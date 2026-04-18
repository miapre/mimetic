/**
 * Mimic AI — Component Resolution Enforcement Layer
 *
 * Deterministic, auditable resolution system for HTML → DS component mapping.
 *
 * For EVERY HTML element, executes a strict 5-step pipeline:
 *   1. Intent Detection — what is this element?
 *   2. DS Discovery — what DS components could match?
 *   3. Variant Resolution — which variant is the correct match?
 *   4. Decision — DS component or primitive fallback?
 *   5. Validation — is the chosen component fully correct?
 *
 * Core rule: incorrect DS usage is worse than fallback.
 * If ANY step is uncertain, the system falls back to primitives.
 *
 * This module produces resolution decisions only.
 * It does NOT modify Figma, connect to MCP, or execute builds.
 *
 * Usage:
 *   import { resolveComponent, resolveAll } from './component-resolver.js';
 *   const decision = resolveComponent(htmlNode, dsInventory);
 *   const allDecisions = resolveAll(htmlNodes, dsInventory);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = resolve(__dir, '..', 'learning');
const RESOLUTION_LOG_PATH = resolve(LEARNING_DIR, 'resolution-patterns.json');

if (!existsSync(LEARNING_DIR)) mkdirSync(LEARNING_DIR, { recursive: true });


// ═════════════════════════════════════════════════════════════════════════════
// STEP 1 — INTENT DETECTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tag taxonomy — structural classification of HTML elements.
 * Maps tag names and attributes to structured intent.
 * Rule-based, not heuristic.
 */
const TAG_ROLES = {
  // Interactive
  button:   { type: 'action',  defaultRole: 'primary' },
  a:        { type: 'action',  defaultRole: 'secondary' },
  // Form
  input:    { type: 'input',   defaultRole: null },
  textarea: { type: 'input',   defaultRole: null },
  select:   { type: 'input',   defaultRole: null },
  // Text
  h1:       { type: 'text',    defaultRole: 'primary' },
  h2:       { type: 'text',    defaultRole: 'primary' },
  h3:       { type: 'text',    defaultRole: 'primary' },
  h4:       { type: 'text',    defaultRole: 'secondary' },
  h5:       { type: 'text',    defaultRole: 'secondary' },
  h6:       { type: 'text',    defaultRole: 'secondary' },
  p:        { type: 'text',    defaultRole: null },
  span:     { type: 'text',    defaultRole: null },
  label:    { type: 'text',    defaultRole: null },
  // Layout
  div:      { type: 'layout',  defaultRole: null },
  section:  { type: 'layout',  defaultRole: null },
  article:  { type: 'layout',  defaultRole: null },
  aside:    { type: 'layout',  defaultRole: null },
  main:     { type: 'layout',  defaultRole: null },
  header:   { type: 'layout',  defaultRole: 'primary' },
  footer:   { type: 'layout',  defaultRole: null },
  nav:      { type: 'layout',  defaultRole: 'primary' },
  // Table
  table:    { type: 'layout',  defaultRole: null },
  tr:       { type: 'layout',  defaultRole: null },
  td:       { type: 'layout',  defaultRole: null },
  th:       { type: 'text',    defaultRole: 'secondary' },
  // Media
  img:      { type: 'media',   defaultRole: null },
  svg:      { type: 'media',   defaultRole: 'decorative' },
  video:    { type: 'media',   defaultRole: null },
  // List
  ul:       { type: 'layout',  defaultRole: null },
  ol:       { type: 'layout',  defaultRole: null },
  li:       { type: 'layout',  defaultRole: null },
};

/**
 * Detect semantics from HTML attributes and context.
 */
function detectSemantics(node) {
  const semantics = [];
  const tag = node.tag?.toLowerCase();
  const attrs = node.attributes || {};
  const classes = (attrs.class || '').toLowerCase();
  const role = attrs.role?.toLowerCase();
  const type = attrs.type?.toLowerCase();
  const href = attrs.href;

  // Clickable
  if (tag === 'button' || tag === 'a' || role === 'button' || attrs.onclick) {
    semantics.push('clickable');
  }

  // Navigational
  if (tag === 'a' && href && !href.startsWith('#') && !href.startsWith('javascript')) {
    semantics.push('navigational');
  }
  if (tag === 'nav' || role === 'navigation') {
    semantics.push('navigational');
  }

  // Form-related
  if (['input', 'textarea', 'select'].includes(tag) || tag === 'form') {
    semantics.push('form');
  }
  if (type === 'password') semantics.push('auth');
  if (type === 'email') semantics.push('auth');
  if (type === 'search') semantics.push('search');

  // Label-like (short text on background)
  if (classes.includes('badge') || classes.includes('tag') || classes.includes('chip') ||
      classes.includes('pill') || classes.includes('label') || classes.includes('status')) {
    semantics.push('label');
  }

  // Tab-like
  if (classes.includes('tab') || role === 'tab' || role === 'tablist') {
    semantics.push('tab');
  }

  // Toggle / checkbox
  if (type === 'checkbox' || type === 'radio' || role === 'switch') {
    semantics.push('toggle');
  }

  // Icon
  if (tag === 'svg' || tag === 'img' || classes.includes('icon')) {
    semantics.push('icon');
  }

  // Modal / dialog
  if (role === 'dialog' || classes.includes('modal') || classes.includes('dialog')) {
    semantics.push('modal');
  }

  return semantics;
}

/**
 * Detect content type from node children.
 */
function detectContentType(node) {
  const hasText = node.textContent && node.textContent.trim().length > 0;
  const hasIcon = node.children?.some(c =>
    c.tag === 'svg' || c.tag === 'img' || (c.attributes?.class || '').includes('icon')
  );

  if (hasText && hasIcon) return 'mixed';
  if (hasIcon) return 'icon';
  if (hasText) return 'text';
  return 'empty';
}

/**
 * STEP 1: Detect intent from an HTML node.
 *
 * @param {Object} node — parsed HTML node
 *   { tag, attributes, textContent, children, computedStyles }
 * @returns {Object} structured intent
 */
export function detectIntent(node) {
  const tag = node.tag?.toLowerCase();
  const tagInfo = TAG_ROLES[tag] || { type: 'layout', defaultRole: null };
  const semantics = detectSemantics(node);
  const contentType = detectContentType(node);

  // Refine role based on semantics
  let role = tagInfo.defaultRole;
  if (semantics.includes('clickable') && !role) role = 'primary';
  if (semantics.includes('label')) role = 'decorative';
  if (semantics.includes('icon') && !semantics.includes('clickable')) role = 'decorative';

  return {
    type: tagInfo.type,
    role,
    semantics,
    contentType,
    tag,
    textContent: node.textContent?.trim()?.substring(0, 100) || null,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// STEP 2 — DS DISCOVERY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * DS component inventory entry schema:
 *
 * {
 *   name: string,
 *   key: string,
 *   supportedTypes: string[],     // ['action', 'input', ...]
 *   supportedRoles: string[],     // ['primary', 'secondary', ...]
 *   supportedSemantics: string[], // ['clickable', 'navigational', ...]
 *   variants: [{
 *     name: string,
 *     key: string,
 *     properties: { [propName]: { type, values, default } }
 *   }],
 *   structureRequirements: {
 *     minChildren: number,
 *     maxChildren: number,
 *     requiredSlots: string[],    // ['icon', 'text', ...]
 *   }
 * }
 */

/**
 * STEP 2: Discover candidate DS components for a given intent.
 *
 * @param {Object} intent — from detectIntent()
 * @param {Array} dsInventory — array of DS component entries
 * @returns {Array} candidate matches, scored
 */
export function discoverComponents(intent, dsInventory) {
  if (!dsInventory || dsInventory.length === 0) return [];

  const candidates = [];

  for (const component of dsInventory) {
    let score = 0;
    const reasons = [];

    // Type match (required — 0 score means no match)
    if (component.supportedTypes?.includes(intent.type)) {
      score += 3;
      reasons.push(`type:${intent.type}`);
    } else {
      continue; // Type mismatch is disqualifying
    }

    // Role match
    if (intent.role && component.supportedRoles?.includes(intent.role)) {
      score += 2;
      reasons.push(`role:${intent.role}`);
    }

    // Semantic match (each matching semantic adds score)
    for (const sem of intent.semantics) {
      if (component.supportedSemantics?.includes(sem)) {
        score += 1;
        reasons.push(`semantic:${sem}`);
      }
    }

    // Content type compatibility
    if (intent.contentType === 'mixed' &&
        component.structureRequirements?.requiredSlots?.includes('icon') &&
        component.structureRequirements?.requiredSlots?.includes('text')) {
      score += 1;
      reasons.push('contentType:mixed_supported');
    }

    if (score > 0) {
      candidates.push({
        component: component.name,
        componentKey: component.key,
        score,
        matchReasons: reasons,
        variants: component.variants || [],
        structureRequirements: component.structureRequirements || null,
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}


// ═════════════════════════════════════════════════════════════════════════════
// STEP 3 — VARIANT RESOLUTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a single variant against the intent and node.
 * Separates errors into CRITICAL (block DS usage) and NON-CRITICAL (allow with warnings).
 *
 * CRITICAL errors:
 *   - required property unsatisfiable
 *   - structural violation (child count)
 *   - required slot impossible
 *
 * NON-CRITICAL warnings:
 *   - optional property unmapped
 *   - optional slot missing
 *   - weak property alignment
 */
function evaluateVariant(variant, candidate, intent, node) {
  const criticalErrors = [];
  const warnings = [];
  const unresolvedProperties = [];
  const missingSlots = [];

  // Check properties
  if (variant.properties) {
    for (const [propName, propDef] of Object.entries(variant.properties)) {
      const canSatisfy =
        (propDef.type === 'TEXT' && node.textContent?.trim().length > 0) ||
        (propDef.type === 'BOOLEAN') ||
        (propDef.type === 'VARIANT') ||
        (propDef.type === 'INSTANCE_SWAP' && node.children?.length > 0) ||
        (propDef.default !== undefined);

      if (propDef.required && !canSatisfy) {
        criticalErrors.push(`required_property_unsatisfiable:${propName}(type=${propDef.type})`);
      } else if (!propDef.required && !canSatisfy) {
        unresolvedProperties.push(propName);
        warnings.push(`optional_property_unmapped:${propName}`);
      }
    }
  }

  // Check structure
  const struct = candidate.structureRequirements;
  if (struct) {
    const childCount = node.children?.length || 0;

    if (struct.minChildren !== undefined && childCount < struct.minChildren) {
      criticalErrors.push(`structure:too_few_children(need=${struct.minChildren},have=${childCount})`);
    }
    if (struct.maxChildren !== undefined && childCount > struct.maxChildren) {
      criticalErrors.push(`structure:too_many_children(need=${struct.maxChildren},have=${childCount})`);
    }

    if (struct.requiredSlots) {
      for (const slot of struct.requiredSlots) {
        if (slot === 'text' && intent.contentType === 'icon') {
          criticalErrors.push('slot_impossible:text(content_is_icon_only)');
        } else if (slot === 'icon' && intent.contentType === 'text') {
          missingSlots.push(slot);
          warnings.push('optional_slot_missing:icon(can_be_hidden)');
        }
      }
    }
  }

  return { criticalErrors, warnings, unresolvedProperties, missingSlots };
}

/**
 * STEP 3: Resolve the best valid variant from candidates.
 *
 * Returns:
 *   - STRICT match: zero errors, zero warnings
 *   - VALID match: zero critical errors, some warnings
 *   - null: all variants have critical errors
 *
 * @param {Array} candidates — from discoverComponents()
 * @param {Object} intent — from detectIntent()
 * @param {Object} node — original HTML node
 * @returns {Object|null} resolved match with maturity level
 */
export function resolveVariant(candidates, intent, node) {
  let bestValid = null; // Best VALID_MATCH (has warnings but no critical errors)

  for (const candidate of candidates) {
    for (const variant of candidate.variants) {
      const evaluation = evaluateVariant(variant, candidate, intent, node);

      if (evaluation.criticalErrors.length > 0) continue; // Disqualified

      const match = {
        component: candidate.component,
        componentKey: candidate.componentKey,
        variant: variant.name,
        variantKey: variant.key,
        score: candidate.score,
        matchReasons: candidate.matchReasons,
        criticalErrors: [],
        warnings: evaluation.warnings,
        unresolvedProperties: evaluation.unresolvedProperties,
        missingSlots: evaluation.missingSlots,
      };

      // STRICT: zero warnings
      if (evaluation.warnings.length === 0) {
        match.maturity = 'STRICT';
        return match;
      }

      // VALID: track as best non-strict match (prefer higher score)
      if (!bestValid || candidate.score > bestValid.score) {
        match.maturity = 'VALID';
        bestValid = match;
      }
    }
  }

  return bestValid; // May be null if all had critical errors
}


// ═════════════════════════════════════════════════════════════════════════════
// STEP 3.5 — SEMANTIC INTEGRITY CHECK
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate that a resolved DS component preserves the semantic meaning
 * of the original HTML element. Prevents semantic drift where a component
 * matches structurally but changes the element's purpose.
 *
 * Rules (all must pass):
 *   1. Component type must match intent type
 *   2. Component must support ALL required semantics from intent
 *   3. If intent has an explicit role, component must support that role
 *   4. No semantic downgrade (e.g., navigational element → decorative component)
 *
 * @param {Object} resolved — from resolveVariant()
 * @param {Object} intent — from detectIntent()
 * @param {Array} dsInventory — to look up the original component entry
 * @returns {Object} { passed: boolean, errors: string[] }
 */
export function semanticIntegrityCheck(resolved, intent, dsInventory) {
  if (!resolved) return { passed: false, errors: ['no_resolved_component'] };

  const errors = [];

  // Find the full DS component entry for the resolved match
  const dsEntry = dsInventory?.find(c => c.key === resolved.componentKey);
  if (!dsEntry) {
    // Cannot verify — treat as failed integrity
    errors.push('semantic:component_not_in_inventory');
    return { passed: false, errors };
  }

  // Rule 1: Type match (action, input, text, layout, media)
  if (!dsEntry.supportedTypes?.includes(intent.type)) {
    errors.push(`semantic:type_mismatch(intent=${intent.type},component_supports=[${dsEntry.supportedTypes?.join(',')}])`);
  }

  // Rule 2: Required semantics must be supported
  // Required semantics = those that define the element's core behavior.
  //
  // Compatibility rule: "navigational" is satisfied by "clickable".
  // A clickable component can represent a navigational link — the navigation
  // meaning is carried by the link text and destination, not the component type.
  // This prevents every <a> from failing semantic integrity against button-like components.
  const requiredSemantics = intent.semantics.filter(s =>
    ['clickable', 'navigational', 'form', 'search', 'auth', 'toggle', 'tab', 'modal'].includes(s)
  );

  const componentSemantics = new Set(dsEntry.supportedSemantics || []);

  for (const sem of requiredSemantics) {
    const isSatisfied =
      componentSemantics.has(sem) ||
      (sem === 'navigational' && componentSemantics.has('clickable'));

    if (!isSatisfied) {
      errors.push(`semantic:missing_required_semantic(${sem})`);
    }
  }

  // Rule 3: Role compatibility
  // When DS component has no explicit roles (empty array), treat as "role unrestricted" —
  // the component can serve any role. This prevents blocking candidates that simply
  // lack role metadata in their inventory entry.
  if (intent.role && intent.role !== 'decorative') {
    const hasRoles = dsEntry.supportedRoles && dsEntry.supportedRoles.length > 0;
    if (hasRoles && !dsEntry.supportedRoles.includes(intent.role)) {
      errors.push(`semantic:role_unsupported(intent=${intent.role},component_supports=[${dsEntry.supportedRoles.join(',')}])`);
    }
    // If component has no roles declared, allow — the match is scored lower but not blocked.
  }

  // Rule 4: No semantic downgrade
  // Functional elements (clickable, form, navigational) must not map to decorative-only components
  const isFunctional = requiredSemantics.length > 0;
  const isDecorativeOnly = dsEntry.supportedRoles?.length === 1 && dsEntry.supportedRoles[0] === 'decorative';
  if (isFunctional && isDecorativeOnly) {
    errors.push(`semantic:downgrade(functional_element_mapped_to_decorative_component)`);
  }

  return { passed: errors.length === 0, errors };
}


// ═════════════════════════════════════════════════════════════════════════════
// STEP 4 + 5 — DECISION AND VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate a resolved DS component match.
 *
 * Returns a validation result with:
 *   level: "STRICT" | "VALID" | "FAILED"
 *   errors: critical blockers (if any)
 *   warnings: non-critical issues (if any)
 *
 * @param {Object} resolved — from resolveVariant() (or null)
 * @param {Object} intent — from detectIntent()
 * @param {Object} node — original HTML node
 * @returns {Object} validation result
 */
function validateResolution(resolved, intent, node) {
  if (!resolved) {
    return { level: 'FAILED', errors: ['no_resolved_match'], warnings: [] };
  }

  const errors = [];
  const warnings = [...(resolved.warnings || [])];

  // Critical: score must indicate meaningful match
  if (resolved.score < 4) {
    errors.push(`weak_match:score=${resolved.score}(minimum=4)`);
  }

  // Critical: text content must exist when component expects it
  if ((intent.contentType === 'text' || intent.contentType === 'mixed') &&
      (!node.textContent || node.textContent.trim().length === 0)) {
    errors.push('content:empty_text_for_text_component');
  }

  if (errors.length > 0) {
    return { level: 'FAILED', errors, warnings };
  }

  // No critical errors — level is STRICT or VALID based on warnings
  const level = warnings.length === 0 ? 'STRICT' : 'VALID';
  return { level, errors: [], warnings };
}

/**
 * Make the final resolution decision.
 *
 * Three possible outcomes:
 *   STRICT_MATCH — full validation + semantic integrity, zero warnings
 *   VALID_MATCH  — no critical errors + semantic integrity, minor warnings only
 *   FALLBACK     — no viable DS component, or semantic integrity failed
 *
 * Semantic integrity is REQUIRED for both STRICT and VALID.
 * If semantic check fails, the decision is forced to FALLBACK regardless of score.
 *
 * @param {Object} resolved — from resolveVariant() (or null)
 * @param {Object} validation — from validateResolution()
 * @param {Object} intent — from detectIntent()
 * @param {Object} semanticResult — from semanticIntegrityCheck()
 * @returns {Object} decision
 */
function makeDecision(resolved, validation, intent, semanticResult) {
  // Semantic integrity is a gate — if it fails, force FALLBACK
  if (resolved && !semanticResult.passed) {
    return {
      type: 'FALLBACK',
      component: null,
      componentKey: null,
      variant: null,
      variantKey: null,
      reason: `Semantic mismatch: component does not preserve intent. ${semanticResult.errors.join('; ')}`,
      confidence: 1.0,
      validation,
      semanticIntegrity: semanticResult,
      downgradeFrom: validation.level === 'STRICT' ? 'STRICT_MATCH' : 'VALID_MATCH',
      downgradeReason: semanticResult.errors,
    };
  }

  // STRICT_MATCH: everything passes, no warnings, semantic intact
  if (resolved && validation.level === 'STRICT' && semanticResult.passed) {
    return {
      type: 'STRICT_MATCH',
      component: resolved.component,
      componentKey: resolved.componentKey,
      variant: resolved.variant,
      variantKey: resolved.variantKey,
      reason: `Strict DS match: ${resolved.matchReasons.join(', ')}`,
      confidence: Math.min(resolved.score / 6, 1.0),
      validation,
      semanticIntegrity: semanticResult,
    };
  }

  // VALID_MATCH: no critical errors, semantic intact, has non-critical warnings
  if (resolved && validation.level === 'VALID' && semanticResult.passed) {
    return {
      type: 'VALID_MATCH',
      component: resolved.component,
      componentKey: resolved.componentKey,
      variant: resolved.variant,
      variantKey: resolved.variantKey,
      reason: `Valid DS match with caveats: ${resolved.matchReasons.join(', ')}`,
      confidence: Math.min(resolved.score / 7, 0.9),
      validation,
      semanticIntegrity: semanticResult,
      unresolvedProperties: resolved.unresolvedProperties || [],
      missingSlots: resolved.missingSlots || [],
    };
  }

  // FALLBACK: no viable DS component
  const fallbackReason = !resolved
    ? 'No DS component matched the intent'
    : `DS match failed validation: ${validation.errors.join('; ')}`;

  return {
    type: 'FALLBACK',
    component: null,
    componentKey: null,
    variant: null,
    variantKey: null,
    reason: fallbackReason,
    confidence: 1.0,
    validation,
    semanticIntegrity: semanticResult || { passed: false, errors: ['no_check_performed'] },
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a single HTML node to a DS component or primitive.
 *
 * Executes the full 5-step pipeline:
 *   1. Intent Detection
 *   2. DS Discovery
 *   3. Variant Resolution
 *   4. Decision
 *   5. Validation
 *
 * @param {Object} node — parsed HTML node
 * @param {Array} dsInventory — DS component inventory
 * @returns {Object} resolution result with decision and full trace
 */
/**
 * Attempt warm-cache resolution from ds-knowledge.json patterns.
 * Returns a cached match if found with sufficient confidence, or null.
 * The caller MUST validate the cached component against the live DS (Rule 34).
 *
 * @param {Object} node — parsed HTML node
 * @param {Array} cachedPatterns — from ds-knowledge.json (active patterns only)
 * @returns {Object|null} cached resolution trace, or null if no cache hit
 */
export function resolveFromCache(node, cachedPatterns) {
  if (!cachedPatterns || cachedPatterns.length === 0) return null;

  const intent = detectIntent(node);
  const signature = `${intent.tag}.${(intent.semantics || []).join('.')}`;

  // Find matching pattern by signature or pattern_key
  const match = cachedPatterns.find(p =>
    p.valid_until === null &&
    (p.confidence ?? 0) >= CACHE_CONFIDENCE_THRESHOLD &&
    (p.signature === signature || p.pattern_key === signature || p.pattern_key === intent.tag)
  );

  if (!match) return null;

  return {
    intent,
    cachedMatch: true,
    patternId: match.pattern_key,
    component_key: match.component_key,
    component_name: match.component_name,
    variant: match.variant,
    props_mapping: match.props_mapping,
    configuration_recipe: match.configuration_recipe,
    confidence: match.confidence,
    source: match.source,
    use_count: match.use_count,
    // Caller must validate before using
    requiresValidation: true,
  };
}

const CACHE_CONFIDENCE_THRESHOLD = 0.8;

export function resolveComponent(node, dsInventory) {
  // Step 1: Intent Detection
  const intent = detectIntent(node);

  // Step 2: DS Discovery
  const candidates = discoverComponents(intent, dsInventory);

  // Step 3: Variant Resolution
  const resolved = resolveVariant(candidates, intent, node);

  // Step 3.5: Semantic Integrity Check
  const semanticResult = resolved
    ? semanticIntegrityCheck(resolved, intent, dsInventory)
    : { passed: false, errors: ['no_resolved_component'] };

  // Step 5: Structural/Content Validation
  const validation = validateResolution(resolved, intent, node);

  // Step 4: Decision (gated by semantic integrity)
  const decision = makeDecision(resolved, validation, intent, semanticResult);

  // Build complete trace
  const outcome = decision.type === 'FALLBACK' ? 'FALLBACK'
    : decision.type === 'STRICT_MATCH' ? 'STRICT_MATCH'
    : 'VALID_MATCH';

  const trace = {
    intent,
    candidates: candidates.map(c => ({
      component: c.component,
      score: c.score,
      matchReasons: c.matchReasons,
    })),
    resolved: resolved ? {
      component: resolved.component,
      variant: resolved.variant,
      score: resolved.score,
      maturity: resolved.maturity,
      warnings: resolved.warnings,
      unresolvedProperties: resolved.unresolvedProperties,
      missingSlots: resolved.missingSlots,
    } : null,
    semanticIntegrity: semanticResult,
    decision,
    outcome,
    downgrade: decision.downgradeFrom ? {
      from: decision.downgradeFrom,
      reason: decision.downgradeReason,
    } : null,
  };

  return trace;
}

/**
 * Resolve all HTML nodes in a document.
 *
 * @param {Array} nodes — array of parsed HTML nodes
 * @param {Array} dsInventory — DS component inventory
 * @returns {Object} all resolutions with summary
 */
export function resolveAll(nodes, dsInventory) {
  const resolutions = [];
  const counts = { STRICT_MATCH: 0, VALID_MATCH: 0, FALLBACK: 0 };

  for (const node of nodes) {
    const result = resolveComponent(node, dsInventory);
    resolutions.push(result);
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  }

  const dsTotal = counts.STRICT_MATCH + counts.VALID_MATCH;

  return {
    resolutions,
    summary: {
      total: nodes.length,
      strictMatches: counts.STRICT_MATCH,
      validMatches: counts.VALID_MATCH,
      fallbacks: counts.FALLBACK,
      dsRate: nodes.length > 0 ? (dsTotal / nodes.length * 100).toFixed(1) + '%' : '0%',
    },
  };
}


/**
 * Build a resolution map keyed by node._id for use by the tree executor.
 *
 * @param {Array} nodes — parsed HTML nodes (must have _id field)
 * @param {Array} resolutions — parallel array from resolveAll().resolutions
 * @returns {Object} map of _id → { type, componentKey, variantKey, confidence }
 */
export function buildResolutionMap(nodes, resolutions) {
  const map = {};
  for (let i = 0; i < nodes.length && i < resolutions.length; i++) {
    const node = nodes[i];
    const res = resolutions[i];
    if (!node._id) continue;
    if (res.outcome === 'FALLBACK') continue; // Only store DS matches

    map[node._id] = {
      type: res.decision.type,
      componentKey: res.decision.componentKey,
      variantKey: res.decision.variantKey,
      confidence: res.decision.confidence,
      component: res.decision.component,
    };
  }
  return map;
}


// ═════════════════════════════════════════════════════════════════════════════
// LEARNING HOOK
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Persist resolution patterns to learning artifact.
 * Appends resolution trace to cumulative file.
 * Rolling window of last 200 entries.
 *
 * @param {Array} resolutions — array of resolution traces from resolveAll()
 * @param {string} buildId — identifier for this build
 */
export function persistResolutionPatterns(resolutions, buildId) {
  let existing = [];
  if (existsSync(RESOLUTION_LOG_PATH)) {
    try { existing = JSON.parse(readFileSync(RESOLUTION_LOG_PATH, 'utf8')); } catch {}
  }

  const entries = resolutions.map(r => ({
    buildId,
    timestamp: new Date().toISOString(),
    intent: r.intent,
    candidateCount: r.candidates.length,
    topCandidate: r.candidates[0]?.component || null,
    topScore: r.candidates[0]?.score || 0,
    decision: {
      type: r.decision.type,
      component: r.decision.component,
      variant: r.decision.variant,
      confidence: r.decision.confidence,
      reason: r.decision.reason,
    },
    validation: {
      level: r.decision.validation?.level,
      errors: r.decision.validation?.errors || [],
      warnings: r.decision.validation?.warnings || [],
    },
    unresolvedProperties: r.decision.unresolvedProperties || [],
    missingSlots: r.decision.missingSlots || [],
    semanticIntegrity: r.semanticIntegrity || null,
    downgrade: r.downgrade || null,
    outcome: r.outcome,
  }));

  const combined = [...existing, ...entries].slice(-200);
  writeFileSync(RESOLUTION_LOG_PATH, JSON.stringify(combined, null, 2), 'utf8');

  const outcomes = { STRICT_MATCH: 0, VALID_MATCH: 0, FALLBACK: 0 };
  for (const e of entries) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1;

  return {
    logged: entries.length,
    totalStored: combined.length,
    outcomes,
  };
}
