'use strict';

/**
 * Real-handler tests for plugin/code.js's handlers.preload_fonts, executed
 * against the actual plugin code (via internal/tests/helpers/figma-stub.js).
 *
 * internal/tests/plugin-font-preload.test.js already covers the dedup +
 * tolerate-individual-failures contract with a portable reimplementation
 * (written before this file's execution harness existed). This file
 * exercises the REAL exported handlers.preload_fonts instead.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

describe('plugin/code.js — handlers.preload_fonts (real handler)', () => {
  let stub;
  let plugin;

  beforeEach(() => {
    stub = createFigmaStub();
    plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
  });

  it('loads each distinct font exactly once, even if requested multiple times', async () => {
    const result = await plugin.handlers.preload_fonts({
      fonts: [
        { family: 'Roboto', style: 'Regular' },
        { family: 'Roboto', style: 'Regular' },
        { family: 'Roboto', style: 'Bold' },
      ],
    });

    assert.equal(stub._loadFontCalls.length, 2, 'Roboto Regular should only be loaded once despite being requested twice');
    assert.equal(result.loadedCount, 2);
    assert.deepEqual(
      result.loaded.map((f) => `${f.family}/${f.style}`).sort(),
      ['Roboto/Bold', 'Roboto/Regular']
    );
  });

  it('tolerates individual font failures — one bad font does not abort the rest', async () => {
    stub = createFigmaStub({ loadFontFailures: ['MissingFont::Regular'] });
    plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0;

    const result = await plugin.handlers.preload_fonts({
      fonts: [
        { family: 'Roboto', style: 'Regular' },
        { family: 'MissingFont', style: 'Regular' },
        { family: 'OpenSans', style: 'Medium' },
      ],
    });

    assert.equal(result.loadedCount, 2);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.failed, [{ family: 'MissingFont', style: 'Regular' }]);
  });

  it('accepts fontFamily/fontStyle as aliases for family/style', async () => {
    const result = await plugin.handlers.preload_fonts({
      fonts: [{ fontFamily: 'Poppins', fontStyle: 'SemiBold' }],
    });
    assert.equal(result.loadedCount, 1);
    assert.deepEqual(result.loaded, [{ family: 'Poppins', style: 'SemiBold' }]);
  });

  it('skips entries with no resolvable family instead of throwing', async () => {
    const result = await plugin.handlers.preload_fonts({
      fonts: [{ style: 'Regular' }, null, {}],
    });
    assert.equal(result.requested, 3);
    assert.equal(result.loadedCount, 0);
    assert.equal(result.failedCount, 0, 'entries with no family are skipped, not counted as failures');
  });

  it('a font already loaded via a prior handler call is not reloaded (session-level dedup spans handlers)', async () => {
    // Cold-start-independent: force a real distinct family/style through
    // set_text first, then confirm preload_fonts sees it as already loaded.
    const text = stub.createText();
    text.name = 'x';
    text.fontName = { family: 'Inter', style: 'Black' };
    text.characters = 'x';
    stub.currentPage.appendChild(text);
    await plugin.handlers.set_text({ nodeId: text.id, content: 'y' });

    stub._loadFontCalls.length = 0; // reset so we only observe THIS call
    const result = await plugin.handlers.preload_fonts({ fonts: [{ family: 'Inter', style: 'Black' }] });

    assert.equal(stub._loadFontCalls.length, 0, 'already-loaded font must not trigger another figma.loadFontAsync call');
    assert.equal(result.loadedCount, 1, 'still reported as loaded — it was, just earlier');
  });

  it('accepts fonts passed as a JSON-stringified array (coerceArray)', async () => {
    const result = await plugin.handlers.preload_fonts({
      fonts: JSON.stringify([{ family: 'Merriweather', style: 'Regular' }]),
    });
    assert.equal(result.loadedCount, 1);
  });

  it('reports loadedFontCacheSize reflecting the session-wide loaded-font set', async () => {
    const result = await plugin.handlers.preload_fonts({
      fonts: [{ family: 'A', style: 'Regular' }, { family: 'B', style: 'Regular' }],
    });
    // +4 for the Inter cold-start pre-warm already in loadedFontKeys.
    assert.equal(result.loadedFontCacheSize, plugin._state.loadedFontKeys.size);
    assert.ok(result.loadedFontCacheSize >= 2);
  });
});
