/**
 * Mimic AI — Pipeline Controller
 *
 * Deterministic execution controller that sits between input resolution
 * and build execution. Removes all decision ambiguity from Claude.
 *
 * Flow:
 *   Input → Classification → Pipeline Controller → Rendering (if needed) → Build
 *
 * Rules:
 *   DIRECT_HTML           → pass HTML directly to build
 *   RENDERED_DOM_REQUIRED → ALWAYS call renderer, wait, validate result
 *   Render SUCCESS        → reclassify as DIRECT_HTML, continue
 *   Render FAILURE        → stop pipeline, return structured failure
 *
 * Usage (MCP tool):
 *   Called via mimic_pipeline_resolve — Claude provides URL, controller does the rest.
 *
 * Usage (module):
 *   import { resolveInput } from './pipeline-controller.js';
 *   const result = await resolveInput({ url, cookies, timeout });
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderPage } from './renderer.js';
import { acquireAuth, cleanupAuth } from './auth-acquire.js';
import { validateAuthValidity } from './auth-validity.js';
import { persistLearning } from './signal-intelligence.js';
// Build execution is handled by Claude-orchestrated builds (canonical path).
// This module only handles input resolution and rendering.

const __dir = dirname(fileURLToPath(import.meta.url));
const BUILDS_DIR = resolve(__dir, '..', 'builds');
const LOGS_DIR = resolve(__dir, '..', 'builds', 'pipeline-logs');

// Ensure directories exist
if (!existsSync(BUILDS_DIR)) mkdirSync(BUILDS_DIR, { recursive: true });
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ─── CLASSIFICATION ─────────────────────────────────────────────────────────

/**
 * Classify raw HTML content.
 * Returns DIRECT_HTML or RENDERED_DOM_REQUIRED.
 * No ambiguity — binary decision based on measurable signals.
 */
function classifyHTML(html) {
  if (!html || typeof html !== 'string') {
    return { classification: 'RENDERED_DOM_REQUIRED', reason: 'No HTML content provided' };
  }

  // Strip scripts and styles for content analysis
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const textLength = stripped.length;
  const nodeCount = (html.match(/<[a-z][^>]*>/gi) || []).length;

  // Structural tags that indicate real UI
  const structuralTags = ['<nav', '<header', '<main', '<section', '<article', '<aside', '<footer', '<table'];
  const structuralCount = structuralTags.reduce((count, tag) =>
    count + (html.match(new RegExp(tag, 'gi')) || []).length, 0);

  // Framework shell indicators — tags that signal JS-rendered scaffolding
  const frameworkShellTerms = ['__next', '__nuxt', 'app-root', 'ng-app'];
  const loadingTerms = ['loading', 'spinner', 'skeleton', 'shimmer'];
  const buildTerms = ['webpack', 'chunk', '_buildManifest', 'hydrat'];

  const frameworkScore = frameworkShellTerms.reduce((c, t) => c + (html.toLowerCase().includes(t) ? 1 : 0), 0);
  const loadingScore = loadingTerms.reduce((c, t) => c + (html.toLowerCase().includes(t) ? 1 : 0), 0);
  const buildScore = buildTerms.reduce((c, t) => c + (html.toLowerCase().includes(t) ? 1 : 0), 0);
  const shellScore = frameworkScore + loadingScore + buildScore;

  // Interactive elements present (real UI, not just scaffold)
  const interactiveCount = (html.match(/<(button|a\s|input|select|textarea)/gi) || []).length;

  const signals = { textLength, nodeCount, structuralCount, shellScore, frameworkScore, loadingScore, buildScore, interactiveCount };

  // Decision logic:
  // A page is DIRECT_HTML if it has real content, regardless of simplicity.
  // A page needs rendering only if it's a framework shell with little real content.
  //
  // DIRECT_HTML if ANY of:
  //   1. Has text + structure and low shell score (normal HTML page)
  //   2. Has text content and no framework indicators (simple page like example.com)
  //
  // RENDERED_DOM_REQUIRED if:
  //   Framework shell detected AND content is thin
  const hasRealContent = textLength > 50 && (nodeCount > 10 || interactiveCount > 0);
  const isFrameworkShell = frameworkScore > 0 && textLength < 300;
  const isLoadingOnly = loadingScore > 0 && textLength < 300 && interactiveCount < 3;

  const isDirect = hasRealContent && !isFrameworkShell && !isLoadingOnly;

  return {
    classification: isDirect ? 'DIRECT_HTML' : 'RENDERED_DOM_REQUIRED',
    reason: isDirect
      ? `Meaningful HTML: ${textLength} chars, ${nodeCount} nodes, ${structuralCount} regions`
      : `Insufficient content: ${textLength} chars, ${nodeCount} nodes, ${structuralCount} regions, shellScore ${shellScore}`,
    signals
  };
}

// ─── FETCH ──────────────────────────────────────────────────────────────────

/**
 * Fetch raw HTML from a URL.
 * Returns { ok, html, status } or { ok: false, error }.
 */
async function fetchHTML(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mimic-AI/1.0 (HTML-to-Figma renderer)' },
      redirect: 'follow',
    });
    const html = await res.text();
    return { ok: true, html, status: res.status };
  } catch (err) {
    return { ok: false, html: null, status: null, error: err.message };
  }
}

// ─── PIPELINE LOG ───────────────────────────────────────────────────────────

function logPipelineEvent(event) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = resolve(LOGS_DIR, `pipeline-${timestamp}.json`);
  writeFileSync(logFile, JSON.stringify(event, null, 2), 'utf8');
  return logFile;
}

// ─── CORE PIPELINE RESOLVER ─────────────────────────────────────────────────

/**
 * Deterministic pipeline resolver.
 *
 * @param {Object} options
 * @param {string} options.url — URL to resolve
 * @param {string} [options.htmlContent] — pre-fetched HTML (skip fetch step)
 * @param {string} [options.htmlFilePath] — path to local HTML file (skip fetch + classify as DIRECT_HTML)
 * @param {number} [options.timeout] — render timeout in ms
 * @param {Array}  [options.cookies] — auth cookies for renderer
 * @param {Array}  [options.dsComponents] — DS search results for inventory building
 * @param {Object} [options.dsContext] — map of componentKey → context data
 * @param {Object} [options.buildContext] — { pageId, parentNodeId, designSystemFileKey }
 * @returns {Object} pipeline result with build plan when READY
 */
export async function resolveInput(options) {
  const { url, htmlContent, htmlFilePath, timeout = 30000, cookies = [] } = options;
  const startTime = Date.now();

  const pipelineResult = {
    status: 'PENDING',
    inputType: null,
    classification: null,
    renderRequired: false,
    renderResult: null,
    outputPath: null,
    outputClassification: null,
    durationMs: null,
    error: null,
    logFile: null,
  };

  try {
    // ── STEP 1: Determine input source ──────────────────────────────────

    let html = null;

    if (htmlFilePath) {
      // Local file — skip fetch, classify directly
      if (!existsSync(htmlFilePath)) {
        throw new Error(`HTML file not found: ${htmlFilePath}`);
      }
      html = readFileSync(htmlFilePath, 'utf8');
      pipelineResult.inputType = 'LOCAL_FILE';

    } else if (htmlContent) {
      // Pre-fetched content — classify directly
      html = htmlContent;
      pipelineResult.inputType = 'PRE_FETCHED';

    } else if (url) {
      // Fetch from URL
      const fetchResult = await fetchHTML(url);
      if (!fetchResult.ok) {
        throw new Error(`Fetch failed: ${fetchResult.error}`);
      }
      html = fetchResult.html;
      pipelineResult.inputType = 'URL_FETCH';

    } else {
      throw new Error('No input provided. Provide url, htmlContent, or htmlFilePath.');
    }

    // ── STEP 2: Classify — deterministic, no ambiguity ──────────────────

    const classification = classifyHTML(html);
    pipelineResult.classification = classification;

    // ── STEP 3: Execute based on classification ─────────────────────────

    if (classification.classification === 'DIRECT_HTML') {
      // Save the HTML and proceed
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = htmlFilePath || resolve(BUILDS_DIR, `direct-${timestamp}.html`);
      if (!htmlFilePath) {
        writeFileSync(outputFile, html, 'utf8');
      }
      pipelineResult.status = 'READY';
      pipelineResult.renderRequired = false;
      pipelineResult.outputPath = outputFile;
      pipelineResult.outputClassification = 'DIRECT_HTML';

    } else if (classification.classification === 'RENDERED_DOM_REQUIRED') {
      // MUST render — no exceptions, no skipping
      if (!url) {
        throw new Error('RENDERED_DOM_REQUIRED but no URL available for headless rendering.');
      }
      pipelineResult.renderRequired = true;

      // Auth acquisition: if no cookies provided, attempt automatic acquisition
      let effectiveCookies = cookies;
      let puppeteerLaunchOptions = null;
      let authResultForCleanup = null;

      if (effectiveCookies.length === 0 && url) {
        try {
          const urlObj = new URL(url);
          // Extract base domain for cookie search (e.g., app.layerlens.ai → layerlens.ai)
          const hostParts = urlObj.hostname.split('.');
          const baseDomain = hostParts.length > 2 ? hostParts.slice(-2).join('.') : urlObj.hostname;
          const authResult = await acquireAuth({ domain: baseDomain });
          authResultForCleanup = authResult;
          pipelineResult.authAcquisition = {
            attempted: true,
            method: authResult.method,
            status: authResult.status,
            cookieCount: authResult.cookieCount,
            profileUsed: authResult.profileUsed,
            failureMode: authResult.failureMode,
            durationMs: authResult.durationMs,
          };
          if (authResult.status === 'SUCCESS') {
            if (authResult.puppeteerOptions) {
              // Profile-based auth: pass launch options to renderer
              puppeteerLaunchOptions = authResult.puppeteerOptions;
            }
            if (authResult.cookies?.length > 0) {
              // Cookie-based auth: pass cookies to renderer
              effectiveCookies = authResult.cookies;
            }
          }
          // Auth failure is NOT a pipeline failure — page may be public after JS render.
        } catch (authErr) {
          pipelineResult.authAcquisition = {
            attempted: true,
            status: 'FAILURE',
            failureMode: 'AUTH_ACQUISITION_ERROR',
            error: authErr.message,
          };
        }
      } else if (effectiveCookies.length > 0) {
        pipelineResult.authAcquisition = { attempted: false, reason: 'cookies_provided_externally' };
      }

      const renderResult = await renderPage({ url, timeout, cookies: effectiveCookies, puppeteerLaunchOptions });

      // Cleanup auth temp resources
      if (authResultForCleanup) cleanupAuth(authResultForCleanup);
      pipelineResult.renderResult = {
        status: renderResult.status,
        durationMs: renderResult.durationMs,
        failureMode: renderResult.failureMode,
        renderedNodeCount: renderResult.renderedNodeCount,
        renderedTextLength: renderResult.renderedTextLength,
        readiness: renderResult.readiness,
        stability: renderResult.stability,
        layoutDataPath: renderResult.layoutDataPath || null,
        layoutRecords: renderResult.layoutRecords || 0,
      };

      if (renderResult.status === 'SUCCESS') {
        // Step A: Validate render readiness (content exists)
        const readiness = renderResult.readiness;
        const hasMeaningfulContent = (readiness?.signals?.textLength || 0) > 100
          && (readiness?.signals?.nodeCount || 0) > 20;

        if (!readiness?.ready || !hasMeaningfulContent) {
          pipelineResult.status = 'FAILURE';
          pipelineResult.error = `Rendered DOM too weak: ${readiness?.signals?.textLength || 0} chars, ${readiness?.signals?.nodeCount || 0} nodes`;
          pipelineResult.outputClassification = 'RENDERED_DOM_TOO_WEAK';
        } else {
          // Step B: Validate auth validity (is this the real app, not a login page?)
          const renderedHTML = readFileSync(renderResult.outputPath, 'utf8');
          const authValidity = validateAuthValidity(renderedHTML, readiness?.signals);
          pipelineResult.authValidity = {
            classification: authValidity.classification,
            confidence: authValidity.confidence,
            reason: authValidity.reason,
            isValid: authValidity.isValid,
            durationMs: authValidity.durationMs,
          };

          if (authValidity.isValid) {
            pipelineResult.status = 'READY';
            pipelineResult.outputPath = renderResult.outputPath;
            pipelineResult.outputClassification = 'DIRECT_HTML';

          } else if (authValidity.classification === 'AUTH_STATE_AMBIGUOUS') {
            // ── RECOVERY: one bounded retry for ambiguous states ──────────
            // Re-render with +5s extra wait, then re-evaluate.
            // Max 1 retry. No loops. Deterministic.
            pipelineResult.recovery = { attempted: true, reason: 'AUTH_STATE_AMBIGUOUS' };

            const recoveryRender = await renderPage({
              url, timeout: 5000 + timeout, cookies: effectiveCookies, puppeteerLaunchOptions
            });

            if (recoveryRender.status === 'SUCCESS') {
              const recoveryHTML = readFileSync(recoveryRender.outputPath, 'utf8');
              const recoveryCheck = validateAuthValidity(recoveryHTML, recoveryRender.readiness?.signals);

              pipelineResult.recovery.newClassification = recoveryCheck.classification;
              pipelineResult.recovery.newConfidence = recoveryCheck.confidence;
              pipelineResult.recovery.newReason = recoveryCheck.reason;
              pipelineResult.recovery.succeeded = recoveryCheck.isValid;

              if (recoveryCheck.isValid) {
                pipelineResult.status = 'READY';
                pipelineResult.outputPath = recoveryRender.outputPath;
                pipelineResult.outputClassification = 'DIRECT_HTML';
                pipelineResult.authValidity = {
                  classification: recoveryCheck.classification,
                  confidence: recoveryCheck.confidence,
                  reason: `Recovered: ${recoveryCheck.reason}`,
                  isValid: true,
                  durationMs: recoveryCheck.durationMs,
                };
              } else {
                pipelineResult.status = 'FAILURE';
                pipelineResult.error = `Auth ambiguous after recovery: ${recoveryCheck.classification} — ${recoveryCheck.reason}`;
                pipelineResult.outputClassification = recoveryCheck.classification;
              }
            } else {
              pipelineResult.recovery.succeeded = false;
              pipelineResult.recovery.renderFailed = true;
              pipelineResult.status = 'FAILURE';
              pipelineResult.error = `Recovery render failed: ${recoveryRender.failureMode}`;
            }

          } else {
            // Definite auth failure (login page, expired session, etc.) — no recovery
            pipelineResult.status = 'FAILURE';
            pipelineResult.error = `Auth invalid: ${authValidity.classification} — ${authValidity.reason}`;
            pipelineResult.outputClassification = authValidity.classification;
          }
        }
      } else {
        // Render failed
        pipelineResult.status = 'FAILURE';
        pipelineResult.error = `Rendering failed: ${renderResult.failureMode}`;
      }
    }

  } catch (err) {
    pipelineResult.status = 'FAILURE';
    pipelineResult.error = err.message;
  }

  // ── STEP 4: Log and learn ────────────────────────────────────────────

  pipelineResult.durationMs = Date.now() - startTime;
  pipelineResult.url = url;

  pipelineResult.logFile = logPipelineEvent({
    ...pipelineResult,
    timestamp: new Date().toISOString(),
  });

  // Signal intelligence: persist learning from this execution (passive, no behavior change)
  try {
    const learning = persistLearning(pipelineResult);
    pipelineResult.signalIntelligence = learning;
  } catch (e) {
    // Learning failure must never block the pipeline
    pipelineResult.signalIntelligence = { error: e.message };
  }

  return pipelineResult;
}

// ─── CLI ENTRY POINT ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-')) {
  const url = args[0];
  const timeoutIdx = args.indexOf('--timeout');
  const timeout = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) : 30000;

  resolveInput({ url, timeout }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'READY' ? 0 : 1);
  });
}
