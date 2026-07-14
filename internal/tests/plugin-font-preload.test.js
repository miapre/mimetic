'use strict';

/**
 * Regression tests for audit finding B14 (Inter-only font pre-warm):
 *
 * plugin/code.js only ever pre-warmed Inter at cold start
 * (figma.loadFontAsync calls for family: 'Inter' near the message
 * dispatcher). Any DS using a different font family failed on the FIRST
 * text node that wasn't Inter, because handlers.set_component_text,
 * set_component_text_by_id, batch_set_component_text, and set_text all
 * assigned `.characters` on an EXISTING text node synchronously, with no
 * figma.loadFontAsync call for that node's actual font first. A promised
 * fix for this was documented but never landed.
 *
 * Fixed in plugin/code.js:
 *  1. ensureFontLoaded(node) — loads whatever font(s) a text node's
 *     current characters actually use (handles mixed-font nodes too)
 *     before the caller mutates it. Wired into all four handlers above.
 *  2. handlers.preload_fonts — an explicit, generic message type that
 *     accepts a list of {family, style} and loads them via
 *     figma.loadFontAsync, deduped, tolerating individual failures.
 *  3. The Inter cold-start pre-warm is UNCHANGED (kept as the default).
 *
 * plugin/code.js runs inside the Figma plugin sandbox (uses the global
 * `figma` API, no module.exports) and has no execution harness in this
 * repo — see internal/tests/batch-executor.test.js and
 * internal/tests/bridge-handler-contract.test.js for the two established
 * patterns this file follows:
 *   (a) a portable reimplementation of the dedup/tolerate-failure logic,
 *       tested in isolation (same approach as resolvePayloadRefs), and
 *   (b) static source-text assertions confirming the real file actually
 *       has the handler and calls the guard at each characters= site.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_CODE_PATH = path.join(__dirname, '..', '..', 'plugin', 'code.js');
const pluginSource = fs.readFileSync(PLUGIN_CODE_PATH, 'utf8');

// ── (a) Portable reimplementation of the font-loading logic ────────────────
// Mirrors plugin/code.js's loadFont()/preload_fonts handler so the dedup +
// tolerate-individual-failures contract can be tested without a `figma`
// global. Kept intentionally simple/parallel to the real implementation.

function fontKey(fontName) {
  return (fontName && fontName.family || '') + '::' + (fontName && fontName.style || '');
}

function makeFontLoader(loadFontAsyncImpl) {
  const loadedFontKeys = new Set();

  async function loadFont(fontName) {
    if (!fontName || !fontName.family) return false;
    const key = fontKey(fontName);
    if (loadedFontKeys.has(key)) return true;
    try {
      await loadFontAsyncImpl(fontName);
      loadedFontKeys.add(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function preloadFonts(fonts) {
    const loaded = [];
    const failed = [];
    const seen = {};
    for (const entry of (fonts || [])) {
      const f = entry || {};
      const family = f.family || f.fontFamily;
      const style = f.style || f.fontStyle || 'Regular';
      if (!family) continue;
      const key = fontKey({ family, style });
      if (seen[key]) continue;
      seen[key] = true;
      const ok = await loadFont({ family, style });
      (ok ? loaded : failed).push({ family, style });
    }
    return { requested: (fonts || []).length, loaded, failed, loadedCount: loaded.length, failedCount: failed.length };
  }

  return { loadFont, preloadFonts, loadedFontKeys };
}

describe('plugin font loading — dedup + tolerate-individual-failures (portable simulation)', () => {
  it('loads each distinct font exactly once, even if requested multiple times', async () => {
    let callCount = 0;
    const { preloadFonts } = makeFontLoader(async () => { callCount++; });

    const result = await preloadFonts([
      { family: 'Roboto', style: 'Regular' },
      { family: 'Roboto', style: 'Regular' },
      { family: 'Roboto', style: 'Bold' },
    ]);

    assert.strictEqual(callCount, 2, 'Roboto Regular should only be loaded once despite being requested twice');
    assert.strictEqual(result.loadedCount, 2);
    assert.deepStrictEqual(result.loaded.map(f => `${f.family}/${f.style}`).sort(), ['Roboto/Bold', 'Roboto/Regular']);
  });

  it('tolerates individual font failures — one bad font does not abort the rest', async () => {
    const { preloadFonts } = makeFontLoader(async (fontName) => {
      if (fontName.family === 'MissingFont') throw new Error('font not installed');
    });

    const result = await preloadFonts([
      { family: 'Roboto', style: 'Regular' },
      { family: 'MissingFont', style: 'Regular' },
      { family: 'OpenSans', style: 'Medium' },
    ]);

    assert.strictEqual(result.loadedCount, 2);
    assert.strictEqual(result.failedCount, 1);
    assert.deepStrictEqual(result.failed, [{ family: 'MissingFont', style: 'Regular' }]);
  });

  it('a font already loaded via loadFont() directly is not reloaded by preloadFonts()', async () => {
    let callCount = 0;
    const { loadFont, preloadFonts } = makeFontLoader(async () => { callCount++; });

    await loadFont({ family: 'Inter', style: 'Regular' });
    await preloadFonts([{ family: 'Inter', style: 'Regular' }]);

    assert.strictEqual(callCount, 1, 'session-level dedup should span both call paths');
  });

  it('accepts fontFamily/fontStyle as aliases for family/style', async () => {
    const { preloadFonts } = makeFontLoader(async () => {});
    const result = await preloadFonts([{ fontFamily: 'Poppins', fontStyle: 'SemiBold' }]);
    assert.strictEqual(result.loadedCount, 1);
    assert.deepStrictEqual(result.loaded, [{ family: 'Poppins', style: 'SemiBold' }]);
  });

  it('skips entries with no resolvable family instead of throwing', async () => {
    const { preloadFonts } = makeFontLoader(async () => {});
    const result = await preloadFonts([{ style: 'Regular' }, null, {}]);
    assert.strictEqual(result.requested, 3);
    assert.strictEqual(result.loadedCount, 0);
    assert.strictEqual(result.failedCount, 0, 'entries with no family are skipped, not counted as failures');
  });
});

describe('plugin/code.js — static source checks (real file, not the portable simulation)', () => {
  it('registers handlers.preload_fonts', () => {
    assert.match(pluginSource, /handlers\.preload_fonts\s*=/, 'plugin/code.js must define handlers.preload_fonts');
  });

  it('defines ensureFontLoaded and loadFont helpers', () => {
    assert.match(pluginSource, /function\s+ensureFontLoaded\s*\(/);
    assert.match(pluginSource, /async function\s+loadFont\s*\(/);
  });

  it('every handler that WRITES new content into .characters on an existing TEXT node calls ensureFontLoaded first (regression guard for the Inter-only bug)', () => {
    // For each `<x>.characters = <rhs>;` WRITE in a handler body (rhs is new
    // content, not a read-out copy like `props.characters = node.characters`),
    // the same handler must call ensureFontLoaded(<x>) somewhere before it.
    // (create_text is exempt — it creates a brand-new node and already loads
    // its font explicitly via payload.fontFamily/fontStyle before
    // figma.createText(), which is a different, already-correct code path.)
    const assignmentRe = /(\w+)\.characters\s*=\s*([^;]+);/g;

    // Map every `handlers.<name> =` declaration offset -> name, so we can
    // find which handler body an assignment offset falls inside.
    const handlerDeclRe = /handlers\.(\w+)\s*=/g;
    const handlerDecls = [];
    let hMatch;
    while ((hMatch = handlerDeclRe.exec(pluginSource))) {
      handlerDecls.push({ name: hMatch[1], index: hMatch.index });
    }
    function handlerNameAt(offset) {
      let name = '(unknown handler)';
      for (const decl of handlerDecls) {
        if (decl.index <= offset) name = decl.name;
        else break;
      }
      return name;
    }

    let match;
    const uncheckedAssignments = [];
    while ((match = assignmentRe.exec(pluginSource))) {
      const varName = match[1];
      const rhs = match[2].trim();
      const assignmentIndex = match.index;

      // Skip read-out copies (e.g. `props.characters = node.characters`) —
      // these report an existing value, they don't mutate a text node, so
      // no font needs to be loaded for them.
      if (/^\w+\.characters$/.test(rhs)) continue;

      const handlerName = handlerNameAt(assignmentIndex);
      if (handlerName === 'create_text') continue; // different, already-correct path

      // Look backwards up to 600 chars for an ensureFontLoaded(varName) call
      // — generous enough to span the lines between resolving the node and
      // setting .characters in each handler.
      const windowStart = Math.max(0, assignmentIndex - 600);
      const preceding = pluginSource.slice(windowStart, assignmentIndex);
      const guardRe = new RegExp('ensureFontLoaded\\(\\s*' + varName + '\\s*\\)');
      if (!guardRe.test(preceding)) {
        uncheckedAssignments.push(`handlers.${handlerName}: "${varName}.characters = ${rhs};" at offset ${assignmentIndex}`);
      }
    }

    assert.deepStrictEqual(uncheckedAssignments, [], 'found .characters write(s) with no preceding ensureFontLoaded guard:\n' + uncheckedAssignments.join('\n'));
  });

  it('the Inter cold-start pre-warm is kept as the default (not removed)', () => {
    assert.match(pluginSource, /loadFontAsync\(\{\s*family:\s*['"]Inter['"]/, 'cold-start Inter pre-warm must remain as the default');
  });
});
