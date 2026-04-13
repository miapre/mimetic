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

async function sendToPlugin(type, params) {
  if (!pluginSocket || pluginSocket.readyState !== 1 /* OPEN */) {
    throw new Error(
      'Figma plugin is not connected. ' +
      'Open Figma desktop, go to Plugins > Development, and run "Mimic AI".'
    );
  }

  const id = nextId();
  const message = JSON.stringify({ id, type, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: Figma plugin did not respond to instruction "${type}" within 120s`));
    }, 120_000);

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
