'use strict';

/**
 * Real-handler tests for plugin/code.js's handlers.set_variant, executed
 * against the actual plugin code (via internal/tests/helpers/figma-stub.js).
 *
 * The appliedProperties contract: `applied[key]` is the coerced value that
 * was actually set on success, or `{ error: <message> }` on a per-key
 * failure. Wave-5 work depends on this being accurate per-key, not just a
 * single success/fail flag for the whole call — a set_variant call with 3
 * properties where only 1 fails must still report the other 2 as applied.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin, makeComponentStub } = require('./helpers/figma-stub');

describe('plugin/code.js — handlers.set_variant (real handler)', () => {
  let plugin;
  let stub;
  let instanceId;

  beforeEach(async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Button',
      componentProperties: {
        Size: { type: 'VARIANT', value: 'Medium' },
        Hierarchy: { type: 'VARIANT', value: 'Primary' },
        'Show icon': { type: 'BOOLEAN', value: false },
      },
    });
    stub = createFigmaStub({ registry, components: { 'button-key': comp } });
    plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'button-key', importMode: 'component' });
    instanceId = inserted.nodeId;
  });

  it('throws NODE_NOT_FOUND for an unknown nodeId', () => {
    assert.throws(
      () => plugin.handlers.set_variant({ nodeId: '9:9999', properties: { Size: 'Large' } }),
      (err) => {
        assert.equal(err.error, 'NODE_NOT_FOUND');
        return true;
      }
    );
  });

  it('throws INVALID_NODE_TYPE when the node is not an INSTANCE', () => {
    const frameId = (() => {
      const frame = stub.createFrame();
      stub.currentPage.appendChild(frame);
      return frame.id;
    })();
    assert.throws(
      () => plugin.handlers.set_variant({ nodeId: frameId, properties: { Size: 'Large' } }),
      (err) => {
        assert.equal(err.error, 'INVALID_NODE_TYPE');
        return true;
      }
    );
  });

  it('applies every property and reports the coerced value per key on full success', () => {
    const result = plugin.handlers.set_variant({
      nodeId: instanceId,
      properties: { Size: 'Large', Hierarchy: 'Secondary' },
    });
    assert.deepEqual(result.appliedProperties, { Size: 'Large', Hierarchy: 'Secondary' });

    const node = stub.getNodeById(instanceId);
    assert.equal(node.componentProperties.Size.value, 'Large');
    assert.equal(node.componentProperties.Hierarchy.value, 'Secondary');
  });

  it('coerces the string "true"/"false" to real booleans for BOOLEAN properties', () => {
    const result = plugin.handlers.set_variant({
      nodeId: instanceId,
      properties: { 'Show icon': 'true' },
    });
    assert.strictEqual(result.appliedProperties['Show icon'], true);
    const node = stub.getNodeById(instanceId);
    assert.strictEqual(node.componentProperties['Show icon'].value, true);
  });

  it('reports a per-key error object (not a call-wide failure) when ONE property key fails, while other keys still succeed', () => {
    const node = stub.getNodeById(instanceId);
    node._propFailKeys.add('Hierarchy'); // simulate this specific key throwing on setProperties

    const result = plugin.handlers.set_variant({
      nodeId: instanceId,
      properties: { Size: 'Small', Hierarchy: 'DoesNotExist' },
    });

    // Size succeeded independently of Hierarchy's failure.
    assert.equal(result.appliedProperties.Size, 'Small');
    assert.equal(node.componentProperties.Size.value, 'Small');

    // Hierarchy failed — reported as a per-key error object, not thrown.
    assert.equal(typeof result.appliedProperties.Hierarchy, 'object');
    assert.ok(result.appliedProperties.Hierarchy.error, 'failed key must carry an error object, not the raw value');
  });

  it('a single failing key does not stop earlier or later keys from being applied (order-independent per-key isolation)', () => {
    const node = stub.getNodeById(instanceId);
    node._propFailKeys.add('Size'); // fail the FIRST key this time

    const result = plugin.handlers.set_variant({
      nodeId: instanceId,
      properties: { Size: 'Small', Hierarchy: 'Secondary', 'Show icon': 'true' },
    });

    assert.ok(result.appliedProperties.Size.error);
    assert.equal(result.appliedProperties.Hierarchy, 'Secondary');
    assert.strictEqual(result.appliedProperties['Show icon'], true);
  });
});
