'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileNoGoods } = require('../../src/knowledge/compiler');

describe('No-Good Compiler', () => {
  it('returns empty array when no signals cross threshold', () => {
    const signals = [
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 1 },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 2 },
    ];
    const result = compileNoGoods(signals, {});
    assert.equal(result.candidates.length, 0);
  });

  it('compiles candidate when signal appears in 3 distinct builds', () => {
    const signals = [
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 1, context: 'ctx1' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 2, context: 'ctx2' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 3, context: 'ctx3' },
    ];
    const result = compileNoGoods(signals, {});
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].status, 'candidate');
    assert.equal(result.candidates[0].source, 'auto_compiled');
    assert.ok(result.candidates[0].id.startsWith('auto-'));
    assert.ok(result.candidates[0].rule.length > 0);
    assert.deepEqual(result.candidates[0].compiledFrom, ['bg-secondary->stroke']);
  });

  it('skips compilation when active rule already exists for same key', () => {
    const signals = [
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 1, context: 'ctx' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 2, context: 'ctx' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 3, context: 'ctx' },
    ];
    const existingRules = {
      'auto-category_mismatch-bg-secondary--stroke': {
        status: 'active', source: 'auto_compiled', compiledFrom: ['bg-secondary->stroke'],
      },
    };
    const result = compileNoGoods(signals, existingRules);
    assert.equal(result.candidates.length, 0);
  });

  it('skips compilation when dismissed rule exists for same key', () => {
    const signals = [
      { type: 'gate_hit', key: 'badge', buildNumber: 1, context: 'ctx' },
      { type: 'gate_hit', key: 'badge', buildNumber: 2, context: 'ctx' },
      { type: 'gate_hit', key: 'badge', buildNumber: 3, context: 'ctx' },
    ];
    const existingRules = {
      'auto-gate_hit-badge': {
        status: 'dismissed', source: 'auto_compiled', compiledFrom: ['badge'],
      },
    };
    const result = compileNoGoods(signals, existingRules);
    assert.equal(result.candidates.length, 0);
  });

  it('marks auto-promotion when candidate has 6+ distinct builds', () => {
    const signals = [];
    for (let i = 1; i <= 6; i++) {
      signals.push({ type: 'binding_failure', key: 'missing-var-path', buildNumber: i, context: `build ${i}` });
    }
    const existingRules = {
      'auto-binding_failure-missing-var-path': {
        status: 'candidate', source: 'auto_compiled', compiledFrom: ['missing-var-path'],
      },
    };
    const result = compileNoGoods(signals, existingRules);
    assert.equal(result.promotions.length, 1);
    assert.equal(result.promotions[0], 'auto-binding_failure-missing-var-path');
  });

  it('generates correct rule text for category_mismatch', () => {
    const signals = [
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 1, context: 'ctx' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 2, context: 'ctx' },
      { type: 'category_mismatch', key: 'bg-secondary->stroke', buildNumber: 3, context: 'ctx' },
    ];
    const result = compileNoGoods(signals, {});
    assert.ok(result.candidates[0].rule.includes('bg-secondary'));
    assert.ok(result.candidates[0].rule.includes('stroke'));
    assert.equal(result.candidates[0].category, 'variable');
  });

  it('generates correct rule text for gate_hit', () => {
    const signals = [
      { type: 'gate_hit', key: 'badge', buildNumber: 1, context: 'ctx' },
      { type: 'gate_hit', key: 'badge', buildNumber: 2, context: 'ctx' },
      { type: 'gate_hit', key: 'badge', buildNumber: 3, context: 'ctx' },
    ];
    const result = compileNoGoods(signals, {});
    assert.ok(result.candidates[0].rule.includes('badge'));
    assert.equal(result.candidates[0].category, 'component');
  });

  it('generates correct rule text for binding_failure', () => {
    const signals = [
      { type: 'binding_failure', key: 'border-brand-500', buildNumber: 1, context: 'ctx' },
      { type: 'binding_failure', key: 'border-brand-500', buildNumber: 2, context: 'ctx' },
      { type: 'binding_failure', key: 'border-brand-500', buildNumber: 3, context: 'ctx' },
    ];
    const result = compileNoGoods(signals, {});
    assert.ok(result.candidates[0].rule.includes('border-brand-500'));
    assert.equal(result.candidates[0].category, 'variable');
  });

  // ── Spec §5.4 fix: category map to actually-emitted categories, and ──
  // propose a variable that actually exists via an injected suggestVariable
  // callback instead of guessing a prefix via string surgery (finding 5).
  describe('category_mismatch — real emitted categories + suggestVariable injection', () => {
    it('with a suggestVariable callback: proposes a variable that exists in the active DS cache', () => {
      // key shape as actually produced by mcp.js: "<wrongly-used variable>-><expected category>"
      const signals = [
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 1, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 2, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 3, context: 'ctx' },
      ];
      const suggestVariable = (path, category) => {
        assert.equal(category, 'border');
        return ['border-primary'];
      };
      const result = compileNoGoods(signals, {}, { suggestVariable });
      assert.equal(result.candidates.length, 1);
      assert.ok(result.candidates[0].rule.includes('bg-primary'));
      assert.ok(result.candidates[0].rule.includes('border-primary'), 'rule should name a variable that actually exists');
      assert.ok(!result.candidates[0].rule.includes('Check available variables'), 'should not fall back to the generic message when a suggestion exists');
    });

    it('without a suggestVariable callback: falls back to naming the category, not a fabricated guess', () => {
      const signals = [
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 1, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 2, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-primary->border', buildNumber: 3, context: 'ctx' },
      ];
      const result = compileNoGoods(signals, {}); // no opts — backward compatible with the existing 2-arg call site
      assert.ok(result.candidates[0].rule.includes('bg-primary'));
      assert.ok(result.candidates[0].rule.includes('border'));
      // Should not claim a specific variable exists when nothing could confirm it.
      assert.ok(!/Use border-[a-z-]+ instead\./.test(result.candidates[0].rule));
    });

    it('with a suggestVariable callback that finds no match: says so rather than fabricating a suggestion', () => {
      const signals = [
        { type: 'category_mismatch', key: 'bg-weird->radius', buildNumber: 1, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-weird->radius', buildNumber: 2, context: 'ctx' },
        { type: 'category_mismatch', key: 'bg-weird->radius', buildNumber: 3, context: 'ctx' },
      ];
      const suggestVariable = () => [];
      const result = compileNoGoods(signals, {}, { suggestVariable });
      assert.ok(result.candidates[0].rule.includes('bg-weird'));
      assert.ok(result.candidates[0].rule.includes('radius'));
      assert.ok(!/Use radius-[a-z-]+ instead\./.test(result.candidates[0].rule));
    });

    it('covers all five actually-emitted categories (border/background/text/spacing/radius)', () => {
      for (const category of ['border', 'background', 'text', 'spacing', 'radius']) {
        const key = `some-var->${category}`;
        const signals = [1, 2, 3].map(n => ({ type: 'category_mismatch', key, buildNumber: n, context: 'ctx' }));
        const result = compileNoGoods(signals, {});
        assert.ok(result.candidates[0].rule.includes(category), `rule should mention the ${category} category`);
      }
    });
  });
});
