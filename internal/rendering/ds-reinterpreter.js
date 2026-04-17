/**
 * Mimic AI — DS Reinterpretation Layer
 *
 * Resolves raw CSS values (font sizes, colors, spacing) to the closest
 * DS-backed text style, color variable, or spacing token.
 *
 * This is NOT exact matching. This is interpretation.
 * For any raw value, the reinterpreter finds the best DS-backed option
 * based on semantic role, numerical proximity, and usage patterns.
 *
 * Does NOT modify resolver logic. Does NOT affect DS component matching.
 * Only affects FALLBACK PRIMITIVE rendering — making primitives DS-compliant.
 *
 * Usage:
 *   import { resolveTextStyle, resolveColorVariable, resolveSpacing } from './ds-reinterpreter.js';
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dir, '..', 'learning', 'RESOLUTION_RULES.json');
const KNOWLEDGE_PATH = resolve(__dir, '..', 'ds-knowledge', 'ds-knowledge-normalized.json');

let _rules = null;
let _knowledge = null;

function loadRules() {
  if (_rules) return _rules;
  if (!existsSync(RULES_PATH)) return null;
  try { _rules = JSON.parse(readFileSync(RULES_PATH, 'utf8')); return _rules; } catch { return null; }
}

function loadKnowledge() {
  if (_knowledge) return _knowledge;
  if (!existsSync(KNOWLEDGE_PATH)) return null;
  try { _knowledge = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8')); return _knowledge; } catch { return null; }
}


// ═══════════════════════════════════════════════════════════════════════════
// TEXT STYLE REINTERPRETATION
// ═══════════════════════════════════════════════════════════════════════════

// Text size tiers — built dynamically from DS knowledge when available.
// Falls back to standard scale if no DS knowledge exists.
var _textSizeMap = null;

function getTextSizeMap() {
  if (_textSizeMap) return _textSizeMap;

  // Try to derive from DS knowledge (style names contain size info)
  var knowledge = loadKnowledge();
  if (knowledge) {
    var textStyles = knowledge.styles.filter(function(s) { return s.category === 'typography'; });
    var tierMap = {};
    for (var i = 0; i < textStyles.length; i++) {
      var s = textStyles[i];
      // Extract tier from name like "Text sm/Bold" → "Text sm"
      var parts = s.name.split('/');
      if (parts.length >= 2) {
        var tier = parts[0].trim();
        // Extract approx px from style description or infer from tier name pattern
        if (!tierMap[tier] && s.description) {
          var sizeMatch = s.description.match(/(\d+)/);
          if (sizeMatch) tierMap[tier] = parseInt(sizeMatch[1]);
        }
      }
    }
    // If we found tiers with sizes, use them
    var derived = Object.keys(tierMap).map(function(t) { return { tier: t, approxPx: tierMap[t] }; });
    if (derived.length >= 4) {
      _textSizeMap = derived.sort(function(a, b) { return a.approxPx - b.approxPx; });
      return _textSizeMap;
    }
  }

  // Fallback: derive tiers from actual DS style names if possible
  // This works for any DS — it extracts the naming pattern from available styles
  const dsKnowledge = loadKnowledge();
  if (dsKnowledge?.styles) {
    const textStyles = dsKnowledge.styles.filter(s => s.category === 'typography');
    if (textStyles.length > 0) {
      // Extract unique tier prefixes (everything before the "/" in "Text sm/Regular")
      const tierSizes = {};
      for (const s of textStyles) {
        const parts = s.name.split('/');
        if (parts.length >= 2) {
          const tier = parts[0].trim();
          // Try to infer size from the style name or from actual fontSize if available
          if (!tierSizes[tier]) tierSizes[tier] = [];
          tierSizes[tier].push(s);
        }
      }
      // Build map from tier names — if we can't determine sizes, use name-order heuristic
      const tiers = Object.keys(tierSizes).sort();
      if (tiers.length > 0) {
        _textSizeMap = tiers.map((tier, i) => ({
          tier,
          approxPx: 10 + (i * 4), // rough approximation by order; overridden by DS knowledge when available
        }));
        return _textSizeMap;
      }
    }
  }

  // Last resort: common convention (Text/Display naming from Untitled UI)
  // This is a best-guess for DSs that follow this common pattern
  _textSizeMap = [
    { tier: 'Text xs',     approxPx: 12 },
    { tier: 'Text sm',     approxPx: 14 },
    { tier: 'Text md',     approxPx: 16 },
    { tier: 'Text lg',     approxPx: 18 },
    { tier: 'Display xs',  approxPx: 24 },
    { tier: 'Display sm',  approxPx: 30 },
    { tier: 'Display md',  approxPx: 36 },
    { tier: 'Display lg',  approxPx: 48 },
  ];
  return _textSizeMap;
}

const WEIGHT_MAP = {
  300: 'Regular',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Bold',
};

/**
 * Resolve a raw fontSize + fontWeight to the closest DS text style.
 *
 * @param {number} fontSize — raw pixel size
 * @param {number} fontWeight — raw CSS weight (400, 500, 600, 700)
 * @returns {Object} { styleKey, styleName, confidence, method }
 */
export function resolveTextStyle(fontSize, fontWeight = 400) {
  const knowledge = loadKnowledge();
  if (!knowledge) return { styleKey: null, styleName: null, confidence: 0, method: 'no_knowledge' };

  const allStyles = knowledge.styles.filter(s => s.category === 'typography');
  if (allStyles.length === 0) return { styleKey: null, styleName: null, confidence: 0, method: 'no_styles' };

  // Find closest size tier (dynamic from DS or fallback)
  var sizeMap = getTextSizeMap();
  let bestTier = sizeMap[0];
  let bestDist = Infinity;
  for (const tier of sizeMap) {
    const dist = Math.abs(tier.approxPx - fontSize);
    if (dist < bestDist) { bestDist = dist; bestTier = tier; }
  }

  // Map weight to style suffix
  const weightName = WEIGHT_MAP[fontWeight] || 'Regular';

  // Build target style name: "Text sm/Bold", "Display lg/Regular", etc.
  const targetName = `${bestTier.tier}/${weightName}`;

  // Exact match first
  const exact = allStyles.find(s => s.name === targetName);
  if (exact) {
    return { styleKey: exact.key, styleName: exact.name, confidence: bestDist <= 1 ? 1.0 : 0.8, method: 'exact' };
  }

  // Fuzzy: same tier, any weight
  const sameTier = allStyles.filter(s => s.name.startsWith(bestTier.tier + '/'));
  if (sameTier.length > 0) {
    // Prefer Regular > Medium > Semibold > Bold (closest to target weight)
    const weightOrder = ['Regular', 'Medium', 'Semibold', 'Bold'];
    const targetIdx = weightOrder.indexOf(weightName);
    let bestMatch = sameTier[0];
    let bestWeightDist = Infinity;
    for (const s of sameTier) {
      const suffix = s.name.split('/')[1]?.trim();
      // Skip underlined/italic variants for primary text
      if (suffix?.includes('underlined') || suffix?.includes('italic') || suffix?.includes('List')) continue;
      const idx = weightOrder.indexOf(suffix);
      if (idx >= 0) {
        const dist = Math.abs(idx - targetIdx);
        if (dist < bestWeightDist) { bestWeightDist = dist; bestMatch = s; }
      }
    }
    return { styleKey: bestMatch.key, styleName: bestMatch.name, confidence: 0.7, method: 'tier_match' };
  }

  return { styleKey: null, styleName: null, confidence: 0, method: 'no_match' };
}


// ═══════════════════════════════════════════════════════════════════════════
// COLOR VARIABLE REINTERPRETATION
// ═══════════════════════════════════════════════════════════════════════════

// Semantic color roles based on typical DS patterns
const SEMANTIC_COLORS = {
  // Dark text colors (high contrast on light background)
  'text-primary':    { r: 0.059, g: 0.09, b: 0.165 },   // ~#0F172A (gray-900)
  'text-secondary':  { r: 0.2, g: 0.255, b: 0.333 },     // ~#334155 (gray-700)
  'text-tertiary':   { r: 0.278, g: 0.337, b: 0.412 },   // ~#475569 (gray-600)
  'text-quaternary': { r: 0.39, g: 0.455, b: 0.545 },     // ~#64748B (gray-500)
};

// Known DS variable keys from RESOLUTION_RULES
const KNOWN_VARIABLES = {};

function loadKnownVariables() {
  const rules = loadRules();
  if (!rules) return;
  const spec3 = rules.ds_mappings?.find(r => r.id === 'DS-SPEC-003');
  if (spec3?.variables) {
    for (const [name, key] of Object.entries(spec3.variables)) {
      KNOWN_VARIABLES[name] = key;
    }
  }
}

/**
 * Resolve a raw RGB color to the closest DS semantic color variable.
 *
 * @param {Object} color — { r, g, b } in 0-1 range
 * @param {string} role — 'text', 'fill', 'stroke', 'background'
 * @returns {Object} { variableName, variableKey, confidence, method }
 */
export function resolveColorVariable(color, role = 'text') {
  loadKnownVariables();

  if (!color) return { variableName: null, variableKey: null, confidence: 0, method: 'no_color' };

  // For text role, match against semantic text colors
  if (role === 'text') {
    let bestName = null;
    let bestDist = Infinity;

    for (const [name, ref] of Object.entries(SEMANTIC_COLORS)) {
      const dist = colorDistance(color, ref);
      if (dist < bestDist) { bestDist = dist; bestName = name; }
    }

    if (bestName && bestDist < 0.3) {
      const key = KNOWN_VARIABLES[bestName] || null;
      const confidence = bestDist < 0.05 ? 1.0 : bestDist < 0.15 ? 0.8 : 0.6;
      return { variableName: bestName, variableKey: key, confidence, method: key ? 'semantic_match' : 'semantic_match_no_key' };
    }
  }

  // White/near-white → likely background, use 'white' or skip
  if (color.r > 0.95 && color.g > 0.95 && color.b > 0.95) {
    return { variableName: 'bg-primary', variableKey: null, confidence: 0.5, method: 'near_white' };
  }

  // Very dark → text-primary
  if (color.r < 0.15 && color.g < 0.15 && color.b < 0.2) {
    const key = KNOWN_VARIABLES['text-primary'] || null;
    return { variableName: 'text-primary', variableKey: key, confidence: 0.7, method: key ? 'dark_text' : 'dark_text_no_key' };
  }

  return { variableName: null, variableKey: null, confidence: 0, method: 'no_match' };
}

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}


// ═══════════════════════════════════════════════════════════════════════════
// SPACING REINTERPRETATION
// ═══════════════════════════════════════════════════════════════════════════

const SPACING_SCALE = [];

// Standard DS spacing token names — the plugin's getVariableByPath resolves these
// We define the full expected scale; only tokens that exist in the DS will resolve
const STANDARD_SPACING = [
  { name: 'spacing-none', px: 0 },
  { name: 'spacing-xxs', px: 2 },
  { name: 'spacing-xs', px: 4 },
  { name: 'spacing-sm', px: 6 },
  { name: 'spacing-md', px: 8 },
  { name: 'spacing-lg', px: 12 },
  { name: 'spacing-xl', px: 16 },
  { name: 'spacing-2xl', px: 20 },
  { name: 'spacing-3xl', px: 24 },
  { name: 'spacing-4xl', px: 32 },
  { name: 'spacing-5xl', px: 40 },
  { name: 'spacing-6xl', px: 48 },
  { name: 'spacing-7xl', px: 64 },
  { name: 'spacing-8xl', px: 80 },
];

function loadSpacingScale() {
  if (SPACING_SCALE.length > 0) return;

  // Load known tokens from rules first (these have confirmed keys)
  const rules = loadRules();
  const knownKeys = {};
  if (rules) {
    const spec1 = rules.ds_mappings?.find(r => r.id === 'DS-SPEC-001');
    if (spec1?.values) {
      for (const [name, data] of Object.entries(spec1.values)) {
        knownKeys[name] = data.key;
      }
    }
  }

  // Build scale from standard spacing, enriched with known keys
  for (const token of STANDARD_SPACING) {
    SPACING_SCALE.push({
      name: token.name,
      px: token.px,
      key: knownKeys[token.name] || null,
    });
  }
  SPACING_SCALE.sort((a, b) => a.px - b.px);
}

/**
 * Resolve a raw pixel spacing value to the closest DS spacing token.
 *
 * @param {number} px — raw pixel value
 * @returns {Object} { tokenName, tokenKey, tokenPx, confidence, method }
 */
export function resolveSpacing(px) {
  loadSpacingScale();
  if (SPACING_SCALE.length === 0) return { tokenName: null, tokenKey: null, tokenPx: null, confidence: 0, method: 'no_scale' };

  let best = SPACING_SCALE[0];
  let bestDist = Infinity;
  for (const token of SPACING_SCALE) {
    const dist = Math.abs(token.px - px);
    if (dist < bestDist) { bestDist = dist; best = token; }
  }

  const confidence = bestDist === 0 ? 1.0 : bestDist <= 2 ? 0.8 : bestDist <= 4 ? 0.6 : 0.3;
  return { tokenName: best.name, tokenKey: best.key, tokenPx: best.px, confidence, method: bestDist === 0 ? 'exact' : 'nearest' };
}


// ═══════════════════════════════════════════════════════════════════════════
// BATCH REINTERPRETATION FOR BUILD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reinterpret a full set of build parameters for a text node.
 * Returns DS-backed params that should replace raw values.
 *
 * @param {Object} params — raw build params { fontSize, fontWeight, fills, fillHex }
 * @returns {Object} { textStyleId, fillVariable, reinterpretation }
 */
export function reinterpretTextParams(params) {
  loadKnownVariables(); // Ensure KNOWN_VARIABLES is populated before checking text-primary
  const result = { textStyleId: null, fillVariable: null, reinterpretation: [] };

  // Typography
  if (params.fontSize && !params.textStyleId) {
    const style = resolveTextStyle(params.fontSize, params.fontWeight || 400);
    if (style.styleKey && style.confidence >= 0.6) {
      result.textStyleId = style.styleKey;
      result.reinterpretation.push({
        type: 'typography',
        from: `${params.fontSize}px/${params.fontWeight || 400}`,
        to: style.styleName,
        confidence: style.confidence,
        method: style.method,
      });
    }
  }

  // Color — try DS variable first (covers gray text colors), then DS color style (covers accents)
  if (!params.fillVariable && !params.fillStyleKey) {
    let color = null;
    if (Array.isArray(params.fills) && params.fills[0]?.color) {
      color = params.fills[0].color;
    }
    if (color) {
      // Try color style (reliable via preload cache) — covers grays AND accents
      const styleResolved = resolveColorStyle(color);
      if (styleResolved.styleKey && styleResolved.confidence >= 0.6) {
        result.fillStyleKey = styleResolved.styleKey;
        result.reinterpretation.push({
          type: 'color',
          from: `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`,
          to: styleResolved.styleName,
          confidence: styleResolved.confidence,
          method: styleResolved.method,
        });
      }
    }
    // Default text with no explicit fill → use Gray 900 color style (matches text-primary)
    // Variable binding for text-primary often fails (library walk timeout).
    // Color style import is reliable when preloaded.
    if (!color && !params.fillHex && !params.fills && !result.fillVariable && !result.fillStyleKey) {
      // Resolve to the darkest gray style — same color as text-primary variable
      const styleResult = resolveColorStyle({ r: 0.059, g: 0.09, b: 0.165 });
      if (styleResult.styleKey) {
        result.fillStyleKey = styleResult.styleKey;
        result.reinterpretation.push({
          type: 'color',
          from: 'default_black',
          to: styleResult.styleName,
          confidence: 0.9,
          method: 'default_text_style',
        });
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// COLOR STYLE RESOLUTION (uses 990 color styles from DS knowledge)
// ═══════════════════════════════════════════════════════════════════════════

// Color style resolution uses dynamic DS knowledge — no hardcoded color values.
// The DS knowledge file (ds-knowledge-normalized.json) contains all color styles
// with their keys and names. Resolution matches raw RGB values to the closest
// DS style by computing color distance.
//
// For DSs that include resolved RGB values in their style descriptions,
// exact matching is possible. Otherwise, name-based heuristics are used.

let _colorStyleCache = null;

function buildColorStyleCache() {
  if (_colorStyleCache) return _colorStyleCache;
  const knowledge = loadKnowledge();
  if (!knowledge) return null;

  const colorStyles = knowledge.styles.filter(s => s.category === 'color');

  // Build lookup: style name → key
  const styleByName = {};
  for (const s of colorStyles) {
    styleByName[s.name] = s.key;
  }

  // Build reference map dynamically from all available color styles.
  // No hardcoded color values — the map is populated from DS knowledge only.
  // If the DS knowledge includes resolved RGB values (via description or metadata),
  // they are used for distance-based matching. Otherwise, name-based matching is used.
  const refMap = {};
  for (const s of colorStyles) {
    // Extract RGB from description if available (some DS extractors include hex values)
    const hexMatch = s.description?.match(/#([0-9a-fA-F]{6})/);
    if (hexMatch) {
      const hex = hexMatch[1];
      const r = parseInt(hex.substr(0, 2), 16) / 255;
      const g = parseInt(hex.substr(2, 2), 16) / 255;
      const b = parseInt(hex.substr(4, 2), 16) / 255;
      refMap[s.key] = { name: s.name, key: s.key, ref: { r, g, b } };
    }
  }

  _colorStyleCache = { styles: colorStyles, refMap, styleByName };
  return _colorStyleCache;
}

/**
 * Resolve a raw RGB color to the closest DS color STYLE.
 * Covers grays AND accent colors (blue, green, purple, orange).
 *
 * @param {Object} color — { r, g, b } in 0-1 range
 * @returns {Object} { styleKey, styleName, confidence, method }
 */
export function resolveColorStyle(color) {
  if (!color) return { styleKey: null, styleName: null, confidence: 0, method: 'no_color' };

  const cache = buildColorStyleCache();
  if (!cache) return { styleKey: null, styleName: null, confidence: 0, method: 'no_knowledge' };

  // Match against all reference colors (grays + accents)
  let bestKey = null;
  let bestName = null;
  let bestDist = Infinity;

  for (const [key, entry] of Object.entries(cache.refMap)) {
    const dist = colorDistance(color, entry.ref);
    if (dist < bestDist) { bestDist = dist; bestKey = key; bestName = entry.name; }
  }

  if (bestKey && bestDist < 0.1) {
    const confidence = bestDist < 0.02 ? 1.0 : bestDist < 0.05 ? 0.8 : 0.6;
    return { styleKey: bestKey, styleName: bestName, confidence, method: bestName.startsWith('Gray') ? 'gray_match' : 'accent_match' };
  }

  // Near-white — intentional, skip
  if (color.r > 0.97 && color.g > 0.97 && color.b > 0.97) {
    return { styleKey: null, styleName: null, confidence: 0, method: 'white_skip' };
  }

  return { styleKey: null, styleName: null, confidence: 0, method: 'no_match' };
}


/**
 * Reinterpret frame params for DS compliance.
 * Now resolves fills and strokes to DS COLOR STYLES (not variables).
 */
export function reinterpretFrameParams(params) {
  const result = { fillStyleKey: null, strokeStyleKey: null, fillVariable: null, strokeVariable: null, reinterpretation: [] };

  // Fill
  if (!params.fillVariable && !params.fillStyleKey && Array.isArray(params.fills) && params.fills.length > 0) {
    const color = params.fills[0]?.color;
    if (color) {
      // Try color style first (covers grays, borders, backgrounds)
      const styleResult = resolveColorStyle(color);
      if (styleResult.styleKey && styleResult.confidence >= 0.6) {
        result.fillStyleKey = styleResult.styleKey;
        result.reinterpretation.push({
          type: 'fill',
          from: `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`,
          to: styleResult.styleName,
          confidence: styleResult.confidence,
          method: styleResult.method,
        });
      }
    }
  }

  // Stroke
  if (!params.strokeVariable && !params.strokeStyleKey && Array.isArray(params.strokes) && params.strokes.length > 0) {
    const color = params.strokes[0]?.color;
    if (color) {
      const styleResult = resolveColorStyle(color);
      if (styleResult.styleKey && styleResult.confidence >= 0.6) {
        result.strokeStyleKey = styleResult.styleKey;
        result.reinterpretation.push({
          type: 'stroke',
          from: `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`,
          to: styleResult.styleName,
          confidence: styleResult.confidence,
          method: styleResult.method,
        });
      }
    }
  }

  // Spacing — resolve raw px values to DS token names (plugin resolves names to variables)
  const spacingFields = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'itemSpacing', 'gap'];
  result.spacing = {};
  for (const field of spacingFields) {
    if (typeof params[field] === 'number' && params[field] > 0) {
      const resolved = resolveSpacing(params[field]);
      if (resolved.tokenName && resolved.confidence >= 0.6) {
        result.spacing[field] = resolved.tokenName;
        result.reinterpretation.push({
          type: 'spacing',
          from: `${params[field]}px`,
          to: `${resolved.tokenName} (${resolved.tokenPx}px)`,
          confidence: resolved.confidence,
          method: resolved.method,
          field,
        });
      }
    }
  }

  // Corner radius — resolve to DS token if close match
  if (typeof params.cornerRadius === 'number' && params.cornerRadius > 0) {
    const resolved = resolveSpacing(params.cornerRadius); // reuse spacing scale for radius
    if (resolved.tokenName && resolved.confidence >= 0.8) {
      result.cornerRadius = resolved.tokenName;
      result.reinterpretation.push({
        type: 'radius',
        from: `${params.cornerRadius}px`,
        to: `${resolved.tokenName} (${resolved.tokenPx}px)`,
        confidence: resolved.confidence,
        method: resolved.method,
      });
    }
  }

  return result;
}
