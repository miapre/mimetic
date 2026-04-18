/**
 * Mimic AI — Component Inserter
 *
 * DS-agnostic component insertion via learned mappings.
 * Reads component keys from RESOLUTION_RULES.json — never hardcodes them.
 * Resolves variants by inspecting componentProperties dynamically.
 *
 * Usage:
 *   import { createInserter } from './component-inserter.js';
 *   const inserter = createInserter(bridgeCallFn, dsFileKey);
 *   const result = await inserter.resolveAndInsert(parentId, intent, text);
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Detect if a text string looks like an interactive element (button, link).
 * Returns intent object or null. DS-agnostic — pattern-based on text content.
 */
function detectInteractive(text, context = {}) {
  if (!text) return null;
  var t = text.trim();
  // Arrow suffix → link
  if (t.endsWith('\u2192') || t.endsWith('\u203A') || t.endsWith('\u00BB')) {
    return { type: 'action', role: 'secondary', variant: 'link', confidence: 0.9 };
  }
  // Common action verbs
  if (t.match(/^(View|See|Browse|Copy|Download|Share|Edit|Delete|Remove|Dismiss)\b/i)) {
    return { type: 'action', role: 'secondary', variant: 'link', confidence: 0.8 };
  }
  // Short text that looks like a button label
  if (t.length <= 25 && t.match(/^(Copy|Save|Submit|Cancel|Confirm|Apply|Close|Undo|Retry)$/i)) {
    return { type: 'action', role: 'secondary', variant: 'secondary', confidence: 0.85 };
  }
  // CTA-like text
  if (t.match(/^(Get started|Try|Start|Create|Run|Import|Install|Connect|Enable)/i)) {
    return { type: 'action', role: 'primary', variant: 'primary', confidence: 0.8 };
  }
  return null;
}

const __dir = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dir, '..', 'learning', 'RESOLUTION_RULES.json');
const KNOWLEDGE_PATH = resolve(__dir, '..', 'ds-knowledge', 'ds-knowledge-normalized.json');

/**
 * Load DS component mappings from learned rules.
 * Returns a map of intent → { key, fileKey, name }.
 */
function loadMappings() {
  if (!existsSync(RULES_PATH)) return {};
  try {
    const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
    const mappings = {};
    for (const rule of (rules.ds_mappings || [])) {
      if (!rule.component_key) continue;
      // Map by semantic role, not by name
      const id = rule.id;
      if (id === 'DS-MAP-003') mappings['action'] = { key: rule.component_key, name: rule.component };
      if (id === 'DS-MAP-004') mappings['badge'] = { key: rule.component_key, name: rule.component };
      if (id === 'DS-MAP-006') mappings['action:utility'] = { key: rule.component_key, name: rule.component };
      if (id === 'DS-MAP-002') mappings['input'] = { key: rule.component_key, name: rule.component };
      if (id === 'DS-MAP-007') mappings['tab'] = { key: rule.component_key, name: rule.component };
      if (id === 'DS-MAP-001') mappings['navigation'] = { key: rule.component_key, name: rule.component };
    }
    return mappings;
  } catch { return {}; }
}

/**
 * Discover DS components from the knowledge layer by semantic category.
 * Used when no learned mapping exists for an intent.
 *
 * Searches componentSets by inferredCategory (from DS knowledge normalization).
 * Returns the best match based on category + name pattern scoring.
 *
 * @param {string} semanticCategory — e.g., 'progress', 'checkbox', 'unknown'
 * @param {string[]} nameHints — optional name fragments to score against
 * @returns {Object|null} { key, name } or null
 */
function discoverFromKnowledge(semanticCategory, nameHints = []) {
  if (!existsSync(KNOWLEDGE_PATH)) return null;
  let knowledge;
  try { knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8')); } catch { return null; }

  const candidates = [];

  // Search component sets by inferred category
  for (const set of knowledge.componentSets) {
    let score = 0;

    // Category match (from DS knowledge normalization — NOT hardcoded)
    if (set.inferredCategory === semanticCategory) score += 3;

    // Name hint matching (generic structural terms, not DS-specific names)
    for (const hint of nameHints) {
      if (set.name.toLowerCase().includes(hint.toLowerCase())) score += 2;
    }

    // Prefer sets with variant axes (richer, more likely to be real components)
    if (Object.keys(set.variantAxes).length > 0) score += 1;

    // Prefer sets with properties from API (verified structure)
    if (Object.keys(set.properties).length > 0) score += 1;

    if (score >= 3) {
      candidates.push({ key: set.key, name: set.name, score, category: set.inferredCategory });
    }
  }

  // Also search standalone components if no sets match
  if (candidates.length === 0) {
    for (const comp of knowledge.standaloneComponents) {
      let score = 0;
      if (comp.inferredCategory === semanticCategory) score += 3;
      for (const hint of nameHints) {
        if (comp.name.toLowerCase().includes(hint.toLowerCase())) score += 2;
      }
      if (score >= 3) {
        candidates.push({ key: comp.key, name: comp.name, score, category: comp.inferredCategory });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, return best
  candidates.sort((a, b) => b.score - a.score);
  return { key: candidates[0].key, name: candidates[0].name, confidence: candidates[0].score >= 5 ? 'high' : 'medium' };
}

// Semantic category → search hints mapping (DS-agnostic structural terms)
const CATEGORY_HINTS = {
  'progress': { category: 'progress', hints: ['progress', 'bar'] },
  'selectable': { category: 'checkbox', hints: ['checkbox', 'check'] },
  'selectable:group-item': { category: 'checkbox', hints: ['checkbox group', 'check item'] },
  'list-item:activity': { category: 'unknown', hints: ['activity item', 'activity'] },
  'list-item:check': { category: 'unknown', hints: ['check item'] },
  'list-item': { category: 'unknown', hints: ['item', 'list item'] },
};

/**
 * Create a component inserter bound to a bridge call function.
 *
 * @param {Function} callBridge — async function(type, params) for bridge calls
 * @param {string} dsFileKey — design system library file key (from config, not hardcoded)
 * @returns {Object} inserter with resolveAndInsert, insertAction, insertBadge methods
 */
export function createInserter(callBridge, dsFileKey) {
  const mappings = loadMappings();

  /**
   * Insert a DS component by semantic intent.
   * Resolves component from learned mappings, configures variants dynamically.
   *
   * @param {string} parentId
   * @param {string} intentType — 'action', 'badge', 'input', 'tab', etc.
   * @param {Object} config — { text, role, size } for variant resolution
   * @returns {Object|null} insertion result or null (fallback)
   */
  async function resolveAndInsert(parentId, intentType, config = {}) {
    // Step 1: Check learned mappings (RESOLUTION_RULES.json)
    let mapping = mappings[intentType];

    // Step 2: If no learned mapping, discover from DS knowledge layer
    if (!mapping) {
      const categoryInfo = CATEGORY_HINTS[intentType];
      if (categoryInfo) {
        const discovered = discoverFromKnowledge(categoryInfo.category, categoryInfo.hints);
        if (discovered && discovered.confidence !== 'low') {
          mapping = { key: discovered.key, name: discovered.name };
        }
      }
    }

    if (!mapping) return null; // No mapping found via either path

    try {
      const result = await callBridge('insert_component', {
        componentKey: mapping.key,
        fileKey: dsFileKey,
        parentId,
      });

      // Set text if available
      if (config.text) {
        try {
          await callBridge('set_component_text', { nodeId: result.nodeId, property: 'Label', value: config.text });
        } catch (e) {
          // Try other common text property names
          for (const prop of ['Text', 'Title', 'label', 'text']) {
            try { await callBridge('set_component_text', { nodeId: result.nodeId, property: prop, value: config.text }); break; } catch (_) {}
          }
        }
      }

      // Determine if this component should fill its parent
      const fillIntents = ['selectable', 'selectable:group-item', 'list-item', 'list-item:activity', 'list-item:check', 'progress'];
      if (fillIntents.includes(intentType)) {
        config.fillParent = true;
      }

      // Resolve variants dynamically by inspecting component properties
      const configReport = await configureVariants(callBridge, result.nodeId, config);
      result.configReport = configReport;

      return result;
    } catch (e) {
      return null; // Component insertion failed — caller should fallback
    }
  }

  /**
   * Detect if text is interactive and insert appropriate DS component.
   * Falls back to null if detection confidence is low or insertion fails.
   */
  async function resolveText(parentId, text) {
    const interactive = detectInteractive(text);
    if (!interactive || interactive.confidence < 0.8) return null;

    const cleanText = text.replace(/\s*[→›»]\s*$/, '').trim();
    const config = {
      text: cleanText,
      role: interactive.variant || interactive.role,
      hasIcon: text.includes('→') || text.includes('›'), // Arrow suggests trailing icon intent
    };

    return resolveAndInsert(parentId, 'action', config);
  }

  return { resolveAndInsert, resolveText, mappings, discoverFromKnowledge };
}


/**
 * Configure component instance dynamically after insertion.
 *
 * Inspects componentProperties to understand available axes,
 * then maps intent config to property values using semantic inference.
 *
 * Also handles:
 * - Instance sizing (fill/hug based on context)
 * - Icon slot detection
 * - Boolean property configuration
 *
 * @param {Function} callBridge
 * @param {string} nodeId
 * @param {Object} config — { role, size, text, fillParent, intentType }
 * @returns {Object} configReport — what was configured and what remains unresolved
 */
async function configureVariants(callBridge, nodeId, config) {
  const report = { configured: [], unresolved: [], iconSlots: [] };

  // Get component properties
  let props;
  try {
    const info = await callBridge('get_node_props', { nodeId });
    props = info.componentProperties || [];
  } catch { return report; }

  // Parse properties into structured map
  // key format: "PropertyName#nodeId" → extract name before #
  const propMap = {};
  for (const p of props) {
    const rawKey = p.key || '';
    const propName = rawKey.includes('#') ? rawKey.split('#')[0] : rawKey;
    const nameLower = propName.toLowerCase();
    propMap[nameLower] = { ...p, propName, rawKey };
  }

  // ── HIERARCHY / TYPE / STYLE (maps to role) ──
  if (config.role) {
    const roleValues = {
      'primary': ['Primary', 'primary', 'Filled', 'filled'],
      'secondary': ['Secondary', 'secondary', 'Outlined', 'outlined', 'Tertiary color'],
      'link': ['Link', 'link', 'Text', 'text', 'Tertiary', 'tertiary'],
      'tertiary': ['Tertiary', 'tertiary', 'Ghost', 'ghost'],
    };
    const targets = roleValues[config.role] || [config.role];

    for (const [name, prop] of Object.entries(propMap)) {
      if (prop.type !== 'VARIANT') continue;
      if (name.includes('hierarch') || name.includes('type') || name.includes('style') || name.includes('emphasis')) {
        for (const target of targets) {
          try {
            await callBridge('set_variant', { nodeId, property: prop.propName, value: target });
            report.configured.push({ property: prop.propName, value: target, reason: 'role:' + config.role });
            break;
          } catch (_) { continue; }
        }
        break;
      }
    }
  }

  // ── SIZE ──
  if (config.size) {
    for (const [name, prop] of Object.entries(propMap)) {
      if (prop.type !== 'VARIANT') continue;
      if (name.includes('size')) {
        try {
          await callBridge('set_variant', { nodeId, property: prop.propName, value: config.size });
          report.configured.push({ property: prop.propName, value: config.size, reason: 'size' });
        } catch (_) {}
        break;
      }
    }
  }

  // ── STATE (default to Default/default) ──
  for (const [name, prop] of Object.entries(propMap)) {
    if (prop.type !== 'VARIANT') continue;
    if (name.includes('state')) {
      const current = prop.value;
      if (current && !['Default', 'default', 'Rest', 'rest', 'Normal'].includes(current)) {
        try {
          await callBridge('set_variant', { nodeId, property: prop.propName, value: 'Default' });
          report.configured.push({ property: prop.propName, value: 'Default', reason: 'state_normalization' });
        } catch (_) {}
      }
      break;
    }
  }

  // ── BOOLEAN PROPERTIES (icon presence, etc.) ──
  for (const [name, prop] of Object.entries(propMap)) {
    if (prop.type !== 'BOOLEAN') continue;

    // Detect icon slots
    if (name.includes('icon')) {
      report.iconSlots.push({ property: prop.propName, current: prop.value });

      // If no icon content available, disable icon visibility
      if (!config.hasIcon) {
        try {
          await callBridge('set_variant', { nodeId, property: prop.propName, value: false });
          report.configured.push({ property: prop.propName, value: false, reason: 'no_icon_content' });
        } catch (_) {
          report.unresolved.push({ property: prop.propName, reason: 'icon_disable_failed' });
        }
      }
    }
  }

  // ── INSTANCE SIZING ──
  // Components inserted into auto-layout parents should fill cross-axis when appropriate
  if (config.fillParent) {
    try {
      await callBridge('set_layout_sizing', { nodeId, layoutSizingHorizontal: 'FILL' });
      report.configured.push({ property: 'layoutSizingHorizontal', value: 'FILL', reason: 'fill_parent' });
    } catch (_) {
      report.unresolved.push({ property: 'sizing', reason: 'fill_failed' });
    }
  }

  // ── HUG HEIGHT for list items (don't keep fixed height) ──
  if (config.fillParent) {
    try {
      await callBridge('set_layout_sizing', { nodeId, layoutSizingVertical: 'HUG' });
      report.configured.push({ property: 'layoutSizingVertical', value: 'HUG', reason: 'hug_height' });
    } catch (_) {}
  }

  return report;
}
