/**
 * Mimic AI — Block Classifier
 *
 * Classifies HTML sections into four types BEFORE building:
 *   1. DATA_SURFACE — structured product UI (tables, stats, forms)
 *   2. INTERACTIVE — buttons, tabs, inputs, controls
 *   3. LAYOUT_PATTERN — hero, grid, card layout, footer
 *   4. DECORATIVE_MEDIA — logos, illustrations, non-functional images
 *
 * Classification drives placeholder vs structured build decisions.
 * Does NOT access DS inventory. Does NOT assume UI patterns by name.
 * Uses only structural signals from the parsed HTML.
 */

/**
 * Classify a parsed HTML section node.
 *
 * @param {Object} node — parsed HTML node with tag, children, fullText, attributes
 * @returns {Object} { type, confidence, reason, subClassifications }
 */
export function classifyBlock(node) {
  const tag = node.tag;
  const children = node.children || [];
  const fullText = (node.fullText || '').trim();
  const cls = (node.attributes?.class || '').toLowerCase();
  const childTags = children.map(c => c.tag);

  // Count structural elements
  const hasTable = containsTag(node, 'table');
  const hasForm = containsTag(node, 'form') || containsTag(node, 'input');
  const hasButtons = countTag(node, 'button') + countTag(node, 'a');
  const hasHeadings = countTag(node, 'h1') + countTag(node, 'h2') + countTag(node, 'h3');
  const hasImages = countTag(node, 'img') + countTag(node, 'svg');
  const hasParagraphs = countTag(node, 'p');
  const hasLists = containsTag(node, 'ul') || containsTag(node, 'ol');
  const textLength = fullText.length;

  // DATA_SURFACE: tables, stat grids, structured data displays
  if (hasTable) {
    return { type: 'DATA_SURFACE', confidence: 0.95, reason: 'Contains table element' };
  }

  // DATA_SURFACE: repeated structured children with numbers/stats
  // Check one level deeper for nested stat patterns
  const deepChildren = children.length === 1 && children[0].children ? children[0].children : children;
  const deeperChildren = deepChildren.length === 1 && deepChildren[0].children ? deepChildren[0].children : deepChildren;
  if (deeperChildren.length >= 3 && deeperChildren.every(c => countTag(c, 'p') >= 2 && (c.fullText || '').match(/\d/))) {
    return { type: 'DATA_SURFACE', confidence: 0.8, reason: 'Repeated stat-like children with numeric content' };
  }

  // INTERACTIVE: primarily buttons/inputs/forms
  if (hasForm || (hasButtons > 3 && textLength < 200)) {
    return { type: 'INTERACTIVE', confidence: 0.85, reason: 'Form elements or button-heavy section' };
  }

  // DECORATIVE_MEDIA: primarily images with little text
  if (hasImages > 5 && textLength < 100) {
    return { type: 'DECORATIVE_MEDIA', confidence: 0.8, reason: 'Many images, minimal text' };
  }

  // DECORATIVE_MEDIA: single image or decorative div with no meaningful content
  if (children.length <= 2 && hasImages > 0 && textLength < 50) {
    return { type: 'DECORATIVE_MEDIA', confidence: 0.7, reason: 'Image-dominant with minimal text' };
  }

  // LAYOUT_PATTERN: heading + content + optional CTA — most section-level blocks
  if (hasHeadings > 0 && (hasParagraphs > 0 || hasButtons > 0 || hasLists)) {
    return { type: 'LAYOUT_PATTERN', confidence: 0.9, reason: 'Heading + content structure' };
  }

  // LAYOUT_PATTERN: grid of similar children
  if (children.length >= 2 && cls.includes('grid')) {
    return { type: 'LAYOUT_PATTERN', confidence: 0.8, reason: 'Grid class with multiple children' };
  }

  // Default: LAYOUT_PATTERN for any section with content
  if (textLength > 50) {
    return { type: 'LAYOUT_PATTERN', confidence: 0.6, reason: 'Content-bearing section (default)' };
  }

  return { type: 'DECORATIVE_MEDIA', confidence: 0.5, reason: 'No strong structural signals' };
}

/**
 * Classify all sections in a page.
 */
export function classifyPageSections(sections) {
  return sections.map((sec, i) => ({
    index: i,
    tag: sec.tag,
    text: (sec.fullText || '').substring(0, 60),
    ...classifyBlock(sec),
  }));
}

// Helpers
function containsTag(node, tag) {
  if (node.tag === tag) return true;
  for (const c of (node.children || [])) { if (containsTag(c, tag)) return true; }
  return false;
}

function countTag(node, tag) {
  let count = node.tag === tag ? 1 : 0;
  for (const c of (node.children || [])) count += countTag(c, tag);
  return count;
}
