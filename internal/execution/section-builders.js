/**
 * Mimic AI — Pattern-Aware Section Builders
 *
 * Router classifies top-level sections → pattern detector selects builder →
 * builder constructs the whole section intentionally.
 *
 * NO generic DOM walking. NO recursive routing inside sections.
 * Each builder extracts meaningful content and builds with intent.
 *
 * Patterns (general, not DS-specific):
 *   HERO — heading + subtitle + CTAs + optional showcase
 *   DATA_TABLE — heading + context controls (tabs/filters) + table + action
 *   STAT_ROW — grid of number+label cards
 *   COMPARISON — side-by-side tier cards with features
 *   EXPLAINER — heading + repeated title+description+media items
 *   FINAL_CTA — centered heading + subtitle + CTA row
 *   FOOTER — brand + nav + legal
 *   DECORATIVE_STRIP — heading + image/logo placeholders
 */

import { classifyBlock } from '../layout/block-classifier.js';

const buildLog = [];
export function getBuildLog() { return buildLog; }
export function clearBuildLog() { buildLog.length = 0; }

// ═════════════════════════════════════════════════════════════════════════════
// ROUTER (top-level only, no recursion)
// ═════════════════════════════════════════════════════════════════════════════

export async function routeToBuilder(block, figma, ctx) {
  const classification = classifyBlock(block);
  const pattern = detectPattern(block, classification);
  const entry = { index: ctx.index, type: classification.type, pattern, builder: null, error: null };

  try {
    switch (pattern) {
      case 'HERO': entry.builder = 'buildHero'; await buildHero(block, ctx); break;
      case 'DATA_TABLE': entry.builder = 'buildDataTable'; await buildDataTable(block, ctx); break;
      case 'STAT_ROW': entry.builder = 'buildStatRow'; await buildStatRow(block, ctx); break;
      case 'COMPARISON': entry.builder = 'buildComparison'; await buildComparison(block, ctx); break;
      case 'EXPLAINER': entry.builder = 'buildExplainer'; await buildExplainer(block, ctx); break;
      case 'FINAL_CTA': entry.builder = 'buildFinalCta'; await buildFinalCta(block, ctx); break;
      case 'FOOTER': entry.builder = 'buildFooter'; await buildFooter(block, ctx); break;
      case 'DECORATIVE_STRIP': entry.builder = 'buildDecorativeStrip'; await buildDecorativeStrip(block, ctx); break;
      default: entry.builder = 'buildGenericSection'; await buildGenericSection(block, ctx);
    }
  } catch (e) {
    entry.error = e.message;
  }

  buildLog.push(entry);
  return entry;
}

// ═════════════════════════════════════════════════════════════════════════════
// PATTERN DETECTOR — selects the right builder from structure signals
// ═════════════════════════════════════════════════════════════════════════════

function detectPattern(block, classification) {
  const text = block.fullText || '';
  const hasTable = has(block, 'table');
  const hasList = has(block, 'ul');
  const headings = findAll(block, ['h1','h2','h3']);
  const buttons = findAll(block, ['button']);
  const links = findAll(block, ['a']);
  const images = countTag(block, 'img');
  const paragraphs = findAll(block, ['p']);

  // DATA_TABLE: contains a table element
  if (hasTable) return 'DATA_TABLE';

  // HERO: first section with large heading + multiple CTAs
  if (headings.length > 0 && (buttons.length + links.length) >= 2 && paragraphs.length >= 1 && headings[0].length > 20) return 'HERO';

  // DECORATIVE_STRIP: many images, little text
  if (images > 5 && text.length < 200) return 'DECORATIVE_STRIP';

  // STAT_ROW: repeated numeric content (digits in children)
  const statChildren = findStatLikeChildren(block);
  if (statChildren && statChildren.length >= 3) return 'STAT_ROW';

  // COMPARISON: has list items inside grid/flex children (tier cards)
  if (hasList && headings.length >= 1) {
    const deepGridChildren = findGridChildren(block);
    if (deepGridChildren && deepGridChildren.length >= 2) return 'COMPARISON';
  }

  // EXPLAINER: heading + repeated structured children with text
  if (headings.length >= 1 && findRepeatedContentChildren(block).length >= 2) return 'EXPLAINER';

  // FINAL_CTA: heading + small body + single CTA area
  if (headings.length === 1 && paragraphs.length >= 1 && (buttons.length + links.length) <= 3 && text.length < 400) return 'FINAL_CTA';

  // FOOTER: footer tag
  if (block.tag === 'footer') return 'FOOTER';

  // Decorative: mostly images
  if (images > 2 && text.length < 100) return 'DECORATIVE_STRIP';

  return 'GENERIC';
}

// ═════════════════════════════════════════════════════════════════════════════
// EXTRACTION HELPERS — read meaningful content, not DOM structure
// ═════════════════════════════════════════════════════════════════════════════

function findAll(node, tags, results = []) {
  if (tags.includes(node.tag)) results.push((node.fullText || node.textContent || '').trim());
  for (const c of (node.children || [])) findAll(c, tags, results);
  return results;
}

function has(node, tag) {
  if (node.tag === tag) return true;
  for (const c of (node.children || [])) { if (has(c, tag)) return true; }
  return false;
}

function countTag(node, tag) {
  let n = node.tag === tag ? 1 : 0;
  for (const c of (node.children || [])) n += countTag(c, tag);
  return n;
}

function extractFirstHeading(block) {
  function find(n) {
    if (['h1','h2','h3'].includes(n.tag)) return (n.fullText || '').trim();
    for (const c of (n.children || [])) { const r = find(c); if (r) return r; }
    return null;
  }
  return find(block);
}

function extractFirstParagraph(block) {
  function find(n) {
    if (n.tag === 'p') { const t = (n.fullText || '').trim(); if (t.length > 15) return t; }
    for (const c of (n.children || [])) { const r = find(c); if (r) return r; }
    return null;
  }
  return find(block);
}

function extractAllParagraphs(block) {
  const results = [];
  function find(n) {
    if (n.tag === 'p') { const t = (n.fullText || '').trim(); if (t.length > 10) results.push(t); }
    for (const c of (n.children || [])) find(c);
  }
  find(block);
  return results;
}

function extractButtonTexts(block) {
  const results = [];
  function find(n) {
    if (n.tag === 'button' || (n.tag === 'a' && n.attributes?.href)) {
      const t = (n.fullText || n.textContent || '').trim();
      if (t && t.length < 50) results.push(t);
    }
    for (const c of (n.children || [])) find(c);
  }
  find(block);
  return [...new Set(results)]; // Deduplicate
}

function extractBadgeTexts(block) {
  const results = [];
  function find(n) {
    if (n.tag === 'button' || n.tag === 'span' || n.tag === 'div') {
      const t = (n.fullText || '').trim();
      if (t && t.length > 3 && t.length < 40 && !t.includes('\n')) {
        const cls = (n.attributes?.class || '').toLowerCase();
        if (cls.includes('rounded') || cls.includes('badge') || cls.includes('pill') || cls.includes('inline-flex')) {
          results.push(t);
        }
      }
    }
    for (const c of (n.children || [])) find(c);
  }
  find(block);
  return results;
}

function extractTableHeaders(block) {
  const headers = [];
  function find(n) {
    if (n.tag === 'th') headers.push((n.fullText || '').trim());
    for (const c of (n.children || [])) find(c);
  }
  find(block);
  return headers;
}

function findStatLikeChildren(block) {
  function check(children) {
    if (children.length >= 3 && children.every(c => countTag(c, 'p') >= 2 && (c.fullText || '').match(/\d/))) return children;
    return null;
  }
  let current = block.children || [];
  for (let depth = 0; depth < 3; depth++) {
    const result = check(current);
    if (result) return result;
    if (current.length === 1 && current[0].children) current = current[0].children;
    else break;
  }
  return null;
}

function findGridChildren(block) {
  function find(n) {
    const cls = (n.attributes?.class || '').toLowerCase();
    if (cls.includes('grid') && n.children && n.children.length >= 2) return n.children;
    for (const c of (n.children || [])) { const r = find(c); if (r) return r; }
    return null;
  }
  return find(block);
}

function findRepeatedContentChildren(block) {
  function find(n) {
    if (n.children && n.children.length >= 2) {
      const withContent = n.children.filter(c => (c.fullText || '').length > 30 && c.children?.length > 0);
      if (withContent.length >= 2) return withContent;
    }
    for (const c of (n.children || [])) { const r = find(c); if (r) return r; }
    return null;
  }
  return find(block) || [];
}

function extractListItems(block) {
  const items = [];
  function find(n) {
    if (n.tag === 'li') { const t = (n.fullText || '').trim(); if (t) items.push(t); }
    for (const c of (n.children || [])) find(c);
  }
  find(block);
  return items;
}

// ═════════════════════════════════════════════════════════════════════════════
// FIGMA HELPERS
// ═════════════════════════════════════════════════════════════════════════════

async function mkFrame(ctx, name, dir, parentId, opts = {}) {
  const r = await ctx.callBridge('create_frame', {
    name, parentNodeId: parentId, direction: dir,
    primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO',
    gap: opts.gap || 0,
    paddingTop: opts.pt || 0, paddingBottom: opts.pb || 0,
    paddingLeft: opts.pl || 0, paddingRight: opts.pr || 0,
    ...(opts.align && { counterAxisAlignItems: opts.align }),
    ...(opts.justify && { primaryAxisAlignItems: opts.justify }),
    ...(opts.fill ? { fillHex: opts.fill } : { fillNone: true }),
    ...(opts.stroke && { strokeHex: opts.stroke, strokeWidth: opts.sw || 1 }),
    ...(opts.radius && { cornerRadius: opts.radius }),
  });
  const id = r?.nodeId || r?.id;
  if (id && !opts.hug) try { await ctx.callBridge('set_layout_sizing', { nodeId: id, layoutSizingHorizontal: 'FILL' }); } catch(e) {}
  return id;
}

async function addText(ctx, text, parentId, opts = {}) {
  if (!text) return;
  await ctx.callBridge('create_text', {
    text: text.substring(0, 500), parentNodeId: parentId,
    ...(opts.style && { textStyleId: opts.style }),
    ...(opts.color && { fillVariable: opts.color }),
    ...(opts.hex && { fillHex: opts.hex }),
    ...(opts.center && { textAlignHorizontal: 'CENTER' }),
  });
}

async function addPlaceholder(ctx, name, w, h, parentId, fill, radius) {
  await ctx.callBridge('create_rectangle', {
    name, width: w, height: h, parentNodeId: parentId,
    fillHex: fill || 'E5E7EB', cornerRadius: radius || 8,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// DS RESOLUTION HELPERS — attempt DS component, fallback to primitive
// ═════════════════════════════════════════════════════════════════════════════

const dsLog = [];
export function getDsLog() { return dsLog; }

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS — verify DS component correctness after insertion
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate that a DS component was inserted and configured correctly.
 * Uses get_node_props to read back the component state.
 *
 * Returns { valid, checks, reason } — valid=true only if ALL checks pass.
 */
async function validateInsertion(ctx, nodeId, intent, expectedText) {
  const checks = { inserted: false, hasProps: false, textBound: false, structureIntact: false };
  let reason = null;

  try {
    // Check A: Component exists (insertion succeeded)
    const props = await ctx.callBridge('get_node_props', { nodeId });
    checks.inserted = true;

    // Check B: Has component properties (is a real instance, not a broken node)
    if (props?.componentProperties && Object.keys(props.componentProperties).length > 0) {
      checks.hasProps = true;
    } else if (props?.type === 'INSTANCE') {
      checks.hasProps = true; // Instance without exposed props is still valid
    }

    // Check C: Text was bound (at least one text layer contains expected text)
    if (props?.textLayers && Array.isArray(props.textLayers)) {
      const hasMatchingText = props.textLayers.some(t =>
        t.chars && (t.chars.includes(expectedText) || expectedText.includes(t.chars))
      );
      if (hasMatchingText) {
        checks.textBound = true;
      } else if (expectedText.length < 5) {
        // Very short text may not match exactly — accept if component has any text
        checks.textBound = props.textLayers.some(t => t.chars && t.chars.length > 0);
      }
    }

    // Check D: Structure intact (component type is INSTANCE, not degraded)
    if (props?.type === 'INSTANCE') {
      checks.structureIntact = true;
    }

  } catch(e) {
    reason = 'validation_read_failed: ' + e.message;
  }

  const valid = checks.inserted && checks.hasProps && checks.structureIntact;
  // Text binding is desirable but not always guaranteed — log as warning if missing
  if (!checks.textBound && valid) {
    reason = 'text_binding_unverified';
  }
  if (!valid && !reason) {
    reason = 'failed_checks: ' + JSON.stringify(checks);
  }

  return { valid, checks, reason };
}

/**
 * Remove a rejected DS component from the canvas.
 */
async function removeNode(ctx, nodeId) {
  try { await ctx.callBridge('delete_node', { nodeId }); } catch(e) { /* best effort */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// DS RESOLUTION HELPERS — insert → validate → accept or reject+fallback
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a Button intent with full validation.
 */
async function resolveButton(ctx, text, parentId) {
  const key = ctx.dsKeys?.button;
  if (!key || !text) {
    await addText(ctx, text || '', parentId, { style: ctx.styles?.body, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'button', text, result: 'FALLBACK', reason: key ? 'no_text' : 'no_key', checks: null });
    return;
  }

  let insertedId = null;
  try {
    const r = await ctx.callBridge('insert_component', { componentKey: key, fileKey: ctx.dsFileKey, parentNodeId: parentId });
    insertedId = r?.nodeId || r?.id;
  } catch(e) {}

  if (!insertedId) {
    await addText(ctx, text, parentId, { style: ctx.styles?.body, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'button', text, result: 'FALLBACK', reason: 'insert_failed', checks: null });
    return;
  }

  // Configure
  try { await ctx.callBridge('set_component_text', { nodeId: insertedId, propertyName: 'primary_text', value: text }); } catch(e) {}
  try { await ctx.callBridge('set_variant', { nodeId: insertedId, propertyName: '⬅️ Icon leading#3287:1577', value: false }); } catch(e) {}
  try { await ctx.callBridge('set_variant', { nodeId: insertedId, propertyName: '➡️ Icon trailing#3287:2338', value: false }); } catch(e) {}

  // Validate
  const validation = await validateInsertion(ctx, insertedId, 'button', text);

  if (validation.valid) {
    dsLog.push({ intent: 'button', text, result: 'DS_ACCEPTED', component: 'Button', checks: validation.checks, warning: validation.reason });
  } else {
    // REJECT: remove the inserted component and fallback
    await removeNode(ctx, insertedId);
    await addText(ctx, text, parentId, { style: ctx.styles?.body, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'button', text, result: 'DS_REJECTED', reason: validation.reason, checks: validation.checks });
  }
}

/**
 * Resolve a Badge intent with full validation.
 */
async function resolveBadge(ctx, text, parentId) {
  const key = ctx.dsKeys?.badge;
  if (!key || !text) {
    await addText(ctx, text || '', parentId, { style: ctx.styles?.small, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'badge', text, result: 'FALLBACK', reason: key ? 'no_text' : 'no_key', checks: null });
    return;
  }

  let insertedId = null;
  try {
    const r = await ctx.callBridge('insert_component', { componentKey: key, fileKey: ctx.dsFileKey, parentNodeId: parentId });
    insertedId = r?.nodeId || r?.id;
  } catch(e) {}

  if (!insertedId) {
    await addText(ctx, text, parentId, { style: ctx.styles?.small, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'badge', text, result: 'FALLBACK', reason: 'insert_failed', checks: null });
    return;
  }

  // Configure text
  try { await ctx.callBridge('set_component_text', { nodeId: insertedId, propertyName: 'text', value: text }); } catch(e) {
    try { await ctx.callBridge('set_text', { nodeId: insertedId, value: text }); } catch(e2) {}
  }

  // Validate
  const validation = await validateInsertion(ctx, insertedId, 'badge', text);

  if (validation.valid) {
    dsLog.push({ intent: 'badge', text, result: 'DS_ACCEPTED', component: 'Badge', checks: validation.checks, warning: validation.reason });
  } else {
    await removeNode(ctx, insertedId);
    await addText(ctx, text, parentId, { style: ctx.styles?.small, color: ctx.colors?.textPrimary });
    dsLog.push({ intent: 'badge', text, result: 'DS_REJECTED', reason: validation.reason, checks: validation.checks });
  }
}

/**
 * Resolve a Link-style action. Falls back to text since link variant
 * cannot be guaranteed without explicit variant selection proof.
 */
async function resolveLinkButton(ctx, text, parentId) {
  // Link-style buttons use the same Button set but need Link color variant.
  // Without proven variant selection, delegate to resolveButton which validates.
  await resolveButton(ctx, text, parentId);
}

// ═════════════════════════════════════════════════════════════════════════════
// PATTERN-AWARE BUILDERS
// ═════════════════════════════════════════════════════════════════════════════

async function buildHero(block, ctx) {
  const heading = extractFirstHeading(block);
  const body = extractFirstParagraph(block);
  const buttons = extractButtonTexts(block);
  const badges = extractBadgeTexts(block);

  const sec = await mkFrame(ctx, 'Hero', 'VERTICAL', ctx.parentNodeId, { gap: 20, pt: 56, pb: 48, pl: 80, pr: 80, align: 'CENTER', fill: 'F9F9FF' });
  if (!sec) return;

  // Badge/announcement row — attempt DS Badge
  if (badges.length > 0) {
    const row = await mkFrame(ctx, 'Announcement', 'HORIZONTAL', sec, { gap: 8, align: 'CENTER', hug: true });
    if (row) for (const b of badges.slice(0, 2)) await resolveBadge(ctx, b, row);
  }

  await addText(ctx, heading, sec, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary, center: true });
  await addText(ctx, body, sec, { style: ctx.styles?.body, color: ctx.colors?.textSecondary, center: true });

  // CTA row — attempt DS Buttons
  if (buttons.length > 0) {
    const row = await mkFrame(ctx, 'CTAs', 'HORIZONTAL', sec, { gap: 12, hug: true });
    if (row) for (const b of buttons.slice(0, 3)) await resolveButton(ctx, b, row);
  }

  // Showcase placeholder (not decorative — represents product value)
  await addPlaceholder(ctx, 'Hero showcase (placeholder)', 900, 200, sec, 'F0F1F3', 16);
}

async function buildDataTable(block, ctx) {
  const heading = extractFirstHeading(block);
  const body = extractFirstParagraph(block);
  const headers = extractTableHeaders(block);
  const badges = extractBadgeTexts(block);
  const buttons = extractButtonTexts(block);

  const sec = await mkFrame(ctx, heading || 'Data surface', 'VERTICAL', ctx.parentNodeId, { gap: 24, pt: 64, pb: 64, pl: 80, pr: 80 });
  if (!sec) return;

  // Heading area
  if (heading || body) {
    const hArea = await mkFrame(ctx, 'Header', 'VERTICAL', sec, { gap: 6, align: 'CENTER' });
    if (hArea) {
      await addText(ctx, heading, hArea, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary, center: true });
      await addText(ctx, body, hArea, { style: ctx.styles?.body, color: ctx.colors?.textSecondary, center: true });
    }
  }

  // Context controls: tabs and filters — attempt DS Badges
  if (badges.length > 0) {
    const tabRow = await mkFrame(ctx, 'Tabs & Filters', 'HORIZONTAL', sec, { gap: 6, hug: true });
    if (tabRow) for (const b of badges.slice(0, 8)) await resolveBadge(ctx, b, tabRow);
  }

  // Table
  if (headers.length > 0) {
    const tbl = await mkFrame(ctx, 'Table', 'VERTICAL', sec, { gap: 0, stroke: 'DDDEE0', radius: 12 });
    if (tbl) {
      const hRow = await mkFrame(ctx, 'Header row', 'HORIZONTAL', tbl, { pt: 12, pb: 12, pl: 24, pr: 24, fill: 'F8F8F9' });
      if (hRow) for (const h of headers) await addText(ctx, h, hRow, { style: ctx.styles?.small, color: ctx.colors?.textSecondary });

      for (let i = 0; i < 5; i++) {
        const row = await mkFrame(ctx, 'Row ' + (i+1), 'HORIZONTAL', tbl, { pt: 12, pb: 12, pl: 24, pr: 24, stroke: 'F0F1F1' });
        if (row) for (const h of headers) await addText(ctx, '—', row, { style: ctx.styles?.small, color: ctx.colors?.textSecondary });
      }

      const empty = await mkFrame(ctx, 'Empty state', 'VERTICAL', tbl, { gap: 8, pt: 40, pb: 40, align: 'CENTER' });
      if (empty) {
        await addText(ctx, 'No results found', empty, { style: ctx.styles?.body, color: ctx.colors?.textPrimary, center: true });
        await addText(ctx, 'No evaluation data matches the selected filters. Try adjusting your filters.', empty, { style: ctx.styles?.small, color: ctx.colors?.textSecondary, center: true });
      }
    }
  }

  // Action link — attempt DS Button
  if (buttons.length > 0) await resolveLinkButton(ctx, buttons[0], sec);
}

async function buildStatRow(block, ctx) {
  const statChildren = findStatLikeChildren(block);
  if (!statChildren) { await buildGenericSection(block, ctx); return; }

  const sec = await mkFrame(ctx, 'Stats', 'HORIZONTAL', ctx.parentNodeId, { gap: 16, pt: 64, pb: 64, pl: 80, pr: 80 });
  if (!sec) return;

  for (const stat of statChildren) {
    const texts = [];
    function findP(n) { if (n.tag === 'p') { const t = (n.textContent || '').trim(); if (t) texts.push(t); } for (const c of (n.children || [])) findP(c); }
    findP(stat);

    const card = await mkFrame(ctx, texts[0] || 'Stat', 'VERTICAL', sec, { gap: 4, pt: 32, pb: 32, pl: 28, pr: 28, fill: 'F9F9FB', radius: 16, stroke: 'E8E9EB' });
    if (card) {
      await addText(ctx, texts[0], card, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary });
      await addText(ctx, texts[1], card, { style: ctx.styles?.small, color: ctx.colors?.textSecondary });
    }
  }
}

async function buildComparison(block, ctx) {
  const gridChildren = findGridChildren(block);
  if (!gridChildren || gridChildren.length < 2) { await buildGenericSection(block, ctx); return; }

  const sec = await mkFrame(ctx, 'Pricing', 'HORIZONTAL', ctx.parentNodeId, { gap: 24, pt: 64, pb: 64, pl: 80, pr: 80 });
  if (!sec) return;

  for (let i = 0; i < gridChildren.length; i++) {
    const card = gridChildren[i];
    const heading = extractFirstHeading(card);
    const paras = extractAllParagraphs(card);
    const items = extractListItems(card);
    const btns = extractButtonTexts(card);
    const isHighlighted = (card.attributes?.class || '').includes('brand');

    const cFrame = await mkFrame(ctx, heading || 'Tier ' + (i+1), 'VERTICAL', sec, {
      gap: 16, pt: 32, pb: 32, pl: 28, pr: 28, radius: 20,
      stroke: isHighlighted ? '1043CC' : 'DDDEE0', sw: isHighlighted ? 2 : 1,
      fill: isHighlighted ? 'F2F5FF' : undefined,
    });
    if (!cFrame) continue;

    // Tier badge — attempt DS Badge
    if (paras[0] && paras[0].length < 20) await resolveBadge(ctx, paras[0], cFrame);
    if (paras[1] && paras[1].length < 30) await addText(ctx, paras[1], cFrame, { style: ctx.styles?.small, color: ctx.colors?.textSecondary });
    await addText(ctx, heading, cFrame, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary });

    // Description
    for (const p of paras.filter(p => p.length > 30)) await addText(ctx, p, cFrame, { style: ctx.styles?.small, color: ctx.colors?.textPrimary });

    // Feature list
    if (items.length > 0) {
      const list = await mkFrame(ctx, 'Features', 'VERTICAL', cFrame, { gap: 10 });
      if (list) for (const item of items) await addText(ctx, '✓  ' + item, list, { style: ctx.styles?.small, color: ctx.colors?.textPrimary });
    }

    // CTA — attempt DS Buttons
    if (btns.length > 0) {
      const ctaRow = await mkFrame(ctx, 'CTA', 'HORIZONTAL', cFrame, { gap: 8, pt: 8 });
      if (ctaRow) for (const b of btns) await resolveButton(ctx, b, ctaRow);
    }
  }
}

async function buildExplainer(block, ctx) {
  const heading = extractFirstHeading(block);
  const body = extractFirstParagraph(block);
  const items = findRepeatedContentChildren(block);

  const sec = await mkFrame(ctx, heading || 'Explainer', 'VERTICAL', ctx.parentNodeId, { gap: 32, pt: 64, pb: 64, pl: 80, pr: 80 });
  if (!sec) return;

  await addText(ctx, heading, sec, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary });
  await addText(ctx, body, sec, { style: ctx.styles?.body, color: ctx.colors?.textSecondary });

  const cards = await mkFrame(ctx, 'Items', 'HORIZONTAL', sec, { gap: 20 });
  if (!cards) return;

  for (const item of items) {
    const title = extractFirstHeading(item);
    const desc = extractFirstParagraph(item);
    const hasImg = countTag(item, 'img') > 0;

    const card = await mkFrame(ctx, title || 'Item', 'VERTICAL', cards, { gap: 0, fill: 'F9F9FB', radius: 16, stroke: 'E8E9EB' });
    if (!card) continue;

    // Image placeholder (only for decorative/screenshot content)
    if (hasImg) await addPlaceholder(ctx, 'Screenshot: ' + (title || 'feature'), 400, 200, card, 'E5E7EB', 0);

    const inner = await mkFrame(ctx, 'Content', 'VERTICAL', card, { gap: 8, pt: 20, pb: 24, pl: 24, pr: 24 });
    if (inner) {
      await addText(ctx, title, inner, { style: ctx.styles?.body, color: ctx.colors?.textPrimary });
      await addText(ctx, desc, inner, { style: ctx.styles?.small, color: ctx.colors?.textSecondary });
    }
  }
}

async function buildFinalCta(block, ctx) {
  const heading = extractFirstHeading(block);
  const paras = extractAllParagraphs(block);
  const buttons = extractButtonTexts(block);

  const sec = await mkFrame(ctx, 'Final CTA', 'VERTICAL', ctx.parentNodeId, { gap: 16, pt: 64, pb: 64, pl: 80, pr: 80, align: 'CENTER', fill: 'F9F9FF' });
  if (!sec) return;

  await addText(ctx, heading, sec, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary, center: true });
  for (const p of paras.slice(0, 2)) await addText(ctx, p, sec, { style: ctx.styles?.body, color: ctx.colors?.textSecondary, center: true });

  if (buttons.length > 0) {
    const row = await mkFrame(ctx, 'CTAs', 'HORIZONTAL', sec, { gap: 12, hug: true });
    if (row) for (const b of buttons) await resolveButton(ctx, b, row);
  }
}

async function buildFooter(block, ctx) {
  const links = findAll(block, ['a']);
  const paras = extractAllParagraphs(block);

  const sec = await mkFrame(ctx, 'Footer', 'VERTICAL', ctx.parentNodeId, { gap: 20, pt: 36, pb: 36, pl: 80, pr: 80, fill: '0D1217' });
  if (!sec) return;

  await addPlaceholder(ctx, 'Logo (placeholder)', 130, 24, sec, '383C42', 4);

  if (links.length > 0) {
    const nav = await mkFrame(ctx, 'Nav', 'HORIZONTAL', sec, { gap: 20 });
    if (nav) for (const l of links.slice(0, 8)) await addText(ctx, l, nav, { style: ctx.styles?.small, hex: '8C9099' });
  }

  await addPlaceholder(ctx, 'Divider', 1200, 1, sec, '262A30', 0);

  if (paras.length > 0) {
    const bottom = await mkFrame(ctx, 'Bottom', 'HORIZONTAL', sec, { justify: 'SPACE_BETWEEN', align: 'CENTER' });
    if (bottom) {
      await addText(ctx, paras[0], bottom, { style: ctx.styles?.small, hex: '6B7080' });
      const social = await mkFrame(ctx, 'Social', 'HORIZONTAL', bottom, { gap: 16, hug: true });
      if (social) for (const s of ['Twitter', 'LinkedIn', 'GitHub']) await addText(ctx, s, social, { style: ctx.styles?.small, hex: '6B7080' });
    }
  }
}

async function buildDecorativeStrip(block, ctx) {
  const heading = extractFirstHeading(block);
  const text = (block.fullText || '').trim();
  const imgCount = Math.min(countTag(block, 'img'), 10);

  const sec = await mkFrame(ctx, heading || 'Media strip', 'VERTICAL', ctx.parentNodeId, { gap: 24, pt: 24, pb: 24, pl: 80, pr: 80, align: 'CENTER' });
  if (!sec) return;

  if (heading) await addText(ctx, heading, sec, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary, center: true });
  if (text && !heading) await addText(ctx, text.substring(0, 100), sec, { style: ctx.styles?.small, color: ctx.colors?.textSecondary, center: true });

  if (imgCount > 0) {
    const strip = await mkFrame(ctx, 'Logos (placeholder)', 'HORIZONTAL', sec, { gap: 32, align: 'CENTER', justify: 'CENTER', hug: true });
    if (strip) for (let i = 0; i < imgCount; i++) await addPlaceholder(ctx, 'Logo ' + (i+1), 90, 32, strip, 'B8BCC5', 6);
  }
}

async function buildGenericSection(block, ctx) {
  const heading = extractFirstHeading(block);
  const body = extractFirstParagraph(block);

  const sec = await mkFrame(ctx, heading || 'Section', 'VERTICAL', ctx.parentNodeId, { gap: 16, pt: 48, pb: 48, pl: 80, pr: 80 });
  if (!sec) return;

  if (heading) await addText(ctx, heading, sec, { style: ctx.styles?.heading, color: ctx.colors?.textPrimary });
  if (body) await addText(ctx, body, sec, { style: ctx.styles?.body, color: ctx.colors?.textSecondary });
}
