const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KnowledgeStore } = require('../../../src/knowledge/store');

describe('KnowledgeStore', () => {
  let tmpDir;
  let TEST_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-store-test-'));
    TEST_PATH = path.join(tmpDir, 'ds-knowledge.json');
  });

  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('creates new store with correct v3 schema', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.save();
    const data = JSON.parse(fs.readFileSync(TEST_PATH, 'utf-8'));
    assert.equal(data.version, 3);
    assert.ok(data.rules);
    assert.ok(data.libraries);
    assert.ok(data.meta);
  });

  it('loads existing v3 store, active bucket defaults to __default__', () => {
    fs.writeFileSync(TEST_PATH, JSON.stringify({
      version: 3,
      meta: { created: null, migratedFrom: null, lastCompaction: null },
      rules: {},
      libraryFileKeys: {},
      libraries: {
        __default__: {
          libraryName: null, libraryFileKey: null, idSource: 'legacy', aliases: [],
          fingerprint: null, dsFingerprint: 'abc',
          components: { btn: { componentKey: 'k1' } },
          patterns: {}, gaps: {}, buildHistory: [], manifests: [], signals: [],
          meta: { buildCount: 5, lastBuild: null, created: null },
        },
      },
    }));
    const store = new KnowledgeStore(TEST_PATH);
    store.load();
    assert.equal(store.data.meta.buildCount, 5);
    assert.equal(store.data.components.btn.componentKey, 'k1');
  });

  it('saves component recipe', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setComponent('button-primary', {
      componentKey: 'abc123',
      variant: { Size: 'md', Hierarchy: 'Primary' },
      confidence: 'strong',
      buildCount: 1,
    });
    store.save();
    const reloaded = new KnowledgeStore(TEST_PATH);
    reloaded.load();
    assert.equal(reloaded.data.components['button-primary'].componentKey, 'abc123');
  });

  it('rejects an unknown confidence tier on setComponent', () => {
    const store = new KnowledgeStore(TEST_PATH);
    assert.throws(() => {
      store.setComponent('bad', { confidence: 'super-verified' });
    }, /Invalid confidence tier/);
  });

  it('rejects a non-object variantStats on setComponent', () => {
    const store = new KnowledgeStore(TEST_PATH);
    assert.throws(() => {
      store.setComponent('bad', { confidence: 'new', variantStats: ['not', 'an', 'object'] });
    }, /variantStats must be an object/);
  });

  it('stores and retrieves library file keys', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setLibraryFileKey('Test Theme', 'testFileKey123abc');
    assert.equal(store.getLibraryFileKey('Test Theme'), 'testFileKey123abc');
    assert.equal(store.getLibraryFileKey('Unknown'), null);
  });

  it('persists library file keys across save/load', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setLibraryFileKey('Acme Design System', 'abc123');
    store.save();
    const store2 = new KnowledgeStore(TEST_PATH);
    store2.load();
    assert.equal(store2.getLibraryFileKey('Acme Design System'), 'abc123');
  });

  it('records build history', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.recordBuild({ screenName: 'Dashboard', toolCalls: 120, cacheHits: 5, componentCount: 8, primitiveCount: 3, bindingFailures: 1, componentUsagePercent: 73 });
    store.recordBuild({ screenName: 'Settings', toolCalls: 80, cacheHits: 15, componentCount: 10, primitiveCount: 2, bindingFailures: 0, componentUsagePercent: 83 });
    const history = store.getBuildHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].screenName, 'Dashboard');
    assert.equal(history[0].toolCalls, 120);
    assert.equal(history[1].toolCalls, 80);
  });

  it('caps build history at 50 entries per library (spec §3.5)', () => {
    const store = new KnowledgeStore(TEST_PATH);
    for (let i = 0; i < 55; i++) {
      store.recordBuild({ screenName: `Screen ${i}`, toolCalls: 100 - i, cacheHits: i, componentCount: 5, primitiveCount: 2, bindingFailures: 0, componentUsagePercent: 71 });
    }
    assert.equal(store.getBuildHistory().length, 50);
    assert.equal(store.getBuildHistory()[0].screenName, 'Screen 5');
  });

  it('persists build history across save/load', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.recordBuild({ screenName: 'Test', toolCalls: 50, cacheHits: 10, componentCount: 4, primitiveCount: 1, bindingFailures: 0, componentUsagePercent: 80 });
    store.save();
    const store2 = new KnowledgeStore(TEST_PATH);
    store2.load();
    assert.equal(store2.getBuildHistory().length, 1);
    assert.equal(store2.getBuildHistory()[0].screenName, 'Test');
  });

  it('tracks gap evidence', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.addGap('tab-component', {
      evidence: 'Built as primitive',
      elements: ['nav tabs'],
      estimatedSavings: { toolCalls: 6 },
    });
    assert.ok(store.data.gaps['tab-component']);
    assert.equal(store.data.gaps['tab-component'].elements.length, 1);
    assert.equal(store.data.gaps['tab-component'].status, 'open');
  });
});
