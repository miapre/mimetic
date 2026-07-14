'use strict';

/**
 * Real-handler tests for Figma Slots support (GA June 2026) in
 * plugin/code.js: collectConfigurationHints exposing slotProperties +
 * property types, and the new handlers.fill_slot / handlers.reset_slot.
 *
 * The exact Slots plugin-API write shape (how a SLOT property is actually
 * filled/reset) is NOT confirmed against live Figma docs/behavior — see the
 * doc comments on handlers.fill_slot / handlers.reset_slot in plugin/code.js.
 * These tests exercise the PRIMARY assumed path (setProperties()-based fill,
 * a resetSlot() method call for reset) plus the fallback/error paths, using
 * the figma-stub harness (which we control) rather than a real Figma host.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin, makeComponentStub } = require('./helpers/figma-stub');

describe('plugin/code.js — collectConfigurationHints: slotProperties + type merge', () => {
  let plugin;

  beforeEach(() => {
    const stub = createFigmaStub();
    plugin = loadPlugin(stub);
  });

  it('surfaces SLOT-type component properties in configurationHints.slotProperties', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: {
        'Content#12:3': { type: 'SLOT', value: 'node:default-content' },
        'Show footer': { type: 'BOOLEAN', value: true },
      },
    });
    const stub = createFigmaStub({ registry, components: { 'card-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    assert.equal(result.configurationHints.slotProperties.length, 1);
    assert.equal(result.configurationHints.slotProperties[0].name, 'Content');
    assert.equal(result.configurationHints.slotProperties[0].key, 'Content#12:3');
    assert.equal(result.configurationHints.slotProperties[0].current, 'node:default-content');
  });

  it('attaches property type onto matching variantProperties entries', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Button',
      parent: {
        type: 'COMPONENT_SET',
        variantGroupProperties: {
          Size: { values: ['Small', 'Medium', 'Large'] },
        },
      },
      variantProperties: { Size: 'Medium' },
      componentProperties: {
        'Size': { type: 'VARIANT', value: 'Medium' },
      },
    });
    const stub = createFigmaStub({ registry, components: { 'button-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({ componentKey: 'button-key', importMode: 'component' });
    assert.equal(result.configurationHints.variantProperties.Size.type, 'VARIANT');
  });

  it('does not throw and reports an empty slotProperties list when componentProperties has no SLOT entries', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Legacy Button',
      componentProperties: { 'Disabled': { type: 'BOOLEAN', value: false } },
    });
    const stub = createFigmaStub({ registry, components: { 'legacy-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({ componentKey: 'legacy-key', importMode: 'component' });
    assert.deepEqual(result.configurationHints.slotProperties, []);
  });
});

describe('plugin/code.js — handlers.fill_slot (real handler)', () => {
  it('throws MISSING_PARAM when slotName or componentKey is absent (on a valid node)', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, { name: 'Card', componentProperties: {} });
    const stub = createFigmaStub({ registry, components: { 'card-key': host } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    assert.throws(() => plugin.handlers.fill_slot({ nodeId: inserted.nodeId }), (err) => {
      assert.equal(err.error, 'MISSING_PARAM');
      assert.equal(err.property, 'slotName');
      return true;
    });
    assert.throws(() => plugin.handlers.fill_slot({ nodeId: inserted.nodeId, slotName: 'Content' }), (err) => {
      assert.equal(err.error, 'MISSING_PARAM');
      assert.equal(err.property, 'componentKey');
      return true;
    });
  });

  it('throws NODE_NOT_FOUND for an unknown nodeId', () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    assert.throws(() => plugin.handlers.fill_slot({ nodeId: 'nope', slotName: 'Content', componentKey: 'k' }), (err) => {
      assert.equal(err.error, 'NODE_NOT_FOUND');
      return true;
    });
  });

  it('fills a SLOT property via setProperties (primary assumed path) with the newly created instance id', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: { 'Content#1:1': { type: 'SLOT', value: null } },
    });
    const fillComp = makeComponentStub(registry, { name: 'Metric Card', key: 'fill-key' });
    const stub = createFigmaStub({
      registry,
      components: { 'card-key': host, 'fill-key': fillComp },
    });
    const plugin = loadPlugin(stub);

    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });
    const result = await plugin.handlers.fill_slot({
      nodeId: inserted.nodeId,
      slotName: 'Content',
      componentKey: 'fill-key',
    });

    assert.equal(result.slotName, 'Content');
    assert.equal(result.filledWithKey, 'fill-key');
    assert.ok(result.filledInstanceId);

    const hostNode = stub.getNodeById(inserted.nodeId);
    assert.equal(hostNode.componentProperties['Content#1:1'].value, result.filledInstanceId);
  });

  it('throws SLOT_NOT_FOUND with the available slot names when slotName does not match any SLOT property', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: { 'Header#1:1': { type: 'SLOT', value: null } },
    });
    const stub = createFigmaStub({ registry, components: { 'card-key': host } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    assert.throws(
      () => plugin.handlers.fill_slot({ nodeId: inserted.nodeId, slotName: 'Content', componentKey: 'fill-key' }),
      (err) => {
        assert.equal(err.error, 'SLOT_NOT_FOUND');
        assert.deepEqual(err.available, ['Header']);
        return true;
      }
    );
  });

  it('falls back to fillSlot() when setProperties throws, and reports SLOT_FILL_UNSUPPORTED when neither works', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: { 'Content#1:1': { type: 'SLOT', value: null } },
    });
    const fillComp = makeComponentStub(registry, { name: 'Metric Card', key: 'fill-key' });
    const stub = createFigmaStub({ registry, components: { 'card-key': host, 'fill-key': fillComp } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    const hostNode = stub.getNodeById(inserted.nodeId);
    hostNode._propFailKeys.add('Content#1:1'); // force setProperties() to throw for this key

    // No fillSlot() method on the stub node — fallback also unavailable.
    await assert.rejects(
      () => plugin.handlers.fill_slot({ nodeId: inserted.nodeId, slotName: 'Content', componentKey: 'fill-key' }),
      (err) => {
        assert.equal(err.error, 'SLOT_FILL_UNSUPPORTED');
        return true;
      }
    );

    // Now simulate a host exposing a dedicated fillSlot() method — fallback succeeds.
    let fillSlotCalledWith = null;
    hostNode.fillSlot = (key, inst) => { fillSlotCalledWith = { key, inst }; };
    const result = await plugin.handlers.fill_slot({ nodeId: inserted.nodeId, slotName: 'Content', componentKey: 'fill-key' });
    assert.equal(fillSlotCalledWith.key, 'Content#1:1');
    assert.equal(result.slotName, 'Content');
  });
});

describe('plugin/code.js — handlers.reset_slot (real handler)', () => {
  it('throws SLOT_NOT_FOUND when no SLOT property matches (e.g. pre-Slots Figma version)', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, { name: 'Legacy', componentProperties: {} });
    const stub = createFigmaStub({ registry, components: { 'legacy-key': host } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'legacy-key', importMode: 'component' });

    assert.throws(
      () => plugin.handlers.reset_slot({ nodeId: inserted.nodeId, slotName: 'Content' }),
      (err) => {
        assert.equal(err.error, 'SLOT_NOT_FOUND');
        return true;
      }
    );
  });

  it('resets via node.resetSlot(key) when available', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: { 'Content#1:1': { type: 'SLOT', value: 'node:something' } },
    });
    const stub = createFigmaStub({ registry, components: { 'card-key': host } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    const hostNode = stub.getNodeById(inserted.nodeId);
    let resetCalledWith = null;
    hostNode.resetSlot = (key) => { resetCalledWith = key; };

    const result = await plugin.handlers.reset_slot({ nodeId: inserted.nodeId, slotName: 'Content' });
    assert.equal(resetCalledWith, 'Content#1:1');
    assert.equal(result.reset, true);
  });

  it('reports SLOT_RESET_UNSUPPORTED when no resetSlot() is available anywhere', async () => {
    const registry = new Map();
    const host = makeComponentStub(registry, {
      name: 'Card',
      componentProperties: { 'Content#1:1': { type: 'SLOT', value: null } },
    });
    const stub = createFigmaStub({ registry, components: { 'card-key': host } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    // reset_slot is synchronous (unlike fill_slot, which imports a component
    // asynchronously) — it throws directly rather than returning a rejected
    // Promise, so assert.throws (not assert.rejects) is the correct matcher.
    assert.throws(
      () => plugin.handlers.reset_slot({ nodeId: inserted.nodeId, slotName: 'Content' }),
      (err) => {
        assert.equal(err.error, 'SLOT_RESET_UNSUPPORTED');
        return true;
      }
    );
  });
});
