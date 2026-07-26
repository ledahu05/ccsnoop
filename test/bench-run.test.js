import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

import * as daemon from '../src/daemon.js';
import { readUsage } from '../src/report.js';
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
  writeArmConfig,
  copyCredentials,
  scrubCredentials,
  parseSystemInit,
  preflightSystemInit,
  pickFreshSession,
  readCaptureManifest,
  assertGzipObserved,
  assertCaptureOrder,
  extractCapture,
  fixtureCounts,
  buildArmRecord,
  buildProvenance,
  listingSizes,
  claudeVersion,
} from '../scripts/bench/run.mjs';

/** The stand-in for the `claude` binary — every capture test is token-free. */
const FAKE_CLAUDE = path.resolve('test/fixtures/fake-claude.mjs');

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
    // `infraOnly` stops before step 8 — no secret copied, no tokens spent.
    const first = await cmdArm('arm-00', { root, infraOnly: true });
    assert.equal(first.reused, false, 'first arm builds the run');
    assert.match(first.baseUrl, /^http:\/\/localhost:\d+\/[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(path.join(first.runDir, 'cwd', 'CLAUDE.md')), true);

    // A second arm against the same root reuses the healthy run — same dir, same
    // base URL, no fresh port dance (bench/SPEC.md §2: infra is run-scoped).
    const second = await cmdArm('arm-01', { root, infraOnly: true });
    assert.equal(second.reused, true, 'second arm reuses the healthy run');
    assert.equal(second.runDir, first.runDir);
    assert.equal(second.baseUrl, first.baseUrl);
  } finally {
    // Tear down whatever run(s) landed under the custom root.
    await sweepOrphans(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── steps 8–10, 20: the arm's config dir and the secret ──────────────────────

test('writeArmConfig: writes the arm settings verbatim and seeds from the fixture', () => {
  const run = mkTmp('armcfg');
  try {
    const arm = readManifest().arms.find((a) => a.id === 'arm-00');
    const configDir = writeArmConfig(run, arm);
    assert.equal(configDir, path.join(run, 'arm-00', '.claude'));

    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    assert.deepEqual(written, arm.settings, 'settings round-trip unchanged');

    // seed `loaded` brings the 8 agents; `bare` brings nothing (.gitkeep skipped).
    const agents = fs.readdirSync(path.join(configDir, 'agents'));
    assert.equal(agents.length, 8);

    const bare = writeArmConfig(run, { id: 'arm-06', settings: {}, seed: 'bare' });
    assert.deepEqual(fs.readdirSync(bare), ['settings.json'], 'bare seeds nothing');
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test('credentials: copied 0600, scrubbed idempotently, fatal when the source is absent', () => {
  const run = mkTmp('creds');
  try {
    const configDir = writeArmConfig(run, { id: 'arm-00', settings: {}, seed: 'bare' });
    const src = path.join(run, 'fake-creds.json');
    fs.writeFileSync(src, '{"claudeAiOauth":{"accessToken":"not-a-real-token"}}');

    const dest = copyCredentials(configDir, src);
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'));
    assert.equal(fs.statSync(dest).mode & 0o777, 0o600, 'the secret is 0600');

    // CC drops `.claude.json` (oauthAccount: email + account UUIDs) alongside
    // the secret; a kept run under bench/runs/ must carry neither.
    const identity = path.join(configDir, '.claude.json');
    fs.writeFileSync(identity, '{"oauthAccount":{"emailAddress":"dev@example.com"}}');

    scrubCredentials(configDir);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(identity), false, 'account identity goes too');
    scrubCredentials(configDir); // idempotent — it runs from three places

    assert.throws(
      () => copyCredentials(configDir, path.join(run, 'nope.json')),
      (err) => err instanceof BenchError && /loggedIn/.test(err.message),
    );
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

// ── step 11: the system/init pre-flight ──────────────────────────────────────

test('parseSystemInit: finds the init event, ignores other events and partial lines', () => {
  const stdout =
    'not json\n' +
    '{"type":"system","subtype":"compact"}\n' +
    '{"type":"system","subtype":"init","tools":["Bash","Read"]}\n' +
    '{"type":"resu\n';
  const event = parseSystemInit(stdout);
  assert.equal(event.subtype, 'init');
  assert.deepEqual(event.tools, ['Bash', 'Read']);
  assert.equal(parseSystemInit('{"type":"result"}\n'), null);
});

test('preflightSystemInit: a NON-ZERO exit with a valid init event passes', () => {
  const run = mkTmp('preflight-ok');
  try {
    const configDir = writeArmConfig(run, { id: 'arm-00', settings: {}, seed: 'bare' });
    // The stub exits 1, exactly as the real binary does against a dead port.
    const r = preflightSystemInit({ configDir, cwd: run, model: 'm', claudeBin: FAKE_CLAUDE });
    assert.equal(r.toolCount, 6);
    assert.ok(r.tools.includes('Workflow'));
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test('preflightSystemInit: fatal when no init event is emitted, or zero tools', () => {
  const run = mkTmp('preflight-bad');
  try {
    const configDir = writeArmConfig(run, { id: 'arm-00', settings: {}, seed: 'bare' });
    const call = (mode) => {
      const prev = process.env.CCSNOOP_FAKE_MODE;
      process.env.CCSNOOP_FAKE_MODE = mode;
      try {
        preflightSystemInit({ configDir, cwd: run, model: 'm', claudeBin: FAKE_CLAUDE });
      } finally {
        if (prev === undefined) delete process.env.CCSNOOP_FAKE_MODE;
        else process.env.CCSNOOP_FAKE_MODE = prev;
      }
    };
    assert.throws(() => call('noinit'), /no init event|emitted no init event/);
    assert.throws(() => call('notools'), /0 tools/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

// ── steps 13, 16, 18: session proof, extraction, hard observations ───────────

test('pickFreshSession: 0 new dirs is the session proof failing; >1 is ambiguous', () => {
  // A pre-existing `proxy-<stamp>` dir (the reachability GET) sits in `before`.
  assert.equal(pickFreshSession(['proxy-1'], ['proxy-1', 'sess-a']), 'sess-a');
  assert.throws(
    () => pickFreshSession(['proxy-1'], ['proxy-1']),
    /zero exchange captured/,
  );
  assert.throws(() => pickFreshSession([], ['a', 'b']), /ambiguous capture: 2/);
});

test('readCaptureManifest: absent and empty manifests are both zero-capture', () => {
  const dir = mkTmp('capman');
  try {
    assert.throws(() => readCaptureManifest(dir), /no manifest.jsonl/);
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), '\n\n');
    assert.throws(() => readCaptureManifest(dir), /empty manifest.jsonl/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertGzipObserved: a TRUNCATED gzip whose usage reads null still passes', () => {
  const dir = mkTmp('gzip');
  try {
    // `1f 8b` then garbage: gunzip fails, decodeBlob falls back to raw bytes,
    // readUsage returns null — and the guard must still pass, because it reads
    // the magic bytes, not `usage`. This is the whole point of step 18.
    const truncated = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')]);
    fs.writeFileSync(path.join(dir, '0001.response.sse'), truncated);
    fs.writeFileSync(
      path.join(dir, 'manifest.jsonl'),
      JSON.stringify({ turn: 1, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n',
    );
    assert.equal(readUsage(truncated), null, 'a usage-based guard would lie here');
    assert.equal(assertGzipObserved(dir), 1);

    // Plaintext carries no signature — fatal.
    fs.writeFileSync(path.join(dir, '0001.response.sse'), 'event: message_start\n');
    assert.throws(() => assertGzipObserved(dir), /gzip signature 1f 8b not observed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertCaptureOrder: turns must ascend from 1', () => {
  assert.equal(assertCaptureOrder([{ turn: 1 }, { turn: 2 }]), true);
  assert.throws(() => assertCaptureOrder([{ turn: 2 }, { turn: 1 }]), /not strictly ascending/);
  assert.throws(() => assertCaptureOrder([{ turn: 2 }]), /first captured turn is 2/);
});

test('extractCapture: moves the session dir and is fatal when it is absent', () => {
  const root = mkTmp('extract');
  try {
    const src = path.join(root, 'sessions', 'sess-a');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'manifest.jsonl'), '{}\n');
    const dest = extractCapture(src, path.join(root, 'arm-00', 'capture'));
    assert.equal(fs.existsSync(path.join(dest, 'manifest.jsonl')), true);
    assert.equal(fs.existsSync(src), false, 'the source is moved, not copied');
    assert.throws(() => extractCapture(src, dest), /capture absent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── step 21: arm.json and provenance.json ────────────────────────────────────

test('fixtureCounts: read from the FIXTURE, never from the arm (arm-06 seeds bare)', () => {
  assert.deepEqual(fixtureCounts(), { mcpTools: 64, seedAgents: 8 });
});

test('buildArmRecord: §6 shape, both totals, no per-slot token field', () => {
  const model = {
    exchanges: [
      {
        anatomy: { system: 10, tools: 20, history: 0, currentTurn: 5, total: 35 },
        requestBytes: 40,
        segments: [{ slot: 'tool:Read', bucket: 'tools', bytes: 20, hash: 'h', label: 'l', flagship: true }],
        usage: { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 29367, outputTokens: 103 },
        durationMs: 8412,
        waste: { bloatCount: 3 },
      },
    ],
  };
  const arm = { id: 'arm-00', label: 'temoin', lever: null, seed: 'loaded', settings: { hooks: { SessionStart: [{}] } } };
  const rec = buildArmRecord({ arm, sessionId: 's1', model });

  assert.equal(rec.turn1.anatomy.total, 35);
  assert.equal(rec.turn1.requestBytes, 40, 'both totals are always emitted');
  assert.ok(rec.turn1.anatomy.total < rec.turn1.requestBytes);
  assert.deepEqual(Object.keys(rec.turn1.segments[0]).sort(), ['bucket', 'bytes', 'slot']);
  assert.equal(rec.usage.turn1.cacheCreation, 29367);
  assert.equal(rec.turn2, undefined, 'a one-turn capture emits no turn2');
  assert.equal(rec.context.waste.flagship, 'tool:Read');
  assert.equal(rec.knob, 'hooks.SessionStart (déclaration)');
});

test('buildArmRecord: a null usage OMITS the key rather than zeroing it', () => {
  const model = {
    exchanges: [
      { anatomy: { system: 1, tools: 1, history: 0, currentTurn: 1, total: 3 }, requestBytes: 9, segments: [], usage: null },
    ],
  };
  const rec = buildArmRecord({ arm: { id: 'arm-00', label: 'x', seed: 'bare' }, sessionId: 's', model });
  assert.equal('usage' in rec, false, 'zeroing would publish a false measurement');
});

test('buildProvenance: complete, and fatal without a Claude Code version', () => {
  const p = buildProvenance({
    claudeCodeVersion: '2.1.220',
    model: 'claude-haiku-4-5-20251001',
    port: 41377,
    timestamp: '2026-07-26T10:00:00Z',
    counts: fixtureCounts(),
    listing: listingSizes(undefined),
  });
  assert.equal(p.ccsnoopVersion, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  assert.equal(p.toolSearch, true);
  assert.deepEqual(p.fixtureCounts, { mcpTools: 64, seedAgents: 8 });
  assert.throws(
    () =>
      buildProvenance({
        claudeCodeVersion: '',
        model: 'm',
        port: 1,
        timestamp: 't',
        counts: {},
        listing: {},
      }),
    /provenance incomplete/,
  );
});

test('claudeVersion: parsed off --version, fatal when unobtainable', () => {
  assert.equal(claudeVersion(FAKE_CLAUDE), '2.1.220');
  assert.throws(() => claudeVersion('/nonexistent/claude'), /cannot read the Claude Code version/);
});

// ── the whole per-arm sequence, against the fake binary (zero tokens) ────────

test('cmdArm: full arm 8–21 against the fake claude — artifacts written, secret gone', async () => {
  const root = mkTmp('arm-full');
  const credsSrc = path.join(root, 'fake-creds.json');
  fs.writeFileSync(credsSrc, '{"claudeAiOauth":{"accessToken":"not-a-real-token"}}');
  try {
    const r = await cmdArm('arm-00', { root, claudeBin: FAKE_CLAUDE, credentialsPath: credsSrc });

    assert.equal(r.turns, 2, 'two POSTs captured from one invocation');
    assert.equal(r.toolCount, 6);
    assert.equal(fs.existsSync(path.join(r.captureDir, 'manifest.jsonl')), true);
    assert.equal(
      fs.existsSync(path.join(r.armDir, '.claude', '.credentials.json')),
      false,
      'step 20 scrubbed the secret on the success path',
    );
    // Step 15 ran before extraction and its HTML was discarded — none of it
    // must have been carried into capture/.
    assert.equal(fs.existsSync(path.join(r.captureDir, 'report.html')), false);
    assert.equal(fs.existsSync(path.join(r.armDir, '.report-throwaway.html')), false);

    const arm = JSON.parse(fs.readFileSync(path.join(r.armDir, 'arm.json'), 'utf8'));
    assert.equal(arm.id, 'arm-00');
    assert.equal(arm.sessionId, r.sessionId);
    assert.ok(arm.turn1.requestBytes > arm.turn1.anatomy.total);
    assert.equal(arm.usage.turn2.cacheRead, 29367);
    assert.ok(arm.preflight.tools.includes('Workflow'), 'the observed tools[] is recorded');

    const prov = JSON.parse(fs.readFileSync(path.join(r.runDir, 'provenance.json'), 'utf8'));
    assert.equal(prov.claudeCodeVersion, '2.1.220');
    assert.equal(prov.toolSearch, true);
    assert.deepEqual(prov.fixtureCounts, { mcpTools: 64, seedAgents: 8 });
  } finally {
    await sweepOrphans(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cmdArm: an arm that captures nothing is FATAL, and still scrubs the secret', async () => {
  const root = mkTmp('arm-silent');
  const credsSrc = path.join(root, 'fake-creds.json');
  fs.writeFileSync(credsSrc, '{"claudeAiOauth":{"accessToken":"not-a-real-token"}}');
  const prev = process.env.CCSNOOP_FAKE_MODE;
  process.env.CCSNOOP_FAKE_MODE = 'silent'; // exits 0 having captured nothing
  try {
    await assert.rejects(
      () => cmdArm('arm-00', { root, claudeBin: FAKE_CLAUDE, credentialsPath: credsSrc }),
      /zero exchange captured/,
    );
    // The run dir survives (a later arm must not lose its capture), but the
    // secret is gone via the `finally`.
    const runDir = fs.readdirSync(root).map((e) => path.join(root, e)).find((p) => fs.existsSync(path.join(p, 'cwd')));
    assert.equal(fs.existsSync(path.join(runDir, 'arm-00', '.claude', '.credentials.json')), false);
  } finally {
    if (prev === undefined) delete process.env.CCSNOOP_FAKE_MODE;
    else process.env.CCSNOOP_FAKE_MODE = prev;
    await sweepOrphans(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
