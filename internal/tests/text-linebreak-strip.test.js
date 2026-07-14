'use strict';

// Restored v1 rule: container width controls wrapping in Figma, so a
// hardcoded \n / \r\n in text content fights auto-layout. figma_create_text
// and figma_update_node (op: "text") must strip line breaks from `content`
// before the value reaches the bridge, and must say so via `_textNote` when
// they do. Component text overrides (figma_component_text, in components.js)
// are explicitly out of scope — this file only covers build.js's
// figma_create_text and edit.js's figma_update_node op="text" (formerly the
// standalone figma_set_text, merged in the v3.0.0 tool-surface consolidation).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DsCache } = require('../../src/ds/cache');
const { DsResolver } = require('../../src/ds/resolver');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { BuildManifest } = require('../../src/knowledge/manifest');
const { MockBridge } = require('./helpers/mock-bridge');

function createToolContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-linebreak-knowledge.json'));
  const buildManifest = new BuildManifest();
  const session = { phase: 2, toolCallCount: 0, cacheHits: 0 };
  const handlers = {};

  const context = {
    bridge,
    dsCache,
    dsResolver,
    knowledgeStore,
    buildManifest,
    session,
    requirePhase(min) {
      if (session.phase < min) throw new Error(`phase ${session.phase} < ${min}`);
    },
    advancePhase(to) {
      session.phase = Math.max(session.phase, to);
    },
    registerTool(name, _desc, _schema, handler) {
      handlers[name] = handler;
    },
  };

  require('../../src/tools/build').register(null, context);
  require('../../src/tools/edit').register(null, context);

  return { bridge, dsCache, session, handlers };
}

describe('figma_create_text — line break stripping (build.js)', () => {
  let setup;

  beforeEach(() => {
    setup = createToolContext();
  });

  it('strips embedded \\n, collapses resulting doubled spaces, and flags _textNote', async () => {
    const result = await setup.handlers.figma_create_text({
      parentId: 'frame:1',
      content: 'Total revenue\nup 12% this quarter',
    });

    const sent = setup.bridge.getMessages('create_text').at(-1);
    assert.equal(sent.payload.content, 'Total revenue up 12% this quarter');
    assert.equal(result._textNote, 'Line breaks removed — container width controls wrapping.');
  });

  it('strips \\r\\n sequences the same way as \\n', async () => {
    await setup.handlers.figma_create_text({
      parentId: 'frame:1',
      content: 'Line one\r\nLine two\r\nLine three',
    });

    const sent = setup.bridge.getMessages('create_text').at(-1);
    assert.equal(sent.payload.content, 'Line one Line two Line three');
  });

  it('leaves text without line breaks completely untouched, and omits _textNote', async () => {
    const result = await setup.handlers.figma_create_text({
      parentId: 'frame:1',
      content: 'Total revenue',
    });

    const sent = setup.bridge.getMessages('create_text').at(-1);
    assert.equal(sent.payload.content, 'Total revenue');
    assert.equal(result._textNote, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, '_textNote') || result._textNote === undefined);
  });
});

describe('figma_update_node op="text" — line break stripping (edit.js)', () => {
  let setup;

  beforeEach(() => {
    setup = createToolContext();
  });

  it('strips embedded \\n and flags _textNote', async () => {
    const result = await setup.handlers.figma_update_node({
      op: 'text',
      nodeId: 'text:1',
      content: 'Total revenue\nup 12% this quarter',
    });

    const sent = setup.bridge.getMessages('set_text').at(-1);
    assert.equal(sent.payload.content, 'Total revenue up 12% this quarter');
    assert.equal(result._textNote, 'Line breaks removed — container width controls wrapping.');
  });

  it('leaves text without line breaks untouched and omits _textNote', async () => {
    const result = await setup.handlers.figma_update_node({
      op: 'text',
      nodeId: 'text:1',
      content: 'Total revenue',
    });

    const sent = setup.bridge.getMessages('set_text').at(-1);
    assert.equal(sent.payload.content, 'Total revenue');
    assert.equal(result._textNote, undefined);
  });
});
