'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { DsDiscovery } = require('../../src/ds/discovery');
const { DsCache } = require('../../src/ds/cache');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { MockBridge } = require('./helpers/mock-bridge');
const { DsResolver } = require('../../src/ds/resolver');
const { BuildManifest } = require('../../src/knowledge/manifest');

// Write to a throwaway temp dir instead of a tracked fixture file — this
// test never reads pre-existing content (KnowledgeStore.load() is never
// called here), it only saves fresh state, so there is nothing to seed.
// Writing into the repo just left perpetual timestamp-only git diffs on
// internal/tests/.test-knowledge.json every run.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-ai-component-first-'));

function createToolContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(TMP_DIR, '.test-knowledge.json'));
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
  require('../../src/tools/ds-setup').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/edit').register(null, context);
  require('../../src/tools/learning').register(null, context);

  return { bridge, dsCache, knowledgeStore, session, handlers };
}

describe('component-first enforcement', () => {
  let setup;

  beforeEach(() => {
    setup = createToolContext();
  });

  it('maps missing section components without throwing and returns fallback guidance', () => {
    const discovery = new DsDiscovery(new MockBridge(), new DsCache(), new KnowledgeStore('/tmp/mimic-test.json'));
    const result = discovery.searchComponent('header');

    assert.equal(result.found, false);
    assert.equal(result.fallbackRequired, true);
    assert.match(result.fallbackHint, /search the library/i);
    assert.deepEqual(result.searchTerms.slice(0, 2), ['header', 'nav']);
  });

  it('preserves fallback guidance from mimic_map_components (first call)', async () => {
    const result = await setup.handlers.mimic_map_components({ elementTypes: ['header', 'button'] });

    assert.equal(result.mapped, 0);
    assert.equal(result.missing, 2);
    assert.equal(result.searchComplete, false);
    assert.equal(result.notFound[0].fallbackRequired, true);
    assert.match(result.notFound[0].fallbackHint, /search the library/i);
    assert.ok(setup.session.componentMap);
  });

  it('resolves components from librarySearchResults on second call', async () => {
    // First call — nothing found
    const first = await setup.handlers.mimic_map_components({ elementTypes: ['button', 'header', 'badge'] });
    assert.equal(first.mapped, 0);
    assert.equal(first.missing, 3);
    assert.equal(first.searchComplete, false);

    // Second call — provide search results from Figma MCP
    const second = await setup.handlers.mimic_map_components({
      elementTypes: ['button', 'header', 'badge'],
      librarySearchResults: [
        { name: '<Button>', componentKey: 'btn-key-123', libraryName: 'Acme UI', assetType: 'component_set' },
        { name: 'Some unrelated thing', componentKey: 'unrelated-key', libraryName: 'Other Lib', assetType: 'component' },
      ],
    });

    assert.equal(second.searchComplete, true);
    // Button should now be found (ingested into cache), header and badge confirmed gaps
    assert.equal(second.mapped, 1);
    assert.equal(second.missing, 2);
    assert.equal(second.components[0].elementType, 'button');
    assert.equal(second.components[0].componentKey, 'btn-key-123');
    // Missing types should say "proceed with primitives", not "search again"
    for (const m of second.notFound) {
      assert.match(m.fallbackHint, /No DS component/);
      assert.match(m.fallbackHint, /confirmedNoComponent/);
      assert.doesNotMatch(m.fallbackHint, /MUST search/i);
    }
  });

  it('confirms all gaps when librarySearchResults has no matches', async () => {
    const result = await setup.handlers.mimic_map_components({
      elementTypes: ['navbar', 'footer'],
      librarySearchResults: [
        { name: 'Unrelated Component', componentKey: 'unrelated', libraryName: 'Other Lib', assetType: 'component' },
      ],
    });

    assert.equal(result.searchComplete, true);
    assert.equal(result.mapped, 0);
    assert.equal(result.missing, 2);
    assert.match(result.hint, /Library search complete/);
    assert.match(result.hint, /confirmed gaps/);
  });

  it('blocks protected primitive frames until no-component override is documented', async () => {
    const blocked = await setup.handlers.figma_create_frame({
      name: 'Button: Start free trial',
      parentId: 'parent:1',
    });

    assert.equal(blocked.error, 'COMPONENT_FIRST_REQUIRED');
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);

    const allowed = await setup.handlers.figma_create_frame({
      name: 'Button: Start free trial',
      parentId: 'parent:1',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'Fixture-specific button variant missing from the DS library.',
    });

    assert.ok(allowed.nodeId);
    assert.match(allowed._componentCheck, /Primitive override accepted/);
    assert.equal(setup.bridge.getMessages('create_frame').length, 1);
  });

  // v3.0.0: figma_batch was removed from the MCP surface (it bypassed
  // per-tool validation by design flaw); its component-first-gate test
  // went with it. The gate itself is still covered by the
  // figma_create_frame tests above.

  it('passes known single-component import mode to component insertion', async () => {
    setup.dsCache.addComponent('single-component-key', {
      name: 'Buttons/Button',
      isComponentSet: false,
    });

    await setup.handlers.figma_insert_component({
      componentKey: 'single-component-key',
      parentId: 'parent:1',
      name: 'Smoke button',
    });

    const insert = setup.bridge.getMessages('insert_component')[0];
    assert.equal(insert.payload.importMode, 'component');
  });

  it('generates a build report when report args are omitted', async () => {
    const result = await setup.handlers.mimic_generate_build_report({});

    assert.ok(result.reportPath);
    assert.match(result.summary, /Build report for/);
    assert.equal(result.componentQualityGate, 'PASS');
  });

  it('blocks page-level artboards that overlap existing top-level nodes', async () => {
    setup.bridge.setResponse('get_page_nodes', {
      nodes: [
        { id: 'existing:1', name: 'Existing Artboard', type: 'FRAME', x: 0, y: 0, width: 1280, height: 720 },
      ],
    });

    const result = await setup.handlers.figma_create_frame({
      name: 'Overlapping Artboard',
      x: 500,
      y: 0,
      width: 1280,
      height: 720,
      direction: 'VERTICAL',
    });

    assert.equal(result.error, 'ARTBOARD_OVERLAP');
    assert.equal(result.suggestedX, 1360);
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);
  });

  it('auto-places page-level artboards to the right when x is omitted', async () => {
    setup.bridge.setResponse('get_page_nodes', {
      nodes: [
        { id: 'existing:1', name: 'Existing Artboard', type: 'FRAME', x: 0, y: 0, width: 1280, height: 720 },
      ],
    });

    await setup.handlers.figma_create_frame({
      name: 'Auto Placed Artboard',
      y: 0,
      width: 1280,
      height: 720,
      direction: 'VERTICAL',
    });

    const created = setup.bridge.getMessages('create_frame')[0];
    assert.equal(created.payload.x, 1360);
  });

  it('sets node position directly for placement correction', async () => {
    const result = await setup.handlers.figma_update_node({
      op: 'position',
      nodeId: 'artboard:1',
      x: 1360,
      y: 0,
    });

    assert.equal(result.x, 1360);
    assert.equal(result.y, 0);
    assert.equal(setup.bridge.getMessages('set_node_position').length, 1);
  });

  it('sets component text by exact text node id (figma_component_text with textNodeId override)', async () => {
    const result = await setup.handlers.figma_component_text({
      nodeId: 'component:1',
      overrides: [
        { textNodeId: 'Icomponent:1;child:2', content: 'Run verification' },
      ],
    });

    const message = setup.bridge.getMessages('set_component_text_by_id')[0];
    assert.equal(message.payload.nodeId, 'component:1');
    assert.equal(message.payload.textNodeId, 'Icomponent:1;child:2');
    assert.equal(result.results[0].characters, 'Run verification');
  });

  // ── Fix 2: MAPPED_COMPONENT_AVAILABLE enforcement ──

  it('blocks frame creation when name matches a mapped component from mimic_map_components', async () => {
    // Map "alert" and "tooltip" to DS components (names NOT in hardcoded COMPONENT_FIRST_PATTERNS)
    setup.dsCache.addComponent('ck-alert', { name: 'Alert', isComponentSet: true });
    setup.dsCache.addComponent('ck-tooltip', { name: 'Tooltip', isComponentSet: true });

    await setup.handlers.mimic_map_components({
      elementTypes: ['alert', 'tooltip'],
      librarySearchResults: [],
    });

    // "Alert" should be blocked — exact match on mapped elementType
    const blocked = await setup.handlers.figma_create_frame({
      name: 'Alert',
      parentId: 'parent:1',
    });
    assert.equal(blocked.error, 'MAPPED_COMPONENT_AVAILABLE');
    assert.ok(blocked.message.includes('Alert'));
    assert.ok(blocked.recovery.componentKey);
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);

    // "Tooltip: Help" should also be blocked — prefix "tooltip" matches mapped "tooltip"
    const blocked2 = await setup.handlers.figma_create_frame({
      name: 'Tooltip: Help text',
      parentId: 'parent:1',
    });
    assert.equal(blocked2.error, 'MAPPED_COMPONENT_AVAILABLE');
  });

  it('does NOT block frames whose name only partially overlaps a mapped component', async () => {
    setup.dsCache.addComponent('ck-card-header', { name: 'Card header', isComponentSet: true });

    await setup.handlers.mimic_map_components({
      elementTypes: ['card header'],
      librarySearchResults: [],
    });

    // "Card: Revenue" should NOT be blocked — "card" != "card header"
    const allowed = await setup.handlers.figma_create_frame({
      name: 'Card: Revenue',
      parentId: 'parent:1',
    });
    assert.ok(allowed.nodeId, 'Frame should be created — "Card" is not "Card header"');
    assert.equal(setup.bridge.getMessages('create_frame').length, 1);
  });

  it('allows frame creation with confirmedNoComponent even when mapped component exists', async () => {
    setup.dsCache.addComponent('ck-alert', { name: 'Alert', isComponentSet: true });

    await setup.handlers.mimic_map_components({
      elementTypes: ['alert'],
      librarySearchResults: [],
    });

    // confirmedNoComponent bypasses the mapped check
    const allowed = await setup.handlers.figma_create_frame({
      name: 'Alert Section',
      parentId: 'parent:1',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'Custom alert layout not matching DS component structure',
    });
    // The hardcoded pattern list doesn't have "alert", so confirmedNoComponent
    // is only checked by the hardcoded gate. The mapped check skips when
    // confirmedNoComponent is true.
    assert.ok(allowed.nodeId);
  });

  // ── Fix 1: Unused mapped components in build report ──

  it('reports unused mapped components in the build report', async () => {
    setup.dsCache.addComponent('ck-card-header', { name: 'Card header', isComponentSet: true });
    setup.dsCache.addComponent('ck-alert', { name: 'Alert', isComponentSet: true });
    setup.dsCache.addComponent('ck-badge', { name: 'Badge', isComponentSet: true });

    await setup.handlers.mimic_map_components({
      elementTypes: ['card header', 'alert', 'badge'],
      librarySearchResults: [],
    });

    // Only report Badge as used — Card header and Alert were mapped but never inserted
    const report = await setup.handlers.mimic_generate_build_report({
      screenName: 'Unused Components Test',
      components: [{ name: 'Badge', instances: 2, componentKey: 'ck-badge' }],
      primitives: [{ element: 'Custom Section', reason: 'No DS component for coverage matrix layout' }],
    });

    assert.equal(report.unusedMappedComponentCount, 2);
    assert.ok(report.unusedMappedComponents);
    assert.equal(report.unusedMappedComponents.length, 2);
    const unusedNames = report.unusedMappedComponents.map(c => c.componentName);
    assert.ok(unusedNames.includes('Card header'));
    assert.ok(unusedNames.includes('Alert'));
    assert.ok(report.summary.includes('mapped component(s) never used'));
  });

  it('does not flag unused components when all mapped components were inserted', async () => {
    setup.dsCache.addComponent('ck-badge', { name: 'Badge', isComponentSet: true });

    await setup.handlers.mimic_map_components({
      elementTypes: ['badge'],
      librarySearchResults: [],
    });

    // Simulate insertion tracking
    setup.session._componentInsertions = new Map([
      ['ck-badge', { names: ['Badge'], instances: 3 }],
    ]);

    const report = await setup.handlers.mimic_generate_build_report({
      screenName: 'All Used Test',
      components: [{ name: 'Badge', instances: 3, componentKey: 'ck-badge' }],
      primitives: [],
    });

    assert.equal(report.unusedMappedComponentCount, 0);
    assert.equal(report.unusedMappedComponents, undefined);
    assert.ok(!report.summary.includes('mapped component(s) never used'));
  });
});
