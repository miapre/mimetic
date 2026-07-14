'use strict';

/**
 * Real-handler tests for Grid automation support (May 2026) in
 * plugin/code.js: handlers.create_frame's GRID layoutMode path,
 * handlers.insert_component's grid-child span support, and
 * handlers.set_layout_sizing's grid-child span support.
 *
 * The feature-detection strategy throughout: every GRID-specific property
 * assignment (frame.layoutMode = 'GRID', gridRowCount, gridColumnCount,
 * gridRowGap/gridColumnGap, gridRowSpan/gridColumnSpan) is wrapped in its
 * own try/catch. A pre-Grid Figma host is simulated here via
 * Object.defineProperty overrides on the stub node that throw for specific
 * property assignments — the figma-stub harness itself has no restrictions
 * (plain object properties), so these overrides are applied per-test.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFigmaStub, loadPlugin, makeComponentStub } = require('./helpers/figma-stub');

/** Makes `propName` throw when assigned to `value`, on the given node. */
function makePropertyThrow(node, propName, message) {
  let current = node[propName];
  Object.defineProperty(node, propName, {
    configurable: true,
    get() { return current; },
    set(v) {
      if (v === 'GRID' || typeof v === 'number') {
        throw new Error(message || (propName + ' not supported'));
      }
      current = v;
    },
  });
}

describe('plugin/code.js — handlers.create_frame: GRID layoutMode (real handler)', () => {
  it('creates a GRID frame with row/column count and gaps when layoutMode: GRID is requested', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);

    const result = await plugin.handlers.create_frame({
      name: 'Dashboard Grid',
      parentId: null,
      layoutMode: 'GRID',
      gridRowCount: 3,
      gridColumnCount: 4,
      gridRowGap: 16,
      gridColumnGap: 24,
    });

    const node = stub.getNodeById(result.nodeId);
    assert.equal(node.layoutMode, 'GRID');
    assert.equal(node.gridRowCount, 3);
    assert.equal(node.gridColumnCount, 4);
    assert.equal(node.gridRowGap, 16);
    assert.equal(node.gridColumnGap, 24);
    assert.equal(result.bindingFailures, false);
  });

  it('falls back to VERTICAL/HORIZONTAL when layoutMode is not GRID', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const result = await plugin.handlers.create_frame({ name: 'Row', parentId: null, direction: 'HORIZONTAL' });
    const node = stub.getNodeById(result.nodeId);
    assert.equal(node.layoutMode, 'HORIZONTAL');
  });

  it('surfaces a clear GRID_LAYOUT_UNSUPPORTED error on a pre-Grid Figma version instead of an opaque throw', async () => {
    const stub = createFigmaStub();
    // Simulate an older Figma host: assigning layoutMode = 'GRID' throws,
    // exactly like an unsupported enum value would in the real Plugin API.
    const originalCreateFrame = stub.createFrame.bind(stub);
    stub.createFrame = () => {
      const n = originalCreateFrame();
      makePropertyThrow(n, 'layoutMode', 'Unsupported layoutMode: GRID');
      return n;
    };
    const plugin = loadPlugin(stub);

    // handlers.create_frame is declared `async function` — every throw
    // inside it (even the very first line) becomes a rejected Promise, not
    // a synchronous throw, so assert.rejects is the correct matcher here
    // (contrast with handlers.reset_slot's sync-throw tests elsewhere).
    await assert.rejects(
      () => plugin.handlers.create_frame({ name: 'Dashboard Grid', parentId: null, layoutMode: 'GRID', gridRowCount: 2, gridColumnCount: 2 }),
      (err) => {
        assert.equal(err.error, 'GRID_LAYOUT_UNSUPPORTED');
        assert.match(err.message, /GRID/);
        return true;
      }
    );
  });

  it('binds gridRowGapVariable/gridColumnGapVariable via the normal variable-binding path', async () => {
    const registry = new Map();
    const gapVar = { id: 'var:gap-row', name: 'Spacing/spacing-lg', variableCollectionId: 'col:1' };
    const gapVar2 = { id: 'var:gap-col', name: 'Spacing/spacing-xl', variableCollectionId: 'col:1' };
    const stub = createFigmaStub({
      registry,
      localVariableCollections: [{ id: 'col:1', name: 'Spacing', modes: [{ modeId: 'm1', name: 'Default' }], _variables: [gapVar, gapVar2] }],
    });
    const plugin = loadPlugin(stub);

    const result = await plugin.handlers.create_frame({
      name: 'Dashboard Grid',
      parentId: null,
      layoutMode: 'GRID',
      gridRowGapVariable: 'Spacing/spacing-lg',
      gridColumnGapVariable: 'Spacing/spacing-xl',
    });

    assert.equal(result.applied.gridRowGapVariable, true);
    assert.equal(result.applied.gridColumnGapVariable, true);
    assert.equal(result.bindingFailures, false);
  });
});

describe('plugin/code.js — grid-child spans (real handler)', () => {
  it('figma_create_frame: sets gridRowSpan/gridColumnSpan on a child frame when provided', async () => {
    const stub = createFigmaStub();
    const plugin = loadPlugin(stub);
    const parentResult = await plugin.handlers.create_frame({ name: 'Grid', parentId: null, layoutMode: 'GRID', gridRowCount: 2, gridColumnCount: 2 });

    const childResult = await plugin.handlers.create_frame({
      name: 'Cell: A',
      parentId: parentResult.nodeId,
      gridRowSpan: 2,
      gridColumnSpan: 1,
    });

    const childNode = stub.getNodeById(childResult.nodeId);
    assert.equal(childNode.gridRowSpan, 2);
    assert.equal(childNode.gridColumnSpan, 1);
    assert.equal(childResult.applied.gridRowSpan, true);
    assert.equal(childResult.applied.gridColumnSpan, true);
  });

  it('figma_create_frame: does not fail the whole creation when span assignment is unsupported — tracks it as a non-fatal warning', async () => {
    const stub = createFigmaStub();
    const originalCreateFrame = stub.createFrame.bind(stub);
    let callCount = 0;
    stub.createFrame = () => {
      callCount++;
      const n = originalCreateFrame();
      if (callCount === 2) {
        // Second frame created (the child) — simulate a host with no
        // gridRowSpan support at all.
        makePropertyThrow(n, 'gridRowSpan', 'gridRowSpan not supported');
      }
      return n;
    };
    const plugin = loadPlugin(stub);
    await plugin.handlers.create_frame({ name: 'Grid', parentId: null, layoutMode: 'GRID' });

    const result = await plugin.handlers.create_frame({ name: 'Cell: A', parentId: null, gridRowSpan: 2 });
    assert.equal(result.applied.gridRowSpan, false);
    assert.equal(result.bindingFailures, true);
    assert.ok(result.warnings.some((w) => w.includes('gridRowSpan')));
  });

  it('handlers.insert_component: sets gridRowSpan/gridColumnSpan on the inserted instance', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Metric Card' });
    const stub = createFigmaStub({ registry, components: { 'card-key': comp } });
    const plugin = loadPlugin(stub);

    const result = await plugin.handlers.insert_component({
      componentKey: 'card-key',
      importMode: 'component',
      gridRowSpan: 1,
      gridColumnSpan: 3,
    });

    const node = stub.getNodeById(result.nodeId);
    assert.equal(node.gridRowSpan, 1);
    assert.equal(node.gridColumnSpan, 3);
    assert.equal(result.gridSpanWarnings, undefined);
  });

  it('handlers.insert_component: reports gridSpanWarnings (not a thrown error) when span assignment is unsupported', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Metric Card' });
    const stub = createFigmaStub({ registry, components: { 'card-key': comp } });
    const plugin = loadPlugin(stub);

    // makeComponentStub's createInstance() builds a fresh FigmaNodeStub — patch
    // the class prototype briefly isn't practical here, so instead we assert
    // via a component whose instance we make throw post-hoc isn't possible
    // before insert; simplest reliable simulation: monkey-patch
    // figma.getNodeById is unaffected — instead directly verify the handler
    // tolerates a throwing setter by wrapping instance creation.
    const originalImport = stub.importComponentByKeyAsync.bind(stub);
    stub.importComponentByKeyAsync = (key) => originalImport(key).then((imported) => {
      const originalCreateInstance = imported.createInstance.bind(imported);
      imported.createInstance = () => {
        const inst = originalCreateInstance();
        makePropertyThrow(inst, 'gridColumnSpan', 'gridColumnSpan not supported');
        return inst;
      };
      return imported;
    });

    const result = await plugin.handlers.insert_component({
      componentKey: 'card-key',
      importMode: 'component',
      gridColumnSpan: 2,
    });

    assert.ok(Array.isArray(result.gridSpanWarnings));
    assert.ok(result.gridSpanWarnings.some((w) => w.includes('gridColumnSpan')));
  });

  it('handlers.set_layout_sizing: sets gridRowSpan/gridColumnSpan on an existing node', async () => {
    const registry = new Map();
    const comp = makeComponentStub(registry, { name: 'Metric Card' });
    const stub = createFigmaStub({ registry, components: { 'card-key': comp } });
    const plugin = loadPlugin(stub);
    const inserted = await plugin.handlers.insert_component({ componentKey: 'card-key', importMode: 'component' });

    const result = await plugin.handlers.set_layout_sizing({
      nodeId: inserted.nodeId,
      gridRowSpan: 2,
      gridColumnSpan: 2,
    });

    const node = stub.getNodeById(inserted.nodeId);
    assert.equal(node.gridRowSpan, 2);
    assert.equal(node.gridColumnSpan, 2);
    assert.equal(result.applied.gridRowSpan, true);
    assert.equal(result.applied.gridColumnSpan, true);
  });
});
