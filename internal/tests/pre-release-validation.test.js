'use strict';

/**
 * Pre-Release Validation — Final test suite before public release.
 *
 * Covers every gap NOT handled by the existing 326 learning-loop tests:
 * discovery/mapping, rectangle/ellipse/SVG validation, batch ops,
 * edit/styling tools, chart build, build manifest/inspection,
 * verified confidence + gap merge + stress, component text tracking,
 * and an end-to-end build session scenario.
 *
 * Uses the same mock bridge harness as learning-loop-comprehensive.test.js.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Test Harness (copied from learning-loop-comprehensive.test.js) ──

function createTestHarness() {
  const bridge = {
    connected: true,
    _onDisconnect: null,
    send(type, payload) {
      switch (type) {
        case 'get_plugin_status':
          return Promise.resolve({ fileName: 'Test File', currentPage: 'Page 1' });
        case 'discover_library_variables':
          return Promise.resolve({ libraries: [{ name: 'TestDS', collections: ['Colors', 'Spacing'] }], variables: [
            { path: 'bg-primary', key: 'var-bg-primary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'bg-secondary', key: 'var-bg-secondary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'text-primary', key: 'var-text-primary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'text-secondary', key: 'var-text-secondary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'border-primary', key: 'var-border-primary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'border-secondary', key: 'var-border-secondary', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'fg-success-primary', key: 'var-fg-success', resolvedType: 'COLOR', collection: 'Colors', libraryName: 'TestDS' },
            { path: 'radius-md', key: 'var-radius-md', resolvedType: 'FLOAT', collection: 'Spacing', libraryName: 'TestDS' },
            { path: 'spacing-xl', key: 'var-spacing-xl', resolvedType: 'FLOAT', collection: 'Spacing', libraryName: 'TestDS' },
            { path: 'spacing-3xl', key: 'var-spacing-3xl', resolvedType: 'FLOAT', collection: 'Spacing', libraryName: 'TestDS' },
          ], totalVariables: 10 });
        case 'preload_variables':
          return Promise.resolve({ preloadedVars: payload.variables?.length || 0 });
        case 'preload_styles':
          return Promise.resolve({ preloadedStyles: 0, styles: [] });
        case 'set_session_defaults':
          return Promise.resolve({ ok: true });
        case 'discover_library_components':
          return Promise.resolve({ components: [] });
        case 'create_frame':
          return Promise.resolve({ nodeId: `frame-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: payload.name, applied: {}, warnings: [] });
        case 'create_text':
          return Promise.resolve({ nodeId: `text-${Date.now()}`, name: payload.name, applied: {}, warnings: [] });
        case 'create_rectangle':
          return Promise.resolve({ nodeId: `rect-${Date.now()}`, name: payload.name, applied: {}, warnings: [] });
        case 'create_ellipse':
          return Promise.resolve({ nodeId: `ellipse-${Date.now()}`, name: payload.name, applied: {}, warnings: [] });
        case 'create_svg':
          return Promise.resolve({
            nodeId: `svg-${Date.now()}`, name: payload.name, applied: {}, warnings: [],
            unboundChildren: payload._mockUnbound || [],
            childSummary: {},
          });
        case 'insert_component':
          return Promise.resolve({
            nodeId: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: payload.name || 'Component',
            componentKey: payload.componentKey,
            configurationHints: { textNodes: [{ nodeId: 'tn-1', name: 'Text', characters: 'Placeholder' }], variantProperties: {}, booleanProperties: {} },
            disabledBooleans: [],
          });
        case 'set_variant':
          return Promise.resolve({ ok: true });
        case 'set_component_text':
          return Promise.resolve({ ok: true, nodeId: `tn-resolved-${Date.now()}` });
        case 'set_component_text_by_id':
          return Promise.resolve({ ok: true, nodeId: payload.textNodeId });
        case 'batch_set_component_text':
          return Promise.resolve({
            succeeded: (payload.overrides || []).filter((_, i) => !payload._mockFailIndices?.includes(i)).length,
            failed: payload._mockFailIndices?.length || 0,
            results: (payload.overrides || []).map((o, i) => {
              if (payload._mockFailIndices?.includes(i)) {
                return { ok: false, textNodeName: o.textNodeName, error: 'Node not found' };
              }
              return { ok: true, textNodeName: o.textNodeName, nodeId: `tn-batch-${i}` };
            }),
          });
        case 'set_layout_sizing':
          return Promise.resolve({ ok: true });
        case 'set_node_props':
          return Promise.resolve({ ok: true });
        case 'get_node_props':
          return Promise.resolve({ layoutSizingHorizontal: 'FIXED', layoutMode: 'VERTICAL', width: 1440, height: 900 });
        case 'get_node_children':
          return Promise.resolve({ children: [] });
        case 'get_page_nodes':
          return Promise.resolve({ nodes: [] });
        case 'get_node_parent':
          return Promise.resolve({ type: 'FRAME', parentType: 'FRAME' });
        case 'delete_node':
          return Promise.resolve({ ok: true });
        case 'set_all_variable_modes':
          return Promise.resolve({ ok: true });
        case 'restyle_artboard':
          return Promise.resolve({ ok: true, applied: {}, warnings: [] });
        case 'set_node_fill':
          return Promise.resolve({ ok: true, applied: {}, warnings: [] });
        case 'set_text_style':
          return Promise.resolve({ ok: true });
        case 'set_text':
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({ ok: true });
      }
    },
    sendBatch(ops) {
      const results = ops.map((op, i) => {
        let result;
        switch (op.type) {
          case 'create_frame':
            result = { nodeId: `frame-batch-${i}-${Date.now()}`, name: op.payload.name, applied: {}, warnings: [] };
            break;
          case 'create_text':
            result = { nodeId: `text-batch-${i}-${Date.now()}`, name: op.payload.name, applied: {}, warnings: [] };
            break;
          case 'insert_component':
            result = {
              nodeId: `comp-batch-${i}-${Date.now()}`,
              name: op.payload.name || 'Component',
              componentKey: op.payload.componentKey,
              configurationHints: { textNodes: [{ nodeId: 'tn-1', name: 'Text', characters: 'Placeholder' }], variantProperties: {}, booleanProperties: {} },
              disabledBooleans: [],
            };
            break;
          default:
            result = { ok: true };
        }
        return { ok: true, index: i, result };
      });
      return Promise.resolve({ results, totalOps: ops.length, succeeded: ops.length, failed: 0 });
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-prerelease-'));
  const knowledgePath = path.join(tmpDir, 'ds-knowledge.json');

  const { DsCache } = require('../../src/ds/cache');
  const { DsResolver } = require('../../src/ds/resolver');
  const { KnowledgeStore } = require('../../src/knowledge/store');
  const { BuildManifest } = require('../../src/knowledge/manifest');

  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(knowledgePath);
  const buildManifest = new BuildManifest();

  const session = {
    phase: 0,
    artboardId: null,
    enforcementProfile: null,
    toolCallCount: 0,
    cacheHits: 0,
    consecutiveFailures: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    checkpointIssued: false,
    bindingFailures: [],
    componentTextTracker: new Map(),
    pendingVariableMismatchConfirmation: false,
    variableMismatchSourceLibs: null,
    variableSourceConfirmed: null,
    buildsSinceReport: 0,
    buildInterrupted: false,
    categoryMismatches: [],
    replaySavings: 0,
    _componentInsertions: new Map(),
    _variantConfigs: new Map(),
    _textNodeStructures: new Map(),
    _nodeComponentKeys: new Map(),
    _frameLayoutConfigs: new Map(),
  };

  function advancePhase(to) {
    if (to >= 3 && session.buildsSinceReport === 0) session.buildsSinceReport = 1;
    session.phase = Math.max(session.phase, to);
  }

  function requirePhase(minPhase, hint) {
    if (session.phase < minPhase) throw new Error(`Phase ${session.phase} < ${minPhase}: ${hint}`);
  }

  function resetSession() {
    session.phase = 0;
    session.toolCallCount = 0;
    session.cacheHits = 0;
    session.consecutiveFailures = 0;
    session.phaseToolCalls = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    session.checkpointIssued = false;
    session.bindingFailures = [];
    session.componentTextTracker = new Map();
    session.buildsSinceReport = 0;
    session.buildInterrupted = false;
    session.categoryMismatches = [];
    session.replaySavings = 0;
    session._componentInsertions = new Map();
    session._variantConfigs = new Map();
    session._textNodeStructures = new Map();
    session._nodeComponentKeys = new Map();
    session._frameLayoutConfigs = new Map();
  }

  const toolRegistry = { tools: [], handlers: {} };
  function registerTool(name, desc, schema, handler) {
    toolRegistry.tools.push({ name, desc, schema });
    toolRegistry.handlers[name] = handler;
  }

  const context = {
    bridge, dsCache, dsResolver, knowledgeStore, buildManifest, session,
    requirePhase, advancePhase, resetSession, registerTool,
    requireReportIfPending: () => {},
    get figmaRest() { return null; },
  };

  // Register ALL tool modules
  require('../../src/tools/status').register(null, context);
  require('../../src/tools/ds-setup').register(null, context);
  require('../../src/tools/build').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/edit').register(null, context);
  require('../../src/tools/learning').register(null, context);
  require('../../src/tools/table').register(null, context);
  require('../../src/tools/inspect').register(null, context);
  require('../../src/tools/chart').register(null, context);

  async function call(name, args = {}) {
    const handler = toolRegistry.handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args);
  }

  function seedCache() {
    dsCache.addVariable('bg-primary', { key: 'var-bg-primary', category: 'background' });
    dsCache.addVariable('bg-secondary', { key: 'var-bg-secondary', category: 'background' });
    dsCache.addVariable('text-primary', { key: 'var-text-primary', category: 'text' });
    dsCache.addVariable('text-secondary', { key: 'var-text-secondary', category: 'text' });
    dsCache.addVariable('border-primary', { key: 'var-border-primary', category: 'border' });
    dsCache.addVariable('border-secondary', { key: 'var-border-secondary', category: 'border' });
    dsCache.addVariable('fg-success-primary', { key: 'var-fg-success', category: 'foreground' });
    dsCache.addVariable('radius-md', { key: 'var-radius-md', category: 'radius' });
    dsCache.addVariable('spacing-xl', { key: 'var-spacing-xl', category: 'spacing' });
    dsCache.addVariable('spacing-3xl', { key: 'var-spacing-3xl', category: 'spacing' });
  }

  return { call, session, dsCache, dsResolver, knowledgeStore, bridge, resetSession, advancePhase, tmpDir, buildManifest, seedCache, context };
}


// ═══════════════════════════════════════════════════════════════════
// BLOCK 1 — Discovery and Mapping Flow
// ═══════════════════════════════════════════════════════════════════
describe('Block 1 — Discovery and mapping flow', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  it('mimic_map_components finds confirmed Badge recipe from knowledge store', async () => {
    h.advancePhase(2);
    // Store a confirmed Badge recipe in the knowledge store
    h.knowledgeStore.setComponent('ck-badge', {
      names: ['Badge'],
      componentKey: 'ck-badge',
      confidence: 'confirmed',
      buildCount: 3,
      instances: 5,
    });
    h.knowledgeStore.save();

    const result = await h.call('mimic_map_components', {
      elementTypes: ['badge'],
    });
    assert.ok(result.components, 'Should have components array');
    const badgeEntry = result.components.find(c => c.elementType === 'badge');
    assert.ok(badgeEntry, 'Badge should be found');
    assert.equal(badgeEntry.source, 'knowledge_store');
    assert.equal(badgeEntry.componentKey, 'ck-badge');
  });

  it('mimic_map_components finds component from dsCache', async () => {
    h.advancePhase(2);
    h.dsCache.addComponent('ck-button', {
      name: 'Button',
      isComponentSet: true,
    });

    const result = await h.call('mimic_map_components', {
      elementTypes: ['button'],
    });
    const btnEntry = result.components.find(c => c.elementType === 'button');
    assert.ok(btnEntry, 'Button should be found from ds_cache');
    assert.equal(btnEntry.source, 'ds_cache');
    assert.equal(btnEntry.componentKey, 'ck-button');
  });

  it('mimic_map_components returns not found for nonexistent types', async () => {
    h.advancePhase(2);
    const result = await h.call('mimic_map_components', {
      elementTypes: ['nonexistent'],
    });
    assert.ok(result.notFound, 'Should have notFound array');
    assert.equal(result.notFound.length, 1);
    assert.equal(result.notFound[0].elementType, 'nonexistent');
    assert.ok(result.notFound[0].searchTerms, 'Should have search terms');
  });

  it('mimic_map_components two-call workflow: first missing, second with search results ingests', async () => {
    h.advancePhase(2);

    // First call: nothing found
    const first = await h.call('mimic_map_components', { elementTypes: ['avatar'] });
    assert.equal(first.missing, 1, 'Avatar should be missing');

    // Add the component to dsCache as if we found it via search
    h.dsCache.addComponent('ck-avatar', { name: 'Avatar', isComponentSet: true });

    // Second call with librarySearchResults
    const second = await h.call('mimic_map_components', {
      elementTypes: ['avatar'],
      librarySearchResults: [
        { name: 'Avatar', componentKey: 'ck-avatar', libraryName: 'TestDS', assetType: 'component_set' },
      ],
    });
    assert.ok(second.searchComplete, 'Search should be complete');
    const avatarFound = second.components.find(c => c.elementType === 'avatar');
    assert.ok(avatarFound, 'Avatar should now be found');
  });

  it('mimic_ai_knowledge_read returns all sections', async () => {
    h.knowledgeStore.setComponent('test', { names: ['Test'], buildCount: 1 });
    h.knowledgeStore.setPattern('Card', { description: 'Card pattern', buildCount: 1 });
    h.knowledgeStore.addGap('Progress', { elements: ['Progress'], evidence: 'Not found' });
    h.knowledgeStore.setRule('rule-1', { category: 'color', rule: 'No brand on charts' });
    h.knowledgeStore.save();

    const result = await h.call('mimic_ai_knowledge_read', {});
    assert.ok(result.components.test, 'Should have test component');
    assert.ok(result.patterns.Card, 'Should have Card pattern');
    assert.ok(result.gaps.Progress, 'Should have Progress gap');
    assert.ok(result.rules['rule-1'], 'Should have rule-1');
    assert.ok(result.meta, 'Should have meta section');
  });

  it('figma_list_ds (kind: variables) returns all cached variables', async () => {
    h.advancePhase(2);
    const result = await h.call('figma_list_ds', { kind: 'variables' });
    assert.equal(result.count, 10, 'Should return all 10 seeded variables');
  });

  it('figma_list_ds (kind: variables) filters by category', async () => {
    h.advancePhase(2);
    const result = await h.call('figma_list_ds', { kind: 'variables', category: 'background' });
    assert.equal(result.category, 'background');
    assert.equal(result.count, 2, 'Should return bg-primary and bg-secondary');
    assert.ok(result.variables.every(v => v.category === 'background'));
  });

  it('mimic_ds_assets (set_defaults) rejects permissive mode when DS has tokens', async () => {
    const result = await h.call('mimic_ds_assets', { action: 'set_defaults', dsMode: 'permissive' });
    assert.equal(result.error, 'DS_MODE_REJECTED');
  });

  it('mimic_ds_assets (set_defaults) accepts strict mode and advances to phase 2', async () => {
    const result = await h.call('mimic_ds_assets', { action: 'set_defaults', dsMode: 'strict' });
    assert.equal(result.phase, 2);
    assert.equal(result.enforcement.dsMode, 'strict');
  });

  it('mimic_ds_assets (preload variables) stores variables in cache and sends to plugin', async () => {
    const result = await h.call('mimic_ds_assets', {
      action: 'preload', kind: 'variables',
      variables: [
        { path: 'test-var', key: 'k-test', collection: 'Colors', category: 'color' },
      ],
    });
    assert.ok(result.cached >= 1, 'Should have cached variables');
    assert.ok(h.dsCache.getVariable('test-var'), 'Variable should be in cache');
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 2 — Rectangle, Ellipse, SVG Category Validation
// ═══════════════════════════════════════════════════════════════════
describe('Block 2 — Rectangle, ellipse, SVG category validation', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('figma_create_shape (rectangle) with bg-* as strokeVariable warns category mismatch', async () => {
    const result = await h.call('figma_create_shape', {
      shape: 'rectangle',
      parentId: 'p-1',
      strokeVariable: 'bg-secondary',
    });
    assert.ok(result._categoryWarnings, 'Should have category warnings');
    assert.ok(result._categoryWarnings.length > 0);
    assert.ok(result._categoryWarnings[0].includes('bg-*'));
  });

  it('figma_create_shape (rectangle) with correct variables has no warnings', async () => {
    const result = await h.call('figma_create_shape', {
      shape: 'rectangle',
      parentId: 'p-1',
      fillVariable: 'bg-primary',
      strokeVariable: 'border-secondary',
    });
    assert.ok(!result._categoryWarnings || result._categoryWarnings.length === 0,
      'No category warnings for correct usage');
  });

  it('figma_create_shape (rectangle) with raw cornerRadius does NOT trigger radius enforcement', async () => {
    // Rectangles do NOT have radius enforcement (only frames do)
    const result = await h.call('figma_create_shape', {
      shape: 'rectangle',
      parentId: 'p-1',
      cornerRadius: 8,
    });
    // Should succeed with no radius-specific warnings
    assert.ok(result.nodeId);
    const radiusWarning = (result._categoryWarnings || []).find(w => w.includes('cornerRadius'));
    assert.ok(!radiusWarning, 'Rectangle should NOT enforce radius variables');
  });

  it('figma_create_shape (ellipse) with correct fillVariable has no warnings', async () => {
    const result = await h.call('figma_create_shape', {
      shape: 'ellipse',
      parentId: 'p-1',
      fillVariable: 'bg-primary',
    });
    assert.ok(result.nodeId, 'Ellipse should be created');
    // No error means no path errors
    assert.ok(!result.error);
  });

  it('figma_create_shape (ellipse) with invalid variable path returns error', async () => {
    const result = await h.call('figma_create_shape', {
      shape: 'ellipse',
      parentId: 'p-1',
      fillVariable: 'nonexistent-var',
    });
    assert.equal(result.error, 'INVALID_VARIABLE_PATHS');
  });

  it('figma_create_svg with correct fillVariable has no error', async () => {
    const result = await h.call('figma_create_svg', {
      parentId: 'p-1',
      svgString: '<svg><rect/></svg>',
      fillVariable: 'fg-success-primary',
    });
    assert.ok(result.nodeId, 'SVG should be created');
    assert.ok(!result.error);
  });

  it('figma_create_svg returns unboundChildren checklist', async () => {
    // Override bridge to return unbound children for this test
    const origSend = h.bridge.send;
    h.bridge.send = (type, payload) => {
      if (type === 'create_svg') {
        return Promise.resolve({
          nodeId: 'svg-1',
          name: 'Chart SVG',
          unboundChildren: [
            { nodeId: 'vec-1', type: 'VECTOR', name: 'line1' },
            { nodeId: 'txt-1', type: 'TEXT', name: 'label1', characters: 'Jan' },
          ],
          childSummary: { vectors: 1, texts: 1 },
        });
      }
      return origSend.call(h.bridge, type, payload);
    };

    const result = await h.call('figma_create_svg', {
      parentId: 'p-1',
      svgString: '<svg><line/><text>Jan</text></svg>',
    });
    assert.ok(result.configurationChecklist, 'Should have configuration checklist');
    assert.ok(result.configurationChecklist.length >= 2, 'Should have vector and text binding actions');
    const vectorAction = result.configurationChecklist.find(c => c.action === 'BIND_VECTOR_FILLS');
    const textAction = result.configurationChecklist.find(c => c.action === 'BIND_TEXT_STYLES');
    assert.ok(vectorAction, 'Should have BIND_VECTOR_FILLS action');
    assert.ok(textAction, 'Should have BIND_TEXT_STYLES action');
    assert.ok(result._bindingStatus.includes('2'), 'Should mention 2 unbound children');

    h.bridge.send = origSend;
  });

  it('figma_create_shape (rectangle) with invalid variable path returns error', async () => {
    const result = await h.call('figma_create_shape', {
      shape: 'rectangle',
      parentId: 'p-1',
      fillVariable: 'totally-wrong-var',
    });
    assert.equal(result.error, 'INVALID_VARIABLE_PATHS');
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 3 — Component-first gate (formerly exercised via figma_batch)
// v3.0.0: figma_batch was removed from the MCP surface. The gate logic it
// shared with figma_create_frame (checkComponentFirstGate in build.js) is
// still fully exercised here through the standalone tool.
// ═══════════════════════════════════════════════════════════════════
describe('Block 3 — Component-first gate on create_frame', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('create_frame for "Badge: Active" triggers component-first gate', async () => {
    const result = await h.call('figma_create_frame', { name: 'Badge: Active', parentId: 'p-1' });
    assert.equal(result.error, 'COMPONENT_FIRST_REQUIRED');
  });

  it('create_frame matching a confirmed knowledge store recipe triggers KNOWN_COMPONENT_EXISTS', async () => {
    // Add confirmed recipe for "Metric Card"
    h.knowledgeStore.setComponent('ck-metric', {
      names: ['Metric Card'],
      componentKey: 'ck-metric',
      confidence: 'confirmed',
      buildCount: 3,
    });
    h.knowledgeStore.save();

    const result = await h.call('figma_create_frame', { name: 'Metric Card: Revenue', parentId: 'p-1' });
    assert.equal(result.error, 'KNOWN_COMPONENT_EXISTS');
  });

  it('create_frame with a non-component-like name succeeds', async () => {
    const result = await h.call('figma_create_frame', {
      name: 'Content Row', parentId: 'p-1', direction: 'HORIZONTAL',
    });
    assert.ok(result.nodeId);
    assert.ok(!result.error);
  });

  it('create_frame requires phase 2', async () => {
    const h2 = createTestHarness();
    h2.seedCache();
    // Phase 0 — should fail
    await assert.rejects(
      () => h2.call('figma_create_frame', { name: 'X', parentId: 'p-1' }),
      /Phase 0 < 2|PHASE_REQUIRED/
    );
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 4 — Edit and Styling Tools
// ═══════════════════════════════════════════════════════════════════
describe('Block 4 — Edit and styling tools', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('figma_update_node (restyle) applies fill variable', async () => {
    const result = await h.call('figma_update_node', {
      op: 'restyle',
      nodeId: 'frame-1',
      fillVariable: 'bg-primary',
    });
    assert.ok(result.ok || !result.error, 'Should succeed');
  });

  it('figma_update_node (restyle) rejects invalid variable', async () => {
    const result = await h.call('figma_update_node', {
      op: 'restyle',
      nodeId: 'frame-1',
      fillVariable: 'nonexistent',
    });
    assert.equal(result.error, 'INVALID_VARIABLE_PATHS');
  });

  it('figma_update_node (fill) applies fill variable', async () => {
    const result = await h.call('figma_update_node', {
      op: 'fill',
      nodeId: 'node-1',
      fillVariable: 'bg-secondary',
    });
    assert.ok(!result.error, 'Should succeed with valid variable');
  });

  it('figma_update_node (fill) requires at least one color source', async () => {
    const result = await h.call('figma_update_node', { op: 'fill', nodeId: 'node-1' });
    assert.equal(result.error, 'MISSING_COLOR');
  });

  it('figma_update_node (text_style) applies text style', async () => {
    const result = await h.call('figma_update_node', {
      op: 'text_style',
      nodeId: 'text-1',
      textStyleId: 'ts-key-1',
    });
    assert.ok(!result.error, 'Should succeed');
  });

  it('figma_update_node (layout) applies sizing changes', async () => {
    const result = await h.call('figma_update_node', {
      op: 'layout',
      nodeId: 'frame-1',
      layoutSizingHorizontal: 'FILL',
      gapVariable: 'spacing-xl',
    });
    assert.ok(!result.error, 'Should succeed with valid variables');
  });

  it('figma_update_node (text) updates text content', async () => {
    const result = await h.call('figma_update_node', {
      op: 'text',
      nodeId: 'text-1',
      content: 'Updated content',
    });
    assert.ok(!result.error, 'Should succeed');
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 5 — Chart Build (full build, not just compute)
// ═══════════════════════════════════════════════════════════════════
describe('Block 5 — Chart build', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('mimic_build_chart with type "bar" creates chart', async () => {
    const result = await h.call('mimic_build_chart', {
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue by Month',
      data: [
        { label: 'Jan', value: 12000 },
        { label: 'Feb', value: 18000 },
        { label: 'Mar', value: 15000 },
      ],
      dimensions: { chartHeight: 200 },
    });
    assert.ok(result.chartCardId, 'Should return chart card ID');
    assert.equal(result.chartType, 'bar');
    assert.ok(result.summary.totalElements > 0, 'Should have created elements');
    assert.ok(result.geometry, 'Should have computed geometry');
  });

  it('mimic_build_chart with invalid chartType returns error', async () => {
    const result = await h.call('mimic_build_chart', {
      parentId: 'p-1',
      chartType: 'waterfall',
      title: 'Test',
      data: [{ label: 'A', value: 1 }],
      dimensions: {},
    });
    assert.equal(result.error, 'UNSUPPORTED_CHART_TYPE');
  });

  it('mimic_compute_chart for bar returns bars and axes', async () => {
    const result = await h.call('mimic_compute_chart', {
      chartType: 'bar',
      data: [
        { label: 'A', value: 10 },
        { label: 'B', value: 20 },
      ],
      dimensions: { chartHeight: 200 },
    });
    assert.ok(result.bars, 'Should have bars');
    assert.ok(result.bars.length === 2, 'Should have 2 bars');
    assert.ok(result._chartColorHint, 'Should have color hint');
    assert.ok(result._chartColorHint.suggestedPalette, 'Should have suggested palette');
    assert.ok(result._chartColorHint.colorRules, 'Should have color rules');
    assert.ok(result._chartBuildRules, 'Should have build rules');
  });

  it('mimic_compute_chart suggestedPalette excludes semantic colors', async () => {
    const result = await h.call('mimic_compute_chart', {
      chartType: 'bar',
      data: [{ label: 'A', value: 10 }],
      dimensions: { chartHeight: 200 },
    });
    const palette = result._chartColorHint.suggestedPalette;
    // Palette should NOT include Brand, Success, Warning, Error at 500 level
    for (const color of palette) {
      assert.ok(!color.includes('utility-brand-500'), `Palette should exclude brand: ${color}`);
      assert.ok(!color.includes('utility-success-500'), `Palette should exclude success: ${color}`);
      assert.ok(!color.includes('utility-warning-500'), `Palette should exclude warning: ${color}`);
      assert.ok(!color.includes('utility-error-500'), `Palette should exclude error: ${color}`);
    }
  });

  it('mimic_compute_chart for donut returns segments spanning full circle', async () => {
    const result = await h.call('mimic_compute_chart', {
      chartType: 'donut',
      data: [
        { label: 'A', value: 60 },
        { label: 'B', value: 40 },
      ],
      dimensions: { outerRadius: 80, innerRadius: 0.6 },
    });
    assert.ok(result.segments, 'Should have segments');
    assert.equal(result.segments.length, 2);
    // The last segment's endAngle should be close to the first segment's startAngle + 2*PI
    const firstStart = result.segments[0].startAngle;
    const lastEnd = result.segments[result.segments.length - 1].endAngle;
    const totalArc = lastEnd - firstStart;
    assert.ok(Math.abs(totalArc - 2 * Math.PI) < 0.01, `Total arc should be ~2PI, got ${totalArc}`);
  });

  it('mimic_compute_chart with unknown type returns error', async () => {
    const result = await h.call('mimic_compute_chart', {
      chartType: 'sankey',
      data: [],
      dimensions: {},
    });
    assert.ok(result.error, 'Should return error for unknown type');
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 6 — Build Manifest and Inspection
// ═══════════════════════════════════════════════════════════════════
describe('Block 6 — Build manifest and inspection', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('figma_inspect (section) finds by name from build manifest', async () => {
    // Use non-component-like names to avoid component-first gate
    await h.call('figma_create_frame', { name: 'Content Area', parentId: 'artboard-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Metrics Row', parentId: 'artboard-1', direction: 'HORIZONTAL' });

    const result = await h.call('figma_inspect', { target: 'section', sectionName: 'Content' });
    assert.ok(result.found, 'Should find Content Area');
    assert.ok(result.figmaNodeId, 'Should have figmaNodeId');
    assert.ok(result.htmlSection.includes('Content'), 'Should match Content Area');
  });

  it('figma_inspect (section) returns available sections when not found', async () => {
    await h.call('figma_create_frame', { name: 'Details Panel', parentId: 'artboard-1', direction: 'VERTICAL' });

    const result = await h.call('figma_inspect', { target: 'section', sectionName: 'Nonexistent' });
    assert.equal(result.found, false);
    assert.ok(result.available, 'Should list available sections');
    assert.ok(result.available.includes('Details Panel'));
  });

  it('Build manifest records sections during frame creation and component insertion', async () => {
    // Create artboard (no parent)
    const artboard = await h.call('figma_create_frame', { name: 'Dashboard', direction: 'VERTICAL', width: 1440, height: 900 });
    assert.ok(h.buildManifest.artboardId, 'Artboard should be recorded');

    // Create child frame
    await h.call('figma_create_frame', { name: 'Stats Row', parentId: artboard.nodeId, direction: 'HORIZONTAL' });
    const frameSections = h.buildManifest.sections.filter(s => s.type === 'frame');
    assert.ok(frameSections.length >= 1, 'Should have frame sections');

    // Insert component
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: artboard.nodeId, name: 'Status Badge' });
    const compSections = h.buildManifest.sections.filter(s => s.type === 'component');
    assert.ok(compSections.length >= 1, 'Should have component sections');
  });

  it('mimic_ai_knowledge_read (format: design_md) returns DS reference content', async () => {
    const result = await h.call('mimic_ai_knowledge_read', { format: 'design_md' });
    assert.ok(result.content, 'Should have content');
    assert.ok(result.content.includes('Design System Reference'), 'Should have DS title');
    assert.ok(result.content.includes('Variables'), 'Should mention variables');
    assert.ok(result.content.includes('10'), 'Should show variable count');
  });

  it('figma_inspect (section) with empty manifest returns empty available', async () => {
    const result = await h.call('figma_inspect', { target: 'section', sectionName: 'anything' });
    assert.equal(result.found, false);
    assert.ok(Array.isArray(result.available));
    assert.equal(result.available.length, 0);
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 7 — Verified Confidence + Gap Merge + Stress
// ═══════════════════════════════════════════════════════════════════
describe('Block 7 — Verified confidence, gap merge, stress', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  it('Component recipe across 7 builds promoted to verified', async () => {
    // Simulate 7 builds with Badge component
    for (let i = 0; i < 7; i++) {
      h.advancePhase(2);
      await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });
      await h.call('mimic_generate_build_report', {
        screenName: `Build ${i + 1}`,
        components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
        primitives: [],
      });
      h.resetSession();
      h.seedCache();
      h.knowledgeStore.load();
    }

    h.knowledgeStore.load();
    const recipe = h.knowledgeStore.getComponent('ck-badge');
    assert.ok(recipe, 'Recipe should exist');
    assert.equal(recipe.confidence, 'verified', 'Should be promoted to verified');
    assert.equal(recipe.buildCount, 7);
  });

  it('Verified recipe auto-applies variants on insert', async () => {
    // Pre-populate a verified recipe with defaultVariants
    h.knowledgeStore.setComponent('ck-badge', {
      names: ['Badge'],
      componentKey: 'ck-badge',
      confidence: 'verified',
      buildCount: 7,
      instances: 14,
      defaultVariants: { Color: 'Success', Size: 'sm' },
    });
    h.knowledgeStore.save();

    h.advancePhase(2);
    const result = await h.call('figma_insert_component', {
      componentKey: 'ck-badge',
      parentId: 'p-1',
      name: 'Badge',
    });
    assert.ok(result._autoApplied, 'Should have auto-applied variants');
    assert.deepEqual(result._autoApplied.variants, { Color: 'Success', Size: 'sm' });
  });

  it('Gap tracking: same gap reported twice merges elements', async () => {
    h.knowledgeStore.addGap('Progress Bar', {
      elements: ['progress-bar'],
      evidence: 'Build 1',
    });
    h.knowledgeStore.addGap('Progress Bar', {
      elements: ['progress-bar', 'linear-progress'],
      evidence: 'Build 2',
    });
    h.knowledgeStore.save();
    h.knowledgeStore.load();

    const gaps = h.knowledgeStore.getGaps();
    assert.ok(gaps['Progress Bar'], 'Gap should exist');
    // Elements should be deduplicated
    assert.ok(gaps['Progress Bar'].elements.includes('progress-bar'));
    assert.ok(gaps['Progress Bar'].elements.includes('linear-progress'));
    // Evidence should be updated
    assert.equal(gaps['Progress Bar'].evidence, 'Build 2');
    // lastSeen should be updated
    assert.ok(gaps['Progress Bar'].lastSeen);
  });

  it('Gap tracking: different gaps stored separately', async () => {
    h.knowledgeStore.addGap('Progress', { elements: ['progress'], evidence: 'Test 1' });
    h.knowledgeStore.addGap('Stepper', { elements: ['stepper'], evidence: 'Test 2' });
    h.knowledgeStore.save();
    h.knowledgeStore.load();

    const gaps = h.knowledgeStore.getGaps();
    assert.ok(gaps['Progress'], 'Progress gap should exist');
    assert.ok(gaps['Stepper'], 'Stepper gap should exist');
    assert.notDeepEqual(gaps['Progress'].elements, gaps['Stepper'].elements);
  });

  it('Build report with binding failures + category mismatches + rule violations all at once', async () => {
    h.advancePhase(2);

    // Set up binding failures in session
    h.session.bindingFailures = [
      { nodeId: 'n1', nodeName: 'Card', tool: 'create_frame', failedBindings: ['bg-error'] },
    ];
    // Set up category mismatches in session
    h.session.categoryMismatches = ['Used bg-primary as strokeVariable instead of border-primary'];

    // Add a color rule to the knowledge store
    h.knowledgeStore.setRule('color-semantic', {
      category: 'color',
      rule: 'Never use brand colors on charts',
      scope: 'charts',
    });
    h.knowledgeStore.save();

    // Build a primitive called "chart" that would trigger color rule check
    await h.call('figma_create_frame', { name: 'Chart Area', parentId: 'p-1', direction: 'VERTICAL' });

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Mixed Issues Build',
      components: [],
      primitives: [{ element: 'chart', reason: 'No chart component in DS' }],
    });

    // All three sections should appear
    assert.ok(report.bindingFailureCount > 0, 'Should report binding failures');
    assert.ok(report.summary.includes('binding failures'), 'Summary should mention binding failures');
    assert.ok(report.recommendations, 'Should have recommendations');
  });

  it('10 rules matching one frame all injected in _rules', async () => {
    h.advancePhase(2);

    // Create 10 rules that match "card"
    for (let i = 0; i < 10; i++) {
      h.knowledgeStore.setRule(`card-rule-${i}`, {
        category: 'structure',
        rule: `Card rule number ${i}: always do thing ${i}`,
        scope: 'card',
      });
    }
    h.knowledgeStore.save();

    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'p-1',
      direction: 'VERTICAL',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'No card component in DS library',
    });
    assert.ok(frame._rules, 'Should have _rules');
    assert.equal(frame._rules.length, 10, 'All 10 rules should be injected');
  });

  it('20 rules saved all retrievable', async () => {
    for (let i = 0; i < 20; i++) {
      h.knowledgeStore.setRule(`rule-${i}`, {
        category: i % 2 === 0 ? 'color' : 'structure',
        rule: `Rule number ${i}`,
      });
    }
    h.knowledgeStore.save();
    h.knowledgeStore.load();

    const rules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(rules).length, 20);
  });

  it('Build history: 3 builds with different tool calls', async () => {
    for (let buildNum = 1; buildNum <= 3; buildNum++) {
      h.advancePhase(2);
      h.session.toolCallCount = 50 - buildNum * 5; // Decreasing tool calls: 45, 40, 35
      await h.call('figma_create_frame', { name: 'Frame', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: `Build ${buildNum}`,
        components: [],
        primitives: [],
        toolCallCount: 50 - buildNum * 5,
      });
      h.resetSession();
      h.seedCache();
      h.knowledgeStore.load();
    }

    h.knowledgeStore.load();
    const history = h.knowledgeStore.getBuildHistory();
    assert.equal(history.length, 3, 'Should have 3 build history entries');
    // Verify decreasing tool calls
    assert.ok(history[0].toolCalls > history[2].toolCalls, 'Tool calls should decrease');
  });

  it('Knowledge store with 50 component recipes: load/save intact', async () => {
    for (let i = 0; i < 50; i++) {
      h.knowledgeStore.setComponent(`comp-${i}`, {
        names: [`Component ${i}`],
        componentKey: `ck-${i}`,
        confidence: i < 7 ? 'verified' : i < 20 ? 'confirmed' : 'new',
        buildCount: i + 1,
        instances: i * 2,
      });
    }
    h.knowledgeStore.save();

    // Reload and verify all 50 are intact
    const fresh = new (require('../../src/knowledge/store').KnowledgeStore)(h.knowledgeStore.filePath);
    fresh.load();
    assert.equal(Object.keys(fresh.data.components).length, 50);
    assert.equal(fresh.getComponent('comp-49').instances, 98);
    assert.equal(fresh.getComponent('comp-0').confidence, 'verified');
  });

  it('Pattern with no layoutConfig stored but no replay', async () => {
    h.advancePhase(2);

    // Create a pattern with minimal args (no layout config to capture)
    await h.call('figma_create_frame', { name: 'Row: A', parentId: 'p-1' });
    await h.call('figma_create_frame', { name: 'Row: B', parentId: 'p-1' });

    await h.call('mimic_generate_build_report', {
      screenName: 'Minimal Build',
      components: [],
      primitives: [],
    });

    h.knowledgeStore.load();
    const pattern = h.knowledgeStore.getPattern('Row');
    assert.ok(pattern, 'Row pattern should exist');
    // No layout config captured since no layout properties were provided
    // Pattern still stored, just without replay data
    assert.equal(pattern.confidence, 'new');
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 8 — Component Text Tracking
// ═══════════════════════════════════════════════════════════════════
describe('Block 8 — Component text tracking', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    h.advancePhase(2);
  });

  it('figma_component_text tracks override in componentTextTracker', async () => {
    // Insert component first (sets up tracker)
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card',
      parentId: 'p-1',
      name: 'Card Header',
    });

    // Override text
    await h.call('figma_component_text', {
      nodeId: comp.nodeId,
      overrides: [{ textNodeName: 'Text', content: 'Revenue' }],
    });

    const tracker = h.session.componentTextTracker.get(comp.nodeId);
    assert.ok(tracker, 'Tracker should exist for this component');
    assert.ok(tracker.overridden.has('Text'), 'Text node name should be tracked as overridden');
  });

  it('figma_component_text (textNodeId) tracks override by exact nodeId', async () => {
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card',
      parentId: 'p-1',
      name: 'Card',
    });

    await h.call('figma_component_text', {
      nodeId: comp.nodeId,
      overrides: [{ textNodeId: 'tn-1', content: 'Updated' }],
    });

    const tracker = h.session.componentTextTracker.get(comp.nodeId);
    assert.ok(tracker, 'Tracker should exist');
    assert.ok(tracker.overridden.has('tn-1'), 'Exact textNodeId should be tracked');
  });

  it('Unoverridden text nodes appear in build report', async () => {
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card',
      parentId: 'p-1',
      name: 'Incomplete Card',
    });

    // Deliberately skip text override

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Incomplete Build',
      components: [{ name: 'Card', instances: 1, componentKey: 'ck-card' }],
      primitives: [],
    });

    assert.ok(report.unoverriddenTextCount > 0, 'Should report unoverridden text nodes');
    assert.ok(report.summary.includes('text node(s) not overridden'), 'Summary should mention unoverridden text');
  });

  it('All text overridden shows no unoverridden warning in report', async () => {
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card',
      parentId: 'p-1',
      name: 'Complete Card',
    });

    // Override the text node
    await h.call('figma_component_text', {
      nodeId: comp.nodeId,
      overrides: [{ textNodeName: 'Text', content: 'Real content' }],
    });

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Complete Build',
      components: [{ name: 'Card', instances: 1, componentKey: 'ck-card' }],
      primitives: [],
    });

    assert.equal(report.unoverriddenTextCount, 0, 'Should have no unoverridden text');
  });

  it('figma_component_text with partial failure reports correctly', async () => {
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-multi',
      parentId: 'p-1',
      name: 'Multi-text',
    });

    // Override bridge to simulate partial failure
    const origSend = h.bridge.send;
    h.bridge.send = (type, payload) => {
      if (type === 'batch_set_component_text') {
        return Promise.resolve({
          succeeded: 2,
          failed: 1,
          results: [
            { ok: true, textNodeName: 'Title', nodeId: 'tn-title' },
            { ok: true, textNodeName: 'Subtitle', nodeId: 'tn-sub' },
            { ok: false, textNodeName: 'Nonexistent', error: 'Node not found' },
          ],
        });
      }
      return origSend.call(h.bridge, type, payload);
    };

    const result = await h.call('figma_component_text', {
      nodeId: comp.nodeId,
      overrides: [
        { textNodeName: 'Title', content: 'Dashboard' },
        { textNodeName: 'Subtitle', content: 'Welcome' },
        { textNodeName: 'Nonexistent', content: 'Oops' },
      ],
    });

    assert.ok(result.hint.includes('1'), 'Should mention 1 failed node');
    // Successful ones should be tracked
    const tracker = h.session.componentTextTracker.get(comp.nodeId);
    assert.ok(tracker, 'Tracker should exist');
    assert.ok(tracker.overridden.has('Title'), 'Title should be tracked');
    assert.ok(tracker.overridden.has('Subtitle'), 'Subtitle should be tracked');

    h.bridge.send = origSend;
  });
});


// ═══════════════════════════════════════════════════════════════════
// BLOCK 9 — End-to-End Pre-Release Scenario
// ═══════════════════════════════════════════════════════════════════
describe('Block 9 — End-to-end pre-release scenario', () => {
  it('Complete two-build session with learning, rules, and promotion', async () => {
    const h = createTestHarness();

    // ── Step 1: Empty knowledge store ──
    const emptyRead = await h.call('mimic_ai_knowledge_read', {});
    assert.equal(Object.keys(emptyRead.components).length, 0);
    assert.equal(Object.keys(emptyRead.rules).length, 0);

    // ── Step 2: Check status at Phase 0 ──
    const status0 = await h.call('mimic_status', {});
    assert.equal(status0.phase, 0);

    // ── Step 3: Advance to Phase 2 (skip real discovery) ──
    h.seedCache();
    h.advancePhase(2);

    // ── Step 4: Map components ──
    // Add some components to dsCache for mapping
    h.dsCache.addComponent('ck-card-header', { name: 'Card Header', isComponentSet: true });
    h.dsCache.addComponent('ck-badge', { name: 'Badge', isComponentSet: true });

    const mapping = await h.call('mimic_map_components', {
      elementTypes: ['card header', 'badge', 'table'],
      librarySearchResults: [], // Mark search as complete
    });
    assert.ok(mapping.searchComplete, 'Search should be complete');
    assert.ok(mapping.mapped >= 2, 'Should find card header and badge');

    // ── Step 5: Build a dashboard ──
    // Artboard
    const artboard = await h.call('figma_create_frame', {
      name: 'Dashboard',
      direction: 'VERTICAL',
      width: 1440,
      height: 900,
    });
    assert.ok(artboard.nodeId);

    // Header section
    const header = await h.call('figma_create_frame', {
      name: 'Header Section',
      parentId: artboard.nodeId,
      direction: 'HORIZONTAL',
      fillVariable: 'bg-primary',
      paddingVariable: 'spacing-xl',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'No header component in DS library',
    });

    // Stats row
    const statsRow = await h.call('figma_create_frame', {
      name: 'Stats Row',
      parentId: artboard.nodeId,
      direction: 'HORIZONTAL',
      gapVariable: 'spacing-xl',
    });

    // ── Step 6: 4 stat cards ──
    const cardNames = ['Card: Revenue', 'Card: Users', 'Card: Orders', 'Card: Conversion'];
    const cardNodeIds = [];
    for (const cardName of cardNames) {
      const card = await h.call('figma_create_frame', {
        name: cardName,
        parentId: statsRow.nodeId,
        direction: 'VERTICAL',
        paddingVariable: 'spacing-xl',
        gapVariable: 'spacing-xl',
        fillVariable: 'bg-primary',
        strokeVariable: 'border-secondary',
        cornerRadiusVariable: 'radius-md',
      });
      cardNodeIds.push(card.nodeId);

      // Insert card header
      const ch = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: card.nodeId,
        name: `${cardName} Header`,
      });
      await h.call('figma_component_text', {
        nodeId: ch.nodeId,
        overrides: [{ textNodeName: 'Text', content: cardName.split(': ')[1] }],
      });

      // Insert badge
      const badge = await h.call('figma_insert_component', {
        componentKey: 'ck-badge',
        parentId: card.nodeId,
        name: `${cardName} Badge`,
      });
      await h.call('figma_set_variant', {
        nodeId: badge.nodeId,
        properties: { Color: 'Success' },
      });
      await h.call('figma_component_text', {
        nodeId: badge.nodeId,
        overrides: [{ textNodeName: 'Text', content: '+12%' }],
      });
    }

    // Footer
    await h.call('figma_create_frame', {
      name: 'Footer Section',
      parentId: artboard.nodeId,
      direction: 'HORIZONTAL',
      fillVariable: 'bg-secondary',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'No footer component in DS library',
    });

    // ── Step 8: Generate report ──
    const report1 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard Build 1',
      components: [
        { name: 'Card Header', instances: 4, componentKey: 'ck-card-header' },
        { name: 'Badge', instances: 4, componentKey: 'ck-badge' },
      ],
      primitives: [
        { element: 'Header Section', reason: 'No header component in DS library' },
        { element: 'Footer Section', reason: 'No footer component in DS library' },
      ],
    });
    assert.ok(report1.reportPath, 'Should have report path');
    assert.ok(report1.componentUsagePercent >= 60, 'Should have decent component usage');

    // Verify knowledge store state after report
    h.knowledgeStore.load();
    const cardHeaderRecipe = h.knowledgeStore.getComponent('ck-card-header');
    assert.ok(cardHeaderRecipe, 'Card Header recipe should be persisted');
    assert.equal(cardHeaderRecipe.buildCount, 1);

    const badgeRecipe = h.knowledgeStore.getComponent('ck-badge');
    assert.ok(badgeRecipe, 'Badge recipe should be persisted');

    const cardPattern = h.knowledgeStore.getPattern('Card');
    assert.ok(cardPattern, 'Card pattern should be created');
    assert.ok(cardPattern.occurrences >= 4, 'Pattern should have 4 occurrences');

    // ── Step 9: Save 4 rules from "user feedback" ──
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-structure',
      data: { category: 'structure', rule: 'Cards always have card header + content area', scope: 'card' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'badge-color',
      data: { category: 'component', rule: 'Badge default color is Success for positive metrics', scope: 'badge' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-padding',
      data: { category: 'spacing', rule: 'Cards use spacing-xl for padding and gap', scope: 'card' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'header-fill',
      data: { category: 'color', rule: 'Header uses bg-primary fill', scope: 'header' },
    });

    // ── Step 10: Reset session, start Build 2 ──
    h.resetSession();
    h.seedCache();
    h.knowledgeStore.load();

    // ── Step 11: Verify status shows rules + recipes ──
    const status2 = await h.call('mimic_status', {});
    assert.ok(status2._designRules, 'Status should show design rules');
    assert.equal(status2._designRules.length, 4, 'Should have 4 rules');
    assert.ok(status2.knowledge.components >= 2, 'Should have component recipes');

    // ── Step 12: Build same dashboard again ──
    h.advancePhase(2);

    const artboard2 = await h.call('figma_create_frame', {
      name: 'Dashboard v2',
      direction: 'VERTICAL',
      width: 1440,
      height: 900,
    });

    const statsRow2 = await h.call('figma_create_frame', {
      name: 'Stats Row',
      parentId: artboard2.nodeId,
      direction: 'HORIZONTAL',
      gapVariable: 'spacing-xl',
    });

    // Build 4 cards again - rules should be injected
    for (const cardName of cardNames) {
      const card = await h.call('figma_create_frame', {
        name: cardName,
        parentId: statsRow2.nodeId,
        direction: 'VERTICAL',
        paddingVariable: 'spacing-xl',
        gapVariable: 'spacing-xl',
        fillVariable: 'bg-primary',
        strokeVariable: 'border-secondary',
        cornerRadiusVariable: 'radius-md',
      });

      // Rules should be injected on card frames
      assert.ok(card._rules, `Rules should be injected for ${cardName}`);
      assert.ok(card._rules.length > 0, 'Should have matching rules');

      const ch = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: card.nodeId,
        name: `${cardName} Header`,
      });
      await h.call('figma_component_text', {
        nodeId: ch.nodeId,
        overrides: [{ textNodeName: 'Text', content: cardName.split(': ')[1] }],
      });

      const badge = await h.call('figma_insert_component', {
        componentKey: 'ck-badge',
        parentId: card.nodeId,
        name: `${cardName} Badge`,
      });
      // Verified recipe should auto-apply variants if badge reached confirmed
      await h.call('figma_component_text', {
        nodeId: badge.nodeId,
        overrides: [{ textNodeName: 'Text', content: '+12%' }],
      });
    }

    // ── Step 13: Generate report 2 ──
    const report2 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard Build 2',
      components: [
        { name: 'Card Header', instances: 4, componentKey: 'ck-card-header' },
        { name: 'Badge', instances: 4, componentKey: 'ck-badge' },
      ],
      primitives: [],
    });
    assert.ok(report2.reportPath, 'Should have report path');
    assert.ok(report2.rulesChecked >= 4, 'Should have checked rules');

    // ── Step 14: Verify final knowledge store state ──
    h.knowledgeStore.load();
    const finalCardHeader = h.knowledgeStore.getComponent('ck-card-header');
    assert.equal(finalCardHeader.buildCount, 2, 'Card Header should have 2 builds');

    const finalBadge = h.knowledgeStore.getComponent('ck-badge');
    assert.equal(finalBadge.buildCount, 2, 'Badge should have 2 builds');

    const finalRules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(finalRules).length, 4, 'Should still have 4 rules');

    const history = h.knowledgeStore.getBuildHistory();
    assert.equal(history.length, 2, 'Should have 2 build history entries');
    assert.equal(history[0].screenName, 'Dashboard Build 1');
    assert.equal(history[1].screenName, 'Dashboard Build 2');

    const finalPattern = h.knowledgeStore.getPattern('Card');
    assert.ok(finalPattern, 'Card pattern should still exist');
    assert.equal(finalPattern.buildCount, 2, 'Pattern should have buildCount 2');
  });
});
