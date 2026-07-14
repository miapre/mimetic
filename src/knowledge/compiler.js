'use strict';

const COMPILE_THRESHOLD = 3;
const AUTO_PROMOTE_THRESHOLD = 6;

// Categories actually emitted by DsCache.validateVariables' category-mismatch
// detection (src/ds/cache.js expectedCategory values), plus the DS-variable
// naming prefix each one conventionally corresponds to. This replaces the old
// map, which checked for a category value ('stroke') that validateVariables
// never actually emits (it emits 'border') — the branch could never fire, so
// no-good rules for category mismatches always fell back to the generic
// "check available variables" message instead of naming a concrete fix.
const CATEGORY_PREFIX_HINT = {
  border: 'border',
  background: 'bg',
  text: 'text',
  spacing: 'spacing',
  radius: 'radius',
};

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/**
 * @param {'category_mismatch'|'binding_failure'|'gate_hit'|string} type
 * @param {string} key
 * @param {number[]} buildNumbers
 * @param {{ suggestVariable?: (path: string, category: string|null) => (string[]|string|null) }} [opts]
 *   `suggestVariable` is injected rather than imported (cache.js belongs to a
 *   different worker) so the compiler can propose a variable that actually
 *   exists in the active DS cache (spec §5.4) instead of guessing a prefix
 *   via string surgery. Optional — when absent, or when it returns no match,
 *   the rule says so explicitly rather than fabricating a suggestion.
 */
function generateRule(type, key, buildNumbers, opts = {}) {
  const { suggestVariable } = opts;
  const id = `auto-${type}-${sanitizeKey(key)}`;
  const buildList = buildNumbers.sort((a, b) => a - b).join(', ');

  switch (type) {
    case 'category_mismatch': {
      // key shape: "<variable>-><expectedCategory>" (the variable that was
      // WRONGLY used, and the category the property actually expected).
      const parts = key.split('->');
      const variable = parts[0] || key;
      const expectedCategory = parts[1] || 'unknown';
      const prefixHint = CATEGORY_PREFIX_HINT[expectedCategory] || null;

      let suggestion = null;
      if (typeof suggestVariable === 'function') {
        const stripped = variable.replace(/^[^-/]+-/, '');
        let results = suggestVariable(stripped, expectedCategory);
        if ((!results || (Array.isArray(results) && results.length === 0)) && stripped !== variable) {
          results = suggestVariable(variable, expectedCategory);
        }
        suggestion = Array.isArray(results) ? (results[0] || null) : (results || null);
      }

      const rule = suggestion
        ? `Never use ${variable} as a ${expectedCategory} variable. Use ${suggestion} instead.`
        : prefixHint
          ? `Never use ${variable} as a ${expectedCategory} variable. Use a ${prefixHint}-* variable instead — no existing variable could be automatically matched; check available ${prefixHint}-* variables after discovery.`
          : `Never use ${variable} as a ${expectedCategory} variable. Check available variables after discovery.`;

      return {
        id,
        category: 'variable',
        rule,
        reason: `Auto-compiled: failed in builds #${buildList}`,
      };
    }
    case 'binding_failure':
      return {
        id,
        category: 'variable',
        rule: `Variable path "${key}" does not exist in this DS. Verify after discovery or use an alternative.`,
        reason: `Auto-compiled: failed in builds #${buildList}`,
      };
    case 'gate_hit':
      return {
        id,
        category: 'component',
        rule: `"${key}" has a DS component. Always use figma_insert_component, never create as primitive.`,
        reason: `Auto-compiled: blocked in builds #${buildList}`,
      };
    default:
      return {
        id,
        category: 'variable',
        rule: `Recurring failure on "${key}". Review and correct.`,
        reason: `Auto-compiled: occurred in builds #${buildList}`,
      };
  }
}

/**
 * @param {Array<{type: string, key: string, buildNumber: number}>} signals
 * @param {Object} existingRules
 * @param {{ suggestVariable?: Function }} [opts] - see generateRule; optional,
 *   backward compatible with the existing 2-arg call site in learning.js.
 */
function compileNoGoods(signals, existingRules, opts = {}) {
  const groups = new Map();
  for (const s of signals) {
    const groupKey = `${s.type}:${s.key}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { type: s.type, key: s.key, buildNumbers: new Set() });
    }
    groups.get(groupKey).buildNumbers.add(s.buildNumber);
  }

  const coveredKeys = new Set();
  for (const [, rule] of Object.entries(existingRules)) {
    if (rule.compiledFrom) {
      for (const k of rule.compiledFrom) coveredKeys.add(k);
    }
  }

  const candidates = [];
  const promotions = [];

  for (const [, group] of groups) {
    const distinctBuilds = group.buildNumbers.size;

    const existingId = `auto-${group.type}-${sanitizeKey(group.key)}`;
    const existingRule = existingRules[existingId];
    if (existingRule && existingRule.status === 'candidate' && distinctBuilds >= AUTO_PROMOTE_THRESHOLD) {
      promotions.push(existingId);
      continue;
    }

    if (coveredKeys.has(group.key)) continue;

    if (distinctBuilds >= COMPILE_THRESHOLD) {
      const rule = generateRule(group.type, group.key, [...group.buildNumbers], opts);
      candidates.push({
        ...rule,
        source: 'auto_compiled',
        status: 'candidate',
        compiledFrom: [group.key],
        compiledAt: new Date().toISOString(),
      });
    }
  }

  return { candidates, promotions };
}

module.exports = { compileNoGoods, COMPILE_THRESHOLD, AUTO_PROMOTE_THRESHOLD };
