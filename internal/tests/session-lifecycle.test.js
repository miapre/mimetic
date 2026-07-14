'use strict';

/**
 * Regression tests for the session/phase state-machine fixes:
 *
 * B7  — mimic_generate_build_report used to leave the session parked at
 *       Phase 5 forever (advancePhase() is Math.max, so it can only move
 *       forward). The second build in the same file inherited Phase 5:
 *       the Phase-3 checkpoint/stop circuit breaker could never fire
 *       again, and per-build accumulators (bindingFailures,
 *       componentTextTracker, categoryMismatches, phaseToolCalls,
 *       toolCallCount, cacheHits) kept growing across builds, so the
 *       SECOND report double-counted the first build's data.
 *       Fix: a successful mimic_generate_build_report now triggers
 *       resetBuildState() (mcp.js), which returns phase to 2 (DS
 *       discovery/library selection preserved — the expensive state) and
 *       zeroes every per-build accumulator.
 *
 * B8  — resetSession() used to reset the session field-by-field and
 *       missed ~12 keys (selectedLibraryKey, componentMap, the per-build
 *       Maps like _pendingInserts/_variantConfigs, replaySavings, etc.),
 *       so those leaked across a file switch. Fix: createSession() is now
 *       the single factory defining the full session shape; resetSession()
 *       and resetBuildState() both derive from it by deleting every
 *       existing key and reassigning the factory's fresh keys back in, so
 *       a missed key is structurally impossible.
 *
 * B21 — every tool in src/tools/edit.js had no phase gate of its own, so
 *       all 11 were usable at Phase 0, before DS discovery — inconsistent
 *       with every other build/edit tool's "blocked until Phase 2"
 *       contract. Fix: mcp.js's tool-call wrapper gated all 11 edit.js
 *       tool names centrally (EDIT_TOOLS_REQUIRE_PHASE_2), without editing
 *       edit.js itself.
 *
 *       v3.0.0 update: the tool-surface consolidation merged those edit.js
 *       tools into figma_update_node (op-dispatched) and figma_variable_
 *       modes. Since mcp.js's centralized name-based Set can no longer
 *       express "gate some ops of this tool but not others" (figma_update_
 *       node's 'select'/'page' ops were never gated — they used to be
 *       figma_select_node/figma_change_page in inspect.js), the gate now
 *       lives inside edit.js's own op handlers (matching the pattern
 *       components.js already used). Only figma_delete_node (unchanged,
 *       still has no self-gate) remains in mcp.js's
 *       EDIT_TOOLS_REQUIRE_PHASE_2 Set.
 *
 * These tests drive the REAL mcp.js request wrapper — the actual
 * 'tools/call' handler registered on the MCP `Server` instance — instead
 * of calling tool handlers directly, because the behavior under test
 * (circuit breaker / checkpoint counters, the post-report reset, and the
 * central phase gate) all lives in that wrapper, not in any individual
 * tool file.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_PATH = require.resolve('../../mcp');

/**
 * A fresh mcp.js module instance. mcp.js constructs module-level
 * singletons (session, dsCache, knowledgeStore, bridge, buildManifest) as
 * a side effect of require() — so each test gets an isolated instance by
 * busting the require cache and re-requiring, rather than relying on
 * node:test's process model to isolate test files. MIMIC_KNOWLEDGE_PATH is
 * pointed at a throwaway tmp file so no test ever touches the real
 * ~/.mimic-ai store.
 */
function freshMcp() {
  delete require.cache[MCP_PATH];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-session-lifecycle-'));
  const prevKnowledgePath = process.env.MIMIC_KNOWLEDGE_PATH;
  process.env.MIMIC_KNOWLEDGE_PATH = path.join(tmpDir, 'ds-knowledge.json');
  const mod = require('../../mcp');
  if (prevKnowledgePath === undefined) delete process.env.MIMIC_KNOWLEDGE_PATH;
  else process.env.MIMIC_KNOWLEDGE_PATH = prevKnowledgePath;
  return { server: mod.server, context: mod.context, createSession: mod.createSession, tmpDir };
}

/**
 * Invoke the real 'tools/call' handler mcp.js registers on `server`,
 * bypassing the stdio transport. This exercises the actual wrapper logic
 * (circuit breaker, checkpoint, phase gates, the B7 reset hook) exactly as
 * a live MCP client's tool call would.
 */
async function callTool(mod, name, args = {}) {
  const handler = mod.server._requestHandlers.get('tools/call');
  assert.ok(handler, 'tools/call handler must be registered on the server');
  const response = await handler({ method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(response.content[0].text);
}

function cleanup(mod) {
  try { fs.rmSync(mod.tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── B8: createSession() / resetSession() completeness ──────────────────

describe('createSession() / resetSession() — B8: no key left at a stale value', () => {
  it('resetSession() returns every known key to its fresh value, even when every key was mutated first', () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;
      const fresh = mod.createSession();

      // Mutate EVERY key the factory defines to a non-fresh sentinel value.
      // This is the direct test for B8: the old resetSession() hand-listed
      // ~20 keys and simply forgot ~12 of them, so mutating literally every
      // key first and then asserting all of them come back fresh is the
      // only way to prove a miss is now impossible, not just that the
      // handful of keys someone remembered to test are fine.
      for (const key of Object.keys(fresh)) {
        const freshVal = fresh[key];
        if (freshVal instanceof Map) {
          session[key].set('stale-sentinel', true);
        } else if (Array.isArray(freshVal)) {
          session[key] = [...freshVal, 'stale-sentinel'];
        } else if (typeof freshVal === 'number') {
          session[key] = freshVal + 999;
        } else if (typeof freshVal === 'boolean') {
          session[key] = !freshVal;
        } else if (freshVal && typeof freshVal === 'object') {
          session[key] = { ...freshVal, stale: 'sentinel' };
        } else {
          session[key] = 'stale-sentinel';
        }
      }
      // Also plant a key the factory doesn't know about, proving the reset
      // doesn't just leave unrecognized keys lying around.
      session._rogueKey = 'should not survive a reset';

      mod.context.resetSession();

      const freshAfter = mod.createSession();
      for (const key of Object.keys(freshAfter)) {
        // knowledgeStoreNotice is the one deliberate exception — it's
        // startup metadata carried over across resetSession() by design
        // (see the dedicated test below), not build/file-scoped state.
        if (key === 'knowledgeStoreNotice') continue;
        if (freshAfter[key] instanceof Map) {
          assert.equal(session[key].size, 0, `${key} must be an empty Map after resetSession()`);
        } else {
          assert.deepEqual(session[key], freshAfter[key], `${key} must match createSession()'s fresh value after resetSession()`);
        }
      }
      assert.equal(session._rogueKey, undefined, 'a key not defined by createSession() must not survive resetSession()');
    } finally {
      cleanup(mod);
    }
  });

  it('preserves knowledgeStoreNotice across resetSession() — it is startup metadata, not file-scoped state', () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;
      session.knowledgeStoreNotice = 'migrated knowledge store from legacy path';
      mod.context.resetSession();
      assert.equal(session.knowledgeStoreNotice, 'migrated knowledge store from legacy path');
    } finally {
      cleanup(mod);
    }
  });

  it('file-switch reset clears the specific B8-missed keys (selectedLibraryKey and the per-build Maps)', () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;
      session.selectedLibraryKey = 'lib-abc';
      session.pendingExternalVariables = true;
      session.externalVariablesLibraryKey = 'ext-key';
      session.communityLibraryVariableKeys = { LibraryA: 'key-1' };
      session.componentMap = { components: [{ elementType: 'button' }] };
      session.expectedStyleCount = 12;
      session.replaySavings = 5;
      session._pendingInserts.set('dedup-1', { at: Date.now() });
      session._timeoutRetries.set('dedup-1', 1);
      session._componentInsertions.set('comp-key', { count: 2, names: ['Button'] });
      session._variantConfigs.set('comp-key', { Color: 'Success' });
      session._nodeComponentKeys.set('node-1', 'comp-key');
      session._frameLayoutConfigs.set('Card', { gap: 8 });
      session._textNodeStructures.set('comp-key', { nodeNames: ['Heading'] });

      mod.context.resetSession();

      assert.equal(session.selectedLibraryKey, null);
      assert.equal(session.pendingExternalVariables, false);
      assert.equal(session.externalVariablesLibraryKey, null);
      assert.equal(session.communityLibraryVariableKeys, null);
      assert.equal(session.componentMap, null);
      assert.equal(session.expectedStyleCount, null);
      assert.equal(session.replaySavings, 0);
      assert.equal(session._pendingInserts.size, 0);
      assert.equal(session._timeoutRetries.size, 0);
      assert.equal(session._componentInsertions.size, 0);
      assert.equal(session._variantConfigs.size, 0);
      assert.equal(session._nodeComponentKeys.size, 0);
      assert.equal(session._frameLayoutConfigs.size, 0);
      assert.equal(session._textNodeStructures.size, 0);
    } finally {
      cleanup(mod);
    }
  });

  it('resetSession() mutates in place — object identity is preserved for modules that destructured session at require() time', () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;
      const capturedByToolModule = session; // simulates `const { session } = context` in e.g. edit.js
      session.phase = 3;
      session.toolCallCount = 40;
      mod.context.resetSession();
      assert.equal(session, capturedByToolModule, 'resetSession must mutate session in place, never reassign context.session');
      assert.equal(capturedByToolModule.phase, 0);
      assert.equal(capturedByToolModule.toolCallCount, 0);
    } finally {
      cleanup(mod);
    }
  });
});

// ── B7: post-report reset ───────────────────────────────────────────────

describe('mimic_generate_build_report — B7: post-report reset to Phase 2 with clean accumulators', () => {
  it('returns phase to 2 (not left at 5) and zeroes phaseToolCalls/checkpointIssued/bindingFailures/componentTextTracker/categoryMismatches', async () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;
      // Simulate a completed build: mid-Phase-3 activity plus accumulator state.
      session.phase = 3;
      session.phaseToolCalls = { 0: 0, 1: 0, 2: 0, 3: 14, 4: 0, 5: 0 };
      session.checkpointIssued = true;
      session.bindingFailures = [{ tool: 'figma_create_frame', nodeId: 'n1', failedBindings: ['bg-primary'] }];
      session.componentTextTracker.set('n1', { name: 'Card', expected: [], overridden: new Set() });
      session.categoryMismatches = ["bg-primary: used as strokeVariable for 'Divider'"];
      session.toolCallCount = 25;
      session.cacheHits = 3;
      session.buildsSinceReport = 1;

      // DS-discovery state that must SURVIVE the reset (the expensive part).
      session.enforcementProfile = { dsMode: 'strict' };
      session.selectedLibraryKey = 'my-design-system';
      session.discoveryFileKey = 'file-key-123';
      session.componentMap = { components: [{ elementType: 'button', componentKey: 'ck-1' }] };

      const result = await callTool(mod, 'mimic_generate_build_report', {
        screenName: 'Build 1', components: [], primitives: [],
      });
      assert.ok(!result.error, `report call must succeed: ${JSON.stringify(result)}`);

      assert.equal(session.phase, 2, 'phase must return to 2, not stay at 5');
      assert.deepEqual(session.phaseToolCalls, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
      assert.equal(session.checkpointIssued, false, 'checkpoint must be able to fire again on the next build');
      assert.deepEqual(session.bindingFailures, []);
      assert.equal(session.componentTextTracker.size, 0);
      assert.deepEqual(session.categoryMismatches, []);
      assert.equal(session.toolCallCount, 0);
      assert.equal(session.cacheHits, 0);
      assert.equal(session.buildsSinceReport, 0);

      // DS-discovery state must be preserved — recomputing it would mean
      // re-running discovery, exactly the expensive work B7 says to keep.
      assert.deepEqual(session.enforcementProfile, { dsMode: 'strict' });
      assert.equal(session.selectedLibraryKey, 'my-design-system');
      assert.equal(session.discoveryFileKey, 'file-key-123');
      assert.deepEqual(session.componentMap, { components: [{ elementType: 'button', componentKey: 'ck-1' }] });
    } finally {
      cleanup(mod);
    }
  });

  it('a second build in the same file re-triggers the Phase-3 20-op checkpoint after the fix (it could not before)', async () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;

      // Build 1: enter Phase 3 and drive 20 successful tool calls to trigger
      // the checkpoint. mimic_status is used as the driver because it's a
      // real registered tool that succeeds without touching the (unstarted,
      // in this test) bridge/plugin connection — any successful call in
      // Phase 3 increments phaseToolCalls[3], which is all the checkpoint
      // logic cares about.
      session.phase = 3;
      let checkpointHits = 0;
      for (let i = 0; i < 20; i++) {
        const r = await callTool(mod, 'mimic_status', {});
        if (r._checkpoint) checkpointHits++;
      }
      assert.equal(checkpointHits, 1, 'checkpoint must fire exactly once at the 20th op in build 1');
      assert.equal(session.checkpointIssued, true);

      // End build 1 with a report — this is what resets state for build 2.
      const reportResult = await callTool(mod, 'mimic_generate_build_report', {
        screenName: 'Build 1', components: [], primitives: [],
      });
      assert.ok(!reportResult.error);
      assert.equal(session.phase, 2);
      assert.equal(session.checkpointIssued, false);

      // Build 2, same file/session: re-enter Phase 3 (as build.js's
      // advancePhase(3) would on the first create_frame/insert_component
      // call) and drive another 20 successful calls.
      mod.context.advancePhase(3);
      checkpointHits = 0;
      for (let i = 0; i < 20; i++) {
        const r = await callTool(mod, 'mimic_status', {});
        if (r._checkpoint) checkpointHits++;
      }
      assert.equal(checkpointHits, 1, 'checkpoint must be able to fire again in build 2 — this is the exact B7 regression');
    } finally {
      cleanup(mod);
    }
  });

  it('a second report does not double-count the first build\'s tool calls or binding failures', async () => {
    const mod = freshMcp();
    try {
      const { session } = mod.context;

      // Build 1 activity.
      session.phase = 3;
      session.toolCallCount = 15;
      session.bindingFailures = [{ tool: 'figma_create_frame', nodeId: 'n1', failedBindings: ['bg-primary'] }];

      const report1 = await callTool(mod, 'mimic_generate_build_report', {
        screenName: 'Build 1', components: [], primitives: [],
      });
      assert.ok(!report1.error);
      assert.equal(report1.bindingFailureCount, 1, 'report 1 must reflect build 1\'s single binding failure');
      assert.match(report1.summary, /15 tool calls/);

      // Build 2 activity — smaller, on the same session/file.
      mod.context.advancePhase(3);
      session.toolCallCount = 7;
      session.bindingFailures = [{ tool: 'figma_set_node_fill', nodeId: 'n2', failedBindings: ['text-secondary'] }];

      const report2 = await callTool(mod, 'mimic_generate_build_report', {
        screenName: 'Build 2', components: [], primitives: [],
      });
      assert.ok(!report2.error);
      assert.equal(report2.bindingFailureCount, 1, 'report 2 must show only build 2\'s failure, not build 1 + build 2 (2)');
      assert.match(report2.summary, /7 tool calls/, 'report 2 must show only build 2\'s tool calls, not the 15+7=22 accumulated total');
    } finally {
      cleanup(mod);
    }
  });
});

// ── B21: edit.js phase gating ────────────────────────────────────────────

describe('edit.js tools — B21: Phase 2 gate (now self-gated per figma_update_node op)', () => {
  // Every op that used to be its own standalone gated tool.
  const GATED_UPDATE_NODE_OPS = ['text', 'text_style', 'fill', 'layout', 'visibility', 'position', 'move', 'restyle'];
  // These two ops were NEVER gated pre-v3.0.0 (figma_select_node / figma_change_page).
  const UNGATED_UPDATE_NODE_OPS = ['select', 'page'];

  for (const op of GATED_UPDATE_NODE_OPS) {
    it(`figma_update_node op="${op}" is blocked at Phase 0 with a helpful PHASE_REQUIRED error`, async () => {
      const mod = freshMcp();
      try {
        assert.equal(mod.context.session.phase, 0);
        const result = await callTool(mod, 'figma_update_node', { op, nodeId: 'n1', content: 'x', visible: true, x: 0, y: 0, parentId: 'p1', textStyleId: 't1' });
        assert.equal(result.error, 'PHASE_REQUIRED', `op="${op}" must be blocked before DS discovery`);
        assert.equal(result.currentPhase, 0);
        assert.equal(result.requiredPhase, 2);
        assert.match(result.message, /discover_ds|Phase 2|discovery/i, 'the error must tell the caller how to unblock it');
      } finally {
        cleanup(mod);
      }
    });
  }

  for (const op of UNGATED_UPDATE_NODE_OPS) {
    it(`figma_update_node op="${op}" is NOT blocked at Phase 0 (was never gated pre-consolidation)`, async () => {
      const mod = freshMcp();
      try {
        assert.equal(mod.context.session.phase, 0);
        const result = await callTool(mod, 'figma_update_node', { op, nodeId: 'n1', pageName: 'Page 1' });
        assert.notEqual(result.error, 'PHASE_REQUIRED', `op="${op}" must not require Phase 2`);
      } finally {
        cleanup(mod);
      }
    });
  }

  it('figma_variable_modes is blocked at Phase 0 with a helpful PHASE_REQUIRED error', async () => {
    const mod = freshMcp();
    try {
      assert.equal(mod.context.session.phase, 0);
      const result = await callTool(mod, 'figma_variable_modes', { nodeId: 'n1', modeIndex: 0 });
      assert.equal(result.error, 'PHASE_REQUIRED');
      assert.equal(result.currentPhase, 0);
      assert.equal(result.requiredPhase, 2);
    } finally {
      cleanup(mod);
    }
  });

  it('figma_delete_node is blocked at Phase 0 with a helpful PHASE_REQUIRED error (still centrally gated in mcp.js)', async () => {
    const mod = freshMcp();
    try {
      assert.equal(mod.context.session.phase, 0);
      const result = await callTool(mod, 'figma_delete_node', { nodeId: 'n1' });
      assert.equal(result.error, 'PHASE_REQUIRED');
      assert.equal(result.currentPhase, 0);
      assert.equal(result.requiredPhase, 2);
    } finally {
      cleanup(mod);
    }
  });

  it('does not block figma_update_node once Phase 2 is reached (fails later, for an unrelated bridge/plugin reason, not PHASE_REQUIRED)', async () => {
    const mod = freshMcp();
    try {
      mod.context.session.phase = 2;
      const result = await callTool(mod, 'figma_update_node', { op: 'text', nodeId: 'n1', content: 'hello' });
      assert.notEqual(result.error, 'PHASE_REQUIRED', 'at Phase 2, the gate itself must not block the call');
    } finally {
      cleanup(mod);
    }
  });

  it('non-edit tools (e.g. mimic_status) are unaffected by the edit-tool gate at Phase 0', async () => {
    const mod = freshMcp();
    try {
      const result = await callTool(mod, 'mimic_status', {});
      assert.notEqual(result.error, 'PHASE_REQUIRED');
      assert.equal(result.phase, 0);
    } finally {
      cleanup(mod);
    }
  });
});

// ── Bridge port: MIMIC_BRIDGE_PORT is no longer overridden ─────────────

describe('Bridge instantiation — mcp.js no longer hardcodes port 3056', () => {
  it('respects MIMIC_BRIDGE_PORT when set, instead of the hardcoded 3056 override', () => {
    delete require.cache[MCP_PATH];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-bridge-port-'));
    const prevKnowledgePath = process.env.MIMIC_KNOWLEDGE_PATH;
    const prevBridgePort = process.env.MIMIC_BRIDGE_PORT;
    process.env.MIMIC_KNOWLEDGE_PATH = path.join(tmpDir, 'ds-knowledge.json');
    process.env.MIMIC_BRIDGE_PORT = '4099';
    try {
      const mod = require('../../mcp');
      assert.equal(mod.context.bridge.port, 4099);
    } finally {
      if (prevKnowledgePath === undefined) delete process.env.MIMIC_KNOWLEDGE_PATH;
      else process.env.MIMIC_KNOWLEDGE_PATH = prevKnowledgePath;
      if (prevBridgePort === undefined) delete process.env.MIMIC_BRIDGE_PORT;
      else process.env.MIMIC_BRIDGE_PORT = prevBridgePort;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      delete require.cache[MCP_PATH];
    }
  });

  it('falls back to 3056 when MIMIC_BRIDGE_PORT is unset', () => {
    delete require.cache[MCP_PATH];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-bridge-port-default-'));
    const prevKnowledgePath = process.env.MIMIC_KNOWLEDGE_PATH;
    const prevBridgePort = process.env.MIMIC_BRIDGE_PORT;
    process.env.MIMIC_KNOWLEDGE_PATH = path.join(tmpDir, 'ds-knowledge.json');
    delete process.env.MIMIC_BRIDGE_PORT;
    try {
      const mod = require('../../mcp');
      assert.equal(mod.context.bridge.port, 3056);
    } finally {
      if (prevKnowledgePath === undefined) delete process.env.MIMIC_KNOWLEDGE_PATH;
      else process.env.MIMIC_KNOWLEDGE_PATH = prevKnowledgePath;
      if (prevBridgePort === undefined) delete process.env.MIMIC_BRIDGE_PORT;
      else process.env.MIMIC_BRIDGE_PORT = prevBridgePort;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      delete require.cache[MCP_PATH];
    }
  });
});
