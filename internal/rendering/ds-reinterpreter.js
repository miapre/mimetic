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

// DS text style size tiers (from style names):
// xxs ≈ 10px, xs ≈ 12px, sm ≈ 14px, md ≈ 16px, lg ≈ 18px, xl ≈ 20px
// Display: xs ≈ 24px, sm ≈ 30px, md ≈ 36px, lg ≈ 48px, xl ≈ 60px, 2xl ≈ 72px
const TEXT_SIZE_MAP = [
  { tier: 'Text xxs',    approxPx: 10 },
  { tier: 'Text xs',     approxPx: 12 },
  { tier: 'Text sm',     approxPx: 14 },
  { tier: 'Text md',     approxPx: 16 },
  { tier: 'Text lg',     approxPx: 18 },
  { tier: 'Text xl',     approxPx: 20 },
  { tier: 'Display xs',  approxPx: 24 },
  { tier: 'Display sm',  approxPx: 30 },
  { tier: 'Display md',  approxPx: 36 },
  { tier: 'Display lg',  approxPx: 48 },
  { tier: 'Display xl',  approxPx: 60 },
  { tier: 'Display 2xl', approxPx: 72 },
];

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

  // Find closest size tier
  let bestTier = TEXT_SIZE_MAP[0];
  let bestDist = Infinity;
  for (const tier of TEXT_SIZE_MAP) {
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
      // Resolve to Gray (light mode)/900 style — same color as text-primary variable
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

// Build a color lookup from known gray scale values in the DS
// These are the most commonly used fills/strokes in product UI
const GRAY_SCALE_STYLES = {
  // Gray light mode — mapped from typical Tailwind/DS gray scale RGB values
  '50':  { r: 0.973, g: 0.98, b: 0.988 },   // #F8FAFC
  '100': { r: 0.945, g: 0.957, b: 0.969 },   // #F1F5F9
  '200': { r: 0.886, g: 0.91, b: 0.941 },    // #E2E8F0
  '300': { r: 0.796, g: 0.835, b: 0.882 },   // #CBD5E1
  '400': { r: 0.58, g: 0.64, b: 0.72 },      // #94A3B8
  '500': { r: 0.39, g: 0.455, b: 0.545 },     // #64748B
  '600': { r: 0.278, g: 0.337, b: 0.412 },    // #475569
  '700': { r: 0.2, g: 0.255, b: 0.333 },      // #334155
  '800': { r: 0.118, g: 0.161, b: 0.231 },    // #1E293B
  '900': { r: 0.059, g: 0.09, b: 0.165 },     // #0F172A
};

// Accent color reference values — mapped from common CSS accent scales
const ACCENT_SCALE_STYLES = {
  // Blue light (Tailwind blue)
  'Blue light/50':  { r: 0.937, g: 0.965, b: 1.0 },     // #EFF6FF
  'Blue light/100': { r: 0.859, g: 0.929, b: 0.996 },    // #DBEAFE
  'Blue light/600': { r: 0.145, g: 0.388, b: 0.921 },    // #2563EB
  'Blue light/700': { r: 0.114, g: 0.306, b: 0.847 },    // #1D4ED8
  // Brand (primary blue)
  'Brand/600':      { r: 0.145, g: 0.388, b: 0.921 },    // #2563EB
  'Brand/700':      { r: 0.114, g: 0.306, b: 0.847 },    // #1D4ED8
  // Green
  'Green/50':       { r: 0.941, g: 0.992, b: 0.957 },    // #F0FDF4
  'Green/100':      { r: 0.863, g: 0.988, b: 0.906 },    // #DCFCE7
  'Green/700':      { r: 0.082, g: 0.502, b: 0.239 },    // #15803D
  // Purple
  'Purple/50':      { r: 0.961, g: 0.953, b: 1.0 },      // #F5F3FF
  'Purple/100':     { r: 0.929, g: 0.914, b: 0.992 },    // #EDE9FE
  'Purple/600':     { r: 0.486, g: 0.227, b: 0.929 },    // #7C3AED
  'Purple/700':     { r: 0.427, g: 0.157, b: 0.851 },    // #6D28D9
  // Orange (amber equivalent)
  'Orange/50':      { r: 1.0, g: 0.984, b: 0.922 },      // #FFFBEB
  'Orange/100':     { r: 0.996, g: 0.953, b: 0.78 },     // #FEF3C7
  'Orange/700':     { r: 0.706, g: 0.322, b: 0.055 },    // #B45309
};

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

  // Build reference map: key → { name, ref RGB }
  const refMap = {};

  // Add gray scale
  for (const [level, ref] of Object.entries(GRAY_SCALE_STYLES)) {
    const name = `Gray (light mode)/${level}`;
    const key = styleByName[name];
    if (key) refMap[key] = { name, key, ref };
  }

  // Add accent scale
  for (const [name, ref] of Object.entries(ACCENT_SCALE_STYLES)) {
    const key = styleByName[name];
    if (key) refMap[key] = { name, key, ref };
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
