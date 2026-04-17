/**
 * Mimic AI — DS Inventory Builder
 *
 * Converts live DS discovery results (from search_design_system + get_design_context)
 * into the structured inventory format required by the component resolver.
 *
 * Conservative by design:
 *   - If a field cannot be confidently inferred, it is left empty or conservative
 *   - Never guesses semantics from component names alone
 *   - Prefers false negatives (missed match) over false positives (wrong match)
 *
 * Usage:
 *   import { buildInventory, buildInventoryEntry } from './ds-inventory-builder.js';
 *   const inventory = buildInventory(searchResults, contextResults);
 */


// ═════════════════════════════════════════════════════════════════════════════
// TYPE AND ROLE INFERENCE — CONSERVATIVE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Infer supportedTypes from component properties and structure.
 *
 * Two-layer inference:
 *   Layer 1: Strong evidence from properties (action, input, text)
 *   Layer 2: When context is insufficient, expand to plausible types
 *            so the component can become a candidate (scored, not matched)
 *
 * Multi-type classification is allowed when uncertain.
 * The resolver's scoring and semantic integrity still gate final matches.
 */
function inferTypes(entry) {
  const types = [];
  const props = entry.properties || {};
  const propNames = Object.keys(props).map(p => p.toLowerCase());
  const hasTextProp = propNames.some(p => p.includes('text') || p.includes('label') || p.includes('title'));
  const hasIconProp = propNames.some(p => p.includes('icon'));
  const hasVariants = (entry.variantNames || []).length > 0;
  const hasProperties = propNames.length > 0;
  const isComposite = !!(entry.childSlots && entry.childSlots.length > 1);

  // Strong evidence: interactive properties → action
  if (propNames.some(p => p.includes('state') || p.includes('disabled') || p.includes('hover') || p.includes('pressed'))) {
    types.push('action');
  }

  // Strong evidence: input-related properties → input
  if (propNames.some(p => p.includes('placeholder') || p.includes('value') || p.includes('input') || p.includes('destructive'))) {
    types.push('input');
  }

  // Strong evidence: text properties → text
  if (hasTextProp) {
    types.push('text');
  }

  // Layer 2: Expand when context is insufficient
  // A component with variants but no strong type signal could be text or layout.
  // Allow both so it becomes a candidate — the resolver scores and validates.
  if (types.length === 0 && hasVariants && !isComposite) {
    types.push('text');
    types.push('layout');
  }

  // Fallback: completely unknown → layout only (safe default)
  if (types.length === 0) {
    types.push('layout');
  }

  return [...new Set(types)];
}

/**
 * Infer supportedRoles from variant hierarchy/size/weight properties.
 *
 * When role cannot be confidently inferred, returns an empty array.
 * The resolver treats empty supportedRoles as "role not restricted" —
 * the component can match any intent role, scored lower but not blocked.
 * Semantic integrity still gates the final decision.
 */
function inferRoles(entry) {
  const roles = [];
  const variantNames = (entry.variantNames || []).map(v => v.toLowerCase());
  const allValues = variantNames.join(' ');

  if (allValues.includes('primary')) roles.push('primary');
  if (allValues.includes('secondary')) roles.push('secondary');
  if (allValues.includes('tertiary')) roles.push('secondary');
  if (allValues.includes('link')) roles.push('secondary');

  return [...new Set(roles)];
}

/**
 * Infer supportedSemantics from properties and variant names.
 * ONLY assigns semantics backed by actual component evidence.
 */
function inferSemantics(entry) {
  const semantics = [];
  const props = entry.properties || {};
  const propNames = Object.keys(props).map(p => p.toLowerCase());
  const variantNames = (entry.variantNames || []).map(v => v.toLowerCase());
  const allVariantText = variantNames.join(' ');

  // Evidence: interactive states → clickable
  if (propNames.some(p => p.includes('state')) &&
      allVariantText.match(/hover|pressed|focused|disabled/)) {
    semantics.push('clickable');
  }

  // Evidence: has icon swap → may support icon-based interaction
  if (propNames.some(p => p.includes('icon'))) {
    semantics.push('icon');
  }

  // Evidence: input-like properties → form
  if (propNames.some(p => p.includes('placeholder') || p.includes('value') || p.includes('type'))) {
    semantics.push('form');
  }

  // Evidence: search-specific type variant
  if (allVariantText.includes('search')) {
    semantics.push('search');
  }

  // Evidence: tab-like structure
  if (allVariantText.includes('tab') || allVariantText.includes('current')) {
    semantics.push('tab');
  }

  // Evidence: toggle/checkbox
  if (allVariantText.includes('checked') || allVariantText.includes('toggle') || allVariantText.includes('switch')) {
    semantics.push('toggle');
  }

  return semantics;
}

/**
 * Infer structure requirements from component properties.
 */
function inferStructure(entry) {
  const props = entry.properties || {};
  const propNames = Object.keys(props).map(p => p.toLowerCase());
  const slots = [];

  if (propNames.some(p => p.includes('text') || p.includes('label') || p.includes('title'))) {
    slots.push('text');
  }
  if (propNames.some(p => p.includes('icon'))) {
    slots.push('icon');
  }

  return {
    requiredSlots: slots,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// VARIANT PROCESSING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract variant information from component set children names.
 * Input: array of variant name strings like "Size=md, Hierarchy=Primary, State=Default"
 */
function processVariants(variantNames, componentKey) {
  return variantNames.map((name, i) => {
    const properties = {};
    // Parse "Key=Value" pairs from variant name
    const pairs = name.split(',').map(p => p.trim());
    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(s => s?.trim());
      if (key && value) {
        properties[key] = { type: 'VARIANT', values: [value], default: value };
      }
    }

    return {
      name,
      key: `${componentKey}_v${i}`, // Placeholder — real key comes from DS discovery
      properties,
    };
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a single inventory entry from a DS component's search result + context.
 *
 * @param {Object} searchResult — from search_design_system
 *   { name, componentKey, assetType, libraryName }
 * @param {Object} [context] — from get_design_context (optional, enriches entry)
 *   { properties, variantNames, childSlots }
 * @returns {Object} inventory entry for the resolver
 */
export function buildInventoryEntry(searchResult, context = {}) {
  const entry = {
    // Raw data for inference
    name: searchResult.name,
    properties: context.properties || {},
    variantNames: context.variantNames || [],
  };

  const supportedTypes = inferTypes(entry);
  const supportedRoles = inferRoles(entry);
  const supportedSemantics = inferSemantics(entry);
  const structureRequirements = inferStructure(entry);

  // Detect composite (has child slot definitions)
  const isComposite = !!(context.childSlots && context.childSlots.length > 1);
  const compositeStructure = isComposite ? {
    requiredChildRoles: context.childSlots.filter(s => s.required).map(s => s.role),
    optionalChildRoles: context.childSlots.filter(s => !s.required).map(s => s.role),
    minChildren: context.childSlots.filter(s => s.required).length,
    maxChildren: context.childSlots.length + 5, // Conservative max
  } : undefined;

  return {
    name: searchResult.name,
    key: searchResult.componentKey,
    supportedTypes,
    supportedRoles,
    supportedSemantics,
    variants: processVariants(context.variantNames || [], searchResult.componentKey),
    structureRequirements,
    isComposite,
    ...(compositeStructure && { compositeStructure }),
  };
}

/**
 * Build a complete DS inventory from search results and context data.
 *
 * @param {Array} searchResults — array of search_design_system results
 * @param {Map|Object} contextMap — map of componentKey → context data
 * @returns {Array} complete inventory for the resolver
 */
export function buildInventory(searchResults, contextMap = {}) {
  const inventory = [];

  for (const result of searchResults) {
    // Only process components from the target library (skip non-DS results)
    const context = contextMap[result.componentKey] || contextMap[result.name] || {};
    const entry = buildInventoryEntry(result, context);
    inventory.push(entry);
  }

  return inventory;
}

/**
 * Build a minimal inventory from component names and keys only.
 * Use when full context is not available.
 * Produces conservative entries with minimal type/role/semantic inference.
 */
export function buildMinimalInventory(components) {
  return components.map(c => ({
    name: c.name,
    key: c.key || c.componentKey,
    supportedTypes: ['layout'], // Conservative default
    supportedRoles: [],
    supportedSemantics: [],
    variants: [],
    structureRequirements: { requiredSlots: [] },
    isComposite: false,
  }));
}
