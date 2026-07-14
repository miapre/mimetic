'use strict';

/**
 * Real-handler tests for plugin/code.js's ensureFontLoaded() and the four
 * handlers that must call it before mutating an existing TEXT node's
 * .characters (set_component_text, set_component_text_by_id,
 * batch_set_component_text, set_text) — executed against the actual plugin
 * code via internal/tests/helpers/figma-stub.js.
 *
 * internal/tests/plugin-font-preload.test.js already covers this with a
 * portable reimplementation + static source checks (there was no execution
 * harness at the time it was written). This file adds real execution
 * coverage now that plugin/code.js exports its handlers: mixed-font nodes
 * via getRangeFontName, and font-load failure tolerance (a font that fails
 * to load must not block the .characters assignment — best-effort per the
 * inline doc comment on ensureFontLoaded).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

function makeTextInstance(stub, { name = 'Label', fontName, rangeFonts, characters = 'old text' } = {}) {
  const text = stub.createText();
  text.name = name;
  text.characters = characters;
  if (rangeFonts) {
    text._rangeFonts = rangeFonts;
    text.fontName = stub.mixed;
  } else if (fontName) {
    text.fontName = fontName;
  }
  stub.currentPage.appendChild(text);
  return text;
}

describe('plugin/code.js — ensureFontLoaded (real function, via exported helper)', () => {
  it('loads the single font a non-mixed TEXT node uses', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
    const text = makeTextInstance(stub, { fontName: { family: 'Roboto', style: 'Bold' } });

    await plugin.ensureFontLoaded(text);

    assert.deepEqual(stub._loadFontCalls, [{ family: 'Roboto', style: 'Bold' }]);
  });

  it('loads every DISTINCT font across a mixed-font node\'s character ranges (getRangeFontName)', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
    const text = makeTextInstance(stub, {
      characters: 'HelloWorld',
      rangeFonts: [
        { start: 0, end: 5, fontName: { family: 'Roboto', style: 'Bold' } },
        { start: 5, end: 10, fontName: { family: 'Roboto', style: 'Regular' } },
      ],
    });

    await plugin.ensureFontLoaded(text);

    const keys = stub._loadFontCalls.map((f) => f.family + '::' + f.style).sort();
    assert.deepEqual(keys, ['Roboto::Bold', 'Roboto::Regular']);
  });

  it('does not reload the same font twice across ranges that repeat it (dedup via loadedFontKeys)', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
    const text = makeTextInstance(stub, {
      characters: 'AAAAABBBBB',
      rangeFonts: [
        { start: 0, end: 1, fontName: { family: 'Inter', style: 'Regular' } },
        { start: 1, end: 2, fontName: { family: 'Inter', style: 'Regular' } },
        { start: 2, end: 10, fontName: { family: 'Inter', style: 'Regular' } },
      ],
    });

    await plugin.ensureFontLoaded(text);

    assert.equal(stub._loadFontCalls.length, 1, 'the same family::style must only be loaded once');
  });

  it('tolerates a font load failure — does not throw, just skips it', async () => {
    const stub = createFigmaStub({ loadFontFailures: ['MissingFont::Regular'] });
    const plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
    const text = makeTextInstance(stub, { fontName: { family: 'MissingFont', style: 'Regular' } });

    await assert.doesNotReject(plugin.ensureFontLoaded(text));
    assert.equal(plugin._state.loadedFontKeys.has('MissingFont::Regular'), false);
  });

  it('is a no-op for non-TEXT nodes', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
    const frame = stub.createFrame();
    await assert.doesNotReject(plugin.ensureFontLoaded(frame));
    assert.equal(stub._loadFontCalls.length, 0);
  });
});

describe('plugin/code.js — set_component_text / set_component_text_by_id / batch_set_component_text / set_text all await ensureFontLoaded before mutating .characters', () => {
  let stub;
  let plugin;

  beforeEach(() => {
    stub = createFigmaStub();
    plugin = loadPlugin(stub);
    stub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap
  });

  it('set_component_text loads the node\'s font before writing new characters', async () => {
    const root = stub.createFrame();
    stub.currentPage.appendChild(root);
    const text = makeTextInstance(stub, { name: 'Heading', fontName: { family: 'Poppins', style: 'SemiBold' } });
    root.appendChild(text);

    const result = await plugin.handlers.set_component_text({
      nodeId: root.id,
      textNodeName: 'Heading',
      content: 'New Heading',
    });

    assert.equal(result.characters, 'New Heading');
    assert.deepEqual(stub._loadFontCalls, [{ family: 'Poppins', style: 'SemiBold' }]);
  });

  it('set_component_text_by_id loads the font for a mixed-font node before writing', async () => {
    const root = stub.createFrame();
    stub.currentPage.appendChild(root);
    const text = makeTextInstance(stub, {
      characters: 'AB',
      rangeFonts: [
        { start: 0, end: 1, fontName: { family: 'OpenSans', style: 'Regular' } },
        { start: 1, end: 2, fontName: { family: 'OpenSans', style: 'Bold' } },
      ],
    });
    root.appendChild(text);

    const result = await plugin.handlers.set_component_text_by_id({
      nodeId: root.id,
      textNodeId: text.id,
      content: 'Replaced',
    });

    assert.equal(result.characters, 'Replaced');
    const keys = stub._loadFontCalls.map((f) => f.family + '::' + f.style).sort();
    assert.deepEqual(keys, ['OpenSans::Bold', 'OpenSans::Regular']);
  });

  it('batch_set_component_text loads fonts per text node before each write, tolerating one node\'s font failure', async () => {
    const failStub = createFigmaStub({ loadFontFailures: ['MissingFont::Regular'] });
    const failPlugin = loadPlugin(failStub);
    failStub._loadFontCalls.length = 0; // drop the Inter cold-start pre-warm calls from bootstrap

    const root = failStub.createFrame();
    failStub.currentPage.appendChild(root);
    const t1 = makeTextInstance(failStub, { name: 'Title', fontName: { family: 'Inter', style: 'Bold' } });
    const t2 = makeTextInstance(failStub, { name: 'Subtitle', fontName: { family: 'MissingFont', style: 'Regular' } });
    root.appendChild(t1);
    root.appendChild(t2);

    const result = await failPlugin.handlers.batch_set_component_text({
      nodeId: root.id,
      overrides: [
        { textNodeName: 'Title', content: 'New Title' },
        { textNodeName: 'Subtitle', content: 'New Subtitle' },
      ],
    });

    // Both writes proceed (best-effort font load) — a failed font load does
    // not block the .characters assignment, per ensureFontLoaded's contract.
    assert.equal(result.succeeded, 2);
    assert.equal(t1.characters, 'New Title');
    assert.equal(t2.characters, 'New Subtitle');
  });

  it('set_text loads the node\'s font before writing new characters', async () => {
    const text = makeTextInstance(stub, { fontName: { family: 'Lato', style: 'Medium' }, characters: 'x' });

    const result = await plugin.handlers.set_text({ nodeId: text.id, content: 'y' });

    assert.equal(result.characters, 'y');
    assert.deepEqual(stub._loadFontCalls, [{ family: 'Lato', style: 'Medium' }]);
  });
});
