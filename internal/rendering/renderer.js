/**
 * Mimic AI — Rendering Layer
 *
 * Handles client-rendered pages by launching a headless browser,
 * waiting for meaningful UI hydration, and extracting the rendered DOM.
 *
 * This module sits between input resolution and the build pipeline:
 *   Input Resolution → Rendering Layer → Rendered DOM → Build Pipeline
 *
 * Usage:
 *   node internal/rendering/renderer.js <url> [--output <path>] [--timeout <ms>] [--auth-cookies <json-path>]
 *
 * Or as a module:
 *   import { renderPage } from './renderer.js';
 *   const result = await renderPage({ url, outputPath, timeout, cookies });
 */

import puppeteer from 'puppeteer';
import { extractRenderedLayout } from '../layout/rendered-layout-extractor.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(__dir, '..', 'builds');
const DEFAULT_TIMEOUT = 30000;
const STABILITY_INTERVAL = 500;
const STABILITY_CHECKS = 4;
const MIN_TEXT_DENSITY = 50;
const MIN_MEANINGFUL_NODES = 20;

// ─── READINESS DETECTION ────────────────────────────────────────────────────

/**
 * Generic readiness model.
 * Combines multiple signals to determine if a page has finished rendering.
 * No app-specific selectors or product-specific assumptions.
 */
async function checkReadiness(page) {
  return await page.evaluate(() => {
    const body = document.body;
    if (!body) return { ready: false, reason: 'no_body', signals: {} };

    // Signal 1: Text density — meaningful text content beyond shell markup
    const textContent = body.innerText || '';
    const textLength = textContent.trim().length;

    // Signal 2: Node count — rendered DOM should have significant structure
    const allNodes = body.querySelectorAll('*');
    const nodeCount = allNodes.length;

    // Signal 3: Loading indicators absent
    const loadingSelectors = [
      '[class*="loading"]', '[class*="spinner"]', '[class*="skeleton"]',
      '[class*="loader"]', '[aria-busy="true"]', '[data-loading="true"]',
      '[class*="shimmer"]', '[class*="placeholder"]'
    ];
    const loadingElements = loadingSelectors.reduce((count, sel) => {
      try { return count + document.querySelectorAll(sel).length; } catch { return count; }
    }, 0);

    // Signal 4: Meaningful structural regions
    const structuralTags = ['nav', 'header', 'main', 'section', 'article', 'aside', 'footer', 'table'];
    const structuralCount = structuralTags.reduce((count, tag) => {
      return count + document.querySelectorAll(tag).length;
    }, 0);

    // Signal 5: Interactive elements present (buttons, links, inputs)
    const interactiveCount = document.querySelectorAll('button, a[href], input, select, textarea').length;

    // Signal 6: Images loaded
    const images = document.querySelectorAll('img');
    const loadedImages = Array.from(images).filter(img => img.complete).length;
    const totalImages = images.length;

    const signals = {
      textLength,
      nodeCount,
      loadingElements,
      structuralCount,
      interactiveCount,
      imagesLoaded: totalImages > 0 ? `${loadedImages}/${totalImages}` : 'none',
    };

    // Decision model
    const hasText = textLength >= 50;
    const hasStructure = nodeCount >= 20;
    const noLoading = loadingElements === 0;
    const hasRegions = structuralCount >= 1;
    const hasInteractive = interactiveCount >= 1;

    const readyScore = [hasText, hasStructure, noLoading, hasRegions, hasInteractive]
      .filter(Boolean).length;

    // Ready if 4+ of 5 signals pass, OR if 3+ pass and no loading indicators
    const ready = (readyScore >= 4) || (readyScore >= 3 && noLoading);

    return { ready, readyScore, maxScore: 5, signals };
  });
}

/**
 * Wait for DOM stability — the DOM should stop changing.
 * Measures mutation count over intervals. When mutations approach zero,
 * the page is considered stable.
 */
async function waitForStability(page, interval = STABILITY_INTERVAL, checks = STABILITY_CHECKS) {
  let stableCount = 0;

  for (let i = 0; i < checks * 3; i++) {
    const mutations = await page.evaluate(() => {
      return new Promise(resolve => {
        let count = 0;
        const observer = new MutationObserver(mutations => { count += mutations.length; });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        setTimeout(() => { observer.disconnect(); resolve(count); }, 400);
      });
    });

    if (mutations <= 2) {
      stableCount++;
      if (stableCount >= checks) return true;
    } else {
      stableCount = 0;
    }

    await new Promise(r => setTimeout(r, interval));
  }

  return false;
}

// ─── FAILURE CLASSIFICATION ─────────────────────────────────────────────────

function classifyFailure(error, readinessResult, timedOut) {
  if (error?.message?.includes('net::ERR_NAME_NOT_RESOLVED')) return 'NAVIGATION_FAILURE';
  if (error?.message?.includes('net::ERR_CONNECTION_REFUSED')) return 'NAVIGATION_FAILURE';
  if (error?.message?.includes('401') || error?.message?.includes('403')) return 'AUTH_WALL_DETECTED';
  if (timedOut && readinessResult?.signals?.loadingElements > 0) return 'ENDLESS_LOADING';
  if (timedOut && (readinessResult?.signals?.nodeCount || 0) < MIN_MEANINGFUL_NODES) return 'SHELL_ONLY_AFTER_TIMEOUT';
  if (readinessResult && !readinessResult.ready) return 'RENDERED_DOM_TOO_WEAK';
  return 'UNKNOWN_FAILURE';
}

// ─── CORE RENDER FUNCTION ───────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {string} options.url — URL to render
 * @param {string} [options.outputPath] — where to save rendered HTML
 * @param {number} [options.timeout] — max wait time in ms
 * @param {Array}  [options.cookies] — array of cookie objects for auth
 * @returns {Object} render result with status, path, signals, timing
 */
export async function renderPage(options) {
  const {
    url,
    outputPath,
    timeout = DEFAULT_TIMEOUT,
    cookies = [],
    puppeteerLaunchOptions = null,
  } = options;

  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = outputPath || resolve(DEFAULT_OUTPUT_DIR, `rendered-${timestamp}.html`);

  // Ensure output directory exists
  const outDir = dirname(outputFile);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let browser, page;
  let readinessResult = null;
  let stable = false;
  let error = null;
  let timedOut = false;

  const result = {
    status: 'PENDING',
    url,
    outputPath: outputFile,
    startTime: new Date(startTime).toISOString(),
    endTime: null,
    durationMs: null,
    readiness: null,
    stability: null,
    failureMode: null,
    renderedNodeCount: null,
    renderedTextLength: null,
  };

  try {
    // Launch headless browser — use auth-provided options if available
    const launchOptions = puppeteerLaunchOptions || {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    browser = await puppeteer.launch(launchOptions);

    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Set cookies for auth if provided
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    // Navigate
    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    // Wait for readiness with polling
    const readinessStart = Date.now();
    const readinessTimeout = timeout - (Date.now() - startTime);

    while (Date.now() - readinessStart < readinessTimeout) {
      readinessResult = await checkReadiness(page);
      if (readinessResult.ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!readinessResult?.ready) {
      timedOut = true;
    }

    // Wait for DOM stability
    if (readinessResult?.ready) {
      stable = await waitForStability(page);
    }

    // Extract rendered DOM
    const renderedHTML = await page.content();
    const finalCheck = await checkReadiness(page);

    // Extract computed layout data while page is still live
    let layoutData = null;
    try {
      layoutData = await extractRenderedLayout(page);
    } catch (e) {
      // Layout extraction failure is non-fatal
    }

    // Save rendered HTML
    writeFileSync(outputFile, renderedHTML, 'utf8');

    // Save layout data alongside HTML
    if (layoutData) {
      const layoutFile = outputFile.replace('.html', '.layout.json');
      writeFileSync(layoutFile, JSON.stringify(layoutData, null, 2), 'utf8');
      result.layoutDataPath = layoutFile;
      result.layoutRecords = layoutData.length;
    }

    // Populate result
    result.status = readinessResult?.ready ? 'SUCCESS' : 'WEAK_RENDER';
    result.readiness = finalCheck;
    result.stability = stable;
    result.renderedNodeCount = finalCheck.signals?.nodeCount;
    result.renderedTextLength = finalCheck.signals?.textLength;

    if (!readinessResult?.ready) {
      result.status = 'FAILURE';
      result.failureMode = classifyFailure(null, readinessResult, timedOut);
    }

  } catch (err) {
    error = err;
    result.status = 'FAILURE';
    result.failureMode = classifyFailure(err, readinessResult, false);
    result.error = err.message;
  } finally {
    if (browser) await browser.close();

    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    // Save render result artifact
    const resultFile = outputFile.replace('.html', '.result.json');
    writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
  }

  return result;
}

// ─── CLI ENTRY POINT ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-')) {
  const url = args[0];
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  const timeoutIdx = args.indexOf('--timeout');
  const timeout = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]) : DEFAULT_TIMEOUT;
  const cookieIdx = args.indexOf('--auth-cookies');
  let cookies = [];
  if (cookieIdx >= 0) {
    try { cookies = JSON.parse(readFileSync(args[cookieIdx + 1], 'utf8')); } catch {}
  }

  renderPage({ url, outputPath, timeout, cookies }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'SUCCESS' ? 0 : 1);
  });
}
