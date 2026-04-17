/**
 * Mimic AI — Signal Intelligence Layer
 *
 * Passive learning layer that captures, compares, and structures signal data
 * from every pipeline execution. Does NOT change runtime decisions.
 *
 * Produces:
 *   - internal/learning/signal-patterns.json  (cumulative signal snapshots)
 *   - internal/learning/recovery-patterns.json (recovery-specific observations)
 *
 * Usage:
 *   import { captureSignals, classifyOutcome, persistLearning } from './signal-intelligence.js';
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = resolve(__dir, '..', 'learning');
const SIGNAL_PATTERNS_PATH = resolve(LEARNING_DIR, 'signal-patterns.json');
const RECOVERY_PATTERNS_PATH = resolve(LEARNING_DIR, 'recovery-patterns.json');

if (!existsSync(LEARNING_DIR)) mkdirSync(LEARNING_DIR, { recursive: true });

// ─── SIGNAL SNAPSHOT ────────────────────────────────────────────────────────

/**
 * Capture a full signal snapshot from a pipeline result.
 * Extracts all signal data into a flat, comparable structure.
 */
export function captureSignals(pipelineResult) {
  const readiness = pipelineResult.renderResult?.readiness?.signals || null;
  const authValidity = pipelineResult.authValidity || null;
  const recovery = pipelineResult.recovery || null;

  return {
    timestamp: new Date().toISOString(),
    url: pipelineResult.url || null,
    status: pipelineResult.status,

    classification: pipelineResult.classification?.classification || null,
    classificationSignals: pipelineResult.classification?.signals || null,

    renderRequired: pipelineResult.renderRequired || false,
    renderDurationMs: pipelineResult.renderResult?.durationMs || null,

    readiness: readiness ? {
      textLength: readiness.textLength,
      nodeCount: readiness.nodeCount,
      loadingElements: readiness.loadingElements,
      structuralCount: readiness.structuralCount,
      interactiveCount: readiness.interactiveCount,
    } : null,

    authAcquisition: pipelineResult.authAcquisition ? {
      status: pipelineResult.authAcquisition.status,
      method: pipelineResult.authAcquisition.method,
      cookieCount: pipelineResult.authAcquisition.cookieCount,
    } : null,

    authValidity: authValidity ? {
      classification: authValidity.classification,
      confidence: authValidity.confidence,
      isValid: authValidity.isValid,
    } : null,

    recovery: recovery ? {
      attempted: recovery.attempted,
      reason: recovery.reason,
      succeeded: recovery.succeeded,
      newClassification: recovery.newClassification || null,
      newConfidence: recovery.newConfidence || null,
    } : null,

    totalDurationMs: pipelineResult.durationMs || null,
  };
}

// ─── RECOVERY DELTA ─────────────────────────────────────────────────────────

/**
 * Compute signal delta between initial and recovery renders.
 * Only meaningful when recovery was attempted.
 */
export function computeRecoveryDelta(initialSignals, recoverySignals) {
  if (!initialSignals || !recoverySignals) return null;

  const fields = ['textLength', 'nodeCount', 'loadingElements', 'structuralCount', 'interactiveCount'];
  const delta = {};

  for (const field of fields) {
    const before = initialSignals[field] ?? null;
    const after = recoverySignals[field] ?? null;
    if (before !== null && after !== null) {
      delta[field] = { before, after, change: after - before };
    }
  }

  return delta;
}

// ─── OUTCOME CLASSIFICATION ─────────────────────────────────────────────────

/**
 * Classify the build outcome based on pipeline result.
 *
 * Categories:
 *   STRONG_VALID      — high confidence, strong signals
 *   WEAK_VALID        — passes but near thresholds
 *   RECOVERED_VALID   — ambiguous → recovered to valid
 *   HARD_FAILURE      — definite invalid (login, expired, redirect)
 *   AMBIGUOUS_FAILURE — failed after recovery attempt
 *   DIRECT_PASS       — no rendering needed, direct HTML
 *   RENDER_FAILURE    — rendering itself failed
 */
export function classifyOutcome(pipelineResult) {
  const status = pipelineResult.status;
  const authClass = pipelineResult.authValidity?.classification;
  const confidence = pipelineResult.authValidity?.confidence || 0;
  const recovery = pipelineResult.recovery;
  const renderRequired = pipelineResult.renderRequired;

  if (status === 'READY' && !renderRequired) {
    return 'DIRECT_PASS';
  }

  if (status === 'READY' && recovery?.attempted && recovery?.succeeded) {
    return 'RECOVERED_VALID';
  }

  if (status === 'READY' && confidence >= 0.9) {
    return 'STRONG_VALID';
  }

  if (status === 'READY' && confidence < 0.9) {
    return 'WEAK_VALID';
  }

  if (status === 'FAILURE' && recovery?.attempted && !recovery?.succeeded) {
    return 'AMBIGUOUS_FAILURE';
  }

  if (status === 'FAILURE' && pipelineResult.renderResult?.status === 'FAILURE') {
    return 'RENDER_FAILURE';
  }

  if (status === 'FAILURE' && (
    authClass === 'AUTH_INVALID_LOGIN_PAGE' ||
    authClass === 'AUTH_INVALID_EXPIRED_SESSION' ||
    authClass === 'AUTH_INVALID_PARTIAL_GATE' ||
    authClass === 'AUTH_INVALID_REDIRECT_LOOP'
  )) {
    return 'HARD_FAILURE';
  }

  return 'UNKNOWN_OUTCOME';
}

// ─── THRESHOLD PRESSURE DETECTION ───────────────────────────────────────────

/**
 * Analyze cumulative signal patterns for threshold pressure.
 * Detects:
 *   - frequent WEAK_VALID (near-miss positive)
 *   - frequent RECOVERED_VALID (ambiguity is common)
 *   - frequent AMBIGUOUS_FAILURE (threshold may be too strict)
 */
export function detectThresholdPressure(patterns) {
  if (!patterns || patterns.length < 3) return { alerts: [] };

  const recent = patterns.slice(-20); // Last 20 entries
  const counts = {};
  for (const p of recent) {
    counts[p.outcome] = (counts[p.outcome] || 0) + 1;
  }

  const alerts = [];
  const total = recent.length;

  if ((counts.WEAK_VALID || 0) / total > 0.3) {
    alerts.push({
      type: 'FREQUENT_WEAK_VALID',
      rate: ((counts.WEAK_VALID || 0) / total * 100).toFixed(0) + '%',
      suggestion: 'Many builds pass with low confidence. Consider investigating common signal patterns to tighten or relax thresholds.',
    });
  }

  if ((counts.RECOVERED_VALID || 0) / total > 0.2) {
    alerts.push({
      type: 'FREQUENT_RECOVERY',
      rate: ((counts.RECOVERED_VALID || 0) / total * 100).toFixed(0) + '%',
      suggestion: 'Ambiguity is common. Initial thresholds may be too strict, or pages commonly load slowly.',
    });
  }

  if ((counts.AMBIGUOUS_FAILURE || 0) / total > 0.2) {
    alerts.push({
      type: 'FREQUENT_AMBIGUOUS_FAILURE',
      rate: ((counts.AMBIGUOUS_FAILURE || 0) / total * 100).toFixed(0) + '%',
      suggestion: 'Many builds fail on ambiguity even after recovery. Thresholds may need calibration or new signals.',
    });
  }

  return { alerts, counts, total };
}

// ─── PERSISTENCE ────────────────────────────────────────────────────────────

function loadJSON(path) {
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Persist a signal snapshot and outcome to learning artifacts.
 * Appends to cumulative files. Safe to call on every build.
 */
export function persistLearning(pipelineResult) {
  const signals = captureSignals(pipelineResult);
  const outcome = classifyOutcome(pipelineResult);

  // Build signal pattern entry
  const entry = {
    ...signals,
    outcome,
  };

  // Append to signal-patterns.json
  const patterns = loadJSON(SIGNAL_PATTERNS_PATH);
  patterns.push(entry);
  // Keep last 100 entries to prevent unbounded growth
  const trimmed = patterns.slice(-100);
  saveJSON(SIGNAL_PATTERNS_PATH, trimmed);

  // If recovery was attempted, also log to recovery-patterns.json
  if (pipelineResult.recovery?.attempted) {
    const recoveryEntry = {
      timestamp: signals.timestamp,
      url: signals.url,
      outcome,
      initialAuthValidity: pipelineResult.authValidity ? {
        classification: pipelineResult.authValidity.classification,
        confidence: pipelineResult.authValidity.confidence,
      } : null,
      recovery: signals.recovery,
      delta: computeRecoveryDelta(
        signals.readiness,
        // Recovery signals would need to be captured separately; for now use what's available
        pipelineResult.recovery?.newSignals || null
      ),
    };

    const recoveryPatterns = loadJSON(RECOVERY_PATTERNS_PATH);
    recoveryPatterns.push(recoveryEntry);
    saveJSON(RECOVERY_PATTERNS_PATH, recoveryPatterns.slice(-50));
  }

  // Run threshold pressure detection
  const pressure = detectThresholdPressure(trimmed);

  return { outcome, pressure, entryCount: trimmed.length };
}
