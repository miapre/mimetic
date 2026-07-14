#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Bridge } = require('./src/bridge');
const { DsCache } = require('./src/ds/cache');
const { DsResolver } = require('./src/ds/resolver');
const { KnowledgeStore } = require('./src/knowledge/store');
const { BuildManifest } = require('./src/knowledge/manifest');
const { FigmaRest } = require('./src/figma-rest');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/**
 * Resolve FIGMA_TOKEN from multiple sources (first match wins):
 * 1. ~/.mimic-ai.json  { "figmaToken": "figd_..." }  — hot-reloadable
 * 2. process.env.FIGMA_TOKEN (standard MCP env config) — set at spawn time
 * 3. null (server starts without REST API — discovery prompts setup)
 *
 * Config file wins over env var so token updates take effect without
 * restarting the MCP server process.
 */
function resolveFigmaToken() {
  try {
    const configPath = path.join(os.homedir(), '.mimic-ai.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.figmaToken) return cfg.figmaToken;
  } catch { /* file doesn't exist or is invalid — fall through to env */ }
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  return null;
}

/**
 * Resolve the canonical knowledge store path.
 *
 * Previously this was `path.join(process.cwd(), 'ds-knowledge.json')` — since
 * cwd depends entirely on how the MCP client launches the server, learning
 * silently fragmented into a different file per working directory. The
 * canonical location is now `~/.mimic-ai/ds-knowledge.json`, stable
 * regardless of launch cwd.
 *
 * MIMIC_KNOWLEDGE_PATH overrides this if set (e.g. for tests, or a user who
 * wants the store somewhere else deliberately).
 */
function resolveKnowledgeStorePath() {
  if (process.env.MIMIC_KNOWLEDGE_PATH) return process.env.MIMIC_KNOWLEDGE_PATH;
  return path.join(os.homedir(), '.mimic-ai', 'ds-knowledge.json');
}

/**
 * One-time migration: if the canonical knowledge store doesn't exist yet,
 * check legacy locations — cwd/ds-knowledge.json (the old default), then
 * ~/ds-knowledge.json (a path some workarounds referenced but the code never
 * actually used) — and copy the first one found to the canonical path. The
 * original file is left in place (never deleted — it's the user's data).
 *
 * Returns a human-readable migration note, or null if nothing needed migrating.
 */
function migrateKnowledgeStoreIfNeeded(canonicalPath) {
  if (fs.existsSync(canonicalPath)) return null;

  const legacyCandidates = [
    path.join(process.cwd(), 'ds-knowledge.json'),
    path.join(os.homedir(), 'ds-knowledge.json'),
  ];

  for (const legacyPath of legacyCandidates) {
    if (path.resolve(legacyPath) === path.resolve(canonicalPath)) continue;
    try {
      if (!fs.existsSync(legacyPath)) continue;
      const canonicalDir = path.dirname(canonicalPath);
      if (!fs.existsSync(canonicalDir)) fs.mkdirSync(canonicalDir, { recursive: true });
      fs.copyFileSync(legacyPath, canonicalPath);
      return `Migrated knowledge store from ${legacyPath} to ${canonicalPath} (original left in place).`;
    } catch {
      // Best-effort migration — try the next candidate.
    }
  }
  return null;
}

/**
 * MCP clients (including Claude Code) may deliver array/object tool arguments
 * as JSON-encoded strings instead of parsed values. This function walks the
 * args object and parses any string that looks like JSON array/object.
 */
function deepCoerceArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (typeof val === 'string') {
      // Try to parse JSON arrays and objects
      if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
        try { out[key] = JSON.parse(val); } catch { /* keep as string */ }
      }
      // Coerce boolean strings
      else if (val === 'true') out[key] = true;
      else if (val === 'false') out[key] = false;
    }
  }
  return out;
}

// Build session state
const session = {
  phase: 0,      // 0=idle, 1=discovery, 2=inventory, 3=build, 4=qa, 5=report
  artboardId: null,
  enforcementProfile: null,
  toolCallCount: 0,
  cacheHits: 0,
  // Circuit breaker state
  consecutiveFailures: 0,
  phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  checkpointIssued: false,
  // Binding failure tracking — accumulated during Phase 3 for the build report
  bindingFailures: [],
  // Text override tracking — per component instance, tracks expected vs overridden text nodes
  // Key: component nodeId → { name, expected: [{nodeId, name, defaultText}], overridden: Set<nodeId|name> }
  componentTextTracker: new Map(),
  // Variable source mismatch confirmation state
  pendingVariableMismatchConfirmation: false,
  variableMismatchSourceLibs: null,
  variableSourceConfirmed: null,
  // Report enforcement — blocks new builds until report is generated
  buildsSinceReport: 0,
  // Plugin disconnect during active build — blocks all build tools until mimic_status is called
  buildInterrupted: false,
  // Variable category mismatches — accumulated during Phase 3 for the build report
  categoryMismatches: [],
  // Failure signals — accumulated during build for no-good compilation
  _signals: new Map(),
};

// Circuit breaker constants
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PHASE3_CALLS_BEFORE_CHECKPOINT = 20;
const MAX_PHASE3_CALLS_BEFORE_STOP = 300;

function requirePhase(minPhase, hint) {
  const { PhaseError } = require('./src/utils/errors');
  if (session.phase < minPhase) {
    throw new PhaseError(session.phase, minPhase, hint);
  }
}

/**
 * Enforce report before starting a new build session.
 * Call this only from session-starting tools (discover_ds), not from
 * individual build operations (create_frame, create_text, etc.).
 */
function requireReportIfPending() {
  if (session.buildsSinceReport > 0) {
    const err = new Error(
      `REPORT_REQUIRED: A build completed without a report. ` +
      `Call mimic_generate_build_report before starting a new build. ` +
      `The build report is mandatory after every build — ` +
      `it teaches users about DS usage, gaps, and efficiency.`
    );
    err.code = 'REPORT_REQUIRED';
    throw err;
  }
}

function advancePhase(to) {
  // Mark that a build happened (for report enforcement on next discovery)
  if (to >= 3 && session.buildsSinceReport === 0) {
    session.buildsSinceReport = 1;
  }
  session.phase = Math.max(session.phase, to);
}

function resetSession() {
  session.phase = 0;
  session.artboardId = null;
  session.enforcementProfile = null;
  session.toolCallCount = 0;
  session.cacheHits = 0;
  session.consecutiveFailures = 0;
  session.phaseToolCalls = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  session.checkpointIssued = false;
  session.bindingFailures = [];
  session.componentTextTracker = new Map();
  session.buildsSinceReport = 0;
  session.buildInterrupted = false;
  session.categoryMismatches = [];
  session._signals = new Map();
  // Community library check state
  session.pendingCommunityCheck = false;
  session.discoveryFileKey = null;
  session.discoveredLibraries = null;
  session.discoveryResults = null;
  session.completenessWarnings = null;
  // Variable source mismatch state
  session.pendingVariableMismatchConfirmation = false;
  session.variableMismatchSourceLibs = null;
  session.variableSourceConfirmed = null;
}

// ── Tool Registry ─────────────────────────────────────────────────────
const toolRegistry = { tools: [], handlers: {} };

function registerTool(name, description, inputSchema, handler) {
  toolRegistry.tools.push({ name, description, inputSchema });
  toolRegistry.handlers[name] = handler;
}

// Shared instances
const bridge = new Bridge({ port: 3056 });

// Flag active build as interrupted when plugin disconnects mid-build.
// Build tools are blocked until mimic_status clears the flag after reconnection.
bridge._onDisconnect = () => {
  if (session.phase >= 3 && session.phase < 5) {
    session.buildInterrupted = true;
  }
};
const dsCache = new DsCache();
const dsResolver = new DsResolver(dsCache);
const knowledgeStorePath = resolveKnowledgeStorePath();
const knowledgeStoreDir = path.dirname(knowledgeStorePath);
if (!fs.existsSync(knowledgeStoreDir)) {
  fs.mkdirSync(knowledgeStoreDir, { recursive: true });
}
// One-time migration from legacy locations (old cwd-based default, or the
// ~/ds-knowledge.json path some workarounds referenced) into the canonical
// path. Runs before load() so the migrated data is what actually loads.
const knowledgeStoreMigrationNote = migrateKnowledgeStoreIfNeeded(knowledgeStorePath);
const knowledgeStore = new KnowledgeStore(knowledgeStorePath);
const buildManifest = new BuildManifest();
// Lazy-resolved on each discovery call — re-reads config file so token
// updates take effect without restarting the MCP server process.
let _figmaRest = null;
let _lastToken = null;
function getFigmaRest() {
  const token = resolveFigmaToken();
  if (!token) return null;
  if (token !== _lastToken) {
    _figmaRest = new FigmaRest(token);
    _lastToken = token;
  }
  return _figmaRest;
}
// Backwards compat for code that references figmaRest directly
const figmaRest = null; // use getFigmaRest() instead

// MCP Server
const server = new Server(
  { name: 'mimic-ai', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// Context object passed to all tool registration functions
const context = {
  bridge,
  dsCache,
  dsResolver,
  knowledgeStore,
  buildManifest,
  session,
  requirePhase,
  requireReportIfPending,
  advancePhase,
  resetSession,
  registerTool,
  get figmaRest() { return getFigmaRest(); },
};

// Tool registration
require('./src/tools/status').register(server, context);
require('./src/tools/ds-setup').register(server, context);
require('./src/tools/build').register(server, context);
require('./src/tools/components').register(server, context);
require('./src/tools/edit').register(server, context);
require('./src/tools/inspect').register(server, context);
require('./src/tools/batch').register(server, context);
require('./src/tools/learning').register(server, context);
require('./src/tools/compliance').register(server, context);
require('./src/tools/rendering').register(server, context);
require('./src/tools/table').register(server, context);
require('./src/tools/chart').register(server, context);

// ── MCP Request Handlers ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolRegistry.handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool', name }) }],
    };
  }
  // These tools are always allowed, even when circuit breaker is active
  const EXEMPT_TOOLS = new Set([
    // Status & reporting
    'mimic_status', 'mimic_generate_build_report', 'mimic_generate_design_md',
    // Discovery & setup (failures here shouldn't block builds)
    'mimic_discover_ds', 'mimic_map_components', 'mimic_ai_knowledge_read',
    'figma_discover_library_styles', 'figma_discover_library_variables',
    'figma_discover_library_components',
    'figma_preload_styles', 'figma_preload_variables', 'figma_set_session_defaults',
    // Inspect & QA
    'figma_validate_ds_compliance', 'figma_get_node_props', 'figma_get_node_children',
    'figma_get_node_parent', 'figma_get_page_nodes', 'figma_get_pages',
    'figma_get_selection', 'figma_get_text_info', 'figma_get_component_variants',
    'figma_read_variable_values', 'figma_list_text_styles',
  ]);

  // Build interrupt guard: plugin disconnected during an active build.
  // ALL build tools are blocked until the plugin reconnects and mimic_status is called.
  // This prevents the LLM from continuing with Mimic tools in a corrupted session state.
  if (session.buildInterrupted && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'BUILD_INTERRUPTED',
        message: 'The Figma plugin disconnected during an active build. This build session is paused. '
          + 'STOP ALL BUILDING — do NOT use other Figma tools (Figma MCP, use_figma, etc.) as a fallback. '
          + 'They bypass DS enforcement and produce output without components, variables, or text styles. '
          + 'The user must reconnect the plugin, then call mimic_status to resume.',
        recovery: 'Ask the user to run the Mimic AI plugin in Figma, then call mimic_status.',
        phase: session.phase,
        toolCallCount: session.toolCallCount,
      }) }],
    };
  }

  // Circuit breaker: check if too many consecutive failures
  if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'CIRCUIT_BREAKER',
        consecutiveFailures: session.consecutiveFailures,
        message: `${session.consecutiveFailures} consecutive tool calls have failed. Stop building and generate the report with mimic_generate_build_report. Do not attempt more fixes — investigate the pattern of failures first.`,
        recentPhase: session.phase,
        toolCallCount: session.toolCallCount,
      }) }],
    };
  }

  // Circuit breaker: max tool calls in Phase 3 before forced stop
  if (session.phase === 3 && session.phaseToolCalls[3] >= MAX_PHASE3_CALLS_BEFORE_STOP && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'BUILD_LIMIT_REACHED',
        message: `${MAX_PHASE3_CALLS_BEFORE_STOP} tool calls in build phase. This build is too large or stuck. Generate the report with mimic_generate_build_report and assess what was built so far.`,
        toolCallCount: session.toolCallCount,
        phaseToolCalls: session.phaseToolCalls[3],
      }) }],
    };
  }

  try {
    const result = await handler(deepCoerceArgs(args || {}));

    // Success: reset consecutive failure counter, increment phase counter
    session.consecutiveFailures = 0;
    session.phaseToolCalls[session.phase] = (session.phaseToolCalls[session.phase] || 0) + 1;

    // Track binding failures at session level for the build report
    if (result && typeof result === 'object' && result.bindingFailures) {
      const failedBindings = Object.entries(result.applied || {})
        .filter(([, ok]) => ok === false)
        .map(([k]) => k);
      session.bindingFailures.push({
        tool: name,
        nodeId: result.nodeId || null,
        nodeName: result.name || null,
        failedBindings,
        warnings: result.warnings || [],
      });
      // Emit signals for no-good compilation
      for (const varPath of failedBindings) {
        session._signals.set(`binding_failure:${varPath}`, {
          type: 'binding_failure', key: varPath, context: `${name}: ${varPath} not found`,
        });
      }
    }

    // Track category mismatches for the build report
    if (result && typeof result === 'object' && result._categoryWarnings) {
      session.categoryMismatches.push(...result._categoryWarnings);
      // Emit signals for no-good compilation
      for (const warning of result._categoryWarnings) {
        const varMatch = warning.match(/^[^:]+:\s*'([^']+)'.+for (\w+)/);
        if (varMatch) {
          const signalKey = `${varMatch[1]}->${varMatch[2]}`;
          session._signals.set(`category_mismatch:${signalKey}`, {
            type: 'category_mismatch', key: signalKey, context: warning,
          });
        }
      }
    }

    // Phase 3 checkpoint: after N build operations, insert a progress summary
    if (session.phase === 3
        && session.phaseToolCalls[3] === MAX_PHASE3_CALLS_BEFORE_CHECKPOINT
        && !session.checkpointIssued) {
      session.checkpointIssued = true;
      const checkpoint = {
        checkpoint: true,
        buildOpsCompleted: session.phaseToolCalls[3],
        message: `${MAX_PHASE3_CALLS_BEFORE_CHECKPOINT} build operations completed. Take a screenshot or call figma_validate_ds_compliance to verify progress before continuing. Fix any issues now — they compound if left until the end.`,
        cachedState: {
          textStyles: dsCache.textStyles.size,
          variables: dsCache.variables.size,
          components: dsCache.components.size,
          failedKeys: dsCache.failedKeys.size,
          libraryFontIncompatible: dsCache.libraryFontIncompatible,
        },
      };
      // Merge checkpoint into result
      const merged = typeof result === 'object' && result !== null
        ? { ...result, _checkpoint: checkpoint }
        : { result, _checkpoint: checkpoint };
      return {
        content: [{ type: 'text', text: JSON.stringify(merged) }],
      };
    }

    // Inject report reminder sparingly — every 10th build op or on status checks
    const buildOps = session.phaseToolCalls[3] || 0;
    if (session.phase >= 3 && session.phase < 5 && buildOps > 0 && typeof result === 'object' && result !== null) {
      if (name === 'mimic_status' || buildOps % 10 === 0) {
        result._reportReminder = 'When the build is done, you MUST call mimic_generate_build_report before responding to the user.';
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    const { isInfraError } = require('./src/utils/errors');
    const infraFailure = isInfraError(err);

    // Only count USER errors toward circuit breaker (wrong params, phase errors, bad variable paths).
    // Infra failures (bridge timeout, parent node disappeared, plugin disconnected) are NOT the
    // user's fault — reset the counter and warn with retry guidance instead of punishing.
    if (!EXEMPT_TOOLS.has(name)) {
      if (infraFailure) {
        session.consecutiveFailures = 0; // reset — don't punish for infra problems
      } else {
        session.consecutiveFailures++;
      }
    }
    session.phaseToolCalls[session.phase] = (session.phaseToolCalls[session.phase] || 0) + 1;

    const errorPayload = err.toJSON ? err.toJSON() : { error: err.message };

    // Surface plugin error details (available options, recovery hints)
    if (err.pluginError && typeof err.pluginError === 'object') {
      if (err.pluginError.available) errorPayload.available = err.pluginError.available;
      if (err.pluginError.recovery) errorPayload.recovery = err.pluginError.recovery;
      if (err.pluginError.property) errorPayload.property = err.pluginError.property;
    }

    // Plugin disconnect during active build: set interrupt flag
    const isDisconnect = /PLUGIN_DISCONNECTED/i.test(err.message);
    if (isDisconnect && session.phase >= 3 && session.phase < 5) {
      session.buildInterrupted = true;
    }

    // Infra failures: add recovery guidance instead of circuit breaker warnings
    if (infraFailure) {
      errorPayload._infraFailure = {
        classified: true,
        message: isDisconnect
          ? 'PLUGIN DISCONNECTED during active build. STOP ALL BUILDING. '
            + 'Do NOT use other Figma tools (Figma MCP, use_figma, etc.) as a fallback — '
            + 'they bypass DS enforcement and produce output without components, variables, or text styles. '
            + 'Tell the user the plugin disconnected. After reconnection, call mimic_status to resume.'
          : 'This is an infrastructure failure (plugin/bridge), not a user error. '
            + 'The circuit breaker counter has been reset. '
            + 'Retry the operation, or if the plugin is disconnected, ask the user to restart it.',
        suggestion: isDisconnect
          ? 'STOP. Ask the user to reconnect the Figma plugin. Then call mimic_status to resume the build.'
          : /Bridge timeout/i.test(err.message)
            ? 'Bridge timed out — the plugin may be busy or disconnected. Wait a moment and retry.'
            : /Parent node not found/i.test(err.message) || /Parent node not found/i.test(err.pluginError?.message || '')
              ? 'Parent node disappeared — this is a plugin state issue. Verify the parent still exists with figma_get_node_children on its container, then retry.'
            : /plugin disconnected/i.test(err.message)
              ? 'Plugin disconnected — ask the user to restart the Figma plugin, then retry.'
              : 'Infrastructure error detected. Retry or check plugin status.',
      };
    }

    // Add failure context for user errors approaching circuit breaker
    if (!infraFailure && session.consecutiveFailures >= 2) {
      errorPayload._failureContext = {
        consecutiveFailures: session.consecutiveFailures,
        warning: session.consecutiveFailures === 2
          ? 'Two consecutive failures. If the next call also fails, the circuit breaker will activate. Verify your parameters against cached DS values before retrying.'
          : `${session.consecutiveFailures} consecutive failures. Circuit breaker will activate.`,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    };
  }
});

async function main() {
  // Start bridge (auto-starts, invisible to user)
  await bridge.start();

  // Load knowledge store if it exists. load() never throws — a corrupt file
  // or unsupported schema version is backed up and replaced with a fresh
  // store instead of preventing the server from connecting (see store.js).
  knowledgeStore.load();

  // Surface knowledge-store startup notices loudly. These aren't fatal, but
  // they mean learning silently reset or moved — the user should know.
  // Stashed on `session` too so a future mimic_status update can surface
  // them in-band, the same way session.buildInterrupted does today.
  if (knowledgeStoreMigrationNote) {
    console.error(`[mimic-ai] ${knowledgeStoreMigrationNote}`);
    session.knowledgeStoreNotice = knowledgeStoreMigrationNote;
  }
  if (knowledgeStore.loadWarning) {
    console.error(`[mimic-ai] ${knowledgeStore.loadWarning.message}`);
    session.knowledgeStoreNotice = knowledgeStore.loadWarning.message;
  }

  // Connect MCP
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start when run directly (`node mcp.js` / the `mimic-ai` bin entry),
// not when required by tests — requiring this module registers tools and
// constructs shared instances (harmless), but must not open the bridge port
// or attempt a stdio connection as a side effect of `require()`.
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  server,
  context,
  resolveKnowledgeStorePath,
  migrateKnowledgeStoreIfNeeded,
};
