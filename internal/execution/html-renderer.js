/**
 * Mimic AI — Strict HTML-First Renderer
 *
 * Renders parsed HTML nodes into Figma in DOM order.
 * NO grouping, NO reordering, NO merging.
 * Layout direction comes ONLY from CSS class → flex/grid mapping.
 * If not determinable → defaults to VERTICAL stacking.
 *
 * Usage:
 *   import { renderHTML } from './html-renderer.js';
 *   await renderHTML(engine, parsedNodes, parentId);
 */

// ═══════════════════════════════════════════════════════════════════════════
// CSS CLASS → LAYOUT DIRECTION (strict, from source stylesheet)
// ═══════════════════════════════════════════════════════════════════════════

// Classes where display:flex with default row direction or explicit row
const FLEX_ROW_CLASSES = [
  'premium-layout', 'inner', 'nav-left', 'nav-right', 'nav-links',
  'sidebar-link', 'sidebar-logo',
  'workspace-chip',
  'stat-cards', 'stat-card', 'stat-body',
  'header-top',
  'filter-bar', 'filter-toggle-chip', 'filter-btn', 'filter-search', 'source-pills',
  'hero-actions', 'hero-tags-row', 'hero-tags', 'hero-form-fields',
  'cl-header', 'cl-progress-row',
  'step', 'step-title-row',
  'rec-item',
  'qs-header', 'qs-title', 'qs-footer-links',
  'log-row', 'log-header',
  'pagination', 'pag-controls',
  'footer-bottom', 'footer-grid',
  'cards-grid', 'two-col',
  'btn-primary', 'btn-secondary', 'btn-ghost', 'btn-primary-nav', 'btn-run-eval',
  'sb-credits-row', 'sb-user', 'sb-link', 'sb-logo', 'sb-project',
  'user-row', 'credits-row',
  'action-card', // cards are vertical but their CTA is inline
  'card-cta',
  'tp-presets', 'tp-preset',
  'rec-more-btn', 'qs-link',
];

// Classes where display:flex with column direction
const FLEX_COL_CLASSES = [
  'sidebar', 'sidebar-nav', 'sidebar-cta', 'sidebar-workspace', 'sidebar-footer',
  'sb-nav', 'sb-footer', 'sb-credits',
  'premium-main', 'main', 'content',
  'page-header', 'page-title',
  'table-section', 'table-card', 'data-table',
  'hero', 'card', 'qs-card',
  'action-card',
  'cl-steps', 'cl-progress', 'step-body', 'rec-body',
  'rec-header', 'rec-items', 'rec-items-grid',
  'log-entries', 'log-entry', 'log-expanded', 'log-text',
  'app',
];

// Table elements → row = horizontal, others = vertical
const TABLE_HORIZONTAL = new Set(['tr', 'thead', 'tfoot']);
const TABLE_VERTICAL = new Set(['table', 'tbody']);

// Tags where children are inherently inline
const INLINE_PARENT_TAGS = new Set(['button', 'a', 'label', 'span']);

/**
 * Determine layout direction from CSS class and tag.
 * Returns 'HORIZONTAL' or 'VERTICAL'.
 * ONLY based on explicit CSS mapping — no guessing.
 */
function getDirection(node) {
  const cls = (node.attributes?.class || '').toLowerCase();
  const tag = node.tag?.toLowerCase();

  // Check flex-row classes
  for (const pattern of FLEX_ROW_CLASSES) {
    if (cls.includes(pattern)) return 'HORIZONTAL';
  }

  // Check flex-col classes
  for (const pattern of FLEX_COL_CLASSES) {
    if (cls.includes(pattern)) return 'VERTICAL';
  }

  // Table elements
  if (TABLE_HORIZONTAL.has(tag)) return 'HORIZONTAL';
  if (TABLE_VERTICAL.has(tag)) return 'VERTICAL';

  // Inline parent tags (button, a, label)
  if (INLINE_PARENT_TAGS.has(tag)) return 'HORIZONTAL';

  // Default: vertical
  return 'VERTICAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// STRICT RENDERER
// ═══════════════════════════════════════════════════════════════════════════

const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'template', 'colgroup', 'col']);

/**
 * Render a single HTML node and its children into Figma.
 * Preserves DOM order strictly. No reordering or regrouping.
 *
 * @param {Object} engine — build engine instance
 * @param {Object} node — parsed HTML node
 * @param {string} parentId — Figma parent node ID
 * @param {number} depth — current depth
 * @param {number} maxDepth — limit
 * @returns {Object|null} created node result
 */
async function renderNode(engine, node, parentId, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return null;
  if (!node || !node.tag) return null;

  const tag = node.tag.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;

  // Skip hidden elements
  if (node.attributes?.['aria-hidden'] === 'true' && (!node.children || node.children.length === 0)) return null;
  const style = node.attributes?.style || '';
  if (style.includes('display:none') || style.includes('display: none')) return null;

  const cls = node.attributes?.class || '';
  const children = node.children || [];
  const textContent = (node.textContent || '').trim();

  // ── LEAF: text-only node ──
  if (children.length === 0 && tag !== 'svg' && tag !== 'img') {
    if (!textContent) return null; // Skip empty leaves

    // Detect font styling from CSS class
    const fontSize = tag === 'h1' ? 30 : tag === 'h2' ? 24 : tag === 'h3' ? 20 : tag === 'h4' ? 18
      : cls.includes('stat-value') ? 24 : cls.includes('nav-logo') ? 16
      : cls.includes('title') && !cls.includes('sub') ? 14 : 13;
    const fontWeight = ['h1','h2','h3','h4'].includes(tag) || cls.includes('value') || cls.includes('title') || cls.includes('brand') || cls.includes('logo-text') || cls.includes('600') || cls.includes('700') || cls.includes('800') ? 700
      : cls.includes('semibold') || cls.includes('label') ? 600
      : cls.includes('500') || cls.includes('medium') ? 500 : 400;
    const isSecondary = cls.includes('subtitle') || cls.includes('label') || cls.includes('meta') || cls.includes('sub') || cls.includes('500') || cls.includes('gray') || cls.includes('note') || cls.includes('info') || cls.includes('footer');
    const fills = isSecondary ? [{ type: 'SOLID', color: { r: 0.443, g: 0.443, b: 0.478 } }] : undefined;

    // Check if this is an interactive element that should be a DS component
    if (['button', 'a'].includes(tag) && textContent.length <= 40) {
      const isPrimary = cls.includes('primary') || cls.includes('btn-primary') || cls.includes('run-eval');
      const isGhost = cls.includes('ghost') || cls.includes('link');
      const result = await engine.action(parentId, textContent, isPrimary ? 'primary' : isGhost ? 'link' : 'secondary');
      return result;
    }

    return engine.text({ text: textContent, parentId, fontSize, fontWeight, fills });
  }

  // ── LEAF: SVG/IMG (icon or media) ──
  if (tag === 'svg' || tag === 'img') {
    return engine.icon(parentId, { className: cls, position: 'leading' }, 16);
  }

  // ── CONTAINER: has children → create frame, render children inside ──
  const direction = getDirection(node);

  // Determine frame properties from CSS class
  const hasBorder = cls.includes('card') || cls.includes('table-card') || cls.includes('stat-card') || cls.includes('sidebar');
  const hasBg = cls.includes('header') && !cls.includes('th-') || cls.includes('sidebar') || cls.includes('card') || cls.includes('footer');
  const isWhiteBg = hasBg || cls.includes('filter-bar');

  const params = {
    name: cls.split(' ')[0] || tag,
    parentId,
    layoutMode: direction,
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'AUTO',
    fills: isWhiteBg ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] : [],
    itemSpacing: direction === 'HORIZONTAL' ? 8 : 4,
  };

  // Padding for padded containers
  if (cls.includes('header') || cls.includes('section') || cls.includes('footer') || cls.includes('sidebar-cta') || cls.includes('sidebar-workspace')) {
    params.paddingTop = 16; params.paddingBottom = 16; params.paddingLeft = 20; params.paddingRight = 20;
  }
  if (cls.includes('page-header')) {
    params.paddingTop = 36; params.paddingBottom = 32; params.paddingLeft = 40; params.paddingRight = 40;
    params.itemSpacing = 28;
  }
  if (cls.includes('table-section')) {
    params.paddingTop = 24; params.paddingBottom = 48; params.paddingLeft = 40; params.paddingRight = 40;
  }
  if (cls.includes('filter-bar')) {
    params.paddingTop = 14; params.paddingBottom = 14; params.paddingLeft = 20; params.paddingRight = 20;
  }
  if (cls.includes('stat-card')) {
    params.paddingTop = 18; params.paddingBottom = 18; params.paddingLeft = 20; params.paddingRight = 20;
    params.itemSpacing = 14;
  }

  // Border
  if (hasBorder) {
    params.strokes = [{ type: 'SOLID', color: { r: 0.894, g: 0.894, b: 0.906 } }];
    params.strokeWeight = 1; params.strokeAlign = 'INSIDE'; params.cornerRadius = 10;
  }

  // Sizing
  if (cls.includes('sidebar')) { params.width = 220; params.counterAxisSizingMode = 'FIXED'; }
  if (cls.includes('premium-main') || cls.includes('main')) { params.layoutGrow = 1; }
  if (cls.includes('stat-cards') || cls.includes('cards-grid') || cls.includes('two-col') || cls.includes('footer-grid')) {
    // Children should grow equally
    params.itemSpacing = 12;
  }

  const containerResult = await engine.frame(params);

  // Render children in DOM order
  for (const child of children) {
    await renderNode(engine, child, containerResult.nodeId, depth + 1, maxDepth);
  }

  return containerResult;
}

/**
 * Render parsed HTML nodes into Figma using strict HTML-first approach.
 * No grouping heuristics. No reordering. CSS class → direction mapping only.
 *
 * @param {Object} engine — build engine instance
 * @param {Object[]} nodes — parsed HTML nodes
 * @param {string} parentId — Figma parent to render into
 * @param {number} [maxDepth=10] — recursion limit
 */
export async function renderHTML(engine, nodes, parentId, maxDepth = 10) {
  for (const node of nodes) {
    await renderNode(engine, node, parentId, 0, maxDepth);
  }
}
