'use strict';

/**
 * Structured per-library fingerprint capture + diff classification
 * (schema-v3-spec.md §4.1-4.3). Replaces the v2 string fingerprint
 * (name-list + style-count JSON) which could not distinguish a rename from
 * a remove+add, carried no variable data at all, and was never written on
 * the community/skipRestApi path (defects N, I; finding 3).
 *
 * This module is pure (no bridge/store calls) — callers (status.js) build
 * the fingerprint from the already-populated dsCache + knowledgeStore and
 * persist it via knowledgeStore.setStructuredFingerprint().
 */

const crypto = require('node:crypto');

// Icon heuristic (spec §4.1 elision rule): no "/", no space, no "=", and the
// whole name matches /^[a-z0-9-]+$/ — e.g. "help-octagon", "chevron-down".
// Real UI components/component-sets have structured names ("Buttons/Button",
// "Input field", "Size=md, Type=Default").
function isIconLikeName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return !n.includes('/') && !n.includes(' ') && !n.includes('=') && /^[a-z0-9-]+$/.test(n);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * Normalize a component's variantProperties (shape varies by source — an
 * array of {name, values} from the plugin's page-scan discover_library_
 * components, or absent entirely for REST-discovered components since the
 * Figma REST /components endpoint does not expose variant schemas — see
 * defect I) into a canonical sorted structure and hash it.
 *
 * Property TYPE (VARIANT|BOOLEAN|TEXT|INSTANCE_SWAP|SLOT) is included only
 * when the source data carries it. plugin/code.js's discover_library_
 * components handler now reads componentSet.componentPropertyDefinitions
 * (feature-detected — older Figma versions/component sets may not expose
 * it) and attaches a real `type` per property; the REST path still cannot
 * surface types (Figma's REST /components endpoint has no variant-schema
 * data at all), so `type` defaults to 'VARIANT' when values are present and
 * is absent otherwise. This default is intentionally a NO-OP for same-
 * source comparisons: a component whose properties were always genuinely
 * VARIANT hashes identically before and after the plugin gained type
 * awareness (default 'VARIANT' === real 'VARIANT'), while a real VARIANT ->
 * SLOT/BOOLEAN migration changes the hash because the newly-observed type
 * differs from the old default. Cross-source (REST <-> page_scan)
 * comparisons never reach this level of detail — diffFingerprints reports
 * a source change instead of diffing component-by-component — so the
 * REST-side "no types ever" limitation can't produce a false positive
 * against a typed page_scan capture.
 *
 * @returns {string|null}
 */
function computeVariantSchemaHash(variantProperties) {
  if (!variantProperties) return null;
  let entries;
  if (Array.isArray(variantProperties)) {
    if (variantProperties.length === 0) return null;
    entries = variantProperties.map((vp) => [
      vp.name,
      {
        type: vp.type || 'VARIANT',
        values: [...(vp.values || [])].map(String).sort(),
        default: vp.default ?? null,
      },
    ]);
  } else if (typeof variantProperties === 'object') {
    const keys = Object.keys(variantProperties);
    if (keys.length === 0) return null;
    entries = keys.map((name) => {
      const vp = variantProperties[name] || {};
      return [
        name,
        {
          type: vp.type || 'VARIANT',
          values: [...(vp.values || [])].map(String).sort(),
          default: vp.default ?? vp.current ?? null,
        },
      ];
    });
  } else {
    return null;
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify(entries));
}

/**
 * Build the structured per-library fingerprint (spec §4.1) from the current
 * dsCache + the active library's knowledge recipes (for the icon-elision
 * "referenced by a recipe" check).
 *
 * @param {{ dsCache: import('./cache').DsCache, knowledgeStore: import('../knowledge/store').KnowledgeStore, source: 'rest'|'page_scan'|'external_variables', restFreshness?: object }} opts
 */
function buildStructuredFingerprint({ dsCache, knowledgeStore, source, restFreshness }) {
  const referencedKeys = new Set();
  for (const recipe of Object.values(knowledgeStore?.data?.components || {})) {
    if (recipe.componentKey) referencedKeys.add(recipe.componentKey);
  }

  const components = {};
  for (const [key, comp] of dsCache.components) {
    const name = comp.name || '';
    const elide = isIconLikeName(name) && !referencedKeys.has(key);
    components[key] = {
      n: elide ? null : name,
      s: comp.componentSetKey || comp.setKey || null,
      v: computeVariantSchemaHash(comp.variantProperties),
    };
  }

  const styles = {};
  for (const [key, style] of dsCache.textStyles) styles[key] = style.name || null;
  for (const [key, style] of dsCache.fillStyles) styles[key] = style.name || null;
  for (const [key, style] of dsCache.effectStyles) styles[key] = style.name || null;

  const variables = {};
  for (const [path, info] of dsCache.variables) {
    const variableKey = info.key || path;
    variables[variableKey] = {
      p: path,
      t: info.resolvedType || null,
      // `c` must be an ID-shaped identifier so it can be meaningfully
      // compared against `rc` (rootVariableCollectionId) below — a display
      // NAME (e.g. "Colors") would never equal a collection id/key, making
      // the override-detection comparison always-true false positives.
      // `info.collectionKey` (the variable's own home collection id, set by
      // the extended-collections discovery path — plugin/code.js's
      // discover_library_variables + status.js's caching of it) is the
      // correct source; fall back to the display name only for older/
      // externally-injected variable entries that predate this field, where
      // `rc` will also be absent so the comparison never fires anyway.
      c: info.collectionKey || info.collection || null,
      rc: info.rootVariableCollectionId || null,
    };
  }

  const fingerprint = {
    capturedAt: new Date().toISOString(),
    source: source || 'page_scan',
    restFreshness: restFreshness || null,
    components,
    styles,
    variables,
  };
  fingerprint.hash = sha256({ components, styles, variables });
  return fingerprint;
}

/**
 * Classify differences between a previously-stored fingerprint and a freshly
 * captured one (spec §4.3). Only compares fingerprints of the same `source`
 * class — a source change (rest <-> page_scan) is reported as an
 * informational note, never as mass component changes (fixes defect N /
 * acceptance 12).
 */
function diffFingerprints(prev, curr) {
  if (!prev) return { firstCapture: true, sourceChanged: false, unchanged: false, componentDiffs: [], styleDiffs: [], variableDiffs: [] };
  if (prev.source && curr.source && prev.source !== curr.source) {
    return {
      firstCapture: false,
      sourceChanged: true,
      prevSource: prev.source,
      currSource: curr.source,
      unchanged: false,
      componentDiffs: [],
      styleDiffs: [],
      variableDiffs: [],
    };
  }
  if (prev.hash && curr.hash && prev.hash === curr.hash) {
    return { firstCapture: false, sourceChanged: false, unchanged: true, componentDiffs: [], styleDiffs: [], variableDiffs: [] };
  }

  const componentDiffs = [];
  const prevComponents = prev.components || {};
  const currComponents = curr.components || {};
  const allComponentKeys = new Set([...Object.keys(prevComponents), ...Object.keys(currComponents)]);
  for (const key of allComponentKeys) {
    const p = prevComponents[key];
    const c = currComponents[key];
    if (p && !c) {
      componentDiffs.push({ type: 'component_removed', key, name: p.n });
    } else if (!p && c) {
      componentDiffs.push({ type: 'component_added', key, name: c.n });
    } else if (p && c) {
      if (p.n && c.n && p.n !== c.n) {
        componentDiffs.push({ type: 'renamed', key, oldName: p.n, newName: c.n });
      }
      if (p.v && c.v && p.v !== c.v) {
        componentDiffs.push({ type: 'variant_schema_changed', key, name: c.n || p.n || key });
      }
    }
  }

  const styleDiffs = [];
  const prevStyles = prev.styles || {};
  const currStyles = curr.styles || {};
  for (const key of new Set([...Object.keys(prevStyles), ...Object.keys(currStyles)])) {
    const p = prevStyles[key];
    const c = currStyles[key];
    if (p !== undefined && c === undefined) styleDiffs.push({ type: 'style_removed', key, name: p });
    else if (p === undefined && c !== undefined) styleDiffs.push({ type: 'style_added', key, name: c });
    else if (p !== c && p && c) styleDiffs.push({ type: 'renamed', key, oldName: p, newName: c });
  }

  const variableDiffs = [];
  const prevVars = prev.variables || {};
  const currVars = curr.variables || {};
  for (const key of new Set([...Object.keys(prevVars), ...Object.keys(currVars)])) {
    const p = prevVars[key];
    const c = currVars[key];
    if (p && !c) {
      variableDiffs.push({ type: 'variable_removed', key, path: p.p });
    } else if (!p && c) {
      // A variable key whose root collection differs from its own collection
      // is an extension override on an existing token, not a new root
      // variable (spec §4.1).
      if (c.rc && c.c && c.rc !== c.c) {
        variableDiffs.push({ type: 'variable_override_added', key, path: c.p });
      } else {
        variableDiffs.push({ type: 'variable_added', key, path: c.p });
      }
    } else if (p && c && p.p !== c.p) {
      variableDiffs.push({ type: 'token_renamed', key, oldPath: p.p, newPath: c.p });
    }
  }

  return { firstCapture: false, sourceChanged: false, unchanged: false, componentDiffs, styleDiffs, variableDiffs };
}

module.exports = { buildStructuredFingerprint, diffFingerprints, computeVariantSchemaHash, isIconLikeName };
