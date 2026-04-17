/**
 * Mimic AI — Layout Tree Builder
 *
 * Converts parsed HTML into a layout tree with direction, grouping, and role annotations.
 * The tree is built BEFORE any Figma rendering — it represents structural intent.
 *
 * Each node in the layout tree has:
 *   - direction: 'HORIZONTAL' | 'VERTICAL'
 *   - role: 'container' | 'row' | 'text' | 'interactive' | 'media' | 'decorative'
 *   - children: nested layout nodes
 *   - source: reference to the original HTML node
 *
 * Usage:
 *   import { buildLayoutTree, validateStructure } from './layout-tree-builder.js';
 *   const tree = buildLayoutTree(parsedHtmlNodes);
 */

// ═══════════════════════════════════════════════════════════════════════════
// DIRECTION DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// CSS class patterns that indicate horizontal layout (flex-row, inline, grid-row)
const HORIZONTAL_PATTERNS = [
  /flex-row|flex.*row|inline-flex/,
  /nav-links|nav-right|nav-left/,
  /filter-bar|filter-btn|filter-toggle|filter-search|source-pills/,
  /stat-cards|stat-card/,
  /header-top|footer-bottom|footer-grid/,
  /pag-controls/,
  /btn-|button/,
  /chip|pill|tag-row|tags-row|badge-row/,
  /sidebar-link|sidebar-logo|workspace-chip/,
  /model-row|table-row/,
  /inner$/,
  /actions|cta-row|hero-actions/,
  /credits-row|credit-row/,
  /two-col/,
];

// Tags that are inherently horizontal
const HORIZONTAL_TAGS = new Set(['tr', 'thead', 'tfoot']);

// Tags that are inherently vertical
const VERTICAL_TAGS = new Set(['ul', 'ol', 'table', 'tbody', 'section', 'article', 'main', 'aside', 'nav', 'header', 'footer', 'form']);

/**
 * Detect layout direction from HTML node.
 * Returns 'HORIZONTAL' or 'VERTICAL'.
 */
function detectDirection(node) {
  const cls = (node.attributes?.class || '').toLowerCase();
  const tag = node.tag?.toLowerCase();

  // Check horizontal patterns in class names
  for (const pattern of HORIZONTAL_PATTERNS) {
    if (pattern.test(cls)) return 'HORIZONTAL';
  }

  // Check tag-based direction
  if (HORIZONTAL_TAGS.has(tag)) return 'HORIZONTAL';
  if (VERTICAL_TAGS.has(tag)) return 'VERTICAL';

  // Heuristic: if node has few children (2-3) and they are mixed types, likely horizontal
  const children = node.children || [];
  if (children.length >= 2 && children.length <= 4) {
    const types = children.map(c => classifyRole(c));
    const hasIcon = types.includes('media') || types.includes('decorative');
    const hasText = types.includes('text');
    const hasAction = types.includes('interactive');
    // icon + text is horizontal (common row pattern)
    if (hasIcon && hasText && !types.includes('container')) return 'HORIZONTAL';
    // text + action is horizontal (label + button)
    if (hasText && hasAction && children.length <= 3) return 'HORIZONTAL';
  }

  // Default: vertical
  return 'VERTICAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// ROLE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

function classifyRole(node) {
  const tag = node.tag?.toLowerCase();
  const cls = (node.attributes?.class || '').toLowerCase();
  const children = node.children || [];

  if (['button', 'a', 'input', 'select', 'textarea'].includes(tag)) return 'interactive';
  if (['img', 'svg', 'video', 'picture'].includes(tag)) return 'media';
  if (['h1','h2','h3','h4','h5','h6','p','span','label'].includes(tag) && children.length === 0) return 'text';
  if (tag === 'th' || tag === 'td') return 'text';
  if (cls.includes('icon') || cls.includes('avatar') || cls.includes('dot')) return 'decorative';
  if (children.length > 0) return 'container';
  if (node.textContent?.trim()) return 'text';
  return 'decorative';
}

// ═══════════════════════════════════════════════════════════════════════════
// SKIP / PASS-THROUGH DETECTION
// ═══════════════════════════════════════════════════════════════════════════

const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'template']);
const PASSTHROUGH_CLASSES = ['container', 'inner', 'wrapper'];

function shouldSkip(node) {
  if (SKIP_TAGS.has(node.tag?.toLowerCase())) return true;
  if (node.attributes?.['aria-hidden'] === 'true' && !node.children?.length) return true;
  const style = node.attributes?.style || '';
  if (style.includes('display:none') || style.includes('display: none')) return true;
  return false;
}

function isPassthrough(node) {
  const cls = (node.attributes?.class || '').toLowerCase();
  // Pure wrapper divs that add no visual meaning — flatten their children
  return PASSTHROUGH_CLASSES.some(p => cls === p) && node.tag === 'div';
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT TREE BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a layout tree from parsed HTML nodes.
 *
 * @param {Object[]} nodes — parsed HTML nodes from html-parser.js
 * @returns {Object} layout tree root
 */
export function buildLayoutTree(nodes) {
  const children = [];
  for (const node of nodes) {
    const layoutNode = buildNode(node);
    if (layoutNode) children.push(layoutNode);
  }

  return {
    direction: 'VERTICAL',
    role: 'container',
    name: 'root',
    children,
    source: null,
    stats: computeStats({ children }),
  };
}

function buildNode(node) {
  if (shouldSkip(node)) return null;

  const tag = node.tag?.toLowerCase();
  const cls = node.attributes?.class || '';
  const children = node.children || [];
  const role = classifyRole(node);

  // Leaf nodes (text, media, decorative)
  if (children.length === 0) {
    return {
      direction: null,
      role,
      name: cls.split(' ')[0] || tag,
      tag,
      text: (node.textContent || '').trim().substring(0, 100),
      attributes: node.attributes,
      children: [],
      source: node,
    };
  }

  // Passthrough: flatten children into parent level
  if (isPassthrough(node)) {
    const flatChildren = [];
    for (const child of children) {
      const built = buildNode(child);
      if (built) flatChildren.push(built);
    }
    // If only one child, return it directly
    if (flatChildren.length === 1) return flatChildren[0];
    // Multiple children — wrap in implicit group
    return {
      direction: detectDirection(node),
      role: 'container',
      name: cls.split(' ')[0] || tag,
      tag,
      attributes: node.attributes,
      children: flatChildren,
      source: node,
    };
  }

  // Container: build children recursively
  const builtChildren = [];
  for (const child of children) {
    const built = buildNode(child);
    if (built) builtChildren.push(built);
  }

  return {
    direction: detectDirection(node),
    role,
    name: cls.split(' ')[0] || tag,
    tag,
    text: role === 'interactive' ? (node.textContent || '').trim().substring(0, 60) : null,
    attributes: node.attributes,
    children: builtChildren,
    source: node,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

function computeStats(tree) {
  let sections = 0, groups = 0, leaves = 0, maxDepth = 0;

  function walk(node, depth) {
    if (depth > maxDepth) maxDepth = depth;
    if (node.children?.length > 0) {
      groups++;
      if (depth <= 2) sections++;
      for (const child of node.children) walk(child, depth + 1);
    } else {
      leaves++;
    }
  }

  for (const child of (tree.children || [])) walk(child, 1);
  return { sections, groups, leaves, maxDepth };
}

/**
 * Validate that a Figma build preserved the layout tree structure.
 *
 * @param {Object} layoutTree — from buildLayoutTree
 * @param {Object} buildStats — { sections, groups } from build engine
 * @returns {Object} { valid, missing, flattened }
 */
export function validateStructure(layoutTree, buildStats) {
  const expected = layoutTree.stats;
  const missing = [];
  const flattened = [];

  // Check section preservation
  if (buildStats.sections < expected.sections * 0.8) {
    missing.push(`Sections: expected ~${expected.sections}, got ${buildStats.sections}`);
  }

  // Check group preservation
  if (buildStats.groups < expected.groups * 0.5) {
    flattened.push(`Groups: expected ~${expected.groups}, got ${buildStats.groups}`);
  }

  return {
    valid: missing.length === 0 && flattened.length === 0,
    expected,
    actual: buildStats,
    missing,
    flattened,
  };
}

/**
 * Print a layout tree summary for debugging.
 */
export function printLayoutTree(tree, depth = 0) {
  const prefix = '  '.repeat(depth);
  const dir = tree.direction ? (tree.direction === 'HORIZONTAL' ? '→' : '↓') : '·';
  const name = tree.name || tree.tag || '?';
  const cc = tree.children?.length || 0;
  const text = tree.text ? ` "${tree.text.substring(0, 30)}"` : '';
  console.log(`${prefix}${dir} ${name} [${tree.role}]${cc ? ' (' + cc + ')' : ''}${text}`);
  if (depth < 4) {
    for (const child of (tree.children || [])) printLayoutTree(child, depth + 1);
  }
}
