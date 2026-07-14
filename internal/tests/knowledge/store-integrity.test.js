'use strict';

/**
 * Regression tests for the "Report integrity" and "Knowledge store safety"
 * bug fixes:
 *
 * - findMatchingRules: word-boundary (token) matching instead of bare
 *   .includes() substring matching, so "tab" never phantom-matches "table".
 * - findMatchingRules: only ACTIVE rules are eligible — candidate/dismissed
 *   auto-compiled rules must never be injected into build tool responses.
 * - save(): atomic write (temp file + rename), no partial/corrupt writes.
 * - load(): corrupt JSON / unsupported schema version recovers instead of
 *   throwing — backs up the bad file, resets to a fresh v3 store, and
 *   surfaces a loud loadWarning instead of bricking the MCP server.
 */

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { KnowledgeStore } = require('../../../src/knowledge/store');

describe('KnowledgeStore — word-boundary rule matching', () => {
  let tmpPath;
  let store;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `store-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    store = new KnowledgeStore(tmpPath);
  });

  afterEach(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  it('"tab" keyword does NOT match a rule that only mentions "table"', () => {
    store.setRule('table-rule', {
      category: 'structure',
      rule: 'Tables must use DS Table cell components, never primitives',
      scope: 'table',
    });
    const matches = store.findMatchingRules(['tab']);
    assert.equal(matches.length, 0, '"tab" must not phantom-match "table" via substring');
  });

  it('"tab" keyword DOES match a rule that actually mentions tabs', () => {
    store.setRule('tabs-rule', {
      category: 'component',
      rule: 'Tabs must always use the DS Tabs component',
      scope: 'tab',
    });
    const matches = store.findMatchingRules(['tab']);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, 'tabs-rule');
  });

  it('real single-word phrase matching still works (scope)', () => {
    store.setRule('card-rule', { category: 'structure', rule: 'Cards need headers', scope: 'card, panel' });
    const matches = store.findMatchingRules(['card']);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, 'card-rule');
  });

  it('real single-word phrase matching still works (rule text, no scope)', () => {
    store.setRule('rule-1', { category: 'structure', rule: 'Every card must have a header', scope: '' });
    const matches = store.findMatchingRules(['card']);
    assert.equal(matches.length, 1);
  });

  it('multi-word keyword phrase matches when all its words appear as whole tokens', () => {
    store.setRule('card-header-rule', {
      category: 'component',
      rule: 'Card header: always enable Supporting text boolean',
      scope: 'card header',
    });
    const matches = store.findMatchingRules(['card header']);
    assert.equal(matches.length, 1, 'multi-word phrase keyword should still match');
  });

  it('multi-word keyword phrase does NOT match when only some words are present', () => {
    store.setRule('card-only-rule', { category: 'structure', rule: 'Cards need a footer only', scope: 'card' });
    // "card header" as a keyword requires BOTH "card" and "header" as whole
    // tokens in the same field — this rule only has "card".
    const matches = store.findMatchingRules(['card header']);
    assert.equal(matches.length, 0);
  });

  it('category filter still applies alongside token matching', () => {
    store.setRule('card-structure', { category: 'structure', rule: 'Cards need headers', scope: 'card' });
    store.setRule('card-color', { category: 'color', rule: 'Card accents use brand color', scope: 'card' });
    const structureMatches = store.findMatchingRules(['card'], 'structure');
    assert.equal(structureMatches.length, 1);
    assert.equal(structureMatches[0].id, 'card-structure');
  });

  it('no keywords returns nothing', () => {
    store.setRule('r', { category: 'structure', rule: 'Cards need headers', scope: 'card' });
    assert.equal(store.findMatchingRules([]).length, 0);
  });
});

describe('KnowledgeStore — findMatchingRules only returns active rules', () => {
  let tmpPath;
  let store;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `store-integrity-active-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    store = new KnowledgeStore(tmpPath);
  });

  afterEach(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  it('a dismissed auto-compiled rule is never returned', () => {
    store.setRule('dismissed-rule', {
      category: 'variable', rule: 'No bg as stroke ever', scope: 'badge',
      source: 'auto_compiled', status: 'dismissed',
    });
    assert.equal(store.findMatchingRules(['badge']).length, 0);
  });

  it('a candidate (not yet promoted) auto-compiled rule is never returned', () => {
    store.setRule('candidate-rule', {
      category: 'variable', rule: 'No bg as stroke ever', scope: 'badge',
      source: 'auto_compiled', status: 'candidate',
    });
    assert.equal(store.findMatchingRules(['badge']).length, 0);
  });

  it('an active auto-compiled rule IS returned', () => {
    store.setRule('active-rule', {
      category: 'variable', rule: 'No bg as stroke ever', scope: 'badge',
      source: 'auto_compiled', status: 'active',
    });
    const matches = store.findMatchingRules(['badge']);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, 'active-rule');
  });

  it('a plain user-defined rule (no source/status) is always returned', () => {
    store.setRule('user-rule', { category: 'structure', rule: 'Cards always have Card Header', scope: 'card' });
    const matches = store.findMatchingRules(['card']);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, 'user-rule');
  });

  it('candidate/dismissed rules are excluded even when mixed with active/user rules matching the same keyword', () => {
    store.setRule('user-rule', { category: 'component', rule: 'Badge default color is Success', scope: 'badge' });
    store.setRule('active-rule', { category: 'component', rule: 'Badge must show status text', scope: 'badge', source: 'auto_compiled', status: 'active' });
    store.setRule('candidate-rule', { category: 'component', rule: 'Badge should be larger', scope: 'badge', source: 'auto_compiled', status: 'candidate' });
    store.setRule('dismissed-rule', { category: 'component', rule: 'Badge should be red', scope: 'badge', source: 'auto_compiled', status: 'dismissed' });
    const matches = store.findMatchingRules(['badge']);
    const ids = matches.map(m => m.id).sort();
    assert.deepEqual(ids, ['active-rule', 'user-rule']);
  });
});

describe('KnowledgeStore — atomic save', () => {
  let tmpDir;
  let tmpPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-atomic-'));
    tmpPath = path.join(tmpDir, 'ds-knowledge.json');
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('writes valid, complete JSON and leaves no leftover temp files', () => {
    const store = new KnowledgeStore(tmpPath);
    store.setComponent('button-primary', { componentKey: 'k1', buildCount: 1, confidence: 'new' });
    store.save();

    const raw = fs.readFileSync(tmpPath, 'utf-8');
    const parsed = JSON.parse(raw); // must not throw — file is complete, valid JSON
    // v3 shape: recipes live under libraries.<activeLibraryId>.components,
    // not at the top level (see schema-v3-spec.md §3.3).
    assert.equal(parsed.libraries.__default__.components['button-primary'].componentKey, 'k1');

    const dirEntries = fs.readdirSync(tmpDir);
    const tempLeftovers = dirEntries.filter(f => f.includes('.tmp-'));
    assert.deepEqual(tempLeftovers, [], 'no .tmp- files should remain after save()');
  });

  it('repeated saves each produce a fully valid file (no partial-write races)', () => {
    const store = new KnowledgeStore(tmpPath);
    for (let i = 0; i < 10; i++) {
      store.setComponent(`comp-${i}`, { componentKey: `k${i}`, buildCount: i, confidence: 'new' });
      store.save();
      const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
      assert.equal(Object.keys(parsed.libraries.__default__.components).length, i + 1);
    }
  });
});

describe('KnowledgeStore — corrupt file recovery', () => {
  let tmpDir;
  let tmpPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-corrupt-'));
    tmpPath = path.join(tmpDir, 'ds-knowledge.json');
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('invalid JSON: backs up the bad file, resets to a fresh v3 store, surfaces a loadWarning', () => {
    fs.writeFileSync(tmpPath, '{ this is not valid json !!!', 'utf-8');
    const store = new KnowledgeStore(tmpPath);

    assert.doesNotThrow(() => store.load());
    assert.equal(store.data.version, 3);
    assert.deepEqual(store.data.components, {});
    assert.ok(store.loadWarning, 'loadWarning should be set');
    assert.equal(store.loadWarning.code, 'KNOWLEDGE_STORE_CORRUPT');
    assert.match(store.loadWarning.message, /could not be loaded/i);

    assert.ok(store.loadWarning.backupPath, 'backupPath should be set');
    assert.ok(fs.existsSync(store.loadWarning.backupPath), 'backup file should exist on disk');
    const backupContent = fs.readFileSync(store.loadWarning.backupPath, 'utf-8');
    assert.equal(backupContent, '{ this is not valid json !!!');
  });

  it('unsupported schema version: backs up the bad file, resets to a fresh v3 store, surfaces a loadWarning', () => {
    const badData = { version: 999, components: { keep: 'me' } };
    fs.writeFileSync(tmpPath, JSON.stringify(badData), 'utf-8');
    const store = new KnowledgeStore(tmpPath);

    assert.doesNotThrow(() => store.load());
    assert.equal(store.data.version, 3);
    assert.deepEqual(store.data.components, {});
    assert.ok(store.loadWarning);
    assert.match(store.loadWarning.message, /unsupported schema version/i);
    assert.ok(fs.existsSync(store.loadWarning.backupPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(store.loadWarning.backupPath, 'utf-8')), badData);
  });

  it('the fresh store is persisted immediately, so a second load of the same path does not re-trigger recovery', () => {
    fs.writeFileSync(tmpPath, 'not json at all', 'utf-8');
    const store1 = new KnowledgeStore(tmpPath);
    store1.load();
    assert.ok(store1.loadWarning);

    const backupsAfterFirstLoad = fs.readdirSync(tmpDir).filter(f => f.includes('.corrupt-'));
    assert.equal(backupsAfterFirstLoad.length, 1);

    // Fresh store instance re-reading the same (now-recovered) path.
    const store2 = new KnowledgeStore(tmpPath);
    store2.load();
    assert.equal(store2.loadWarning, null, 'second load of the recovered file should be clean');

    // No additional backup should have been created.
    const backupsAfterSecondLoad = fs.readdirSync(tmpDir).filter(f => f.includes('.corrupt-'));
    assert.equal(backupsAfterSecondLoad.length, 1);
  });

  it('a missing file (ENOENT) still creates a fresh store with no warning (not a corruption case)', () => {
    const store = new KnowledgeStore(tmpPath); // never written
    assert.doesNotThrow(() => store.load());
    assert.equal(store.data.version, 3);
    assert.equal(store.loadWarning, null);
  });
});
