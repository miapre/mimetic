/**
 * Mimic AI — Layout Intent Layer
 *
 * Reads CSS class-based layout signals from parsed HTML nodes and annotates
 * them with Figma-compatible layout directives (direction, gap, alignment).
 *
 * This layer:
 *   - Reads ONLY what the developer declared via CSS classes
 *   - Does NOT assume UI patterns (no "nav = horizontal", no "card = vertical")
 *   - Does NOT access DS inventory or influence component resolution
 *   - Works with Tailwind, Bootstrap, and custom utility class conventions
 *
 * Product Contract compliance:
 *   §3: No DS-specific assumptions — this reads CSS, not DS components
 *   §9.5: No UI hardcoding — this reads developer intent, not pattern assumptions
 *
 * Usage:
 *   import { applyLayoutIntent } from './layout-intent.js';
 *   const annotatedNodes = applyLayoutIntent(parsedNodes);
 *
 * The executor reads node._layout to set direction, gap, padding, alignment.
 */


// ═════════════════════════════════════════════════════════════════════════════
// CSS CLASS SIGNAL EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract layout signals from a node's CSS classes.
 * Only reads explicit declarations — never infers.
 */
function extractLayoutSignals(node) {
  const cls = node.attributes?.class || '';
  if (!cls) return null;

  const classes = new Set(cls.split(/\s+/).filter(Boolean));
  const signals = {};

  // ── DIRECTION ───────────────────────────────────────────────────────
  // flex / flex-row → HORIZONTAL
  // flex-col → VERTICAL
  // grid → depends on columns
  // inline-flex → HORIZONTAL

  if (classes.has('flex') || classes.has('inline-flex')) {
    signals.display = 'flex';
    // Default flex direction is row (horizontal) unless flex-col overrides
    signals.direction = classes.has('flex-col') ? 'VERTICAL' : 'HORIZONTAL';
  }

  if (classes.has('grid')) {
    signals.display = 'grid';
    signals.direction = 'HORIZONTAL'; // Grid defaults to row-based flow
  }

  // Explicit direction overrides
  if (classes.has('flex-row')) signals.direction = 'HORIZONTAL';
  if (classes.has('flex-col')) signals.direction = 'VERTICAL';
  if (classes.has('flex-col-reverse')) signals.direction = 'VERTICAL';
  if (classes.has('flex-row-reverse')) signals.direction = 'HORIZONTAL';

  // ── GAP ─────────────────────────────────────────────────────────────
  for (const c of classes) {
    const gapMatch = c.match(/^gap-(\d+(?:\.\d+)?)$/);
    if (gapMatch) signals.gap = parseFloat(gapMatch[1]) * 4; // Tailwind: gap-N = N * 4px

    const gapXMatch = c.match(/^gap-x-(\d+(?:\.\d+)?)$/);
    if (gapXMatch) signals.gapX = parseFloat(gapXMatch[1]) * 4;

    const gapYMatch = c.match(/^gap-y-(\d+(?:\.\d+)?)$/);
    if (gapYMatch) signals.gapY = parseFloat(gapYMatch[1]) * 4;

    // Space-between utility (margin-based spacing)
    const spaceXMatch = c.match(/^space-x-(\d+(?:\.\d+)?)$/);
    if (spaceXMatch) signals.gap = signals.gap || parseFloat(spaceXMatch[1]) * 4;

    const spaceYMatch = c.match(/^space-y-(\d+(?:\.\d+)?)$/);
    if (spaceYMatch) signals.gap = signals.gap || parseFloat(spaceYMatch[1]) * 4;
  }

  // ── ALIGNMENT ───────────────────────────────────────────────────────
  if (classes.has('items-center')) signals.counterAxisAlign = 'CENTER';
  if (classes.has('items-start')) signals.counterAxisAlign = 'MIN';
  if (classes.has('items-end')) signals.counterAxisAlign = 'MAX';
  if (classes.has('items-baseline')) signals.counterAxisAlign = 'BASELINE';

  if (classes.has('justify-center')) signals.primaryAxisAlign = 'CENTER';
  if (classes.has('justify-start')) signals.primaryAxisAlign = 'MIN';
  if (classes.has('justify-end')) signals.primaryAxisAlign = 'MAX';
  if (classes.has('justify-between')) signals.primaryAxisAlign = 'SPACE_BETWEEN';

  // ── PADDING ─────────────────────────────────────────────────────────
  for (const c of classes) {
    const pMatch = c.match(/^p-(\d+(?:\.\d+)?)$/);
    if (pMatch) { const v = parseFloat(pMatch[1]) * 4; signals.padding = v; }

    const pxMatch = c.match(/^px-(\d+(?:\.\d+)?)$/);
    if (pxMatch) { const v = parseFloat(pxMatch[1]) * 4; signals.paddingX = v; }

    const pyMatch = c.match(/^py-(\d+(?:\.\d+)?)$/);
    if (pyMatch) { const v = parseFloat(pyMatch[1]) * 4; signals.paddingY = v; }

    // Individual sides
    const ptMatch = c.match(/^pt-(\d+(?:\.\d+)?)$/);
    if (ptMatch) signals.paddingTop = parseFloat(ptMatch[1]) * 4;
    const pbMatch = c.match(/^pb-(\d+(?:\.\d+)?)$/);
    if (pbMatch) signals.paddingBottom = parseFloat(pbMatch[1]) * 4;
    const plMatch = c.match(/^pl-(\d+(?:\.\d+)?)$/);
    if (plMatch) signals.paddingLeft = parseFloat(plMatch[1]) * 4;
    const prMatch = c.match(/^pr-(\d+(?:\.\d+)?)$/);
    if (prMatch) signals.paddingRight = parseFloat(prMatch[1]) * 4;
  }

  // ── WIDTH / SIZING ──────────────────────────────────────────────────
  if (classes.has('w-full')) signals.fillWidth = true;
  if (classes.has('flex-grow') || classes.has('grow')) signals.fillWidth = true;
  if (classes.has('flex-shrink-0') || classes.has('shrink-0')) signals.shrink = false;

  for (const c of classes) {
    const maxWMatch = c.match(/^max-w-\[(\d+)px\]$/);
    if (maxWMatch) signals.maxWidth = parseInt(maxWMatch[1]);
  }

  // ── WRAP ────────────────────────────────────────────────────────────
  if (classes.has('flex-wrap')) signals.wrap = true;

  // Only return if we found meaningful layout signals
  const hasSignals = signals.direction || signals.display || signals.gap !== undefined || signals.padding !== undefined;
  return hasSignals ? signals : null;
}


// ═════════════════════════════════════════════════════════════════════════════
// LAYOUT ANNOTATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Annotate a single node with layout signals (non-mutating — adds _layout field).
 */
function annotateNode(node) {
  const signals = extractLayoutSignals(node);

  if (signals) {
    node._layout = {
      direction: signals.direction || 'VERTICAL',
      gap: signals.gap ?? signals.gapX ?? signals.gapY ?? undefined,
      wrap: signals.wrap || false,
      counterAxisAlign: signals.counterAxisAlign || undefined,
      primaryAxisAlign: signals.primaryAxisAlign || undefined,
      paddingTop: signals.paddingTop ?? signals.paddingY ?? signals.padding ?? undefined,
      paddingBottom: signals.paddingBottom ?? signals.paddingY ?? signals.padding ?? undefined,
      paddingLeft: signals.paddingLeft ?? signals.paddingX ?? signals.padding ?? undefined,
      paddingRight: signals.paddingRight ?? signals.paddingX ?? signals.padding ?? undefined,
      fillWidth: signals.fillWidth || false,
      maxWidth: signals.maxWidth || undefined,
    };
  }

  // Recurse into children
  if (node.children) {
    for (const child of node.children) {
      annotateNode(child);
    }
  }

  return node;
}


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply layout intent to a parsed node tree.
 * Annotates each node with _layout based on CSS class signals.
 * Non-destructive — adds _layout field, does not modify other fields.
 *
 * @param {Array} nodes — parsed HTML nodes
 * @returns {Array} same nodes with _layout annotations
 */
export function applyLayoutIntent(nodes) {
  for (const node of nodes) {
    annotateNode(node);
  }
  return nodes;
}

/**
 * Summary of layout annotations applied.
 */
export function layoutIntentSummary(nodes) {
  let annotated = 0, horizontal = 0, vertical = 0, withGap = 0, withPadding = 0, total = 0;

  function count(n) {
    total++;
    if (n._layout) {
      annotated++;
      if (n._layout.direction === 'HORIZONTAL') horizontal++;
      else vertical++;
      if (n._layout.gap !== undefined) withGap++;
      if (n._layout.paddingTop !== undefined || n._layout.paddingLeft !== undefined) withPadding++;
    }
    for (const c of (n.children || [])) count(c);
  }
  for (const n of nodes) count(n);

  return { total, annotated, horizontal, vertical, withGap, withPadding, annotationRate: (annotated / total * 100).toFixed(1) + '%' };
}
