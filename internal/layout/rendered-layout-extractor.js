/**
 * Mimic AI — Rendered Layout Extractor
 *
 * Extracts computed layout data from a live Puppeteer page.
 * Runs AFTER rendering is ready, BEFORE the browser closes.
 *
 * Extracts only factual browser data:
 *   - Bounding boxes (x, y, width, height)
 *   - Computed CSS layout properties (display, flexDirection, gap, etc.)
 *   - Visibility
 *
 * Does NOT:
 *   - Infer UI patterns
 *   - Guess layout intent
 *   - Access DS information
 *   - Hardcode component names
 *
 * Output: array of layout records, each with a selector path for
 * downstream mapping to parsed nodes.
 *
 * Usage:
 *   const layoutData = await extractRenderedLayout(page);
 */


/**
 * Extract computed layout data from all visible container elements on the page.
 *
 * Runs inside the browser via page.evaluate().
 * Only targets elements likely to be layout containers (div, section, nav, etc.)
 * to keep extraction performant.
 *
 * @param {Object} page — Puppeteer Page object (must be navigated and ready)
 * @param {Object} [options]
 * @param {number} [options.maxElements=500] — cap to prevent slow extraction
 * @returns {Array} layout records
 */
export async function extractRenderedLayout(page, options = {}) {
  const { maxElements = 500 } = options;

  const layoutData = await page.evaluate((maxEl) => {
    const CONTAINER_TAGS = new Set([
      'div', 'section', 'article', 'aside', 'main', 'header', 'footer',
      'nav', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'form',
    ]);

    const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'head']);

    const records = [];
    let count = 0;

    /**
     * Build a stable path selector for a DOM node.
     * Uses tag + nth-child index at each level.
     * This creates a deterministic path that can be matched to parsed nodes.
     */
    function buildPath(el) {
      const parts = [];
      let current = el;
      while (current && current !== document.body && current !== document.documentElement) {
        const tag = current.tagName?.toLowerCase() || '';
        if (!tag) break;
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(current);
          parts.unshift(`${tag}[${index}]`);
        } else {
          parts.unshift(tag);
        }
        current = parent;
      }
      return parts.join('>');
    }

    function processElement(el) {
      if (count >= maxEl) return;

      const tag = el.tagName?.toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) return;

      // Only extract layout data for container elements
      if (!CONTAINER_TAGS.has(tag)) return;

      // Skip hidden elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      // Bounding box
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      // Extract computed layout properties
      const record = {
        path: buildPath(el),
        tag,
        className: (el.className || '').toString().substring(0, 100),
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        layout: {
          display: style.display,
          flexDirection: style.flexDirection !== 'row' ? style.flexDirection : (style.display === 'flex' ? 'row' : null),
          flexWrap: style.flexWrap !== 'nowrap' ? style.flexWrap : null,
          justifyContent: style.justifyContent !== 'normal' ? style.justifyContent : null,
          alignItems: style.alignItems !== 'normal' ? style.alignItems : null,
          gap: style.gap !== 'normal' && style.gap !== '0px' ? style.gap : null,
          gridTemplateColumns: style.gridTemplateColumns !== 'none' ? style.gridTemplateColumns : null,
          position: style.position !== 'static' ? style.position : null,
          overflow: style.overflow !== 'visible' ? style.overflow : null,
        },
        sizing: {
          width: rect.width,
          isFullWidth: rect.width >= 1400, // Near viewport width
          isNarrow: rect.width < 200,
        },
        childCount: el.children.length,
      };

      // Clean nulls for compact output
      for (const [k, v] of Object.entries(record.layout)) {
        if (v === null) delete record.layout[k];
      }

      records.push(record);
      count++;

      // Process children
      for (const child of el.children) {
        processElement(child);
      }
    }

    // Start from body's direct children
    for (const child of document.body.children) {
      processElement(child);
    }

    return records;
  }, maxElements);

  return layoutData;
}


/**
 * Map extracted layout records to parsed nodes by matching paths.
 *
 * Limitation: path matching between browser DOM and parsed HTML is approximate.
 * The parser may skip/flatten some nodes. Matching uses tag + class as fallback.
 *
 * @param {Array} layoutData — from extractRenderedLayout()
 * @param {Array} parsedNodes — from parseHTML()
 * @returns {number} count of successfully mapped nodes
 */
export function mapLayoutToNodes(layoutData, parsedNodes) {
  // Build a lookup by className prefix (first class) for fuzzy matching
  const layoutByClass = new Map();
  for (const record of layoutData) {
    const firstClass = (record.className || '').split(' ')[0];
    if (firstClass) {
      if (!layoutByClass.has(firstClass)) layoutByClass.set(firstClass, []);
      layoutByClass.get(firstClass).push(record);
    }
  }

  let mapped = 0;

  function mapNode(node) {
    if (node._layout) {
      // Already has CSS-class-based layout — don't override, but enrich
    }

    const nodeClass = (node.attributes?.class || '').split(' ')[0];
    if (nodeClass && layoutByClass.has(nodeClass)) {
      const candidates = layoutByClass.get(nodeClass);
      // Pick the first unmatched candidate with same tag
      const match = candidates.find(c => c.tag === node.tag && !c._used);
      if (match) {
        match._used = true;

        // Enrich node._layout with browser-computed data
        const existing = node._layout || {};

        // Browser-computed direction overrides CSS-class-inferred when available
        const computedDir = match.layout.display === 'flex'
          ? (match.layout.flexDirection === 'column' ? 'VERTICAL' : 'HORIZONTAL')
          : match.layout.display === 'grid' ? 'HORIZONTAL'
          : null;

        // Parse gap from computed value (e.g., "12px" → 12)
        const computedGap = match.layout.gap ? parseInt(match.layout.gap) : null;

        // Build enriched layout
        node._layout = {
          ...existing,
          direction: computedDir || existing.direction || 'VERTICAL',
          gap: computedGap ?? existing.gap ?? undefined,
          // Browser box data
          _box: match.box,
          _computed: match.layout,
          _sizing: match.sizing,
        };

        // Alignment from computed styles
        if (match.layout.alignItems === 'center') node._layout.counterAxisAlign = 'CENTER';
        if (match.layout.alignItems === 'flex-start') node._layout.counterAxisAlign = 'MIN';
        if (match.layout.alignItems === 'flex-end') node._layout.counterAxisAlign = 'MAX';
        if (match.layout.justifyContent === 'center') node._layout.primaryAxisAlign = 'CENTER';
        if (match.layout.justifyContent === 'space-between') node._layout.primaryAxisAlign = 'SPACE_BETWEEN';
        if (match.layout.justifyContent === 'flex-end') node._layout.primaryAxisAlign = 'MAX';

        // Width behavior
        if (match.sizing.isFullWidth) node._layout.fillWidth = true;

        mapped++;
      }
    }

    for (const child of (node.children || [])) {
      mapNode(child);
    }
  }

  for (const node of parsedNodes) {
    mapNode(node);
  }

  return mapped;
}
