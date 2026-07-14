'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const MAX_EXECUTE_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — generous for HTML/JSON payloads, bounded for a localhost dev tool
const HELLO_TYPE = 'mimic_hello';

class Bridge {
  /**
   * @param {object} opts
   * @param {number} [opts.port=3056] - overridden by the MIMIC_BRIDGE_PORT env var when not explicit
   * @param {number} [opts.keepaliveInterval=15000]
   * @param {number} [opts.maxReconnectAttempts=3]
   * @param {number} [opts.defaultTimeout=60000]
   */
  constructor(opts = {}) {
    this.port = opts.port ?? (Number(process.env.MIMIC_BRIDGE_PORT) || 3056);
    this.keepaliveInterval = opts.keepaliveInterval ?? 15000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 120000;

    this.connected = false;
    this.ws = null;
    this.server = null;
    this.wss = null;
    this._keepaliveTimer = null;

    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.responseHandlers = new Map();
  }

  // ── Message formatting ──────────────────────────────────────────────

  /**
   * Creates a message envelope with a unique ID.
   */
  formatMessage(type, payload) {
    return {
      id: crypto.randomUUID(),
      type,
      payload: payload ?? {},
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Start HTTP + WebSocket server.
   *
   * Never kills anything on the target port. If the port is taken, we
   * probe it to tell apart "another Mimic AI session" (actionable message,
   * points at MIMIC_BRIDGE_PORT) from "some unrelated process" (generic
   * EADDRINUSE guidance) — and fail startup either way.
   *
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleHttp(req, res);
      });

      this.wss = new WebSocketServer({
        server: this.server,
        verifyClient: ({ origin }) => this._isLocalOrigin(origin),
      });
      this.wss.on('connection', (socket) => this._onConnection(socket));
      // ws re-emits the underlying server's bind failures on the
      // WebSocketServer instance itself. With no listener there, that
      // re-emit throws synchronously mid-emit on `this.server`, which
      // aborts the loop before our own `error` listener below ever runs.
      // A no-op listener here just prevents that; `onError` on
      // `this.server` is what actually handles EADDRINUSE.
      this.wss.on('error', () => {});

      const onError = async (err) => {
        this.server.removeListener('error', onError);
        if (err && err.code === 'EADDRINUSE') {
          const isMimicBridge = await this._probeExistingBridge();
          if (isMimicBridge) {
            reject(new Error(
              `Another Mimic AI session is already running (bridge on port ${this.port}). ` +
              `Close the other session or set MIMIC_BRIDGE_PORT to run this one on a different port.`
            ));
          } else {
            reject(new Error(
              `Port ${this.port} is already in use by another process (not a Mimic AI bridge). ` +
              `Stop whatever is using port ${this.port}, or set MIMIC_BRIDGE_PORT to run Mimic on a different port.`
            ));
          }
          return;
        }
        reject(err);
      };
      this.server.on('error', onError);

      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
  }

  /**
   * Probe whatever is already listening on this.port to see if it looks
   * like a Mimic AI bridge (identified via the `service` marker on /status).
   * Never throws — resolves false on any error, timeout, or unexpected shape.
   * @returns {Promise<boolean>}
   */
  _probeExistingBridge() {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/status', timeout: 1000 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              resolve(!!(parsed && parsed.service === 'mimic-ai-bridge'));
            } catch (_) {
              resolve(false);
            }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  /**
   * Gracefully stop everything.
   */
  async stop() {
    this.stopKeepalive();

    // Reject all pending response handlers
    this._rejectAllPending('Bridge shutting down');

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── Sending ─────────────────────────────────────────────────────────

  /**
   * Send a message to the connected Figma plugin.
   * Queues if not connected; resolves when response arrives.
   *
   * @param {string} type
   * @param {object} payload
   * @param {number} [timeout]
   * @returns {Promise<object>}
   */
  send(type, payload, timeout) {
    const msg = this.formatMessage(type, payload);
    const effectiveTimeout = timeout ?? this.defaultTimeout;

    const promise = new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        // Fail fast — don't queue indefinitely when the plugin is disconnected.
        // CRITICAL: The error message explicitly forbids fallback to other Figma tools.
        // Without this, the LLM pivots to non-Mimic Figma MCP tools that have zero
        // DS enforcement — producing garbage output with raw hex, no components, no variables.
        reject(new Error(
          `PLUGIN_DISCONNECTED: Cannot execute "${type}" — the Figma plugin is not connected. ` +
          `STOP ALL BUILDING. Do NOT use other Figma tools (Figma MCP, use_figma, etc.) as a fallback — ` +
          `they bypass DS enforcement and produce output without components, variables, or text styles. ` +
          `Tell the user the plugin disconnected. They must reopen Figma and run the Mimic AI plugin ` +
          `(Plugins > Development > Mimic AI > Run). After reconnection, call mimic_status to verify ` +
          `the session before continuing the build.`
        ));
        return;
      }

      this._dispatch(msg, resolve, reject, effectiveTimeout);
    });

    return promise;
  }

  /**
   * Send a batch of operations to the plugin in one WebSocket message.
   * The plugin executes them sequentially with $resultOf:N reference resolution.
   * Auto-chunks at CHUNK_SIZE operations to avoid plugin timeout.
   *
   * @param {Array<{type: string, payload: object}>} operations
   * @param {number} [timeout] - Override timeout per chunk.
   * @returns {Promise<{results: Array, totalOps: number, succeeded: number, failed: number}>}
   */
  sendBatch(operations, timeout) {
    const CHUNK_SIZE = 50;

    // Normalize node IDs but preserve $resultOf references
    const normalizedOps = operations.map(op => {
      const payload = op.payload ? { ...op.payload } : {};
      for (const key of ['nodeId', 'parentId', 'targetId']) {
        if (typeof payload[key] === 'string' && !payload[key].startsWith('$resultOf:')) {
          payload[key] = payload[key].replace(/-/g, ':');
        }
      }
      return { type: op.type, payload };
    });

    // Single chunk — send directly
    if (normalizedOps.length <= CHUNK_SIZE) {
      const effectiveTimeout = timeout ?? (this.defaultTimeout + normalizedOps.length * 500);
      const msg = this.formatMessage('batch_execute', { operations: normalizedOps });

      return new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          reject(new Error(
            `PLUGIN_DISCONNECTED: Cannot execute batch — the Figma plugin is not connected. ` +
            `STOP ALL BUILDING. Do NOT use other Figma tools as a fallback — ` +
            `they bypass DS enforcement. Tell the user to reconnect the plugin, ` +
            `then call mimic_status to resume.`
          ));
          return;
        }
        this._dispatch(msg, resolve, reject, effectiveTimeout);
      });
    }

    // Multiple chunks — execute sequentially, stitch results
    return this._sendBatchChunked(normalizedOps, timeout);
  }

  /**
   * Internal: split large batch into chunks and execute sequentially.
   * Cross-chunk $resultOf references are resolved by remapping indices.
   */
  async _sendBatchChunked(operations, timeout) {
    const CHUNK_SIZE = 50;
    const allResults = [];
    let offset = 0;

    for (let start = 0; start < operations.length; start += CHUNK_SIZE) {
      const chunk = operations.slice(start, start + CHUNK_SIZE);

      // Remap $resultOf references: prior-chunk refs resolve to concrete values,
      // same-chunk refs get re-indexed relative to chunk start.
      const remapped = chunk.map(op => {
        const payload = { ...op.payload };
        for (const key of ['nodeId', 'parentId', 'targetId']) {
          if (typeof payload[key] === 'string') {
            const m = payload[key].match(/^\$resultOf:(\d+)(?:\.(.+))?$/);
            if (m) {
              const refIdx = parseInt(m[1], 10);
              if (refIdx < offset) {
                // Reference points to a prior chunk — resolve with concrete value
                const field = m[2] || 'nodeId';
                const prior = allResults[refIdx];
                payload[key] = (prior && prior.ok && prior.result) ? (prior.result[field] || null) : null;
              } else {
                // Reference is within this chunk — remap index
                const newIdx = refIdx - offset;
                payload[key] = `$resultOf:${newIdx}${m[2] ? '.' + m[2] : ''}`;
              }
            }
          }
        }
        return { type: op.type, payload };
      });

      const effectiveTimeout = timeout ?? (this.defaultTimeout + remapped.length * 500);
      const msg = this.formatMessage('batch_execute', { operations: remapped });

      const chunkResult = await new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          reject(new Error(
            `PLUGIN_DISCONNECTED: Cannot execute batch chunk — the Figma plugin is not connected. ` +
            `STOP ALL BUILDING. Do NOT use other Figma tools as a fallback — ` +
            `they bypass DS enforcement. Tell the user to reconnect the plugin, ` +
            `then call mimic_status to resume.`
          ));
          return;
        }
        this._dispatch(msg, resolve, reject, effectiveTimeout);
      });

      // Re-index results to global indices
      const chunkResults = (chunkResult.results || []).map(r => ({
        ...r,
        index: r.index + offset,
      }));
      allResults.push(...chunkResults);
      offset += chunk.length;
    }

    const succeeded = allResults.filter(r => r.ok).length;
    return {
      results: allResults,
      totalOps: allResults.length,
      succeeded,
      failed: allResults.length - succeeded,
    };
  }

  // ── Keepalive ───────────────────────────────────────────────────────

  startKeepalive() {
    this.stopKeepalive();
    this._keepaliveTimer = setInterval(() => this._pingTick(), this.keepaliveInterval);

    // Allow the Node process to exit even if the timer is running
    if (this._keepaliveTimer.unref) {
      this._keepaliveTimer.unref();
    }
  }

  stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  /**
   * One keepalive tick: standard ws liveness check. If the previous ping
   * never got a pong back (isAlive still false), the socket is dead —
   * terminate it so `close` fires and ops fail fast instead of idling out
   * the full request timeout. Otherwise mark it unanswered and ping again.
   */
  _pingTick() {
    if (!this.ws || !this.connected) return;

    if (this.ws.isAlive === false) {
      this.ws.terminate();
      return;
    }

    this.ws.isAlive = false;
    this.ws.ping();
  }

  // ── Private ─────────────────────────────────────────────────────────

  /**
   * Reject every in-flight response handler with the given message and
   * clear the map. Shared by shutdown, socket close/terminate, and
   * connection supersede — anywhere the connection tied to those pending
   * requests goes away.
   */
  _rejectAllPending(message) {
    for (const [, handler] of this.responseHandlers) {
      clearTimeout(handler.timer);
      handler.reject(new Error(message));
    }
    this.responseHandlers.clear();
  }

  /**
   * Normalize Figma node IDs: replace dashes with colons.
   */
  _normalizeNodeIds(payload) {
    if (!payload) return payload;
    const out = { ...payload };
    for (const key of ['nodeId', 'parentId', 'targetId']) {
      if (typeof out[key] === 'string') {
        out[key] = out[key].replace(/-/g, ':');
      }
    }
    return out;
  }

  /**
   * Send a message over the WebSocket and register a response handler.
   */
  _dispatch(msg, resolve, reject, timeout) {
    const normalized = {
      ...msg,
      payload: this._normalizeNodeIds(msg.payload),
    };

    const timer = setTimeout(() => {
      this.responseHandlers.delete(msg.id);
      reject(new Error(`Bridge timeout after ${timeout}ms for ${msg.type} (${msg.id})`));
    }, timeout);

    // Allow timer to not block exit
    if (timer.unref) timer.unref();

    this.responseHandlers.set(msg.id, { resolve, reject, timer });

    try {
      this.ws.send(JSON.stringify(normalized));
    } catch (err) {
      clearTimeout(timer);
      this.responseHandlers.delete(msg.id);
      reject(err);
    }
  }

  /**
   * Handle incoming WebSocket connection. The socket is NOT treated as the
   * plugin executor until it sends a `mimic_hello` message — this stops any
   * local process that opens a raw WS connection from silently displacing
   * the real plugin (defect 5b). The `/execute` HTTP path is a distinct
   * client and is unaffected by this — it only ever talks through
   * `this.send()`, which already gates on `this.connected`.
   */
  _onConnection(socket) {
    socket.isAlive = true;
    let helloReceived = false;

    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (data) => {
      if (!helloReceived) {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (_) {
          console.warn('[Mimic AI bridge] Ignoring unparseable WebSocket message before executor handshake');
          return;
        }
        if (msg && msg.type === HELLO_TYPE) {
          helloReceived = true;
          this._promoteExecutor(socket);
          return;
        }
        console.warn(`[Mimic AI bridge] Ignoring message with unexpected type "${msg && msg.type}" before executor handshake`);
        return;
      }
      this._onMessage(data);
    });

    socket.on('close', () => {
      if (this.ws === socket) {
        this.connected = false;
        this.ws = null;
        this.stopKeepalive();
        this._rejectAllPending(
          'PLUGIN_DISCONNECTED: The Figma plugin connection closed while this request was in flight. ' +
          'Reopen the Mimic AI plugin in Figma and retry.'
        );
        // Notify disconnect listener (used by session to flag build interruption)
        if (this._onDisconnect) this._onDisconnect();
      }
    });

    socket.on('error', (err) => {
      // Swallow; close handler will clean up
    });
  }

  /**
   * Promote a socket that has just sent `mimic_hello` to be THE plugin
   * executor. Latest-hello-wins — reconnects must keep working — but any
   * requests still in flight on the connection being superseded are
   * rejected immediately instead of idling out the full timeout (defect 3).
   */
  _promoteExecutor(socket) {
    if (this.ws && this.ws !== socket) {
      this._rejectAllPending(
        'PLUGIN_DISCONNECTED: The Figma plugin reconnected while this request was in flight. ' +
        'The new connection is active — retry the operation.'
      );
      this.ws.close();
    }

    this.ws = socket;
    this.connected = true;
    this.startKeepalive();
  }

  /**
   * Handle an incoming message (response from Figma plugin).
   */
  _onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      console.warn('[Mimic AI bridge] Ignoring malformed WebSocket message (invalid JSON)');
      return;
    }

    const handler = this.responseHandlers.get(data.id);
    if (!handler) return; // No matching request

    clearTimeout(handler.timer);
    this.responseHandlers.delete(data.id);

    if (data.error) {
      const errorMsg = typeof data.error === 'object'
        ? (data.error.message || JSON.stringify(data.error))
        : String(data.error);
      const err = new Error(errorMsg);
      err.pluginError = data.error;
      handler.reject(err);
    } else {
      handler.resolve(data.result ?? data);
    }
  }

  /**
   * Minimal HTTP handler for /status and /execute.
   */
  _isLocalOrigin(origin) {
    if (!origin) return true; // Same-origin requests (curl, etc.) have no Origin header
    try {
      const url = new URL(origin);
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch { return false; }
  }

  _handleHttp(req, res) {
    const origin = req.headers.origin;

    // Reject non-local origins
    if (origin && !this._isLocalOrigin(origin)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // CORS headers — only allow localhost origins
    const allowedOrigin = origin || 'http://localhost';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'mimic-ai-bridge',
        connected: this.connected,
      }));
      return;
    }

    if (req.url === '/execute' && req.method === 'POST') {
      this._handleExecute(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  /**
   * POST /execute — forward a command to the Figma plugin via WebSocket.
   * Body is capped at MAX_EXECUTE_BODY_BYTES (413 beyond) — an unbounded
   * localhost endpoint would otherwise buffer arbitrarily large requests
   * in memory (defect 5a).
   */
  _handleExecute(req, res) {
    let body = '';
    let bytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_EXECUTE_BODY_BYTES) {
        rejected = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Request body exceeds ${MAX_EXECUTE_BODY_BYTES} byte limit` }));
        // Drain (don't buffer) the rest of the body instead of destroying the
        // socket outright — an abrupt destroy can race the response bytes
        // and reset the connection before the client reads the 413.
        req.resume();
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (rejected) return;
      try {
        const { type, payload, timeout } = JSON.parse(body);
        if (!type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "type" field' }));
          return;
        }
        const result = await this.send(type, payload, timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}

// ── Standalone entry point ────────────────────────────────────────────

async function startStandalone() {
  // MIMIC_BRIDGE_PORT is the documented override; BRIDGE_PORT is kept as a
  // legacy alias so any existing setups that already set it keep working.
  const port = Number(process.env.MIMIC_BRIDGE_PORT) || Number(process.env.BRIDGE_PORT) || 3056;
  const bridge = new Bridge({ port });
  await bridge.start();
  console.log(`Bridge listening on port ${bridge.port}`);

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { Bridge, startStandalone };
