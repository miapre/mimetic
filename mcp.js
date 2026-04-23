/**
 * Mimic AI / mcp.js
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

import { renderPage } from './internal/rendering/renderer.js';
import { resolveInput } from './internal/rendering/pipeline-controller.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3055';

// ---------------------------------------------------------------------------
// Knowledge file — persistent DS pattern→component mappings
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = process.env.KNOWLEDGE_PATH || resolve(__dir, 'ds-knowledge.json');

const KNOWLEDGE_VERSION = 2;
const VERIFIED_THRESHOLD = 3; // use_count required for CANDIDATE → VERIFIED promotion
const CONFIDENCE_CORRECTION = 0.9;
const CONFIDENCE_AUTO_INFERRED = 0.5;
const CONFIDENCE_AUTO_PROMOTED = 0.8;
const CONFIDENCE_CACHE_THRESHOLD = 0.8; // Minimum confidence for warm-cache use
const CONFIDENCE_EXPIRE_THRESHOLD = 0.3; // Below this after 5 builds → auto-expire
const EXPIRE_BUILD_COUNT = 5;

// Migrate V1 pattern to V2 format (additive, non-breaking)
function migratePatternV1toV2(p) {
  return {
    ...p,
    confidence:           p.confidence ?? (p.state === 'VERIFIED' ? CONFIDENCE_AUTO_PROMOTED : CONFIDENCE_AUTO_INFERRED),
    source:               p.source ?? (p.correction_count > 0 ? 'user_correction' : 'auto_inferred'),
    valid_until:          p.valid_until ?? null,
    supersedes:           p.supersedes ?? [],
    configuration_recipe: p.configuration_recipe ?? null,
    variant:              p.variant ?? null,
    props_mapping:        p.props_mapping ?? null,
    signature:            p.signature ?? p.pattern_key,
    scope:                p.scope ?? 'project',
    examples:             p.examples ?? [],
    last_validated:       p.last_validated ?? null,
  };
}

function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_PATH)) {
    return {
      version: KNOWLEDGE_VERSION,
      patterns: [],
      explicit_rules: [],
      gaps: {},
      catalog: { componentSets: [], styles: [], variables: [], last_refreshed: null },
      meta: { schema_version: KNOWLEDGE_VERSION, total_patterns: 0, verified_patterns: 0 },
      updated: null,
    };
  }
  try {
    const data = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8'));

    // Migrate V1 → V2
    if (!data.version || data.version < 2) {
      data.version = KNOWLEDGE_VERSION;
      // Migrate patterns
      if (Array.isArray(data.patterns)) {
        data.patterns = data.patterns.map(migratePatternV1toV2);
      }
      // Ensure new sections exist
      if (!data.gaps) data.gaps = {};
      if (!data.catalog) data.catalog = { componentSets: [], styles: [], variables: [], last_refreshed: null };
      if (!data.meta) data.meta = { schema_version: KNOWLEDGE_VERSION, total_patterns: 0, verified_patterns: 0 };
    }

    // Ensure required arrays/objects exist regardless of version
    if (!Array.isArray(data.explicit_rules)) data.explicit_rules = [];
    if (!Array.isArray(data.patterns)) data.patterns = [];
    if (!data.gaps) data.gaps = {};
    if (!data.catalog) data.catalog = { componentSets: [], styles: [], variables: [], last_refreshed: null };

    // Update meta counts
    data.meta = data.meta || {};
    data.meta.schema_version = KNOWLEDGE_VERSION;
    data.meta.total_patterns = data.patterns.filter(p => !p.valid_until).length;
    data.meta.verified_patterns = data.patterns.filter(p => p.state === 'VERIFIED' && !p.valid_until).length;

    return data;
  } catch {
    try { renameSync(KNOWLEDGE_PATH, KNOWLEDGE_PATH + '.bak'); } catch { /* ignore */ }
    return {
      version: KNOWLEDGE_VERSION,
      patterns: [],
      explicit_rules: [],
      gaps: {},
      catalog: { componentSets: [], styles: [], variables: [], last_refreshed: null },
      meta: { schema_version: KNOWLEDGE_VERSION, total_patterns: 0, verified_patterns: 0 },
      updated: null,
    };
  }
}

function saveKnowledge(knowledge) {
  knowledge.updated = new Date().toISOString();
  knowledge.version = KNOWLEDGE_VERSION;
  // Update meta counts before save
  knowledge.meta = knowledge.meta || {};
  knowledge.meta.schema_version = KNOWLEDGE_VERSION;
  knowledge.meta.total_patterns = knowledge.patterns.filter(p => !p.valid_until).length;
  knowledge.meta.verified_patterns = knowledge.patterns.filter(p => p.state === 'VERIFIED' && !p.valid_until).length;
  writeFileSync(KNOWLEDGE_PATH, JSON.stringify(knowledge, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// V2 Knowledge operations — Pattern lifecycle
// ---------------------------------------------------------------------------

// Invalidate a pattern (cache miss — component removed or variant changed)
function invalidatePattern(knowledge, patternKey, reason) {
  const entry = knowledge.patterns.find(p => p.pattern_key === patternKey && !p.valid_until);
  if (entry) {
    entry.valid_until = new Date().toISOString();
    entry.notes = (entry.notes || '') + ` [Invalidated: ${reason}]`;
  }
}

// Supersede a pattern with a new one (user correction)
function supersedePattern(knowledge, oldPatternKey, newPattern) {
  // Invalidate old
  const oldEntry = knowledge.patterns.find(p => p.pattern_key === oldPatternKey && !p.valid_until);
  const oldId = oldEntry ? (oldEntry.id || oldEntry.pattern_key) : null;
  if (oldEntry) {
    oldEntry.valid_until = new Date().toISOString();
  }
  // Create new with supersedes reference
  const newEntry = {
    pattern_key:          newPattern.pattern_key || oldPatternKey,
    component_key:        newPattern.component_key,
    component_name:       newPattern.component_name ?? null,
    library_key:          newPattern.library_key || null,
    library_name:         newPattern.library_name || null,
    state:                'CANDIDATE',
    use_count:            1,
    correction_count:     0,
    last_used:            new Date().toISOString(),
    dismissed_conflicts:  [],
    notes:                newPattern.notes ?? null,
    // V2 fields
    confidence:           newPattern.confidence ?? CONFIDENCE_CORRECTION,
    source:               newPattern.source ?? 'user_correction',
    valid_until:          null,
    supersedes:           oldId ? [oldId] : [],
    configuration_recipe: newPattern.configuration_recipe ?? null,
    variant:              newPattern.variant ?? null,
    props_mapping:        newPattern.props_mapping ?? null,
    signature:            newPattern.signature ?? newPattern.pattern_key,
    scope:                newPattern.scope ?? 'project',
    examples:             newPattern.examples ?? [],
    last_validated:       new Date().toISOString(),
  };
  knowledge.patterns.push(newEntry);
  return newEntry;
}

// Track a DS gap
function trackGap(knowledge, gapId, description, recommendation, buildId) {
  if (!knowledge.gaps) knowledge.gaps = {};
  const existing = knowledge.gaps[gapId];
  if (existing) {
    existing.affected_elements = (existing.affected_elements || 0) + 1;
    if (!existing.builds_affected.includes(buildId)) {
      existing.builds_affected.push(buildId);
    }
  } else {
    knowledge.gaps[gapId] = {
      id: gapId,
      description,
      affected_elements: 1,
      first_seen: new Date().toISOString(),
      builds_affected: [buildId],
      recommendation,
      resolved: false,
    };
  }
}

// Mark a gap as resolved (DS now has the component)
function resolveGap(knowledge, gapId) {
  if (knowledge.gaps && knowledge.gaps[gapId]) {
    knowledge.gaps[gapId].resolved = true;
  }
}

// Update catalog (DS inventory cache)
function updateCatalog(knowledge, catalog) {
  knowledge.catalog = {
    ...catalog,
    last_refreshed: new Date().toISOString(),
  };
}

// Merge an array of incoming pattern updates into the knowledge file.
// Handles: upsert, use_count increment, CANDIDATE→VERIFIED promotion,
// correction_count increment, state override, dismissed_conflicts merge.
// V2: also handles confidence, source, valid_until, supersedes, configuration_recipe,
// variant, props_mapping, signature, scope, examples, last_validated.
function applyPatternUpdates(knowledge, updates) {
  for (const update of updates) {
    const { pattern_key } = update;
    if (!pattern_key) continue;

    // Only match currently-valid patterns (valid_until === null)
    const idx = knowledge.patterns.findIndex(
      p => p.pattern_key === pattern_key && !p.valid_until
    );

    if (idx === -1) {
      // New entry — V2 schema
      knowledge.patterns.push({
        pattern_key,
        component_key:        update.component_key ?? null,
        component_name:       update.component_name ?? null,
        library_key:          update.library_key ?? null,
        library_name:         update.library_name ?? null,
        state:                update.state ?? 'CANDIDATE',
        use_count:            update.use_count ?? 1,
        correction_count:     update.correction_count ?? 0,
        last_used:            new Date().toISOString(),
        dismissed_conflicts:  update.dismissed_conflicts ?? [],
        notes:                update.notes ?? null,
        // V2 fields
        confidence:           update.confidence ?? CONFIDENCE_AUTO_INFERRED,
        source:               update.source ?? 'auto_inferred',
        valid_until:          null,
        supersedes:           update.supersedes ?? [],
        configuration_recipe: update.configuration_recipe ?? null,
        variant:              update.variant ?? null,
        props_mapping:        update.props_mapping ?? null,
        signature:            update.signature ?? pattern_key,
        scope:                update.scope ?? 'project',
        examples:             update.examples ?? [],
        last_validated:       update.last_validated ?? null,
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

      // Increment correction_count if requested — V2: also supersede
      if (update.increment_correction) {
        entry.correction_count = (entry.correction_count ?? 0) + 1;
        // Correction demotes VERIFIED → CANDIDATE and reduces confidence
        if (entry.state === 'VERIFIED') entry.state = 'CANDIDATE';
        entry.confidence = Math.max((entry.confidence ?? 0.5) - 0.2, 0.1);
      }

      // Update component binding if provided
      if (update.component_key)  entry.component_key  = update.component_key;
      if (update.component_name) entry.component_name = update.component_name;
      if (update.library_key !== undefined) entry.library_key = update.library_key;
      if (update.library_name !== undefined) entry.library_name = update.library_name;
      if (update.notes !== undefined) entry.notes = update.notes;

      // V2 field updates
      if (update.confidence !== undefined)           entry.confidence = update.confidence;
      if (update.source)                             entry.source = update.source;
      if (update.configuration_recipe !== undefined) entry.configuration_recipe = update.configuration_recipe;
      if (update.variant !== undefined)              entry.variant = update.variant;
      if (update.props_mapping !== undefined)        entry.props_mapping = update.props_mapping;
      if (update.last_validated)                     entry.last_validated = update.last_validated;
      if (update.signature)                          entry.signature = update.signature;

      // Append examples if provided
      if (Array.isArray(update.examples)) {
        entry.examples = [...(entry.examples ?? []), ...update.examples].slice(-10); // keep last 10
      }

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
        entry.confidence = Math.max(entry.confidence ?? 0.5, CONFIDENCE_AUTO_PROMOTED);
        entry.source = entry.source === 'auto_inferred' ? 'auto_promoted' : entry.source;
      }

      // Auto-expire: low confidence after many builds
      if (
        (entry.confidence ?? 0.5) < CONFIDENCE_EXPIRE_THRESHOLD &&
        entry.use_count >= EXPIRE_BUILD_COUNT
      ) {
        entry.valid_until = new Date().toISOString();
        entry.notes = (entry.notes || '') + ' [Auto-expired: low confidence after ' + entry.use_count + ' builds]';
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
  // ── Status ────────────────────────────────────────────────────────────────

  {
    name: 'mimic_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Check Mimic AI readiness — the reviewer for your design system. Returns bridge status, ' +
      'plugin connection, DS knowledge (patterns, recipes, gaps, catalog freshness), and ' +
      'learning progress. Call at session start. If first_run is true, guide DS connection.',
    inputSchema: { type: 'object', properties: {} },
  },

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
      required: [],
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
        gap:           { type: ['number', 'string'], description: 'Gap between children. DS variable path (e.g., "spacing-3xl") preferred. Raw px number allowed in permissive mode only.' },
        gapVariable:   { type: 'string', description: 'DS spacing variable path for gap (e.g., "Spacing/spacing-3xl"). Bound via setBoundVariable. Preferred over raw gap number.' },
        padding:       { type: ['number', 'string'], description: 'Uniform padding. DS variable path preferred. Raw px allowed in permissive mode only.' },
        paddingVariable: { type: 'string', description: 'DS spacing variable path for uniform padding. Bound to all 4 sides via setBoundVariable.' },
        paddingTop:    { type: ['number', 'string'] },
        paddingRight:  { type: ['number', 'string'] },
        paddingBottom: { type: ['number', 'string'] },
        paddingLeft:   { type: ['number', 'string'] },
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
        cornerRadius: { type: ['number', 'string'], description: 'Corner radius. DS variable path (e.g., "radius-xl") preferred. Raw px allowed in permissive mode only.' },
        cornerRadiusVariable: { type: 'string', description: 'DS radius variable path (e.g., "Radius/radius-xl"). Bound via setBoundVariable. Preferred over raw cornerRadius number.' },
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
    name: 'figma_create_ellipse',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Create an ellipse in Figma. Supports arcs for donut segments. Use DS color variables for fills and strokes.',
    inputSchema: {
      type: 'object',
      properties: {
        name:            { type: 'string', description: 'Name for the ellipse node.' },
        width:           { type: 'number', description: 'Width in pixels.' },
        height:          { type: 'number', description: 'Height in pixels.' },
        parentNodeId:    { type: 'string', description: 'Parent frame to insert into.' },
        fillVariable:    { type: 'string', description: 'DS color variable path for fill.' },
        fillHex:         { type: 'string', description: 'Hex color fallback (rejected in strict mode).' },
        fillNone:        { type: 'boolean', description: 'No fill.' },
        strokeVariable:  { type: 'string', description: 'DS color variable path for stroke.' },
        strokeHex:       { type: 'string', description: 'Hex color fallback.' },
        strokeWidth:     { type: 'number', description: 'Stroke weight.' },
        arcData: {
          type: 'object',
          description: 'Arc configuration for donut segments.',
          properties: {
            startingAngle: { type: 'number', description: 'Starting angle in radians.' },
            endingAngle:   { type: 'number', description: 'Ending angle in radians.' },
            innerRadius:   { type: 'number', description: 'Inner radius as 0-1 ratio.' },
          },
        },
        x:               { type: 'number', description: 'X position.' },
        y:               { type: 'number', description: 'Y position.' },
        layoutGrow:      { type: 'number', description: 'Layout grow factor.' },
        layoutAlign:     { type: 'string', description: 'Layout alignment.' },
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
      'Set VARIANT or BOOLEAN component properties on an instance. ' +
      'Supports single property OR batch mode. ' +
      'IMPORTANT: For VARIANT properties, Figma requires all variant axes to form a valid combination — ' +
      'use batch mode (properties object) to set multiple variants at once. ' +
      'For BOOLEAN properties, use true/false (not strings). ' +
      'Use figma_get_component_variants to discover available property names and values first.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string' },
        propertyName: { type: 'string', description: 'Single property name, e.g. "Size" or "Icon leading". Use "properties" for batch.' },
        value:        { description: 'String for VARIANT, boolean for BOOLEAN.' },
        properties:   { type: 'object', description: 'Batch mode: { "Size": "sm", "Hierarchy": "Link", "Icon leading": false }. Overrides propertyName/value.' },
      },
      required: ['nodeId'],
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
        bars: {
          type: 'array',
          description: 'Bar chart data. Each item: { label: string, value: number, color?: string (DS hex) }.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'number' },
              color: { type: 'string', description: 'DS hex color for this bar segment.' },
            },
            required: ['label', 'value'],
          },
        },
        annotations: {
          type: 'array',
          description: 'Vertical annotation lines on a bar chart. Each item: { x: number, label?: string, color?: string }.',
          items: {
            type: 'object',
            properties: {
              x:     { type: 'number', description: 'X position (data value) for the annotation line.' },
              label: { type: 'string' },
              color: { type: 'string' },
            },
            required: ['x'],
          },
        },
        data: {
          type: 'array',
          description: 'Scatter/jitter plot data points. Each item: { x: number, y: string (category), label?: string, color?: string }.',
          items: {
            type: 'object',
            properties: {
              x:     { type: 'number' },
              y:     { type: 'string', description: 'Category band (Y axis label).' },
              label: { type: 'string' },
              color: { type: 'string', description: 'DS hex color for this data point.' },
            },
            required: ['x', 'y'],
          },
        },
        xDomain:      { type: 'array', items: { type: 'number' }, description: '[min, max] for X axis.' },
        categories:   { type: 'object', description: 'Donut/pie/scatter/bar segment definitions. Keys are segment names, values are { value: number, color: string (DS hex), colorVariable?: string (DS variable path) }.' },
        categoryVariables: { type: 'object', description: 'DS variable paths per category. Keys match categories keys, values are DS color variable paths (e.g., {"Pass": "Component colors/Utility/Success/utility-success-500"}). Tried first; hex fallback from categories if binding fails.' },
        categoryOrder: { type: 'array', items: { type: 'string' }, description: 'Render order for categories (donut/pie/scatter).' },
        dotSize:      { type: 'number' },
        jitter:       { type: 'boolean' },
        xTicks: {
          type: 'array',
          description: 'Explicit X axis tick values.',
          items: { type: 'number' },
        },
        tickSuffix:   { type: 'string', description: 'Suffix appended to every tick label (e.g. "%", "ms").' },
        xLabel:       { type: 'string' },
        series: {
          type: 'array',
          description: 'Line chart series. Each item: { name: string, data: [{ x: number, y: number }], color?: string (DS hex), smooth?: boolean, area?: boolean }.',
          items: {
            type: 'object',
            properties: {
              name:   { type: 'string' },
              data:   {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' } },
                  required: ['x', 'y'],
                },
              },
              color:  { type: 'string', description: 'DS hex color for this series line.' },
              colorVariable: { type: 'string', description: 'DS color variable path for this series (e.g., "Component colors/Utility/Success/utility-success-500"). Tried first; hex fallback from color if binding fails.' },
              smooth: { type: 'boolean', description: 'Smooth curve interpolation.' },
              area:   { type: 'boolean', description: 'Fill area under the line.' },
            },
            required: ['name', 'data'],
          },
        },
        yDomain:      { type: 'array', items: { type: 'number' }, description: '[min, max] for Y axis.' },
        yTicks: {
          type: 'array',
          description: 'Explicit Y axis tick values.',
          items: { type: 'number' },
        },
        xTickSuffix:  { type: 'string' },
        yTickSuffix:  { type: 'string' },
        yLabel:       { type: 'string' },
        size:         { type: 'number' },
        innerRadius:  { type: 'number' },
        centerLabel:  { type: 'string' },
        centerSubLabel: { type: 'string' },
        legendPosition: { type: 'string', enum: ['right', 'bottom'], description: 'Legend placement for donut/pie charts. "right" (default) places legend beside the chart. "bottom" places it below.' },
        // DS integration params for chart elements
        bgVariable:        { type: 'string', description: 'DS variable path for chart outer frame background (e.g., "Colors/Background/bg-secondary"). Replaces hardcoded #F9FAFB.' },
        radiusVariable:    { type: 'string', description: 'DS radius variable path for chart outer frame (e.g., "Radius/radius-md"). Replaces hardcoded 8px.' },
        gridVariable:      { type: 'string', description: 'DS variable path for grid line color (e.g., "Colors/Border/border-secondary"). Replaces hardcoded #E7EAEE.' },
        labelFillVariable: { type: 'string', description: 'DS variable path for chart label text color (e.g., "Colors/Text/text-tertiary (600)"). Replaces hardcoded #6D778C.' },
        labelTextStyleId:  { type: 'string', description: 'DS text style key for chart labels. Applied to all axis/legend labels.' },
        fontFamily:        { type: 'string', description: 'Font family for chart labels (overrides session default).' },
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

  {
    name: 'figma_preload_styles',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Batch import DS text and color styles into the plugin cache. ' +
      'Call at build start with all style keys needed for the build. ' +
      'Cached styles resolve instantly during create_text/create_frame calls. ' +
      'Without preloading, each style import has an 8-second timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of DS style keys to preload.',
        },
      },
      required: ['keys'],
    },
  },

  {
    name: 'figma_discover_library_styles',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'List local and imported text styles, color styles, and effect styles in the current file. ' +
      'Returns style IDs and keys usable with preload_styles and textStyleId in create_text. ' +
      'Note: Figma Plugin API cannot enumerate library styles directly — for full library style discovery, ' +
      'use search_design_system from the Figma MCP. Optional nameFilter narrows results.',
    inputSchema: {
      type: 'object',
      properties: {
        nameFilter: { type: 'string', description: 'Optional substring to filter style names (case-insensitive).' },
      },
    },
  },

  {
    name: 'figma_restyle_artboard',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      'Restyle an entire artboard by walking all descendants and applying color, font, radius, and spacing overrides. ' +
      'Pass a colorMap to remap hex colors (e.g. {"ffffff": "0f172a"} changes white to dark navy). ' +
      'Optional fontFamily changes all text to a new font. radiusScale multiplies all corner radii. ' +
      'spacingScale multiplies all padding and gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId:       { type: 'string', description: 'Root artboard node ID to restyle.' },
        colorMap:     { type: 'object', description: 'Hex color remapping: { "oldHex": "newHex" }. No # prefix. Lowercase.' },
        fontFamily:   { type: 'string', description: 'New font family for all text nodes (e.g. "DM Sans").' },
        radiusScale:  { type: 'number', description: 'Multiplier for all corner radii (e.g. 0.5 = halve, 2.0 = double).' },
        spacingScale: { type: 'number', description: 'Multiplier for all padding and gap values.' },
      },
      required: ['nodeId'],
    },
  },

  {
    name: 'figma_discover_library_variables',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Discover ALL variable collections and variables available from enabled libraries. ' +
      'Uses figma.teamLibrary API to enumerate across all enabled libraries (including community libraries). ' +
      'Returns variable keys grouped by collection, usable with preload_variables or fillVariable/strokeVariable. ' +
      'Call this at build start to discover what DS variables are available. Optional nameFilter narrows results.',
    inputSchema: {
      type: 'object',
      properties: {
        nameFilter: { type: 'string', description: 'Optional substring to filter variable names (case-insensitive).' },
      },
    },
  },

  {
    name: 'figma_preload_variables',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Batch import DS variables into the plugin cache. Two import modes:\n' +
      '1. **Prefix-based** (prefixes param): Walks team library collections and imports variables matching path prefixes. ' +
      'Works for team-published libraries. Does NOT find community library variables.\n' +
      '2. **Key-based** (keys param): Imports variables directly by their Figma key, bypassing collection enumeration. ' +
      'Use this for community library variables — get the keys from search_design_system (Figma MCP), then pass them here. ' +
      'Each key entry can be a string (just the key) or { key, name } for explicit name mapping.\n' +
      'Both modes can be used together. Call at build start alongside preload_styles.',
    inputSchema: {
      type: 'object',
      properties: {
        prefixes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Variable path prefixes to import from team libraries (e.g., ["Colors", "spacing", "radius"]). Empty array imports all.',
        },
        keys: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string', description: 'Variable key string — name is read from the imported variable.' },
              {
                type: 'object',
                properties: {
                  key:  { type: 'string', description: 'Figma variable key (from search_design_system results).' },
                  name: { type: 'string', description: 'Variable name/path for cache lookup (e.g., "primary/main").' },
                },
                required: ['key'],
              },
            ],
          },
          description: 'Variable keys to import directly (bypasses collection enumeration). Use for community library variables. Get keys from search_design_system.',
        },
      },
      required: [],
    },
  },

  {
    name: 'figma_set_session_defaults',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Set session-level defaults for DS compliance. Call once at build start after preload_styles. ' +
      'textFillStyleKey sets the default fill for all text nodes that have no explicit fill — ' +
      'prevents raw #000000 black. Pass the DS text-primary color style key. ' +
      'textFillVariable is the alternative for DSs that use variables instead of color styles (e.g., community libraries). ' +
      'Pass one of textFillStyleKey or textFillVariable — not both. ' +
      'fontFamily sets the default font family for all text nodes (default: "Inter"). ' +
      'Set this if your DS uses a different font (e.g., "Roboto", "SF Pro"). ' +
      'dsMode controls DS enforcement: "strict" (default) requires all visual properties to use DS ' +
      'variables/styles — raw hex, raw px, raw fonts are rejected. "permissive" allows raw fallbacks ' +
      'for component-only DSs without published tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        textFillStyleKey: {
          type: 'string',
          description: 'DS color style key for text-primary (default text fill). Use for DSs with published color styles.',
        },
        textFillVariable: {
          type: 'string',
          description: 'DS variable path for text-primary (e.g., "text/primary"). Use for DSs that use variables instead of color styles (community libraries).',
        },
        fontFamily: {
          type: 'string',
          description: 'Default font family for text nodes (e.g., "Inter", "Roboto", "SF Pro"). Defaults to "Inter" if not set.',
        },
        dsMode: {
          type: 'string',
          enum: ['strict', 'permissive'],
          description: 'DS enforcement mode. "strict" (default): all fills, strokes, spacing, radius, and typography must use DS variables/styles — raw values are rejected with an error. "permissive": raw fallbacks allowed for DSs without published tokens. Default: "strict".',
        },
      },
      required: [],
    },
  },

  {
    name: 'figma_read_variable_values',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Read the resolved values of all local variables in the current Figma file. ' +
      'Returns variable names, types, resolved hex values (for colors), and numeric values (for spacing/radius). ' +
      'Use this to extract DS token values for DESIGN.md generation, Tailwind export, or drift detection. ' +
      'Must be run in the library file (where variables are local) for full results. ' +
      'In consumer files, use discover_library_variables instead (returns keys/names but not values).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'figma_tag_raw_exception',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Tag a node as a user-approved raw value exception. Prefixes the node name with [RAW-OK] ' +
      'and stores the reason in plugin data. Tagged nodes are skipped by validate_ds_compliance. ' +
      'Use ONLY after the user explicitly approves a raw fallback for a specific node.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to tag.' },
        reason: { type: 'string', description: 'Why this raw value was approved (e.g., "chart internal geometry", "decorative element").' },
      },
      required: ['nodeId', 'reason'],
    },
  },

  {
    name: 'figma_validate_ds_compliance',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Post-build DS compliance validation. Walks all nodes under an artboard and flags violations: ' +
      'raw fills (no bound DS variable), raw text styles (no textStyleId), raw spacing (no bound variable), ' +
      'fixed sizing on non-artboard frames. Returns a compliance report with violation details. ' +
      'Call after every build (Phase 4 QA) to verify DS-only rule compliance.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Root node ID to validate (typically the artboard).' },
      },
      required: ['nodeId'],
    },
  },

  // ── DESIGN.md generator ──────────────────────────────────────────────────

  {
    name: 'mimic_generate_design_md',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Generate a DESIGN.md file from the current DS knowledge. ' +
      'Compiles DS variables, text styles, components, and Mimic\'s learned usage patterns ' +
      'into the open DESIGN.md format (compatible with Google Stitch, generative UI tools, and AI coding agents). ' +
      'The YAML frontmatter contains machine-readable tokens (colors, typography, spacing, radius, components). ' +
      'The markdown prose sections contain human-readable usage guidelines generated from build patterns. ' +
      'Optionally saves to a file path. Returns the full DESIGN.md content.',
    inputSchema: {
      type: 'object',
      properties: {
        dsName: {
          type: 'string',
          description: 'Name for the design system (used in the DESIGN.md header).',
        },
        description: {
          type: 'string',
          description: 'Optional one-line description of the design system.',
        },
        savePath: {
          type: 'string',
          description: 'Optional file path to save the DESIGN.md. If omitted, content is returned but not saved.',
        },
      },
      required: ['dsName'],
    },
  },

  // ── Build report generator ───────────────────────────────────────────────

  {
    name: 'mimic_generate_build_report',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Generate a build report after a Mimic build. Compiles DS compliance data, learned patterns, ' +
      'DS gap recommendations, and build metadata into a structured report. ' +
      'Call validate_ds_compliance first to get the complianceData, then pass it here. ' +
      'Returns the report as markdown (default) or HTML. Optionally saves to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        screenName: { type: 'string', description: 'Name of the screen that was built (e.g., "Dataflow Landing Page").' },
        dsName: { type: 'string', description: 'Name of the design system used.' },
        artboardNodeId: { type: 'string', description: 'Artboard node ID (for metadata).' },
        complianceData: {
          type: 'object',
          description: 'Output from validate_ds_compliance: { stats, violations, summary }.',
        },
        sectionsBuilt: {
          type: 'array',
          description: 'List of section names built (e.g., ["Nav", "Hero", "Metrics"]).',
          items: { type: 'string' },
        },
        dsComponents: {
          type: 'array',
          description: 'DS components used: [{ name, count, variant }].',
          items: { type: 'object' },
        },
        primitives: {
          type: 'array',
          description: 'Elements built as primitives: [{ name, reason }].',
          items: { type: 'object' },
        },
        format: {
          type: 'string', enum: ['markdown', 'html'],
          description: 'Output format. Default: markdown.',
        },
        savePath: {
          type: 'string',
          description: 'Optional file path to save the report.',
        },
      },
      required: ['screenName', 'dsName'],
    },
  },

  // ── Mimic AI pipeline controller ─────────────────────────────────────────

  {
    name: 'mimic_pipeline_resolve',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Deterministic input resolver for HTML → Figma builds. ' +
      'Provide a URL, local HTML file path, or raw HTML content. ' +
      'The controller classifies the input (DIRECT_HTML vs RENDERED_DOM_REQUIRED), ' +
      'renders client-rendered pages automatically if needed, validates the result, ' +
      'and returns a ready-to-build HTML file path. ' +
      'ALWAYS call this BEFORE starting any HTML → Figma build. ' +
      'If result.status is READY, use result.outputPath as build input. ' +
      'If result.status is FAILURE, do NOT proceed — report the error.',
    inputSchema: {
      type: 'object',
      properties: {
        url:          { type: 'string', description: 'URL to resolve. Fetched and classified automatically.' },
        htmlFilePath: { type: 'string', description: 'Path to a local HTML file. Skips fetch, classifies directly.' },
        htmlContent:  { type: 'string', description: 'Raw HTML string. Skips fetch, classifies directly.' },
        timeout:      { type: 'number', description: 'Render timeout in ms. Default: 30000.' },
        cookies:      {
          type: 'array',
          description: 'Auth cookies for rendering. Each: { name, value, domain, path }.',
          items: {
            type: 'object',
            properties: {
              name:   { type: 'string' },
              value:  { type: 'string' },
              domain: { type: 'string' },
              path:   { type: 'string' },
            },
            required: ['name', 'value', 'domain'],
          },
        },
      },
    },
  },

  // ── Mimic AI rendering layer (direct) ──────────────────────────────────

  {
    name: 'mimic_render_url',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      'Render a client-rendered web page in a headless browser and extract the full DOM. ' +
      'Use this when a URL returns only a JS shell, loading spinner, or hydration scaffold — ' +
      'not meaningful HTML. The renderer waits for the page to fully hydrate using generic ' +
      'readiness signals (text density, node count, DOM stability) before extracting. ' +
      'Returns the path to the rendered HTML file which can then be used as build input. ' +
      'On failure, returns a classified error (auth wall, endless loading, empty shell, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        url:       { type: 'string', description: 'URL to render.' },
        output:    { type: 'string', description: 'Optional output file path. Defaults to internal/builds/rendered-{timestamp}.html.' },
        timeout:   { type: 'number', description: 'Max render wait in ms. Default: 30000.' },
        cookies:   {
          type: 'array',
          description: 'Auth cookies for the target domain. Each: { name, value, domain, path }.',
          items: {
            type: 'object',
            properties: {
              name:   { type: 'string' },
              value:  { type: 'string' },
              domain: { type: 'string' },
              path:   { type: 'string' },
            },
            required: ['name', 'value', 'domain'],
          },
        },
      },
      required: ['url'],
    },
  },

  {
    name: 'mimic_discover_ds',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'Extract and normalize a design system from a Figma library file. ' +
      'Call this on first run or when the DS has been updated. ' +
      'Queries the Figma REST API for components, component sets, styles, and variables. ' +
      'Normalizes the extraction into a structured knowledge artifact at internal/ds-knowledge/ds-knowledge-normalized.json. ' +
      'Returns a summary of what was found (counts of components, styles, variables).',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key for the DS library file.' },
      },
      required: ['fileKey'],
    },
  },

  // ── Mimic AI learning loop ────────────────────────────────────────────────

  {
    name: 'mimic_ai_knowledge_read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Read the Mimic AI knowledge file (ds-knowledge.json). ' +
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
    name: 'mimic_ai_knowledge_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Write pattern→component mappings and explicit DS rules to the Mimic AI knowledge file (ds-knowledge.json). ' +
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
              library_key:          { type: 'string',  description: 'Library key from Figma search. Tracks which DS library this component belongs to.' },
              library_name:         { type: 'string',  description: 'Human-readable library name (e.g., "LayerLens Theme").' },
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
          description: 'Set true when the user signals their design system was updated. Resets seen_count to 0 on ALL gap-type rules, causing Mimic AI to re-run DS search for those patterns on the next run and discover any newly added components.',
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
  'figma_preload_variables',
  'figma_create_frame',
  'figma_create_text',
  'figma_create_rectangle',
  'figma_create_ellipse',
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
  'figma_preload_styles',
  'figma_set_session_defaults',
  'figma_discover_library_styles',
  'figma_discover_library_variables',
  'figma_restyle_artboard',
  'figma_read_variable_values',
  'figma_validate_ds_compliance',
  'figma_tag_raw_exception',
]);

// Strip "figma_" prefix to get the bridge instruction type.
function bridgeType(toolName) {
  return toolName.replace(/^figma_/, '');
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mimic-ai', version: '1.1.0' },
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

    if (name === 'mimic_status') {
      // Check all connection statuses
      const knowledge = loadKnowledge();
      const hasKnowledge = existsSync(KNOWLEDGE_PATH) && knowledge.patterns.length > 0;
      const dsKnowledgePath = resolve(__dir, 'internal', 'ds-knowledge', 'ds-knowledge-normalized.json');
      const hasDsKnowledge = existsSync(dsKnowledgePath);

      let bridgeRunning = false;
      let pluginConnected = false;
      try {
        const r = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(2000) });
        bridgeRunning = r.ok;
        if (r.ok) {
          const statusData = await r.json();
          pluginConnected = statusData.pluginConnected === true;
        }
      } catch { /* bridge not running */ }

      const activePatterns = knowledge.patterns.filter(p => !p.valid_until);
      const patternCount = activePatterns.length;
      const verifiedCount = activePatterns.filter(p => p.state === 'VERIFIED').length;
      const invalidatedCount = knowledge.patterns.filter(p => p.valid_until).length;
      const ruleCount = knowledge.explicit_rules.length;
      const gapCount = Object.values(knowledge.gaps || {}).filter(g => !g.resolved).length;
      const catalogAge = knowledge.catalog?.last_refreshed
        ? Math.round((Date.now() - new Date(knowledge.catalog.last_refreshed).getTime()) / (1000 * 60 * 60))
        : null;
      const recipesCount = activePatterns.filter(p => p.configuration_recipe).length;

      result = {
        bridge_running: bridgeRunning,
        plugin_connected: pluginConnected,
        bridge_url: BRIDGE_URL,
        ds_knowledge_file: hasDsKnowledge,
        learning_knowledge_file: hasKnowledge,
        schema_version: knowledge.version || 1,
        patterns: {
          total: patternCount,
          verified: verifiedCount,
          invalidated: invalidatedCount,
          with_recipes: recipesCount,
          by_source: {
            user_correction: activePatterns.filter(p => p.source === 'user_correction').length,
            auto_inferred: activePatterns.filter(p => p.source === 'auto_inferred').length,
            auto_promoted: activePatterns.filter(p => p.source === 'auto_promoted').length,
          },
        },
        explicit_rules: ruleCount,
        ds_gaps: gapCount,
        catalog: {
          component_sets: knowledge.catalog?.componentSets?.length || 0,
          age_hours: catalogAge,
          stale: catalogAge !== null && catalogAge > 168, // >7 days
        },
        first_run: !hasDsKnowledge && patternCount === 0,
        message: !hasDsKnowledge
          ? 'No DS knowledge found. Run mimic_discover_ds with your DS library file key to get started.'
          : !bridgeRunning
            ? 'DS knowledge loaded but bridge is not running. Start the bridge and Figma plugin.'
            : bridgeRunning && !pluginConnected
              ? `Bridge running but Figma plugin not connected. Open the plugin in Figma. ${patternCount} patterns loaded.`
              : `Ready. ${patternCount} patterns (${verifiedCount} verified, ${recipesCount} recipes). ${gapCount} DS gaps tracked.`,
      };

    } else if (name === 'mimic_generate_build_report') {
      // ── Build report generator ──────────────────────────────────────────
      const knowledge = loadKnowledge();
      const activePatterns = knowledge.patterns.filter(p => !p.valid_until);
      const verifiedCount = activePatterns.filter(p => p.state === 'VERIFIED').length;
      const candidateCount = activePatterns.filter(p => p.state === 'CANDIDATE').length;
      const gaps = knowledge.explicit_rules.filter(r => r.type === 'gap' && !r.dismissed);
      const conventions = knowledge.explicit_rules.filter(r => r.type === 'convention' && !r.dismissed);

      const stats = fixedArgs.complianceData?.stats || {};
      const sections = fixedArgs.sectionsBuilt || [];
      const components = fixedArgs.dsComponents || [];
      const primitives = fixedArgs.primitives || [];
      const fmt = fixedArgs.format || 'markdown';

      const totalComponents = components.reduce((sum, c) => sum + (c.count || 1), 0);
      const now = new Date().toISOString().split('T')[0];

      // ── Build markdown report ──────────────────────────────────────────
      let md = '';
      md += `# Build Report — ${fixedArgs.screenName}\n\n`;
      md += `**Date:** ${now}  \n`;
      md += `**Design system:** ${fixedArgs.dsName}  \n`;
      if (fixedArgs.artboardNodeId) md += `**Artboard:** ${fixedArgs.artboardNodeId}  \n`;
      md += `**Sections:** ${sections.length > 0 ? sections.join(', ') : 'Not specified'}  \n\n`;

      // What was built
      md += `## What was built\n\n`;
      md += `${fixedArgs.screenName}: ${sections.length} sections`;
      if (totalComponents > 0) md += `, ${totalComponents} DS component instances`;
      md += `.\n\n`;

      // DS usage
      md += `## DS usage\n\n`;
      if (components.length > 0) {
        md += `**Components used:**\n`;
        for (const c of components) md += `- ${c.name}${c.count > 1 ? ' ×' + c.count : ''}${c.variant ? ' (' + c.variant + ')' : ''}\n`;
        md += '\n';
      }
      if (primitives.length > 0) {
        md += `**Built as primitives:**\n`;
        for (const p of primitives) md += `- ${p.name} — ${p.reason}\n`;
        md += '\n';
      }

      // Quality
      md += `## Quality\n\n`;
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| Total nodes | ${stats.total || '—'} |\n`;
      md += `| DS-compliant | ${stats.compliant || '—'} |\n`;
      md += `| Raw fills | ${stats.rawFill || 0} |\n`;
      md += `| Raw text styles | ${stats.rawText || 0} |\n`;
      md += `| Raw spacing | ${stats.rawSpacing || 0} |\n`;
      md += `| Fixed sizing | ${stats.fixedSize || 0} |\n\n`;

      if (stats.total) {
        const pct = Math.round((stats.compliant / stats.total) * 100);
        md += `DS compliance: **${pct}%** (${stats.compliant}/${stats.total} nodes)\n\n`;
      }

      // Patterns
      md += `## Patterns\n\n`;
      md += `| Pattern | Component | Confidence | Source |\n|---|---|---|---|\n`;
      for (const p of activePatterns.slice(0, 15)) {
        const conf = p.state === 'VERIFIED' ? 'Strong' : p.use_count >= 2 ? 'Moderate' : 'New';
        md += `| ${p.pattern_key} | ${p.component_name || '—'} | ${conf} (${p.use_count} builds) | ${p.source} |\n`;
      }
      if (activePatterns.length > 15) md += `| ... | ${activePatterns.length - 15} more patterns | | |\n`;
      md += `\nCache: ${verifiedCount} verified, ${candidateCount} candidates. Next build uses ${activePatterns.length} cached patterns.\n\n`;

      // DS gap recommendations
      if (gaps.length > 0) {
        md += `## DS gap recommendations\n\n`;
        for (const g of gaps) {
          md += `- **${g.rule_key}** — ${g.reason} (seen ${g.seen_count} times)\n`;
        }
        md += '\n';
      }

      // Conventions learned
      if (conventions.length > 0) {
        md += `## Conventions learned\n\n`;
        for (const c of conventions) {
          md += `- **${c.rule_key}** — ${c.reason}\n`;
        }
        md += '\n';
      }

      md += `---\n*Generated by Mimic AI v${JSON.parse(readFileSync(resolve(__dir, 'package.json'), 'utf8')).version}*\n`;

      // Convert to HTML if requested
      let output = md;
      if (fmt === 'html') {
        // Simple markdown → HTML conversion
        output = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
        output += '<title>Build Report — ' + fixedArgs.screenName + '</title>';
        output += '<style>body{font-family:Inter,-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.6}';
        output += 'h1{font-size:24px;border-bottom:2px solid #e5e7eb;padding-bottom:8px}h2{font-size:18px;margin-top:32px}';
        output += 'table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}th{text-align:left;padding:8px 12px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-weight:600}';
        output += 'td{padding:8px 12px;border-bottom:1px solid #f3f4f6}ul{margin:8px 0}li{margin:4px 0}strong{font-weight:600}';
        output += 'hr{border:none;border-top:1px solid #e5e7eb;margin:32px 0}em{color:#6b7280}</style></head><body>';
        // Basic markdown to HTML
        output += md
          .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
          .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/^\| (.*?) \|$/gm, (match) => {
            const cells = match.split('|').filter(c => c.trim()).map(c => c.trim());
            return '<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
          })
          .replace(/^\|[-|]+\|$/gm, '')
          .replace(/^- (.*?)$/gm, '<li>$1</li>')
          .replace(/(<li>.*<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>')
          .replace(/(<tr>.*<\/tr>\n?)+/g, (m) => '<table><thead>' + m.split('\n')[0] + '</thead><tbody>' + m.split('\n').slice(1).join('\n') + '</tbody></table>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/---/g, '<hr>')
          .replace(/  \n/g, '<br>');
        output += '</body></html>';
      }

      // Save if path provided
      if (fixedArgs.savePath) {
        const { writeFileSync, mkdirSync } = await import('fs');
        const { dirname } = await import('path');
        mkdirSync(dirname(fixedArgs.savePath), { recursive: true });
        writeFileSync(fixedArgs.savePath, output, 'utf8');
      }

      result = {
        report: output,
        saved: fixedArgs.savePath || null,
        summary: {
          sections: sections.length,
          dsComponents: totalComponents,
          primitives: primitives.length,
          compliance: stats.total ? Math.round((stats.compliant / stats.total) * 100) + '%' : '—',
          patterns: activePatterns.length,
          gaps: gaps.length,
        },
      };

    } else if (name === 'mimic_generate_design_md') {
      // ── DESIGN.md generator ──────────────────────────────────────────────
      // Compiles DS knowledge into the open DESIGN.md format (Google Stitch compatible).
      const dsKnowledgePath = resolve(__dir, 'internal', 'ds-knowledge', 'ds-knowledge-normalized.json');
      const knowledge = loadKnowledge();

      // Load DS inventory
      let dsData = null;
      if (existsSync(dsKnowledgePath)) {
        try { dsData = JSON.parse(readFileSync(dsKnowledgePath, 'utf8')); } catch (_) {}
      }

      // Resolve variable values via bridge (if running)
      let variables = [];
      try {
        const vr = await fetch(`${BRIDGE_URL}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'read_variable_values', params: {} }),
          signal: AbortSignal.timeout(10000),
        });
        const vd = await vr.json();
        if (vd.ok && vd.result) variables = vd.result.variables || [];
      } catch (_) { /* bridge not running — use DS inventory only */ }

      // Build YAML frontmatter
      const yaml = { name: fixedArgs.dsName || 'Design System' };
      if (fixedArgs.description) yaml.description = fixedArgs.description;

      // Colors: from resolved variables
      const colorVars = variables.filter(v => v.resolvedType === 'COLOR');
      if (colorVars.length > 0) {
        yaml.colors = {};
        for (const v of colorVars) {
          // Use short name (last segment of path) as token name
          const shortName = v.name.split('/').pop().replace(/\s*\([^)]*\)$/, '');
          yaml.colors[shortName] = v.value || '#000000';
        }
      }

      // Typography: from DS text styles (if available in inventory)
      const textStyles = dsData?.textStyles || dsData?.styles?.filter(s => s.styleType === 'TEXT') || [];
      if (textStyles.length > 0) {
        yaml.typography = {};
        for (const s of textStyles) {
          const tName = (s.name || '').replace(/^typography\//, '').replace(/\//g, '-');
          if (!tName) continue;
          const t = {};
          if (s.fontFamily) t.fontFamily = s.fontFamily;
          if (s.fontSize) t.fontSize = s.fontSize + 'px';
          if (s.fontWeight) t.fontWeight = String(s.fontWeight);
          if (s.lineHeight) t.lineHeight = s.lineHeight + 'px';
          if (s.letterSpacing) t.letterSpacing = s.letterSpacing + 'em';
          yaml.typography[tName] = Object.keys(t).length > 0 ? t : { fontSize: '16px' };
        }
      }

      // Spacing: from resolved FLOAT variables with spacing-like names
      const spacingVars = variables.filter(v => v.resolvedType === 'FLOAT' && /spacing|gap|padding|margin/i.test(v.name));
      if (spacingVars.length > 0) {
        yaml.spacing = {};
        for (const v of spacingVars) {
          const shortName = v.name.split('/').pop();
          yaml.spacing[shortName] = typeof v.value === 'number' ? v.value + 'px' : v.value;
        }
      }

      // Radius: from resolved FLOAT variables with radius-like names
      const radiusVars = variables.filter(v => v.resolvedType === 'FLOAT' && /radius|rounded/i.test(v.name));
      if (radiusVars.length > 0) {
        yaml.rounded = {};
        for (const v of radiusVars) {
          const shortName = v.name.split('/').pop();
          yaml.rounded[shortName] = typeof v.value === 'number' ? v.value + 'px' : v.value;
        }
      }

      // Components: from Mimic's learned patterns + DS component inventory
      const activePatterns = knowledge.patterns.filter(p => !p.valid_until && p.component_key);
      if (activePatterns.length > 0) {
        yaml.components = {};
        for (const p of activePatterns) {
          const cName = (p.component_name || p.pattern_key || 'component').replace(/[^a-zA-Z0-9-]/g, '-');
          const comp = {};
          if (p.variant) comp.variant = p.variant;
          if (p.use_count) comp._usage = `Used ${p.use_count} times across builds`;
          if (p.source) comp._source = p.source;
          yaml.components[cName] = comp;
        }
      }

      // Serialize YAML (simple serializer — no dependency needed)
      function toYaml(obj, indent = 0) {
        const pad = '  '.repeat(indent);
        let out = '';
        for (const [k, v] of Object.entries(obj)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
          } else {
            const val = typeof v === 'string' && (v.includes(':') || v.includes('#') || v.includes('{'))
              ? `"${v}"` : v;
            out += `${pad}${k}: ${val}\n`;
          }
        }
        return out;
      }

      // Build markdown prose from knowledge patterns
      let prose = '';

      // Overview
      prose += `## Overview\n\n`;
      prose += `This DESIGN.md was generated by Mimic AI from the ${fixedArgs.dsName} design system.\n`;
      prose += `It contains ${colorVars.length} color tokens, ${textStyles.length} text styles, `;
      prose += `${spacingVars.length} spacing tokens, and ${radiusVars.length} radius tokens.\n\n`;

      // Colors section
      if (colorVars.length > 0) {
        prose += `## Colors\n\n`;
        const semanticGroups = {};
        for (const v of colorVars) {
          const group = v.name.split('/').slice(0, -1).join('/') || 'Other';
          if (!semanticGroups[group]) semanticGroups[group] = [];
          semanticGroups[group].push(v);
        }
        for (const [group, vars] of Object.entries(semanticGroups)) {
          prose += `**${group}:** ${vars.map(v => v.name.split('/').pop()).join(', ')}\n\n`;
        }
      }

      // Typography section
      if (textStyles.length > 0) {
        prose += `## Typography\n\n`;
        prose += `The design system provides ${textStyles.length} text styles. `;
        const fonts = [...new Set(textStyles.map(s => s.fontFamily).filter(Boolean))];
        if (fonts.length > 0) prose += `Font families: ${fonts.join(', ')}.\n\n`;
        else prose += '\n';
      }

      // Layout section
      if (spacingVars.length > 0) {
        prose += `## Layout & Spacing\n\n`;
        prose += `Spacing follows a defined scale with ${spacingVars.length} tokens. `;
        prose += `Use these tokens for padding, margins, and gaps to maintain consistency.\n\n`;
      }

      // Shapes section
      if (radiusVars.length > 0) {
        prose += `## Shapes\n\n`;
        prose += `Border radius tokens: ${radiusVars.map(v => v.name.split('/').pop()).join(', ')}.\n\n`;
      }

      // Components section (from Mimic's learning)
      if (activePatterns.length > 0) {
        prose += `## Components\n\n`;
        prose += `Mimic has learned ${activePatterns.length} component patterns from builds:\n\n`;
        for (const p of activePatterns) {
          const state = p.state === 'VERIFIED' ? 'verified' : 'candidate';
          const usage = p.use_count ? ` (used ${p.use_count} times)` : '';
          prose += `- **${p.component_name || p.pattern_key}**${usage} — ${state}\n`;
        }
        prose += '\n';
      }

      // DS gaps section
      const gaps = Object.values(knowledge.gaps || {}).filter(g => !g.resolved);
      if (gaps.length > 0) {
        prose += `## Do's and Don'ts\n\n`;
        prose += `### Gaps identified by Mimic\n\n`;
        for (const g of gaps) {
          prose += `- ${g.description || g.gap_key}: seen ${g.seen_count || 0} times across builds\n`;
        }
        prose += '\n';
      }

      // Assemble final DESIGN.md
      const designMd = `---\n${toYaml(yaml)}---\n\n${prose}`;

      // Save if path provided
      if (fixedArgs.savePath) {
        const { writeFileSync, mkdirSync } = await import('fs');
        const { dirname } = await import('path');
        mkdirSync(dirname(fixedArgs.savePath), { recursive: true });
        writeFileSync(fixedArgs.savePath, designMd, 'utf8');
      }

      result = {
        content: designMd,
        saved: fixedArgs.savePath || null,
        stats: {
          colors: colorVars.length,
          textStyles: textStyles.length,
          spacing: spacingVars.length,
          radius: radiusVars.length,
          components: activePatterns.length,
          gaps: gaps.length,
        },
      };

    } else if (name === 'mimic_pipeline_resolve') {
      result = await resolveInput({
        url: fixedArgs.url,
        htmlFilePath: fixedArgs.htmlFilePath,
        htmlContent: fixedArgs.htmlContent,
        timeout: fixedArgs.timeout,
        cookies: fixedArgs.cookies || [],
      });

    } else if (name === 'mimic_render_url') {
      result = await renderPage({
        url: fixedArgs.url,
        outputPath: fixedArgs.output,
        timeout: fixedArgs.timeout,
        cookies: fixedArgs.cookies || [],
      });

    } else if (name === 'mimic_discover_ds') {
      // First-run DS discovery: extract via bridge REST API, then normalize
      const bridgeUrl = process.env.BRIDGE_URL || 'http://127.0.0.1:3055';
      const knowledgePath = resolve(__dir, 'internal/ds-knowledge/ds-knowledge-normalized.json');

      // Load previous knowledge for change detection
      let previousCounts = null;
      if (existsSync(knowledgePath)) {
        try {
          const prev = JSON.parse(readFileSync(knowledgePath, 'utf8'));
          previousCounts = prev.summary || null;
        } catch (_) {}
      }

      const extractRes = await fetch(`${bridgeUrl}/extract-ds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileKey: fixedArgs.fileKey }),
      });
      const extractData = await extractRes.json();
      if (!extractData.ok) throw new Error('DS extraction failed: ' + (extractData.error || 'unknown'));

      // Normalize using ds-knowledge-builder
      const { buildDSKnowledge } = await import('./internal/ds-knowledge/ds-knowledge-builder.js');
      const normalized = buildDSKnowledge(extractData.result, []);

      // Detect changes if previous knowledge exists
      let changes = null;
      if (previousCounts && normalized.summary) {
        changes = {};
        for (const key of Object.keys(normalized.summary)) {
          const prev = previousCounts[key] || 0;
          const curr = normalized.summary[key] || 0;
          if (prev !== curr) changes[key] = { previous: prev, current: curr, delta: curr - prev };
        }
        if (Object.keys(changes).length === 0) changes = null;
      }

      result = {
        fileKey: fixedArgs.fileKey,
        firstRun: !previousCounts,
        counts: extractData.result.counts,
        normalizedPath: knowledgePath,
        summary: normalized.summary || null,
        changes,
      };

    } else if (name === 'mimic_ai_knowledge_read') {
      const knowledge = loadKnowledge();
      if (fixedArgs.pattern_key) {
        const entry = knowledge.patterns.find(p => p.pattern_key === fixedArgs.pattern_key) ?? null;
        result = { entry, path: KNOWLEDGE_PATH };
      } else {
        result = { ...knowledge, path: KNOWLEDGE_PATH };
      }

    } else if (name === 'mimic_ai_knowledge_write') {
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
