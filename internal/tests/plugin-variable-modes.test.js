'use strict';

/**
 * Smoke test for plugin/code.js's handlers.set_all_variable_modes, executed
 * against the actual plugin code (via internal/tests/helpers/figma-stub.js).
 *
 * This is the handler CLAUDE.md's Artboard Setup step 2 depends on: "Call
 * figma_set_all_variable_modes with the artboard nodeId. This sets default
 * modes on ALL variable collections (including library collections).
 * Without it, DS variables render as black." It applies the mode to local
 * collections directly and to library collections resolved from whatever
 * variables happen to already be in variableCache (populated by prior
 * bind/preload calls) — the mode then cascades to descendants through
 * Figma's own inheritance, which this stub does not need to reimplement to
 * verify the handler applies the right mode to the right collections.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');

describe('plugin/code.js — handlers.set_all_variable_modes (real handler, smoke test)', () => {
  let stub;
  let plugin;
  let frameId;

  beforeEach(async () => {
    stub = createFigmaStub({
      localVariableCollections: [
        {
          id: 'VC:local-colors',
          name: 'Colors',
          modes: [{ modeId: 'M:light', name: 'Light' }, { modeId: 'M:dark', name: 'Dark' }],
          _variables: [{ id: 'V:bg', name: 'color/bg/primary', variableCollectionId: 'VC:local-colors' }],
        },
      ],
      libraryVariableCollections: [
        {
          id: 'VC:lib-spacing',
          key: 'lib-spacing-key',
          name: 'Spacing',
          modes: [{ modeId: 'M:default', name: 'Default' }],
          _variables: [{ id: 'V:sp-24', name: 'spacing/24', variableCollectionId: 'VC:lib-spacing' }],
        },
      ],
    });
    plugin = loadPlugin(stub);
    const frame = await plugin.handlers.create_frame({ name: 'Artboard' });
    frameId = frame.nodeId;
  });

  it('applies modeIndex 0 (light) to every LOCAL collection by default', async () => {
    const result = await plugin.handlers.set_all_variable_modes({ nodeId: frameId });

    assert.equal(result.collectionsApplied, 1);
    assert.deepEqual(result.collections, [{ collection: 'Colors', mode: 'Light', modeIndex: 0 }]);

    const node = stub.getNodeById(frameId);
    assert.equal(node._explicitModes['VC:local-colors'], 'M:light');
  });

  it('applies modeIndex 1 (dark) when requested', async () => {
    const result = await plugin.handlers.set_all_variable_modes({ nodeId: frameId, modeIndex: 1 });
    assert.deepEqual(result.collections, [{ collection: 'Colors', mode: 'Dark', modeIndex: 1 }]);

    const node = stub.getNodeById(frameId);
    assert.equal(node._explicitModes['VC:local-colors'], 'M:dark');
  });

  it('also resolves and applies LIBRARY collections whose variables are already cached (e.g. from a prior bind)', async () => {
    // Simulate a prior figma_read_variable_values / bind call having cached
    // a library variable — set_all_variable_modes walks variableCache to
    // discover library collection IDs it wouldn't otherwise see.
    plugin._state.variableCache.set('spacing/24', { id: 'V:sp-24', variableCollectionId: 'VC:lib-spacing' });

    const result = await plugin.handlers.set_all_variable_modes({ nodeId: frameId });

    assert.equal(result.collectionsApplied, 2);
    const names = result.collections.map((c) => c.collection).sort();
    assert.deepEqual(names, ['Colors', 'Spacing']);

    const node = stub.getNodeById(frameId);
    assert.equal(node._explicitModes['VC:lib-spacing'], 'M:default');
  });

  it('clamps modeIndex to the last available mode when the collection has fewer modes than requested', async () => {
    plugin._state.variableCache.set('spacing/24', { id: 'V:sp-24', variableCollectionId: 'VC:lib-spacing' });

    // Spacing only has 1 mode (index 0) — requesting index 1 should clamp to 0.
    const result = await plugin.handlers.set_all_variable_modes({ nodeId: frameId, modeIndex: 1 });
    const spacingEntry = result.collections.find((c) => c.collection === 'Spacing');
    assert.equal(spacingEntry.modeIndex, 0);
    assert.equal(spacingEntry.mode, 'Default');
  });

  it('throws NODE_NOT_FOUND for an unknown nodeId', async () => {
    await assert.rejects(
      plugin.handlers.set_all_variable_modes({ nodeId: '9:9999' }),
      (err) => {
        assert.equal(err.error, 'NODE_NOT_FOUND');
        return true;
      }
    );
  });
});
