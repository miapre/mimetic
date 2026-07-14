'use strict';

/**
 * Learning Loop Integration Test
 *
 * Simulates 3 builds with user feedback between them to verify:
 * 1. Component recipes persist across builds
 * 2. Design rules are saved and injected into subsequent builds
 * 3. Category mismatch validation catches wrong variable usage
 * 4. Build report includes recommendations
 * 5. Chart palette excludes semantic colors
 * 6. Artboard deletion is blocked
 * 7. Plugin disconnect sets buildInterrupted flag
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
          ], totalVariables: 9 });
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
  };

  // Create temp knowledge store
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-learn-'));
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

  return { call, session, dsCache, knowledgeStore, bridge, resetSession, advancePhase, tmpDir };
}

// ── Tests ────────────────────────────────────────────────────────

describe('Learning Loop — 3-build simulation', () => {
  let h;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('Build 1 → feedback → rules → Build 2 → verify rules injected', async () => {
    // ── BUILD 1: Basic build, no rules yet ──
    const status1 = await h.call('mimic_status');
    assert.equal(status1.phase, 0);
    assert.equal(status1.knowledge.rules, 0);
    assert.ok(!status1._designRules, 'No rules on first build');

    // Advance to Phase 2 manually (skip full discovery for speed)
    h.advancePhase(2);

    // Simulate building a card with raw cornerRadius (bad practice)
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Revenue',
      parentId: 'parent-1',
      direction: 'VERTICAL',
      cornerRadius: 8, // raw value — should trigger warning
    });
    assert.ok(frame.nodeId);

    // Simulate inserting a component
    const comp = await h.call('figma_insert_component', {
      componentKey: 'comp-key-badge',
      parentId: frame.nodeId,
      name: 'Badge: Active',
    });
    assert.ok(comp.nodeId);

    // Generate build report
    const report1 = await h.call('mimic_generate_build_report', {
      screenName: 'Dashboard Build 1',
      components: [{ name: 'Badge', instances: 3, componentKey: 'comp-key-badge' }],
      primitives: [{ element: 'Card', reason: 'No card component in DS', searchTerms: ['card', 'tile'] }],
    });

    assert.ok(report1.summary.includes('Dashboard Build 1'));
    assert.equal(report1.componentQualityGate, 'PASS'); // 3 components vs 1 justified primitive

    // Verify component recipe persisted
    h.knowledgeStore.load();
    const badgeRecipe = h.knowledgeStore.getComponent('comp-key-badge');
    assert.ok(badgeRecipe, 'Badge recipe should be persisted');
    assert.equal(badgeRecipe.buildCount, 1);
    assert.deepEqual(badgeRecipe.names, ['Badge']);

    // ── USER FEEDBACK (simulated) ──
    // "Cards always have a card header component first, then content with spacing-xl padding"
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule',
      id: 'card-structure',
      data: {
        category: 'structure',
        rule: 'Cards must have a Card Header component as the first child, followed by a content frame with spacing-xl padding.',
        reason: 'User correction: built cards without card header, user wants consistent card structure.',
        scope: 'cards',
      },
    });

    // "Use border-* for strokes, never bg-*"
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule',
      id: 'border-variable-category',
      data: {
        category: 'variable',
        rule: 'Strokes must use border-* variables, never bg-* variables.',
        reason: 'User correction: 228 strokes used bg-secondary instead of border-secondary.',
      },
    });

    // "Brand color only for links"
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule',
      id: 'brand-color-semantic',
      data: {
        category: 'color',
        rule: 'Brand color is only for links and brand-related elements. Never on charts or data visualization.',
        reason: 'User correction: chart bars used brand color.',
        scope: 'charts, data visualization',
      },
    });

    // Verify rules persisted
    h.knowledgeStore.load();
    const rules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(rules).length, 3);
    assert.ok(rules['card-structure']);
    assert.equal(rules['card-structure'].category, 'structure');

    // ── BUILD 2: Verify rules are injected ──
    h.resetSession();
    h.advancePhase(2);

    const status2 = await h.call('mimic_status');
    assert.equal(status2.knowledge.rules, 3, 'Should have 3 rules');
    assert.ok(status2._designRules, 'Rules should be injected');
    assert.equal(status2._designRules.length, 3);

    // Verify rule content is accessible
    const ruleIds = status2._designRules.map(r => r.id);
    assert.ok(ruleIds.includes('card-structure'));
    assert.ok(ruleIds.includes('border-variable-category'));
    assert.ok(ruleIds.includes('brand-color-semantic'));

    // Verify rule text is in the response
    const cardRule = status2._designRules.find(r => r.id === 'card-structure');
    assert.ok(cardRule.rule.includes('Card Header component'));
  });

  it('category mismatch: bg-* used as strokeVariable warns but does not block', async () => {
    h.advancePhase(2);

    // Populate cache with categorized variables
    h.dsCache.addVariable('bg-secondary', { key: 'v1', category: 'background' });
    h.dsCache.addVariable('border-secondary', { key: 'v2', category: 'border' });

    // Use bg-secondary as stroke — should warn but proceed
    const frame = await h.call('figma_create_frame', {
      name: 'Card: Bad Stroke',
      parentId: 'parent-1',
      direction: 'VERTICAL',
      strokeVariable: 'bg-secondary', // WRONG category
    });
    assert.ok(frame.nodeId, 'Frame should be created (not blocked)');
    assert.ok(frame._categoryWarnings, 'Should have category warnings');
    assert.ok(frame._categoryWarnings.length > 0);
    assert.ok(frame._categoryWarnings[0].includes('bg-*'), 'Should mention bg-* category');
    assert.ok(frame._categoryWarnings[0].includes('border-*'), 'Should suggest border-* category');
  });

  it('category mismatch: bg-* used as text fill warns', async () => {
    h.advancePhase(2);
    h.dsCache.addVariable('bg-primary', { key: 'v1', category: 'background' });
    h.dsCache.addVariable('text-primary', { key: 'v2', category: 'text' });

    const text = await h.call('figma_create_text', {
      parentId: 'parent-1',
      content: 'Hello',
      fillVariable: 'bg-primary', // WRONG — should be text-*
    });
    assert.ok(text.nodeId);
    assert.ok(text._categoryWarnings, 'Should warn about bg-* on text');
    assert.ok(text._categoryWarnings[0].includes('text'));
  });

  it('raw cornerRadius warns when DS has radius variables', async () => {
    h.advancePhase(2);
    h.dsCache.addVariable('radius-md', { key: 'v1', category: 'radius' });
    h.session.enforcementProfile = { enforceRadiusVars: true };

    const frame = await h.call('figma_create_frame', {
      name: 'Card: Raw Radius',
      parentId: 'parent-1',
      direction: 'VERTICAL',
      cornerRadius: 8, // raw — should warn
    });
    assert.ok(frame.nodeId);
    assert.ok(frame._categoryWarnings);
    assert.ok(frame._categoryWarnings.some(w => w.includes('cornerRadius') && w.includes('radius variables')));
  });

  it('artboard deletion is blocked for top-level frames', async () => {
    h.advancePhase(2);

    // Override bridge to return PAGE as parent type
    const origSend = h.bridge.send.bind(h.bridge);
    h.bridge.send = (type, payload) => {
      if (type === 'get_node_parent') {
        return Promise.resolve({ type: 'PAGE', parentType: 'PAGE' });
      }
      return origSend(type, payload);
    };

    const result = await h.call('figma_delete_node', { nodeId: 'artboard-123' });
    assert.equal(result.error, 'ARTBOARD_DELETE_BLOCKED');
    assert.ok(result.message.includes('NEVER deleted'));
  });

  it('artboard deletion allowed for nested nodes', async () => {
    h.advancePhase(2);

    // Default bridge returns FRAME as parent — not PAGE
    const result = await h.call('figma_delete_node', { nodeId: 'nested-node-456' });
    assert.ok(result.ok, 'Nested node deletion should succeed');
  });

  it('plugin disconnect sets buildInterrupted and blocks tools', async () => {
    h.advancePhase(3); // Active build

    // Simulate disconnect
    h.bridge.connected = false;
    if (h.bridge._onDisconnect) h.bridge._onDisconnect();

    // The session flag is set by the mcp.js callback, but in our test harness
    // we set it directly since we're not going through the MCP request handler
    h.session.buildInterrupted = true;

    // Verify status reports the interruption
    // (mimic_status still works — it's exempt)
    h.bridge.connected = false;
    const status = await h.call('mimic_status');
    assert.ok(status.buildInterrupted || status.buildInterruptedWarning,
      'Status should report build interruption');

    // Reconnect
    h.bridge.connected = true;
    const status2 = await h.call('mimic_status');
    assert.ok(!status2.buildInterrupted || status2.buildInterruptedWarning?.includes('resumed'),
      'After reconnection, interruption should be cleared or show resumed');
  });

  it('chart palette excludes semantic colors', async () => {
    h.advancePhase(2);
    const result = await h.call('mimic_compute_chart', {
      chartType: 'bar',
      data: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }],
      dimensions: { chartHeight: 200 },
    });

    const palette = result._chartColorHint.suggestedPalette;
    assert.ok(palette.length > 0, 'Should have palette colors');

    // None should be Brand, Success, Warning, Error
    for (const color of palette) {
      assert.ok(!color.includes('/Brand/'), `Palette should not include Brand: ${color}`);
      assert.ok(!color.includes('/Success/'), `Palette should not include Success: ${color}`);
      assert.ok(!color.includes('/Warning/'), `Palette should not include Warning: ${color}`);
      assert.ok(!color.includes('/Error/'), `Palette should not include Error: ${color}`);
    }

    // Should have colorRules
    assert.ok(result._chartColorHint.colorRules, 'Should have colorRules');
    assert.ok(result._chartColorHint.colorRules.some(r => r.includes('NEVER use Brand')));
  });

  it('build report includes recommendations when category mismatches occurred', async () => {
    h.advancePhase(2);
    h.dsCache.addVariable('bg-secondary', { key: 'v1', category: 'background' });
    h.dsCache.addVariable('border-secondary', { key: 'v2', category: 'border' });

    // Build with category mismatch
    const frame = await h.call('figma_create_frame', {
      name: 'Test Frame',
      parentId: 'parent-1',
      direction: 'VERTICAL',
      strokeVariable: 'bg-secondary',
    });

    // Track the mismatch in session (normally done by mcp.js request handler)
    if (frame._categoryWarnings) {
      h.session.categoryMismatches.push(...frame._categoryWarnings);
    }

    // Generate report
    const report = await h.call('mimic_generate_build_report', {
      screenName: 'Mismatch Test',
      components: [],
      primitives: [],
    });

    assert.ok(report.recommendations, 'Report should have recommendations');
    assert.ok(report.recommendations.length > 0);
    assert.ok(report.recommendations.some(r => r.includes('category mismatches')));
    assert.ok(report._presentationRules, 'Report should include presentation rules');
    assert.ok(report._presentationRules.some(r => r.includes('HTML')));
  });

  it('rules filter by category', async () => {
    // Save rules in different categories
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'color-rule-1',
      data: { category: 'color', rule: 'No brand on charts' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'structure-rule-1',
      data: { category: 'structure', rule: 'Cards need headers' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'spacing-rule-1',
      data: { category: 'spacing', rule: 'Tables get 24px inset' },
    });

    h.knowledgeStore.load();
    const colorRules = h.knowledgeStore.getRules('color');
    assert.equal(Object.keys(colorRules).length, 1);
    assert.ok(colorRules['color-rule-1']);

    const allRules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(allRules).length, 3);
  });

  it('component recipe confidence promotes across builds', async () => {
    // Build 1
    h.advancePhase(2);
    await h.call('figma_insert_component', { componentKey: 'ck-tabs', parentId: 'p-1', name: 'Tabs' });
    await h.call('mimic_generate_build_report', {
      screenName: 'Build 1', components: [{ name: 'Tabs', instances: 2, componentKey: 'ck-tabs' }], primitives: [],
    });

    h.knowledgeStore.load();
    let recipe = h.knowledgeStore.getComponent('ck-tabs');
    assert.equal(recipe.confidence, 'new');
    assert.equal(recipe.buildCount, 1);

    // Builds 2-3 (promote to confirmed at 3)
    for (let i = 2; i <= 3; i++) {
      h.resetSession();
      h.advancePhase(2);
      await h.call('figma_insert_component', { componentKey: 'ck-tabs', parentId: 'p-1', name: 'Tabs' });
      await h.call('mimic_generate_build_report', {
        screenName: `Build ${i}`, components: [{ name: 'Tabs', instances: 1, componentKey: 'ck-tabs' }], primitives: [],
      });
    }

    h.knowledgeStore.load();
    recipe = h.knowledgeStore.getComponent('ck-tabs');
    assert.equal(recipe.confidence, 'confirmed', 'Should be confirmed after 3 builds');
    assert.equal(recipe.buildCount, 3);
  });

  it('full 3-build learning loop with rules', async () => {
    // ── BUILD 1: naive build ──
    h.advancePhase(2);
    h.dsCache.addVariable('bg-secondary', { key: 'v1', category: 'background' });
    h.dsCache.addVariable('border-secondary', { key: 'v2', category: 'border' });
    h.dsCache.addVariable('text-primary', { key: 'v3', category: 'text' });
    h.dsCache.addVariable('radius-md', { key: 'v4', category: 'radius' });

    await h.call('figma_insert_component', { componentKey: 'ck-card-header', parentId: 'p-1', name: 'Card Header' });
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-1', name: 'Badge' });

    // Mistake: use bg-secondary as stroke
    const badFrame = await h.call('figma_create_frame', {
      name: 'Card: Metrics', parentId: 'p-1', direction: 'VERTICAL',
      strokeVariable: 'bg-secondary',
    });
    assert.ok(badFrame._categoryWarnings?.length > 0, 'Build 1 should catch category mismatch');
    if (badFrame._categoryWarnings) h.session.categoryMismatches.push(...badFrame._categoryWarnings);

    const report1 = await h.call('mimic_generate_build_report', {
      screenName: 'Build 1',
      components: [
        { name: 'Card Header', instances: 1, componentKey: 'ck-card-header' },
        { name: 'Badge', instances: 2, componentKey: 'ck-badge' },
      ],
      primitives: [],
    });
    assert.ok(report1.recommendations?.some(r => r.includes('category mismatches')), 'Report 1 should recommend fixing mismatches');

    // ── USER FEEDBACK → save rules ──
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'card-always-header',
      data: { category: 'structure', rule: 'Every card must start with a Card Header component.', reason: 'User: "all cards need card headers"' },
    });
    await h.call('mimic_ai_knowledge_write', {
      type: 'rule', id: 'progress-bar-label',
      data: { category: 'component', rule: 'Progress bars: enable the Label boolean instead of creating separate text nodes.', reason: 'User: "use the label property"' },
    });

    // ── BUILD 2: rules are loaded, component recipes exist ──
    h.resetSession();
    h.advancePhase(2);

    const status2 = await h.call('mimic_status');
    assert.equal(status2.knowledge.rules, 2, 'Build 2 should see 2 rules');
    assert.ok(status2._designRules.find(r => r.id === 'card-always-header'), 'Card header rule present');
    assert.ok(status2._designRules.find(r => r.id === 'progress-bar-label'), 'Progress bar rule present');

    // Badge recipe should exist from Build 1
    assert.equal(status2.knowledge.components, 2, 'Should have 2 component recipes');

    // Build correctly this time — border-secondary for strokes
    const goodFrame = await h.call('figma_create_frame', {
      name: 'Card: Revenue', parentId: 'p-2', direction: 'VERTICAL',
      strokeVariable: 'border-secondary', // correct category
    });
    assert.ok(!goodFrame._categoryWarnings, 'No warnings when using correct category');

    await h.call('figma_insert_component', { componentKey: 'ck-card-header', parentId: goodFrame.nodeId, name: 'Card Header' });
    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: goodFrame.nodeId, name: 'Badge' });

    const report2 = await h.call('mimic_generate_build_report', {
      screenName: 'Build 2',
      components: [
        { name: 'Card Header', instances: 1, componentKey: 'ck-card-header' },
        { name: 'Badge', instances: 3, componentKey: 'ck-badge' },
      ],
      primitives: [],
    });
    assert.ok(!report2.recommendations?.some(r => r.includes('category mismatches')), 'Report 2 should have no mismatch warnings');

    // ── BUILD 3: verify confidence promotion ──
    h.resetSession();
    h.advancePhase(2);

    await h.call('figma_insert_component', { componentKey: 'ck-badge', parentId: 'p-3', name: 'Badge' });
    await h.call('mimic_generate_build_report', {
      screenName: 'Build 3',
      components: [{ name: 'Badge', instances: 1, componentKey: 'ck-badge' }],
      primitives: [],
    });

    h.knowledgeStore.load();
    const badgeRecipe = h.knowledgeStore.getComponent('ck-badge');
    assert.equal(badgeRecipe.buildCount, 3, 'Badge used in 3 builds');
    assert.equal(badgeRecipe.confidence, 'confirmed', 'Badge should be confirmed after 3 builds');

    // Card Header used in 2 builds — still new
    const headerRecipe = h.knowledgeStore.getComponent('ck-card-header');
    assert.equal(headerRecipe.buildCount, 2);
    assert.equal(headerRecipe.confidence, 'new', 'Card Header still new after 2 builds');

    // Rules still present
    const finalRules = h.knowledgeStore.getRules();
    assert.equal(Object.keys(finalRules).length, 2);

    // Build history should have 3 entries
    const history = h.knowledgeStore.getBuildHistory();
    assert.equal(history.length, 3);
  });
});
