'use strict';

/**
 * Contract test: every bridge message `type` that MCP-side tool code
 * (src/tools/*.js, via bridge.send() or collector.send()) sends to the
 * Figma plugin must have a corresponding handler registered in
 * plugin/code.js.
 *
 * Without this, `figma.ui.onmessage` (and the `figma_batch` dispatcher)
 * fall through to "Unknown handler: <type>" — and call sites that
 * `.catch(() => {})` the response (a common pattern for "best effort"
 * operations) silently no-op instead of surfacing the failure.
 *
 * This is exactly BUG 1 from the Mimic AI audit: src/tools/table.js sent
 * `set_node_props` (carrying paddingLeftVariable / paddingRightVariable
 * for card-inset tables) to a plugin that had no `set_node_props` handler,
 * so `firstColumnPaddingLeft` / `lastColumnPaddingRight` were documented
 * parameters that did nothing.
 *
 * plugin/code.js runs inside the Figma plugin sandbox and has no test
 * coverage in this harness (no `figma` global to execute against), so
 * this is a static/textual check rather than an execution test: parse
 * both sides as source text and diff the handler-name sets.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_CODE_PATH = path.join(__dirname, '..', '..', 'plugin', 'code.js');
const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

/** All `handlers.<name> = ...` registrations in plugin/code.js. */
function collectRegisteredHandlers() {
  const source = fs.readFileSync(PLUGIN_CODE_PATH, 'utf8');
  const names = new Set();
  const re = /^handlers\.([a-zA-Z0-9_]+)\s*=/gm;
  let m;
  while ((m = re.exec(source))) {
    names.add(m[1]);
  }
  return names;
}

function walkJsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `<something>.send('type', ...)` literal across src/ — this covers
 * both `bridge.send(...)` and `collector.send(...)` (BatchCollector /
 * SequentialSender are drop-in replacements for bridge.send with the same
 * `(type, payload)` signature, and their ops are eventually delivered to
 * the same plugin dispatcher via sendBatch/figma_batch).
 */
function collectSentTypes() {
  const files = walkJsFiles(SRC_ROOT, []);
  const sentBy = new Map(); // type -> ["relative/file.js:line", ...]
  const lineRe = /\.send\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, idx) => {
      lineRe.lastIndex = 0;
      let m;
      while ((m = lineRe.exec(line))) {
        const type = m[1];
        if (!sentBy.has(type)) sentBy.set(type, []);
        sentBy.get(type).push(`${path.relative(SRC_ROOT, file)}:${idx + 1}`);
      }
    });
  }
  return sentBy;
}

describe('Bridge <-> plugin handler contract', () => {
  it('every message type sent from src/tools has a registered plugin handler', () => {
    const registered = collectRegisteredHandlers();
    const sent = collectSentTypes();

    const missing = [];
    for (const [type, locations] of sent) {
      if (!registered.has(type)) {
        missing.push(`"${type}" sent from ${locations.join(', ')} — no handlers.${type} in plugin/code.js`);
      }
    }

    assert.equal(
      missing.length,
      0,
      'Found bridge message type(s) with no plugin handler (silent "Unknown handler" no-op):\n' +
        missing.join('\n')
    );
  });

  it('regression: set_node_props (table.js card-inset column padding) is registered', () => {
    const registered = collectRegisteredHandlers();
    assert.ok(
      registered.has('set_node_props'),
      'plugin/code.js must define handlers.set_node_props — src/tools/table.js sends it ' +
        'for firstColumnPaddingLeft / lastColumnPaddingRight and swallows the error via .catch(() => {})'
    );
  });

  it('regression: preload_fonts (B14 — DS-agnostic font pre-warm) is registered', () => {
    const registered = collectRegisteredHandlers();
    assert.ok(
      registered.has('preload_fonts'),
      'plugin/code.js must define handlers.preload_fonts — the generic, non-Inter-only ' +
        'font pre-warm entry point (see internal/tests/plugin-font-preload.test.js for behavior coverage)'
    );
  });

  it('regression: fill_slot / reset_slot (Figma Slots, GA June 2026) are registered', () => {
    const registered = collectRegisteredHandlers();
    assert.ok(
      registered.has('fill_slot'),
      'plugin/code.js must define handlers.fill_slot — src/tools/components.js\'s figma_fill_slot sends it'
    );
    assert.ok(
      registered.has('reset_slot'),
      'plugin/code.js must define handlers.reset_slot — src/tools/components.js\'s figma_reset_slot sends it'
    );
  });

  it('sanity: the extraction regex actually finds known handlers (guards against a silently broken parser)', () => {
    const registered = collectRegisteredHandlers();
    assert.ok(registered.has('set_layout_sizing'));
    assert.ok(registered.has('create_frame'));
    assert.ok(registered.size > 40, `expected 40+ registered handlers, found ${registered.size}`);
  });
});
