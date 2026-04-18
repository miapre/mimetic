/**
 * Mimic AI — Build Learning Artifact System
 *
 * Observes builds and generates learning artifacts. Runs AFTER build completion.
 * Does NOT affect runtime resolution, rendering, or DS matching.
 *
 * Three outputs:
 *   1. Build artifact  → mimic/builds/{timestamp}.json (per-build snapshot)
 *   2. Knowledge file  → mimic/knowledge/component-behavior.json (cumulative)
 *   3. Recommendations → mimic/reports/recommendations.json (threshold-triggered)
 *
 * Rules:
 *   - Append-only (never overwrites blindly)
 *   - Never crashes the build (all errors caught)
 *   - Never modifies resolver behavior
 *   - No DS-specific assumptions
 *   - Evidence-based only (counting + grouping, no inference)
 *
 * Usage:
 *   import { generateBuildLearning } from './build-learning.js';
 *   // Call after build completes — pass pipelineResult
 *   const artifact = generateBuildLearning(pipelineResult);
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, '..', '..');

const BUILDS_DIR = resolve(PROJECT_ROOT, 'mimic', 'builds');
const KNOWLEDGE_DIR = resolve(PROJECT_ROOT, 'mimic', 'knowledge');
const REPORTS_DIR = resolve(PROJECT_ROOT, 'mimic', 'reports');

const COMPONENT_BEHAVIOR_PATH = resolve(KNOWLEDGE_DIR, 'component-behavior.json');
const RECOMMENDATIONS_PATH = resolve(REPORTS_DIR, 'recommendations.json');

// Thresholds for recommendation generation
const FALLBACK_THRESHOLD = 5;    // Same fallback type > N times → recommend
const UNRESOLVED_THRESHOLD = 3;  // Same unresolved pattern > N times → recommend

// Ensure directories exist
function ensureDirs() {
  for (const dir of [BUILDS_DIR, KNOWLEDGE_DIR, REPORTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// STAGE 1 — BUILD ARTIFACT GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a build artifact from pipeline result.
 *
 * @param {Object} pipelineResult — from pipeline-controller.js resolveInput()
 * @returns {Object} build artifact (also written to disk)
 */
function generateBuildArtifact(pipelineResult) {
  const now = new Date();
  const buildId = `build-${now.toISOString().replace(/[:.]/g, '-')}`;

  // Extract resolution traces if available
  const resolutions = pipelineResult._resolutions || [];
  const uiElements = pipelineResult._uiElements || [];

  // Build resolution entries — compact, decision-level only
  const resolutionEntries = [];
  for (let i = 0; i < resolutions.length; i++) {
    const r = resolutions[i];
    const node = uiElements[i];
    if (!r) continue;

    const confidence = r.outcome === 'STRICT_MATCH' ? 'high'
      : r.outcome === 'VALID_MATCH' ? 'medium'
      : 'low';

    resolutionEntries.push({
      elementType: node?.tag || 'unknown',
      intent: {
        type: r.intent?.type || 'unknown',
        role: r.intent?.role || null,
        semantics: r.intent?.semantics || [],
      },
      decision: r.outcome === 'FALLBACK' ? 'FALLBACK' : 'DS_COMPONENT',
      component: {
        name: r.decision?.component || null,
        key: r.decision?.componentKey || null,
      },
      confidence,
    });
  }

  // Collect failures
  const failures = resolutions
    .filter(r => r.outcome === 'FALLBACK')
    .map(r => ({
      elementType: r.intent?.tag || r.intent?.type || 'unknown',
      reason: r.decision?.reason || 'unknown',
    }));

  // Detect signals
  const fallbackTypes = {};
  for (const r of resolutions) {
    if (r.outcome === 'FALLBACK') {
      const key = `${r.intent?.type || 'unknown'}/${r.intent?.tag || 'unknown'}`;
      fallbackTypes[key] = (fallbackTypes[key] || 0) + 1;
    }
  }
  const repeatedFallbackTypes = Object.entries(fallbackTypes)
    .filter(([, count]) => count >= 2)
    .map(([type]) => type);

  // Detect unresolved patterns — element types that consistently fail
  const unresolvedPatterns = Object.entries(fallbackTypes)
    .filter(([, count]) => count >= 3)
    .map(([type]) => type);

  // Input metrics
  const htmlSize = pipelineResult.outputPath
    ? (() => { try { return readFileSync(pipelineResult.outputPath, 'utf8').length; } catch { return 0; } })()
    : 0;

  const summary = pipelineResult.resolution || {};

  const artifact = {
    buildId,
    timestamp: now.toISOString(),
    input: {
      htmlSize,
      nodeCount: pipelineResult.parsing?.uiElements || 0,
    },
    summary: {
      elementsProcessed: resolutionEntries.length,
      dsMatches: (summary.strictMatches || 0) + (summary.validMatches || 0),
      fallbacks: summary.fallbacks || 0,
      errors: pipelineResult.buildError ? 1 : 0,
    },
    resolution: resolutionEntries,
    failures: failures.slice(0, 50), // Cap to keep file small
    signals: {
      repeatedFallbackTypes,
      unresolvedPatterns,
    },
  };

  return artifact;
}

/**
 * Write build artifact to disk.
 */
function localDateDir(now) {
  // Returns YYYY-MM-DD in local time
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localTimeFile(now) {
  // Returns HH-mm-ss in local time
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}-${min}-${s}`;
}

function persistBuildArtifact(artifact) {
  ensureDirs();
  const now = new Date(artifact.timestamp);
  const dateDir = localDateDir(now);
  const dir = resolve(BUILDS_DIR, dateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${localTimeFile(now)}.json`;
  const filepath = resolve(dir, filename);
  writeFileSync(filepath, JSON.stringify(artifact, null, 2), 'utf8');
  return filepath;
}


// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2 — KNOWLEDGE AGGREGATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update the cumulative component-behavior knowledge file.
 * Incremental — reads existing, merges new data, writes back.
 */
function updateKnowledge(artifact) {
  ensureDirs();

  // Load or create
  let knowledge;
  try {
    if (existsSync(COMPONENT_BEHAVIOR_PATH)) {
      knowledge = JSON.parse(readFileSync(COMPONENT_BEHAVIOR_PATH, 'utf8'));
    }
  } catch {
    // Corrupted — recreate
  }
  if (!knowledge) {
    knowledge = { components: {}, fallbacks: {}, patterns: { unresolved: [] } };
  }

  // Ensure structure
  if (!knowledge.components) knowledge.components = {};
  if (!knowledge.fallbacks) knowledge.fallbacks = {};
  if (!knowledge.patterns) knowledge.patterns = { unresolved: [] };
  if (!Array.isArray(knowledge.patterns.unresolved)) knowledge.patterns.unresolved = [];

  const now = artifact.timestamp;

  // Update component usage
  for (const entry of artifact.resolution) {
    if (entry.decision !== 'DS_COMPONENT' || !entry.component.key) continue;

    const key = entry.component.key;
    if (!knowledge.components[key]) {
      knowledge.components[key] = {
        name: entry.component.name,
        usageCount: 0,
        successfulMatches: 0,
        lastUsed: null,
      };
    }
    knowledge.components[key].usageCount++;
    if (entry.confidence === 'high') knowledge.components[key].successfulMatches++;
    knowledge.components[key].lastUsed = now;
    // Keep name current
    if (entry.component.name) knowledge.components[key].name = entry.component.name;
  }

  // Update fallback counts
  for (const entry of artifact.resolution) {
    if (entry.decision !== 'FALLBACK') continue;

    const type = entry.elementType;
    if (!knowledge.fallbacks[type]) {
      knowledge.fallbacks[type] = { count: 0, lastSeen: null };
    }
    knowledge.fallbacks[type].count++;
    knowledge.fallbacks[type].lastSeen = now;
  }

  // Update unresolved patterns
  for (const pattern of artifact.signals.unresolvedPatterns) {
    const existing = knowledge.patterns.unresolved.find(p => p.signature === pattern);
    if (existing) {
      existing.occurrences++;
    } else {
      knowledge.patterns.unresolved.push({ signature: pattern, occurrences: 1 });
    }
  }

  // Persist
  writeFileSync(COMPONENT_BEHAVIOR_PATH, JSON.stringify(knowledge, null, 2), 'utf8');
  return knowledge;
}


// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3 — RECOMMENDATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate recommendations when evidence thresholds are met.
 * Evidence-based only — no guessing, no DS assumptions.
 */
function generateRecommendations(knowledge) {
  ensureDirs();

  const recommendations = [];

  // Missing component recommendations — questions + evidence (V2 format)
  for (const [type, data] of Object.entries(knowledge.fallbacks)) {
    if (data.count >= FALLBACK_THRESHOLD) {
      recommendations.push({
        type: 'MISSING_COMPONENT',
        question: `Should your DS include a component for "${type}"?`,
        evidence: `${data.count} elements across builds used primitives — the pattern is consistent.`,
        evidenceCount: data.count,
        lastSeen: data.lastSeen,
        // V1 compat
        description: `Should your DS include a component for "${type}"? (${data.count} elements, all primitives)`,
      });
    }
  }

  // Unresolved pattern recommendations
  for (const pattern of knowledge.patterns.unresolved) {
    if (pattern.occurrences >= UNRESOLVED_THRESHOLD) {
      recommendations.push({
        type: 'UNRESOLVED_PATTERN',
        question: `Should "${pattern.signature}" be mapped to a DS component?`,
        evidence: `Appeared ${pattern.occurrences} times with no match. A correction or new component would eliminate the fallback.`,
        evidenceCount: pattern.occurrences,
        description: `Should "${pattern.signature}" be mapped? (${pattern.occurrences} occurrences, no match)`,
      });
    }
  }

  // Underperforming component recommendations
  for (const [key, data] of Object.entries(knowledge.components)) {
    if (data.usageCount >= 5 && data.successfulMatches / data.usageCount < 0.5) {
      recommendations.push({
        type: 'LOW_CONFIDENCE_COMPONENT',
        question: `Is "${data.name}" the right match for its pattern?`,
        evidence: `Used ${data.usageCount} times but only ${data.successfulMatches} matched well. The mapping may need a correction.`,
        evidenceCount: data.usageCount,
        description: `Is "${data.name}" correct? (${data.successfulMatches}/${data.usageCount} high-confidence matches)`,
      });
    }
  }

  const output = { recommendations, generatedAt: new Date().toISOString() };

  // Only write if there are recommendations
  if (recommendations.length > 0) {
    writeFileSync(RECOMMENDATIONS_PATH, JSON.stringify(output, null, 2), 'utf8');
  }

  return output;
}


// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate all learning artifacts for a completed build.
 * Safe — never crashes, never blocks the build.
 *
 * @param {Object} pipelineResult — from resolveInput()
 * @returns {Object} summary of what was generated
 */
/**
 * Record a build from a simple summary — works for ANY build path.
 * Does not require pipeline controller. Call this after direct bridge builds.
 *
 * @param {Object} summary
 * @param {string} summary.source — description of build input
 * @param {number} summary.dsComponents — count of DS components inserted
 * @param {number} summary.primitives — count of primitive elements created
 * @param {string[]} summary.componentNames — names of DS components used
 * @param {string[]} summary.fallbackTypes — element types that fell back
 * @param {string} [summary.figmaNodeId] — artboard node ID in Figma
 * @returns {Object} paths to all generated files
 */
export function recordBuild(summary) {
  try {
    ensureDirs();
    const now = new Date();
    const buildId = `build-${now.toISOString().replace(/[:.]/g, '-')}`;

    // Build a minimal artifact
    const resolutionEntries = [];
    for (const name of (summary.componentNames || [])) {
      resolutionEntries.push({
        elementType: 'component',
        intent: { type: 'action', role: null, semantics: [] },
        decision: 'DS_COMPONENT',
        component: { name, key: null },
        confidence: 'high',
      });
    }
    for (const type of (summary.fallbackTypes || [])) {
      resolutionEntries.push({
        elementType: type,
        intent: { type: 'layout', role: null, semantics: [] },
        decision: 'FALLBACK',
        component: { name: null, key: null },
        confidence: 'low',
      });
    }

    // DS compliance summary from bridge responses
    const compliance = summary.dsCompliance || [];
    const complianceSummary = {
      totalNodes: compliance.length,
      dsTextStyle: compliance.filter(c => c?.textStyle === 'ds_style').length,
      rawTextStyle: compliance.filter(c => c?.textStyle === 'raw_fallback').length,
      unresolvedTextStyle: compliance.filter(c => c?.textStyle === 'unresolved').length,
      failedTextStyle: compliance.filter(c => c?.textStyle === 'style_failed').length,
      dsFill: compliance.filter(c => c?.fill === 'ds_variable' || c?.fill === 'ds_style').length,
      rawFill: compliance.filter(c => c?.fill === 'raw_fallback').length,
      unavailableFill: compliance.filter(c => c?.fill === 'ds_style_unavailable').length,
      dsStroke: compliance.filter(c => c?.stroke === 'ds_variable' || c?.stroke === 'ds_style').length,
      rawStroke: compliance.filter(c => c?.stroke === 'raw_fallback').length,
      unavailableStroke: compliance.filter(c => c?.stroke === 'ds_style_unavailable').length,
    };

    const artifact = {
      buildId,
      timestamp: now.toISOString(),
      input: { source: summary.source || 'direct-build', nodeCount: (summary.dsComponents || 0) + (summary.primitives || 0) },
      summary: {
        elementsProcessed: resolutionEntries.length,
        dsMatches: summary.dsComponents || 0,
        fallbacks: summary.primitives || 0,
        errors: 0,
      },
      dsCompliance: complianceSummary,
      resolution: resolutionEntries,
      failures: [],
      signals: { repeatedFallbackTypes: [], unresolvedPatterns: [] },
      figmaNodeId: summary.figmaNodeId || null,
    };

    const artifactPath = persistBuildArtifact(artifact);
    const knowledge = updateKnowledge(artifact);
    const recommendations = generateRecommendations(knowledge);

    // Build summary report — local time, date-grouped
    const reportBaseDir = resolve(PROJECT_ROOT, 'mimic', 'reports');
    const reportDateDir = resolve(reportBaseDir, localDateDir(now));
    if (!existsSync(reportDateDir)) mkdirSync(reportDateDir, { recursive: true });
    const reportPath = resolve(reportDateDir, `${localTimeFile(now)}.md`);

    // V2: Pattern learning summary
    const patternsLearned = summary.patternsLearned || [];
    const patternsUsedFromCache = summary.patternsUsedFromCache || 0;
    const patternsInvalidated = summary.patternsInvalidated || 0;
    const patternsNew = summary.patternsNew || 0;
    const recipesNew = summary.recipesNew || 0;
    const dsGaps = summary.dsGaps || [];

    const report = [
      `# Build Summary`,
      ``,
      `**Date:** ${now.toISOString()}`,
      `**Source:** ${summary.source || 'direct-build'}`,
      summary.figmaNodeId ? `**Figma artboard:** ${summary.figmaNodeId}` : null,
      ``,
      `## Results`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      `| DS components | ${summary.dsComponents || 0} |`,
      `| Primitives | ${summary.primitives || 0} |`,
      `| Total elements | ${(summary.dsComponents || 0) + (summary.primitives || 0)} |`,
      ``,
      summary.componentNames?.length ? `**DS components used:** ${summary.componentNames.join(', ')}` : null,
      ``,
      `## Cache Status`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      `| From cache (validated) | ${patternsUsedFromCache} |`,
      `| Invalidated (DS changed) | ${patternsInvalidated} |`,
      `| New discoveries | ${patternsNew} |`,
      `| Recipes saved | ${recipesNew} |`,
      ``,
      patternsLearned.length > 0 ? `## Patterns Learned\n` : null,
      ...patternsLearned.map(p => `- \`${p.signature}\` → ${p.component_name} (${p.source}, confidence ${p.confidence})`),
      patternsLearned.length > 0 ? `` : null,
      dsGaps.length > 0 ? `## DS Gaps (cumulative)\n` : null,
      dsGaps.length > 0 ? `| Gap | Elements | Recommendation |` : null,
      dsGaps.length > 0 ? `|---|---|---|` : null,
      ...dsGaps.map(g => `| ${g.description} | ${g.affected_elements} | ${g.recommendation} |`),
      dsGaps.length > 0 ? `` : null,
      ``,
      `## DS Compliance`,
      ``,
      `| Token Type | DS-Backed | Raw Fallback | Unresolved |`,
      `|---|---|---|---|`,
      `| Token Type | DS-Backed | Raw Fallback | DS Unavailable | Unresolved |`,
      `|---|---|---|---|---|`,
      `| Text style | ${complianceSummary.dsTextStyle} | ${complianceSummary.rawTextStyle} | ${complianceSummary.failedTextStyle || 0} | ${complianceSummary.unresolvedTextStyle} |`,
      `| Fill | ${complianceSummary.dsFill} | ${complianceSummary.rawFill} | ${complianceSummary.unavailableFill || 0} | — |`,
      `| Stroke | ${complianceSummary.dsStroke} | ${complianceSummary.rawStroke} | ${complianceSummary.unavailableStroke || 0} | — |`,
      complianceSummary.rawTextStyle > 0 ? `\n**⚠ ${complianceSummary.rawTextStyle} text node(s) using raw typography**` : null,
      complianceSummary.rawFill > 0 ? `**⚠ ${complianceSummary.rawFill} node(s) using raw hex fill — no DS match found**` : null,
      complianceSummary.unavailableFill > 0 ? `**⚠ ${complianceSummary.unavailableFill} node(s) — DS fill style selected but import failed**` : null,
      complianceSummary.rawStroke > 0 ? `**⚠ ${complianceSummary.rawStroke} node(s) using raw hex stroke**` : null,
      complianceSummary.unavailableStroke > 0 ? `**⚠ ${complianceSummary.unavailableStroke} node(s) — DS stroke style selected but import failed**` : null,
      ``,
      `## Generated Files`,
      ``,
      `- Build artifact: \`${artifactPath}\``,
      `- Knowledge: \`${COMPONENT_BEHAVIOR_PATH}\``,
      recommendations.recommendations.length > 0 ? `- Recommendations: \`${RECOMMENDATIONS_PATH}\`` : null,
      `- This report: \`${reportPath}\``,
    ].filter(Boolean).join('\n');

    writeFileSync(reportPath, report, 'utf8');

    return {
      success: true,
      buildId,
      artifactPath,
      knowledgePath: COMPONENT_BEHAVIOR_PATH,
      recommendationsPath: recommendations.recommendations.length > 0 ? RECOMMENDATIONS_PATH : null,
      reportPath,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function generateBuildLearning(pipelineResult) {
  try {
    // Stage 1: Build artifact
    const artifact = generateBuildArtifact(pipelineResult);
    const artifactPath = persistBuildArtifact(artifact);

    // Stage 2: Knowledge aggregation
    const knowledge = updateKnowledge(artifact);

    // Stage 3: Recommendations
    const recommendations = generateRecommendations(knowledge);

    return {
      success: true,
      buildArtifactPath: artifactPath,
      buildId: artifact.buildId,
      summary: artifact.summary,
      knowledgeComponents: Object.keys(knowledge.components).length,
      knowledgeFallbacks: Object.keys(knowledge.fallbacks).length,
      recommendations: recommendations.recommendations.length,
    };
  } catch (err) {
    // NEVER crash the build — log and continue
    return {
      success: false,
      error: err.message,
    };
  }
}
