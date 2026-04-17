/**
 * Mimic AI — Composite Structure Detector
 *
 * Detects multi-element HTML structures that may map to a single DS composite
 * component. Runs BEFORE individual resolution to give composite DS components
 * the chance to match before children are resolved independently.
 *
 * Detection is structural, NOT DS-specific:
 *   - Analyzes child types, roles, ordering, and depth
 *   - Produces structural signatures that DS discovery can match against
 *   - Never assumes specific component names ("card", "hero", "navbar")
 *
 * Usage:
 *   import { detectComposites, resolveWithComposites } from './composite-detector.js';
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectIntent, discoverComponents, resolveVariant, semanticIntegrityCheck } from './component-resolver.js';
import { validateCompositeLayout } from './layout-validator.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = resolve(__dir, '..', 'learning');
const COMPOSITE_LOG_PATH = resolve(LEARNING_DIR, 'composite-patterns.json');

if (!existsSync(LEARNING_DIR)) mkdirSync(LEARNING_DIR, { recursive: true });


// ═════════════════════════════════════════════════════════════════════════════
// CHILD ROLE CLASSIFICATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Classify a child node into a structural role.
 * These are generic structural roles, NOT DS component names.
 */
function classifyChildRole(node) {
  const tag = node.tag?.toLowerCase();
  const attrs = node.attributes || {};
  const classes = (attrs.class || '').toLowerCase();
  const hasText = node.textContent?.trim().length > 0;
  const childCount = node.children?.length || 0;

  // Media: images, SVGs, video
  if (['img', 'svg', 'video', 'picture', 'canvas'].includes(tag)) return 'media';
  if (classes.includes('image') || classes.includes('thumbnail') || classes.includes('avatar')) return 'media';

  // Action: buttons, links with interaction intent
  if (['button'].includes(tag)) return 'action';
  if (tag === 'a' && attrs.href) return 'action';

  // Input: form elements
  if (['input', 'textarea', 'select'].includes(tag)) return 'input';

  // Heading: heading tags
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';

  // Description: paragraph-level text content
  if (tag === 'p' && hasText) return 'description';

  // Label: short text with visual distinction (badges, tags, chips)
  if (hasText && node.textContent.trim().length < 30 && (
    classes.includes('badge') || classes.includes('tag') || classes.includes('chip') ||
    classes.includes('label') || classes.includes('status') || classes.includes('category')
  )) return 'label';

  // Metadata: small text, dates, counts, secondary info
  if (tag === 'span' && hasText && node.textContent.trim().length < 50) return 'metadata';
  if (tag === 'time') return 'metadata';

  // List: ordered/unordered lists
  if (['ul', 'ol'].includes(tag)) return 'list';

  // Container: divs and sections with children (sub-structure)
  if (['div', 'section', 'article', 'aside', 'main', 'header', 'footer', 'nav'].includes(tag) && childCount > 0) {
    return 'container';
  }

  // Text: any remaining text-bearing element
  if (hasText) return 'text';

  // Spacer/decoration: empty elements
  if (!hasText && childCount === 0) return 'decoration';

  return 'unknown';
}


// ═════════════════════════════════════════════════════════════════════════════
// STRUCTURAL SIGNATURE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Produce a structural signature for a parent node and its children.
 * The signature describes the composition without naming specific patterns.
 *
 * Example signatures:
 *   "media+heading+description+action" (image, title, text, button)
 *   "heading+list+action" (title, list, CTA)
 *   "media+container+container" (image area, content area, footer area)
 */
function buildSignature(parentNode) {
  const children = parentNode.children || [];
  if (children.length === 0) return null;

  const roles = children.map(classifyChildRole);

  // Deduplicate consecutive same roles (e.g., label+label+label → label×3)
  const compressed = [];
  let lastRole = null;
  let count = 0;
  for (const role of roles) {
    if (role === lastRole) {
      count++;
    } else {
      if (lastRole) compressed.push(count > 1 ? `${lastRole}×${count}` : lastRole);
      lastRole = role;
      count = 1;
    }
  }
  if (lastRole) compressed.push(count > 1 ? `${lastRole}×${count}` : lastRole);

  return {
    raw: roles,
    compressed: compressed.join('+'),
    childCount: children.length,
    uniqueRoles: [...new Set(roles)],
    roleFrequency: roles.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// COMPOSITE DETECTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determine if a node qualifies as a composite candidate.
 * A composite candidate is a container with multiple children of different
 * structural roles, suggesting it maps to a single DS component.
 *
 * NOT a composite: a wrapper div with one child, or a text-only container.
 */
function isCompositeCandidate(node) {
  const children = node.children || [];
  if (children.length < 2) return false; // Need at least 2 children

  const signature = buildSignature(node);
  if (!signature) return false;

  // Must have at least 2 different roles (not just text+text+text)
  if (signature.uniqueRoles.length < 2) return false;

  // Must have at least one non-container, non-unknown role
  const meaningfulRoles = signature.uniqueRoles.filter(r =>
    !['container', 'unknown', 'decoration'].includes(r)
  );
  if (meaningfulRoles.length < 1) return false;

  return true;
}

/**
 * Score a composite candidate based on structural richness.
 * Higher scores indicate more likely DS composite match potential.
 */
function scoreComposite(signature) {
  let score = 0;

  // More unique roles = richer structure
  score += signature.uniqueRoles.length * 2;

  // Presence of key structural roles
  const keyRoles = ['media', 'heading', 'description', 'action', 'input', 'label'];
  for (const role of keyRoles) {
    if (signature.uniqueRoles.includes(role)) score += 1;
  }

  // Child count in sweet spot (2-8 children)
  if (signature.childCount >= 2 && signature.childCount <= 8) score += 2;

  return score;
}

/**
 * Detect all composite candidates in a flat list of top-level nodes.
 *
 * Scans each node that has children and evaluates whether it represents
 * a composite structure worth attempting DS composite resolution.
 *
 * @param {Array} nodes — parsed HTML nodes
 * @returns {Array} composite candidates with signatures and scores
 */
export function detectComposites(nodes) {
  const composites = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!isCompositeCandidate(node)) continue;

    const signature = buildSignature(node);
    const score = scoreComposite(signature);

    composites.push({
      nodeIndex: i,
      node,
      signature,
      score,
      childIndices: node.children.map((_, ci) => ({ parentIndex: i, childIndex: ci })),
    });
  }

  // Sort by score descending — resolve highest-confidence composites first
  composites.sort((a, b) => b.score - a.score);

  return composites;
}


// ═════════════════════════════════════════════════════════════════════════════
// COMPOSITE DS MATCHING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * DS composite component inventory entry schema (extends base schema):
 *
 * {
 *   ...base component fields,
 *   isComposite: true,
 *   compositeStructure: {
 *     requiredChildRoles: ['media', 'heading'],     // Roles that MUST be present
 *     optionalChildRoles: ['description', 'action'], // Roles that MAY be present
 *     minChildren: 2,
 *     maxChildren: 8,
 *   }
 * }
 */

/**
 * Attempt to match a composite candidate against DS composite components.
 *
 * @param {Object} composite — from detectComposites()
 * @param {Array} dsInventory — DS component inventory (includes composite entries)
 * @returns {Object|null} match result or null
 */
export function matchComposite(composite, dsInventory) {
  const compositeComponents = dsInventory.filter(c => c.isComposite);
  if (compositeComponents.length === 0) return null;

  const childRoles = composite.signature.raw;
  const uniqueRoles = composite.signature.uniqueRoles;

  let bestMatch = null;

  for (const dsComp of compositeComponents) {
    const cs = dsComp.compositeStructure;
    if (!cs) continue;

    const errors = [];
    const warnings = [];

    // Check required child roles
    for (const required of (cs.requiredChildRoles || [])) {
      if (!uniqueRoles.includes(required)) {
        errors.push(`missing_required_child_role:${required}`);
      }
    }

    // Check child count bounds
    if (cs.minChildren && composite.signature.childCount < cs.minChildren) {
      errors.push(`too_few_children:need=${cs.minChildren},have=${composite.signature.childCount}`);
    }
    if (cs.maxChildren && composite.signature.childCount > cs.maxChildren) {
      errors.push(`too_many_children:need=${cs.maxChildren},have=${composite.signature.childCount}`);
    }

    // Check for unexpected roles (roles not in required or optional)
    const allExpected = [...(cs.requiredChildRoles || []), ...(cs.optionalChildRoles || [])];
    for (const role of uniqueRoles) {
      if (!allExpected.includes(role) && role !== 'container' && role !== 'unknown' && role !== 'decoration') {
        warnings.push(`unexpected_child_role:${role}`);
      }
    }

    // Score: required roles matched + optional roles present
    let matchScore = 0;
    for (const req of (cs.requiredChildRoles || [])) {
      if (uniqueRoles.includes(req)) matchScore += 3;
    }
    for (const opt of (cs.optionalChildRoles || [])) {
      if (uniqueRoles.includes(opt)) matchScore += 1;
    }

    if (errors.length === 0 && matchScore > 0) {
      const match = {
        component: dsComp.name,
        componentKey: dsComp.key,
        matchScore,
        errors: [],
        warnings,
        satisfiedRequired: (cs.requiredChildRoles || []).filter(r => uniqueRoles.includes(r)),
        satisfiedOptional: (cs.optionalChildRoles || []).filter(r => uniqueRoles.includes(r)),
      };

      if (!bestMatch || matchScore > bestMatch.matchScore) {
        bestMatch = match;
      }
    }
  }

  return bestMatch;
}


// ═════════════════════════════════════════════════════════════════════════════
// COMPOSITE VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate a composite match before allowing DS usage.
 *
 * Rules:
 *   - ALL required child roles must be satisfied
 *   - NO semantic conflicts between composite intent and DS component
 *   - NO required slots missing (at the composite level)
 *   - Structure must match DS expectations
 *
 * If ANY condition fails → reject composite, resolve children individually.
 */
export function validateCompositeMatch(compositeCandidate, match, dsInventory) {
  const errors = [];

  if (!match) {
    return { valid: false, errors: ['no_composite_match'] };
  }

  // Re-verify required roles
  const dsComp = dsInventory.find(c => c.key === match.componentKey);
  if (!dsComp?.compositeStructure) {
    errors.push('component_missing_composite_structure');
    return { valid: false, errors };
  }

  for (const req of (dsComp.compositeStructure.requiredChildRoles || [])) {
    if (!compositeCandidate.signature.uniqueRoles.includes(req)) {
      errors.push(`validation:missing_required_child_role:${req}`);
    }
  }

  // Check for semantic downgrade at composite level
  const parentTag = compositeCandidate.node.tag?.toLowerCase();
  if (['nav', 'header', 'footer', 'form'].includes(parentTag)) {
    // Functional parent — DS composite must support functional role
    if (!dsComp.supportedSemantics?.some(s => ['navigational', 'form'].includes(s))) {
      errors.push(`semantic:functional_parent(${parentTag})_mapped_to_non_functional_composite`);
    }
  }

  if (match.warnings.length > 3) {
    errors.push('too_many_warnings:structural_confidence_too_low');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: match.warnings,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// LAYOUT DIRECTION (safe default only)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Assign layout direction for a composite fallback container.
 *
 * This system does NOT attempt to optimize layout.
 * It only prevents structural contradictions.
 * All valid layouts must remain possible.
 *
 * Default: VERTICAL (safe, universal, works for any structure).
 * VERTICAL is never wrong — it may not be optimal, but it is never contradictory.
 * The user or a future iteration can adjust direction after build.
 */
function assignLayoutDirection() {
  return 'VERTICAL';
}

/**
 * Detect if the composite should use sub-groups.
 *
 * Sub-groups are created ONLY at media boundaries:
 * a transition from media to non-media roles (or vice versa).
 *
 * This is the single structural signal strong enough to justify grouping
 * without introducing UI assumptions. Media elements are structurally
 * distinct from content elements in virtually all layouts.
 *
 * Sub-groups are NOT created for other role transitions.
 * All sub-groups use VERTICAL direction (safe default).
 */
function detectSubGroups(signature) {
  const roles = signature.raw;
  const uniqueRoles = new Set(roles);

  // Only create sub-groups when media + non-media roles coexist
  if (!uniqueRoles.has('media')) return null;
  const hasNonMedia = [...uniqueRoles].some(r =>
    !['media', 'container', 'unknown', 'decoration'].includes(r)
  );
  if (!hasNonMedia) return null;

  const groups = [];
  let currentGroup = { roles: [], startIndex: 0 };

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const prevRole = i > 0 ? roles[i - 1] : null;

    const isMediaBoundary = prevRole !== null && (
      (role === 'media' && prevRole !== 'media') ||
      (role !== 'media' && prevRole === 'media')
    );

    if (isMediaBoundary && currentGroup.roles.length > 0) {
      groups.push({ ...currentGroup, endIndex: i - 1 });
      currentGroup = { roles: [], startIndex: i };
    }

    currentGroup.roles.push(role);
  }

  if (currentGroup.roles.length > 0) {
    groups.push({ ...currentGroup, endIndex: roles.length - 1 });
  }

  // Only return if we actually split into 2+ groups
  if (groups.length < 2) return null;

  return groups.map(g => ({
    ...g,
    direction: 'VERTICAL', // Safe default — no assumptions
  }));
}

/**
 * Build a complete fallback container plan for a composite that has no DS match.
 * Preserves structure using DS-token primitives.
 */
function buildCompositeFallbackPlan(candidate) {
  const signature = candidate.signature;
  const node = candidate.node;
  const direction = assignLayoutDirection();
  const subGroups = detectSubGroups(signature);

  return {
    containerName: node.tag || 'composite-container',
    direction,
    // DS tokens — resolved at execution time
    spacing: { variable: null, hint: 'use nearest DS spacing token' },
    padding: { variable: null, hint: 'use nearest DS spacing token' },
    fills: { variable: null, fillNone: true }, // Transparent by default
    strokes: null,
    radius: null,
    subGroups: subGroups ? subGroups.map(g => ({
      startIndex: g.startIndex,
      endIndex: g.endIndex,
      roles: g.roles,
      direction: g.direction,
    })) : null,
    childCount: signature.childCount,
    childRoles: signature.raw,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// COMPOSITE-FIRST RESOLUTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve nodes with composite-first strategy.
 *
 * Three possible outcomes per composite candidate:
 *
 *   COMPOSITE_MATCH    — DS composite component exists and validates.
 *                        Parent + children resolved as one DS instance.
 *
 *   COMPOSITE_FALLBACK — No DS composite, but structure IS preserved.
 *                        Parent becomes a primitive AL container (DS tokens).
 *                        Children resolve individually INSIDE this container.
 *
 *   (no outcome)       — Node is not a composite candidate.
 *                        Proceeds to individual resolution unchanged.
 *
 * @param {Array} nodes — parsed HTML nodes
 * @param {Array} dsInventory — DS component inventory (includes composites)
 * @returns {Object} resolution results
 */
export function resolveWithComposites(nodes, dsInventory) {
  const composites = detectComposites(nodes);

  const compositeResults = [];
  const resolvedByComposite = new Set();    // Fully consumed by DS composite
  const fallbackContainers = [];             // Structured primitive containers

  for (const candidate of composites) {
    const match = matchComposite(candidate, dsInventory);
    const validation = validateCompositeMatch(candidate, match, dsInventory);

    const result = {
      nodeIndex: candidate.nodeIndex,
      signature: candidate.signature.compressed,
      signatureRaw: candidate.signature.raw,
      score: candidate.score,
      match: match ? {
        component: match.component,
        componentKey: match.componentKey,
        matchScore: match.matchScore,
        satisfiedRequired: match.satisfiedRequired,
        satisfiedOptional: match.satisfiedOptional,
        warnings: match.warnings,
      } : null,
      validation,
      outcome: null,
      fallbackPlan: null,
    };

    if (match && validation.valid) {
      // DS composite found and validated
      result.outcome = 'COMPOSITE_MATCH';
      resolvedByComposite.add(candidate.nodeIndex);

    } else {
      // No DS composite — attempt structured primitive container
      const dsRejectionReason = !match
        ? 'no_ds_composite_component_matched'
        : `validation_failed:${validation.errors.join(';')}`;

      const plan = buildCompositeFallbackPlan(candidate);
      const layoutValidation = validateCompositeLayout(plan);
      result.layoutValidation = layoutValidation;

      if (layoutValidation.valid) {
        // Layout is consistent — use structured fallback
        result.outcome = 'COMPOSITE_FALLBACK';
        result.rejectionReason = dsRejectionReason;
        result.fallbackPlan = plan;

        fallbackContainers.push({
          nodeIndex: candidate.nodeIndex,
          node: candidate.node,
          plan,
          childNodes: candidate.node.children || [],
        });
      } else {
        // Layout has contradictions — downgrade to individual resolution
        result.outcome = 'NON_COMPOSITE';
        result.rejectionReason = `layout_validation_failed:${layoutValidation.errors.join(';')}`;
        result.fallbackPlan = null;
        // Node goes to nonCompositeIndices for individual resolution
      }
    }

    compositeResults.push(result);
  }

  // Indices that need individual resolution:
  // 1. Not detected as composite at all
  // 2. Detected but layout validation failed (NON_COMPOSITE)
  const compositeMatchOrFallback = new Set([
    ...resolvedByComposite,
    ...fallbackContainers.map(fc => fc.nodeIndex),
  ]);
  const nonCompositeIndices = nodes.map((_, i) => i).filter(i => !compositeMatchOrFallback.has(i));

  return {
    compositeResults,
    resolvedByComposite,           // Fully consumed by DS composite
    fallbackContainers,            // Structured primitive containers — resolve children inside
    nonCompositeIndices,           // Resolve individually (not composite + layout-rejected)
    summary: {
      detected: composites.length,
      matched: compositeResults.filter(r => r.outcome === 'COMPOSITE_MATCH').length,
      fallback: compositeResults.filter(r => r.outcome === 'COMPOSITE_FALLBACK').length,
      layoutRejected: compositeResults.filter(r => r.outcome === 'NON_COMPOSITE').length,
    },
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// LEARNING PERSISTENCE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Persist composite detection patterns for learning.
 */
export function persistCompositePatterns(compositeResults, buildId) {
  let existing = [];
  if (existsSync(COMPOSITE_LOG_PATH)) {
    try { existing = JSON.parse(readFileSync(COMPOSITE_LOG_PATH, 'utf8')); } catch {}
  }

  const entries = compositeResults.map(r => ({
    buildId,
    timestamp: new Date().toISOString(),
    signature: r.signature,
    signatureRaw: r.signatureRaw || null,
    score: r.score,
    outcome: r.outcome,
    component: r.match?.component || null,
    matchScore: r.match?.matchScore || 0,
    rejectionReason: r.rejectionReason || null,
    warnings: r.match?.warnings || [],
    validationErrors: r.validation?.errors || [],
    fallbackPlan: r.fallbackPlan ? {
      direction: r.fallbackPlan.direction,
      childCount: r.fallbackPlan.childCount,
      childRoles: r.fallbackPlan.childRoles,
      hasSubGroups: !!r.fallbackPlan.subGroups,
      subGroupCount: r.fallbackPlan.subGroups?.length || 0,
    } : null,
    layoutValidation: r.layoutValidation || null,
  }));

  const combined = [...existing, ...entries].slice(-100);
  writeFileSync(COMPOSITE_LOG_PATH, JSON.stringify(combined, null, 2), 'utf8');

  return { logged: entries.length, totalStored: combined.length };
}
