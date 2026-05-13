'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DsCache } = require('../../src/ds/cache');
const { DsResolver } = require('../../src/ds/resolver');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { BuildManifest } = require('../../src/knowledge/manifest');
const { MockBridge } = require('./helpers/mock-bridge');

function createToolContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-knowledge-font.json'));
  const buildManifest = new BuildManifest();
  const session = { phase: 2, toolCallCount: 0, cacheHits: 0 };
  const handlers = {};

  const context = {
    bridge,
    dsCache,
    dsResolver,
    knowledgeStore,
    buildManifest,
    session,
    requirePhase(min) {
      if (session.phase < min) throw new Error(`phase ${session.phase} < ${min}`);
    },
    advancePhase(to) {
      session.phase = Math.max(session.phase, to);
    },
    registerTool(name, _desc, _schema, handler) {
      handlers[name] = handler;
    },
  };

  require('../../src/tools/build').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/batch').register(null, context);

  return { bridge, dsCache, session, handlers };
}

describe('font-incompatible library handling', () => {
  let setup;

  beforeEach(() => {
    setup = createToolContext();
  });

  it('detects font error and sets libraryFontIncompatible flag', async () => {
    setup.bridge.setResponse('insert_component', () => {
      throw new Error('in appendChild: unloaded font "Roboto Medium". Please call figma.loadFontAsync({ family: "Roboto", style: "Medium" }) and await the returned promise first.');
    });

    const result = await setup.handlers.figma_insert_component({
      componentKey: 'font-fail-key',
      parentId: 'parent:1',
    });

    assert.equal(result.error, 'LIBRARY_FONT_INCOMPATIBLE');
    assert.equal(result.libraryFontIncompatible, true);
    assert.equal(setup.dsCache.libraryFontIncompatible, true);
    assert.ok(setup.dsCache.hasFailed('font-fail-key'));
  });

  it('returns LIBRARY_FONT_INCOMPATIBLE for loadFontAsync variant', async () => {
    setup.bridge.setResponse('insert_component', () => {
      throw new Error('font not loaded: call loadFontAsync first');
    });

    const result = await setup.handlers.figma_insert_component({
      componentKey: 'font-fail-key-2',
      parentId: 'parent:1',
    });

    assert.equal(result.error, 'LIBRARY_FONT_INCOMPATIBLE');
    assert.equal(setup.dsCache.libraryFontIncompatible, true);
  });

  it('auto-bypasses component-first gate when flag is set', async () => {
    setup.dsCache.libraryFontIncompatible = true;

    const result = await setup.handlers.figma_create_frame({
      name: 'Button: Start free trial',
      parentId: 'parent:1',
    });

    // Should NOT be blocked — gate auto-bypasses
    assert.ok(result.nodeId, 'frame should be created');
    assert.equal(result.error, undefined);
    assert.equal(setup.bridge.getMessages('create_frame').length, 1);
  });

  it('auto-bypasses gate for footer frames when flag is set', async () => {
    setup.dsCache.libraryFontIncompatible = true;

    const result = await setup.handlers.figma_create_frame({
      name: 'Footer Brand',
      parentId: 'parent:1',
    });

    assert.ok(result.nodeId);
    assert.equal(result.error, undefined);
  });

  it('auto-bypasses gate for header frames when flag is set', async () => {
    setup.dsCache.libraryFontIncompatible = true;

    const result = await setup.handlers.figma_create_frame({
      name: 'Header Navigation',
      parentId: 'parent:1',
    });

    assert.ok(result.nodeId);
    assert.equal(result.error, undefined);
  });

  it('auto-bypasses gate for tab frames when flag is set', async () => {
    setup.dsCache.libraryFontIncompatible = true;

    const result = await setup.handlers.figma_create_frame({
      name: 'Tab: Ingestion',
      parentId: 'parent:1',
    });

    assert.ok(result.nodeId);
    assert.equal(result.error, undefined);
  });

  it('still blocks component-like frames when flag is NOT set', async () => {
    assert.equal(setup.dsCache.libraryFontIncompatible, false);

    const result = await setup.handlers.figma_create_frame({
      name: 'Button: Submit',
      parentId: 'parent:1',
    });

    assert.equal(result.error, 'COMPONENT_FIRST_REQUIRED');
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);
  });

  it('flag resets on cache clear', () => {
    setup.dsCache.libraryFontIncompatible = true;
    assert.equal(setup.dsCache.libraryFontIncompatible, true);

    setup.dsCache.clear();
    assert.equal(setup.dsCache.libraryFontIncompatible, false);
  });

  it('non-font errors still throw normally', async () => {
    setup.bridge.setResponse('insert_component', () => {
      throw new Error('COMPONENT_NOT_FOUND: key does not exist');
    });

    await assert.rejects(
      () => setup.handlers.figma_insert_component({
        componentKey: 'bad-key',
        parentId: 'parent:1',
      }),
      /COMPONENT_NOT_FOUND/,
    );

    assert.equal(setup.dsCache.libraryFontIncompatible, false);
    assert.ok(setup.dsCache.hasFailed('bad-key'));
  });
});
