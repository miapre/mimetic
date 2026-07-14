'use strict';

/**
 * Regression tests for audit finding B14 (DS-agnostic hardcoding):
 *
 * mimic_build_chart used to send hardcoded LayerLens Theme spacing/radius
 * token paths ('spacing-xl', 'spacing-lg', 'spacing-sm', 'radius-xs') to
 * every create_frame/create_rectangle call UNCONDITIONALLY, regardless of
 * whether the discovered DS actually has a variable by that name. On any
 * DS that doesn't share LayerLens's naming convention, this either binds
 * to the wrong variable (if one happens to share the name) or silently
 * fails to bind (plugin reports bindingFailures, node gets an unbound gap).
 *
 * Fixed behavior: gapVariable/paddingVariable/cornerRadiusVariable are
 * only sent when the DS cache has an EXACT match for that token path.
 * Otherwise the tool falls back to a raw gap/padding/cornerRadius number
 * so the layout still renders correctly, and the response calls out
 * which tokens fell back via `_spacingRadiusFallbackNote`.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');

function createTestContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const session = {
    phase: 2,
    toolCallCount: 0,
    consecutiveFailures: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    bindingFailures: [],
  };
  const handlers = {};
  function registerTool(name, _description, _inputSchema, handler) {
    handlers[name] = handler;
  }
  function requirePhase(minPhase, hint) {
    if (session.phase < minPhase) throw { error: 'PHASE_REQUIRED', message: hint };
  }
  function advancePhase(to) {
    session.phase = Math.max(session.phase, to);
  }
  const context = { bridge, dsCache, session, requirePhase, advancePhase, registerTool };
  require('../../../src/tools/chart').register(null, context);
  return { handlers, bridge, session, dsCache };
}

function autoUnboundSvgResponse(payload) {
  const svg = payload.svgString || '';
  const tags = svg.match(/<(polygon|path|circle)\b/g) || [];
  const unboundChildren = tags.map((tag, i) => ({
    nodeId: `svg-child:${i}`,
    type: tag.includes('polygon') ? 'POLYGON' : tag.includes('circle') ? 'ELLIPSE' : 'VECTOR',
    name: `Child ${i}`,
  }));
  return {
    nodeId: 'mock:svg1', name: payload.name || 'SVG', type: 'FRAME', width: 100, height: 100,
    applied: {}, warnings: [], bindingFailures: false, unboundChildren,
    childSummary: { vectors: unboundChildren.length, texts: 0, boundVectors: 0, boundTexts: 0 },
  };
}

describe('mimic_build_chart — spacing/radius tokens are DS-cache-validated (B14)', () => {
  let handlers, bridge, dsCache;

  beforeEach(() => {
    ({ handlers, bridge, dsCache } = createTestContext());
    bridge.setResponse('create_svg', autoUnboundSvgResponse);
  });

  it('with an empty DS cache, no create_frame/create_rectangle call sends a *Variable param for gap/padding/cornerRadius — raw numbers are used instead', async () => {
    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 20 }, { label: 'Mar', value: 15 }],
      dimensions: { chartHeight: 200 },
    });

    const frameMsgs = bridge.getMessages('create_frame');
    const rectMsgs = bridge.getMessages('create_rectangle');

    for (const msg of [...frameMsgs, ...rectMsgs]) {
      assert.strictEqual(msg.payload.gapVariable, undefined, `unexpected gapVariable in ${msg.payload.name}`);
      assert.strictEqual(msg.payload.paddingVariable, undefined, `unexpected paddingVariable in ${msg.payload.name}`);
      assert.strictEqual(msg.payload.cornerRadiusVariable, undefined, `unexpected cornerRadiusVariable in ${msg.payload.name}`);
    }

    // The card container and chart body DO get a gap — just a raw one.
    const cardFrame = frameMsgs.find(m => m.payload.name === 'Chart: Revenue');
    assert.strictEqual(typeof cardFrame.payload.gap, 'number');
    assert.strictEqual(typeof cardFrame.payload.padding, 'number');
  });

  it('flags the raw-value fallback in the response so the caller knows nothing was bound', async () => {
    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 20 }],
      dimensions: { chartHeight: 200 },
    });
    assert.ok(result._spacingRadiusFallbackNote, 'should note the fallback');
    assert.match(result._spacingRadiusFallbackNote, /spacingLg|spacingSm|spacingXl|radiusXs/);
  });

  it('uses gapVariable/paddingVariable/cornerRadiusVariable once the DS cache has exact matches, and omits the raw prop', async () => {
    dsCache.addVariable('spacing-xl', { key: 'v1', category: 'spacing' });
    dsCache.addVariable('spacing-lg', { key: 'v2', category: 'spacing' });
    dsCache.addVariable('spacing-sm', { key: 'v3', category: 'spacing' });
    dsCache.addVariable('spacing-xs', { key: 'v3b', category: 'spacing' });
    dsCache.addVariable('radius-xs', { key: 'v4', category: 'radius' });
    dsCache.addVariable('radius-full', { key: 'v4b', category: 'radius' });

    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 20 }],
      dimensions: { chartHeight: 200 },
    });

    assert.strictEqual(result._spacingRadiusFallbackNote, undefined, 'no fallback needed — everything resolved from cache');

    const cardFrame = bridge.getMessages('create_frame').find(m => m.payload.name === 'Chart: Revenue');
    assert.strictEqual(cardFrame.payload.paddingVariable, 'spacing-xl');
    assert.strictEqual(cardFrame.payload.gapVariable, 'spacing-lg');
    assert.strictEqual(cardFrame.payload.padding, undefined);
    assert.strictEqual(cardFrame.payload.gap, undefined);

    const barRect = bridge.getMessages('create_rectangle').find(m => m.payload.name.startsWith('Value:'));
    assert.strictEqual(barRect.payload.cornerRadiusVariable, 'radius-xs');
    assert.strictEqual(barRect.payload.cornerRadius, undefined);
  });

  it('does not use a same-named variable from the wrong category (e.g. a color variable coincidentally named "spacing-xl")', async () => {
    // Same path, wrong category — must be treated as not found.
    dsCache.addVariable('spacing-xl', { key: 'v1', category: 'color' });

    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }],
      dimensions: { chartHeight: 200 },
    });

    const cardFrame = bridge.getMessages('create_frame').find(m => m.payload.name === 'Chart: Revenue');
    assert.strictEqual(cardFrame.payload.paddingVariable, undefined, 'category mismatch must not be treated as a valid match');
    assert.strictEqual(typeof cardFrame.payload.padding, 'number');
  });

  it('donut/radar/line legends also validate against the cache instead of assuming spacing-xl/spacing-xs', async () => {
    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'donut',
      title: 'Share',
      data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }],
      dimensions: { outerRadius: 80, innerRadius: 0.6 },
    });

    const legendFrame = bridge.getMessages('create_frame').find(m => m.payload.name === 'Legend');
    assert.strictEqual(legendFrame.payload.gapVariable, undefined);
    assert.strictEqual(typeof legendFrame.payload.gap, 'number');
    assert.ok(result._spacingRadiusFallbackNote);
  });
});
