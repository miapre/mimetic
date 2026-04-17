/**
 * Mimic AI — Recommendation Query Engine
 *
 * User-facing capability: answers "How can I improve my design system?"
 * with structured, ranked, evidence-based recommendations.
 *
 * All outputs grounded in real data from:
 *   - mimic/reports/recommendations.json
 *   - mimic/knowledge/component-behavior.json
 *
 * Does NOT modify build pipeline, learning system, or resolver.
 *
 * Usage:
 *   import { queryRecommendations } from './recommendation-query.js';
 *   const result = queryRecommendations("How can I improve my DS?");
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, '..', '..');

const RECOMMENDATIONS_PATH = resolve(PROJECT_ROOT, 'mimic', 'reports', 'recommendations.json');
const KNOWLEDGE_PATH = resolve(PROJECT_ROOT, 'mimic', 'knowledge', 'component-behavior.json');


// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadRecommendations() {
  if (!existsSync(RECOMMENDATIONS_PATH)) return null;
  try { return JSON.parse(readFileSync(RECOMMENDATIONS_PATH, 'utf8')); }
  catch { return null; }
}

function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_PATH)) return null;
  try { return JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf8')); }
  catch { return null; }
}


// ═══════════════════════════════════════════════════════════════════════════
// STEP 1 — QUERY UNDERSTANDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify user query into a supported type.
 *
 * @param {string} input — user's natural language query
 * @returns {Object} { type, target }
 */
export function understandQuery(input) {
  if (!input || typeof input !== 'string') {
    return { type: 'UNSUPPORTED', target: null };
  }

  const q = input.toLowerCase().trim();

  // Unsupported topics — things Mimic doesn't track at component level
  const unsupportedPatterns = [
    /\bcolor(?:s)?\b/, /\bspacing\b/, /\btypography\b/, /\bfont(?:s)?\b/,
    /\btoken(?:s)?\b/, /\bvariable(?:s)?\b/, /\bgrid\b/, /\bbreakpoint(?:s)?\b/,
    /\banimation(?:s)?\b/, /\bmotion\b/, /\btheme(?:s)?\b/,
  ];
  for (const pattern of unsupportedPatterns) {
    if (pattern.test(q) && !q.match(/component|improve|recommend|fallback|pattern/)) {
      return { type: 'UNSUPPORTED', target: null };
    }
  }

  // Component-specific queries
  const componentTargets = [
    { pattern: /\b(?:button|btn|cta)s?\b/, target: 'button' },
    { pattern: /\b(?:input|form|field|text.?field|text.?area|search.?bar)s?\b/, target: 'input' },
    { pattern: /\b(?:badge|tag|chip|pill|label|status)s?\b/, target: 'badge' },
    { pattern: /\b(?:tab|tablist|tab.?bar)s?\b/, target: 'tab' },
    { pattern: /\b(?:icon|svg|media|image)s?\b/, target: 'media' },
    { pattern: /\b(?:heading|title|h1|h2|h3|text|paragraph)s?\b/, target: 'text' },
    { pattern: /\b(?:card|tile)s?\b/, target: 'card' },
    { pattern: /\b(?:nav|navigation|menu|sidebar|header|footer)s?\b/, target: 'navigation' },
    { pattern: /\b(?:modal|dialog|overlay|drawer)s?\b/, target: 'modal' },
    { pattern: /\b(?:table|data.?grid|list)s?\b/, target: 'table' },
    { pattern: /\b(?:layout|container|section|div|wrapper)s?\b/, target: 'layout' },
  ];

  for (const { pattern, target } of componentTargets) {
    if (pattern.test(q)) {
      return { type: 'COMPONENT', target };
    }
  }

  // General improvement queries
  const generalPatterns = [
    /improve/, /recommend/, /suggest/, /what.?should/, /how.?can/,
    /gaps?/, /missing/, /fallback/, /coverage/, /better/, /optimize/,
    /design.?system/, /\bds\b/, /what.?wrong/, /issues?/, /problems?/,
    /pattern.*fail/, /fail.*pattern/, /what.*not.*work/,
  ];
  for (const pattern of generalPatterns) {
    if (pattern.test(q)) {
      return { type: 'GENERAL', target: null };
    }
  }

  // If nothing matched, default to UNSUPPORTED
  return { type: 'UNSUPPORTED', target: null };
}


// ═══════════════════════════════════════════════════════════════════════════
// STEP 2 — RECOMMENDATION SELECTION + RANKING
// ═══════════════════════════════════════════════════════════════════════════

// Map from element types in data to component categories
const ELEMENT_TO_CATEGORY = {
  'button': 'button', 'a': 'button',
  'input': 'input', 'textarea': 'input', 'select': 'input',
  'span': 'badge', 'label': 'badge',
  'svg': 'media', 'img': 'media', 'video': 'media',
  'h1': 'text', 'h2': 'text', 'h3': 'text', 'h4': 'text', 'h5': 'text', 'h6': 'text', 'p': 'text',
  'div': 'layout', 'section': 'layout', 'article': 'layout', 'main': 'layout',
  'nav': 'navigation', 'header': 'navigation', 'footer': 'navigation',
  'table': 'table', 'tr': 'table', 'td': 'table', 'th': 'table',
  'ul': 'table', 'ol': 'table', 'li': 'table',
};

/**
 * Select and rank recommendations for a given query.
 */
function selectRecommendations(queryType, target, recommendations, knowledge) {
  if (!recommendations?.recommendations?.length && !knowledge) {
    return [];
  }

  // Build a unified ranked list from both sources
  const ranked = [];

  // From recommendations.json
  if (recommendations?.recommendations) {
    for (const rec of recommendations.recommendations) {
      // Extract element type from description
      const match = rec.description?.match(/Element type "([^"]+)"/);
      const elementType = match?.[1] || null;
      const category = elementType ? (ELEMENT_TO_CATEGORY[elementType] || elementType) : null;

      ranked.push({
        source: 'recommendations',
        type: rec.type,
        elementType,
        category,
        evidenceCount: rec.evidenceCount || 0,
        lastSeen: rec.lastSeen || null,
        rawDescription: rec.description,
      });
    }
  }

  // Enrich from knowledge — add fallback patterns not yet in recommendations
  if (knowledge?.fallbacks) {
    for (const [elementType, data] of Object.entries(knowledge.fallbacks)) {
      const alreadyInRecs = ranked.some(r => r.elementType === elementType);
      if (!alreadyInRecs && data.count >= 3) {
        const category = ELEMENT_TO_CATEGORY[elementType] || elementType;
        ranked.push({
          source: 'knowledge',
          type: 'EMERGING_PATTERN',
          elementType,
          category,
          evidenceCount: data.count,
          lastSeen: data.lastSeen,
          rawDescription: null,
        });
      }
    }
  }

  // Filter by target if COMPONENT query
  let filtered = ranked;
  if (target) {
    filtered = ranked.filter(r => r.category === target);
  }

  // Sort by evidence count descending
  filtered.sort((a, b) => b.evidenceCount - a.evidenceCount);

  // Cap at 5 for general, 3 for component
  const limit = target ? 3 : 5;
  return filtered.slice(0, limit);
}


// ═══════════════════════════════════════════════════════════════════════════
// STEP 3 — RESPONSE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

// Human-readable descriptions for element types
const ELEMENT_DESCRIPTIONS = {
  'p': 'paragraph text elements',
  'div': 'container/layout elements',
  'svg': 'icon and media elements',
  'h1': 'primary headings',
  'h2': 'section headings',
  'h3': 'sub-headings',
  'span': 'inline text elements',
  'a': 'link elements',
  'button': 'button elements',
  'input': 'input fields',
  'img': 'images',
  'nav': 'navigation containers',
  'section': 'page sections',
  'table': 'data tables',
  'ul': 'list elements',
};

const CATEGORY_DESCRIPTIONS = {
  'text': 'Text content (headings, paragraphs)',
  'layout': 'Layout containers (sections, wrappers)',
  'media': 'Icons and media (SVG, images)',
  'button': 'Interactive elements (buttons, links)',
  'input': 'Form inputs (text fields, search)',
  'badge': 'Labels and badges',
  'navigation': 'Navigation structures',
  'table': 'Data tables and lists',
  'tab': 'Tab navigation',
  'card': 'Card containers',
  'modal': 'Modals and dialogs',
};

function generateTitle(rec) {
  const desc = ELEMENT_DESCRIPTIONS[rec.elementType] || `${rec.elementType} elements`;
  if (rec.type === 'MISSING_COMPONENT') {
    return `${capitalize(desc)} consistently fall back to primitives`;
  }
  if (rec.type === 'EMERGING_PATTERN') {
    return `${capitalize(desc)} are emerging as a fallback pattern`;
  }
  if (rec.type === 'UNRESOLVED_PATTERN') {
    return `Unresolved pattern detected for ${desc}`;
  }
  if (rec.type === 'LOW_CONFIDENCE_COMPONENT') {
    return `Low confidence matching for ${desc}`;
  }
  return `Improvement opportunity for ${desc}`;
}

function generateDescription(rec, knowledge) {
  const desc = ELEMENT_DESCRIPTIONS[rec.elementType] || `${rec.elementType} elements`;
  const count = rec.evidenceCount;

  if (rec.type === 'MISSING_COMPONENT') {
    return `Across ${count} build instances, ${desc} are not being mapped to design system components. ` +
      `This means they are rendered as plain primitives instead of using your DS library, ` +
      `reducing visual consistency and requiring manual fixes after build.`;
  }
  if (rec.type === 'EMERGING_PATTERN') {
    return `${capitalize(desc)} have fallen back ${count} times across recent builds. ` +
      `This is not yet a confirmed gap, but the pattern is building. ` +
      `If your DS has a component for this element type, Mimic may need a mapping correction.`;
  }
  if (rec.type === 'LOW_CONFIDENCE_COMPONENT') {
    return `The component matching ${desc} has low confidence. ` +
      `This may indicate the DS component structure doesn't fully align with how these elements appear in HTML.`;
  }
  return `${capitalize(desc)} have been flagged ${count} times. Review whether your DS covers this pattern.`;
}

function generateImpact(rec, knowledge) {
  const count = rec.evidenceCount;

  // Calculate total fallbacks for context
  const totalFallbacks = knowledge?.fallbacks
    ? Object.values(knowledge.fallbacks).reduce((sum, f) => sum + f.count, 0)
    : 0;

  const fallbackPct = totalFallbacks > 0
    ? `${Math.round(count / totalFallbacks * 100)}% of all fallbacks`
    : `${count} instances`;

  const coverageIncrease = count >= 10
    ? 'significant DS coverage increase'
    : count >= 5
      ? 'moderate DS coverage increase'
      : 'minor DS coverage increase';

  const iterationSavings = count >= 10
    ? 'would eliminate the most frequent manual fix across builds'
    : count >= 5
      ? 'would reduce post-build manual corrections'
      : 'would improve build quality incrementally';

  return {
    fallbackReduction: `Would eliminate ${fallbackPct}`,
    dsCoverageIncrease: capitalize(coverageIncrease),
    iterationSavings: capitalize(iterationSavings),
  };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}


// ═══════════════════════════════════════════════════════════════════════════
// STEP 4+5 — FULL RESPONSE ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════

function buildResponse(queryResult, selected, knowledge) {
  // No data available at all
  if (!selected.length && queryResult.type !== 'UNSUPPORTED') {
    if (queryResult.type === 'COMPONENT') {
      return {
        summary: `No improvement recommendations found for ${queryResult.target} components. This could mean your DS handles them well, or Mimic hasn't encountered enough builds to detect patterns yet.`,
        recommendations: [],
      };
    }
    return {
      summary: 'No recommendations available yet. Run more builds to generate actionable insights. Mimic learns from every build and will surface recommendations when patterns emerge.',
      recommendations: [],
    };
  }

  // Build the recommendation list
  const recs = selected.map(rec => ({
    title: generateTitle(rec),
    description: generateDescription(rec, knowledge),
    evidence: rec.evidenceCount,
    impact: generateImpact(rec, knowledge),
  }));

  // Summary
  const totalEvidence = selected.reduce((sum, r) => sum + r.evidenceCount, 0);
  const topCategory = selected[0]?.category;
  const topDesc = CATEGORY_DESCRIPTIONS[topCategory] || topCategory;

  let summary;
  if (queryResult.type === 'COMPONENT') {
    summary = `Found ${recs.length} recommendation${recs.length === 1 ? '' : 's'} for ${queryResult.target} components based on ${totalEvidence} observed instances across builds.`;
  } else {
    summary = `Based on build analysis, ${recs.length} improvement${recs.length === 1 ? '' : 's'} ${recs.length === 1 ? 'has' : 'have'} been identified. ` +
      `The highest-impact area is ${topDesc?.toLowerCase() || 'component coverage'} with ${selected[0]?.evidenceCount || 0} instances.`;
  }

  return { summary, recommendations: recs };
}

function buildUnsupportedResponse() {
  return {
    message: 'Mimic does not currently track this aspect of your design system. Recommendations are based on component-level build observations — which elements map to DS components and which fall back to primitives.',
    supportedQueries: [
      'general improvements ("How can I improve my DS?")',
      'component-specific ("How are buttons performing?")',
      'pattern-based ("What patterns are falling back?")',
      'coverage gaps ("What components am I missing?")',
    ],
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Query the recommendation engine.
 *
 * @param {string} input — user's natural language query
 * @returns {Object} { queryType, response }
 */
export function queryRecommendations(input) {
  const queryResult = understandQuery(input);

  if (queryResult.type === 'UNSUPPORTED') {
    return {
      queryType: 'UNSUPPORTED',
      response: buildUnsupportedResponse(),
    };
  }

  const recommendations = loadRecommendations();
  const knowledge = loadKnowledge();

  const selected = selectRecommendations(
    queryResult.type,
    queryResult.target,
    recommendations,
    knowledge,
  );

  const response = buildResponse(queryResult, selected, knowledge);

  return {
    queryType: queryResult.type,
    target: queryResult.target,
    response,
  };
}
