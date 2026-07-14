'use strict';

const CONFIRMED_THRESHOLD = 3;
const VERIFIED_THRESHOLD = 7;

class PatternMatcher {
  /**
   * Auto-promote confidence through three tiers:
   *   new → confirmed (3+ builds)
   *   confirmed → verified (7+ builds)
   * Returns the (possibly promoted) pattern — does NOT mutate the original.
   */
  maybePromote(pattern) {
    const result = { ...pattern };
    if (result.buildCount >= VERIFIED_THRESHOLD && (result.confidence === 'new' || result.confidence === 'confirmed' || result.confidence === 'strong')) {
      if (result.confidence !== 'verified') {
        result.confidence = 'verified';
        result.source = 'auto_promoted';
        result.promotedAt = new Date().toISOString();
      }
    } else if (result.buildCount >= CONFIRMED_THRESHOLD && result.confidence === 'new') {
      result.confidence = 'confirmed';
      result.source = 'auto_promoted';
      result.promotedAt = new Date().toISOString();
    }
    return result;
  }

  /**
   * Apply a user correction — immediately sets confidence to 'confirmed'.
   * User corrections are strong signal but not verified (need more builds).
   */
  applyCorrection(pattern, source = 'user_correction') {
    return {
      ...pattern,
      confidence: 'confirmed',
      source,
      correctedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply a confirmation (user explicitly confirms a pattern is correct).
   * Immediately sets to 'verified' — highest tier.
   */
  applyConfirmation(pattern) {
    return {
      ...pattern,
      confidence: 'verified',
      source: 'user_confirmed',
      confirmedAt: new Date().toISOString(),
    };
  }

  /**
   * Increment usage count on a pattern.
   */
  incrementUsage(pattern) {
    return {
      ...pattern,
      buildCount: (pattern.buildCount || 0) + 1,
      lastUsed: new Date().toISOString(),
    };
  }

  /**
   * Demote a layout pattern in reaction to a user correction (spec §4.6):
   * a correction is detected when the same build later explicitly re-sets a
   * replayed property on >=2 instances of the prefix. verified demotes to
   * confirmed. The pattern re-captures `layoutConfig` from the corrected
   * build, keeping the previous config in `layoutConfigHistory` (cap 3) so
   * the reconciliation can be inspected/reverted.
   *
   * @param {object} pattern - The existing stored pattern
   * @param {object} correctedConfig - The layout config observed in the
   *   build that corrected the replayed value (becomes the new layoutConfig)
   * @param {number} [buildNumber] - Build number the correction happened in
   */
  demote(pattern, correctedConfig, buildNumber) {
    const result = { ...pattern };
    const history = Array.isArray(result.layoutConfigHistory) ? [...result.layoutConfigHistory] : [];
    if (result.layoutConfig) {
      history.push({ config: result.layoutConfig, buildNumber: buildNumber ?? null });
    }
    result.layoutConfigHistory = history.slice(-3);
    if (correctedConfig) result.layoutConfig = correctedConfig;
    if (result.confidence === 'verified') result.confidence = 'confirmed';
    result.demotedAt = new Date().toISOString();
    return result;
  }
}

module.exports = { PatternMatcher, CONFIRMED_THRESHOLD, VERIFIED_THRESHOLD };
