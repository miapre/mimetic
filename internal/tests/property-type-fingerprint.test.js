'use strict';

/**
 * Tests for the property-type -> fingerprint handoff (worker task 2) and
 * the extended-variable-collections override classification (worker task
 * 3): src/ds/fingerprint.js's computeVariantSchemaHash/buildStructuredFingerprint/
 * diffFingerprints, plus plugin/code.js's discover_library_components now
 * surfacing componentPropertyDefinitions types (VARIANT|BOOLEAN|TEXT|
 * INSTANCE_SWAP|SLOT) via the real handler.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeVariantSchemaHash,
  buildStructuredFingerprint,
  diffFingerprints,
} = require('../../src/ds/fingerprint');
const { DsCache } = require('../../src/ds/cache');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { createFigmaStub, loadPlugin } = require('./helpers/figma-stub');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-fp-'));
  return new KnowledgeStore(path.join(dir, 'ds-knowledge.json'));
}

describe('computeVariantSchemaHash — property type inclusion', () => {
  it('same name/values but a different type produces a different hash (VARIANT -> SLOT)', () => {
    const asVariant = [{ name: 'Content', values: [], type: 'VARIANT' }];
    const asSlot = [{ name: 'Content', values: [], type: 'SLOT' }];
    assert.notEqual(computeVariantSchemaHash(asVariant), computeVariantSchemaHash(asSlot));
  });

  it('VARIANT -> BOOLEAN also changes the hash', () => {
    const asVariant = [{ name: 'Icon', values: ['Yes', 'No'], type: 'VARIANT' }];
    const asBoolean = [{ name: 'Icon', values: [], type: 'BOOLEAN' }];
    assert.notEqual(computeVariantSchemaHash(asVariant), computeVariantSchemaHash(asBoolean));
  });

  it('identical type + values produces an identical hash (stability)', () => {
    const a = [{ name: 'Size', values: ['Small', 'Large'], type: 'VARIANT' }];
    const b = [{ name: 'Size', values: ['Large', 'Small'], type: 'VARIANT' }]; // order-insensitive
    assert.equal(computeVariantSchemaHash(a), computeVariantSchemaHash(b));
  });

  it('REST-untyped stability: an entry with NO type field hashes identically to one explicitly typed VARIANT', () => {
    // Figma's REST /components endpoint never carries property types — the
    // REST-derived path passes variantProperties entries with no `type` key
    // at all. computeVariantSchemaHash must default the absent type to
    // 'VARIANT' so this never registers as a schema change relative to a
    // plugin-side (page_scan) capture of a genuinely VARIANT property.
    const untyped = [{ name: 'Hierarchy', values: ['Primary', 'Secondary'] }];
    const typedVariant = [{ name: 'Hierarchy', values: ['Primary', 'Secondary'], type: 'VARIANT' }];
    assert.equal(computeVariantSchemaHash(untyped), computeVariantSchemaHash(typedVariant));
  });

  it('REST-untyped stability holds across repeated REST-only captures (no drift over time)', () => {
    const restCapture1 = [{ name: 'Color', values: ['Success', 'Gray'] }];
    const restCapture2 = [{ name: 'Color', values: ['Gray', 'Success'] }];
    assert.equal(computeVariantSchemaHash(restCapture1), computeVariantSchemaHash(restCapture2));
  });
});

describe('buildStructuredFingerprint + diffFingerprints — variant_schema_changed via type', () => {
  it('registers variant_schema_changed when a property migrates VARIANT -> SLOT across two page_scan captures', () => {
    const dsCache = new DsCache();
    const knowledgeStore = tmpStore();

    dsCache.addComponent('card-key', {
      name: 'Card',
      variantProperties: [{ name: 'Content', values: ['A', 'B'], type: 'VARIANT' }],
    });
    const before = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    dsCache.clear();
    dsCache.addComponent('card-key', {
      name: 'Card',
      variantProperties: [{ name: 'Content', values: [], type: 'SLOT' }],
    });
    const after = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    const diff = diffFingerprints(before, after);
    assert.equal(diff.sourceChanged, false);
    assert.ok(diff.componentDiffs.some((d) => d.type === 'variant_schema_changed' && d.key === 'card-key'));
  });

  it('does NOT register variant_schema_changed for an unrelated REST-only recapture of the same VARIANT property', () => {
    const dsCache = new DsCache();
    const knowledgeStore = tmpStore();

    dsCache.addComponent('card-key', { name: 'Card', variantProperties: [{ name: 'Size', values: ['Small', 'Large'] }] });
    const before = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'rest' });

    dsCache.clear();
    dsCache.addComponent('card-key', { name: 'Card', variantProperties: [{ name: 'Size', values: ['Large', 'Small'] }] });
    const after = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'rest' });

    const diff = diffFingerprints(before, after);
    assert.equal(diff.unchanged, true);
  });
});

describe('diffFingerprints — variable_override_added (extended variable collections)', () => {
  it('classifies a NEW variable whose rootVariableCollectionId differs from its own collectionKey as an override, not a new root variable', () => {
    const dsCache = new DsCache();
    const knowledgeStore = tmpStore();
    const before = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    dsCache.addVariable('Colors/brand-primary', {
      key: 'var-key-1',
      resolvedType: 'COLOR',
      collectionKey: 'ext-collection-key',
      rootVariableCollectionId: 'root-collection-key',
    });
    const after = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    const diff = diffFingerprints(before, after);
    assert.ok(diff.variableDiffs.some((d) => d.type === 'variable_override_added' && d.path === 'Colors/brand-primary'));
    assert.ok(!diff.variableDiffs.some((d) => d.type === 'variable_added'));
  });

  it('classifies a NEW variable whose rootVariableCollectionId equals its own collectionKey as an ordinary variable_added (not extended)', () => {
    const dsCache = new DsCache();
    const knowledgeStore = tmpStore();
    const before = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    dsCache.addVariable('Colors/brand-primary', {
      key: 'var-key-1',
      resolvedType: 'COLOR',
      collectionKey: 'collection-key',
      rootVariableCollectionId: 'collection-key',
    });
    const after = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    const diff = diffFingerprints(before, after);
    assert.ok(diff.variableDiffs.some((d) => d.type === 'variable_added'));
    assert.ok(!diff.variableDiffs.some((d) => d.type === 'variable_override_added'));
  });

  it('classifies a NEW variable with no rootVariableCollectionId at all (non-extended, older discovery) as variable_added', () => {
    const dsCache = new DsCache();
    const knowledgeStore = tmpStore();
    const before = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    dsCache.addVariable('Colors/brand-primary', { key: 'var-key-1', resolvedType: 'COLOR', collection: 'Colors' });
    const after = buildStructuredFingerprint({ dsCache, knowledgeStore, source: 'page_scan' });

    const diff = diffFingerprints(before, after);
    assert.ok(diff.variableDiffs.some((d) => d.type === 'variable_added'));
  });
});

describe('plugin/code.js — handlers.discover_library_components: property types (real handler)', () => {
  it('surfaces componentPropertyDefinitions types on the page-scan component list', async () => {
    const registry = new Map();
    const stub = createFigmaStub({ registry });
    const plugin = loadPlugin(stub);

    // Build a component-set-backed instance directly on the page, since
    // discover_library_components scans figma.currentPage.findAll for
    // INSTANCE nodes (not the componentMap/componentSet maps used by
    // insert_component).
    const { FigmaNodeStub } = require('./helpers/figma-stub');
    const compSet = new FigmaNodeStub('COMPONENT_SET', registry);
    compSet.name = 'Card';
    compSet.key = 'card-set-key';
    compSet.variantGroupProperties = { Size: { values: ['Small', 'Large'] } };
    compSet.componentPropertyDefinitions = {
      'Size': { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
      'Show footer': { type: 'BOOLEAN', defaultValue: false },
      'Content#12:9': { type: 'SLOT' },
    };
    const mainComp = new FigmaNodeStub('COMPONENT', registry);
    mainComp.name = 'Card, Size=Small';
    mainComp.key = 'card-small-key';
    mainComp.parent = compSet;
    compSet.appendChild(mainComp);

    const instance = new FigmaNodeStub('INSTANCE', registry);
    instance.mainComponent = mainComp;
    stub._page.appendChild(instance);

    const result = await plugin.handlers.discover_library_components({});
    const card = result.components.find((c) => c.key === 'card-set-key');
    assert.ok(card, 'Card component-set should be discovered');

    const byName = Object.fromEntries(card.variantProperties.map((p) => [p.name, p]));
    assert.equal(byName.Size.type, 'VARIANT');
    assert.deepEqual(byName.Size.values, ['Small', 'Large']);
    assert.equal(byName['Show footer'].type, 'BOOLEAN');
    assert.deepEqual(byName['Show footer'].values, []);
    assert.equal(byName.Content.type, 'SLOT');
  });

  it('defaults to VARIANT when componentPropertyDefinitions is unavailable (older Figma version / component)', async () => {
    const registry = new Map();
    const stub = createFigmaStub({ registry });
    const plugin = loadPlugin(stub);
    const { FigmaNodeStub } = require('./helpers/figma-stub');

    const compSet = new FigmaNodeStub('COMPONENT_SET', registry);
    compSet.name = 'Button';
    compSet.key = 'button-set-key';
    compSet.variantGroupProperties = { Hierarchy: { values: ['Primary', 'Secondary'] } };
    // No componentPropertyDefinitions on this stub — simulates an older
    // Figma version/component that doesn't expose it.
    const mainComp = new FigmaNodeStub('COMPONENT', registry);
    mainComp.name = 'Button, Hierarchy=Primary';
    mainComp.key = 'button-primary-key';
    mainComp.parent = compSet;
    compSet.appendChild(mainComp);

    const instance = new FigmaNodeStub('INSTANCE', registry);
    instance.mainComponent = mainComp;
    stub._page.appendChild(instance);

    const result = await plugin.handlers.discover_library_components({});
    const button = result.components.find((c) => c.key === 'button-set-key');
    assert.equal(button.variantProperties[0].type, 'VARIANT');
  });
});
