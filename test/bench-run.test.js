import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

import * as daemon from '../src/daemon.js';
import { deriveToken } from '../src/routes.js';
import {
  BenchError,
  ARM_ID_RE,
  KNOWN_SETTINGS_KEYS,
  FIXTURE_DIR,
  MANIFEST_PATH,
  preflightManifest,
  readManifest,
  assertByteEqual,
  materializeFixture,
  assertNoAncestorConfig,
  findFreePort,
  waitForSocket,
  portDance,
  extractBaseUrl,
  assertRoutePresent,
  reachabilityGuard,
  benchRoot,
  sweepOrphans,
  teardown,
  cmdArm,
} from '../scripts/bench/run.mjs';

function mkTmp(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ccsnoop-bench-${tag}-`)));
}

/** A minimal well-formed one-arm manifest for pre-flight tests. */
function baseManifest() {
  return {
    schemaVersion: 1,
    prompt: 'x',
    model: 'm',
    turns: 2,
    cwd: 'bench/fixture',
    arms: [{ id: 'arm-00', label: 'temoin', seed: 'loaded', settings: { hooks: {} }, env: {} }],
  };
}

// ── the committed fixture (bench/SPEC.md §1) ─────────────────────────────────

test('fixture: CLAUDE.md and hook-persona.txt are each exactly 8192 bytes with distinct sentinels', () => {
  const claude = fs.readFileSync(path.join(FIXTURE_DIR, 'CLAUDE.md'));
  const persona = fs.readFileSync(path.join(FIXTURE_DIR, 'hook-persona.txt'));
  assert.equal(claude.length, 8192);
  assert.equal(persona.length, 8192);
  const cText = claude.toString('utf8');
  const pText = persona.toString('utf8');
  assert.match(cText, /CCSNOOP-BENCH-SENTINEL-CLAUDEMD-/);
  assert.match(pText, /CCSNOOP-BENCH-SENTINEL-PERSONA-/);
  // Distinct: neither sentinel appears in the other file.
  assert.ok(!pText.includes('SENTINEL-CLAUDEMD'), 'persona must not carry the CLAUDE.md sentinel');
  assert.ok(!cText.includes('SENTINEL-PERSONA'), 'CLAUDE.md must not carry the persona sentinel');
});

test('fixture: mcp-stub declares 64 tools, seeds/loaded/agents has 8 agents, seeds/bare is empty', async () => {
  // 8 agents
  const agents = fs
    .readdirSync(path.join(FIXTURE_DIR, 'seeds', 'loaded', 'agents'))
    .filter((f) => f.endsWith('.md'));
  assert.equal(agents.length, 8);

  // bare seed carries no agent/setting content (only a .gitkeep placeholder)
  const bare = fs.readdirSync(path.join(FIXTURE_DIR, 'seeds', 'bare')).filter((f) => f !== '.gitkeep');
  assert.deepEqual(bare, []);

  // 64 tools, over stdio JSON-RPC, no network
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(FIXTURE_DIR, 'mcp-stub.mjs')]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.end();
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  const list = msgs.find((m) => m.id === 2);
  assert.equal(list.result.tools.length, 64);
});

// ── the committed manifest (bench/SPEC.md §1) ────────────────────────────────

test('manifest: the committed manifest declares 8 arms and passes pre-flight', () => {
  const m = readManifest(MANIFEST_PATH);
  assert.equal(m.arms.length, 8);
  assert.equal(m.prompt, 'Read the file FIXED.txt and reply with only its first word.');
  assert.equal(m.model, 'claude-haiku-4-5-20251001');
  assert.equal(m.turns, 2);
  assert.equal(m.cwd, 'bench/fixture');
  for (const arm of m.arms) {
    assert.match(arm.id, ARM_ID_RE);
    assert.ok('settings' in arm && 'env' in arm && 'seed' in arm);
  }
});

// ── Step 1: pre-flight rejections (bench/SPEC.md §2 step 1, §5) ───────────────

test('preflight: rejects malformed JSON', () => {
  const dir = mkTmp('preflight');
  const f = path.join(dir, 'manifest.json');
  fs.writeFileSync(f, '{ not json ');
  assert.throws(() => readManifest(f), BenchError);
});

test('preflight: rejects an unknown settings key', () => {
  const m = baseManifest();
  m.arms[0].settings = { hooks: {}, bogusKey: true };
  assert.ok(!KNOWN_SETTINGS_KEYS.has('bogusKey'));
  assert.throws(() => preflightManifest(m), /unknown settings key/);
});

test('preflight: rejects an id failing /^arm-\\d\\d$/', () => {
  const m = baseManifest();
  m.arms[0].id = 'arm-0';
  assert.throws(() => preflightManifest(m), /does not match/);
});

test('preflight: rejects ids of unequal / non-fixed width (arm-100)', () => {
  // The fixed-width /^arm-\d\d$/ pattern is itself what guarantees equal width;
  // a wider id like arm-100 is rejected (bench/SPEC.md §1, §5).
  const m = baseManifest();
  m.arms = [
    { id: 'arm-00', label: 'a', seed: 'loaded', settings: { hooks: {} }, env: {} },
    { id: 'arm-100', label: 'b', seed: 'loaded', settings: { hooks: {} }, env: {} },
  ];
  assert.throws(() => preflightManifest(m), BenchError);
});

test('preflight: rejects a seed with no matching directory', () => {
  const m = baseManifest();
  m.arms[0].seed = 'does-not-exist';
  assert.throws(() => preflightManifest(m), /has no directory/);
});

test('preflight: accepts a well-formed manifest against the real fixture seeds', () => {
  const m = baseManifest();
  assert.doesNotThrow(() => preflightManifest(m));
});

// ── Step 3: materialize + byte-equality + no-ancestor guard ──────────────────

test('materialize: copies the fixture (minus seeds) and byte-equality holds', () => {
  const dir = mkTmp('mat');
  const cwd = path.join(dir, 'cwd');
  materializeFixture(FIXTURE_DIR, cwd);
  // Files present, seeds excluded.
  assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(cwd, 'mcp-stub.mjs')));
  assert.ok(!fs.existsSync(path.join(cwd, 'seeds')));
  // Re-asserting equality against the source passes.
  assert.doesNotThrow(() => assertByteEqual(FIXTURE_DIR, cwd, new Set(['seeds'])));
});

test('materialize: a mutated copy fails byte-equality (fatal)', () => {
  const dir = mkTmp('mat-mut');
  const cwd = path.join(dir, 'cwd');
  materializeFixture(FIXTURE_DIR, cwd);
  fs.appendFileSync(path.join(cwd, 'FIXED.txt'), 'x'); // mutate one byte
  assert.throws(() => assertByteEqual(FIXTURE_DIR, cwd, new Set(['seeds'])), /differs from source/);
});

test('no-ancestor guard: throws when an ancestor carries .claude/ or CLAUDE.md', () => {
  const root = mkTmp('anc');
  // root/.claude exists; root/child/cwd is the cwd → ancestor root has .claude.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const cwd = path.join(root, 'child', 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  assert.throws(() => assertNoAncestorConfig(cwd), /ancestor/);

  // A clean chain passes even when the cwd itself holds a CLAUDE.md.
  const clean = mkTmp('anc-clean');
  const cwd2 = path.join(clean, 'run', 'cwd');
  fs.mkdirSync(cwd2, { recursive: true });
  fs.writeFileSync(path.join(cwd2, 'CLAUDE.md'), 'ok');
  assert.doesNotThrow(() => assertNoAncestorConfig(cwd2));
});

// ── Step 6: reachability guard (spawned child) ───────────────────────────────

test('reachability guard: exits non-zero against a dead port', async () => {
  const port = await findFreePort(); // nothing listening here
  await assert.rejects(() => reachabilityGuard(`http://127.0.0.1:${port}`), BenchError);
});

/** Listen on an ephemeral port; resolve the bound port number. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

test('reachability guard: passes against a live 200, fails against a 502', async () => {
  const ok = http.createServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  const bad = http.createServer((req, res) => {
    res.writeHead(502);
    res.end();
  });
  const okPort = await listen(ok);
  const badPort = await listen(bad);
  try {
    await assert.doesNotReject(() => reachabilityGuard(`http://127.0.0.1:${okPort}`));
    await assert.rejects(() => reachabilityGuard(`http://127.0.0.1:${badPort}`), BenchError);
  } finally {
    ok.close();
    bad.close();
  }
});

// ── Step 5 + 7: the port dance (no network — start/stop/init are local) ──────

test('port dance: daemon serves on the advertised port and the route is present', async () => {
  const run = mkTmp('dance');
  const home = path.join(run, 'ccsnoop-home');
  const cwd = path.join(run, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  materializeFixture(FIXTURE_DIR, cwd);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd });

  const port = await findFreePort();
  try {
    const r = await portDance({ home, cwd, port });
    // Daemon is up on the chosen port.
    assert.equal(daemon.readState(home).running, true);
    assert.ok(await waitForSocket(port, '127.0.0.1', { timeoutMs: 2000 }));
    // settings.local.json advertises exactly that port.
    const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
    const baseUrl = extractBaseUrl(settingsPath);
    assert.match(baseUrl, new RegExp(`:${port}/`));
    // The route is present in the run's own routes.json.
    assert.doesNotThrow(() => assertRoutePresent(home, r.token));
    assert.equal(r.token, deriveToken(path.join(cwd, '.ccsnoop')));
  } finally {
    await daemon.stop(home);
    fs.rmSync(run, { recursive: true, force: true });
  }
});

// ── teardown idempotency & orphan sweep ──────────────────────────────────────

test('teardown: idempotent — twice succeeds, no daemon, no run dir', async () => {
  const run = mkTmp('td');
  const home = path.join(run, 'ccsnoop-home');
  const cwd = path.join(run, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  materializeFixture(FIXTURE_DIR, cwd);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd });
  const port = await findFreePort();
  await portDance({ home, cwd, port });
  assert.equal(daemon.readState(home).running, true);

  await teardown(run);
  assert.equal(fs.existsSync(run), false, 'run dir removed');
  assert.equal(daemon.readState(home).running, false, 'daemon stopped');

  // Second teardown on the already-removed run must also succeed.
  await assert.doesNotReject(() => teardown(run));
});

test('orphan sweep: stops a daemon left behind under the bench root and removes the dir', async () => {
  const root = mkTmp('sweep-root');
  const run = path.join(root, '2020-01-01T00-00-00-000Z');
  const home = path.join(run, 'ccsnoop-home');
  const cwd = path.join(run, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  materializeFixture(FIXTURE_DIR, cwd);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd });
  const port = await findFreePort();
  await portDance({ home, cwd, port });
  const pid = daemon.readPid(home);
  assert.ok(daemon.isAlive(pid), 'daemon alive before sweep');

  const swept = await sweepOrphans(root);
  assert.deepEqual(swept.map((p) => path.basename(p)), ['2020-01-01T00-00-00-000Z']);
  assert.equal(daemon.isAlive(pid), false, 'daemon stopped by the sweep');
  assert.equal(fs.existsSync(run), false, 'orphan run dir removed');

  fs.rmSync(root, { recursive: true, force: true });
});

test('benchRoot is under the OS tmp dir', () => {
  assert.equal(benchRoot(), path.join(os.tmpdir(), 'ccsnoop-bench'));
});

// ── `arm <id>`: run-scoped orchestration (steps 1–7) ─────────────────────────

test('cmdArm: rejects an unknown arm id before standing up any infra', async () => {
  const root = mkTmp('arm-badid');
  try {
    // arm-99 matches /^arm-\d\d$/ (so pre-flight of the committed manifest passes)
    // but is not a declared arm — cmdArm must fail before creating a run dir.
    await assert.rejects(() => cmdArm('arm-99', { root }), /no arm 'arm-99'/);
    assert.deepEqual(fs.readdirSync(root), [], 'no run dir created on a bad id');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cmdArm: a fresh run stands up a reachable daemon; a second arm reuses it', async () => {
  const root = mkTmp('arm-run');
  try {
    // Step 1–7 on a fresh root: materialize, port dance, route + reachability.
    const first = await cmdArm('arm-00', { root });
    assert.equal(first.reused, false, 'first arm builds the run');
    assert.match(first.baseUrl, /^http:\/\/localhost:\d+\/[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(path.join(first.runDir, 'cwd', 'CLAUDE.md')), true);

    // A second arm against the same root reuses the healthy run — same dir, same
    // base URL, no fresh port dance (bench/SPEC.md §2: infra is run-scoped).
    const second = await cmdArm('arm-01', { root });
    assert.equal(second.reused, true, 'second arm reuses the healthy run');
    assert.equal(second.runDir, first.runDir);
    assert.equal(second.baseUrl, first.baseUrl);
  } finally {
    // Tear down whatever run(s) landed under the custom root.
    await sweepOrphans(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
