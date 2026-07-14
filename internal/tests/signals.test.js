'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KnowledgeStore } = require('../../src/knowledge/store');

describe('Signal Store', () => {
  let store;
  let tmpPath;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `signals-test-${Date.now()}.json`);
    store = new KnowledgeStore(tmpPath);
    store.load();
  });

  it('addSignal appends to signals array', () => {
    store.addSignal({ type: 'category_mismatch', key: 'bg-secondary->stroke', context: 'test', buildNumber: 1 });
    assert.equal(store.getSignals().length, 1);
    assert.equal(store.getSignals()[0].type, 'category_mismatch');
    assert.equal(store.getSignals()[0].key, 'bg-secondary->stroke');
    assert.ok(store.getSignals()[0].date);
  });

  it('addSignal deduplicates within same buildNumber', () => {
    store.addSignal({ type: 'category_mismatch', key: 'bg-secondary->stroke', context: 'first', buildNumber: 1 });
    store.addSignal({ type: 'category_mismatch', key: 'bg-secondary->stroke', context: 'second', buildNumber: 1 });
    assert.equal(store.getSignals().length, 1);
  });

  it('addSignal allows same key in different builds', () => {
    store.addSignal({ type: 'category_mismatch', key: 'bg-secondary->stroke', context: 'build1', buildNumber: 1 });
    store.addSignal({ type: 'category_mismatch', key: 'bg-secondary->stroke', context: 'build2', buildNumber: 2 });
    assert.equal(store.getSignals().length, 2);
  });

  it('caps at 200 entries, evicts oldest', () => {
    for (let i = 0; i < 210; i++) {
      store.addSignal({ type: 'gate_hit', key: `pattern-${i}`, context: 'fill', buildNumber: i });
    }
    assert.equal(store.getSignals().length, 200);
    assert.equal(store.getSignals()[0].key, 'pattern-10');
  });

  it('evictOldSignals removes signals older than 20 builds', () => {
    store.addSignal({ type: 'gate_hit', key: 'old', context: 'old', buildNumber: 1 });
    store.addSignal({ type: 'gate_hit', key: 'recent', context: 'recent', buildNumber: 20 });
    store.evictOldSignals(22);
    const signals = store.getSignals();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].key, 'recent');
  });

  it('persists signals through save/load cycle', () => {
    store.addSignal({ type: 'binding_failure', key: 'missing-var', context: 'test', buildNumber: 5 });
    store.save();
    const store2 = new KnowledgeStore(tmpPath);
    store2.load();
    assert.equal(store2.getSignals().length, 1);
    assert.equal(store2.getSignals()[0].key, 'missing-var');
    fs.unlinkSync(tmpPath);
  });

  it('backfills empty signals array on load of old store', () => {
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 2, components: {}, patterns: {}, gaps: {}, rules: {}, meta: { buildCount: 0, lastBuild: null, created: new Date().toISOString() } }));
    const store2 = new KnowledgeStore(tmpPath);
    store2.load();
    assert.deepEqual(store2.getSignals(), []);
    fs.unlinkSync(tmpPath);
  });
});
