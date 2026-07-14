'use strict';

/**
 * Tests for plugin/code.js's handlers.batch_execute — the $resultOf
 * reference-resolution + parent-grouping executor.
 *
 * This file previously tested a hand-maintained PORTABLE REIMPLEMENTATION
 * of resolvePayloadRefs (a copy of the closure inside handlers.batch_execute)
 * rather than the real plugin code, because plugin/code.js had no execution
 * harness at the time. Now that plugin/code.js exports its handlers (see
 * internal/tests/helpers/figma-stub.js), this file drives the REAL
 * handlers.batch_execute end-to-end against real handlers (create_frame,
 * set_node_props, etc.) running on a FigmaStub, and asserts on batch_execute's
 * actual output — no duplicated resolution logic lives in this test file.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin, makeComponentStub } = require('./helpers/figma-stub');

describe('batch_execute — $resultOf reference resolution (real handler)', () => {
  let stub;
  let plugin;

  beforeEach(() => {
    stub = createFigmaStub();
    plugin = loadPlugin(stub);
  });

  it('substitutes $resultOf:N with result.nodeId (default field) to parent a real created node', async () => {
    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { name: 'Parent' } },
        { type: 'create_frame', payload: { name: 'Child', parentId: '$resultOf:0' } },
      ],
    });

    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);

    const parentNode = stub.getNodeById(results[0].result.nodeId);
    const childNode = stub.getNodeById(results[1].result.nodeId);
    assert.equal(childNode.parent.id, parentNode.id, 'child must actually be parented under the frame created by op 0');
  });

  it('substitutes $resultOf:N.field for explicit field access (e.g. reusing a created node\'s name)', async () => {
    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { name: 'Source Name' } },
        { type: 'create_frame', payload: { name: '$resultOf:0.name' } },
      ],
    });

    const secondNode = stub.getNodeById(results[1].result.nodeId);
    assert.equal(secondNode.name, 'Source Name');
  });

  it('a dependent op is SKIPPED_DEPENDENCY_FAILED (not executed) when its $resultOf reference points at a failed operation', async () => {
    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { parentId: 'nonexistent:1' } }, // fails: NODE_NOT_FOUND
        { type: 'create_frame', payload: { parentId: '$resultOf:0' } },
      ],
    });

    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error, 'SKIPPED_DEPENDENCY_FAILED');
  });

  it('an out-of-bounds $resultOf reference resolves to null and is SKIPPED_DEPENDENCY_FAILED, not thrown', async () => {
    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { parentId: '$resultOf:99' } },
      ],
    });

    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'SKIPPED_DEPENDENCY_FAILED');
  });

  it('resolves a 3-level dependency chain end to end', async () => {
    const { results, succeeded } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { name: 'Grandparent' } },
        { type: 'create_frame', payload: { name: 'Parent', parentId: '$resultOf:0' } },
        { type: 'create_frame', payload: { name: 'Child', parentId: '$resultOf:1' } },
      ],
    });

    assert.equal(succeeded, 3);
    const grandparent = stub.getNodeById(results[0].result.nodeId);
    const parent = stub.getNodeById(results[1].result.nodeId);
    const child = stub.getNodeById(results[2].result.nodeId);
    assert.equal(parent.parent.id, grandparent.id);
    assert.equal(child.parent.id, parent.id);
  });

  it('leaves a literal nodeId untouched when it is not a $resultOf reference', async () => {
    const frame = await plugin.handlers.create_frame({ name: 'Existing' });
    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_frame', payload: { name: 'Child', parentId: frame.nodeId } },
      ],
    });
    const childNode = stub.getNodeById(results[0].result.nodeId);
    assert.equal(childNode.parent.id, frame.nodeId);
  });

  it('resolves $resultOf references inside nested objects (e.g. set_variant properties)', async () => {
    // Build a component importable against a fresh, shared registry so the
    // instance insert_component creates is a real, queryable node.
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Button',
      componentProperties: { Size: { type: 'VARIANT', value: 'Medium' } },
    });
    stub = createFigmaStub({ registry, components: { 'btn-key': comp } });
    plugin = loadPlugin(stub);

    const { results } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'insert_component', payload: { componentKey: 'btn-key', importMode: 'component' } },
        { type: 'set_variant', payload: { nodeId: '$resultOf:0', properties: { Size: 'Large' } } },
      ],
    });

    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].result.appliedProperties.Size, 'Large');
  });
});

describe('batch_execute — grouping across parents does not lose or reorder operations', () => {
  let stub;
  let plugin;

  beforeEach(() => {
    stub = createFigmaStub();
    plugin = loadPlugin(stub);
  });

  it('executes every operation across alternating parents, preserving index order in results', async () => {
    const parentA = await plugin.handlers.create_frame({ name: 'A' });
    const parentB = await plugin.handlers.create_frame({ name: 'B' });

    const { results, totalOps, succeeded, failed } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'create_text', payload: { parentId: parentA.nodeId, characters: '1' } },
        { type: 'create_text', payload: { parentId: parentB.nodeId, characters: '2' } },
        { type: 'create_text', payload: { parentId: parentA.nodeId, characters: '3' } },
        { type: 'create_text', payload: { parentId: parentB.nodeId, characters: '4' } },
      ],
    });

    assert.equal(totalOps, 4);
    assert.equal(succeeded, 4);
    assert.equal(failed, 0);
    assert.deepEqual(results.map((r) => r.index), [0, 1, 2, 3]);

    const parentANode = stub.getNodeById(parentA.nodeId);
    const parentBNode = stub.getNodeById(parentB.nodeId);
    assert.equal(parentANode.children.length, 2);
    assert.equal(parentBNode.children.length, 2);
  });
});

describe('batch_execute — top-level contract (real handler)', () => {
  let plugin;

  beforeEach(() => {
    plugin = loadPlugin(createFigmaStub());
  });

  it('returns an empty result immediately for zero operations', async () => {
    const result = await plugin.handlers.batch_execute({ operations: [] });
    assert.deepEqual(result, { results: [], totalOps: 0, succeeded: 0, failed: 0 });
  });

  it('rejects with BATCH_TOO_LARGE above the 200-operation cap', async () => {
    const operations = Array.from({ length: 201 }, () => ({ type: 'create_frame', payload: {} }));
    await assert.rejects(
      plugin.handlers.batch_execute({ operations }),
      (err) => {
        assert.equal(err.error, 'BATCH_TOO_LARGE');
        return true;
      }
    );
  });

  it('reports UNKNOWN_HANDLER for an unregistered operation type, without aborting the rest of the batch', async () => {
    const { results, succeeded, failed } = await plugin.handlers.batch_execute({
      operations: [
        { type: 'not_a_real_handler', payload: {} },
        { type: 'create_frame', payload: { name: 'Still Runs' } },
      ],
    });
    assert.equal(results[0].error, 'UNKNOWN_HANDLER');
    assert.equal(results[1].ok, true);
    assert.equal(succeeded, 1);
    assert.equal(failed, 1);
  });
});
