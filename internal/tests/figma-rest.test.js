'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FigmaRest } = require('../../src/figma-rest');

describe('FigmaRest', () => {
  it('throws if no token provided', () => {
    assert.throws(() => new FigmaRest(), /token/i);
    assert.throws(() => new FigmaRest(''), /token/i);
  });

  it('parseComponentsResponse extracts component keys and names', () => {
    const rest = new FigmaRest('figd_test');
    const raw = {
      meta: {
        components: [
          { key: 'abc123', name: 'Button', description: 'Primary button', containing_frame: { name: 'Buttons' } },
          { key: 'def456', name: 'Badge', description: '', containing_frame: { name: 'Badges' } },
        ]
      }
    };
    const result = rest.parseComponentsResponse(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 'abc123');
    assert.equal(result[0].name, 'Button');
    assert.equal(result[0].containingFrame, 'Buttons');
    assert.equal(result[1].key, 'def456');
    assert.equal(result[1].name, 'Badge');
  });

  it('parseStylesResponse filters to TEXT styles only', () => {
    const rest = new FigmaRest('figd_test');
    const raw = {
      meta: {
        styles: [
          { key: 's1', name: 'Display lg', style_type: 'TEXT', description: '' },
          { key: 's2', name: 'Brand/Primary', style_type: 'FILL', description: '' },
          { key: 's3', name: 'Text sm', style_type: 'TEXT', description: '' },
        ]
      }
    };
    const result = rest.parseStylesResponse(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 's1');
    assert.equal(result[0].name, 'Display lg');
    assert.equal(result[1].key, 's3');
  });

  it('parseComponentsResponse handles empty/missing meta gracefully', () => {
    const rest = new FigmaRest('figd_test');
    assert.deepEqual(rest.parseComponentsResponse({}), []);
    assert.deepEqual(rest.parseComponentsResponse({ meta: {} }), []);
    assert.deepEqual(rest.parseComponentsResponse({ meta: { components: [] } }), []);
  });

  it('parseStylesResponse handles empty/missing meta gracefully', () => {
    const rest = new FigmaRest('figd_test');
    assert.deepEqual(rest.parseStylesResponse({}), []);
    assert.deepEqual(rest.parseStylesResponse({ meta: {} }), []);
    assert.deepEqual(rest.parseStylesResponse({ meta: { styles: [] } }), []);
  });
});
