'use strict';

/**
 * Regression tests for B3: canonical knowledge store path + one-time
 * migration from legacy locations.
 *
 * Previously the store lived at `process.cwd()/ds-knowledge.json` — since
 * cwd depends on how the MCP client launches the server, learning silently
 * fragmented per working directory. The canonical location is now
 * `~/.mimic-ai/ds-knowledge.json`, with a MIMIC_KNOWLEDGE_PATH env override
 * and a one-time migration from legacy locations (cwd, then ~/ds-knowledge.json).
 *
 * SAFETY: requiring mcp.js executes top-level module code that resolves the
 * real knowledge store path and may attempt a migration as a side effect of
 * `require()`. To avoid ever touching a real developer's actual
 * ~/.mimic-ai directory or their real ~/ds-knowledge.json, MIMIC_KNOWLEDGE_PATH
 * is pointed at a disposable temp path BEFORE mcp.js is required, below.
 * All actual test scenarios exercise the exported pure functions directly
 * with their own os.homedir()/process.cwd() mocks — they don't depend on
 * mcp.js's own module-level singletons.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let guardDir;
let mcp;

before(() => {
  guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-mcp-require-guard-'));
  process.env.MIMIC_KNOWLEDGE_PATH = path.join(guardDir, 'ds-knowledge.json');
  // eslint-disable-next-line global-require
  mcp = require('../../mcp.js');
});

after(() => {
  delete process.env.MIMIC_KNOWLEDGE_PATH;
  try { fs.rmSync(guardDir, { recursive: true, force: true }); } catch {}
});

describe('resolveKnowledgeStorePath', () => {
  const originalEnv = process.env.MIMIC_KNOWLEDGE_PATH;
  let originalHomedir;

  beforeEach(() => { originalHomedir = os.homedir; });
  afterEach(() => {
    os.homedir = originalHomedir;
    if (originalEnv === undefined) delete process.env.MIMIC_KNOWLEDGE_PATH;
    else process.env.MIMIC_KNOWLEDGE_PATH = originalEnv;
  });

  it('respects MIMIC_KNOWLEDGE_PATH override when set', () => {
    process.env.MIMIC_KNOWLEDGE_PATH = '/tmp/somewhere/custom-store.json';
    assert.equal(mcp.resolveKnowledgeStorePath(), '/tmp/somewhere/custom-store.json');
  });

  it('defaults to ~/.mimic-ai/ds-knowledge.json when no override is set', () => {
    delete process.env.MIMIC_KNOWLEDGE_PATH;
    const fakeHome = '/fake/home/dir';
    os.homedir = () => fakeHome;
    assert.equal(mcp.resolveKnowledgeStorePath(), path.join(fakeHome, '.mimic-ai', 'ds-knowledge.json'));
  });

  it('is stable regardless of process.cwd() (the bug this fixes)', () => {
    delete process.env.MIMIC_KNOWLEDGE_PATH;
    const fakeHome = '/fake/home/dir2';
    os.homedir = () => fakeHome;
    const originalCwd = process.cwd;
    try {
      process.cwd = () => '/some/random/project/a';
      const pathA = mcp.resolveKnowledgeStorePath();
      process.cwd = () => '/some/completely/different/project/b';
      const pathB = mcp.resolveKnowledgeStorePath();
      assert.equal(pathA, pathB, 'the resolved path must not depend on cwd');
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe('migrateKnowledgeStoreIfNeeded', () => {
  let tmpHome;
  let tmpCwd;
  let canonicalPath;
  let originalCwd;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-migrate-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-migrate-cwd-'));
    canonicalPath = path.join(tmpHome, '.mimic-ai', 'ds-knowledge.json');
    originalCwd = process.cwd;
    process.cwd = () => tmpCwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
  });

  it('does nothing if the canonical path already exists', () => {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({ version: 2, marker: 'canonical' }));
    const legacyCwdPath = path.join(tmpCwd, 'ds-knowledge.json');
    fs.writeFileSync(legacyCwdPath, JSON.stringify({ version: 2, marker: 'legacy' }));

    const note = mcp.migrateKnowledgeStoreIfNeeded(canonicalPath);
    assert.equal(note, null);
    // Canonical file must be untouched — never overwritten by a legacy file.
    assert.equal(JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')).marker, 'canonical');
  });

  it('migrates from cwd/ds-knowledge.json when canonical is missing, leaving the original in place', () => {
    const legacyCwdPath = path.join(tmpCwd, 'ds-knowledge.json');
    fs.writeFileSync(legacyCwdPath, JSON.stringify({ version: 2, marker: 'from-cwd' }));

    // Mock os.homedir() too, so this test can never fall through to a real
    // developer machine's actual ~/ds-knowledge.json (cwd is checked first
    // and should short-circuit before homedir is ever consulted, but this
    // keeps the test deterministic regardless).
    const originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    try {
      const note = mcp.migrateKnowledgeStoreIfNeeded(canonicalPath);
      assert.ok(note, 'should return a migration note');
      assert.match(note, /cwd|migrated/i);

      assert.ok(fs.existsSync(canonicalPath), 'canonical file should now exist');
      assert.equal(JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')).marker, 'from-cwd');

      // Original must be left in place — never deleted.
      assert.ok(fs.existsSync(legacyCwdPath), 'legacy cwd file must be left in place');
      assert.equal(JSON.parse(fs.readFileSync(legacyCwdPath, 'utf-8')).marker, 'from-cwd');
    } finally {
      os.homedir = originalHomedir;
    }
  });

  it('falls back to ~/ds-knowledge.json when cwd has none', () => {
    const legacyHomePath = path.join(tmpHome, 'ds-knowledge.json');
    fs.writeFileSync(legacyHomePath, JSON.stringify({ version: 2, marker: 'from-home' }));

    // Point the "~/ds-knowledge.json" candidate at tmpHome by having
    // canonicalPath live under tmpHome/.mimic-ai — migrateKnowledgeStoreIfNeeded
    // derives ~/ds-knowledge.json from os.homedir(), so mock it here.
    const originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    try {
      const note = mcp.migrateKnowledgeStoreIfNeeded(canonicalPath);
      assert.ok(note, 'should return a migration note');
      assert.ok(fs.existsSync(canonicalPath));
      assert.equal(JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')).marker, 'from-home');
      // Original left in place.
      assert.ok(fs.existsSync(legacyHomePath));
    } finally {
      os.homedir = originalHomedir;
    }
  });

  it('prefers cwd/ds-knowledge.json over ~/ds-knowledge.json when both exist', () => {
    const legacyCwdPath = path.join(tmpCwd, 'ds-knowledge.json');
    const legacyHomePath = path.join(tmpHome, 'ds-knowledge.json');
    fs.writeFileSync(legacyCwdPath, JSON.stringify({ version: 2, marker: 'from-cwd' }));
    fs.writeFileSync(legacyHomePath, JSON.stringify({ version: 2, marker: 'from-home' }));

    const originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    try {
      mcp.migrateKnowledgeStoreIfNeeded(canonicalPath);
      assert.equal(JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')).marker, 'from-cwd');
    } finally {
      os.homedir = originalHomedir;
    }
  });

  it('returns null when nothing exists anywhere (fresh install)', () => {
    // Mock os.homedir() too — without it, this would fall through to the
    // real developer machine's actual ~/ds-knowledge.json if one exists,
    // making the test both non-deterministic and a real-filesystem read.
    const originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
    try {
      const note = mcp.migrateKnowledgeStoreIfNeeded(canonicalPath);
      assert.equal(note, null);
      assert.ok(!fs.existsSync(canonicalPath));
    } finally {
      os.homedir = originalHomedir;
    }
  });
});
