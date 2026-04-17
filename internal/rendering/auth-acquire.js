/**
 * Mimic AI — Auth Acquisition Layer
 *
 * Reads session cookies from existing browser profiles on the local machine.
 * No user intervention required — reuses sessions the user already has.
 *
 * Supports:
 *   - Chrome (macOS) — reads encrypted cookies from SQLite, decrypts via Keychain
 *
 * Future:
 *   - Firefox profile support
 *   - Arc browser support
 *   - Linux/Windows Chrome support
 *
 * Usage:
 *   import { acquireAuth } from './auth-acquire.js';
 *   const result = await acquireAuth({ domain: '.layerlens.ai' });
 *   // result.cookies → Puppeteer-format cookie array
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, mkdirSync, cpSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { tmpdir } from 'os';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const CHROME_USER_DATA = resolve(
  process.env.HOME, 'Library', 'Application Support', 'Google', 'Chrome'
);
const CHROME_KEYCHAIN_SERVICE = 'Chrome Safe Storage';
const CHROME_KEYCHAIN_ACCOUNT = 'Chrome';
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEYLEN = 16;
const PBKDF2_SALT = 'saltysalt';
const AES_IV = Buffer.alloc(16, 0x20); // 16 bytes of space character

// ─── CHROME PROFILE DISCOVERY ───────────────────────────────────────────────

/**
 * Find all Chrome profiles that have cookies for the given domain.
 * Uses sqlite3 CLI to avoid profile lock issues with in-process SQLite.
 * Returns array of { profileName, profilePath, cookieCount }.
 */
function discoverProfiles(domain) {
  if (!existsSync(CHROME_USER_DATA)) return [];

  const entries = readdirSync(CHROME_USER_DATA, { withFileTypes: true });
  const profiles = entries
    .filter(e => e.isDirectory() && (e.name === 'Default' || e.name.startsWith('Profile')))
    .map(e => ({
      name: e.name,
      path: resolve(CHROME_USER_DATA, e.name),
      cookiesDb: resolve(CHROME_USER_DATA, e.name, 'Cookies'),
    }))
    .filter(p => existsSync(p.cookiesDb));

  const results = [];
  for (const profile of profiles) {
    try {
      const output = execSync(
        `sqlite3 "${profile.cookiesDb}" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%${domain}%';"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const count = parseInt(output) || 0;
      if (count > 0) {
        results.push({ profileName: profile.name, profilePath: profile.path, cookieCount: count });
      }
    } catch (e) {
      // Profile locked or inaccessible — skip
    }
  }

  return results;
}

// ─── KEYCHAIN KEY RETRIEVAL ─────────────────────────────────────────────────

/**
 * Get the Chrome Safe Storage encryption key from macOS Keychain.
 * May prompt the user for Touch ID / password (one-time system auth).
 */
function getKeychainKey() {
  try {
    const key = execSync(
      `security find-generic-password -w -s "${CHROME_KEYCHAIN_SERVICE}" -a "${CHROME_KEYCHAIN_ACCOUNT}"`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
    return key;
  } catch (e) {
    return null;
  }
}

/**
 * Derive the AES decryption key from the Keychain password.
 */
function deriveKey(keychainPassword) {
  return pbkdf2Sync(
    keychainPassword,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    'sha1'
  );
}

// ─── COOKIE DECRYPTION ──────────────────────────────────────────────────────

/**
 * Decrypt a Chrome cookie value (macOS).
 * Encrypted values have a "v10" prefix followed by AES-128-CBC encrypted data.
 */
function decryptCookieValue(encryptedValue, derivedKey) {
  if (!encryptedValue || encryptedValue.length === 0) return '';

  // Check for v10 prefix (Chrome macOS encryption marker)
  const prefix = encryptedValue.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') {
    // Not encrypted or unknown format — return as-is
    return encryptedValue.toString('utf8');
  }

  const encrypted = encryptedValue.slice(3);
  try {
    const decipher = createDecipheriv('aes-128-cbc', derivedKey, AES_IV);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return null; // Decryption failed
  }
}

// ─── COOKIE EXTRACTION ──────────────────────────────────────────────────────

/**
 * Read and decrypt cookies for a domain from a Chrome profile.
 * Returns Puppeteer-format cookie array.
 */
function extractCookies(profilePath, domain, derivedKey) {
  const cookiesDb = resolve(profilePath, 'Cookies');
  const db = new Database(cookiesDb, { readonly: true, fileMustExist: true });

  const rows = db.prepare(`
    SELECT host_key, name, path, encrypted_value, expires_utc,
           is_secure, is_httponly, samesite
    FROM cookies
    WHERE host_key LIKE ?
    ORDER BY host_key, name
  `).all(`%${domain}%`);

  db.close();

  const cookies = [];
  for (const row of rows) {
    const value = decryptCookieValue(row.encrypted_value, derivedKey);
    if (value === null) continue; // Skip failed decryptions

    // Convert Chrome epoch (microseconds since 1601-01-01) to Unix epoch
    const expiresUnix = row.expires_utc > 0
      ? (row.expires_utc / 1000000) - 11644473600
      : -1; // Session cookie

    cookies.push({
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path || '/',
      expires: expiresUnix,
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      sameSite: row.samesite === 0 ? 'None' : row.samesite === 1 ? 'Lax' : 'Strict',
    });
  }

  return cookies;
}

// ─── PROFILE-BASED AUTH (PRIMARY METHOD) ────────────────────────────────────

/**
 * Create a lightweight copy of a Chrome profile for use with Puppeteer.
 * Copies only the files needed for session continuity (Cookies, Local Storage, etc.)
 * Returns the path to the temporary user data directory.
 */
function createProfileCopy(profilePath, profileName) {
  const tempBase = resolve(tmpdir(), `mimic-chrome-${Date.now()}`);
  const tempProfile = resolve(tempBase, profileName);
  mkdirSync(tempProfile, { recursive: true });

  // Copy essential session files
  const essentialFiles = [
    'Cookies', 'Cookies-journal',
    'Login Data', 'Login Data-journal',
    'Web Data', 'Web Data-journal',
    'Preferences', 'Secure Preferences',
  ];

  for (const file of essentialFiles) {
    const src = resolve(profilePath, file);
    if (existsSync(src)) {
      try { cpSync(src, resolve(tempProfile, file)); } catch {}
    }
  }

  // Copy Local Storage directory (contains session tokens)
  const localStorageSrc = resolve(profilePath, 'Local Storage');
  if (existsSync(localStorageSrc)) {
    try { cpSync(localStorageSrc, resolve(tempProfile, 'Local Storage'), { recursive: true }); } catch {}
  }

  // Copy Local State from parent (needed for cookie decryption at browser level)
  const localStateSrc = resolve(CHROME_USER_DATA, 'Local State');
  if (existsSync(localStateSrc)) {
    try { cpSync(localStateSrc, resolve(tempBase, 'Local State')); } catch {}
  }

  return { tempUserDataDir: tempBase, tempProfileDir: tempProfile, profileName };
}

/**
 * Clean up a temporary profile copy.
 */
function cleanupProfileCopy(tempUserDataDir) {
  try { rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
}

// ─── CORE AUTH ACQUISITION ──────────────────────────────────────────────────

/**
 * Acquire authentication context for a domain from the local browser.
 *
 * Primary method: profile-based — creates a temporary copy of the Chrome profile
 * and returns Puppeteer launch options to use that profile directly.
 * The browser handles cookie decryption internally (no Keychain API needed).
 *
 * @param {Object} options
 * @param {string} options.domain — target domain (e.g., 'layerlens.ai' or 'app.layerlens.ai')
 * @param {string} [options.profileName] — specific Chrome profile to use (e.g., 'Profile 4')
 * @returns {Object} auth result with puppeteerOptions for authenticated launch
 */
export async function acquireAuth(options) {
  const { domain, profileName } = options;
  const startTime = Date.now();

  const result = {
    status: 'PENDING',
    method: null,
    profileUsed: null,
    cookieCount: 0,
    cookies: [],           // Empty for profile-based auth (browser has cookies internally)
    puppeteerOptions: null, // Launch options for Puppeteer with auth context
    tempDir: null,          // For cleanup
    failureMode: null,
    durationMs: null,
  };

  try {
    // Step 1: Discover profiles with relevant cookies
    const profiles = discoverProfiles(domain);
    if (profiles.length === 0) {
      result.status = 'FAILURE';
      result.failureMode = 'AUTH_CONTEXT_NOT_FOUND';
      result.method = 'chrome_profile_scan';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Step 2: Select profile (prefer specified, otherwise pick richest)
    const selected = profileName
      ? profiles.find(p => p.profileName === profileName)
      : profiles.sort((a, b) => b.cookieCount - a.cookieCount)[0];

    if (!selected) {
      result.status = 'FAILURE';
      result.failureMode = 'AUTH_CONTEXT_NOT_FOUND';
      result.method = 'chrome_profile_scan';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    result.profileUsed = selected.profileName;
    result.cookieCount = selected.cookieCount;

    // Step 3: Create lightweight profile copy
    const profileCopy = createProfileCopy(selected.profilePath, selected.profileName);
    result.tempDir = profileCopy.tempUserDataDir;

    // Step 4: Build Puppeteer launch options that use this profile
    result.puppeteerOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${profileCopy.tempUserDataDir}`,
        `--profile-directory=${profileCopy.profileName}`,
      ],
    };

    result.status = 'SUCCESS';
    result.method = 'chrome_profile_copy';

  } catch (err) {
    result.status = 'FAILURE';
    result.failureMode = 'UNKNOWN_AUTH_FAILURE';
    result.error = err.message;
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * Clean up auth resources (temp profile directory).
 * Call this after rendering is complete.
 */
export function cleanupAuth(authResult) {
  if (authResult?.tempDir) {
    cleanupProfileCopy(authResult.tempDir);
  }
}

// ─── CLI ENTRY POINT ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-')) {
  const domain = args[0];
  const profileIdx = args.indexOf('--profile');
  const profileName = profileIdx >= 0 ? args[profileIdx + 1] : undefined;

  acquireAuth({ domain, profileName }).then(result => {
    // Don't log full cookie values in CLI output for security
    const safe = { ...result, cookies: result.cookies.map(c => ({ ...c, value: c.value.substring(0, 8) + '...' })) };
    console.log(JSON.stringify(safe, null, 2));
    process.exit(result.status === 'SUCCESS' ? 0 : 1);
  });
}
