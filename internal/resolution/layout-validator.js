/**
 * Mimic AI — Layout Validator
 *
 * This system does NOT attempt to optimize layout.
 * It only prevents structural contradictions.
 * All valid layouts must remain possible.
 *
 * If layout is uncertain → allow it, do not block it.
 * Only block → provably invalid structures.
 *
 * This is a validator, not a solver.
 * It never suggests corrections, retries, or alternatives.
 *
 * Usage:
 *   import { validateCompositeLayout } from './layout-validator.js';
 *   const result = validateCompositeLayout(fallbackPlan);
 */


// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION RULES — CONTRADICTION DETECTION ONLY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Rule A: Subgroup integrity.
 *
 * INVALID if:
 *   - subGroups exist
 *   - AND a group mixes media + non-media roles
 *     (the only reason sub-groups exist is to separate media from content;
 *      if that separation is violated, the grouping is contradictory)
 *
 * This is a provable contradiction: the sub-group was created at a media
 * boundary, so each group should be either all-media or all-non-media.
 */
function checkSubgroupIntegrity(plan) {
  const errors = [];
  if (!plan.subGroups) return errors;

  for (let i = 0; i < plan.subGroups.length; i++) {
    const group = plan.subGroups[i];
    const roles = group.roles || [];
    const hasMedia = roles.includes('media');
    const hasNonMedia = roles.some(r =>
      !['media', 'container', 'unknown', 'decoration'].includes(r)
    );

    if (hasMedia && hasNonMedia) {
      errors.push(`subgroup_integrity:group_${i}_mixes_media_and_non_media(boundary_violated)`);
    }
  }

  return errors;
}

/**
 * Rule B: Empty structure check.
 *
 * INVALID if:
 *   - childCount is 0 or childRoles is empty
 *     (a container with no children is structurally meaningless)
 */
function checkEmptyStructure(plan) {
  const errors = [];

  if (!plan.childRoles || plan.childRoles.length === 0) {
    errors.push('empty_structure:no_child_roles');
  }

  if (plan.childCount !== undefined && plan.childCount === 0) {
    errors.push('empty_structure:zero_children');
  }

  return errors;
}

/**
 * Rule C: Subgroup count sanity.
 *
 * INVALID if:
 *   - subGroups exist
 *   - AND number of subGroups > number of children
 *     (more groups than elements is structurally impossible)
 */
function checkSubgroupCount(plan) {
  const errors = [];
  if (!plan.subGroups) return errors;

  const totalChildren = plan.childRoles?.length || 0;
  if (plan.subGroups.length > totalChildren) {
    errors.push(`subgroup_count:more_groups(${plan.subGroups.length})_than_children(${totalChildren})`);
  }

  return errors;
}


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate a composite fallback layout plan.
 *
 * Runs only contradiction-detection rules. Returns errors (blockers)
 * and warnings (informational, never blocking).
 *
 * Does NOT:
 *   - suggest corrections
 *   - prefer one layout over another
 *   - encode UI patterns
 *   - assume how any structure "should" look
 *
 * @param {Object} fallbackPlan — from buildCompositeFallbackPlan()
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
 */
export function validateCompositeLayout(fallbackPlan) {
  if (!fallbackPlan) {
    return { valid: false, errors: ['no_fallback_plan'], warnings: [] };
  }

  const errors = [
    ...checkSubgroupIntegrity(fallbackPlan),
    ...checkEmptyStructure(fallbackPlan),
    ...checkSubgroupCount(fallbackPlan),
  ];

  return {
    valid: errors.length === 0,
    errors,
    warnings: [], // No warnings — either it's valid or it's blocked
  };
}
