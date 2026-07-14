'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { KnowledgeStore } = require('../../src/knowledge/store');

describe('Staleness Detection', () => {
  let store;

  beforeEach(() => {
    const tmpPath = path.join(os.tmpdir(), `staleness-test-${Date.now()}.json`);
    store = new KnowledgeStore(tmpPath);
    store.load();
  });

  it('markRecipeStale sets stale flag and reason', () => {
    store.setComponent('comp-key-1', { names: ['Badge'], confidence: 'confirmed', buildCount: 5 });
    store.markRecipeStale('comp-key-1', 'component_removed');
    const recipe = store.getComponent('comp-key-1');
    assert.equal(recipe.stale, true);
    assert.equal(recipe.staleReason, 'component_removed');
    assert.ok(recipe.staleAt);
  });

  it('markRecipeStale is a no-op for missing recipe', () => {
    store.markRecipeStale('nonexistent', 'component_removed');
    assert.equal(store.getComponent('nonexistent'), null);
  });

  it('clearRecipeStale removes stale fields', () => {
    store.setComponent('comp-key-1', { names: ['Badge'], confidence: 'confirmed', buildCount: 5, stale: true, staleReason: 'variants_changed', staleAt: '2026-01-01' });
    store.clearRecipeStale('comp-key-1');
    const recipe = store.getComponent('comp-key-1');
    assert.equal(recipe.stale, undefined);
    assert.equal(recipe.staleReason, undefined);
    assert.equal(recipe.staleAt, undefined);
  });

  it('getActiveRules filters out candidate and dismissed rules', () => {
    store.setRule('user-rule', { category: 'color', rule: 'Always use brand for links' });
    store.setRule('auto-rule-candidate', { category: 'variable', rule: 'No bg as stroke', source: 'auto_compiled', status: 'candidate' });
    store.setRule('auto-rule-dismissed', { category: 'variable', rule: 'Dismissed rule', source: 'auto_compiled', status: 'dismissed' });
    store.setRule('auto-rule-active', { category: 'variable', rule: 'Promoted rule', source: 'auto_compiled', status: 'active' });
    const active = store.getActiveRules();
    const ids = Object.keys(active);
    assert.ok(ids.includes('user-rule'));
    assert.ok(ids.includes('auto-rule-active'));
    assert.ok(!ids.includes('auto-rule-candidate'));
    assert.ok(!ids.includes('auto-rule-dismissed'));
  });

  it('checkStaleness detects orphaned recipes', () => {
    store.setComponent('comp-key-1', { names: ['Badge'], confidence: 'confirmed', buildCount: 5, componentKey: 'comp-key-1' });
    store.setComponent('comp-key-2', { names: ['Button'], confidence: 'verified', buildCount: 10, componentKey: 'comp-key-2' });
    const dsComponentKeys = new Set(['comp-key-2']);
    const staleResults = store.checkStaleness(dsComponentKeys, {});
    assert.equal(staleResults.length, 1);
    assert.equal(staleResults[0].key, 'comp-key-1');
    assert.equal(staleResults[0].reason, 'component_removed');
    const recipe = store.getComponent('comp-key-1');
    assert.equal(recipe.stale, true);
  });

  it('checkStaleness detects drifted variant structure', () => {
    store.setComponent('comp-key-1', {
      names: ['Badge'], confidence: 'confirmed', buildCount: 5, componentKey: 'comp-key-1',
      defaultVariants: { Color: 'Success', Size: 'Small' },
    });
    const dsComponentKeys = new Set(['comp-key-1']);
    const dsVariantProperties = { 'comp-key-1': { Color: ['Success', 'Warning', 'Error'] } };
    const staleResults = store.checkStaleness(dsComponentKeys, dsVariantProperties);
    assert.equal(staleResults.length, 1);
    assert.equal(staleResults[0].reason, 'variants_changed');
  });

  it('checkStaleness skips recipes without componentKey', () => {
    store.setComponent('display-name-only', { names: ['Chip'], confidence: 'confirmed', buildCount: 3 });
    const staleResults = store.checkStaleness(new Set(), {});
    assert.equal(staleResults.length, 0);
  });

  it('checkStaleness skips already-stale recipes', () => {
    store.setComponent('comp-key-1', { names: ['Badge'], confidence: 'confirmed', buildCount: 5, componentKey: 'comp-key-1', stale: true, staleReason: 'component_removed' });
    const staleResults = store.checkStaleness(new Set(), {});
    assert.equal(staleResults.length, 0);
  });
});
