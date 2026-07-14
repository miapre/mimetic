'use strict';

/**
 * Shared word-boundary / whole-name matching helpers.
 *
 * Schema v3 spec §5.3 (and defects E/F/R) require recipe/component-name
 * matching that is NOT naive substring containment — `.includes()` matches
 * "tab" inside "table", "button" inside "radio button", and "card" as a
 * prefix of "card header". All three are real false-positive bugs (findings
 * E, F, R; acceptance criteria 18, 19).
 *
 * The fix used throughout the learning-store-facing matchers (recipe lookup
 * in src/ds/discovery.js, the component-first gate in src/tools/build.js,
 * insertion-name resolution in src/tools/learning.js) is WHOLE-NAME equality
 * after normalization — not "is a token of" but "equals, ignoring case/
 * punctuation/whitespace". This is intentionally stricter than the tokenized
 * phrase matching in store.js's findMatchingRules (which matches design
 * RULES against context keywords, a different and more permissive use case
 * that store.js already owns and this module does not touch).
 *
 * Fuzzy/scored substring search (discovery.js tier 3 — the raw DS cache
 * search) is explicitly NOT covered by this module; that tier keeps its
 * existing substring-with-scoring behavior per spec §5.3 tier 3.
 */

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-name match: true iff `term` and `name` are equal once both are
 * normalized (case-insensitive, punctuation/whitespace collapsed). This is
 * what "word-boundary" means in this codebase's matchers — it deliberately
 * rejects "button" ~ "radio button" and "card" ~ "card header", which plain
 * substring/token-containment checks would wrongly accept.
 */
function wordBoundaryMatch(term, name) {
  const t = normalizeForMatch(term);
  const n = normalizeForMatch(name);
  if (!t || !n) return false;
  return t === n;
}

/**
 * True iff `term` whole-name-matches `name`, OR `name` whole-name-matches
 * any of `aliases`. Convenience for matching against a recipe's names[] list
 * or a set of generated search-term aliases.
 */
function wordBoundaryMatchAny(term, candidates) {
  const t = normalizeForMatch(term);
  if (!t) return false;
  return (candidates || []).some((c) => normalizeForMatch(c) === t);
}

module.exports = { normalizeForMatch, wordBoundaryMatch, wordBoundaryMatchAny };
