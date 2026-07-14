'use strict';

/**
 * Real-handler regression tests: Paint/Effect union types unknown to this
 * codebase (SHADER, added to the Paint/Effect unions alongside Grid/Slots,
 * 2026) must pass through plugin/code.js untouched — never crash a read
 * path, never get silently stripped by a write path that didn't ask to
 * touch fills/strokes at all.
 *
 * Audit finding (see report): every existing paint/stroke type check in
 * plugin/code.js is an `===` equality guard (`fill.type === 'SOLID'`), not
 * an exhaustive switch/if-chain with a throwing default — so an unknown
 * type like 'SHADER' was already tolerated everywhere it's read
 * (get_node_props, get_text_info, validate_ds_compliance's hasFillBinding).
 * These tests lock that behavior in as a regression guard, using a stub
 * node whose `fills`/`strokes` arrays contain a SHADER paint the plugin has
 * no explicit handling for.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

const SHADER_PAINT = { type: 'SHADER', visible: true };

describe('plugin/code.js — SHADER paint tolerance (real handler)', () => {
  it('get_node_props reports an unknown SHADER fill type without crashing or synthesizing a color', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const result = await plugin.handlers.create_frame({ name: 'Shader Panel', parentId: null });
    const node = stub.getNodeById(result.nodeId);

    // Simulate a node whose fills already include a SHADER paint alongside
    // an ordinary SOLID one (the mixed case a real design file could have).
    node.fills = [SHADER_PAINT, { type: 'SOLID', color: { r: 1, g: 0, b: 0 }, visible: true, opacity: 1 }];

    const props = plugin.handlers.get_node_props({ nodeId: result.nodeId });
    assert.equal(props.fills.length, 2);
    assert.equal(props.fills[0].type, 'SHADER');
    assert.equal(props.fills[0].color, undefined, 'no color synthesized for a non-SOLID paint');
    assert.equal(props.fills[1].type, 'SOLID');
    assert.deepEqual(props.fills[1].color, { r: 255, g: 0, b: 0 });
  });

  it('get_text_info does not crash when a TEXT node\'s first fill is SHADER', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const result = await plugin.handlers.create_text({ parentId: null, content: 'Hello' });
    const node = stub.getNodeById(result.nodeId);
    node.fills = [SHADER_PAINT];

    const info = plugin.handlers.get_text_info({ nodeId: result.nodeId });
    assert.equal(info.characters, 'Hello');
    assert.equal(info.fillColor, undefined);
  });

  it('validate_ds_compliance does not throw and does not flag a SHADER-only fill as a missing-variable violation', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const result = await plugin.handlers.create_frame({ name: 'Shader Panel', parentId: null });
    const node = stub.getNodeById(result.nodeId);
    node.fills = [SHADER_PAINT];

    const report = plugin.handlers.validate_ds_compliance({ nodeId: result.nodeId, enforceColorVars: true, enforceTextStyles: false });
    assert.equal(report.summary.totalNodes, 1);
    // No SOLID fill present -> no MISSING_FILL_VARIABLE violation should fire
    // for this node (the walk() logic only flags nodes with an unbound
    // SOLID fill; a SHADER-only fill array has none).
    assert.equal(report.violations.filter((v) => v.nodeId === result.nodeId).length, 0);
  });

  it('restyle_artboard leaves an existing SHADER fill untouched when no fillVariable/fill is passed', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const result = await plugin.handlers.create_frame({ name: 'Shader Panel', parentId: null });
    const node = stub.getNodeById(result.nodeId);
    node.fills = [SHADER_PAINT];

    plugin.handlers.restyle_artboard({ nodeId: result.nodeId, cornerRadius: 12 });

    assert.equal(node.cornerRadius, 12);
    assert.deepEqual(node.fills, [SHADER_PAINT], 'fills must be untouched — restyle_artboard only writes fills when a fill param is explicitly given');
  });
});
