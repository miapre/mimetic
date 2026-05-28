'use strict';

const COMPILE_THRESHOLD = 3;
const AUTO_PROMOTE_THRESHOLD = 6;

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function generateRule(type, key, buildNumbers) {
  const id = `auto-${type}-${sanitizeKey(key)}`;
  const buildList = buildNumbers.sort((a, b) => a - b).join(', ');

  switch (type) {
    case 'category_mismatch': {
      const parts = key.split('->');
      const variable = parts[0] || key;
      const wrongCategory = parts[1] || 'unknown';
      const suffix = variable.replace(/^[^-]+-/, '');
      const suggestedPrefix = wrongCategory === 'stroke' ? 'border'
        : wrongCategory === 'text' ? 'text'
        : wrongCategory === 'background' ? 'bg'
        : null;
      const suggestion = suggestedPrefix ? `${suggestedPrefix}-${suffix}` : null;
      return {
        id,
        category: 'variable',
        rule: suggestion
          ? `Never use ${variable} as a ${wrongCategory} variable. Use ${suggestion} instead.`
          : `Never use ${variable} as a ${wrongCategory} variable. Check available variables after discovery.`,
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

function compileNoGoods(signals, existingRules) {
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
      const rule = generateRule(group.type, group.key, [...group.buildNumbers]);
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
