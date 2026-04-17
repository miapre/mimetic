/**
 * Mimic AI / bridge.js
 *
 * Local HTTP + WebSocket bridge between the MCP server and the Figma plugin.
 *
 * - MCP server POSTs instructions to  POST /execute
 * - Figma plugin connects via WebSocket at  ws://localhost:PORT
 * - Bridge queues instructions, sends them to the plugin, and returns results to the MCP.
 *
 * Run with: node bridge.js
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Default port 3055. If you change BRIDGE_PORT here, also update the WebSocket
// URL in plugin/ui.html — the Figma plugin cannot read environment variables.
const PORT = parseInt(process.env.BRIDGE_PORT || '3055', 10);
const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN;

// Cache: "fileKey:nodeId" → component key string
const componentKeyCache = new Map();

// ---------------------------------------------------------------------------
// Figma REST API helpers
// ---------------------------------------------------------------------------

async function fetchComponentKey(fileKey, nodeId) {
  const cacheKey = `${fileKey}:${nodeId}`;
  if (componentKeyCache.has(cacheKey)) return componentKeyCache.get(cacheKey);

  if (!FIGMA_TOKEN) {
    // No token — return null and let the plugin try a local lookup
    return null;
  }

  // Normalise node ID format (URL uses "1-2", API uses "1:2")
  const apiNodeId = nodeId.replace(/-/, ':');

  const res = await fetch(
    `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(apiNodeId)}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );

  if (!res.ok) {
    throw new Error(`Figma API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const nodeData = data.nodes?.[apiNodeId]?.document;

  if (!nodeData) {
    throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
  }
  if (nodeData.type !== 'COMPONENT' && nodeData.type !== 'COMPONENT_SET') {
    throw new Error(`Node ${nodeId} is type "${nodeData.type}", not a COMPONENT`);
  }

  const key = nodeData.key;
  if (!key) throw new Error(`Node ${nodeId} has no component key (is it published to the team library?)`);

  componentKeyCache.set(cacheKey, key);
  return key;
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

let pluginSocket = null;
let requestCounter = 0;
const pending = new Map(); // id → { resolve, reject, timer }

function nextId() {
  return String(++requestCounter);
}

// Per-instruction timeout (ms). Component imports may take longer due to library fetching.
const TIMEOUT_BY_TYPE = {
  insert_component: 45_000,    // Plugin has internal 15s per attempt × 2 + scan
  replace_component: 45_000,
  swap_main_component: 45_000,
};
const DEFAULT_TIMEOUT = 120_000;

async function sendToPlugin(type, params) {
  if (!pluginSocket || pluginSocket.readyState !== 1 /* OPEN */) {
    throw new Error(
      'Figma plugin is not connected. ' +
      'Open Figma desktop, go to Plugins > Development, and run "Mimic AI".'
    );
  }

  const id = nextId();
  const message = JSON.stringify({ id, type, params });
  const timeoutMs = TIMEOUT_BY_TYPE[type] || DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: Figma plugin did not respond to "${type}" within ${timeoutMs / 1000}s. The plugin may have disconnected or the operation hung.`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    pluginSocket.send(message);
  });
}

// ---------------------------------------------------------------------------
// HTTP server (MCP → bridge)
// ---------------------------------------------------------------------------

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, statusCode, body) {
  cors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /status — health check
  if (req.method === 'GET' && req.url === '/status') {
    return json(res, 200, {
      bridge: 'running',
      pluginConnected: !!(pluginSocket && pluginSocket.readyState === 1)
    });
  }

  // POST /extract-ds — enriched DS extraction via REST API (parallel path, no plugin needed)
  if (req.method === 'POST' && req.url === '/extract-ds') {
    if (!FIGMA_TOKEN) return json(res, 400, { ok: false, error: 'FIGMA_ACCESS_TOKEN not set' });
    try {
      const body = await readBody(req);
      const { fileKey } = body;
      if (!fileKey) throw new Error('"fileKey" is required');

      const apiBase = `https://api.figma.com/v1/files/${fileKey}`;
      const headers = { 'X-Figma-Token': FIGMA_TOKEN };

      // 1. Components + component sets
      const [compRes, setRes, styleRes] = await Promise.all([
        fetch(`${apiBase}/components`, { headers }).then(r => r.json()),
        fetch(`${apiBase}/component_sets`, { headers }).then(r => r.json()),
        fetch(`${apiBase}/styles`, { headers }).then(r => r.json()),
      ]);

      // 2. Variables (may fail on older files or personal plans)
      let variables = null;
      try {
        const varRes = await fetch(`${apiBase}/variables/local`, { headers });
        if (varRes.ok) variables = await varRes.json();
      } catch(e) { /* variables not available */ }

      // 3. Batch node details for component metadata (max 50 per call)
      // PRIORITY: component sets first (they carry variant structure), then standalone
      const allNodeIds = [
        ...(setRes.meta?.component_sets || []).map(c => c.node_id),
        ...(compRes.meta?.components || []).map(c => c.node_id),
      ].filter(Boolean).slice(0, 50);

      let nodeDetails = {};
      if (allNodeIds.length > 0) {
        try {
          const nodeRes = await fetch(`${apiBase}/nodes?ids=${allNodeIds.join(',')}&depth=2`, { headers });
          if (nodeRes.ok) {
            const nd = await nodeRes.json();
            nodeDetails = nd.nodes || {};
          }
        } catch(e) { /* node details not available */ }
      }

      return json(res, 200, {
        ok: true,
        result: {
          fileKey,
          extractedAt: new Date().toISOString(),
          components: compRes.meta?.components || [],
          componentSets: setRes.meta?.component_sets || [],
          styles: styleRes.meta?.styles || [],
          variables: variables?.meta || null,
          nodeDetails,
          counts: {
            components: (compRes.meta?.components || []).length,
            componentSets: (setRes.meta?.component_sets || []).length,
            styles: (styleRes.meta?.styles || []).length,
            variables: variables?.meta?.variables ? Object.keys(variables.meta.variables).length : 0,
            nodeDetails: Object.keys(nodeDetails).length,
          },
        },
      });
    } catch(err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  // POST /execute — run an instruction
  if (req.method === 'POST' && req.url === '/execute') {
    try {
      const body = await readBody(req);
      const { type, params = {} } = body;

      // For component insertion, resolve the component key here (REST API)
      // before the instruction is sent to the plugin.
      if (type === 'insert_component') {
        const { nodeId, fileKey } = params;
        // componentKey may be supplied directly (e.g. from a DS search result).
        // nodeId is only required when componentKey is not already known.
        if (!params.componentKey && !nodeId) throw new Error('"params.nodeId" or "params.componentKey" is required for insert_component');
        if (!fileKey) throw new Error('"params.fileKey" is required for insert_component');

        if (nodeId && !params.componentKey) {
          try {
            params.componentKey = await fetchComponentKey(fileKey, nodeId);
          } catch (e) {
            // Non-fatal: plugin will try getNodeById() as a fallback
            console.error(`[bridge] component key lookup failed: ${e.message}`);
            params.componentKey = null;
          }
        }
      }

      const result = await sendToPlugin(type, params);
      return json(res, 200, { ok: true, result });

    } catch (err) {
      return json(res, err.message.includes('not connected') ? 503 : 500, {
        ok: false,
        error: err.message
      });
    }
  }

  json(res, 404, { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// WebSocket server (bridge ↔ Figma plugin)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  console.log('[bridge] Figma plugin connected');
  pluginSocket = ws;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const entry = pending.get(msg.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      pending.delete(msg.id);

      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || 'Plugin returned an error'));
      }
    } catch (e) {
      console.error('[bridge] failed to parse plugin message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[bridge] Figma plugin disconnected');
    if (pluginSocket === ws) {
      pluginSocket = null;
      // Immediately reject any in-flight requests — avoids 120s hang on reconnect.
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Figma plugin disconnected. Run the plugin again to reconnect.'));
      }
      pending.clear();
    }
  });

  ws.on('error', e => console.error('[bridge] plugin socket error:', e.message));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] Running on http://127.0.0.1:${PORT}`);
  console.log('[bridge] Waiting for Figma plugin to connect…');
  if (!FIGMA_TOKEN) {
    console.warn('[bridge] FIGMA_ACCESS_TOKEN not set — library component key resolution disabled.');
    console.warn('[bridge] Components will still insert if they are in the same Figma file.');
  }
});
