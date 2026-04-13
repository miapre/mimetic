/**
 * html-to-figma-design-system / mcp.js
 *
 * MCP server (stdio transport). Exposes Figma write tools to Claude.
 * Communicates with the local bridge server which forwards instructions
 * to the Figma desktop plugin.
 *
 * Configured in ~/.claude/settings.json — see README.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3055';

// ---------------------------------------------------------------------------
// Knowledge file — persistent DS pattern→component mappings
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || resolve(__dir, 'ds-knowledge.json');

const KNOWLEDGE_VERSION = 1;
const VERIFIED_THRESHOLD = 3; // use_count required for CANDIDATE → VERIFIED promotion

function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_PATH)) {
    return { version: KNOWLEDGE_VERSION, patterns: [], explicit_rules: [], updated: null };
  }
  try {
    const data = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8'));
    // Migrate: older knowledge files may not have explicit_rules
    if (!Array.isArray(data.explicit_rules)) data.explicit_rules = [];
    return data;
  } catch {
    // Corrupted file — back it up before any write overwrites it
    try { renameSync(KNOWLEDGE_PATH, KNOWLEDGE_PATH + '.bak'); } catch { /* ignore */ }
    return { version: KNOWLEDGE_VERSION, patterns: [], explicit_rules: [], updated: null };
  }
}

function saveKnowledge(knowledge) {
  knowledge.updated = new Date().toISOString();
  writeFileSync(KNOWLEDGE_PATH, JSON.stringify(knowledge, null, 2), 'utf8');
}

// Merge an array of incoming pattern updates into the knowledge file.
// Handles: upsert, use_count increment, CANDIDATE→VERIFIED promotion,
// correction_count increment, state override, dismissed_conflicts merge.
function applyPatternUpdates(knowledge, updates) {
  for (const update of updates) {
    const { pattern_key } = update;
    if (!pattern_key) continue;

    const idx = knowledge.patterns.findIndex(p => p.pattern_key === pattern_key);

    if (idx === -1) {
      // New entry
      knowledge.patterns.push({
        pattern_key,
        component_key:        update.component_key ?? null,
        component_name:       update.component_name ?? null,
        state:                update.state ?? 'CANDIDATE',
        use_count:            update.use_count ?? 1,
        correction_count:     update.correction_count ?? 0,
        last_used:            new Date().toISOString(),
        dismissed_conflicts:  update.dismissed_conflicts ?? [],
        notes:                update.notes ?? null,
      });
    } else {
      const entry = knowledge.patterns[idx];

      // Explicit state override (e.g. REJECTED, EXPIRED)
      if (update.state) entry.state = update.state;

      // Increment use_count if requested
      if (update.increment_use) {
        entry.use_count = (entry.use_count ?? 0) + 1;
        entry.last_used = new Date().toISOString();
      }

      // Increment correction_count if requested
      if (update.increment_correction) {
        entry.correction_count = (entry.correction_count ?? 0) + 1;
        // Correction demotes VERIFIED → CANDIDATE
        if (entry.state === 'VERIFIED') entry.state = 'CANDIDATE';
      }

      // Update component binding if provided
      if (update.component_key)  entry.component_key  = update.component_key;
      if (update.component_name) entry.component_name = update.component_name;
      if (update.notes !== undefined) entry.notes = update.notes;

      // Merge dismissed_conflicts
      if (Array.isArray(update.dismissed_conflicts)) {
        entry.dismissed_conflicts = [
          ...new Set([...(entry.dismissed_conflicts ?? []), ...update.dismissed_conflicts])
        ];
      }

      // Auto-promote: CANDIDATE → VERIFIED when threshold met and no corrections
      if (
        entry.state === 'CANDIDATE' &&
        entry.use_count >= VERIFIED_THRESHOLD &&
        entry.correction_count === 0
      ) {
        entry.state = 'VERIFIED';
      }
    }
  }
}

// Merge an array of explicit rule updates (DS gaps, substitutions, conventions)
// into knowledge.explicit_rules.
// Handles: upsert, seen_count increment/reset, state, dismissal, convention init.
function applyRuleUpdates(knowledge, ruleUpdates) {
  if (!Array.isArray(ruleUpdates)) return;
  if (!Array.isArray(knowledge.explicit_rules)) knowledge.explicit_rules = [];

  for (const update of ruleUpdates) {
    const { rule_key } = update;
    if (!rule_key) continue;

    const idx = knowledge.explicit_rules.findIndex(r => r.rule_key === rule_key);
    const isConvention = (update.type ?? 'gap') === 'convention';

    if (idx === -1) {
      // New rule.
      // Conventions don't use seen_count semantically — initialize to 0.
      // Gaps and substitutions start at 1 (first occurrence).
      knowledge.explicit_rules.push({
        rule_key,
        type:              update.type ?? 'gap',
        state:             update.state ?? 'active',
        substitution_key:  update.substitution_key  ?? null,
        substitution_name: update.substitution_name ?? null,
        reason:            update.reason ?? null,
        seen_count:        isConvention ? 0 : 1,
        first_seen:        new Date().toISOString(),
        last_seen:         new Date().toISOString(),
        dismissed:         false,
        notes:             update.notes ?? null,
      });
    } else {
      const rule = knowledge.explicit_rules[idx];
      if (update.type)               rule.type              = update.type;
      if (update.state)              rule.state             = update.state;
      if (update.substitution_key)   rule.substitution_key  = update.substitution_key;
      if (update.substitution_name)  rule.substitution_name = update.substitution_name;
      if (update.reason  !== undefined) rule.reason         = update.reason;
      if (update.notes   !== undefined) rule.notes          = update.notes;
      if (update.dismissed !== undefined) rule.dismissed    = update.dismissed;

      // reset_seen_count takes priority over increment_seen
      if (update.reset_seen_count) {
        rule.seen_count = 0;
        rule.last_seen  = new Date().toISOString();
      } else if (update.increment_seen) {
        rule.seen_count = (rule.seen_count ?? 0) + 1;
        rule.last_seen  = new Date().toISOString();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge communication
// ---------------------------------------------------------------------------

async function callBridge(type, params = {}) {
  let res;
  try {
    res = await fetch(`${BRIDGE_URL}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, params }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the bridge server at ${BRIDGE_URL}. ` +
      'Is it running? Start it with: node bridge.js'
    );
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Bridge returned an error');
  return data.result;
}

// ---------------------------------------------------------------------------
// Pre-execution validator
//
// Catches common payload errors before they hit the plugin, where they would
// produce cryptic "object is not extensible" errors or silently broken layouts.
// ---------------------------------------------------------------------------

// Properties that only exist on FrameNode / auto-layout containers.
// Passing these to text or rectangle nodes crashes the Plugin API.
const FRAME_ONLY_PROPS = new Set([
  'direction', 'gap', 'itemSpacing', 'clipsContent',
  'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
]);

function validate(toolName, args) {
  const errors = [];

  // Text nodes cannot receive auto-layout or frame-only properties.
  if (toolName === 'figma_create_text') {
    for (const prop of FRAME_ONLY_PROPS) {
      if (args[prop] !== undefined) {
        errors.push(`"${prop}" is not valid on figma_create_text (frame-only property — use figma_create_frame instead)`);
      }
    }
  }

  // Rectangle nodes: layout and axis properties are also invalid.
  if (toolName === 'figma_create_rectangle') {
    const rectInvalid = [
      'direction', 'gap', 'itemSpacing', 'clipsContent',
      'primaryAxisSizingMode', 'counterAxisSizingMode',
      'primaryAxisAlignItems', 'counterAxisAlignItems',
    ];
    for (const prop of rectInvalid) {
      if (args[prop] !== undefined) {
        errors.push(`"${prop}" is not valid on figma_create_rectangle`);
      }
    }
  }

  // Component insertion requires componentKey or nodeId.
  if (toolName === 'figma_insert_component') {
    if (!args.componentKey && !args.nodeId) {
      errors.push('"componentKey" (preferred) or "nodeId" is required for figma_insert_component');
    }
  }

  // set_component_text requires nodeId, propertyName, value.
  if (toolName === 'figma_set_component_text') {
    if (!args.nodeId)       errors.push('"nodeId" is required for figma_set_component_text');
    if (!args.propertyName) errors.push('"propertyName" is required for figma_set_component_text');
    if (args.value === undefined) errors.push('"value" is required for figma_set_component_text');
  }

  // batch requires a non-empty operations array.
  if (toolName === 'figma_batch') {
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      errors.push('"operations" must be a non-empty array for figma_batch');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validation error in ${toolName}:\n${errors.map(e => `  • ${e}`).join('\n')}`);
  }
}

// Auto-fix: when an auto-layout frame has explicit width + height but no
// primaryAxisSizingMode, default to FIXED so the frame does not collapse to HUG.
function autofix(toolName, args) {
  if (toolName === 'figma_create_frame') {
    if (
      args.width !== undefined &&
      args.height !== undefined &&
      args.direction && args.direction !== 'NONE' &&
      !args.primaryAxisSizingMode
    ) {
      args.primaryAxisSizingMode = 'FIXED';
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // ── Write tools ──────────────────────────────────────────────────────────

  {
    name: 'figma_insert_component',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Insert a library component instance into a Figma frame. ' +
      'Use this to insert any published component from your design system library — ' +
      'navigation bars, headers, footers, section titles, cards, buttons, badges, and so on. ' +
      'This inserts the real library instance — not a recreation. ' +
      'Provide componentKey (preferred, from a DS search result) OR nodeId (component node ID in the library file).',
    inputSchema: {
      type: 'object',
      properties: {
        componentKey: { type: 'string', description: 'Component key hash from a design system search result. Preferred over nodeId.' },
        nodeId:       { type: 'string', description: 'Component node ID in the library file. Only needed when componentKey is unknown.' },
        fileKey:      { type: 'string', description: 'Figma file key of the design system library file.' },
        parentNodeId: { type: 'string', description: 'Node ID of the parent frame. Omit to place on current page.' },
        x:            { type: 'number' },
        y:            { type: 'number' },
        width:        { type: 'number', description: 'Resize instance to this width after insertion.' },
        height:       { type: 'number', description: 'Resize instance to this height after insertion.' },
      },
      required: ['fileKey'],
    },
  },

  {
    name: 'figma_create_frame',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Create an auto-layout frame. Use for application shells, content containers, cards, rows, columns.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'Layer name' },
        parentNodeId: { type: 'string', description: 'Append to this parent. Omit to place on current page.' },
        width:        { type: 'number' },
        height:       { type: 'number' },
        direction: {
          type: 'string',
          enum: ['HORIZONTAL', 'VERTICAL', 'NONE'],
          description: 'Auto-layout direction. NONE = no auto-layout.',
        },
        gap:           { type: 'number', description: 'Gap between children in px.' },
        padding:       { type: 'number', description: 'Uniform padding on all sides in px.' },
        paddingTop:    { type: 'number' },
        paddingRight:  { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft:   { type: 'number' },
        primaryAxisSizingMode: {
          type: 'string', enum: ['FIXED', 'AUTO'],
          description: 'AUTO = hug contents along primary axis. Defaults to FIXED when width+height are set.',
        },
        counterAxisSizingMode: {
          type: 'string', enum: ['FIXED', 'AUTO'],
          description: 'AUTO = hug contents along counter axis.',
        },
        primaryAxisAlignItems: {
          type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'],
        },
        counterAxisAlignItems: {
          type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'],
        },
        fillVariable: {
          type: 'string',
          description: 'Design token variable path for background fill, e.g. "Colors/Background/bg-primary".',
        },
        fillHex:      { type: 'string', description: 'Fallback hex color if fillVariable is not available.' },
        fillNone:     { type: 'boolean', description: 'Set true for no fill (transparent).' },
        strokeVariable: { type: 'string', description: 'Variable path for border color.' },
        strokeHex:    { type: 'string', description: 'Fallback hex for border color.' },
        strokeWidth:  { type: 'number', description: 'Border width in px.' },
        cornerRadius: { type: 'number', description: 'Corner radius in px.' },
        clipsContent: { type: 'boolean' },
        layoutGrow:   { type: 'number', description: '1 = fill remaining space in parent.' },
        layoutAlign:  { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['name'],
    },
  },

  {
    name: 'figma_create_text',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Create a text node. ' +
      'For DS compliance, always pass textStyleId (a DS text style ID from figma_list_text_styles) ' +
      'AND fillVariable (a DS color variable path). ' +
      'Raw fontSize/fontWeight/lineHeight are accepted as fallbacks but DS styles are preferred.',
    inputSchema: {
      type: 'object',
      properties: {
        text:         { type: 'string', description: 'Text content.' },
        parentNodeId: { type: 'string' },
        textStyleId:  { type: 'string', description: 'DS text style ID (e.g. "S:abc123,7649:603"). Use figma_list_text_styles to discover IDs.' },
        fillVariable: { type: 'string', description: 'Color token path, e.g. "Colors/Text/text-primary".' },
        fillHex:      { type: 'string', description: 'Fallback hex color.' },
        fontSize:     { type: 'number', description: 'Fallback — prefer textStyleId.' },
        fontWeight:   { type: 'number', enum: [400, 500, 600, 700], description: 'Fallback — prefer textStyleId.' },
        lineHeight:   { type: 'number', description: 'Line height in px. Fallback — prefer textStyleId.' },
        textAlignHorizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'] },
        width:        { type: 'number', description: 'Fixed width — text wraps at this width.' },
        layoutGrow:   { type: 'number' },
        layoutAlign:  { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['text'],
    },
  },

  {
    name: 'figma_create_rectangle',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Create a rectangle. Useful for dividers (e.g. 1px tall), image placeholders, colored blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string' },
        width:        { type: 'number' },
        height:       { type: 'number' },
        parentNodeId: { type: 'string' },
        fillVariable: { type: 'string' },
        fillHex:      { type: 'string' },
        fillNone:     { type: 'boolean' },
        strokeVariable: { type: 'string' },
        strokeHex:    { type: 'string' },
        strokeWidth:  { type: 'number' },
        cornerRadius: { type: 'number' },
        layoutGrow:   { type: 'number' },
        x:            { type: 'number' },
        y:            { type: 'number' },
      },
      required: ['width', 'height'],
    },
  },

  {
    name: 'figma_set_component_text',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Set a text property on a component instance. ' +
      'Tries component properties first, then falls back to text layer name search. ' +
      'Use figma_get_node_props to discover available property names before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Node ID of the component instance.' },
        propertyName: { type: 'string', description: 'Component property name or text layer name to set.' },
        value:        { type: 'string', description: 'New text value.' },
      },
      required: ['nodeId', 'propertyName', 'value'],
    },
  },

  {
    name: 'figma_set_layout_sizing',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Adjust layout sizing, alignment, padding, or explicit dimensions of a node within its auto-layout parent.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:                { type: 'string' },
        layoutGrow:            { type: 'number', description: '0 = fixed, 1 = fill container.' },
        layoutAlign:           { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'] },
        primaryAxisSizingMode: { type: 'string', enum: ['FIXED', 'AUTO'] },
        counterAxisSizingMode: { type: 'string', enum: ['FIXED', 'AUTO'] },
        layoutSizingHorizontal: { type: 'string', enum: ['FILL', 'HUG', 'FIXED'] },
        layoutSizingVertical:   { type: 'string', enum: ['FILL', 'HUG', 'FIXED'] },
        paddingTop:    { type: 'number' },
        paddingRight:  { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft:   { type: 'number' },
        width:         { type: 'number' },
        height:        { type: 'number' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_set_text',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Set text content on a TEXT node directly by its node ID. ' +
      'Use this to target a specific nested text node inside a component instance ' +
      'when figma_set_component_text cannot reach it by property name. ' +
      'Get nested text node IDs from figma_get_node_props.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID of the TEXT node (can be a nested "I..." ID).' },
        value:  { type: 'string', description: 'New text content.' },
      },
      required: ['nodeId', 'value'],
    },
  },

  {
    name: 'figma_set_node_fill',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Set a fill or stroke color variable on any node. ' +
      'For component instances, walks to the first vector-type descendant (the actual colored shape inside an icon). ' +
      'Use this to apply DS color variables to nodes after insertion.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string' },
        variablePath: { type: 'string', description: 'DS color variable path, e.g. "Colors/Icon/icon-primary".' },
        hexFallback:  { type: 'string', description: 'Hex color fallback if variable cannot be resolved.' },
        target:       { type: 'string', enum: ['fill', 'stroke'], description: 'Default: "fill".' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_set_visibility',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Show or hide any node.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:  { type: 'string' },
        visible: { type: 'boolean' },
      },
      required: ['nodeId', 'visible'],
    },
  },

  {
    name: 'figma_set_variant',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Directly set a VARIANT or BOOLEAN component property on an instance. ' +
      'Use this when figma_set_component_text fails due to "existing errors" on a nested instance. ' +
      'Use figma_get_component_variants to discover available variant values first.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string' },
        propertyName: { type: 'string', description: 'Component property name, e.g. "State" or "size".' },
        value:        { description: 'String for VARIANT, boolean for BOOLEAN.' },
      },
      required: ['nodeId', 'propertyName', 'value'],
    },
  },

  {
    name: 'figma_swap_main_component',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Swap the main component of an INSTANCE node to a different component (by key). ' +
      'Changes which variant the instance is based on — bypasses setProperties entirely. ' +
      'Use figma_get_component_variants to find available variant keys.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Node ID of the INSTANCE to swap.' },
        componentKey: { type: 'string', description: 'Key of the new component to swap to.' },
      },
      required: ['nodeId', 'componentKey'],
    },
  },

  {
    name: 'figma_replace_component',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      'Replace an existing node with a new component instance at the same position in its parent. ' +
      'Deletes the target node, inserts the new component at the same parent index. ' +
      'Use this to fix a wrong component insertion without rebuilding the parent frame.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Node ID of the node to replace.' },
        componentKey: { type: 'string', description: 'Key of the replacement component.' },
        fileKey:      { type: 'string' },
        layoutSizingHorizontal: { type: 'string', enum: ['FILL', 'HUG', 'FIXED'] },
        layoutSizingVertical:   { type: 'string', enum: ['FILL', 'HUG', 'FIXED'] },
        height:       { type: 'number' },
      },
      required: ['nodeId', 'componentKey'],
    },
  },

  {
    name: 'figma_move_node',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Reorder a node within its current parent by moving it to a specific child index. ' +
      'Index 0 = front of stack (bottom in layer panel). ' +
      'Use figma_get_node_parent to see current sibling order before moving.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        index:  { type: 'number', description: 'Target index within the parent children array.' },
      },
      required: ['nodeId', 'index'],
    },
  },

  {
    name: 'figma_delete_node',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Delete a node from the Figma document.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_create_chart',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Render a chart directly in Figma. All data is sent in one call — no per-element round trips. ' +
      'Supported chart types:\n' +
      '  • scatter / jitter — scatter plot with categorical Y bands\n' +
      '  • line — line chart with optional area fill, smooth curves, multi-series\n' +
      '  • donut / pie — donut or pie chart with legend and optional center label\n' +
      '  • bar / histogram — vertical bar chart with optional stacked segments; supports annotation vlines',
    inputSchema: {
      type: 'object',
      properties: {
        chartType: {
          type: 'string',
          enum: ['scatter', 'jitter', 'line', 'area', 'donut', 'pie', 'bar', 'histogram'],
        },
        parentNodeId: { type: 'string' },
        name:         { type: 'string' },
        width:        { type: 'number' },
        height:       { type: 'number' },
        bars:         { type: 'array' },
        annotations:  { type: 'array' },
        data:         { type: 'array' },
        xDomain:      { type: 'array', items: { type: 'number' } },
        categories:   { type: 'object' },
        categoryOrder: { type: 'array', items: { type: 'string' } },
        dotSize:      { type: 'number' },
        jitter:       { type: 'boolean' },
        xTicks:       { type: 'array' },
        tickSuffix:   { type: 'string' },
        xLabel:       { type: 'string' },
        series:       { type: 'array' },
        yDomain:      { type: 'array', items: { type: 'number' } },
        yTicks:       { type: 'array' },
        xTickSuffix:  { type: 'string' },
        yTickSuffix:  { type: 'string' },
        yLabel:       { type: 'string' },
        size:         { type: 'number' },
        innerRadius:  { type: 'number' },
        centerLabel:  { type: 'string' },
        centerSubLabel: { type: 'string' },
      },
      required: ['chartType'],
    },
  },

  {
    name: 'figma_batch',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Execute multiple Figma operations in a single bridge round trip. ' +
      'Use this for repetitive structures — table rows, list items, grid cells, repeated cards — ' +
      'where individual calls would be impractical. ' +
      'Each operation in the array is a { tool, params } object using the same tool names as the individual tools ' +
      '(without the figma_ prefix internally). ' +
      'Returns an array of results in the same order as the operations. ' +
      'A failed operation is reported with { ok: false, error } and does not stop subsequent operations.',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Array of operations to execute. Each: { tool: string, params: object }. ' +
            'tool values: "create_frame", "create_text", "create_rectangle", "set_component_text", ' +
            '"set_layout_sizing", "set_text", "set_node_fill", "set_visibility", "insert_component".',
          items: {
            type: 'object',
            properties: {
              tool:   { type: 'string' },
              params: { type: 'object' },
            },
            required: ['tool', 'params'],
          },
        },
      },
      required: ['operations'],
    },
  },

  // ── Read / inspect tools ─────────────────────────────────────────────────

  {
    name: 'figma_get_node_props',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Get the component properties and all text layers of a node. ' +
      'Call this before figma_set_component_text to discover valid property names. ' +
      'Also useful for Phase 5 validation — verify DS text styles are applied. ' +
      'Returns: { type, name, componentProperties: [{key, type, value}], textLayers: [{id, name, chars}] }',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_node_children',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'List all direct children of a node with their IDs, names, types, and dimensions. ' +
      'Use after construction to verify hierarchy or find a specific child node ID.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_node_parent',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Get the parent of a node, including all sibling children with their IDs and positions. ' +
      'Use to understand the current layout context or verify sibling order.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_text_info',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Get the text style ID, font properties, and fill variable of a TEXT node. ' +
      'Use during Phase 5 validation to verify DS text style and color variable compliance. ' +
      'Returns: { textStyleId, fontName, fontSize, characters, fillVariable }',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_list_text_styles',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'List all local text styles in the document with their IDs and names. ' +
      'Call this during Phase 2.5 (DS inspection) to discover available text style IDs ' +
      'before constructing text nodes. Use the returned IDs as textStyleId in figma_create_text.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_get_component_variants',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Get all variant siblings of an instance\'s main component (all options in the component set). ' +
      'Use this to discover available variant values before calling figma_set_variant or figma_swap_main_component. ' +
      'Returns: { variants: [{id, key, name}] }',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID of an INSTANCE node.' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_selection',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Get the currently selected nodes in Figma. Returns node IDs, names, and dimensions.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_select_node',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Select a node in Figma and scroll it into view.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_get_page_nodes',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'List all top-level nodes on the current Figma page (names, IDs, positions, dimensions).',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_get_pages',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'List all pages in the Figma document with their IDs and names. ' +
      'Use before figma_change_page to find the correct pageId.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'figma_change_page',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Switch the active Figma page. Subsequent operations will target the new page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId:   { type: 'string', description: 'Page node ID from figma_get_pages.' },
        pageName: { type: 'string', description: 'Page name — used if pageId is not provided.' },
      },
    },
  },

  // ── Mimetic learning loop ─────────────────────────────────────────────────

  {
    name: 'mimetic_knowledge_read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Read the Mimetic design system knowledge file (ds-knowledge.json). ' +
      'Call this at the start of every HTML-to-Figma run to load known pattern→component mappings. ' +
      'VERIFIED entries should be used directly without a fresh DS lookup. ' +
      'CANDIDATE entries should be used with a confirming DS check. ' +
      'Returns the full knowledge object, or a single entry if pattern_key is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern_key: {
          type: 'string',
          description: 'Optional. Return only the entry matching this pattern key (e.g. "metric/kpi"). Omit to return all entries.',
        },
      },
    },
  },

  {
    name: 'mimetic_knowledge_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Write pattern→component mappings and explicit DS rules to the Mimetic knowledge file (ds-knowledge.json). ' +
      'Call this at the end of every successful HTML-to-Figma run. ' +
      'Automatically promotes CANDIDATE entries to VERIFIED once use_count reaches 3 with no corrections. ' +
      'Use increment_correction=true when the user corrected a mapping — also write a matching rule_update with reset_seen_count=true. ' +
      'Use state="REJECTED" to permanently suppress a mapping. ' +
      'Use dismissed_conflicts to suppress a DS evolution conflict notice for a specific candidate component. ' +
      'Use rule_updates to record DS gaps, substitutions, and conventions. ' +
      'Use reset_gap_seen_counts=true when the user signals their DS was updated — resets all gap AND substitution rules so new components can be discovered. ' +
      'Gaps with seen_count ≥ 3 are surfaced as DS enhancement recommendations (unless dismissed or resolved). ' +
      'Response includes key_warnings (malformed key format — treat as errors, fix immediately) and rule_type_warnings (rule type changed — confirm intentional).',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Array of pattern entry updates to apply.',
          items: {
            type: 'object',
            properties: {
              pattern_key:          { type: 'string',  description: 'Required. Canonical taxonomy key (e.g. "metric/kpi", "label/chip"). Must match the Pattern Key Taxonomy.' },
              component_key:        { type: 'string',  description: 'Figma component key hash for the mapped DS component.' },
              component_name:       { type: 'string',  description: 'Human-readable component name.' },
              state:                { type: 'string',  enum: ['CANDIDATE', 'VERIFIED', 'REJECTED', 'EXPIRED'], description: 'Explicit state override. Omit to let promotion logic handle CANDIDATE→VERIFIED automatically.' },
              increment_use:        { type: 'boolean', description: 'Set true to increment use_count by 1 for an existing entry.' },
              increment_correction: { type: 'boolean', description: 'Set true when the user corrected this mapping. Increments correction_count and demotes VERIFIED→CANDIDATE. Also write a rule_update with reset_seen_count=true for any associated rule.' },
              dismissed_conflicts:  { type: 'array',   items: { type: 'string' }, description: 'Component keys to suppress in future DS evolution conflict scans.' },
              notes:                { type: 'string',  description: 'Optional context note.' },
            },
            required: ['pattern_key'],
          },
        },
        rule_updates: {
          type: 'array',
          description: 'Array of explicit DS rule updates: gaps (no component exists), substitutions (use this instead), or conventions (DS usage rules).',
          items: {
            type: 'object',
            properties: {
              rule_key:          { type: 'string',  description: 'Required. Pattern key this rule applies to (e.g. "label/chip"). Must match the Pattern Key Taxonomy.' },
              type:              { type: 'string',  enum: ['gap', 'substitution', 'convention'], description: 'gap = no DS component; substitution = use substitution_key instead; convention = DS usage rule.' },
              state:             { type: 'string',  enum: ['active', 'resolved'], description: 'Set "resolved" when a previously missing DS component now exists. Removes the rule from future recommendations and re-enables DS search.' },
              substitution_key:  { type: 'string',  description: 'Component key to use as fallback when pattern has no direct DS match.' },
              substitution_name: { type: 'string',  description: 'Human-readable name of the substitution component.' },
              reason:            { type: 'string',  description: 'Why this rule exists.' },
              increment_seen:    { type: 'boolean', description: 'Set true to increment seen_count by 1. Use for gap/substitution rules — not for conventions.' },
              reset_seen_count:  { type: 'boolean', description: 'Set true to reset seen_count to 0. Use when a correction is made (paired with increment_correction on the pattern update) or when demoting a stale rule.' },
              dismissed:         { type: 'boolean', description: 'Set true to permanently suppress this gap from DS recommendations. Use when the user acknowledges the gap and decides not to add the component.' },
              notes:             { type: 'string',  description: 'Optional context about this rule.' },
            },
            required: ['rule_key'],
          },
        },
        reset_gap_seen_counts: {
          type: 'boolean',
          description: 'Set true when the user signals their design system was updated. Resets seen_count to 0 on ALL gap-type rules, causing Mimetic to re-run DS search for those patterns on the next run and discover any newly added components.',
        },
      },
      required: ['updates'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool → bridge instruction mapping
// ---------------------------------------------------------------------------

// All tools in this set pass params directly to the bridge.
// The bridge type is derived by stripping the "figma_" prefix.
const DIRECT_PASS = new Set([
  'figma_create_frame',
  'figma_create_text',
  'figma_create_rectangle',
  'figma_set_component_text',
  'figma_set_layout_sizing',
  'figma_set_text',
  'figma_set_node_fill',
  'figma_set_visibility',
  'figma_set_variant',
  'figma_swap_main_component',
  'figma_replace_component',
  'figma_move_node',
  'figma_delete_node',
  'figma_create_chart',
  'figma_batch',
  'figma_get_node_props',
  'figma_get_node_children',
  'figma_get_node_parent',
  'figma_get_text_info',
  'figma_list_text_styles',
  'figma_get_component_variants',
  'figma_get_selection',
  'figma_select_node',
  'figma_get_page_nodes',
  'figma_get_pages',
  'figma_change_page',
]);

// Strip "figma_" prefix to get the bridge instruction type.
function bridgeType(toolName) {
  return toolName.replace(/^figma_/, '');
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mimetic', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Run pre-execution validation — throws on invalid payloads.
    validate(name, args);

    // Auto-fix known silent failure patterns before sending to bridge.
    const fixedArgs = autofix(name, { ...args });

    let result;

    if (name === 'mimetic_knowledge_read') {
      const knowledge = loadKnowledge();
      if (fixedArgs.pattern_key) {
        const entry = knowledge.patterns.find(p => p.pattern_key === fixedArgs.pattern_key) ?? null;
        result = { entry, path: KNOWLEDGE_PATH };
      } else {
        result = { ...knowledge, path: KNOWLEDGE_PATH };
      }

    } else if (name === 'mimetic_knowledge_write') {
      const knowledge = loadKnowledge();

      // DS update signal: reset gap AND substitution rules so newly added DS components can be discovered.
      // Substitution rules are reset too — if the real component was added to the DS, the substitution
      // should be re-evaluated rather than continuing to win Phase 3 step 0 indefinitely.
      if (fixedArgs.reset_gap_seen_counts) {
        for (const rule of knowledge.explicit_rules) {
          if (rule.type === 'gap' || rule.type === 'substitution') rule.seen_count = 0;
        }
      }

      // Type transition check: warn when an existing rule's type is being changed.
      // Must run BEFORE applyRuleUpdates mutates the entries.
      const typeWarnings = [];
      for (const u of (fixedArgs.rule_updates ?? [])) {
        if (u.rule_key && u.type) {
          const existing = knowledge.explicit_rules.find(r => r.rule_key === u.rule_key);
          if (existing && existing.type !== u.type) {
            typeWarnings.push(
              `rule_key "${u.rule_key}" type is changing from "${existing.type}" to "${u.type}" — confirm this is intentional`
            );
          }
        }
      }

      applyPatternUpdates(knowledge, fixedArgs.updates ?? []);
      applyRuleUpdates(knowledge, fixedArgs.rule_updates ?? []);
      saveKnowledge(knowledge);

      // Only active, non-dismissed gap rules at threshold surface as recommendations
      const recommendations = (knowledge.explicit_rules ?? []).filter(
        r => r.type === 'gap' && r.state !== 'resolved' && !r.dismissed && r.seen_count >= 3
      );

      // Soft key format check: pattern_key and rule_key should be category/name
      const keyFormatRe = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
      const keyWarnings = [];
      for (const u of (fixedArgs.updates ?? [])) {
        if (u.pattern_key && !keyFormatRe.test(u.pattern_key)) {
          keyWarnings.push(`pattern_key "${u.pattern_key}" does not match taxonomy format (expected "category/name" — e.g. "metric/kpi")`);
        }
      }
      for (const u of (fixedArgs.rule_updates ?? [])) {
        if (u.rule_key && !keyFormatRe.test(u.rule_key)) {
          keyWarnings.push(`rule_key "${u.rule_key}" does not match taxonomy format (expected "category/name")`);
        }
      }

      result = {
        updated: knowledge.updated,
        total_patterns: knowledge.patterns.length,
        verified: knowledge.patterns.filter(p => p.state === 'VERIFIED').length,
        candidate: knowledge.patterns.filter(p => p.state === 'CANDIDATE').length,
        total_rules: (knowledge.explicit_rules ?? []).length,
        ds_recommendations: recommendations.length,
        recommendations: recommendations.map(r => ({ rule_key: r.rule_key, seen_count: r.seen_count, reason: r.reason })),
        ...(keyWarnings.length  > 0 && { key_warnings:       keyWarnings  }),
        ...(typeWarnings.length > 0 && { rule_type_warnings: typeWarnings }),
        path: KNOWLEDGE_PATH,
      };

    } else if (name === 'figma_insert_component') {
      result = await callBridge('insert_component', fixedArgs);
    } else if (DIRECT_PASS.has(name)) {
      result = await callBridge(bridgeType(name), fixedArgs);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };

  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
