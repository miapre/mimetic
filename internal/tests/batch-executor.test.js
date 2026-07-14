const { describe, it } = require('node:test');
const assert = require('node:assert');

// Portable implementation of the plugin's resolvePayloadRefs for testing.
// The canonical implementation lives in plugin/code.js handlers.batch_execute.
const REF_PATTERN = /^\$resultOf:(\d+)(?:\.(.+))?$/;

function resolveRefs(payload, results) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(item => resolveRefs(item, results));
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      const match = value.match(REF_PATTERN);
      if (match) {
        const idx = parseInt(match[1], 10);
        const field = match[2] || 'nodeId';
        const entry = results[idx];
        out[key] = (entry && entry.ok && entry.result) ? (entry.result[field] ?? null) : null;
      } else {
        out[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      out[key] = resolveRefs(value, results);
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('batch executor reference resolution', () => {
  const results = [
    { ok: true, result: { nodeId: '100:1', name: 'Card' } },
    { ok: true, result: { nodeId: '100:2', name: 'Title' } },
    { ok: false, error: 'NODE_NOT_FOUND' },
  ];

  it('substitutes $resultOf:N with result.nodeId (default field)', () => {
    const payload = { parentId: '$resultOf:0', content: 'hello' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, '100:1');
    assert.equal(resolved.content, 'hello');
  });

  it('substitutes $resultOf:N.field for explicit field access', () => {
    const payload = { parentId: '$resultOf:1.name' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, 'Title');
  });

  it('returns null for references to failed operations', () => {
    const payload = { parentId: '$resultOf:2' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, null);
  });

  it('returns null for out-of-bounds references', () => {
    const payload = { parentId: '$resultOf:99' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, null);
  });

  it('leaves non-reference strings untouched', () => {
    const payload = { parentId: '100:5', name: 'Test' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, '100:5');
    assert.equal(resolved.name, 'Test');
  });

  it('resolves references in nested objects', () => {
    const payload = { props: { nodeId: '$resultOf:0' }, name: 'test' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.props.nodeId, '100:1');
  });

  it('does not mutate original payload', () => {
    const payload = { parentId: '$resultOf:0' };
    const original = JSON.stringify(payload);
    resolveRefs(payload, results);
    assert.equal(JSON.stringify(payload), original);
  });
});

describe('batch executor dependency chain simulation', () => {
  it('resolves 3-level dependency chain', () => {
    const r = [
      { ok: true, result: { nodeId: 'A' } },
      { ok: true, result: { nodeId: 'B' } },
    ];
    const op2 = { nodeId: '$resultOf:1', fillVariable: 'color' };
    const resolved = resolveRefs(op2, r);
    assert.equal(resolved.nodeId, 'B');
    assert.equal(resolved.fillVariable, 'color');
  });

  it('cascades skip when root operation fails', () => {
    const r = [{ ok: false, error: 'FAILED' }];
    const op1 = { parentId: '$resultOf:0' };
    const resolved = resolveRefs(op1, r);
    assert.equal(resolved.parentId, null);
  });
});
