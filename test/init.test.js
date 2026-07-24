import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { init, gitTopLevel, InitError } from '../src/init.js';
import { deriveToken } from '../src/routes.js';
import * as daemon from '../src/daemon.js';

/** A fresh git repo in a temp dir; returns its top-level path. */
function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-init-repo-')));
  const r = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(r.status, 0, 'git init failed');
  return dir;
}

function mkHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-init-home-')));
}

/** A non-repo temp dir (no git init). */
function mkPlain() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-init-plain-')));
}

function readSettings(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
}
function readRoutes(home) {
  return JSON.parse(fs.readFileSync(daemon.paths(home).routes, 'utf8'));
}
function gitignoreLines(repo) {
  const p = path.join(repo, '.gitignore');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim());
}

// ── anchoring ─────────────────────────────────────────────────────────────

test('outside a git repo, init errors; inside, it anchors to the git top-level', () => {
  const plain = mkPlain();
  assert.equal(gitTopLevel(plain), null);
  assert.throws(() => init({ cwd: plain, home: mkHome() }), InitError);

  const repo = mkRepo();
  const sub = path.join(repo, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const res = init({ cwd: sub, home: mkHome() });
  assert.equal(res.exitCode, 0);
  // Anchored to the top-level, not the cwd.
  assert.equal(res.captureDir, path.join(repo, '.ccsnoop'));
});

// ── settings.local.json env surgery ─────────────────────────────────────────

test('writes ANTHROPIC_BASE_URL (port+token) and ENABLE_TOOL_SEARCH=true, preserving existing keys', () => {
  const repo = mkRepo();
  const home = mkHome();
  daemon.writeConfig(home, { port: 5555 });

  // Pre-existing settings with an unrelated key that must survive.
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }, null, 2),
  );

  const res = init({ cwd: repo, home });
  const token = deriveToken(path.join(repo, '.ccsnoop'));
  const s = readSettings(repo);
  assert.equal(s.model, 'opus', 'unrelated top-level key preserved');
  assert.equal(s.env.FOO, 'bar', 'unrelated env key preserved');
  assert.equal(s.env.ANTHROPIC_BASE_URL, `http://localhost:5555/${token}`);
  assert.equal(s.env.ENABLE_TOOL_SEARCH, 'true');
  assert.equal(res.token, token);
});

test('port falls back to 41377 when no daemon has ever run', () => {
  const repo = mkRepo();
  const home = mkHome();
  init({ cwd: repo, home });
  const token = deriveToken(path.join(repo, '.ccsnoop'));
  assert.equal(readSettings(repo).env.ANTHROPIC_BASE_URL, `http://localhost:41377/${token}`);
});

test('the settings.local.json write is strict JSON (parses cleanly, no comments)', () => {
  const repo = mkRepo();
  const home = mkHome();
  init({ cwd: repo, home });
  const raw = fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'strict JSON — CC rejects JSONC');
  // No JSONC comment sentinels (a line-leading `//` or a `/*` block).
  assert.ok(!/^\s*\/\//m.test(raw) && !raw.includes('/*'), 'no comment sentinel');
});

// ── gitignore + routes registration ─────────────────────────────────────────

test('gitignores .ccsnoop/ and settings.local.json (created), records route + manifest', () => {
  const repo = mkRepo();
  const home = mkHome();
  const res = init({ cwd: repo, home });
  const token = res.token;

  const lines = gitignoreLines(repo);
  assert.ok(lines.includes('.ccsnoop/'), '.ccsnoop/ gitignored (non-negotiable 5)');
  assert.ok(lines.includes('.claude/settings.local.json'), 'created settings.local.json gitignored');

  const routes = readRoutes(home);
  assert.ok(routes[token], 'route recorded');
  assert.equal(routes[token].dir, path.join(repo, '.ccsnoop'));
  assert.equal(routes[token].created_local_settings, true);
  assert.equal(routes[token].added_gitignore_ccsnoop, true);
  assert.equal(routes[token].added_gitignore_settings, true);
  // A daemon (issue #21) resolves this token to <repo>/.ccsnoop via routeDir.
  assert.equal(daemon.countRoutes(home), 1);
});

test('settings.local.json is NOT gitignored when init did not create it', () => {
  const repo = mkRepo();
  const home = mkHome();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}');

  init({ cwd: repo, home });
  const lines = gitignoreLines(repo);
  assert.ok(lines.includes('.ccsnoop/'));
  assert.ok(!lines.includes('.claude/settings.local.json'), 'user-owned settings file left out of gitignore');
  assert.equal(readRoutes(home)[deriveToken(path.join(repo, '.ccsnoop'))].added_gitignore_settings, false);
});

test('gitignore is not duplicated when .ccsnoop/ already present', () => {
  const repo = mkRepo();
  const home = mkHome();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.ccsnoop/\n');
  init({ cwd: repo, home });
  const occurrences = gitignoreLines(repo).filter((l) => l === '.ccsnoop/').length;
  assert.equal(occurrences, 1, 'existing entry not duplicated');
  assert.equal(readRoutes(home)[deriveToken(path.join(repo, '.ccsnoop'))].added_gitignore_ccsnoop, false);
});

// ── idempotency + force ──────────────────────────────────────────────────────

test('re-running init is idempotent (overwrites ccsnoop-shaped values only)', () => {
  const repo = mkRepo();
  const home = mkHome();
  init({ cwd: repo, home });
  const first = fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8');
  const firstRoutes = fs.readFileSync(daemon.paths(home).routes, 'utf8');

  init({ cwd: repo, home });
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'), first);
  assert.equal(fs.readFileSync(daemon.paths(home).routes, 'utf8'), firstRoutes);
  assert.equal(daemon.countRoutes(home), 1, 'no duplicate route');
});

test('re-run picks up a changed port, overwriting the ccsnoop-shaped base URL', () => {
  const repo = mkRepo();
  const home = mkHome();
  init({ cwd: repo, home });
  const token = deriveToken(path.join(repo, '.ccsnoop'));
  assert.equal(readSettings(repo).env.ANTHROPIC_BASE_URL, `http://localhost:41377/${token}`);

  daemon.writeConfig(home, { port: 9999 });
  init({ cwd: repo, home });
  assert.equal(readSettings(repo).env.ANTHROPIC_BASE_URL, `http://localhost:9999/${token}`);
});

test('a foreign ANTHROPIC_BASE_URL is refused without --force, replaced with it', () => {
  const repo = mkRepo();
  const home = mkHome();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://corp.proxy.example/v1' } }),
  );

  assert.throws(() => init({ cwd: repo, home }), /foreign ANTHROPIC_BASE_URL/);
  // Untouched by the refusal.
  assert.equal(readSettings(repo).env.ANTHROPIC_BASE_URL, 'https://corp.proxy.example/v1');

  const res = init({ cwd: repo, home, force: true });
  const token = res.token;
  assert.equal(readSettings(repo).env.ANTHROPIC_BASE_URL, `http://localhost:41377/${token}`);
});

// ── undo ─────────────────────────────────────────────────────────────────────

test('undo removes exactly what init added; captured .ccsnoop/ data survives', () => {
  const repo = mkRepo();
  const home = mkHome();
  init({ cwd: repo, home });

  // Simulate captured data landing under .ccsnoop/.
  const captured = path.join(repo, '.ccsnoop', 'sessions', 's1', '0001.request.http');
  fs.mkdirSync(path.dirname(captured), { recursive: true });
  fs.writeFileSync(captured, 'POST /v1/messages HTTP/1.1\n');

  const res = init({ cwd: repo, home, undo: true });
  assert.equal(res.exitCode, 0);

  // settings.local.json deleted (init created it); route gone; gitignore entries removed.
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'settings.local.json')), 'created settings removed');
  assert.equal(daemon.countRoutes(home), 0, 'route removed');
  const lines = gitignoreLines(repo);
  assert.ok(!lines.includes('.ccsnoop/'), '.ccsnoop/ gitignore entry removed');
  assert.ok(!lines.includes('.claude/settings.local.json'));

  // Never deletes capture data.
  assert.ok(fs.existsSync(captured), 'captured data left intact');
});

test('undo on a user-owned settings file drops only ccsnoop keys, preserving the rest', () => {
  const repo = mkRepo();
  const home = mkHome();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'opus', env: { FOO: 'bar', ENABLE_TOOL_SEARCH: 'false' } }),
  );
  init({ cwd: repo, home });
  init({ cwd: repo, home, undo: true });

  const s = readSettings(repo);
  assert.equal(s.model, 'opus', 'unrelated key preserved');
  assert.equal(s.env.FOO, 'bar', 'unrelated env key preserved');
  assert.ok(!('ANTHROPIC_BASE_URL' in s.env), 'ccsnoop base URL removed');
  assert.equal(s.env.ENABLE_TOOL_SEARCH, 'false', 'user-owned ENABLE_TOOL_SEARCH preserved');
});

test('undo with no registered route is a no-op that reports nothing to undo', () => {
  const repo = mkRepo();
  const home = mkHome();
  const res = init({ cwd: repo, home, undo: true });
  assert.equal(res.exitCode, 0);
  assert.match(res.lines.join('\n'), /nothing to undo/);
});

test('undo preserves other repos\' routes', () => {
  const home = mkHome();
  const repoA = mkRepo();
  const repoB = mkRepo();
  init({ cwd: repoA, home });
  init({ cwd: repoB, home });
  assert.equal(daemon.countRoutes(home), 2);

  init({ cwd: repoA, home, undo: true });
  const routes = readRoutes(home);
  assert.equal(daemon.countRoutes(home), 1);
  assert.ok(routes[deriveToken(path.join(repoB, '.ccsnoop'))], 'repo B route untouched');
});
