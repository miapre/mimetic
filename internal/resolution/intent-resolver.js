/**
 * Mimic AI — Intent Resolver
 *
 * DS-agnostic intent detection and component discovery.
 * Derives intent from HTML structure, then searches the DS for matching components.
 *
 * Does NOT modify rendering, auto-layout, typography, color, or spacing systems.
 * Only affects WHICH DS components are selected for insertion.
 *
 * Usage:
 *   import { deriveIntent, findBestComponent, resolveVariant } from './intent-resolver.js';
 */


// ═══════════════════════════════════════════════════════════════════════════
// INTENT MODEL (DS-AGNOSTIC)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Derive intent from an HTML element's structural context.
 *
 * @param {Object} context
 * @param {string} context.tag — HTML tag
 * @param {string} [context.text] — visible text content
 * @param {Object} [context.attrs] — HTML attributes (class, role, href, etc.)
 * @param {string} [context.parentRole] — role of the parent section
 * @param {Object[]} [context.children] — child element summaries
 * @returns {Object} intent
 */
export function deriveIntent(context) {
  const tag = (context.tag || '').toLowerCase();
  const text = (context.text || '').trim();
  const cls = (context.attrs?.class || '').toLowerCase();
  const role = context.attrs?.role?.toLowerCase();
  const href = context.attrs?.href;

  const intent = {
    type: 'display',       // action, input, display, feedback, layout
    role: 'structural',    // primary, secondary, decorative, structural
    semantics: [],         // clickable, selectable, repeated, progress, grouped, dismissible
    structure: 'single',   // single, list, compound, nested
    text,
    tag,
  };

  // Type detection
  if (['button', 'a'].includes(tag) || role === 'button' || cls.includes('btn') || href) {
    intent.type = 'action';
  } else if (['input', 'textarea', 'select'].includes(tag)) {
    intent.type = 'input';
  } else if (cls.includes('progress') || role === 'progressbar') {
    intent.type = 'feedback';
  } else if (['div', 'section', 'article', 'aside', 'nav', 'ul', 'ol'].includes(tag)) {
    intent.type = 'layout';
  }

  // Role detection
  if (intent.type === 'action') {
    if (cls.includes('primary') || cls.includes('btn-primary')) intent.role = 'primary';
    else if (cls.includes('secondary') || cls.includes('btn-secondary')) intent.role = 'secondary';
    else if (cls.includes('link') || cls.includes('text') || href) intent.role = 'secondary';
    else intent.role = 'primary';
  }

  // Semantic detection
  if (intent.type === 'action') intent.semantics.push('clickable');
  if (href) intent.semantics.push('navigational');
  if (text.includes('→') || text.includes('›') || cls.includes('link') || cls.includes('more')) intent.semantics.push('clickable');
  if (cls.includes('dismiss') || cls.includes('close') || text === '×' || text === 'x') intent.semantics.push('dismissible');
  if (cls.includes('progress') || role === 'progressbar') intent.semantics.push('progress');
  if (cls.includes('check') || role === 'checkbox') intent.semantics.push('selectable');
  if (context.parentRole === 'list' || context.parentRole === 'repeated') intent.semantics.push('repeated');

  // Structure
  if (context.children && context.children.length > 1) intent.structure = 'compound';
  if (context.parentRole === 'list') intent.structure = 'list';

  return intent;
}


// ═══════════════════════════════════════════════════════════════════════════
// INTERACTIVE ELEMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect if text content represents an interactive element.
 * Looks for link patterns, CTA patterns, and action text.
 *
 * @param {string} text — visible text
 * @param {Object} [context] — surrounding context
 * @returns {Object|null} { type, role, confidence }
 */
export function detectInteractive(text, context = {}) {
  if (!text) return null;
  const t = text.trim();

  // Arrow suffix → link
  if (t.endsWith('→') || t.endsWith('›') || t.endsWith('»')) {
    return { type: 'action', role: 'secondary', variant: 'link', confidence: 0.9 };
  }

  // Common action verbs
  if (t.match(/^(View|See|Browse|Copy|Download|Share|Edit|Delete|Remove|Dismiss)\b/i)) {
    return { type: 'action', role: 'secondary', variant: 'link', confidence: 0.8 };
  }

  // Short text that looks like a button label
  if (t.length <= 25 && t.match(/^(Copy|Save|Submit|Cancel|Confirm|Apply|Close|Undo|Retry)$/i)) {
    return { type: 'action', role: 'secondary', variant: 'secondary', confidence: 0.85 };
  }

  // CTA-like text
  if (t.match(/^(Get started|Try|Start|Create|Run|Import|Install|Connect|Enable)/i)) {
    return { type: 'action', role: 'primary', variant: 'primary', confidence: 0.8 };
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Search terms for common UI intents.
 * Used to query DS via search_design_system MCP tool.
 * DS-agnostic — these are structural/functional terms, not component names.
 */
const INTENT_SEARCH_TERMS = {
  'action:primary': ['button'],
  'action:secondary': ['button'],
  'action:link': ['button', 'link'],
  'input': ['input', 'field'],
  'feedback:progress': ['progress'],
  'selectable': ['checkbox', 'check'],
  'dismissible': ['close', 'dismiss', 'button'],
  'list-item': ['list item', 'item'],
  'icon': ['icon'],
};

/**
 * Resolve which variant properties to set based on intent.
 * Returns a map of property name patterns → desired values.
 *
 * @param {Object} intent — from deriveIntent()
 * @returns {Object} variant hints { propertyPattern: value }
 */
export function resolveVariantHints(intent) {
  const hints = {};

  if (intent.type === 'action') {
    // Hierarchy
    if (intent.role === 'primary') hints['hierarchy'] = 'Primary';
    else if (intent.role === 'secondary') {
      if (intent.semantics.includes('clickable') && (intent.text?.includes('→') || intent.text?.match(/^(View|See|Browse|Copy)/i))) {
        hints['hierarchy'] = 'Link';
      } else {
        hints['hierarchy'] = 'Secondary';
      }
    }

    // Size — default to md unless context suggests otherwise
    hints['size'] = 'md';
    if (intent.text && intent.text.length <= 15) hints['size'] = 'sm';

    // State
    hints['state'] = 'Default';

    // Icons — detect if text suggests icon presence
    if (intent.text?.includes('→') || intent.text?.includes('›')) {
      hints['icon_trailing'] = true;
    }
  }

  if (intent.semantics.includes('dismissible')) {
    hints['hierarchy'] = 'Tertiary';
    hints['size'] = 'sm';
  }

  return hints;
}

/**
 * Apply variant hints to a component instance's properties.
 * Matches hint patterns against actual component property names.
 *
 * @param {Object} componentProperties — from instance.componentProperties
 * @param {Object} hints — from resolveVariantHints()
 * @returns {Object} properties to set via setProperties()
 */
export function matchVariantProperties(componentProperties, hints) {
  const toSet = {};
  const propEntries = Object.entries(componentProperties);

  for (const [hintPattern, hintValue] of Object.entries(hints)) {
    const pattern = hintPattern.toLowerCase();

    for (const [propName, propDef] of propEntries) {
      const name = propName.toLowerCase();

      // Match property name against hint pattern
      if (!name.includes(pattern)) continue;

      if (propDef.type === 'VARIANT') {
        // Find the closest matching variant value
        const values = propDef.preferredValues?.map(v => v.value) || [];
        if (typeof hintValue === 'string') {
          const match = values.find(v => v.toLowerCase() === hintValue.toLowerCase());
          if (match) toSet[propName] = match;
        }
      } else if (propDef.type === 'BOOLEAN') {
        if (typeof hintValue === 'boolean') toSet[propName] = hintValue;
      }
    }
  }

  return toSet;
}

/**
 * Get search terms for a given intent.
 */
export function getSearchTerms(intent) {
  const terms = [];

  if (intent.type === 'action') {
    if (intent.semantics.includes('clickable')) terms.push('button');
  }
  if (intent.type === 'input') terms.push('input', 'field');
  if (intent.semantics.includes('progress')) terms.push('progress');
  if (intent.semantics.includes('selectable')) terms.push('checkbox');
  if (intent.semantics.includes('dismissible')) terms.push('button');

  return [...new Set(terms)];
}
