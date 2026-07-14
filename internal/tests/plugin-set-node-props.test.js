'use strict';

/**
 * Real-handler tests for plugin/code.js's handlers.set_node_props and
 * handlers.set_layout_sizing, executed against the actual plugin code
 * (via internal/tests/helpers/figma-stub.js), not a reimplementation.
 *
 * set_node_props was added this sprint to fix audit BUG 1: src/tools/table.js
 * sent `set_node_props` (carrying paddingLeftVariable / paddingRightVariable
 * for card-inset tables) to a plugin that had no matching handler, so
 * `firstColumnPaddingLeft` / `lastColumnPaddingRight` silently did nothing.
 * internal/tests/bridge-handler-contract.test.js already guards that a
 * handler with this name EXISTS (static check); this file goes further and
 * exercises its actual padding-binding behavior against a live node.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

function stubWithSpacingVars() {
  return createFigmaStub({
    localVariableCollections: [
      {
        id: 'VC:spacing',
        name: 'Spacing',
        modes: [{ modeId: 'M:1', name: 'Default' }],
        _variables: [
          { id: 'V:sp-24', name: 'spacing/24', variableCollectionId: 'VC:spacing' },
          { id: 'V:sp-16', name: 'spacing/16', variableCollectionId: 'VC:spacing' },
        ],
      },
    ],
  });
}

describe('plugin/code.js — handlers.set_node_props (real handler)', () => {
  let plugin;
  let stub;
  let frameId;

  beforeEach(async () => {
    stub = stubWithSpacingVars();
    plugin = loadPlugin(stub);
    const frame = await plugin.handlers.create_frame({ name: 'Table Cell' });
    frameId = frame.nodeId;
  });

  it('binds paddingLeftVariable / paddingRightVariable independently (the card-inset table use case, BUG 1)', () => {
    const result = plugin.handlers.set_node_props({
      nodeId: frameId,
      paddingLeftVariable: 'spacing/24',
      paddingRightVariable: 'spacing/24',
    });
    assert.equal(result.applied.paddingLeftVariable, true);
    assert.equal(result.applied.paddingRightVariable, true);
    assert.equal(result.bindingFailures, false);
  });

  it('actually mutates node.boundVariables via setBoundVariable (not just reporting applied=true)', () => {
    plugin.handlers.set_node_props({
      nodeId: frameId,
      paddingLeftVariable: 'spacing/24',
      paddingRightVariable: 'spacing/16',
    });
    const node = stub.getNodeById(frameId);
    assert.ok(node.boundVariables.paddingLeft, 'paddingLeft should have a bound variable alias');
    assert.equal(node.boundVariables.paddingLeft.id, 'V:sp-24');
    assert.ok(node.boundVariables.paddingRight);
    assert.equal(node.boundVariables.paddingRight.id, 'V:sp-16');
  });

  it('applies shorthand paddingVariable to all four sides', () => {
    const result = plugin.handlers.set_node_props({
      nodeId: frameId,
      paddingVariable: 'spacing/24',
    });
    assert.equal(result.applied.paddingVariable, true);
    const node = stub.getNodeById(frameId);
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      assert.equal(node.boundVariables[side].id, 'V:sp-24', side + ' should be bound to spacing/24');
    }
  });

  it('reports a binding failure with a descriptive warning when the variable path does not exist', () => {
    const result = plugin.handlers.set_node_props({
      nodeId: frameId,
      paddingLeftVariable: 'spacing/does-not-exist',
    });
    assert.equal(result.applied.paddingLeftVariable, false);
    assert.equal(result.bindingFailures, true);
    assert.match(result.warnings[0], /paddingLeftVariable/);
  });

  it('applies raw numeric padding overrides alongside/independent of variable bindings', () => {
    const result = plugin.handlers.set_node_props({
      nodeId: frameId,
      paddingTop: 12,
      paddingBottom: 8,
    });
    assert.equal(result.paddingTop, 12);
    assert.equal(result.paddingBottom, 8);
    assert.deepEqual(result.applied, {});
  });

  it('throws NODE_NOT_FOUND for an unknown nodeId', () => {
    assert.throws(
      () => plugin.handlers.set_node_props({ nodeId: '9:9999', paddingTop: 4 }),
      (err) => {
        assert.equal(err.error, 'NODE_NOT_FOUND');
        return true;
      }
    );
  });
});

describe('plugin/code.js — handlers.set_layout_sizing (real handler)', () => {
  let plugin;
  let stub;
  let frameId;

  beforeEach(async () => {
    stub = stubWithSpacingVars();
    plugin = loadPlugin(stub);
    const frame = await plugin.handlers.create_frame({ name: 'Card' });
    frameId = frame.nodeId;
  });

  it('sets layoutSizingHorizontal/Vertical and reports them back', () => {
    const result = plugin.handlers.set_layout_sizing({
      nodeId: frameId,
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
    });
    assert.equal(result.layoutSizingHorizontal, 'FILL');
    assert.equal(result.layoutSizingVertical, 'HUG');
  });

  it('resizes the node when width/height are provided', () => {
    plugin.handlers.set_layout_sizing({ nodeId: frameId, width: 320, height: 240 });
    const node = stub.getNodeById(frameId);
    assert.equal(node.width, 320);
    assert.equal(node.height, 240);
  });

  it('resizes using the existing dimension when only one of width/height is given', () => {
    const node = stub.getNodeById(frameId);
    node.width = 100;
    node.height = 50;
    plugin.handlers.set_layout_sizing({ nodeId: frameId, width: 200 });
    assert.equal(node.width, 200);
    assert.equal(node.height, 50, 'height should be untouched when only width is provided');
  });

  it('binds the padding shorthand variable to all four sides via bindVariable', () => {
    const result = plugin.handlers.set_layout_sizing({
      nodeId: frameId,
      paddingVariable: 'spacing/24',
    });
    assert.equal(result.applied.paddingVariable, true);
    assert.equal(result.bindingFailures, false);
    const node = stub.getNodeById(frameId);
    assert.equal(node.boundVariables.paddingTop.id, 'V:sp-24');
    assert.equal(node.boundVariables.itemSpacing, undefined, 'padding binding must not touch itemSpacing');
  });

  it('binds gapVariable to itemSpacing, tracked independently from padding', () => {
    const result = plugin.handlers.set_layout_sizing({
      nodeId: frameId,
      gapVariable: 'spacing/16',
      paddingLeftVariable: 'spacing/does-not-exist',
    });
    assert.equal(result.applied.gapVariable, true);
    assert.equal(result.applied.paddingLeftVariable, false);
    assert.equal(result.bindingFailures, true);
    const node = stub.getNodeById(frameId);
    assert.equal(node.boundVariables.itemSpacing.id, 'V:sp-16');
  });

  it('falls back to raw gap number when gapVariable is not provided', () => {
    const result = plugin.handlers.set_layout_sizing({ nodeId: frameId, gap: 20 });
    assert.deepEqual(result.applied, {});
    const node = stub.getNodeById(frameId);
    assert.equal(node.itemSpacing, 20);
  });

  it('throws NODE_NOT_FOUND for an unknown nodeId', () => {
    assert.throws(
      () => plugin.handlers.set_layout_sizing({ nodeId: '9:9999' }),
      (err) => {
        assert.equal(err.error, 'NODE_NOT_FOUND');
        return true;
      }
    );
  });
});
