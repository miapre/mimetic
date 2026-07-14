'use strict';

/**
 * MCP-tool-level tests for figma_fill_slot / figma_reset_slot
 * (src/tools/components.js), against a MockBridge (no real plugin).
 *
 * Covers: phase gating (like every other component tool), the previously-
 * failed-componentKey guard (mirrors figma_insert_component), and the
 * recipe.slots observation recording (spec: SLOT props are never replayed,
 * checklist-only — schema-v3-spec.md §4.1/§4.3 "slots" field).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');
const { DsResolver } = require('../../../src/ds/resolver');
const { KnowledgeStore } = require('../../../src/knowledge/store');
const { BuildManifest } = require('../../../src/knowledge/manifest');
const { PhaseError } = require('../../../src/utils/errors');

function createTestContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-slots-'));
  const knowledgeStore = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  const buildManifest = new BuildManifest();

  const session = {
    phase: 2,
    artboardId: null,
    enforcementProfile: null,
    toolCallCount: 0,
    cacheHits: 0,
    selectedLibraryKey: null,
    expectedStyleCount: null,
    consecutiveFailures: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    checkpointIssued: false,
    bindingFailures: [],
    componentTextTracker: new Map(),
  };

  const handlers = {};
  function registerTool(name, _description, _inputSchema, handler) { handlers[name] = handler; }
  function requirePhase(minPhase, hint) {
    if (session.phase < minPhase) throw new PhaseError(session.phase, minPhase, hint);
  }
  function advancePhase(to) { session.phase = Math.max(session.phase, to); }

  const context = { bridge, dsCache, dsResolver, knowledgeStore, buildManifest, session, requirePhase, advancePhase, registerTool };
  require('../../../src/tools/components').register(null, context);

  return { context, handlers, bridge, session, dsCache, knowledgeStore };
}

describe('figma_fill_slot', () => {
  let handlers, bridge, session, dsCache, knowledgeStore;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    dsCache = setup.dsCache;
    knowledgeStore = setup.knowledgeStore;
  });

  it('requires phase >= 2', async () => {
    session.phase = 1;
    await assert.rejects(
      () => handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'metric-card' }),
      (err) => { assert.ok(err instanceof PhaseError); return true; }
    );
  });

  it('sends fill_slot to the bridge and returns the result', async () => {
    bridge.setResponse('fill_slot', { nodeId: 'n1', slotName: 'Content', filledWithKey: 'metric-card', filledInstanceId: 'n2' });
    const result = await handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'metric-card' });

    const msgs = bridge.getMessages('fill_slot');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload.slotName, 'Content');
    assert.equal(result.filledInstanceId, 'n2');
    assert.equal(session.toolCallCount, 1);
  });

  it('rejects a previously-failed componentKey without calling the bridge (mirrors figma_insert_component)', async () => {
    dsCache.markFailed('bad-key', true);
    const result = await handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'bad-key' });
    assert.equal(result.error, 'COMPONENT_PREVIOUSLY_FAILED');
    assert.equal(bridge.getMessages('fill_slot').length, 0);
  });

  it('marks a componentKey failed (permanent) when the bridge rejects with a non-timeout error', async () => {
    bridge.setResponse('fill_slot', () => { throw new Error('COMPONENT_NOT_FOUND'); });
    await assert.rejects(() => handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'missing-key' }));
    assert.equal(dsCache.hasFailed('missing-key'), true);
  });

  it('records a slot observation on the host component recipe (spec: never replayed, checklist only)', async () => {
    bridge.setResponse('fill_slot', { nodeId: 'n1', slotName: 'Content', filledWithKey: 'metric-card' });
    session._nodeComponentKeys = new Map([['n1', 'card-key']]);

    await handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'metric-card' });
    await handlers.figma_fill_slot({ nodeId: 'n1', slotName: 'Content', componentKey: 'metric-card' });

    const recipe = knowledgeStore.getComponent('card-key');
    assert.ok(recipe, 'a recipe should be created for the host component');
    assert.equal(recipe.slots.Content.observed, 2);
  });

  it('never auto-replays a slot fill on figma_insert_component (slots are checklist-only)', async () => {
    // Insert a component that previously had a slot filled + recorded...
    bridge.setResponse('insert_component', {
      nodeId: 'n1',
      name: 'Card',
      componentKey: 'card-key',
      configurationHints: { textNodes: [], booleanProperties: {}, variantProperties: {}, slotProperties: [{ name: 'Content', key: 'Content#1', current: null }] },
    });
    knowledgeStore.setComponent('card-key', {
      names: ['Card'], instances: 1, buildCount: 3, componentKey: 'card-key', confidence: 'confirmed',
      slots: { Content: { observed: 5 } },
    });

    const result = await handlers.figma_insert_component({ componentKey: 'card-key', parentId: 'p1' });
    // No fill_slot message should ever be sent by figma_insert_component itself.
    assert.equal(bridge.getMessages('fill_slot').length, 0);
    assert.equal(result._autoApplied, undefined, 'no variant auto-apply data means no slot replay either — slots have no defaultVariants-equivalent replay path');
  });
});

describe('figma_reset_slot', () => {
  let handlers, bridge, session;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
  });

  it('requires phase >= 2', async () => {
    session.phase = 0;
    await assert.rejects(
      () => handlers.figma_reset_slot({ nodeId: 'n1', slotName: 'Content' }),
      (err) => { assert.ok(err instanceof PhaseError); return true; }
    );
  });

  it('sends reset_slot to the bridge and returns the result', async () => {
    bridge.setResponse('reset_slot', { nodeId: 'n1', slotName: 'Content', reset: true });
    const result = await handlers.figma_reset_slot({ nodeId: 'n1', slotName: 'Content' });
    assert.equal(bridge.getMessages('reset_slot').length, 1);
    assert.equal(result.reset, true);
    assert.equal(session.toolCallCount, 1);
  });
});
