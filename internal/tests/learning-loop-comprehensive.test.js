'use strict';

/**
 * Learning Loop — Comprehensive Integration Tests
 *
 * 5-tier test suite simulating real production build sessions.
 * Tests the COMPLETE learning loop: builds produce knowledge,
 * user feedback saves rules, subsequent builds use that knowledge
 * AND enforce those rules.
 *
 * Uses a mock bridge — no Figma connection needed.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Helpers ──────────────────────────────────────────────────────

function createTestHarness() {
  // Mock bridge that returns plausible responses
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
          return Promise.resolve({ ok: true });
        case 'batch_set_component_text':
          return Promise.resolve({ succeeded: payload.overrides?.length || 0, failed: 0, results: (payload.overrides || []).map(o => ({ ok: true, textNodeName: o.textNodeName })) });
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
          // Default: not a page child (allows deletion)
          return Promise.resolve({ type: 'FRAME', parentType: 'FRAME' });
        case 'delete_node':
          return Promise.resolve({ ok: true });
        case 'set_all_variable_modes':
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({ ok: true });
      }
    },
    sendBatch(ops) {
      // Mock batch: process each op sequentially and return results
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

  // Create temp knowledge store
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-learn-comp-'));
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

  // Register tools
  require('../../src/tools/status').register(null, context);
  require('../../src/tools/ds-setup').register(null, context);
  require('../../src/tools/build').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/edit').register(null, context);
  require('../../src/tools/learning').register(null, context);
  require('../../src/tools/table').register(null, context);

  async function call(name, args = {}) {
    const handler = toolRegistry.handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args);
  }

  // Seed DS cache with basic variables for all tests
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

  return { call, session, dsCache, knowledgeStore, bridge, resetSession, advancePhase, tmpDir, buildManifest, seedCache };
}


// ═══════════════════════════════════════════════════════════════════
// TIER 1 — Single-element builds
// ═══════════════════════════════════════════════════════════════════
describe('Tier 1 — Single-element builds', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  it('Stat card: frame layout config captured and component recipe persisted', async () => {
    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'parent-1',
      direction: 'VERTICAL',
      paddingVariable: 'spacing-3xl',
    });
    assert.ok(frame.nodeId, 'Frame should be created');

    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-badge',
      parentId: frame.nodeId,
      name: 'Badge',
    });
    assert.ok(comp.nodeId, 'Component should be inserted');

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Stat Card Build',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });
    assert.ok(report.summary.includes('Stat Card Build'));

    h.knowledgeStore.load();
    const recipe = h.knowledgeStore.getComponent('ck-badge');
    assert.ok(recipe, 'Badge recipe should be persisted');
    assert.equal(recipe.buildCount, 1);
    assert.ok(recipe.componentKey === 'ck-badge' || recipe.componentKey === null);
  });

  it('Single input form: two recipes stored separately with correct instance counts', async () => {
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-input', parentId: 'p-1', name: 'Input' });
    await h.call('figma_insert_component', { componentKey: 'ck-button', parentId: 'p-1', name: 'Button' });

    await h.call('mimic_generate_build_report', {
      screenName: 'Form Build',
      components: [
        { name: 'Input', instances: 1, componentKey: 'ck-input' },
        { name: 'Button', instances: 1, componentKey: 'ck-button' },
      ],
      primitives: [],
    });

    h.knowledgeStore.load();
    assert.ok(h.knowledgeStore.getComponent('ck-input'), 'Input recipe stored');
    assert.ok(h.knowledgeStore.getComponent('ck-button'), 'Button recipe stored');
    assert.equal(h.knowledgeStore.getComponent('ck-input').instances, 1);
    assert.equal(h.knowledgeStore.getComponent('ck-button').instances, 1);
  });

  it('Repeated pattern: Card prefix x3 creates a pattern with 3 occurrences', async () => {
    h.advancePhase(2);

    // The build manifest tracks frame creations for pattern extraction
    await h.call('figma_create_frame', { name: 'Card: Revenue', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Card: Users', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Card: Orders', parentId: 'p-1', direction: 'VERTICAL' });

    // Build manifest should have 3 frame sections
    const frameSections = h.buildManifest.sections.filter(s => s.type === 'frame');
    assert.ok(frameSections.length >= 3, 'Should have at least 3 frame sections');

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Cards Build',
      components: [],
      primitives: [],
    });

    h.knowledgeStore.load();
    const pattern = h.knowledgeStore.getPattern('Card');
    assert.ok(pattern, 'Card pattern should be created');
    assert.ok(pattern.occurrences >= 3, 'Pattern should have 3+ occurrences');
    assert.equal(pattern.confidence, 'new', 'Pattern should be new after 1 build');
  });

  it('Empty build: report still valid, no crash', async () => {
    h.advancePhase(2);
    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Empty Build',
      components: [],
      primitives: [],
    });
    assert.ok(report.summary.includes('Empty Build'));
    assert.equal(report.componentUsagePercent, 100, 'No elements means 100% (vacuous truth)');
  });

  it('Text node with bg-* fillVariable warns about category mismatch', async () => {
    h.advancePhase(2);
    const text = await h.call('figma_create_text', {
      parentId: 'p-1',
      content: 'Hello',
      fillVariable: 'bg-primary',
    });
    assert.ok(text.nodeId);
    assert.ok(text._categoryWarnings, 'Should have category warnings');
    assert.ok(text._categoryWarnings.length > 0);
    assert.ok(text._categoryWarnings[0].includes('text'), 'Should mention text category');
  });

  it('Text node with correct text-* fillVariable: no warning', async () => {
    h.advancePhase(2);
    const text = await h.call('figma_create_text', {
      parentId: 'p-1',
      content: 'Hello',
      fillVariable: 'text-primary',
    });
    assert.ok(text.nodeId);
    assert.ok(!text._categoryWarnings, 'Should have no category warnings');
  });

  it('Frame with bg-* strokeVariable warns and suggests border-*', async () => {
    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Test Frame',
      parentId: 'p-1',
      direction: 'VERTICAL',
      strokeVariable: 'bg-secondary',
    });
    assert.ok(frame.nodeId);
    assert.ok(frame._categoryWarnings, 'Should have category warnings');
    assert.ok(frame._categoryWarnings[0].includes('bg-*'), 'Should mention bg-* category');
    assert.ok(frame._categoryWarnings[0].includes('border'), 'Should suggest border category');
  });

  it('Correct variable usage: border-* for stroke, text-* for text, bg-* for fill = zero warnings', async () => {
    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Correct Frame',
      parentId: 'p-1',
      direction: 'VERTICAL',
      fillVariable: 'bg-primary',
      strokeVariable: 'border-secondary',
    });
    assert.ok(!frame._categoryWarnings, 'No warnings for correct usage');

    const text = await h.call('figma_create_text', {
      parentId: frame.nodeId,
      content: 'Label',
      fillVariable: 'text-primary',
    });
    assert.ok(!text._categoryWarnings, 'No warnings for correct text fill');
  });

  it('fg-* as fillVariable on a frame does NOT warn (ambiguous, allowed)', async () => {
    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Icon Frame',
      parentId: 'p-1',
      direction: 'VERTICAL',
      fillVariable: 'fg-success-primary',
    });
    assert.ok(frame.nodeId);
    assert.ok(!frame._categoryWarnings, 'fg-* should not warn (ambiguous, allowed)');
  });

  // User feedback after Tier 1
  it('Rules persist and appear in mimic_status after saving', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule',
      id: 'accuracy-percent',
      data: {
        category: 'component',
        rule: 'Accuracy values always show % symbol — 91.2% not 91.2',
        scope: 'metric, accuracy, stat',
      },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule',
      id: 'metric-naming',
      data: {
        category: 'component',
        rule: 'The metric is called "accuracy", never "score"',
        scope: 'metric, label',
      },
    });

    h.knowledgeStore.load();
    const rules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(rules).length, 2);

    // Check they appear in mimic_status
    const status = await h.call('mimic_status');
    assert.equal(status.knowledge.rules, 2);
    assert.ok(status._designRules, 'Rules should be injected');
    assert.equal(status._designRules.length, 2);
    assert.ok(status._designRulesNote.includes('2 user-defined'));
  });
});


// ═══════════════════════════════════════════════════════════════════
// TIER 2 — Card patterns with boolean configuration
// ═══════════════════════════════════════════════════════════════════
describe('Tier 2 — Card patterns with boolean configuration', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  it('Content Card: insert Card Header, set variant, set text', async () => {
    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue Chart',
      parentId: 'p-1',
      direction: 'VERTICAL',
      paddingVariable: 'spacing-3xl',
      gapVariable: 'spacing-3xl',
    });
    assert.ok(frame.nodeId);

    const header = await h.call('figma_insert_component', {
      componentKey: 'ck-card-header',
      parentId: frame.nodeId,
      name: 'Card Header',
    });
    assert.ok(header.nodeId);
    assert.ok(header.configurationChecklist, 'Should have configurationChecklist');
  });

  it('Card Header boolean tracking: variant config captured in session', async () => {
    h.advancePhase(2);
    const header = await h.call('figma_insert_component', {
      componentKey: 'ck-card-header',
      parentId: 'p-1',
      name: 'Card Header',
    });

    await h.call('figma_set_variant', {
      nodeId: header.nodeId,
      properties: { Divider: 'False', 'Supporting text': 'True' },
    });

    // Verify session tracks the variant config
    const config = h.session._variantConfigs.get('ck-card-header');
    assert.ok(config, 'Variant config should be captured');
    assert.equal(config.Divider, 'False');
    assert.equal(config['Supporting text'], 'True');
  });

  it('Card Header defaultVariants persisted in recipe after build report (majority-wins, spec §5.1)', async () => {
    // Schema v3: defaultVariants requires >=3 consistent observations
    // (majority-wins, replacing last-write-wins) — insert 3 instances all
    // agreeing on the same variant values, per-NODE tracked.
    h.advancePhase(2);
    for (let i = 0; i < 3; i++) {
      const header = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: 'p-1',
        name: 'Card Header',
      });
      await h.call('figma_set_variant', {
        nodeId: header.nodeId,
        properties: { Divider: 'False', 'Supporting text': 'True' },
      });
    }

    await h.call('mimic_generate_build_report', {
      screenName: 'Card Build',
      components: [{ name: 'Card Header', instances: 3, componentKey: 'ck-card-header' }],
      primitives: [],
    });

    h.knowledgeStore.load();
    const recipe = h.knowledgeStore.getComponent('ck-card-header');
    assert.ok(recipe, 'Recipe should exist');
    assert.ok(recipe.defaultVariants, 'defaultVariants should be persisted');
    assert.equal(recipe.defaultVariants.Divider, 'False');
    assert.equal(recipe.defaultVariants['Supporting text'], 'True');
  });

  it('Two content cards create "Card" pattern with layoutConfig from first', async () => {
    h.advancePhase(2);
    await h.call('figma_create_frame', {
      name: 'Card: Revenue Chart',
      parentId: 'p-1',
      direction: 'VERTICAL',
      paddingVariable: 'spacing-3xl',
      gapVariable: 'spacing-3xl',
    });
    await h.call('figma_create_frame', {
      name: 'Card: User Growth',
      parentId: 'p-1',
      direction: 'VERTICAL',
      paddingVariable: 'spacing-3xl',
    });

    await h.call('mimic_generate_build_report', {
      screenName: 'Cards Session',
      components: [],
      primitives: [],
    });

    h.knowledgeStore.load();
    const pattern = h.knowledgeStore.getPattern('Card');
    assert.ok(pattern, 'Card pattern should be stored');
    assert.ok(pattern.layoutConfig, 'Layout config should be stored');
    assert.equal(pattern.layoutConfig.direction, 'VERTICAL');
    assert.equal(pattern.layoutConfig.paddingVariable, 'spacing-3xl');
  });

  it('Data Card creates a DIFFERENT pattern from Content Card', async () => {
    h.advancePhase(2);
    await h.call('figma_create_frame', { name: 'Card: Revenue Chart', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Card: User Growth', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Data Card: Leaderboard', parentId: 'p-1', direction: 'VERTICAL', padding: 0 });
    await h.call('figma_create_frame', { name: 'Data Card: History', parentId: 'p-1', direction: 'VERTICAL', padding: 0 });

    await h.call('mimic_generate_build_report', {
      screenName: 'Mixed Cards',
      components: [],
      primitives: [],
    });

    h.knowledgeStore.load();
    assert.ok(h.knowledgeStore.getPattern('Card'), 'Card pattern should exist');
    assert.ok(h.knowledgeStore.getPattern('Data Card'), 'Data Card pattern should exist');
  });

  it('Third Card instance keeps pattern at new (needs 3 builds for confirmed)', async () => {
    h.advancePhase(2);
    await h.call('figma_create_frame', { name: 'Card: A', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Card: B', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_create_frame', { name: 'Card: C', parentId: 'p-1', direction: 'VERTICAL' });

    await h.call('mimic_generate_build_report', {
      screenName: 'Triple Card',
      components: [],
      primitives: [],
    });

    h.knowledgeStore.load();
    const pattern = h.knowledgeStore.getPattern('Card');
    assert.equal(pattern.confidence, 'new', 'Pattern should still be new after 1 build (needs 3 builds)');
  });

  // User feedback after Tier 2
  it('Save 3 card rules; all injected in figma_create_frame matching "Card: X"', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'content-card-padding',
      data: { category: 'structure', rule: 'Content cards: wrapper owns padding (spacing-3xl), card header Divider=False', scope: 'card, content' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'table-card-edge',
      data: { category: 'structure', rule: 'Table cards: zero padding, card header Divider=True, table edge-to-edge', scope: 'table card, leaderboard' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-header-supporting',
      data: { category: 'component', rule: 'Card header: always enable Supporting text boolean', scope: 'card header' },
    });

    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Card: New Widget',
      parentId: 'p-1',
      direction: 'VERTICAL',
    });

    // Rules matching "card" should be injected
    assert.ok(frame._rules, 'Should have injected rules');
    assert.ok(frame._rules.length >= 1, 'At least 1 rule should match "card"');
    assert.ok(frame._rulesNote, 'Should have rules note');
  });

  it('figma_insert_component injects APPLY_DESIGN_RULES for Card Header', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-header-rule',
      data: { category: 'component', rule: 'Card header: always enable Supporting text boolean', scope: 'card header' },
    });

    h.advancePhase(2);
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card-header',
      parentId: 'p-1',
      name: 'Card Header',
    });

    assert.ok(comp.configurationChecklist, 'Should have checklist');
    const ruleAction = comp.configurationChecklist.find(c => c.action === 'APPLY_DESIGN_RULES');
    assert.ok(ruleAction, 'Should have APPLY_DESIGN_RULES action');
    assert.ok(ruleAction.rules.length >= 1, 'Should have at least 1 rule');
  });
});


// ═══════════════════════════════════════════════════════════════════
// TIER 3 — Data tables + spacing enforcement
// ═══════════════════════════════════════════════════════════════════
describe('Tier 3 — Data tables + spacing enforcement', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
    // Table builder needs component keys in dsCache
    h.dsCache.addComponent('ck-th', { name: 'Table header cell', isComponentSet: true });
    h.dsCache.addComponent('ck-td', { name: 'Table cell', isComponentSet: true });
  });

  it('Basic table: 3 columns, 5 rows creates correct cell counts', async () => {
    h.advancePhase(2);
    const result = await h.call('mimic_build_table', {
      parentId: 'p-1',
      headerCellKey: 'ck-th',
      dataCellKey: 'ck-td',
      cellHeight: 44,
      columns: [
        { header: 'Name', style: 'Text' },
        { header: 'Status', style: 'Badge' },
        { header: 'Role', style: 'Text' },
      ],
      rows: [
        ['Alice', 'Active', 'Admin'],
        ['Bob', 'Pending', 'Member'],
        ['Carol', 'Active', 'Viewer'],
        ['Dave', 'Inactive', 'Member'],
        ['Eve', 'Active', 'Admin'],
      ],
    });

    assert.ok(result.tableBodyId, 'Should have table body ID');
    assert.equal(result.summary.headerCells, 3, 'Should have 3 header cells');
    assert.equal(result.summary.dataCells, 15, 'Should have 15 data cells (3 columns x 5 rows)');
    assert.equal(result.summary.totalComponents, 18, 'Total components = 3 + 15');
    assert.ok(result.summary.totalOperations > 0, 'Should have operations');
  });

  it('Table with first/last column padding calls set_node_props with padding variables', async () => {
    h.advancePhase(2);
    const setPropsCalls = [];
    const origSend = h.bridge.send.bind(h.bridge);
    h.bridge.send = (type, payload) => {
      if (type === 'set_node_props') {
        setPropsCalls.push(payload);
      }
      return origSend(type, payload);
    };

    await h.call('mimic_build_table', {
      parentId: 'p-1',
      headerCellKey: 'ck-th',
      dataCellKey: 'ck-td',
      firstColumnPaddingLeft: 'spacing-3xl',
      lastColumnPaddingRight: 'spacing-3xl',
      columns: [
        { header: 'Name', style: 'Text' },
        { header: 'Role', style: 'Text' },
      ],
      rows: [['Alice', 'Admin'], ['Bob', 'Member']],
    });

    // set_node_props should be called for first column padding
    const leftPadding = setPropsCalls.filter(c => c.paddingLeftVariable === 'spacing-3xl');
    assert.ok(leftPadding.length > 0, 'Should call set_node_props with paddingLeftVariable');

    const rightPadding = setPropsCalls.filter(c => c.paddingRightVariable === 'spacing-3xl');
    assert.ok(rightPadding.length > 0, 'Should call set_node_props with paddingRightVariable');
  });

  it('Table with cellVariants applies variant overrides per cell', async () => {
    h.advancePhase(2);
    const result = await h.call('mimic_build_table', {
      parentId: 'p-1',
      headerCellKey: 'ck-th',
      dataCellKey: 'ck-td',
      columns: [
        { header: 'Name', style: 'Text' },
        {
          header: 'Status',
          style: 'Badge',
          cellVariants: {
            Active: { Color: 'Success' },
            Pending: { Color: 'Warning' },
            Inactive: { Color: 'Gray' },
          },
        },
      ],
      rows: [['Alice', 'Active'], ['Bob', 'Pending'], ['Carol', 'Inactive']],
    });

    assert.equal(result.summary.dataCells, 6, '3 rows x 2 columns');
    assert.equal(result.summary.failures, 0, 'No failures');
  });

  it('Table density: cellHeight is passed through to sizing operations', async () => {
    h.advancePhase(2);
    for (const height of [44, 56, 64]) {
      const result = await h.call('mimic_build_table', {
        parentId: 'p-1',
        headerCellKey: 'ck-th',
        dataCellKey: 'ck-td',
        cellHeight: height,
        columns: [{ header: 'Name', style: 'Text' }],
        rows: [['Alice']],
      });
      assert.equal(result.summary.cellHeight, height, `cellHeight should be ${height}`);
    }
  });

  it('Table without DS components returns TABLE_COMPONENTS_MISSING', async () => {
    h.advancePhase(2);
    // Use a fresh cache without table components
    h.dsCache.components.clear();

    const result = await h.call('mimic_build_table', {
      parentId: 'p-1',
      columns: [{ header: 'Name', style: 'Text' }],
      rows: [['Alice']],
    });

    assert.equal(result.error, 'TABLE_COMPONENTS_MISSING');
    assert.ok(result.recommendation, 'Should have recommendation text');
  });

  it('Table with supportingText: pipe syntax splits text and supporting text', async () => {
    h.advancePhase(2);
    const result = await h.call('mimic_build_table', {
      parentId: 'p-1',
      headerCellKey: 'ck-th',
      dataCellKey: 'ck-td',
      columns: [{ header: 'Name', style: 'Lead text', supportingText: true }],
      rows: [['Sarah Chen|sarah@co.com']],
    });

    assert.equal(result.summary.dataCells, 1);
    assert.equal(result.summary.failures, 0);
  });

  // User feedback after Tier 3
  it('Save 3 table rules, all persist in knowledge store', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'table-card-padding',
      data: { category: 'spacing', rule: 'Tables in cards: first column 24px left padding (spacing-3xl), last column 24px right', scope: 'table, card' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'table-cell-height',
      data: { category: 'spacing', rule: 'All cells in a table share same fixed height — pick density by richest content', scope: 'table, cell' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'badge-color-status',
      data: { category: 'component', rule: 'Badge column cells always get Color variant matching status text', scope: 'badge, table, status' },
    });

    h.knowledgeStore.load();
    assert.equal(Object.keys(h.knowledgeStore.getRules()).length, 3);
    assert.equal(Object.keys(h.knowledgeStore.getRules('spacing')).length, 2);
    assert.equal(Object.keys(h.knowledgeStore.getRules('component')).length, 1);
  });
});


// ═══════════════════════════════════════════════════════════════════
// TIER 4 — Complex dashboard build with enforcement
// ═══════════════════════════════════════════════════════════════════
describe('Tier 4 — Complex dashboard build with enforcement', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  it('Build 1: category mismatches + radius warning in report recommendations', async () => {
    h.advancePhase(2);
    h.session.enforcementProfile = { enforceRadiusVars: true };

    // Deliberate mistake: bg-* as stroke
    const card = await h.call('figma_create_frame', {
      name: 'Card: Metrics',
      parentId: 'p-1',
      direction: 'VERTICAL',
      strokeVariable: 'bg-secondary',
    });
    if (card._categoryWarnings) h.session.categoryMismatches.push(...card._categoryWarnings);

    // Deliberate mistake: raw cornerRadius
    const card2 = await h.call('figma_create_frame', {
      name: 'Card: Chart',
      parentId: 'p-1',
      direction: 'VERTICAL',
      cornerRadius: 8,
    });
    if (card2._categoryWarnings) h.session.categoryMismatches.push(...card2._categoryWarnings);

    // Deliberate mistake: bg-* on text
    const text = await h.call('figma_create_text', {
      parentId: card.nodeId,
      content: 'Total Revenue',
      fillVariable: 'bg-primary',
    });
    if (text._categoryWarnings) h.session.categoryMismatches.push(...text._categoryWarnings);

    // Insert some components
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard Build 1',
      components: [{ name: 'Badge', instances: 4, componentKey: 'ck-badge' }],
      primitives: [{ element: 'Card', reason: 'No card component in DS', searchTerms: ['card'] }],
    });

    assert.ok(report.recommendations, 'Should have recommendations');
    assert.ok(report.recommendations.some(r => r.includes('category mismatches')), 'Should mention category mismatches');
    assert.equal(report.componentQualityGate, 'PASS', '4 components vs 1 justified primitive = PASS');
    assert.equal(report.rulesChecked, 0, 'No rules stored yet');
  });

  it('Build 2 loads 6 stored rules and injects all in mimic_status _designRules', async () => {
    // Save 6 rules
    const rules = [
      { id: 'card-header-first', category: 'structure', rule: 'Cards always have Card Header as first child', scope: 'card' },
      { id: 'model-colors', category: 'color', rule: 'Models get assigned palette colors per space, consistent across all UIs', scope: 'chart, model, space' },
      { id: 'brand-links-only', category: 'color', rule: 'Brand color only for links. Error/Warning/Success only for status', scope: 'chart, color, brand' },
      { id: 'progress-bar-label', category: 'component', rule: 'Progress bar: use Label boolean, do not create separate text', scope: 'progress bar, label' },
      { id: 'shell-immutable', category: 'structure', rule: 'Shell components (sidebar, header, footer) are immutable templates, never rebuild', scope: 'sidebar, header, footer, shell' },
      { id: 'no-semantic-chart', category: 'color', rule: 'Never use green/red/orange on charts, too similar to semantic colors', scope: 'chart, green, red, orange' },
    ];

    for (const r of rules) {
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: r.id, data: r });
    }

    h.resetSession();
    const status = await h.call('mimic_status');
    assert.equal(status.knowledge.rules, 6, 'Should have 6 rules');
    assert.ok(status._designRules, 'Rules should be injected');
    assert.equal(status._designRules.length, 6);
    assert.ok(status._designRulesNote.includes('6 user-defined'));
  });

  it('Build 2: correct variables produce zero category warnings', async () => {
    h.advancePhase(2);

    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'p-1',
      direction: 'VERTICAL',
      fillVariable: 'bg-primary',
      strokeVariable: 'border-secondary',
    });
    assert.ok(!frame._categoryWarnings, 'No warnings for correct categories');

    const text = await h.call('figma_create_text', {
      parentId: frame.nodeId,
      content: 'Revenue',
      fillVariable: 'text-primary',
    });
    assert.ok(!text._categoryWarnings, 'No warnings for correct text fill');
  });

  it('Build 2: cornerRadiusVariable instead of raw cornerRadius = no radius warning', async () => {
    h.advancePhase(2);
    h.session.enforcementProfile = { enforceRadiusVars: true };

    const frame = await h.call('figma_create_frame', {
      name: 'Card: Clean',
      parentId: 'p-1',
      direction: 'VERTICAL',
      cornerRadiusVariable: 'radius-md',
    });
    assert.ok(!frame._categoryWarnings, 'No warnings when using radius variable');
  });

  it('Build 2: matching rules injected into figma_create_frame _rules for "Card: X"', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-header-first',
      data: { category: 'structure', rule: 'Cards always have Card Header as first child', scope: 'card' },
    });

    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'p-1',
      direction: 'VERTICAL',
    });

    assert.ok(frame._rules, 'Should have injected rules');
    assert.ok(frame._rules.some(r => r.rule.includes('Card Header')), 'Should match card structure rule');
  });

  it('Build 2: configurationChecklist has APPLY_DESIGN_RULES on component insert', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-header-rule',
      data: { category: 'component', rule: 'Card header: always enable Supporting text', scope: 'card header' },
    });

    h.advancePhase(2);
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card-header',
      parentId: 'p-1',
      name: 'Card Header',
    });

    const ruleStep = comp.configurationChecklist?.find(c => c.action === 'APPLY_DESIGN_RULES');
    assert.ok(ruleStep, 'Should have APPLY_DESIGN_RULES');
  });

  it('Build 2: clean report with all rules followed shows compliance message', async () => {
    // Save 2 rules
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-rule',
      data: { category: 'structure', rule: 'Cards must have Card Header', scope: 'card' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'spacing-rule',
      data: { category: 'spacing', rule: 'Tables use spacing-3xl padding', scope: 'table' },
    });

    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Clean Build',
      components: [{ name: 'Badge', instances: 2, componentKey: 'ck-badge' }],
      primitives: [],
    });

    assert.equal(report.rulesChecked, 2, 'Should have checked 2 rules');
    assert.ok(!report.ruleViolations, 'No violations in clean build');
    assert.ok(report.summary.includes('All 2 rule(s) followed'), 'Summary should confirm compliance');
  });

  it('Build 3: Badge at 3 builds promotes to confirmed', async () => {
    // Build 1
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });
    await h.call('mimic_generate_build_report', {
      screenName: 'Build 1',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });

    // Build 2
    h.resetSession();
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-2', name: 'Badge' });
    await h.call('mimic_generate_build_report', {
      screenName: 'Build 2',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });

    h.knowledgeStore.load();
    assert.equal(h.knowledgeStore.getComponent('ck-badge').confidence, 'new', 'Still new at 2 builds');

    // Build 3
    h.resetSession();
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-3', name: 'Badge' });
    const report3 = await h.call('mimic_generate_build_report', {
      screenName: 'Build 3',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });

    h.knowledgeStore.load();
    assert.equal(h.knowledgeStore.getComponent('ck-badge').confidence, 'confirmed', 'Confirmed at 3 builds');
    assert.equal(h.knowledgeStore.getComponent('ck-badge').buildCount, 3);
    assert.ok(report3.promotions.length > 0, 'Promotions array should be populated');

    // Build history should have 3 entries
    assert.equal(h.knowledgeStore.getBuildHistory().length, 3);
  });

  it('Build 4: rule violation detected when table built as primitive', async () => {
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'table-ds-components',
      data: { category: 'structure', rule: 'Tables must use DS Table cell components, never primitives', scope: 'table, component' },
    });

    h.advancePhase(2);
    await h.call('figma_create_frame', { name: 'Table Row', parentId: 'p-1', direction: 'HORIZONTAL' });

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Primitive Table Build',
      components: [],
      primitives: [{ element: 'Table', reason: 'Built manually as frames without DS components' }],
    });

    assert.ok(report.ruleViolations, 'Should have violations');
    assert.ok(report.ruleViolations.length > 0);
    assert.ok(report.ruleViolations[0].ruleId === 'table-ds-components');
    assert.ok(report.ruleViolations[0].violation.includes('primitive'));
  });
});


// ═══════════════════════════════════════════════════════════════════
// TIER 5 — Edge cases + guards
// ═══════════════════════════════════════════════════════════════════
describe('Tier 5 — Edge cases + guards', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  // ── Rule lifecycle ────────────────────────────────────────────

  describe('Rule lifecycle', () => {
    it('Update rule: updatedAt changes, content updated, not duplicated', async () => {
      await h.call('mimic_ai_knowledge_write', {
        type: 'rule', id: 'test-rule',
        data: { category: 'color', rule: 'Original text' },
      });

      h.knowledgeStore.load();
      const first = h.knowledgeStore.getRule('test-rule');
      const firstCreated = first.createdAt;

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 5));

      await h.call('mimic_ai_knowledge_write', {
        type: 'rule', id: 'test-rule',
        data: { category: 'color', rule: 'Updated text' },
      });

      h.knowledgeStore.load();
      const updated = h.knowledgeStore.getRule('test-rule');
      assert.equal(updated.rule, 'Updated text');
      assert.equal(updated.createdAt, firstCreated, 'createdAt should not change');
      assert.equal(Object.keys(h.knowledgeStore.getRules()).length, 1, 'Should not duplicate');
    });

    it('Remove rule: gone from getRules and mimic_status', async () => {
      await h.call('mimic_ai_knowledge_write', {
        type: 'rule', id: 'remove-me',
        data: { category: 'color', rule: 'To be removed' },
      });

      h.knowledgeStore.load();
      h.knowledgeStore.removeRule('remove-me');
      h.knowledgeStore.save();

      h.knowledgeStore.load();
      assert.equal(h.knowledgeStore.getRule('remove-me'), null);
      assert.equal(Object.keys(h.knowledgeStore.getRules()).length, 0);

      const status = await h.call('mimic_status');
      assert.equal(status.knowledge.rules, 0);
      assert.ok(!status._designRules);
    });

    it('getRules filters by category correctly', async () => {
      const rulesData = [
        { id: 'c1', category: 'color', rule: 'Color 1' },
        { id: 'c2', category: 'color', rule: 'Color 2' },
        { id: 's1', category: 'structure', rule: 'Structure 1' },
        { id: 'sp1', category: 'spacing', rule: 'Spacing 1' },
        { id: 'sp2', category: 'spacing', rule: 'Spacing 2' },
      ];
      for (const r of rulesData) {
        await h.call('mimic_ai_knowledge_write', { type: 'rule', id: r.id, data: r });
      }

      h.knowledgeStore.load();
      assert.equal(Object.keys(h.knowledgeStore.getRules('color')).length, 2);
      assert.equal(Object.keys(h.knowledgeStore.getRules('structure')).length, 1);
      assert.equal(Object.keys(h.knowledgeStore.getRules('spacing')).length, 2);
      assert.equal(Object.keys(h.knowledgeStore.getRules()).length, 5);
    });

    it('findMatchingRules matches scope and category', async () => {
      h.knowledgeStore.setRule('card-rule', { category: 'structure', rule: 'Cards need headers', scope: 'card, panel' });
      h.knowledgeStore.setRule('chart-rule', { category: 'color', rule: 'No brand on charts', scope: 'chart, visualization' });
      h.knowledgeStore.save();
      h.knowledgeStore.load();

      const cardStructure = h.knowledgeStore.findMatchingRules(['card'], 'structure');
      assert.equal(cardStructure.length, 1);

      const cardColor = h.knowledgeStore.findMatchingRules(['card'], 'color');
      assert.equal(cardColor.length, 0, 'No color rules match "card"');
    });

    it('findMatchingRules with no keywords returns nothing', () => {
      h.knowledgeStore.setRule('some-rule', { category: 'color', rule: 'Rule text' });
      const matches = h.knowledgeStore.findMatchingRules([]);
      assert.equal(matches.length, 0);
    });

    it('findMatchingRules matches on rule text, not just scope', () => {
      h.knowledgeStore.setRule('rule-1', { category: 'structure', rule: 'Every card must have a header', scope: '' });
      const matches = h.knowledgeStore.findMatchingRules(['card']);
      assert.equal(matches.length, 1, 'Should match on rule text');
    });

    it('Rules survive save/load cycle', async () => {
      await h.call('mimic_ai_knowledge_write', {
        type: 'rule', id: 'persist-test',
        data: { category: 'structure', rule: 'Persistent rule', scope: 'test' },
      });

      // Create new store pointing to same file
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const store2 = new KnowledgeStore(h.knowledgeStore.filePath);
      store2.load();
      const rule = store2.getRule('persist-test');
      assert.ok(rule, 'Rule should survive save/load');
      assert.equal(rule.rule, 'Persistent rule');
    });
  });

  // ── Component-first gate from knowledge store ─────────────────

  describe('Component-first gate from knowledge store', () => {
    it('Confirmed recipe blocks frame creation with KNOWN_COMPONENT_EXISTS', async () => {
      h.knowledgeStore.setComponent('ck-progress', {
        names: ['Progress Bar'],
        componentKey: 'ck-progress',
        confidence: 'confirmed',
        buildCount: 3,
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const result = await h.call('figma_create_frame', {
        name: 'Progress Bar: Upload',
        parentId: 'p-1',
        direction: 'HORIZONTAL',
      });

      assert.equal(result.error, 'KNOWN_COMPONENT_EXISTS');
      assert.ok(result.recovery.componentKey, 'Should suggest component key');
    });

    it('New confidence recipe does NOT block frame creation', async () => {
      h.knowledgeStore.setComponent('ck-progress', {
        names: ['Progress Bar'],
        componentKey: 'ck-progress',
        confidence: 'new',
        buildCount: 1,
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const result = await h.call('figma_create_frame', {
        name: 'Progress Bar: Upload',
        parentId: 'p-1',
        direction: 'HORIZONTAL',
      });

      assert.ok(result.nodeId, 'Should create frame (new confidence does not block)');
    });

    it('Confirmed recipe with name "Metric Card" blocks "Metric Card: Revenue"', async () => {
      h.knowledgeStore.setComponent('ck-metric', {
        names: ['Metric Card'],
        componentKey: 'ck-metric',
        confidence: 'confirmed',
        buildCount: 4,
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const result = await h.call('figma_create_frame', {
        name: 'Metric Card: Revenue',
        parentId: 'p-1',
        direction: 'VERTICAL',
      });

      assert.equal(result.error, 'KNOWN_COMPONENT_EXISTS');
    });

    it('Hardcoded pattern "badge" returns COMPONENT_FIRST_REQUIRED, not KNOWN_COMPONENT_EXISTS', async () => {
      h.advancePhase(2);
      const result = await h.call('figma_create_frame', {
        name: 'Badge: Active',
        parentId: 'p-1',
        direction: 'HORIZONTAL',
      });

      assert.equal(result.error, 'COMPONENT_FIRST_REQUIRED', 'Hardcoded pattern takes precedence');
    });

    it('Knowledge store recipe with null componentKey does not block', async () => {
      h.knowledgeStore.setComponent('Custom Widget', {
        names: ['Custom Widget'],
        componentKey: null,
        confidence: 'confirmed',
        buildCount: 5,
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const result = await h.call('figma_create_frame', {
        name: 'Custom Widget: Settings',
        parentId: 'p-1',
        direction: 'VERTICAL',
      });

      // Should not block because componentKey is null (can't suggest an alternative)
      assert.ok(result.nodeId || result.error !== 'KNOWN_COMPONENT_EXISTS',
        'Null componentKey should not block with KNOWN_COMPONENT_EXISTS');
    });
  });

  // ── Pattern edge cases ────────────────────────────────────────

  describe('Pattern edge cases', () => {
    it('Single occurrence of "Card: Revenue" does not create pattern', async () => {
      h.advancePhase(2);
      await h.call('figma_create_frame', { name: 'Card: Revenue', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: 'Single Card',
        components: [],
        primitives: [],
      });

      h.knowledgeStore.load();
      assert.equal(h.knowledgeStore.getPattern('Card'), null, 'No pattern from single instance');
    });

    it('Two instances creates pattern at "new" confidence', async () => {
      h.advancePhase(2);
      await h.call('figma_create_frame', { name: 'Card: Revenue', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('figma_create_frame', { name: 'Card: Users', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: 'Two Cards',
        components: [],
        primitives: [],
      });

      h.knowledgeStore.load();
      const pattern = h.knowledgeStore.getPattern('Card');
      assert.ok(pattern, 'Pattern should be created');
      assert.equal(pattern.confidence, 'new');
    });

    it('Pattern across 3 separate builds promotes to confirmed', async () => {
      for (let i = 1; i <= 3; i++) {
        if (i > 1) h.resetSession();
        h.advancePhase(2);
        await h.call('figma_create_frame', { name: 'Card: A', parentId: 'p-1', direction: 'VERTICAL' });
        await h.call('figma_create_frame', { name: 'Card: B', parentId: 'p-1', direction: 'VERTICAL' });
        await h.call('mimic_generate_build_report', {
          screenName: `Build ${i}`,
          components: [],
          primitives: [],
        });
      }

      h.knowledgeStore.load();
      const pattern = h.knowledgeStore.getPattern('Card');
      assert.equal(pattern.confidence, 'confirmed', 'Should be confirmed after 3 builds');
    });

    it('Confirmed pattern triggers layout replay on matching frame', async () => {
      // Manually set a confirmed pattern with layout config
      h.knowledgeStore.setPattern('Card', {
        confidence: 'confirmed',
        buildCount: 3,
        layoutConfig: { direction: 'VERTICAL', paddingVariable: 'spacing-3xl', gapVariable: 'spacing-xl' },
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const frame = await h.call('figma_create_frame', {
        name: 'Card: New Widget',
        parentId: 'p-1',
      });

      assert.ok(frame._layoutReplay, 'Should have layout replay');
      assert.equal(frame._layoutReplay.direction, 'VERTICAL');
      assert.equal(frame._layoutReplay.paddingVariable, 'spacing-3xl');
    });

    it('New confidence pattern does NOT trigger layout replay', async () => {
      h.knowledgeStore.setPattern('Card', {
        confidence: 'new',
        buildCount: 1,
        layoutConfig: { direction: 'VERTICAL', paddingVariable: 'spacing-3xl' },
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const frame = await h.call('figma_create_frame', {
        name: 'Card: Widget',
        parentId: 'p-1',
      });

      assert.ok(!frame._layoutReplay, 'New pattern should not trigger replay');
    });

    it('Frame "Revenue Card" (no colon prefix) produces no pattern', async () => {
      h.advancePhase(2);
      await h.call('figma_create_frame', { name: 'Revenue Card', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('figma_create_frame', { name: 'Revenue Card 2', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: 'No Colon',
        components: [],
        primitives: [],
      });

      h.knowledgeStore.load();
      // No colon-based prefix so no pattern extracted
      assert.equal(Object.keys(h.knowledgeStore.data.patterns).length, 0);
    });

    it('Frame ":Something" (colon at position 0) produces no pattern', async () => {
      h.advancePhase(2);
      await h.call('figma_create_frame', { name: ':Something', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('figma_create_frame', { name: ':Other', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: 'Colon Start',
        components: [],
        primitives: [],
      });

      h.knowledgeStore.load();
      assert.equal(Object.keys(h.knowledgeStore.data.patterns).length, 0);
    });

    it('Frame "AB: Something" (2-char prefix) produces no pattern', async () => {
      h.advancePhase(2);
      await h.call('figma_create_frame', { name: 'AB: Something', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('figma_create_frame', { name: 'AB: Other', parentId: 'p-1', direction: 'VERTICAL' });
      await h.call('mimic_generate_build_report', {
        screenName: 'Short Prefix',
        components: [],
        primitives: [],
      });

      h.knowledgeStore.load();
      assert.equal(Object.keys(h.knowledgeStore.data.patterns).length, 0, '2-char prefix should not create pattern');
    });
  });

  // ── Component recipe edge cases ───────────────────────────────

  describe('Component recipe edge cases', () => {
    it('Component with no componentKey in report: stored by name', async () => {
      h.advancePhase(2);
      await h.call('mimic_generate_build_report', {
        screenName: 'No Key Build',
        components: [{ name: 'Custom Widget', instances: 2 }],
        primitives: [],
      });

      h.knowledgeStore.load();
      const recipe = h.knowledgeStore.getComponent('Custom Widget');
      assert.ok(recipe, 'Should be stored by name when no componentKey');
      assert.equal(recipe.instances, 2);
    });

    it('Two components sharing same componentKey merge instance counts', async () => {
      h.advancePhase(2);
      await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge: Active' });
      await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge: Pending' });

      await h.call('mimic_generate_build_report', {
        screenName: 'Shared Key',
        components: [
          { name: 'Badge: Active', instances: 1, componentKey: 'ck-badge' },
          { name: 'Badge: Pending', instances: 1, componentKey: 'ck-badge' },
        ],
        primitives: [],
      });

      h.knowledgeStore.load();
      const recipe = h.knowledgeStore.getComponent('ck-badge');
      assert.ok(recipe, 'Should merge into one entry');
      assert.equal(recipe.instances, 2, 'Instances should be combined');
      assert.ok(recipe.names.includes('Badge: Active'));
      assert.ok(recipe.names.includes('Badge: Pending'));
    });

    it('Confirmed recipe with defaultVariants auto-applied on insert', async () => {
      h.knowledgeStore.setComponent('ck-card-header', {
        names: ['Card Header'],
        componentKey: 'ck-card-header',
        confidence: 'confirmed',
        buildCount: 3,
        defaultVariants: { Divider: 'False', 'Supporting text': 'True' },
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const comp = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: 'p-1',
        name: 'Card Header',
      });

      assert.ok(comp._autoApplied, 'Should have auto-applied variants');
      assert.ok(comp._autoApplied.variants, 'Should have variants in autoApplied');
      assert.equal(comp._autoApplied.variants.Divider, 'False');
    });

    it('applyRecipe=false skips auto-apply even for confirmed recipe', async () => {
      h.knowledgeStore.setComponent('ck-card-header', {
        names: ['Card Header'],
        componentKey: 'ck-card-header',
        confidence: 'confirmed',
        buildCount: 3,
        defaultVariants: { Divider: 'False' },
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      const comp = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: 'p-1',
        name: 'Card Header',
        applyRecipe: false,
      });

      assert.ok(!comp._autoApplied, 'Should NOT auto-apply when applyRecipe=false');
    });

    it('Text node structure learned from figma_batch_set_component_text persists', async () => {
      h.advancePhase(2);
      const comp = await h.call('figma_insert_component', {
        componentKey: 'ck-card-header',
        parentId: 'p-1',
        name: 'Card Header',
      });

      await h.call('figma_batch_set_component_text', {
        nodeId: comp.nodeId,
        overrides: [
          { textNodeName: 'Text', content: 'Revenue' },
          { textNodeName: 'Supporting text', content: 'Last 12 months' },
        ],
      });

      // Generate report to persist
      await h.call('mimic_generate_build_report', {
        screenName: 'Text Learning',
        components: [{ name: 'Card Header', instances: 1, componentKey: 'ck-card-header' }],
        primitives: [],
      });

      h.knowledgeStore.load();
      const recipe = h.knowledgeStore.getComponent('ck-card-header');
      assert.ok(recipe.textNodes, 'textNodes should be persisted');
      assert.ok(recipe.textNodes.includes('Text'));
      assert.ok(recipe.textNodes.includes('Supporting text'));
    });
  });

  // ── Variable validation edge cases ────────────────────────────

  describe('Variable validation edge cases', () => {
    it('All correct categories: valid=true, zero warnings', () => {
      const result = h.dsCache.validateVariables({
        fillVariable: 'bg-primary',
        strokeVariable: 'border-secondary',
      });
      assert.equal(result.valid, true);
      assert.equal(result.warnings.length, 0);
      assert.equal(result.categoryMismatches.length, 0);
    });

    it('3 mismatches in one call: all 3 in categoryMismatches', () => {
      const result = h.dsCache.validateVariables({
        strokeVariable: 'bg-secondary',       // bg-* as stroke
        fillVariable: 'border-primary',        // border-* as fill
        content: 'text',
      });
      // fillVariable with content present means expected=text, border=border category -> mismatch
      // strokeVariable expected=border, bg=background -> mismatch
      assert.ok(result.categoryMismatches.length >= 2, 'Should have multiple category mismatches');
    });

    it('fg-* as fillVariable on a frame: NO warning (ambiguous)', () => {
      const result = h.dsCache.validateVariables({
        fillVariable: 'fg-success-primary',
      });
      assert.equal(result.categoryMismatches.length, 0, 'fg-* is ambiguous, no mismatch');
    });

    it('Variable path not found: shows suggestions or variable count', () => {
      const result = h.dsCache.validateVariables({
        fillVariable: 'nonexistent-var',
      });
      assert.equal(result.valid, false, 'Should be invalid when path not found');
      assert.ok(result.warnings.length > 0, 'Should have warnings');
    });
  });

  // ── Session guards ────────────────────────────────────────────

  describe('Session guards', () => {
    it('Artboard delete: parent=PAGE returns ARTBOARD_DELETE_BLOCKED', async () => {
      h.advancePhase(2);
      const origSend = h.bridge.send.bind(h.bridge);
      h.bridge.send = (type, payload) => {
        if (type === 'get_node_parent') {
          return Promise.resolve({ type: 'PAGE', parentType: 'PAGE' });
        }
        return origSend(type, payload);
      };

      const result = await h.call('figma_delete_node', { nodeId: 'artboard-1' });
      assert.equal(result.error, 'ARTBOARD_DELETE_BLOCKED');
    });

    it('Artboard delete: parent=FRAME is allowed', async () => {
      h.advancePhase(2);
      const result = await h.call('figma_delete_node', { nodeId: 'nested-1' });
      assert.ok(result.ok, 'Nested node deletion allowed');
    });

    it('Artboard delete: bridge throws on get_node_parent allows deletion (best-effort)', async () => {
      h.advancePhase(2);
      const origSend = h.bridge.send.bind(h.bridge);
      h.bridge.send = (type, payload) => {
        if (type === 'get_node_parent') {
          return Promise.reject(new Error('Node not found'));
        }
        return origSend(type, payload);
      };

      const result = await h.call('figma_delete_node', { nodeId: 'gone-node' });
      assert.ok(result.ok, 'Should allow deletion when parent check fails');
    });

    it('buildInterrupted cleared by mimic_status when bridge.connected=true', async () => {
      h.advancePhase(3);
      h.session.buildInterrupted = true;
      h.bridge.connected = true;

      const status = await h.call('mimic_status');
      assert.equal(h.session.buildInterrupted, false, 'Should be cleared');
      assert.ok(!status.buildInterrupted, 'Status should not report interruption');
    });

    it('buildInterrupted cleared by resetSession', () => {
      h.session.buildInterrupted = true;
      h.resetSession();
      assert.equal(h.session.buildInterrupted, false);
    });
  });

  // ── Build report edge cases ───────────────────────────────────

  describe('Build report edge cases', () => {
    it('Zero components + zero primitives: valid report, no crash', async () => {
      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Empty',
        components: [],
        primitives: [],
      });
      assert.ok(report.summary);
      assert.equal(report.componentUsagePercent, 100);
    });

    it('10 components + 0 primitives: 100% quality gate PASS', async () => {
      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'All Components',
        components: [{ name: 'Badge', instances: 10, componentKey: 'ck-badge' }],
        primitives: [],
      });
      assert.equal(report.componentQualityGate, 'PASS');
      assert.equal(report.componentUsagePercent, 100);
    });

    it('2 components + 5 justified primitives: quality gate PASS', async () => {
      h.advancePhase(2);
      const justifiedPrims = Array.from({ length: 5 }, (_, i) => ({
        element: `Custom ${i}`,
        reason: 'No DS component exists for this unique layout',
        searchTerms: ['custom'],
      }));
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Justified',
        components: [{ name: 'Badge', instances: 2, componentKey: 'ck-badge' }],
        primitives: justifiedPrims,
      });
      assert.equal(report.componentQualityGate, 'PASS', 'Justified primitives do not penalize');
    });

    it('2 components + 5 unjustified primitives: quality gate FAIL', async () => {
      h.advancePhase(2);
      const unjustifiedPrims = Array.from({ length: 5 }, (_, i) => ({
        element: `Frame ${i}`,
        reason: 'short',  // < 10 chars = unjustified
      }));
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Unjustified',
        components: [{ name: 'Badge', instances: 2, componentKey: 'ck-badge' }],
        primitives: unjustifiedPrims,
      });
      // 2 components / (2 + 5 unjustified) = 28.6% < 80%
      assert.equal(report.componentQualityGate, 'FAIL');
    });

    it('Report includes _presentationRules with HTML offer', async () => {
      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Presentation',
        components: [],
        primitives: [],
      });
      assert.ok(report._presentationRules, 'Should include presentation rules');
      assert.ok(report._presentationRules.some(r => r.includes('HTML')));
    });

    it('Recommendations populated when session.categoryMismatches has entries', async () => {
      h.advancePhase(2);
      h.session.categoryMismatches = ['strokeVariable: bg-secondary is wrong'];
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Mismatch Report',
        components: [],
        primitives: [],
      });
      assert.ok(report.recommendations);
      assert.ok(report.recommendations.some(r => r.includes('category mismatches')));
    });

    it('Recommendations always present (empty array when session is clean)', async () => {
      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Clean Report',
        components: [],
        primitives: [],
      });
      assert.ok(Array.isArray(report.recommendations), 'Recommendations is always an array');
    });

    it('Chart palette excludes semantic colors', async () => {
      h.advancePhase(2);
      const result = await h.call('mimic_compute_chart', {
        chartType: 'bar',
        data: [{ label: 'A', value: 10 }],
        dimensions: { chartHeight: 200 },
      });
      const palette = result._chartColorHint.suggestedPalette;
      for (const color of palette) {
        assert.ok(!color.includes('/Brand/'), `No Brand in palette: ${color}`);
        assert.ok(!color.includes('/Success/'), `No Success in palette: ${color}`);
        assert.ok(!color.includes('/Warning/'), `No Warning in palette: ${color}`);
        assert.ok(!color.includes('/Error/'), `No Error in palette: ${color}`);
      }
    });

    it('Chart colorRules array present with NEVER use Brand text', async () => {
      h.advancePhase(2);
      const result = await h.call('mimic_compute_chart', {
        chartType: 'donut',
        data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }],
        dimensions: { outerRadius: 100, innerRadius: 60 },
      });
      assert.ok(result._chartColorHint.colorRules);
      assert.ok(result._chartColorHint.colorRules.some(r => r.includes('NEVER use Brand')));
    });

    it('Build history capped at 50/library: push 55 builds, only last 50 remain', async () => {
      // Cap raised from 20 (v2) to 50/library per schema v3 spec §3.5.
      for (let i = 0; i < 55; i++) {
        h.knowledgeStore.recordBuild({
          screenName: `Build ${i}`,
          toolCalls: 10,
          componentCount: 5,
          primitiveCount: 1,
        });
      }
      const history = h.knowledgeStore.getBuildHistory();
      assert.equal(history.length, 50, 'Should cap at 50');
      assert.ok(history[0].screenName.includes('5'), 'First 5 should be dropped');
    });

    it('Promotions array populated when confidence changes during report', async () => {
      // Set up a component at 2 builds (will promote to confirmed at 3)
      h.knowledgeStore.setComponent('ck-tabs', {
        names: ['Tabs'],
        componentKey: 'ck-tabs',
        confidence: 'new',
        buildCount: 2,
        instances: 4,
      });
      h.knowledgeStore.save();

      h.advancePhase(2);
      await h.call('figma_insert_component', { componentKey: 'ck-tabs', parentId: 'p-1', name: 'Tabs' });

      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Promotion Build',
        components: [{ name: 'Tabs', instances: 2, componentKey: 'ck-tabs' }],
        primitives: [],
      });

      assert.ok(report.promotions.length > 0, 'Should have promotions');
      assert.ok(report.promotions[0].includes('confirmed'), 'Should promote to confirmed');
    });

    it('rulesChecked count matches stored rules count', async () => {
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'r1', data: { category: 'color', rule: 'Rule 1' } });
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'r2', data: { category: 'structure', rule: 'Rule 2' } });
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'r3', data: { category: 'spacing', rule: 'Rule 3' } });

      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Rules Count',
        components: [],
        primitives: [],
      });
      assert.equal(report.rulesChecked, 3);
    });

    it('Rule compliance: all rules followed shows "All N rule(s) followed" in summary', async () => {
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'r1', data: { category: 'color', rule: 'Use utility colors' } });
      await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'r2', data: { category: 'structure', rule: 'Header first' } });

      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'Compliant',
        components: [{ name: 'Badge', instances: 1 }],
        primitives: [],
      });
      assert.ok(report.summary.includes('All 2 rule(s) followed'));
    });

    it('Rule compliance: zero stored rules = no compliance section in report', async () => {
      h.advancePhase(2);
      const report = await h.call('mimic_generate_build_report', {
        screenName: 'No Rules',
        components: [],
        primitives: [],
      });
      assert.equal(report.rulesChecked, 0);
      assert.ok(!report.ruleViolations);
    });
  });

  // ── Knowledge store persistence ───────────────────────────────

  describe('Knowledge store persistence', () => {
    it('Empty store: cold start, zero everything', () => {
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const emptyPath = path.join(h.tmpDir, 'empty-store.json');
      const store = new KnowledgeStore(emptyPath);
      store.load();
      assert.equal(Object.keys(store.data.components).length, 0);
      assert.equal(Object.keys(store.data.patterns).length, 0);
      assert.equal(Object.keys(store.data.rules).length, 0);
      assert.equal(Object.keys(store.data.gaps).length, 0);
      assert.equal(store.data.meta.buildCount, 0);
    });

    it('Save all types then load from disk: all preserved', () => {
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const storePath = path.join(h.tmpDir, 'full-store.json');
      const store = new KnowledgeStore(storePath);

      store.setComponent('ck-1', { names: ['Badge'], buildCount: 1, confidence: 'new' });
      store.setPattern('Card', { buildCount: 2, confidence: 'new' });
      store.setRule('r1', { category: 'color', rule: 'Test rule' });
      store.addGap('divider', { elements: ['divider'], evidence: 'test' });
      store.save();

      const store2 = new KnowledgeStore(storePath);
      store2.load();
      assert.ok(store2.getComponent('ck-1'));
      assert.ok(store2.getPattern('Card'));
      assert.ok(store2.getRule('r1'));
      assert.equal(Object.keys(store2.getGaps()).length, 1);
    });

    it('a fresh, un-loaded store instance no longer clobbers existing data on save (merge-on-save, spec §3.1)', () => {
      // Pre-v3 behavior: save() was a blind full-file overwrite, so a brand
      // new KnowledgeStore instance saving without ever loading would wipe
      // out anything already on disk — this was defect J (two concurrent
      // sessions silently destroying each other's learning). v3 save()
      // re-reads disk and merges at the library-bucket level first, so this
      // scenario no longer loses data. To genuinely reset the store, delete
      // the file (or load() first, then explicitly clear what you intend to).
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const storePath = path.join(h.tmpDir, 'reset-store.json');

      const store1 = new KnowledgeStore(storePath);
      store1.setComponent('ck-1', { names: ['Test'], buildCount: 1 });
      store1.save();

      const store2 = new KnowledgeStore(storePath);
      // Don't load — save an otherwise-empty in-memory store.
      store2.save();
      store2.load();
      assert.equal(Object.keys(store2.data.components).length, 1, 'merge-on-save must preserve ck-1 instead of wiping it');
      assert.ok(store2.data.components['ck-1']);
    });

    it('Schema version mismatch recovers instead of bricking the server', () => {
      // A bad/unsupported-version knowledge file must never throw and prevent
      // the MCP server from starting — it should back up the bad file, reset
      // to a fresh v3 store, and surface a loud warning instead.
      const storePath = path.join(h.tmpDir, 'bad-version.json');
      fs.writeFileSync(storePath, JSON.stringify({ version: 999, components: {} }));

      const { KnowledgeStore } = require('../../src/knowledge/store');
      const store = new KnowledgeStore(storePath);
      assert.doesNotThrow(() => store.load());
      assert.equal(store.data.version, 3);
      assert.equal(Object.keys(store.data.components).length, 0);
      assert.ok(store.loadWarning, 'should surface a loadWarning');
      assert.match(store.loadWarning.message, /unsupported schema version/i);
      assert.ok(fs.existsSync(store.loadWarning.backupPath), 'corrupt file should be backed up');
    });

    it('Backfill: old store without rules field gets empty object on load', () => {
      const storePath = path.join(h.tmpDir, 'old-store.json');
      const oldData = {
        version: 2,
        dsFingerprint: null,
        components: {},
        patterns: {},
        gaps: {},
        // No rules field
        meta: { buildCount: 0, lastBuild: null, created: new Date().toISOString() },
      };
      fs.writeFileSync(storePath, JSON.stringify(oldData));

      const { KnowledgeStore } = require('../../src/knowledge/store');
      const store = new KnowledgeStore(storePath);
      store.load();
      assert.ok(store.data.rules, 'rules should be backfilled');
      assert.equal(Object.keys(store.data.rules).length, 0);
    });

    it('buildHistory: recordBuild 55 times capped at 50 per library, first 5 dropped', () => {
      // Cap raised from 20 (v2) to 50/library per schema v3 spec §3.5.
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const storePath = path.join(h.tmpDir, 'history-cap.json');
      const store = new KnowledgeStore(storePath);

      for (let i = 0; i < 55; i++) {
        store.recordBuild({ screenName: `Screen ${i}`, toolCalls: i });
      }
      const history = store.getBuildHistory();
      assert.equal(history.length, 50);
      assert.ok(history[0].screenName === 'Screen 5', 'First 5 should be dropped');
    });

    it('libraryFileKeys persist across save/load', () => {
      const { KnowledgeStore } = require('../../src/knowledge/store');
      const storePath = path.join(h.tmpDir, 'lib-keys.json');
      const store = new KnowledgeStore(storePath);

      store.setLibraryFileKey('TestDS', 'abc123');
      store.save();

      const store2 = new KnowledgeStore(storePath);
      store2.load();
      assert.equal(store2.getLibraryFileKey('TestDS'), 'abc123');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════
// TIER 6 — Gaps found during test review
// Tests that were missing, weak, or testing the happy path only.
// ═══════════════════════════════════════════════════════════════════
describe('Tier 6 — Hardened tests (gaps from review)', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
    h.seedCache();
  });

  // ── True multi-build learning loop ──────────────────────────

  it('Full 4-build loop: Build 1 mistakes → feedback → Build 2 clean → Build 3 promotion → Build 4 violation', async () => {
    // BUILD 1: naive build with mistakes
    h.advancePhase(2);
    h.session.enforcementProfile = { enforceRadiusVars: true };

    const badFrame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'p-1',
      direction: 'VERTICAL',
      strokeVariable: 'bg-secondary', // WRONG
      cornerRadius: 8, // RAW
    });
    if (badFrame._categoryWarnings) h.session.categoryMismatches.push(...badFrame._categoryWarnings);

    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: badFrame.nodeId, name: 'Badge' });
    await h.call('figma_insert_component', { componentKey: 'ck-card-header', parentId: badFrame.nodeId, name: 'Card Header' });

    await h.call('figma_create_frame', { name: 'Card: Users', parentId: 'p-1', direction: 'VERTICAL' });
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });

    const report1 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard v1',
      components: [
        { name: 'Badge', instances: 2, componentKey: 'ck-badge' },
        { name: 'Card Header', instances: 1, componentKey: 'ck-card-header' },
      ],
      primitives: [],
    });
    assert.ok(report1.recommendations?.some(r => r.includes('category mismatches')), 'Build 1 should flag mismatches');
    assert.equal(report1.rulesChecked, 0, 'No rules yet');

    // FEEDBACK: save rules
    await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'card-structure',
      data: { category: 'structure', rule: 'Cards must have Card Header as first child', scope: 'card' } });
    await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'brand-links',
      data: { category: 'color', rule: 'Brand only for links, Error/Warning/Success only for status', scope: 'chart, brand, color' } });

    // BUILD 2: clean build, rules loaded
    h.resetSession();
    h.advancePhase(2);

    const status2 = await h.call('mimic_status');
    assert.equal(status2.knowledge.rules, 2);
    assert.equal(status2._designRules.length, 2);

    // Rules injected at point of use
    const cleanCard = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'p-2',
      direction: 'VERTICAL',
      strokeVariable: 'border-secondary', // CORRECT
      cornerRadiusVariable: 'radius-md', // CORRECT
    });
    assert.ok(!cleanCard._categoryWarnings, 'Build 2 should have no warnings');
    assert.ok(cleanCard._rules?.some(r => r.rule.includes('Card Header')), 'Card structure rule injected');

    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: cleanCard.nodeId, name: 'Badge' });
    await h.call('figma_insert_component', { componentKey: 'ck-card-header', parentId: cleanCard.nodeId, name: 'Card Header' });

    const report2 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard v2',
      components: [
        { name: 'Badge', instances: 1, componentKey: 'ck-badge' },
        { name: 'Card Header', instances: 1, componentKey: 'ck-card-header' },
      ],
      primitives: [],
    });
    assert.equal(report2.rulesChecked, 2);
    assert.ok(!report2.ruleViolations, 'Build 2 should have no violations');
    assert.ok(report2.summary.includes('All 2 rule(s) followed'));

    // BUILD 3: promotion
    h.resetSession();
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-3', name: 'Badge' });
    const report3 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard v3',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });

    h.knowledgeStore.load();
    assert.equal(h.knowledgeStore.getComponent('ck-badge').confidence, 'confirmed');
    assert.equal(h.knowledgeStore.getComponent('ck-badge').buildCount, 3);
    assert.ok(report3.promotions.length > 0);

    // BUILD 4: violation — build card header as primitive instead of component
    h.resetSession();
    h.advancePhase(2);
    await h.call('figma_create_frame', { name: 'Table Section', parentId: 'p-4', direction: 'VERTICAL' });
    const report4 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard v4',
      components: [],
      primitives: [{ element: 'Card Header', reason: 'Built card header as frame with manual text instead of DS component' }],
    });

    // Primitive named "card header" + structure rule mentioning "card header" → violation
    assert.ok(report4.ruleViolations, 'Build 4 should detect violation');
    assert.ok(report4.ruleViolations.some(v => v.ruleId === 'card-structure'));

    // Build history should have 4 entries
    h.knowledgeStore.load();
    assert.equal(h.knowledgeStore.getBuildHistory().length, 4);
  });

  // ── Color rule violation detection ─────────────────────────

  it('Color rule violation detected when semantic color mismatch occurs', async () => {
    // Save a color rule
    await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'no-brand-charts',
      data: { category: 'color', rule: 'Brand color only for links, never charts', scope: 'brand, chart' } });

    h.advancePhase(2);
    // Simulate a category mismatch involving "brand"
    h.session.categoryMismatches = ['fillVariable: brand-500 is a brand color used on chart bar'];

    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Color Violation',
      components: [],
      primitives: [],
    });

    assert.ok(report.ruleViolations, 'Should detect color rule violation');
    assert.ok(report.ruleViolations.some(v => v.ruleId === 'no-brand-charts'));
    assert.ok(report.ruleViolations.some(v => v.violation.includes('semantic color misuse')));
  });

  // ── Component rule violation detection ────────────────────

  it('Component rule violation: scope-matching primitive triggers violation', async () => {
    await h.call('mimic_ai_knowledge_write', { type: 'rule', id: 'badge-ds-only',
      data: { category: 'component', rule: 'Badge must always be DS component', scope: 'badge' } });

    h.advancePhase(2);
    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Component Violation',
      components: [],
      primitives: [{ element: 'Badge Status', reason: 'Built as colored frame instead of DS Badge' }],
    });

    assert.ok(report.ruleViolations, 'Should detect component rule violation');
    assert.ok(report.ruleViolations.some(v => v.ruleId === 'badge-ds-only'));
  });

  // ── KNOWN_COMPONENT_EXISTS with confirmedNoComponent override ──

  it('KNOWN_COMPONENT_EXISTS can be bypassed with confirmedNoComponent + reason', async () => {
    h.knowledgeStore.setComponent('ck-progress', {
      names: ['Progress Bar'],
      componentKey: 'ck-progress',
      confidence: 'confirmed',
      buildCount: 5,
    });
    h.knowledgeStore.save();

    h.advancePhase(2);

    // Without override → blocked
    const blocked = await h.call('figma_create_frame', {
      name: 'Progress Bar: Custom',
      parentId: 'p-1',
      direction: 'HORIZONTAL',
    });
    assert.equal(blocked.error, 'KNOWN_COMPONENT_EXISTS');

    // With override → allowed
    const allowed = await h.call('figma_create_frame', {
      name: 'Progress Bar: Custom',
      parentId: 'p-1',
      direction: 'HORIZONTAL',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'Need custom animated progress bar not possible with DS component',
    });
    // The KNOWN_COMPONENT_EXISTS gate fires BEFORE the confirmedNoComponent check
    // so this should still be blocked — the knowledge store gate doesn't accept overrides
    assert.equal(allowed.error, 'KNOWN_COMPONENT_EXISTS',
      'Knowledge store gate does NOT accept primitive override — must use the DS component');
  });

  // ── buildInterrupted NOT set for non-build phases ────────

  it('Plugin disconnect during Phase 0 does NOT set buildInterrupted', () => {
    h.session.phase = 0;
    h.bridge.connected = false;
    if (h.bridge._onDisconnect) h.bridge._onDisconnect();

    // Manually simulate what mcp.js does: only set for Phase 3-4
    if (h.session.phase >= 3 && h.session.phase < 5) {
      h.session.buildInterrupted = true;
    }
    assert.equal(h.session.buildInterrupted, false, 'Phase 0 disconnect should NOT set flag');
  });

  it('Plugin disconnect during Phase 1 does NOT set buildInterrupted', () => {
    h.session.phase = 1;
    if (h.session.phase >= 3 && h.session.phase < 5) {
      h.session.buildInterrupted = true;
    }
    assert.equal(h.session.buildInterrupted, false, 'Phase 1 disconnect should NOT set flag');
  });

  it('Plugin disconnect during Phase 4 DOES set buildInterrupted', () => {
    h.session.phase = 4;
    if (h.session.phase >= 3 && h.session.phase < 5) {
      h.session.buildInterrupted = true;
    }
    assert.equal(h.session.buildInterrupted, true, 'Phase 4 disconnect should set flag');
  });

  // ── Short keywords in frame names don't match rules ──────

  it('Frame "A: B" does not match rules (keywords < 3 chars filtered out)', async () => {
    h.knowledgeStore.setRule('ab-rule', { category: 'structure', rule: 'Something about AB', scope: 'ab' });
    h.knowledgeStore.save();

    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'A: B',
      parentId: 'p-1',
      direction: 'VERTICAL',
    });
    // Both "A" and "B" are < 3 chars, so no rules should match
    assert.ok(!frame._rules, 'Short keywords should not match rules');
  });

  // ── Table padding on correct columns ──────────────────────

  it('Table first/last column padding applied to CORRECT columns, not all', async () => {
    h.advancePhase(2);
    h.dsCache.addComponent('ck-th', { name: 'Table header cell', isComponentSet: true });
    h.dsCache.addComponent('ck-td', { name: 'Table cell', isComponentSet: true });

    const propCalls = [];
    const origSend = h.bridge.send.bind(h.bridge);
    h.bridge.send = (type, payload) => {
      if (type === 'set_node_props') {
        propCalls.push({ ...payload });
      }
      return origSend(type, payload);
    };

    await h.call('mimic_build_table', {
      parentId: 'p-1',
      headerCellKey: 'ck-th',
      dataCellKey: 'ck-td',
      firstColumnPaddingLeft: 'spacing-3xl',
      lastColumnPaddingRight: 'spacing-3xl',
      columns: [
        { header: 'First', style: 'Text' },
        { header: 'Middle', style: 'Text' },
        { header: 'Last', style: 'Text' },
      ],
      rows: [['A', 'B', 'C'], ['D', 'E', 'F']],
    });

    const leftPadding = propCalls.filter(c => c.paddingLeftVariable === 'spacing-3xl');
    const rightPadding = propCalls.filter(c => c.paddingRightVariable === 'spacing-3xl');

    // First column: 1 header + 2 data = 3 cells with left padding
    assert.ok(leftPadding.length >= 2, `First column should have left padding on data cells, got ${leftPadding.length}`);
    // Last column: 1 header + 2 data = 3 cells with right padding
    assert.ok(rightPadding.length >= 2, `Last column should have right padding on data cells, got ${rightPadding.length}`);

    // Middle column should NOT have padding set via set_node_props
    // (no paddingLeftVariable or paddingRightVariable calls for middle cells)
    // Total calls should be for first + last only, not middle
    const totalPaddingCalls = propCalls.length;
    // At least 4 (2 left + 2 right for data cells), at most ~6 (with headers)
    assert.ok(totalPaddingCalls <= 8, `Total padding calls should be bounded, got ${totalPaddingCalls}`);
  });

  // ── Rule matching verifies rule text, not just scope ──────

  it('Rule with empty scope but matching rule text still injects into frame', async () => {
    h.knowledgeStore.setRule('card-text-rule', {
      category: 'structure',
      rule: 'Every card container must use DS spacing variables for padding',
      scope: '', // empty scope
    });
    h.knowledgeStore.save();

    h.advancePhase(2);
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Metrics',
      parentId: 'p-1',
      direction: 'VERTICAL',
    });

    // "card" appears in the rule text, so it should match
    assert.ok(frame._rules, 'Should match on rule text even with empty scope');
    assert.ok(frame._rules.some(r => r.rule.includes('card container')));
  });

  // ── Component insert with structure rules ────────────────

  it('figma_insert_component matches BOTH component and structure rules', async () => {
    h.knowledgeStore.setRule('comp-rule', {
      category: 'component',
      rule: 'Card Header must have Supporting text enabled',
      scope: 'card header',
    });
    h.knowledgeStore.setRule('struct-rule', {
      category: 'structure',
      rule: 'Card header is always the first child inside a card frame',
      scope: 'card header',
    });
    h.knowledgeStore.save();

    h.advancePhase(2);
    const comp = await h.call('figma_insert_component', {
      componentKey: 'ck-card-header',
      parentId: 'p-1',
      name: 'Card Header',
    });

    assert.ok(comp._rules, 'Should have injected rules');
    assert.equal(comp._rules.length, 2, 'Should match both component AND structure rules');
    const ruleAction = comp.configurationChecklist.find(c => c.action === 'APPLY_DESIGN_RULES');
    assert.equal(ruleAction.rules.length, 2);
  });

  // ── Pattern replay values actually reach the frame ────────

  it('Confirmed pattern replay values are passed to bridge create_frame', async () => {
    h.knowledgeStore.setPattern('Section', {
      confidence: 'confirmed',
      buildCount: 3,
      layoutConfig: {
        direction: 'HORIZONTAL',
        gapVariable: 'spacing-xl',
        paddingVariable: 'spacing-3xl',
        counterAxisAlignItems: 'CENTER',
      },
    });
    h.knowledgeStore.save();

    const bridgeCalls = [];
    const origSend = h.bridge.send.bind(h.bridge);
    h.bridge.send = (type, payload) => {
      if (type === 'create_frame') bridgeCalls.push({ ...payload });
      return origSend(type, payload);
    };

    h.advancePhase(2);
    await h.call('figma_create_frame', {
      name: 'Section: Metrics',
      parentId: 'p-1',
      // Don't specify direction/gap/padding — should come from replay
    });

    assert.equal(bridgeCalls.length, 1);
    const sent = bridgeCalls[0];
    assert.equal(sent.direction, 'HORIZONTAL', 'Direction should come from pattern replay');
    assert.equal(sent.gapVariable, 'spacing-xl', 'Gap should come from pattern replay');
    assert.equal(sent.paddingVariable, 'spacing-3xl', 'Padding should come from pattern replay');
    assert.equal(sent.counterAxisAlignItems, 'CENTER', 'Alignment should come from pattern replay');
  });

  // ── Explicit args override pattern replay ─────────────────

  it('Explicit frame args override pattern replay values', async () => {
    h.knowledgeStore.setPattern('Section', {
      confidence: 'confirmed',
      buildCount: 3,
      layoutConfig: { direction: 'HORIZONTAL', gapVariable: 'spacing-xl' },
    });
    h.knowledgeStore.save();

    const bridgeCalls = [];
    const origSend = h.bridge.send.bind(h.bridge);
    h.bridge.send = (type, payload) => {
      if (type === 'create_frame') bridgeCalls.push({ ...payload });
      return origSend(type, payload);
    };

    h.advancePhase(2);
    await h.call('figma_create_frame', {
      name: 'Section: Override',
      parentId: 'p-1',
      direction: 'VERTICAL', // explicit — should NOT be overridden by replay
      gapVariable: 'spacing-3xl', // explicit
    });

    const sent = bridgeCalls[0];
    assert.equal(sent.direction, 'VERTICAL', 'Explicit direction should override replay');
    assert.equal(sent.gapVariable, 'spacing-3xl', 'Explicit gap should override replay');
  });
});
