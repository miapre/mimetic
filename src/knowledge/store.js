'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

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
  }

  /** Load existing store from disk. Creates empty store if file missing. */
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported schema version: ${parsed.version}`);
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

  /** Persist current state to disk. */
  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
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
   * - scope substring match against context keywords
   * - category match
   * - rule text containing any context keyword
   *
   * @param {string[]} keywords - Context words (e.g., ['card', 'revenue', 'badge'])
   * @param {string} [category] - Optional category filter
   * @returns {Array<{id: string, rule: string, category: string, reason?: string}>}
   */
  findMatchingRules(keywords, category) {
    const rules = this.data.rules || {};
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    const matches = [];
    for (const [id, r] of Object.entries(rules)) {
      if (category && r.category !== category) continue;
      const scope = (r.scope || '').toLowerCase();
      const ruleText = (r.rule || '').toLowerCase();
      const hit = lowerKeywords.some(k =>
        scope.includes(k) || ruleText.includes(k)
      );
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
