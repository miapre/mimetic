const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PatternMatcher, CONFIRMED_THRESHOLD, VERIFIED_THRESHOLD } = require('../../../src/knowledge/patterns');

describe('PatternMatcher', () => {
  it('promotes new → confirmed after CONFIRMED_THRESHOLD builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: CONFIRMED_THRESHOLD - 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'new');
    pattern.buildCount = CONFIRMED_THRESHOLD;
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'confirmed');
    assert.equal(promoted.source, 'auto_promoted');
  });

  it('promotes confirmed → verified after VERIFIED_THRESHOLD builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'confirmed', buildCount: VERIFIED_THRESHOLD - 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'confirmed');
    pattern.buildCount = VERIFIED_THRESHOLD;
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
    assert.equal(promoted.source, 'auto_promoted');
  });

  it('promotes new → verified if buildCount jumps past both thresholds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: VERIFIED_THRESHOLD + 5 };
    // new with 12 builds should go straight to verified via the >= VERIFIED check
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
  });

  it('does not demote verified patterns', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'verified', buildCount: 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'verified');
  });

  it('user correction sets confidence to confirmed', () => {
    const matcher = new PatternMatcher();
    const result = matcher.applyCorrection({ confidence: 'new', buildCount: 1 });
    assert.equal(result.confidence, 'confirmed');
    assert.equal(result.source, 'user_correction');
  });

  it('user confirmation sets confidence to verified', () => {
    const matcher = new PatternMatcher();
    const result = matcher.applyConfirmation({ confidence: 'new', buildCount: 1 });
    assert.equal(result.confidence, 'verified');
    assert.equal(result.source, 'user_confirmed');
  });

  it('legacy strong confidence gets promoted to verified at threshold', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'strong', buildCount: VERIFIED_THRESHOLD };
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
  });

  // ── Pattern demotion (spec §4.6 / §5.4 item 8) ──────────────────────
  describe('demote', () => {
    it('demotes verified to confirmed and re-captures layoutConfig from the corrected build', () => {
      const matcher = new PatternMatcher();
      const pattern = { confidence: 'verified', buildCount: 10, layoutConfig: { gap: 8, padding: 16 } };
      const corrected = { gap: 16, padding: 24 };
      const demoted = matcher.demote(pattern, corrected, 12);

      assert.equal(demoted.confidence, 'confirmed');
      assert.deepEqual(demoted.layoutConfig, corrected);
    });

    it('keeps the previous layoutConfig in layoutConfigHistory, capped at 3', () => {
      const matcher = new PatternMatcher();
      let pattern = { confidence: 'verified', layoutConfig: { gap: 1 } };
      pattern = matcher.demote(pattern, { gap: 2 }, 1);
      pattern = matcher.demote(pattern, { gap: 3 }, 2);
      pattern = matcher.demote(pattern, { gap: 4 }, 3);
      pattern = matcher.demote(pattern, { gap: 5 }, 4);

      assert.equal(pattern.layoutConfig.gap, 5);
      assert.equal(pattern.layoutConfigHistory.length, 3, 'capped at 3 per spec §3.3/§3.5');
      // Oldest entry (gap: 1, from build null since it predates any demotion) should have been evicted.
      const gaps = pattern.layoutConfigHistory.map(h => h.config.gap);
      assert.deepEqual(gaps, [2, 3, 4]);
    });

    it('does not mutate the original pattern object', () => {
      const matcher = new PatternMatcher();
      const pattern = { confidence: 'verified', layoutConfig: { gap: 1 } };
      matcher.demote(pattern, { gap: 2 }, 1);
      assert.equal(pattern.confidence, 'verified', 'original object must be untouched');
      assert.equal(pattern.layoutConfig.gap, 1);
    });

    it('a confirmed (never-verified) pattern stays confirmed after demotion', () => {
      const matcher = new PatternMatcher();
      const pattern = { confidence: 'confirmed', layoutConfig: { gap: 1 } };
      const demoted = matcher.demote(pattern, { gap: 2 }, 1);
      assert.equal(demoted.confidence, 'confirmed');
    });
  });
});
