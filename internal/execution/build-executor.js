/**
 * Mimic AI — Figma Build Executor
 *
 * Transforms component resolution decisions into executable Figma build plans,
 * then executes those plans through the existing MCP tool model.
 *
 * Two-phase execution:
 *   1. planBuild()         — creates an auditable build plan from resolutions
 *   2. executeBuildPlan()  — runs the plan through MCP tools
 *
 * Resolution types map to execution strategies:
 *   STRICT_MATCH → INSERT_COMPONENT (full property binding)
 *   VALID_MATCH  → INSERT_COMPONENT (safe bindings only, skip unresolved)
 *   FALLBACK     → CREATE_PRIMITIVE (DS variables and text styles)
 *
 * Core rule: incorrect DS usage is worse than fallback.
 * If any DS insertion cannot be safely planned, it converts to FALLBACK.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = resolve(__dir, '..', 'learning');
const EXECUTION_LOG_PATH = resolve(LEARNING_DIR, 'execution-patterns.json');

if (!existsSync(LEARNING_DIR)) mkdirSync(LEARNING_DIR, { recursive: true });


// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — PLAN BUILD
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Plan a DS component insertion from a STRICT or VALID resolution.
 * Returns the insertion plan or null if the plan cannot be safely created.
 */
function planComponentInsertion(node, resolution, buildContext) {
  const decision = resolution.decision;
  const isStrict = decision.type === 'STRICT_MATCH';

  // Block: missing component key
  if (!decision.componentKey) {
    return { blocked: true, blockedReason: 'missing_component_key' };
  }

  // Block: semantic integrity failed (should not reach here, but enforce)
  if (!decision.semanticIntegrity?.passed) {
    return { blocked: true, blockedReason: 'semantic_integrity_failed' };
  }

  // Build text bindings — only from properties the node can satisfy
  const textBindings = [];
  const propertyBindings = [];
  const warnings = [];

  const resolved = resolution.resolved;
  if (resolved) {
    // Scan variant properties for bindable values
    // We don't have full property schemas here (those come from DS inventory at runtime),
    // so we bind what we can: text content to TEXT properties, boolean toggles to known states.

    // Text binding: if the node has text content and the component has a text slot
    if (node.textContent?.trim()) {
      textBindings.push({
        source: 'node.textContent',
        value: node.textContent.trim(),
        target: 'primary_text', // The build executor will resolve to actual property name
      });
    }

    // For VALID_MATCH: record unresolved properties as warnings, do NOT bind them
    if (!isStrict && decision.unresolvedProperties?.length > 0) {
      for (const prop of decision.unresolvedProperties) {
        warnings.push(`unresolved_optional_property:${prop}(left_at_default)`);
      }
    }

    if (!isStrict && decision.missingSlots?.length > 0) {
      for (const slot of decision.missingSlots) {
        warnings.push(`missing_optional_slot:${slot}(skipped)`);
      }
    }
  }

  return {
    blocked: false,
    blockedReason: null,
    executionType: 'INSERT_COMPONENT',
    componentKey: decision.componentKey,
    variantKey: decision.variantKey || null,
    fileKey: buildContext.designSystemFileKey,
    parentNodeId: buildContext.parentNodeId,
    textBindings,
    propertyBindings,
    warnings,
  };
}

/**
 * Plan a primitive fallback from a FALLBACK resolution.
 * Uses DS variables and text styles — never raw values.
 */
function planPrimitiveFallback(node, resolution, buildContext) {
  const intent = resolution.intent;
  const warnings = [];

  // Determine primitive type based on intent
  let nodeType = 'frame';
  if (intent.type === 'text' && intent.contentType === 'text') nodeType = 'text';
  if (intent.type === 'media') nodeType = 'rectangle'; // Placeholder for images

  const plan = {
    blocked: false,
    blockedReason: null,
    executionType: 'CREATE_PRIMITIVE',
    componentKey: null,
    variantKey: null,
    primitivePlan: {
      nodeType,
      name: node.tag || 'element',
      parentNodeId: buildContext.parentNodeId,
      layout: {
        direction: 'VERTICAL',
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'AUTO',
      },
      // DS tokens — must be resolved at execution time from the DS
      fills: { variable: 'Colors/Background/bg-primary', fallback: null },
      strokes: null,
      textStyle: null,
      textContent: null,
      spacing: { variable: null },
      radius: null,
    },
    textBindings: [],
    propertyBindings: [],
    warnings,
  };

  // Text primitives
  if (nodeType === 'text' && node.textContent?.trim()) {
    plan.primitivePlan.textContent = node.textContent.trim();
    plan.primitivePlan.textStyle = { variable: null }; // Resolved at execution from DS
    plan.primitivePlan.fills = { variable: 'Colors/Text/text-primary', fallback: null };
    plan.textBindings.push({
      source: 'node.textContent',
      value: node.textContent.trim(),
      target: 'direct_text',
    });
  }

  // Frame primitives — layout containers
  if (nodeType === 'frame') {
    // Determine direction from node context
    const isHorizontal = node.computedStyles?.display === 'flex' &&
      node.computedStyles?.flexDirection === 'row';
    plan.primitivePlan.layout.direction = isHorizontal ? 'HORIZONTAL' : 'VERTICAL';
    plan.primitivePlan.fills = { variable: null, fillNone: true }; // Transparent by default
  }

  // Rectangle primitives — media placeholders
  if (nodeType === 'rectangle') {
    plan.primitivePlan.fills = { variable: 'Colors/Background/bg-secondary', fallback: null };
    plan.primitivePlan.layout = null; // Rectangles don't have AL
    warnings.push('media_placeholder:image_content_not_transferred');
  }

  return plan;
}

/**
 * Validate a single execution plan entry before it can be executed.
 * Catches unsafe states that slipped through resolution.
 */
function validatePlanEntry(entry) {
  const errors = [];

  if (entry.executionType === 'INSERT_COMPONENT') {
    if (!entry.componentKey) errors.push('no_component_key');
    if (!entry.fileKey) errors.push('no_file_key');
  }

  if (entry.executionType === 'CREATE_PRIMITIVE') {
    if (!entry.primitivePlan) errors.push('no_primitive_plan');
  }

  if (errors.length > 0) {
    entry.blocked = true;
    entry.blockedReason = `pre_execution_validation:${errors.join(',')}`;
  }

  return entry;
}

/**
 * PHASE 1: Create a complete build plan from resolutions.
 *
 * @param {Object} input
 * @param {Array}  input.nodes — parsed HTML nodes
 * @param {Array}  input.resolutions — from resolveAll().resolutions
 * @param {Array}  input.dsInventory — DS component inventory
 * @param {Object} input.buildContext — { pageId, parentNodeId, designSystemFileKey }
 * @returns {Object} build plan
 */
export function planBuild(input) {
  const { nodes, resolutions, dsInventory, buildContext } = input;

  if (nodes.length !== resolutions.length) {
    throw new Error(`Node count (${nodes.length}) does not match resolution count (${resolutions.length})`);
  }

  const entries = [];
  const counts = { STRICT_MATCH: 0, VALID_MATCH: 0, FALLBACK: 0, BLOCKED: 0 };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const resolution = resolutions[i];
    const outcome = resolution.outcome;

    let entry;

    if (outcome === 'STRICT_MATCH' || outcome === 'VALID_MATCH') {
      entry = planComponentInsertion(node, resolution, buildContext);

      // If component plan is blocked, convert to fallback
      if (entry.blocked) {
        const fallbackEntry = planPrimitiveFallback(node, resolution, buildContext);
        fallbackEntry.warnings.push(`downgraded_from_${outcome}:${entry.blockedReason}`);
        entry = fallbackEntry;
        entry.resolutionType = 'FALLBACK';
        counts.FALLBACK++;
      } else {
        entry.resolutionType = outcome;
        counts[outcome]++;
      }
    } else {
      entry = planPrimitiveFallback(node, resolution, buildContext);
      entry.resolutionType = 'FALLBACK';
      counts.FALLBACK++;
    }

    // Final validation
    entry = validatePlanEntry(entry);
    if (entry.blocked) counts.BLOCKED++;

    entry.nodeIndex = i;
    entry.sourceTag = node.tag;
    entry.sourceText = node.textContent?.trim()?.substring(0, 50) || null;
    entries.push(entry);
  }

  return {
    entries,
    summary: {
      total: entries.length,
      strictMatches: counts.STRICT_MATCH,
      validMatches: counts.VALID_MATCH,
      fallbacks: counts.FALLBACK,
      blocked: counts.BLOCKED,
    },
    buildContext,
    plannedAt: new Date().toISOString(),
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2 — EXECUTE BUILD PLAN
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Convert a plan entry into MCP tool calls.
 * Returns an array of { tool, params } objects ready for figma_batch or individual calls.
 */
function entryToMcpCalls(entry) {
  const calls = [];

  if (entry.blocked) return calls;

  if (entry.executionType === 'INSERT_COMPONENT') {
    // Primary: insert the DS component
    calls.push({
      tool: 'insert_component',
      params: {
        componentKey: entry.componentKey,
        fileKey: entry.fileKey,
        parentNodeId: entry.parentNodeId,
      },
      purpose: 'insert_ds_component',
    });

    // Text bindings: set text on the inserted component
    for (const binding of entry.textBindings) {
      calls.push({
        tool: 'set_component_text',
        params: {
          nodeId: '__LAST_INSERTED__', // Resolved at execution time
          propertyName: binding.target,
          value: binding.value,
        },
        purpose: 'bind_text',
        requiresPreviousNodeId: true,
      });
    }

    // Property bindings: set variant/boolean properties
    for (const binding of entry.propertyBindings) {
      calls.push({
        tool: 'set_variant',
        params: {
          nodeId: '__LAST_INSERTED__',
          propertyName: binding.name,
          value: binding.value,
        },
        purpose: 'bind_property',
        requiresPreviousNodeId: true,
      });
    }
  }

  if (entry.executionType === 'CREATE_PRIMITIVE') {
    const pp = entry.primitivePlan;

    if (pp.nodeType === 'text') {
      calls.push({
        tool: 'create_text',
        params: {
          text: pp.textContent || '',
          parentNodeId: entry.primitivePlan.parentNodeId || entry.parentNodeId,
          fillVariable: pp.fills?.variable || null,
          fillHex: pp.fills?.fallback || null,
          textStyleId: pp.textStyle?.id || null,
        },
        purpose: 'create_primitive_text',
      });
    } else if (pp.nodeType === 'rectangle') {
      calls.push({
        tool: 'create_rectangle',
        params: {
          name: pp.name,
          width: 100,
          height: 100,
          parentNodeId: pp.parentNodeId || entry.parentNodeId,
          fillVariable: pp.fills?.variable || null,
          cornerRadius: pp.radius || null,
        },
        purpose: 'create_primitive_rectangle',
      });
    } else {
      // Frame
      calls.push({
        tool: 'create_frame',
        params: {
          name: pp.name,
          parentNodeId: pp.parentNodeId || entry.parentNodeId,
          direction: pp.layout?.direction || 'VERTICAL',
          primaryAxisSizingMode: pp.layout?.primaryAxisSizingMode || 'AUTO',
          counterAxisSizingMode: pp.layout?.counterAxisSizingMode || 'AUTO',
          fillVariable: pp.fills?.variable || null,
          fillNone: pp.fills?.fillNone || false,
          strokeVariable: pp.strokes?.variable || null,
          strokeWidth: pp.strokes?.width || null,
          cornerRadius: pp.radius || null,
        },
        purpose: 'create_primitive_frame',
      });

      // If the frame has text content, add a text child
      if (pp.textContent) {
        calls.push({
          tool: 'create_text',
          params: {
            text: pp.textContent,
            parentNodeId: '__LAST_CREATED__',
            fillVariable: 'Colors/Text/text-primary',
          },
          purpose: 'create_primitive_text_child',
          requiresPreviousNodeId: true,
        });
      }
    }
  }

  return calls;
}

/**
 * PHASE 2: Execute a build plan through MCP tools.
 *
 * This function prepares the complete MCP call sequence.
 * Actual MCP execution is delegated to the provided callMcp function,
 * which maps to the bridge communication layer.
 *
 * @param {Object} plan — from planBuild()
 * @param {Function} callMcp — async function(toolName, params) → result
 * @returns {Object} execution result with per-entry outcomes
 */
export async function executeBuildPlan(plan, callMcp) {
  const results = [];
  let lastNodeId = null;

  for (const entry of plan.entries) {
    const entryResult = {
      nodeIndex: entry.nodeIndex,
      sourceTag: entry.sourceTag,
      resolutionType: entry.resolutionType,
      executionType: entry.executionType,
      status: 'PENDING',
      mcpCalls: 0,
      errors: [],
      warnings: [...(entry.warnings || [])],
    };

    if (entry.blocked) {
      entryResult.status = 'BLOCKED';
      entryResult.errors.push(entry.blockedReason);
      results.push(entryResult);
      continue;
    }

    const calls = entryToMcpCalls(entry);

    try {
      for (const call of calls) {
        // Resolve dynamic node references
        const params = { ...call.params };
        if (call.requiresPreviousNodeId && lastNodeId) {
          if (params.nodeId === '__LAST_INSERTED__') params.nodeId = lastNodeId;
          if (params.parentNodeId === '__LAST_CREATED__') params.parentNodeId = lastNodeId;
        }

        const result = await callMcp(`figma_${call.tool}`, params);
        entryResult.mcpCalls++;

        // Capture created/inserted node ID for chaining
        if (result?.nodeId) lastNodeId = result.nodeId;
        if (result?.id) lastNodeId = result.id;
      }

      entryResult.status = 'EXECUTED';
    } catch (err) {
      entryResult.status = 'FAILED';
      entryResult.errors.push(err.message);

      // On DS insertion failure, do NOT retry — the plan is what was validated
      // The failure is logged for learning
    }

    results.push(entryResult);
  }

  // Post-execution summary
  const summary = {
    total: results.length,
    executed: results.filter(r => r.status === 'EXECUTED').length,
    blocked: results.filter(r => r.status === 'BLOCKED').length,
    failed: results.filter(r => r.status === 'FAILED').length,
    totalMcpCalls: results.reduce((sum, r) => sum + r.mcpCalls, 0),
  };

  return { results, summary, executedAt: new Date().toISOString() };
}


// ═════════════════════════════════════════════════════════════════════════════
// LEARNING PERSISTENCE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Persist execution patterns for learning.
 *
 * @param {Object} plan — from planBuild()
 * @param {Object} executionResult — from executeBuildPlan() (or null if plan-only)
 * @param {string} buildId — identifier for this build
 */
export function persistExecutionPatterns(plan, executionResult, buildId) {
  let existing = [];
  if (existsSync(EXECUTION_LOG_PATH)) {
    try { existing = JSON.parse(readFileSync(EXECUTION_LOG_PATH, 'utf8')); } catch {}
  }

  const entries = plan.entries.map((entry, i) => {
    const execResult = executionResult?.results?.[i];
    return {
      buildId,
      timestamp: new Date().toISOString(),
      sourceTag: entry.sourceTag,
      resolutionType: entry.resolutionType,
      executionType: entry.executionType,
      componentKey: entry.componentKey || null,
      blocked: entry.blocked,
      blockedReason: entry.blockedReason,
      warnings: entry.warnings,
      executionStatus: execResult?.status || 'NOT_EXECUTED',
      executionErrors: execResult?.errors || [],
      mcpCalls: execResult?.mcpCalls || 0,
    };
  });

  const combined = [...existing, ...entries].slice(-300);
  writeFileSync(EXECUTION_LOG_PATH, JSON.stringify(combined, null, 2), 'utf8');

  return {
    logged: entries.length,
    totalStored: combined.length,
  };
}
