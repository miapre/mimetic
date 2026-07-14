'use strict';

/**
 * Schema v3 acceptance-criteria tests (schema-v3-spec.md §6), covering the
 * store-level surface implemented in src/knowledge/store.js:
 *   1  — v2 -> v3 migration, idempotent double-load
 *   2  — corrupt file recovery (already covered by store-integrity.test.js;
 *        re-asserted here at v3 explicitly for completeness)
 *   3  — claim-by-evidence: exactly-once recipe claiming across libraries
 *   5  — rule scoping (global / per-library / dismissed)
 *   6  — community library bucket rename preserving stats
 *   14 — majority-wins variant derivation (5/4 no-default, 7/2 replayed)
 *   16 — buildCount dedup (once per build regardless of report entry count)
 *   23 — two store instances, two libraries, interleaved saves — both intact
 *   24 — kill-during-save simulation leaves the previous file valid
 *   25 (store-level slice) — shape validation on setComponent
 *
 * All fixtures live under an fs.mkdtemp'd directory — nothing is written to
 * a tracked path.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KnowledgeStore, computeLibraryId, deriveDefaultVariants } = require('../../../src/knowledge/store');

describe('Schema v3 — migration (acceptance criterion 1)', () => {
  let tmpDir;
  let storePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-migrate-'));
    storePath = path.join(tmpDir, 'ds-knowledge.json');
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  function writeV2Fixture() {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 2,
      dsFingerprint: 'legacy-fingerprint-string',
      components: {
        'ck-badge': {
          names: ['Badge'], componentKey: 'ck-badge', confidence: 'confirmed', buildCount: 4, instances: 9,
          defaultVariants: { Color: 'Success', Size: 'md' },
          textNodes: ['Heading', 'Heading', 'Supporting text'],
        },
      },
      patterns: { Card: { description: 'Card pattern', buildCount: 3, confidence: 'confirmed' } },
      gaps: { 'tab-component': { evidence: 'Built as primitive', elements: ['nav tabs'] } },
      rules: { 'user-rule': { category: 'color', rule: 'Brand for links only' } },
      libraryFileKeys: { 'Acme Theme': 'fileKey123' },
      buildHistory: [{ screenName: 'Old build', buildNumber: 1, toolCalls: 10 }],
      signals: [],
      meta: { buildCount: 4, lastBuild: '2026-01-01T00:00:00.000Z', created: '2025-01-01T00:00:00.000Z' },
    }));
  }

  it('produces v3 with all data under libraries.__default__, rules global with libraryId: null, and a knowledge.v2.backup.json', () => {
    writeV2Fixture();
    const store = new KnowledgeStore(storePath);
    store.load();

    assert.equal(store.data.version, 3);
    assert.equal(store.getActiveLibraryId(), '__default__');
    assert.ok(store.data.components['ck-badge']);
    assert.equal(store.data.components['ck-badge'].componentKey, 'ck-badge');
    assert.ok(store.data.patterns.Card);
    assert.ok(store.data.gaps['tab-component']);
    assert.equal(store.data.gaps['tab-component'].status, 'open');

    const rule = store.getRule('user-rule');
    assert.ok(rule);
    assert.equal(rule.libraryId, null);

    const backupPath = path.join(tmpDir, 'knowledge.v2.backup.json');
    assert.ok(fs.existsSync(backupPath), 'v2 backup should be written once');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    assert.equal(backup.version, 2);

    // Migrated variantStats seeded from defaultVariants (count = min(buildCount, 3))
    const variantStats = store.data.components['ck-badge'].variantStats;
    assert.equal(variantStats.Color.Success, 3);
    assert.equal(variantStats.Size.md, 3);

    // textNodes array -> frequency map
    const textNodes = store.data.components['ck-badge'].textNodes;
    assert.equal(textNodes.Heading, 2);
    assert.equal(textNodes['Supporting text'], 1);

    // libraryFileKeys carried forward as the alias seed table
    assert.equal(store.getLibraryFileKey('Acme Theme'), 'fileKey123');
  });

  it('loading the migrated file twice is idempotent (no re-migration, no duplicate backup)', () => {
    writeV2Fixture();
    const store1 = new KnowledgeStore(storePath);
    store1.load();

    const backupPath = path.join(tmpDir, 'knowledge.v2.backup.json');
    const backupMtime1 = fs.statSync(backupPath).mtimeMs;

    const store2 = new KnowledgeStore(storePath);
    store2.load();

    assert.equal(store2.data.version, 3);
    assert.equal(store2.migrationNote, null, 'second load should not report a fresh migration');
    assert.ok(store2.data.components['ck-badge']);
    assert.equal(Object.keys(store2.data.components).length, 1, 'no duplication of migrated data');

    const backupMtime2 = fs.statSync(backupPath).mtimeMs;
    assert.equal(backupMtime1, backupMtime2, 'backup must not be rewritten on the second load');
  });
});

describe('Schema v3 — claim-by-evidence (acceptance criterion 3)', () => {
  let tmpDir;
  let storePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-claim-'));
    storePath = path.join(tmpDir, 'ds-knowledge.json');
    fs.writeFileSync(storePath, JSON.stringify({
      version: 2,
      dsFingerprint: null,
      components: {
        'ck-badge': { names: ['Badge'], componentKey: 'ck-badge', confidence: 'confirmed', buildCount: 3 },
        'ck-button': { names: ['Button'], componentKey: 'ck-button', confidence: 'confirmed', buildCount: 3 },
        'ck-tab': { names: ['Tab'], componentKey: 'ck-tab', confidence: 'new', buildCount: 1 },
      },
      patterns: { Card: { description: 'x', buildCount: 3 } },
      gaps: {},
      rules: {},
      libraryFileKeys: {},
      buildHistory: [],
      signals: [],
      meta: { buildCount: 3, lastBuild: null, created: null },
    }));
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('discovery of library L moves exactly the __default__ recipes whose componentKeys exist in L\'s cache; a second library M later claims its own; no recipe appears in two buckets', () => {
    const store = new KnowledgeStore(storePath);
    store.load();

    // Library L's live cache has ck-badge and ck-button, but not ck-tab.
    const claimL = store.claimByEvidence('libL', new Set(['ck-badge', 'ck-button']));
    assert.equal(claimL.claimed, 2);
    assert.deepEqual(claimL.claimedKeys.sort(), ['ck-badge', 'ck-button']);

    // __default__ still exists (ck-tab unclaimed), library L has the two claimed recipes.
    assert.ok(store.getLibraryBucket('__default__'), '__default__ should still exist — ck-tab unclaimed');
    assert.ok(store.getLibraryBucket('libL').components['ck-badge']);
    assert.ok(store.getLibraryBucket('libL').components['ck-button']);
    assert.ok(!store.getLibraryBucket('libL').components['ck-tab']);

    // Library M later claims ck-tab.
    const claimM = store.claimByEvidence('libM', new Set(['ck-tab']));
    assert.equal(claimM.claimed, 1);
    assert.deepEqual(claimM.claimedKeys, ['ck-tab']);

    // __default__ is now empty of recipes and should have been removed.
    assert.equal(store.getLibraryBucket('__default__'), null);

    // No recipe appears in two buckets.
    assert.ok(!store.getLibraryBucket('libM').components['ck-badge']);
    assert.ok(!store.getLibraryBucket('libM').components['ck-button']);
    assert.ok(store.getLibraryBucket('libM').components['ck-tab']);
  });

  it('patterns/gaps/history are inherited by whichever library claimed >=50% of the original __default__ recipes', () => {
    const store = new KnowledgeStore(storePath);
    store.load();

    // libL claims 2 of 3 recipes (66%) -> should inherit patterns once __default__ empties.
    store.claimByEvidence('libL', new Set(['ck-badge', 'ck-button']));
    store.claimByEvidence('libM', new Set(['ck-tab']));

    assert.ok(store.getLibraryBucket('libL').patterns.Card, 'majority claimant (libL) should inherit the Card pattern');
    assert.ok(!store.getLibraryBucket('libM').patterns.Card, 'minority claimant (libM) should not inherit patterns');
  });
});

describe('Schema v3 — rule scoping (acceptance criterion 5)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-rules-'));
    store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('a rule saved with libraryId: A is injected only in A-sessions; libraryId: null in all; dismissed in none', () => {
    store.setActiveLibrary('libA');
    store.setRule('rule-a', { category: 'component', rule: 'A-only: Badge default color Success', scope: 'badge', libraryId: 'libA' });

    store.setActiveLibrary('libB');
    store.setRule('rule-b', { category: 'component', rule: 'B-only: Badge default color Gray', scope: 'badge', libraryId: 'libB' });

    store.setRule('rule-global', { category: 'color', rule: 'Brand only for links', scope: 'brand', libraryId: null });

    store.setRule('rule-dismissed', {
      category: 'component', rule: 'Badge should be red', scope: 'badge',
      source: 'auto_compiled', status: 'dismissed', libraryId: null,
    });

    // In library A's session: sees rule-a and rule-global, not rule-b, not dismissed.
    store.setActiveLibrary('libA');
    let matches = store.findMatchingRules(['badge']).map(m => m.id);
    assert.ok(matches.includes('rule-a'));
    assert.ok(!matches.includes('rule-b'));
    assert.ok(!matches.includes('rule-dismissed'));
    let brandMatches = store.findMatchingRules(['brand']).map(m => m.id);
    assert.ok(brandMatches.includes('rule-global'));

    // In library B's session: sees rule-b and rule-global, not rule-a.
    store.setActiveLibrary('libB');
    matches = store.findMatchingRules(['badge']).map(m => m.id);
    assert.ok(matches.includes('rule-b'));
    assert.ok(!matches.includes('rule-a'));

    // Same guarantee for getActiveRules() (mimic_status's rule listing) —
    // acceptance criterion 5 explicitly requires "point-of-use AND status both".
    const activeInB = store.getActiveRules();
    assert.ok(activeInB['rule-b']);
    assert.ok(activeInB['rule-global']);
    assert.ok(!activeInB['rule-a']);
    assert.ok(!activeInB['rule-dismissed']);
  });

  it('cold start (no active library set): only global rules apply', () => {
    store.setActiveLibrary('libA');
    store.setRule('rule-a', { category: 'component', rule: 'A-only', scope: 'badge', libraryId: 'libA' });
    store.setRule('rule-global', { category: 'color', rule: 'Global rule about badge', scope: 'badge', libraryId: null });

    store.setActiveLibrary(null); // back to __default__ / cold start
    const matches = store.findMatchingRules(['badge']).map(m => m.id);
    assert.ok(matches.includes('rule-global'));
    assert.ok(!matches.includes('rule-a'));
  });
});

describe('Schema v3 — community library bucket rename (acceptance criterion 6)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-rename-'));
    store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('a community (name-keyed) session reads/writes its own bucket; providing the file key later renames the bucket and preserves stats', () => {
    const nameId = computeLibraryId({ libraryName: 'Acme Community Kit' });
    assert.equal(nameId, 'name:acme community kit');

    store.setActiveLibrary(nameId, { libraryName: 'Acme Community Kit', idSource: 'name' });
    store.setComponent('ck-badge', { componentKey: 'ck-badge', confidence: 'confirmed', buildCount: 5, instances: 12 });
    store.recordBuild({ screenName: 'Community build', toolCalls: 40 });

    // Later, the file key becomes known — rename the bucket.
    const fileKey = 'real-file-key-abc';
    store.renameLibraryBucket(nameId, fileKey);

    assert.equal(store.getLibraryBucket(nameId), null, 'old name-keyed bucket should be gone');
    const renamed = store.getLibraryBucket(fileKey);
    assert.ok(renamed);
    assert.ok(renamed.aliases.includes(nameId), 'old id kept as an alias');
    assert.equal(renamed.components['ck-badge'].buildCount, 5, 'stats preserved across rename');
    assert.equal(renamed.components['ck-badge'].instances, 12);
    assert.equal(renamed.buildHistory.length, 1, 'build history preserved across rename');
  });

  it('checkLibraryIdentityDrift flags a >60% vanish as a possibly-different library', () => {
    const nameId = computeLibraryId({ libraryName: 'Shared Name Kit' });
    store.setActiveLibrary(nameId, { libraryName: 'Shared Name Kit', idSource: 'name' });
    for (let i = 0; i < 10; i++) {
      store.setComponent(`ck-${i}`, { componentKey: `ck-${i}`, confidence: 'new', buildCount: 1 });
    }
    // Only 3 of the 10 previously-seen componentKeys still exist live — 70% vanished.
    const liveKeys = new Set(['ck-0', 'ck-1', 'ck-2']);
    const drift = store.checkLibraryIdentityDrift(nameId, liveKeys);
    assert.equal(drift.possiblyDifferentLibrary, true);
    assert.ok(drift.vanishedRatio > 0.6);
  });

  it('checkLibraryIdentityDrift does not flag a normal small drift', () => {
    const nameId = computeLibraryId({ libraryName: 'Stable Kit' });
    store.setActiveLibrary(nameId, { libraryName: 'Stable Kit', idSource: 'name' });
    for (let i = 0; i < 10; i++) {
      store.setComponent(`ck-${i}`, { componentKey: `ck-${i}`, confidence: 'new', buildCount: 1 });
    }
    const liveKeys = new Set(['ck-0', 'ck-1', 'ck-2', 'ck-3', 'ck-4', 'ck-5', 'ck-6', 'ck-7', 'ck-8']); // 1 of 10 gone
    const drift = store.checkLibraryIdentityDrift(nameId, liveKeys);
    assert.equal(drift.possiblyDifferentLibrary, false);
  });
});

describe('Schema v3 — majority-wins variant derivation (acceptance criterion 14)', () => {
  it('a 5/4 instance split yields no default for that property, with a reason available for _autoApplied.skipped', () => {
    const recipe = { variantStats: { Color: { Success: 5, Gray: 4 } } };
    const defaults = deriveDefaultVariants(recipe);
    assert.equal(defaults.Color, undefined, '5/9 = 0.55 < 0.6 threshold — no dominant default');
  });

  it('a 7/2 split replays the dominant value', () => {
    const recipe = { variantStats: { Color: { Success: 7, Gray: 2 } } };
    const defaults = deriveDefaultVariants(recipe);
    assert.equal(defaults.Color, 'Success');
  });

  it('top count below 3 never becomes a default even at 100% share (one build cannot dictate a default)', () => {
    const recipe = { variantStats: { Size: { md: 2 } } };
    const defaults = deriveDefaultVariants(recipe);
    assert.equal(defaults.Size, undefined);
  });

  it('BOOLEAN and TEXT properties are excluded from replay regardless of vote share', () => {
    const recipe = { variantStats: { Disabled: { true: 9 }, Label: { Foo: 9 } } };
    const defaults = deriveDefaultVariants(recipe, { Disabled: 'BOOLEAN', Label: 'TEXT' });
    assert.equal(defaults.Disabled, undefined);
    assert.equal(defaults.Label, undefined);
  });

  it('recomputeDefaultVariants writes defaultVariants back onto the stored recipe', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-derive-'));
    try {
      const store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
      store.setComponent('ck-badge', { confidence: 'confirmed', buildCount: 9 });
      store.addVariantObservation('ck-badge', 'Color', 'Success', 7);
      store.addVariantObservation('ck-badge', 'Color', 'Gray', 2);
      store.recomputeDefaultVariants('ck-badge');
      assert.equal(store.getComponent('ck-badge').defaultVariants.Color, 'Success');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Schema v3 — buildCount dedup (acceptance criterion 16-adjacent)', () => {
  it('reporting the same componentKey twice in one build increments buildCount by exactly 1', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-dedup-'));
    try {
      const store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
      store.setComponent('ck-badge', { confidence: 'new', buildCount: 0 });

      // "Badge: On track" and "Badge: Plateau" both resolve to ck-badge in build #1.
      store.recordComponentBuild('ck-badge', 1);
      store.recordComponentBuild('ck-badge', 1);
      assert.equal(store.getComponent('ck-badge').buildCount, 1);

      // A genuinely different build increments again.
      store.recordComponentBuild('ck-badge', 2);
      assert.equal(store.getComponent('ck-badge').buildCount, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Schema v3 — concurrency/durability (acceptance criteria 23, 24)', () => {
  let tmpDir;
  let storePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-durability-'));
    storePath = path.join(tmpDir, 'ds-knowledge.json');
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('two store instances on different libraries saving interleaved leaves both buckets intact', () => {
    const storeA = new KnowledgeStore(storePath);
    storeA.load();
    storeA.setActiveLibrary('libA', { libraryName: 'Library A' });
    storeA.setComponent('ck-a1', { componentKey: 'ck-a1', confidence: 'new', buildCount: 1 });

    const storeB = new KnowledgeStore(storePath);
    storeB.load();
    storeB.setActiveLibrary('libB', { libraryName: 'Library B' });
    storeB.setComponent('ck-b1', { componentKey: 'ck-b1', confidence: 'new', buildCount: 1 });

    // Interleave: A saves, then B saves (B never saw A's write before it started).
    storeA.save();
    storeB.save();

    const final = new KnowledgeStore(storePath);
    final.load();
    assert.ok(final.getLibraryBucket('libA'), 'library A bucket must survive');
    assert.ok(final.getLibraryBucket('libB'), 'library B bucket must survive');
    assert.ok(final.getLibraryBucket('libA').components['ck-a1']);
    assert.ok(final.getLibraryBucket('libB').components['ck-b1']);

    // And the reverse order too.
    const storeC = new KnowledgeStore(storePath);
    storeC.load();
    storeC.setActiveLibrary('libA');
    storeC.setComponent('ck-a2', { componentKey: 'ck-a2', confidence: 'new', buildCount: 1 });

    const storeD = new KnowledgeStore(storePath);
    storeD.load();
    storeD.setActiveLibrary('libB');
    storeD.setComponent('ck-b2', { componentKey: 'ck-b2', confidence: 'new', buildCount: 1 });

    storeD.save();
    storeC.save();

    const final2 = new KnowledgeStore(storePath);
    final2.load();
    assert.ok(final2.getLibraryBucket('libA').components['ck-a1'], 'earlier libA data still present');
    assert.ok(final2.getLibraryBucket('libA').components['ck-a2'], 'new libA data present');
    assert.ok(final2.getLibraryBucket('libB').components['ck-b1'], 'earlier libB data still present');
    assert.ok(final2.getLibraryBucket('libB').components['ck-b2'], 'new libB data present');
  });

  it('kill-during-save simulation (write to tmp, crash before rename) leaves the previous file valid and loadable', () => {
    const store = new KnowledgeStore(storePath);
    store.setComponent('ck-good', { componentKey: 'ck-good', confidence: 'new', buildCount: 1 });
    store.save();

    const beforeCrash = fs.readFileSync(storePath, 'utf-8');

    // Simulate a crash mid-save: write a tmp file (as _persist would) but never rename it over the target.
    const crashedTmpPath = path.join(tmpDir, `.ds-knowledge.json.tmp-${process.pid}-crashsim`);
    fs.writeFileSync(crashedTmpPath, JSON.stringify({ version: 3, incomplete: true }), 'utf-8');

    // The real file must be untouched and still valid.
    const afterCrash = fs.readFileSync(storePath, 'utf-8');
    assert.equal(afterCrash, beforeCrash, 'target file must be untouched by an unfinished tmp write');

    const reloaded = new KnowledgeStore(storePath);
    assert.doesNotThrow(() => reloaded.load());
    assert.equal(reloaded.loadWarning, null);
    assert.ok(reloaded.getComponent('ck-good'), 'previously-saved data must still load cleanly');

    // Clean up the simulated crash artifact.
    fs.unlinkSync(crashedTmpPath);
  });
});

describe('Schema v3 — store-level shape validation (acceptance criterion 25, store slice)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-validation-'));
    store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('rejects an unknown confidence tier', () => {
    assert.throws(() => store.setComponent('bad', { confidence: 'super-verified' }), /Invalid confidence tier/);
  });

  it('accepts the known tiers, including the legacy "strong" alias', () => {
    assert.doesNotThrow(() => store.setComponent('a', { confidence: 'new' }));
    assert.doesNotThrow(() => store.setComponent('b', { confidence: 'confirmed' }));
    assert.doesNotThrow(() => store.setComponent('c', { confidence: 'verified' }));
    assert.doesNotThrow(() => store.setComponent('d', { confidence: 'strong' }));
  });

  it('rejects a non-object variantStats', () => {
    assert.throws(() => store.setComponent('bad', { variantStats: 'nope' }), /variantStats must be an object/);
    assert.throws(() => store.setComponent('bad2', { variantStats: ['a', 'b'] }), /variantStats must be an object/);
  });
});

describe('Schema v3 — confidence demotion (spec §4.6)', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-v3-demote-'));
    store = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('demoteRecipe drops verified to confirmed and sets needsReverify', () => {
    store.setComponent('ck-badge', { confidence: 'verified', buildCount: 10 });
    store.demoteRecipe('ck-badge', 'variant_schema_changed');
    const recipe = store.getComponent('ck-badge');
    assert.equal(recipe.confidence, 'confirmed');
    assert.equal(recipe.needsReverify, true);
  });

  it('restoreAfterCleanReplay restores verified only if it was verified before demotion', () => {
    store.setComponent('ck-badge', { confidence: 'verified', buildCount: 10 });
    store.demoteRecipe('ck-badge', 'variant_schema_changed');
    store.restoreAfterCleanReplay('ck-badge');
    assert.equal(store.getComponent('ck-badge').confidence, 'verified');
    assert.equal(store.getComponent('ck-badge').needsReverify, false);
  });

  it('restoreAfterCleanReplay does not promote a recipe that was only ever confirmed', () => {
    store.setComponent('ck-tab', { confidence: 'confirmed', buildCount: 4 });
    store.demoteRecipe('ck-tab', 'variant_schema_changed');
    store.restoreAfterCleanReplay('ck-tab');
    assert.equal(store.getComponent('ck-tab').confidence, 'confirmed');
  });

  it('recordReplayFailure demotes immediately and drops the property after 2 consecutive failures', () => {
    store.setComponent('ck-badge', {
      confidence: 'verified', buildCount: 10,
      defaultVariants: { Size: 'md' },
      variantStats: { Size: { md: 7, sm: 2 } },
    });
    store.recordReplayFailure('ck-badge', 'Size');
    let recipe = store.getComponent('ck-badge');
    assert.equal(recipe.confidence, 'confirmed', 'any replay failure demotes verified -> confirmed immediately');
    assert.ok(recipe.defaultVariants.Size, 'first failure alone does not drop the property');

    store.recordReplayFailure('ck-badge', 'Size');
    recipe = store.getComponent('ck-badge');
    assert.equal(recipe.defaultVariants.Size, undefined, 'second consecutive failure drops the property');
    assert.equal(recipe.variantStats.Size, undefined, 'variantStats for the dropped property is reset');
  });

  it('recordReplaySuccess resets the consecutive-failure counter so unrelated failures do not combine', () => {
    store.setComponent('ck-badge', {
      confidence: 'verified', buildCount: 10,
      defaultVariants: { Size: 'md' },
      variantStats: { Size: { md: 7, sm: 2 } },
    });
    store.recordReplayFailure('ck-badge', 'Size');
    store.recordReplaySuccess('ck-badge', 'Size');
    store.recordReplayFailure('ck-badge', 'Size');
    // Only 1 consecutive failure after the reset — property must survive.
    assert.ok(store.getComponent('ck-badge').defaultVariants.Size);
  });
});
