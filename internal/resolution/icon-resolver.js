/**
 * Mimic AI — Icon Resolver
 *
 * DS-agnostic icon intent detection and icon component discovery.
 *
 * Detects icon intent from HTML context, searches DS for matching icon components,
 * and returns the best candidate with confidence scoring.
 *
 * Does NOT hardcode icon names, keys, or one DS's icon naming scheme.
 * Uses semantic similarity and common icon naming patterns.
 *
 * Usage:
 *   import { resolveIcon, detectIconIntent } from './icon-resolver.js';
 *   const icon = resolveIcon('edit', dsKnowledge);
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = resolve(__dir, '..', 'ds-knowledge', 'ds-knowledge-normalized.json');

let _iconCache = null;

function loadIconInventory() {
  if (_iconCache) return _iconCache;
  if (!existsSync(KNOWLEDGE_PATH)) return null;
  try {
    const k = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8'));
    // Icon components: short names, no slash, likely standalone
    _iconCache = k.standaloneComponents.filter(c => {
      const n = c.name.toLowerCase();
      return n.match(/^[a-z]/) && !n.includes('/') && n.length < 35;
    });
    return _iconCache;
  } catch { return null; }
}


// ═══════════════════════════════════════════════════════════════════════════
// ICON INTENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// Semantic intent → search term mapping (DS-agnostic)
const INTENT_SEARCH_TERMS = {
  'edit': ['edit', 'pencil', 'pen'],
  'close': ['x-close', 'x', 'close'],
  'dismiss': ['x-close', 'x', 'close'],
  'code': ['code', 'terminal', 'code-browser'],
  'upload': ['upload', 'arrow-up', 'cloud-upload'],
  'import': ['upload', 'inbox', 'file-plus', 'download'],
  'evaluate': ['check-circle', 'shield', 'award', 'clipboard-check'],
  'benchmark': ['bar-chart', 'chart', 'trending', 'activity'],
  'sdk': ['code', 'terminal', 'brackets', 'command-line'],
  'arrow-right': ['arrow-right', 'chevron-right', 'arrow-narrow-right'],
  'arrow-left': ['arrow-left', 'chevron-left'],
  'external-link': ['link-external', 'external-link', 'arrow-up-right'],
  'link': ['link', 'link-01', 'chain'],
  'search': ['search', 'magnifying-glass'],
  'settings': ['settings', 'gear', 'cog'],
  'plus': ['plus', 'add', 'plus-circle'],
  'check': ['check', 'check-circle', 'checkmark'],
  'info': ['info-circle', 'info', 'help-circle'],
  'resource': ['file-text', 'book-open', 'file'],
  'article': ['file-text', 'book-open', 'newspaper'],
  'traces': ['activity', 'line-chart', 'pulse'],
  'play': ['play', 'play-circle'],
  'star': ['star', 'stars'],
};

/**
 * Detect icon intent from structural and semantic signals.
 *
 * Priority order:
 *   1. Structural signals (position, parent role, element type)
 *   2. HTML attribute signals (class names, aria-label)
 *   3. Contextual text signals (weak, last resort)
 *
 * @param {Object} context
 * @param {string} [context.position] — 'leading', 'trailing', 'standalone'
 * @param {string} [context.parentRole] — structural role of parent element
 * @param {string} [context.elementTag] — HTML tag (svg, img, span, etc.)
 * @param {string} [context.className] — class name of the icon element or parent
 * @param {string} [context.ariaLabel] — aria-label from HTML
 * @param {string} [context.siblingText] — text content of sibling elements
 * @param {string} [context.parentText] — text content of the parent container
 * @returns {string|null} intent key or null
 */
export function detectIconIntent(context) {
  // ── 1. STRUCTURAL SIGNALS (strongest) ──

  const cls = (context.className || '').toLowerCase();
  const aria = (context.ariaLabel || '').toLowerCase();
  const parentRole = (context.parentRole || '').toLowerCase();

  // Class-name patterns (DS-agnostic: common CSS conventions)
  if (cls.match(/edit|pencil|pen/)) return 'edit';
  if (cls.match(/close|dismiss|x-close/)) return 'close';
  if (cls.match(/code|terminal|command/)) return 'code';
  if (cls.match(/search|magnif/)) return 'search';
  if (cls.match(/settings|gear|cog/)) return 'settings';
  if (cls.match(/arrow.?right|chevron.?right|next/)) return 'arrow-right';
  if (cls.match(/arrow.?left|chevron.?left|prev|back/)) return 'arrow-left';
  if (cls.match(/external|link.?ext|open.?new/)) return 'external-link';
  if (cls.match(/plus|add|create/)) return 'plus';
  if (cls.match(/check|done|complete/)) return 'check';
  if (cls.match(/info|help/)) return 'info';
  if (cls.match(/star|rating|fav/)) return 'star';

  // Aria-label (accessibility text — very strong signal)
  if (aria) {
    if (aria.match(/edit|modify/)) return 'edit';
    if (aria.match(/close|dismiss|remove/)) return 'close';
    if (aria.match(/search/)) return 'search';
    if (aria.match(/settings|preference/)) return 'settings';
    if (aria.match(/navigate|next|forward/)) return 'arrow-right';
    if (aria.match(/back|previous/)) return 'arrow-left';
  }

  // Parent role signals
  if (parentRole === 'dismiss' || parentRole === 'close') return 'close';
  if (parentRole === 'edit') return 'edit';

  // ── 2. POSITIONAL SIGNALS (medium) ──

  const position = (context.position || '').toLowerCase();
  const siblingText = (context.siblingText || '').toLowerCase();
  const parentText = (context.parentText || '').toLowerCase();

  // Trailing icon in a button/link with arrow-like text → navigation
  if (position === 'trailing' && (siblingText.includes('→') || siblingText.includes('›'))) return 'arrow-right';

  // Leading icon in a code-related container
  if (position === 'leading' && (siblingText.match(/code|sdk|install|terminal|pip|npm/) || cls.match(/code|terminal/))) return 'code';

  // ── 3. SIBLING TEXT INFERENCE (weakest — only when no structural signal) ──

  // Only use text matching as last resort, and require multiple signals
  const textPool = (siblingText + ' ' + parentText).toLowerCase();

  // These are weak inferences — only trigger when text is specific enough
  if (textPool.match(/\bimport\b.*\btrace/)) return 'import';
  if (textPool.match(/\bjudge\b|\bevaluat/)) return 'evaluate';
  if (textPool.match(/\bbenchmark\b|\bcompare\b.*\bmodel/)) return 'benchmark';
  if (textPool.match(/\bsdk\b|\binstall\b/)) return 'sdk';
  if (textPool.match(/\btrace[s]?\b|\bactivity\b/)) return 'traces';
  if (textPool.match(/\bguide\b|\bdocument/)) return 'external-link';
  if (textPool.match(/\barticle\b|\bread\b/)) return 'article';
  if (textPool.match(/\bsandbox\b/)) return 'traces';

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// ICON DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Search the DS icon inventory for the best match for a given intent.
 *
 * @param {string} intent — from detectIconIntent()
 * @returns {Object|null} { key, name, confidence } or null
 */
export function resolveIcon(intent) {
  if (!intent) return null;

  const icons = loadIconInventory();
  if (!icons || icons.length === 0) return null;

  const searchTerms = INTENT_SEARCH_TERMS[intent];
  if (!searchTerms) return null;

  const candidates = [];

  for (const icon of icons) {
    const name = icon.name.toLowerCase();
    let score = 0;

    for (const term of searchTerms) {
      if (name === term) score += 5;          // Exact match
      else if (name.startsWith(term)) score += 4; // Starts with
      else if (name.includes(term)) score += 2;   // Contains
    }

    if (score > 0) {
      candidates.push({ key: icon.key, name: icon.name, score });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const confidence = best.score >= 4 ? 'high' : best.score >= 2 ? 'medium' : 'low';

  if (confidence === 'low') return null; // Don't use low-confidence icon matches

  return { key: best.key, name: best.name, confidence };
}


// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC CONVENIENCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an icon from context — combines intent detection + DS search.
 *
 * @param {Object} context — { text, role, sectionName, cardTitle }
 * @returns {Object|null} { key, name, intent, confidence }
 */
export function resolveIconFromContext(context) {
  const intent = detectIconIntent(context);
  if (!intent) return null;

  const result = resolveIcon(intent);
  if (!result) return null;

  return { ...result, intent };
}
