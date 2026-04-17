/**
 * Mimic AI — Tree Executor
 *
 * Walks a parsed HTML node tree and creates Figma elements with correct
 * parent-child nesting. Uses DS tokens when provided, falls back to safe
 * numeric defaults when not.
 *
 * DS token binding:
 *   - buildContext.textStyles: { h1: styleKey, h2: ..., body: ..., small: ... }
 *   - buildContext.colorTokens: { textPrimary: varPath, textSecondary: varPath }
 *   - buildContext.spacingTokens: { gap: varPath, sectionPadding: varPath }
 *   - buildContext.radiusToken: varPath
 *
 * When tokens are absent, numeric fallbacks are used. Structure is identical
 * either way — tokens only improve visual quality, not correctness.
 */

// ── NUMERIC FALLBACKS (used when no DS tokens provided) ──────────────────

const FALLBACK_TEXT_SIZE = {
  h1: 32, h2: 24, h3: 20, h4: 18, h5: 16, h6: 14,
  p: 14, span: 13, label: 13, time: 12, li: 14,
};

const FALLBACK_TEXT_WEIGHT = {
  h1: 700, h2: 700, h3: 600, h4: 600, h5: 600, h6: 600,
  p: 400, span: 400, label: 500, time: 400, li: 400,
};

const FALLBACK_GAP = 8;
const FALLBACK_SECTION_PADDING = 24;
const FALLBACK_INNER_PADDING = 0;

// ── DS STYLE MAPPING ─────────────────────────────────────────────────────
// Maps HTML tags to DS text style tiers (from buildContext.textStyles).
// Uses relative ranking: largest available → smallest available.
// Never guesses style names — uses the tier keys provided.

function resolveTextStyle(tag, textStyles) {
  if (!textStyles) return null;

  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const SMALL_TAGS = new Set(['time', 'label']);

  if (tag === 'h1') return textStyles.h1 || textStyles.heading || null;
  if (tag === 'h2') return textStyles.h2 || textStyles.heading || null;
  if (tag === 'h3') return textStyles.h3 || textStyles.subheading || null;
  if (HEADING_TAGS.has(tag)) return textStyles.subheading || textStyles.body || null;
  if (SMALL_TAGS.has(tag)) return textStyles.small || textStyles.body || null;

  return textStyles.body || null;
}


// ── MAIN EXECUTOR ────────────────────────────────────────────────────────

export async function executeTree(options) {
  const {
    nodes,
    resolutionMap = {},
    parentNodeId,
    fileKey,
    callBridge,
    buildContext = {},
    stats = { frames: 0, texts: 0, rectangles: 0, components: 0, failed: 0, errors: [], maxDepth: 0 },
    depth = 0,
    maxDepth = 15,
  } = options;

  if (depth > maxDepth) return stats;
  if (depth > stats.maxDepth) stats.maxDepth = depth;

  // Extract DS tokens from buildContext (may be absent)
  const textStyles = buildContext.textStyles || null;
  const colorTokens = buildContext.colorTokens || null;
  const spacingTokens = buildContext.spacingTokens || null;
  const radiusToken = buildContext.radiusToken || null;

  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'head', 'title', 'template', 'next-route-announcer']);
  const TEXT_TAGS = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'time', 'li']);
  const MEDIA_TAGS = new Set(['img', 'svg', 'video', 'picture', 'canvas']);
  const SECTION_TAGS = new Set(['section', 'article', 'aside', 'main', 'header', 'footer', 'nav']);

  for (const node of nodes) {
    if (!node.tag || SKIP_TAGS.has(node.tag)) continue;

    const hasChildren = node.children && node.children.length > 0;
    const text = (node.textContent || node.fullText || '').trim();
    const tag = node.tag;

    try {
      // ── DS COMPONENT ────────────────────────────────────────────────
      const resolution = node._id ? resolutionMap[node._id] : null;
      if (resolution && resolution.type !== 'FALLBACK') {
        const result = await callBridge('insert_component', {
          componentKey: resolution.componentKey,
          fileKey,
          parentNodeId,
        });
        const instanceId = result?.nodeId || result?.id;

        if (instanceId) {
          try { await callBridge('set_layout_sizing', { nodeId: instanceId, layoutSizingHorizontal: 'FILL' }); } catch (e) {}
          if (text) {
            try { await callBridge('set_component_text', { nodeId: instanceId, propertyName: 'primary_text', value: text }); } catch (e) {}
          }
        }
        stats.components++;
        continue;
      }

      // ── CONTAINER → frame + recurse ─────────────────────────────────
      if (hasChildren) {
        const layout = node._layout;
        const isSection = SECTION_TAGS.has(tag) || depth <= 2;

        // STRUCTURAL GROUPING DECISION
        // A container is "meaningful" if it has any of:
        //   - Layout signals (direction, gap, padding, alignment)
        //   - Section-level tag (section, nav, header, footer, etc.)
        //   - Multiple children (structural grouping)
        //   - Bounding box data indicating it has visual presence
        //   - Top-level depth (≤2)
        //
        // A container is a "passthrough wrapper" if:
        //   - No layout signals
        //   - Single child
        //   - Not a section tag
        //   - Deep in the tree (depth > 3)
        //
        // Wrappers are flattened: children go directly into the parent.
        const hasLayoutSignals = layout && (layout.direction || layout.gap !== undefined ||
          layout.paddingTop !== undefined || layout.counterAxisAlign || layout.primaryAxisAlign);
        const hasBoxData = layout?._box && layout._box.width > 0;
        const multipleChildren = node.children.filter(c => c.tag && !SKIP_TAGS.has(c.tag)).length > 1;

        const isMeaningful = isSection || hasLayoutSignals || multipleChildren || depth <= 2;
        const isWrapper = !isMeaningful && node.children.length === 1 && depth > 3;

        if (isWrapper) {
          // Flatten: pass single child directly to parent, skip this wrapper
          await executeTree({
            nodes: node.children, resolutionMap, parentNodeId,
            fileKey, callBridge, buildContext, stats,
            depth: depth + 1, maxDepth,
          });
          continue;
        }

        // CREATE MEANINGFUL CONTAINER
        const frameName = node.attributes?.class
          ? node.tag + '.' + node.attributes.class.split(' ')[0]
          : node.tag;

        // Direction: from layout data (CSS/computed), or VERTICAL default
        const direction = layout?.direction || 'VERTICAL';

        // Gap: layout data → DS token → numeric fallback
        // Scale gap by structural level: sections get more space, inner containers less
        const baseGap = layout?.gap ?? (spacingTokens?.gap || FALLBACK_GAP);
        const gap = isSection ? Math.max(baseGap, 16) : baseGap;

        // Padding: layout data → DS section padding → depth-based
        const sectionPad = spacingTokens?.sectionPadding || FALLBACK_SECTION_PADDING;
        const padTop = layout?.paddingTop ?? (isSection ? sectionPad : FALLBACK_INNER_PADDING);
        const padBottom = layout?.paddingBottom ?? (isSection ? sectionPad : FALLBACK_INNER_PADDING);
        const padLeft = layout?.paddingLeft ?? (isSection ? sectionPad : FALLBACK_INNER_PADDING);
        const padRight = layout?.paddingRight ?? (isSection ? sectionPad : FALLBACK_INNER_PADDING);

        // Max width: from layout data (e.g., max-w-[1280px] class)
        const maxWidth = layout?.maxWidth || undefined;

        const frameParams = {
          name: frameName.substring(0, 50),
          parentNodeId,
          direction,
          primaryAxisSizingMode: 'AUTO',
          counterAxisSizingMode: 'AUTO',
          gap,
          paddingTop: padTop,
          paddingBottom: padBottom,
          paddingLeft: padLeft,
          paddingRight: padRight,
          fillNone: true,
        };

        // Alignment from layout data
        if (layout?.counterAxisAlign) frameParams.counterAxisAlignItems = layout.counterAxisAlign;
        if (layout?.primaryAxisAlign) frameParams.primaryAxisAlignItems = layout.primaryAxisAlign;

        // Section-level frames get a subtle separator stroke for visual clarity
        if (isSection && depth > 1 && depth <= 4) {
          frameParams.strokeHex = 'E5E7EB';
          frameParams.strokeWidth = 1;
          frameParams.cornerRadius = 8;
        }

        const result = await callBridge('create_frame', frameParams);
        const frameId = result?.nodeId || result?.id;
        stats.frames++;

        if (frameId) {
          try { await callBridge('set_layout_sizing', { nodeId: frameId, layoutSizingHorizontal: 'FILL' }); } catch (e) {}

          // Max width constraint
          if (maxWidth) {
            try { await callBridge('set_layout_sizing', { nodeId: frameId, width: maxWidth }); } catch (e) {}
          }

          // Direct text on container
          if (node.textContent && node.textContent.trim()) {
            await createTextNode(node.textContent.trim(), tag, frameId, callBridge, textStyles, colorTokens, stats);
          }

          // Recurse
          await executeTree({
            nodes: node.children, resolutionMap, parentNodeId: frameId,
            fileKey, callBridge, buildContext, stats,
            depth: depth + 1, maxDepth,
          });
        }
        continue;
      }

      // ── LEAF TEXT ────────────────────────────────────────────────────
      if (TEXT_TAGS.has(tag) || (text && !MEDIA_TAGS.has(tag))) {
        if (text) {
          await createTextNode(text, tag, parentNodeId, callBridge, textStyles, colorTokens, stats);
        }
        continue;
      }

      // ── LEAF MEDIA → rectangle placeholder ──────────────────────────
      if (MEDIA_TAGS.has(tag)) {
        const isSvg = tag === 'svg';
        const rectParams = {
          name: tag + (node.attributes?.alt ? ': ' + node.attributes.alt.substring(0, 30) : ''),
          width: isSvg ? 24 : 280,
          height: isSvg ? 24 : 160,
          parentNodeId,
          fillHex: isSvg ? 'A3A3A3' : 'E5E7EB',
        };
        if (radiusToken) rectParams.cornerRadius = 8;
        else if (!isSvg) rectParams.cornerRadius = 6;

        await callBridge('create_rectangle', rectParams);
        stats.rectangles++;
        continue;
      }

      // ── INTERACTIVE LEAF (button/a/input without children) ──────────
      if (text) {
        await createTextNode(text, tag, parentNodeId, callBridge, textStyles, colorTokens, stats);
      }

    } catch (err) {
      stats.failed++;
      stats.errors.push({ tag, depth, error: err.message });
    }
  }

  return stats;
}


// ── TEXT NODE CREATION ────────────────────────────────────────────────────
// Centralized text creation: applies DS text style + color token when available.

async function createTextNode(text, tag, parentNodeId, callBridge, textStyles, colorTokens, stats) {
  const textStyleId = resolveTextStyle(tag, textStyles);
  const fillVariable = colorTokens?.textPrimary || null;

  const params = {
    text: text.substring(0, 500),
    parentNodeId,
  };

  // DS text style (preferred) or numeric fallback
  if (textStyleId) {
    params.textStyleId = textStyleId;
  } else {
    params.fontSize = FALLBACK_TEXT_SIZE[tag] || 14;
    params.fontWeight = FALLBACK_TEXT_WEIGHT[tag] || 400;
  }

  // DS color variable (preferred) or no override (uses Figma default black)
  if (fillVariable) {
    params.fillVariable = fillVariable;
  }

  const txtResult = await callBridge('create_text', params);
  const txtId = txtResult?.nodeId || txtResult?.id;
  if (txtId) {
    try { await callBridge('set_layout_sizing', { nodeId: txtId, layoutSizingHorizontal: 'FILL' }); } catch (e) {}
  }
  stats.texts++;
}

// Node identity is via node._id (assigned by html-parser.js).
// Resolution map is keyed by _id (built by buildResolutionMap in component-resolver.js).
