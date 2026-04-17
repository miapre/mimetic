/**
 * Mimic AI — Auth Validity Layer
 *
 * Validates that rendered HTML is actually the intended authenticated UI,
 * not a login page, expired session, auth wall, or redirect artifact.
 *
 * Sits after render success, before pipeline READY.
 * Uses multiple generic signals — no product-specific selectors.
 *
 * Usage:
 *   import { validateAuthValidity } from './auth-validity.js';
 *   const result = validateAuthValidity(htmlString, readinessSignals);
 */

// ─── SIGNAL DETECTORS ──────────────────────────────────────────────────────

/**
 * Detect login page signals in rendered HTML.
 * All checks are generic — no product-specific selectors.
 */
function detectLoginSignals(html) {
  const lower = html.toLowerCase();

  // Signal 1: Password input fields
  const passwordFields = (html.match(/<input[^>]*type\s*=\s*["']password["'][^>]*>/gi) || []).length;

  // Signal 2: Email + password form combination
  const emailFields = (html.match(/<input[^>]*type\s*=\s*["'](email|text)["'][^>]*>/gi) || [])
    .filter(input => {
      const il = input.toLowerCase();
      return il.includes('email') || il.includes('user') || il.includes('login') || il.includes('account');
    }).length;

  // Signal 3: Auth-related submit patterns (in form context)
  const authSubmitTerms = ['sign in', 'log in', 'login', 'signin', 'sign up', 'register',
    'create account', 'forgot password', 'reset password', 'continue with',
    'sign in with', 'log in with', 'authenticate', 'sso', 'single sign'];
  const authSubmitScore = authSubmitTerms.reduce((count, term) =>
    count + (lower.includes(term) ? 1 : 0), 0);

  // Signal 4: OAuth provider buttons (generic patterns)
  const oauthPatterns = ['google', 'github', 'microsoft', 'apple', 'facebook', 'okta',
    'auth0', 'cognito', 'oauth', 'saml', 'openid'];
  const oauthScore = oauthPatterns.reduce((count, term) => {
    // Only count if near a button/link context
    const pattern = new RegExp(`<(button|a)[^>]*>[^<]*${term}[^<]*</(button|a)>`, 'gi');
    return count + (html.match(pattern) || []).length;
  }, 0);

  // Signal 5: Form elements dominate the page
  const formCount = (html.match(/<form/gi) || []).length;
  const totalElements = (html.match(/<[a-z][^>]*>/gi) || []).length;
  const formDominance = totalElements > 0 ? formCount / totalElements : 0;

  return {
    passwordFields,
    emailFields,
    authSubmitScore,
    oauthScore,
    formCount,
    formDominance,
  };
}

/**
 * Detect expired session or partial auth state signals.
 */
function detectExpiredSessionSignals(html) {
  const lower = html.toLowerCase();

  // Signal 1: Session expiry messages
  const expiryTerms = ['session expired', 'session timed out', 'session has ended',
    'been logged out', 'been signed out', 'no longer authenticated',
    'please log in again', 'please sign in again', 'token expired',
    'access denied', 'unauthorized', '401', '403'];
  const expiryScore = expiryTerms.reduce((count, term) =>
    count + (lower.includes(term) ? 1 : 0), 0);

  // Signal 2: Redirect indicators in HTML
  const metaRefresh = (html.match(/<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/gi) || []).length;
  const jsRedirect = (lower.match(/window\.location|location\.href|location\.replace/g) || []).length;

  // Signal 3: Nearly empty page with only redirect or message
  const strippedText = html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const textLength = strippedText.length;
  const isNearlyEmpty = textLength < 200;

  return {
    expiryScore,
    metaRefresh,
    jsRedirect,
    textLength,
    isNearlyEmpty,
  };
}

/**
 * Detect structural complexity signals.
 * Authenticated app UI typically has high structural diversity.
 * Login pages typically have low diversity.
 */
function detectComplexitySignals(html, readinessSignals) {
  const nodeCount = readinessSignals?.nodeCount || (html.match(/<[a-z][^>]*>/gi) || []).length;
  const structuralTags = ['nav', 'header', 'main', 'section', 'article', 'aside', 'footer', 'table', 'ul', 'ol'];
  const structuralCount = structuralTags.reduce((count, tag) =>
    count + (html.match(new RegExp(`<${tag}`, 'gi')) || []).length, 0);

  const interactiveCount = readinessSignals?.interactiveCount ||
    (html.match(/<(button|a\s|input|select|textarea)/gi) || []).length;

  // Unique tag types used (diversity indicator)
  const tagMatches = html.match(/<([a-z][a-z0-9]*)/gi) || [];
  const uniqueTags = new Set(tagMatches.map(t => t.slice(1).toLowerCase()));

  // Tables, lists, grids — indicators of data-rich app UI
  const dataPatterns = (html.match(/<(table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd)/gi) || []).length;

  return {
    nodeCount,
    structuralCount,
    interactiveCount,
    uniqueTagCount: uniqueTags.size,
    dataPatterns,
    // Ratio: structural regions per 100 nodes
    structuralDensity: nodeCount > 0 ? (structuralCount / nodeCount) * 100 : 0,
  };
}

// ─── DECISION MODEL ─────────────────────────────────────────────────────────

/**
 * Classify auth validity based on combined signals.
 *
 * Returns:
 *   classification: AUTH_VALID | AUTH_INVALID_LOGIN_PAGE | AUTH_INVALID_EXPIRED_SESSION |
 *                   AUTH_INVALID_PARTIAL_GATE | AUTH_INVALID_REDIRECT_LOOP | AUTH_STATE_AMBIGUOUS
 *   confidence: 0.0 - 1.0
 *   signals: all raw signals
 *   reason: human-readable explanation
 */
function classifyAuthValidity(loginSignals, sessionSignals, complexitySignals) {
  const {
    passwordFields, emailFields, authSubmitScore, oauthScore, formDominance
  } = loginSignals;

  const {
    expiryScore, metaRefresh, jsRedirect, isNearlyEmpty
  } = sessionSignals;

  const {
    nodeCount, structuralCount, uniqueTagCount, dataPatterns
  } = complexitySignals;

  // ── LOGIN PAGE DETECTION ────────────────────────────────────────────────

  // Strong login signal: password field + auth submit terms
  const strongLogin = passwordFields > 0 && authSubmitScore >= 2;

  // Medium login signal: password field + low complexity
  const mediumLogin = passwordFields > 0 && uniqueTagCount < 25 && structuralCount < 5;

  // OAuth-dominant page (login with Google/GitHub/etc)
  const oauthLogin = oauthScore >= 2 && passwordFields === 0 && structuralCount < 5;

  if (strongLogin) {
    return {
      classification: 'AUTH_INVALID_LOGIN_PAGE',
      confidence: 0.95,
      reason: `Password field detected (${passwordFields}) with auth terms (${authSubmitScore} matches). Low structural complexity suggests login page, not app UI.`,
    };
  }

  if (mediumLogin) {
    return {
      classification: 'AUTH_INVALID_LOGIN_PAGE',
      confidence: 0.8,
      reason: `Password field present with low page complexity (${uniqueTagCount} unique tags, ${structuralCount} structural regions). Likely a login page.`,
    };
  }

  if (oauthLogin) {
    return {
      classification: 'AUTH_INVALID_LOGIN_PAGE',
      confidence: 0.75,
      reason: `OAuth provider buttons detected (${oauthScore}) with minimal page structure. Likely an SSO/OAuth login gate.`,
    };
  }

  // ── EXPIRED SESSION DETECTION ──────────────────────────────────────────
  // Key insight: complex apps (evaluation platforms, dashboards) may contain
  // expiry-related terms as content, not as session state indicators.
  // True expired sessions have LOW complexity + expiry terms.

  const isLowComplexity = nodeCount < 100 && uniqueTagCount < 20;

  if (expiryScore >= 2 && isLowComplexity) {
    return {
      classification: 'AUTH_INVALID_EXPIRED_SESSION',
      confidence: 0.85,
      reason: `Session expiry indicators (${expiryScore} matches) on low-complexity page (${nodeCount} nodes). Likely a real session expiry, not app content.`,
    };
  }

  if (expiryScore >= 1 && isNearlyEmpty) {
    return {
      classification: 'AUTH_INVALID_EXPIRED_SESSION',
      confidence: 0.7,
      reason: `Session expiry term found with nearly empty page content.`,
    };
  }

  // High complexity + expiry terms = app content mentioning those terms, NOT a session error
  // Do not classify as expired session.

  // ── REDIRECT LOOP DETECTION ────────────────────────────────────────────

  if ((metaRefresh > 0 || jsRedirect > 2) && isNearlyEmpty) {
    return {
      classification: 'AUTH_INVALID_REDIRECT_LOOP',
      confidence: 0.75,
      reason: `Redirect indicators (meta: ${metaRefresh}, js: ${jsRedirect}) with minimal content. Possible redirect loop.`,
    };
  }

  // ── PARTIAL AUTH GATE ──────────────────────────────────────────────────

  // Has a password field but also has some app content — could be a partial gate
  if (passwordFields > 0 && structuralCount >= 5 && authSubmitScore >= 1) {
    return {
      classification: 'AUTH_INVALID_PARTIAL_GATE',
      confidence: 0.6,
      reason: `Password field and auth terms present alongside moderate structure. May be a partial auth gate or in-page login overlay.`,
    };
  }

  // ── AUTH VALID (positive signals — multi-signal required) ───────────────
  //
  // AUTH_VALID requires ALL of:
  //   1. No password fields
  //   2. Sufficient node count (structural depth)
  //   3. Sufficient structural diversity (semantic regions)
  //   4. Sufficient interactive elements (real UI, not static content)
  //
  // No single signal grants AUTH_VALID alone.

  const noPasswordFields = passwordFields === 0;
  const { interactiveCount } = complexitySignals;

  // Strong: complex app with multiple confirmation signals
  if (noPasswordFields && nodeCount >= 200 && structuralCount >= 6 && interactiveCount >= 5) {
    return {
      classification: 'AUTH_VALID',
      confidence: 0.95,
      reason: `Multi-signal confirmation: ${nodeCount} nodes, ${structuralCount} regions, ${interactiveCount} interactive elements, ${uniqueTagCount} tag types. No password fields.`,
    };
  }

  // Moderate: reasonable complexity with interactive elements
  if (noPasswordFields && nodeCount >= 50 && structuralCount >= 3 && interactiveCount >= 3 && authSubmitScore <= 2) {
    return {
      classification: 'AUTH_VALID',
      confidence: 0.8,
      reason: `Moderate multi-signal confirmation: ${nodeCount} nodes, ${structuralCount} regions, ${interactiveCount} interactive elements. No password fields.`,
    };
  }

  // ── AMBIGUOUS STATE — FAIL SAFE ───────────────────────────────────────
  //
  // If none of the above matched, the page is ambiguous.
  // This is NOT treated as valid. Build must not proceed.

  return {
    classification: 'AUTH_STATE_AMBIGUOUS',
    confidence: 0.4,
    reason: `Ambiguous: nodes=${nodeCount}, structural=${structuralCount}, interactive=${interactiveCount}, password=${passwordFields}, authTerms=${authSubmitScore}. Insufficient positive signals for AUTH_VALID. Build blocked.`,
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Validate whether rendered HTML represents authenticated app UI.
 *
 * @param {string} html — rendered HTML string
 * @param {Object} [readinessSignals] — signals from the renderer's readiness check
 * @returns {Object} validation result with classification, confidence, signals
 */
export function validateAuthValidity(html, readinessSignals = {}) {
  const startTime = Date.now();

  const loginSignals = detectLoginSignals(html);
  const sessionSignals = detectExpiredSessionSignals(html);
  const complexitySignals = detectComplexitySignals(html, readinessSignals);

  const decision = classifyAuthValidity(loginSignals, sessionSignals, complexitySignals);

  return {
    ...decision,
    isValid: decision.classification === 'AUTH_VALID',
    signals: {
      login: loginSignals,
      session: sessionSignals,
      complexity: complexitySignals,
    },
    durationMs: Date.now() - startTime,
  };
}
