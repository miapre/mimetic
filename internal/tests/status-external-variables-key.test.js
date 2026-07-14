'use strict';

/**
 * Regression test for BUG 2 (audit): src/tools/status.js wrote the
 * community-library variable-key map to `session.communityLibraryVariableKeys`
 * (~line 458) but read it back from `session.communityLibraryKeys` (~line 920)
 * — a dead/typo'd key that is never written anywhere. The read always
 * resolved to `undefined`, so `session.externalVariablesLibraryKey` was
 * always `null`, and the follow-up hint (~line 444) told the LLM to search
 * with `includeLibraryKeys: ["null"]`.
 *
 * This drives the REAL mimic_discover_ds handler through three sequential
 * calls that reproduce the actual flow:
 *   1. Community search results come back — the plugin has no visibility
 *      into the community library's variables (isPluginDiscovered: false
 *      later), so it validates + auto-selects the library and stores the
 *      searched variable key map (the write side, ~line 458).
 *   2. A follow-up call with libraryKey set walks the "normal discovery"
 *      path, detects the variable-source mismatch (selected library has
 *      0 cached variables while some other library contributed variables),
 *      and resolves `externalVariablesLibraryKey` from the stored map
 *      (the read side, ~line 920 — this is the exact line that was
 *      reading the wrong session key).
 *   3. A third call (no externalVariables yet) hits the reminder branch
 *      whose hint text embeds `externalVariablesLibraryKey` (~line 444)
 *      — this must contain the real key, never the literal string "null".
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { MockBridge } = require('./helpers/mock-bridge');
const { DsCache } = require('../../src/ds/cache');
const { KnowledgeStore } = require('../../src/knowledge/store');

function createContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const tmpFile = path.join(os.tmpdir(), `mimic-test-ks-status-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const knowledgeStore = new KnowledgeStore(tmpFile).load();

  const session = {
    phase: 0,
    toolCallCount: 0,
    selectedLibraryKey: null,
    pendingCommunityCheck: false,
    discoveredLibraries: null,
    discoveryFileKey: null,
    discoveryResults: null,
    completenessWarnings: null,
    enforcementProfile: null,
    pendingVariableMismatchConfirmation: false,
    variableMismatchSourceLibs: null,
    variableSourceConfirmed: null,
    pendingExternalVariables: false,
    externalVariablesLibraryKey: null,
    communityLibraryVariableKeys: null,
  };

  const toolHandlers = {};
  function registerTool(name, _desc, _schema, handler) {
    toolHandlers[name] = handler;
  }
  function advancePhase(to) {
    session.phase = Math.max(session.phase, to);
  }
  function resetSession() {
    session.phase = 0;
  }

  const figmaRest = { validateToken: async () => {} };

  const context = {
    bridge, dsCache, knowledgeStore, session,
    advancePhase, resetSession, registerTool, figmaRest,
  };

  require('../../src/tools/status').register(null, context);

  return { context, toolHandlers, bridge, dsCache, session };
}

describe('mimic_discover_ds — external variables library key (BUG 2 regression)', () => {
  it('resolves externalVariablesLibraryKey from the same key the community check writes to, and the reminder hint carries the real key (not "null")', async () => {
    const { toolHandlers, bridge, session } = createContext();
    const discover = toolHandlers['mimic_discover_ds'];
    assert.ok(discover, 'mimic_discover_ds must be registered');

    const FILE_KEY = 'test-file-key';
    const COMMUNITY_LIB = 'Community Lib';
    const SAMPLE_VAR_KEY = 'sample-var-key-123';

    // ── Call 1: community search results come back ──
    // Plugin discovered no libraries of its own; the community search
    // found one new library. Mock the plugin's access validation so it's
    // confirmed accessible, and provide the sample variable key map that
    // status.js must persist (the write side of the bug).
    session.pendingCommunityCheck = true;
    session.discoveredLibraries = [];
    session.discoveryFileKey = FILE_KEY;
    bridge.setResponse('validate_library_access', {
      results: [{ name: COMMUNITY_LIB, accessible: true }],
    });

    const call1 = await discover({
      fileKey: FILE_KEY,
      communitySearchResults: [COMMUNITY_LIB],
      communitySearchVariableKeys: { [COMMUNITY_LIB]: SAMPLE_VAR_KEY },
    });

    // Write side: must land on communityLibraryVariableKeys, not a dead alias.
    assert.equal(session.communityLibraryVariableKeys?.[COMMUNITY_LIB], SAMPLE_VAR_KEY);
    // Only one library candidate — auto-selected.
    assert.equal(call1.autoSelected, true);
    assert.equal(session.selectedLibraryKey, COMMUNITY_LIB);

    // ── Call 2: normal discovery re-run with libraryKey — triggers the
    // variable-source-mismatch check. The plugin's variable discovery only
    // reports variables from a DIFFERENT library ("Other Lib"), and does
    // NOT list the community library among its plugin-discovered libraries
    // — so this is the "community library, not plugin-discoverable" branch
    // that reads back the stored key (the read side of the bug, ~line 920).
    bridge.setResponse('discover_library_variables', {
      libraries: [{ name: 'Other Lib', collections: [] }],
      variables: [
        { path: 'color/brand/500', key: 'other-var-key', resolvedType: 'COLOR', collection: 'colors', libraryName: 'Other Lib' },
      ],
      totalVariables: 1,
    });

    const call2 = await discover({
      fileKey: FILE_KEY,
      libraryKey: COMMUNITY_LIB,
      skipRestApi: true,
    });

    assert.equal(call2.communityVariablesRequired, true);
    assert.equal(session.pendingExternalVariables, true);
    // This is the exact assertion that fails before the fix: before the
    // fix, session.externalVariablesLibraryKey resolves from the dead
    // `communityLibraryKeys` key and is always null.
    assert.equal(
      session.externalVariablesLibraryKey,
      SAMPLE_VAR_KEY,
      'externalVariablesLibraryKey must be resolved from the same session key the community check wrote to'
    );

    // ── Call 3: reminder branch — its hint interpolates externalVariablesLibraryKey.
    const call3 = await discover({ fileKey: FILE_KEY });

    assert.equal(call3.communityVariablesRequired, true);
    assert.ok(call3.hint.includes(SAMPLE_VAR_KEY), `hint should contain the real key, got: ${call3.hint}`);
    assert.ok(!call3.hint.includes('["null"]'), `hint must never fall back to the literal string "null", got: ${call3.hint}`);
    assert.equal(call3.targetLibraryKey, SAMPLE_VAR_KEY);
  });
});
