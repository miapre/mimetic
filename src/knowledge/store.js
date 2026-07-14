'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

/**
 * Split a string into lowercase alphanumeric word tokens.
 * Used for whole-word rule matching — see findMatchingRules().
 */
function tokenize(str) {
  return (str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    dsFingerprint: null,
    components: {},
    patterns: {},
    gaps: {},
    rules: {},
    libraryFileKeys: {},
    buildHistory: [],
    signals: [],
    meta: {
      buildCount: 0,
      lastBuild: null,
      created: new Date().toISOString(),
    },
  };
}

class KnowledgeStore {
  /**
   * @param {string} filePath - Path to ds-knowledge.json
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = createEmptyStore();
    // Set when load() had to recover from a corrupt/unsupported-version file.
    // Not part of `this.data` — it's ephemeral, process-local operational
    // state, not knowledge to persist. Callers (mcp.js, mimic_status,
    // mimic_ai_knowledge_read) should surface this loudly to the user.
    this.loadWarning = null;
  }

  /**
   * Back up an unreadable/corrupt knowledge file and reset to a fresh
   * empty schema-v2 store. Never let a bad knowledge file prevent the
   * MCP server from starting — a build with no learning is recoverable,
   * a server that never connects is not.
   */
  _recoverFromCorruption(rawContent, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.filePath}.corrupt-${stamp}`;
    let backedUp = false;
    try {
      fs.writeFileSync(backupPath, rawContent, 'utf-8');
      backedUp = true;
    } catch { /* best effort — still proceed with a fresh store */ }

    this.data = createEmptyStore();
    this.loadWarning = {
      code: 'KNOWLEDGE_STORE_CORRUPT',
      reason,
      backupPath: backedUp ? backupPath : null,
      message: `⚠ Knowledge store at ${this.filePath} could not be loaded (${reason}). ` +
        (backedUp
          ? `The unreadable file was backed up to ${backupPath}. `
          : `A backup could not be written. `) +
        `Starting with a fresh knowledge store — previously learned components, ` +
        `patterns, and rules are unavailable unless recovered manually from the backup.`,
    };

    // Persist the fresh store immediately so a restart doesn't re-trigger
    // recovery (and re-write a new backup) against the same bad file.
    try { this.save(); } catch { /* non-fatal — in-memory store still usable */ }

    return this;
  }

  /** Load existing store from disk. Creates empty store if file missing. */
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        return this._recoverFromCorruption(raw, `invalid JSON: ${parseErr.message}`);
      }
      if (!parsed || parsed.version !== SCHEMA_VERSION) {
        return this._recoverFromCorruption(raw, `unsupported schema version: ${parsed && parsed.version}`);
      }
      this.data = parsed;
      // Backfill new fields for existing stores
      if (!this.data.libraryFileKeys) this.data.libraryFileKeys = {};
      if (!this.data.buildHistory) this.data.buildHistory = [];
      if (!this.data.rules) this.data.rules = {};
      if (!this.data.signals) this.data.signals = [];
      // Backfill confidence on components that predate the promotion system
      for (const comp of Object.values(this.data.components || {})) {
        if (!comp.confidence) comp.confidence = 'new';
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = createEmptyStore();
      } else {
        throw err;
      }
    }
    return this;
  }

  /** Persist current state to disk. Atomic: write to a temp file, then rename over the target. */
  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
    return this;
  }

  // ── Components ──────────────────────────────────────────────

  setComponent(name, recipe) {
    this.data.components[name] = {
      ...recipe,
      lastUsed: new Date().toISOString(),
    };
    return this;
  }

  getComponent(name) {
    return this.data.components[name] || null;
  }

  // ── Patterns ────────────────────────────────────────────────

  setPattern(name, pattern) {
    this.data.patterns[name] = {
      ...pattern,
      lastUsed: new Date().toISOString(),
    };
    return this;
  }

  getPattern(name) {
    return this.data.patterns[name] || null;
  }

  // ── Gaps ────────────────────────────────────────────────────

  addGap(name, gap) {
    const existing = this.data.gaps[name];
    if (existing) {
      // Merge elements (deduplicated)
      const merged = new Set([...existing.elements, ...gap.elements]);
      existing.elements = [...merged];
      existing.evidence = gap.evidence || existing.evidence;
      existing.estimatedSavings = gap.estimatedSavings || existing.estimatedSavings;
      existing.lastSeen = new Date().toISOString();
    } else {
      this.data.gaps[name] = {
        ...gap,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
    }
    return this;
  }

  getGaps() {
    return { ...this.data.gaps };
  }

  // ── Rules ───────────────────────────────────────────────────
  // User-defined design rules that persist across builds.
  // Categories: color, variable, structure, component, spacing.
  // Rules are injected into build tool responses so the LLM
  // follows them automatically.

  /**
   * Add or update a design rule.
   * @param {string} id - Unique rule ID (e.g. "color-brand-links-only")
   * @param {{ category: string, rule: string, reason?: string, scope?: string }} ruleData
   */
  setRule(id, ruleData) {
    if (!this.data.rules) this.data.rules = {};
    this.data.rules[id] = {
      ...ruleData,
      createdAt: this.data.rules[id]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this;
  }

  getRule(id) {
    return this.data.rules?.[id] || null;
  }

  removeRule(id) {
    if (this.data.rules) delete this.data.rules[id];
    return this;
  }

  /**
   * Get all rules, optionally filtered by category.
   * @param {string} [category] - Filter by category (color, variable, structure, component, spacing)
   * @returns {Object} Map of id → rule
   */
  getRules(category) {
    const rules = this.data.rules || {};
    if (!category) return { ...rules };
    const filtered = {};
    for (const [id, rule] of Object.entries(rules)) {
      if (rule.category === category) filtered[id] = rule;
    }
    return filtered;
  }

  /**
   * Find rules relevant to a given context. Matches by:
   * - scope word-token match against context keywords
   * - category match
   * - rule text word-token match against any context keyword
   *
   * Uses whole-word (token) matching, not substring matching — a keyword
   * like "tab" must never match rule text mentioning "table". Keywords
   * that are themselves multi-word phrases (e.g. "card header") still
   * match when ALL of their words appear as whole tokens in the scope or
   * rule text, so multi-word phrase matching keeps working.
   *
   * Only considers ACTIVE rules (same eligibility as getActiveRules()):
   * user-defined rules (no `source`) are always eligible; auto-compiled
   * candidates (`source` set) are only eligible once `status === 'active'`.
   * Candidate and dismissed auto-compiled rules must never be injected
   * into build tool responses as if they were confirmed guidance.
   *
   * @param {string[]} keywords - Context words (e.g., ['card', 'revenue', 'badge'])
   * @param {string} [category] - Optional category filter
   * @returns {Array<{id: string, rule: string, category: string, reason?: string}>}
   */
  findMatchingRules(keywords, category) {
    const rules = this.getActiveRules();
    const keywordTokenSets = keywords
      .map(k => tokenize(k))
      .filter(toks => toks.length > 0);
    const matches = [];
    for (const [id, r] of Object.entries(rules)) {
      if (category && r.category !== category) continue;
      const scopeTokens = new Set(tokenize(r.scope));
      const ruleTokens = new Set(tokenize(r.rule));
      const hit = keywordTokenSets.some(toks => {
        // Multi-word keyword: match as a phrase — all its words must appear
        // as whole tokens in the same field (scope or rule text).
        if (toks.length > 1) {
          return toks.every(t => scopeTokens.has(t)) || toks.every(t => ruleTokens.has(t));
        }
        // Single-word keyword: whole-token match anywhere in scope or rule text.
        return scopeTokens.has(toks[0]) || ruleTokens.has(toks[0]);
      });
      if (hit) matches.push({ id, rule: r.rule, category: r.category, reason: r.reason });
    }
    return matches;
  }

  // ── Library File Keys ──────────────────────────────────────

  setLibraryFileKey(libraryName, fileKey) {
    if (!this.data.libraryFileKeys) this.data.libraryFileKeys = {};
    this.data.libraryFileKeys[libraryName] = fileKey;
    return this;
  }

  getLibraryFileKey(libraryName) {
    return this.data.libraryFileKeys?.[libraryName] || null;
  }

  // ── Build History ───────────────────────────────────────────

  /**
   * Record a build snapshot for cross-build comparison.
   * Keeps the last 20 entries to avoid unbounded growth.
   */
  recordBuild({ screenName, toolCalls, cacheHits, replaySavings, componentCount, primitiveCount, bindingFailures, componentUsagePercent }) {
    if (!this.data.buildHistory) this.data.buildHistory = [];
    this.data.buildHistory.push({
      screenName,
      buildNumber: this.data.meta.buildCount + 1,
      date: new Date().toISOString(),
      toolCalls: toolCalls || 0,
      cacheHits: cacheHits || 0,
      replaySavings: replaySavings || 0,
      componentCount: componentCount || 0,
      primitiveCount: primitiveCount || 0,
      bindingFailures: bindingFailures || 0,
      componentUsagePercent: componentUsagePercent || 0,
    });
    // Keep only last 20 builds
    if (this.data.buildHistory.length > 20) {
      this.data.buildHistory = this.data.buildHistory.slice(-20);
    }
    return this;
  }

  /** Returns build history array (most recent last). */
  getBuildHistory() {
    return this.data.buildHistory || [];
  }

  // ── Signals ─────────────────────────────────────────────────

  addSignal({ type, key, context, buildNumber }) {
    if (!this.data.signals) this.data.signals = [];
    const dedupKey = `${type}:${key}:${buildNumber}`;
    const exists = this.data.signals.some(
      s => `${s.type}:${s.key}:${s.buildNumber}` === dedupKey
    );
    if (exists) return this;
    this.data.signals.push({
      type, key, context, buildNumber,
      date: new Date().toISOString(),
    });
    if (this.data.signals.length > 200) {
      this.data.signals = this.data.signals.slice(-200);
    }
    return this;
  }

  getSignals() {
    return this.data.signals || [];
  }

  evictOldSignals(currentBuildNumber) {
    if (!this.data.signals) return this;
    const cutoff = currentBuildNumber - 20;
    this.data.signals = this.data.signals.filter(s => s.buildNumber > cutoff);
    return this;
  }

  // ── Staleness ───────────────────────────────────────────────

  markRecipeStale(key, reason) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    recipe.stale = true;
    recipe.staleReason = reason;
    recipe.staleAt = new Date().toISOString();
    return this;
  }

  clearRecipeStale(key) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    delete recipe.stale;
    delete recipe.staleReason;
    delete recipe.staleAt;
    return this;
  }

  getActiveRules() {
    const rules = this.data.rules || {};
    const active = {};
    for (const [id, rule] of Object.entries(rules)) {
      if (!rule.source) { active[id] = rule; continue; }
      if (rule.status === 'active') { active[id] = rule; }
    }
    return active;
  }

  checkStaleness(dsComponentKeys, dsVariantProperties) {
    const results = [];
    for (const [key, recipe] of Object.entries(this.data.components)) {
      if (!recipe.componentKey) continue;
      if (recipe.stale) continue;

      if (!dsComponentKeys.has(recipe.componentKey)) {
        this.markRecipeStale(key, 'component_removed');
        results.push({ key, names: recipe.names || [], reason: 'component_removed' });
        continue;
      }

      if (recipe.defaultVariants && dsVariantProperties[recipe.componentKey]) {
        const currentProps = Object.keys(dsVariantProperties[recipe.componentKey]);
        const storedProps = Object.keys(recipe.defaultVariants);
        const missing = storedProps.filter(p => !currentProps.includes(p));
        if (missing.length > 0) {
          this.markRecipeStale(key, 'variants_changed');
          results.push({ key, names: recipe.names || [], reason: 'variants_changed' });
        }
      }
    }
    return results;
  }

  // ── Meta ────────────────────────────────────────────────────

  incrementBuildCount() {
    this.data.meta.buildCount += 1;
    this.data.meta.lastBuild = new Date().toISOString();
    return this;
  }

  setFingerprint(fingerprint) {
    this.data.dsFingerprint = fingerprint;
    return this;
  }
}

module.exports = { KnowledgeStore };
