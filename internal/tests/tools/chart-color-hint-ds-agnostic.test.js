'use strict';

/**
 * Regression tests for audit finding B14 (DS-agnostic hardcoding):
 *
 * mimic_compute_chart's `_chartColorHint` used to hardcode LayerLens
 * Theme paths ('Component colors/Utility/Indigo/utility-indigo-500',
 * 'Colors/Border/border-secondary', 'Text xs/Medium') on EVERY call,
 * regardless of what DS was actually discovered. That's fine for
 * LayerLens itself but actively misleading (or binding-breaking) for
 * any other design system.
 *
 * Fixed behavior:
 *  - When the DS cache has real matches (palette / border variable /
 *    text-tertiary variable / xs-Medium text style), the hint is built
 *    from those actual cached values.
 *  - When the cache has no match for a given field (including the
 *    empty-cache / pre-discovery case), that field falls back to an
 *    INVENTED example value that does not resemble any real design
 *    system, and the field is listed in `_exampleFields` so the caller
 *    knows not to bind to it as if it were real.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DsCache } = require('../../../src/ds/cache');

function createTestContext() {
  const dsCache = new DsCache();
  const handlers = {};
  function registerTool(name, _description, _inputSchema, handler) {
    handlers[name] = handler;
  }
  const context = {
    registerTool,
    dsCache,
    session: { toolCallCount: 0 },
    knowledgeStore: { load() {}, data: {} },
    buildManifest: {},
    advancePhase() {},
    bridge: {},
  };
  require('../../../src/tools/learning').register(null, context);
  return { handlers, dsCache };
}

const CHART_ARGS = {
  chartType: 'bar',
  data: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }],
  dimensions: { chartHeight: 200 },
};

describe('mimic_compute_chart — _chartColorHint is DS-cache-first (B14)', () => {
  let handlers, dsCache;

  beforeEach(() => {
    ({ handlers, dsCache } = createTestContext());
  });

  it('with an empty DS cache (nothing discovered yet), every field is an invented example, clearly labeled', async () => {
    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;

    assert.ok(hint, 'should have a color hint');
    assert.ok(Array.isArray(hint.suggestedPalette) && hint.suggestedPalette.length >= 3);
    assert.ok(Array.isArray(hint._exampleFields), 'all fields should be flagged as examples with an empty cache');
    for (const field of ['suggestedPalette', 'gridColor', 'labelColor', 'dataLabelStyle']) {
      assert.ok(hint._exampleFields.includes(field), `${field} should be flagged as an example`);
    }
    assert.match(hint.message, /INVENTED EXAMPLE/i);
    assert.match(hint.message, /not.*real design system|not a path in your file/i);
  });

  it('never presents a real vendor DS name (LayerLens or otherwise) as a universal truth', async () => {
    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;
    const serialized = JSON.stringify(hint).toLowerCase();
    assert.ok(!serialized.includes('layerlens'), 'must not name a specific vendor DS');
    assert.ok(!serialized.includes('utility-'), 'must not use LayerLens-shaped utility- token names');
  });

  it('resolves suggestedPalette from the DS cache when a real palette is discovered', async () => {
    dsCache.addVariable('Data/chart-series-1', { key: 'v1', category: 'color', resolvedType: 'COLOR' });
    dsCache.addVariable('Data/chart-series-1-primary', { key: 'v1b', category: 'color', resolvedType: 'COLOR' });
    dsCache.addVariable('Data/chart-series-2-500', { key: 'v2', category: 'color', resolvedType: 'COLOR' });
    dsCache.addVariable('Data/chart-series-3-500', { key: 'v3', category: 'color', resolvedType: 'COLOR' });

    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;

    assert.deepStrictEqual(hint.suggestedPalette, dsCache.findPalette(8));
    assert.ok(!hint._exampleFields || !hint._exampleFields.includes('suggestedPalette'), 'palette should not be flagged as an example once resolved from the cache');
  });

  it('resolves gridColor from a real cached border/secondary variable', async () => {
    dsCache.addVariable('Border/divider-secondary', {
      key: 'v-border', category: 'border', resolvedType: 'COLOR', scopes: ['STROKE'],
    });

    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;

    assert.strictEqual(hint.gridColor, 'Border/divider-secondary');
    assert.ok(!hint._exampleFields || !hint._exampleFields.includes('gridColor'));
  });

  it('resolves dataLabelStyle from a real cached xs/Medium-equivalent text style', async () => {
    dsCache.addTextStyle('style-key-1', { name: 'Body XS/Medium' });

    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;

    assert.strictEqual(hint.dataLabelStyle, 'Body XS/Medium');
    assert.ok(!hint._exampleFields || !hint._exampleFields.includes('dataLabelStyle'));
  });

  it('mixes resolved and example fields when the cache only partially matches, and flags only the example ones', async () => {
    // Only a palette is discovered — grid/label/text-style stay examples.
    dsCache.addVariable('Data/chart-series-1-500', { key: 'v1', category: 'color', resolvedType: 'COLOR' });
    dsCache.addVariable('Data/chart-series-2-500', { key: 'v2', category: 'color', resolvedType: 'COLOR' });
    dsCache.addVariable('Data/chart-series-3-500', { key: 'v3', category: 'color', resolvedType: 'COLOR' });

    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;

    assert.ok(!hint._exampleFields.includes('suggestedPalette'), 'palette was resolved, should not be an example');
    assert.ok(hint._exampleFields.includes('gridColor'), 'gridColor had no match, should be an example');
    assert.ok(hint._exampleFields.includes('labelColor'), 'labelColor had no match, should be an example');
    assert.ok(hint._exampleFields.includes('dataLabelStyle'), 'dataLabelStyle had no match, should be an example');
    assert.match(hint.message, /NOTE:.*example/i);
  });

  it('colorRules always bans Brand/Success/Warning/Error regardless of cache state', async () => {
    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const hint = result._chartColorHint;
    assert.ok(hint.colorRules.some(r => r.includes('NEVER use Brand')));
  });

  it('_chartBuildRules guidance strings no longer bake in literal LayerLens token names', async () => {
    const result = await handlers.mimic_compute_chart(CHART_ARGS);
    const rules = result._chartBuildRules;
    const serialized = JSON.stringify(rules).toLowerCase();
    assert.ok(!serialized.includes('radius-xs'), 'should not prescribe a specific hardcoded radius token name');
    assert.ok(!serialized.includes('radius-full'), 'should not prescribe a specific hardcoded radius token name');
    assert.ok(!serialized.includes('spacing-xs'), 'should not prescribe a specific hardcoded spacing token name');
    assert.ok(!serialized.includes('spacing-xl'), 'should not prescribe a specific hardcoded spacing token name');
    assert.ok(!serialized.includes('border-secondary'), 'should not prescribe a specific hardcoded color token name');
    assert.ok(!serialized.includes('text-tertiary'), 'should not prescribe a specific hardcoded color token name');
  });
});
