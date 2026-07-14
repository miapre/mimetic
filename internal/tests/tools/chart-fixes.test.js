'use strict';

/**
 * Regression tests for three audited chart.js bugs:
 *
 *  1. buildLineChart used stroke-based SVG lines + hardcoded hex fills and
 *     discarded the create_svg result, so the DS-variable binding pass
 *     never ran. Fixed to mirror buildDonutChart/buildRadarChart: filled
 *     shapes only (no stroke), plus a post-import unboundChildren binding
 *     pass with an explicit warning if anything is left unbound.
 *  2. create_rectangle calls for legend dots passed `radiusVariable`,
 *     which the plugin doesn't understand (only `cornerRadiusVariable`).
 *  3. FALLBACK_COLORS led with semantic Brand/Success/Warning/Error colors,
 *     which the tool's own colorRules ban from chart data.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
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

// Builds a create_svg mock response whose unboundChildren mirror the actual
// vector-like tags in the generated SVG string (polygon/path/circle) — same
// shape the real plugin returns from handlers.create_svg's walkForUnbound.
function autoUnboundSvgResponse(payload) {
  const svg = payload.svgString || '';
  const tags = svg.match(/<(polygon|path|circle)\b/g) || [];
  const unboundChildren = tags.map((tag, i) => ({
    nodeId: `svg-child:${i}`,
    type: tag.includes('polygon') ? 'POLYGON' : tag.includes('circle') ? 'ELLIPSE' : 'VECTOR',
    name: `Child ${i}`,
  }));
  return {
    nodeId: 'mock:svg1',
    name: payload.name || 'SVG',
    type: 'FRAME',
    width: 100,
    height: 100,
    applied: {},
    warnings: [],
    bindingFailures: false,
    unboundChildren,
    childSummary: { vectors: unboundChildren.length, texts: 0, boundVectors: 0, boundTexts: 0 },
  };
}

const SEMANTIC_NEEDLES = ['brand-500', 'success-500', 'warning-500', 'error-500'];

describe('chart.js — line chart DS binding (Bug 1)', () => {
  let handlers, bridge;

  beforeEach(() => {
    ({ handlers, bridge } = createTestContext());
    bridge.setResponse('create_svg', autoUnboundSvgResponse);
  });

  it('never uses stroke-based SVG elements for the grid or the line', async () => {
    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'line',
      title: 'Signups',
      data: [
        { label: 'Jan', value: 10 }, { label: 'Feb', value: 25 }, { label: 'Mar', value: 18 },
      ],
      dimensions: { plotWidth: 300, plotHeight: 150 },
    });
    const svgMsg = bridge.getMessages('create_svg').find(m => m.payload.name === 'Plot');
    assert.ok(svgMsg, 'should create the plot SVG');
    assert.ok(!svgMsg.payload.svgString.includes('stroke'), 'SVG must not use stroke-based lines');
  });

  it('runs the post-import binding pass and binds every vector child to a DS variable', async () => {
    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'line',
      title: 'Signups',
      data: [
        { label: 'Jan', value: 10 }, { label: 'Feb', value: 25 }, { label: 'Mar', value: 18 },
      ],
      dimensions: { plotWidth: 300, plotHeight: 150 },
    });

    const svgMsg = bridge.getMessages('create_svg').find(m => m.payload.name === 'Plot');
    const expectedTagCount = (svgMsg.payload.svgString.match(/<(polygon|path|circle)\b/g) || []).length;
    assert.ok(expectedTagCount > 0, 'test SVG should contain drawable elements');

    const fillMsgs = bridge.getMessages('set_node_fill');
    assert.strictEqual(fillMsgs.length, expectedTagCount, 'every unbound vector child must go through set_node_fill');

    for (const msg of fillMsgs) {
      assert.ok(msg.payload.fillVariable, 'binding must use a DS variable, not a raw color');
      assert.ok(!msg.payload.fillVariable.startsWith('#'), 'bound fill must not be a hardcoded hex value');
    }
  });

  it('warns explicitly when create_svg reports fewer unbound children than expected (nothing fails silently)', async () => {
    bridge.setResponse('create_svg', (payload) => {
      const full = autoUnboundSvgResponse(payload);
      // Simulate the plugin only reporting back a subset of the vectors —
      // some elements would otherwise be left with hardcoded fills.
      return { ...full, unboundChildren: full.unboundChildren.slice(0, 1) };
    });

    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'line',
      title: 'Signups',
      data: [
        { label: 'Jan', value: 10 }, { label: 'Feb', value: 25 }, { label: 'Mar', value: 18 },
      ],
      dimensions: { plotWidth: 300, plotHeight: 150 },
    });

    assert.ok(result.failures && result.failures.length > 0, 'should surface a warning, not fail silently');
    const messages = result.failures.map(f => f.error).join(' ');
    assert.ok(/unbound|hardcoded/i.test(messages), 'warning should call out the unbound/hardcoded risk');
  });
});

describe('chart.js — cornerRadiusVariable on legend dots (Bug 2)', () => {
  let handlers, bridge;

  beforeEach(() => {
    ({ handlers, bridge } = createTestContext());
    bridge.setResponse('create_svg', autoUnboundSvgResponse);
  });

  it('donut legend dots use cornerRadiusVariable, never radiusVariable', async () => {
    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'donut',
      title: 'Share',
      data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }],
      dimensions: { outerRadius: 80, innerRadius: 0.6 },
    });

    const dotMsgs = bridge.getMessages('create_rectangle').filter(m => m.payload.name.startsWith('Dot:'));
    assert.ok(dotMsgs.length > 0, 'should create legend dots');
    for (const msg of dotMsgs) {
      assert.strictEqual(msg.payload.radiusVariable, undefined, 'plugin does not understand radiusVariable');
      assert.strictEqual(msg.payload.cornerRadiusVariable, 'radius-full');
    }
  });

  it('shared legend (radar, multi-series) dots use cornerRadiusVariable, never radiusVariable', async () => {
    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'radar',
      title: 'Comparison',
      data: [
        { label: 'Speed', values: [3, 4] },
        { label: 'Power', values: [5, 2] },
        { label: 'Range', values: [2, 3] },
      ],
      seriesNames: ['Current', 'Target'],
      dimensions: { radius: 100 },
    });

    const dotMsgs = bridge.getMessages('create_rectangle').filter(m => m.payload.name.startsWith('Dot:'));
    assert.ok(dotMsgs.length > 0, 'should create legend dots');
    for (const msg of dotMsgs) {
      assert.strictEqual(msg.payload.radiusVariable, undefined, 'plugin does not understand radiusVariable');
      assert.strictEqual(msg.payload.cornerRadiusVariable, 'radius-full');
    }
  });
});

describe('chart.js — FALLBACK_COLORS excludes semantic colors (Bug 3)', () => {
  let handlers, bridge, dsCache;

  beforeEach(() => {
    ({ handlers, bridge, dsCache } = createTestContext());
    bridge.setResponse('create_svg', autoUnboundSvgResponse);
  });

  it('bar chart fallback palette never uses Brand/Success/Warning/Error colors', async () => {
    // Empty dsCache => dsCache.findPalette() returns null => FALLBACK_COLORS engages.
    assert.strictEqual(dsCache.findPalette(), null);

    await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: Array.from({ length: 10 }, (_, i) => ({ label: `M${i}`, value: (i + 1) * 10 })),
      dimensions: { chartHeight: 200 },
    });

    const barRects = bridge.getMessages('create_rectangle').filter(m => m.payload.name.startsWith('Value:'));
    assert.ok(barRects.length > 0, 'should create bar rectangles');
    for (const msg of barRects) {
      const color = (msg.payload.fillVariable || '').toLowerCase();
      for (const needle of SEMANTIC_NEEDLES) {
        assert.ok(!color.includes(needle), `bar fill "${color}" must not use semantic color "${needle}"`);
      }
    }
  });

  it('response carries a fallback note when the built-in palette engages with no caller-provided colors', async () => {
    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 20 }],
      dimensions: { chartHeight: 200 },
    });
    assert.ok(result._fallbackPaletteNote, 'should note that fallback colors were used and why');
  });

  it('does not add the fallback note when the caller passes explicit colors', async () => {
    const result = await handlers.mimic_build_chart({
      parentId: 'p-1',
      chartType: 'bar',
      title: 'Revenue',
      data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 20 }],
      dimensions: { chartHeight: 200 },
      colors: ['Component colors/Utility/Indigo/utility-indigo-500'],
    });
    assert.strictEqual(result._fallbackPaletteNote, undefined);
  });
});
