'use strict';

/**
 * Real-handler tests for plugin/code.js's handlers.insert_component,
 * executed against the actual plugin code (via
 * internal/tests/helpers/figma-stub.js), not a reimplementation.
 *
 * Covers:
 *  - boolean auto-disable at insertion time (disabledBooleans list)
 *  - configurationHints.variantProperties surfaced from the component set
 *  - the B13 fix: a 15s import timeout must reject INSERT_TIMEOUT, and a
 *    LATE resolution of that same import (after the timeout already fired)
 *    must NOT create a duplicate instance. Uses node:test's mock timers to
 *    control the race deterministically instead of waiting 15 real seconds.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin, makeComponentStub } = require('./helpers/figma-stub');

describe('plugin/code.js — handlers.insert_component (real handler)', () => {
  let plugin;
  let stub;

  beforeEach(() => {
    stub = createFigmaStub();
    plugin = loadPlugin(stub);
  });

  it('throws MISSING_PARAM when componentKey is absent', () => {
    assert.throws(
      () => plugin.handlers.insert_component({}),
      (err) => {
        assert.equal(err.error, 'MISSING_PARAM');
        assert.equal(err.property, 'componentKey');
        return true;
      }
    );
  });

  it('auto-disables every BOOLEAN component property that defaults ON', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Input',
      componentProperties: {
        'Show hint text': { type: 'BOOLEAN', value: true },
        'Show label': { type: 'BOOLEAN', value: true },
        'Trailing icon': { type: 'BOOLEAN', value: false }, // already off — should not appear
        'Size': { type: 'VARIANT', value: 'Medium' },        // not boolean — must be untouched
      },
    });
    stub = createFigmaStub({ registry, components: { 'input-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({
      componentKey: 'input-key',
      importMode: 'component',
    });

    assert.deepEqual(result.disabledBooleans.sort(), ['Show hint text', 'Show label']);

    const instance = stub.getNodeById(result.nodeId);
    assert.equal(instance.componentProperties['Show hint text'].value, false);
    assert.equal(instance.componentProperties['Show label'].value, false);
    assert.equal(instance.componentProperties['Trailing icon'].value, false, 'already-off booleans stay off');
    assert.equal(instance.componentProperties['Size'].value, 'Medium', 'non-boolean properties are untouched');
  });

  it('surfaces variantProperties (values + current) in configurationHints, from the component set', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Button',
      parent: {
        type: 'COMPONENT_SET',
        variantGroupProperties: {
          Size: { values: ['Small', 'Medium', 'Large'] },
          Hierarchy: { values: ['Primary', 'Secondary'] },
        },
      },
      variantProperties: { Size: 'Medium', Hierarchy: 'Primary' },
    });
    stub = createFigmaStub({ registry, components: { 'button-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({
      componentKey: 'button-key',
      importMode: 'component',
    });

    assert.deepEqual(result.configurationHints.variantProperties.Size, {
      values: ['Small', 'Medium', 'Large'],
      current: 'Medium',
    });
    assert.deepEqual(result.configurationHints.variantProperties.Hierarchy, {
      values: ['Primary', 'Secondary'],
      current: 'Primary',
    });
  });

  it('lists text node slots in configurationHints.textNodes', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, {
      name: 'Card',
      textChildren: [
        { name: 'Heading', characters: '' },
        { name: 'Body', characters: '' },
      ],
    });
    stub = createFigmaStub({ registry, components: { 'card-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });
    const names = result.configurationHints.textNodes.map((t) => t.name).sort();
    assert.deepEqual(names, ['Body', 'Heading']);
  });

  it('falls back from componentSet to single component when the key is not a set (default importMode)', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Solo' });
    // No entry in componentSets — importComponentSetByKeyAsync rejects (NOT_FOUND),
    // handler falls back to importComponentByKeyAsync.
    stub = createFigmaStub({ registry, components: { 'solo-key': comp } });
    plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({ componentKey: 'solo-key' });
    assert.equal(result.componentName, 'Solo');
  });
});

describe('plugin/code.js — handlers.insert_component B13: timeout vs. late-import race', () => {
  it('rejects INSERT_TIMEOUT when import exceeds 15s, and does not create an instance from a LATER resolution of the same import', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Slow Component' });
    const stub = createFigmaStub({
      registry,
      components: {
        // Resolves 5s AFTER the 15s timeout already fired (20s total).
        'slow-key': { delayMs: 20000, value: comp },
      },
    });
    const plugin = loadPlugin(stub);

    const before = stub._registry.size;

    const promise = plugin.handlers.insert_component({
      componentKey: 'slow-key',
      importMode: 'component',
    });

    // Assert the rejection shape while advancing the timer.
    const assertion = assert.rejects(promise, (err) => {
      assert.equal(err.error, 'INSERT_TIMEOUT');
      assert.match(err.message, /slow-key/);
      return true;
    });

    t.mock.timers.tick(15000); // fires the INSERT_TIMEOUT rejection
    await assertion;

    // Now let the slow import resolve (it was scheduled for 20s total,
    // 5s after the timeout already fired).
    t.mock.timers.tick(5000);
    // Flush the microtask queue so the late `.then()` in the handler runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The B13 guard means this late resolution must NOT have created an
    // instance — registry size should be unchanged (no orphan INSTANCE node).
    assert.equal(stub._registry.size, before, 'a late import resolution after INSERT_TIMEOUT must not create a duplicate/orphan instance');
  });

  it('creates exactly one instance when the import resolves BEFORE the 15s timeout (no regression on the happy path)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Fast Component' });
    const stub = createFigmaStub({
      registry,
      components: {
        'fast-key': { delayMs: 100, value: comp },
      },
    });
    const plugin = loadPlugin(stub);

    const promise = plugin.handlers.insert_component({
      componentKey: 'fast-key',
      importMode: 'component',
    });

    t.mock.timers.tick(100);
    const result = await promise;

    assert.equal(result.componentName, 'Fast Component');
    assert.equal(result.type, 'INSTANCE');
    assert.ok(stub.getNodeById(result.nodeId));

    // Advancing well past 15s afterwards must not produce a second
    // rejection/instance — the timeout was already cleared on success.
    t.mock.timers.tick(20000);
    await Promise.resolve();
    const instanceCount = [...stub._registry.values()].filter((n) => n.type === 'INSTANCE').length;
    assert.equal(instanceCount, 1);
  });
});
