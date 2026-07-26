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
  turn1View,
  assertKnobTook,
  parseDenyEntry,
  removalNames,
  assertDenyTargetsObserved,
  sentinelPresent,
  assertSentinel,
  assertBundledSkillsNonEmpty,
  leverSentinels,
  assertLeverIntegrity,
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

// ── Step 19: lever integrity guards (bench/SPEC.md §4, §5) ───────────────────

/** A synthetic turn-1 view: segment slots (keys + bytes) and raw request text. */
function view(slots, text = '') {
  return { slots: slots.map(([slot, bytes, bucket]) => ({ slot, bytes, bucket: bucket ?? 'tools' })), text };
}

const PERSONA_SENTINEL = 'CCSNOOP-BENCH-SENTINEL-PERSONA-8b17e6d0';
const CLAUDEMD_SENTINEL = 'CCSNOOP-BENCH-SENTINEL-CLAUDEMD-4f3a9c21';

/** A sentinel literal, cast past checkJs's string-widening of `kind`. @returns {any} */
function sen(o) {
  return o;
}

test('turn1View: reads segments (slot/bucket/bytes) and the raw request text', () => {
  const model = {
    exchanges: [
      {
        segments: [{ slot: 'tool:Read', bucket: 'tools', bytes: 20, hash: 'h' }],
        requestBlob: '{"model":"m"}',
      },
      { segments: [], requestBlob: 'turn2' },
    ],
  };
  const v = turn1View(model);
  assert.deepEqual(v.slots, [{ slot: 'tool:Read', bucket: 'tools', bytes: 20 }]);
  assert.equal(v.text, '{"model":"m"}');
  // An empty model degrades to an empty view, never throws.
  assert.deepEqual(turn1View({}), { slots: [], text: '' });
});

// Guard 1 — "did the knob take?"

test('assertKnobTook: a lever arm byte-identical to the witness is FATAL, naming the knob', () => {
  const witness = view([['tool:Workflow', 21525], ['system', 100]]);
  const same = view([['tool:Workflow', 21525], ['system', 100]]);
  assert.throws(() => assertKnobTook(witness, same, 'permissions.deny'), /knob 'permissions.deny' never took/);
  assert.throws(() => assertKnobTook(witness, same, 'permissions.deny'), /byte-identical to the witness/);
});

test('assertKnobTook: a knob that moved bytes (a removed slot) passes', () => {
  const witness = view([['tool:Workflow', 21525], ['system', 100]]);
  const arm = view([['system', 100]]); // Workflow removed
  assert.equal(assertKnobTook(witness, arm, 'permissions.deny'), true);
});

test('assertKnobTook: SET membership, not hash — identical slots under a differing session_id are still caught', () => {
  // The raw text differs (a different session_id / tool_use_id moves the bytes at
  // Δ0), yet the slot set + bytes are identical: a hash comparison would call these
  // "different" and let a knob that never took slip through. Set membership catches it.
  const witness = view([['tool:Workflow', 21525]], 'session_id=aaaa tool_use_id=1111');
  const arm = view([['tool:Workflow', 21525]], 'session_id=bbbb tool_use_id=2222');
  assert.throws(() => assertKnobTook(witness, arm, 'permissions.deny'), /never took/);
});

test('assertKnobTook: a slot present in both but with differing bytes is NOT identical (knob took)', () => {
  const witness = view([['system#2', 500]]);
  const arm = view([['system#2', 545]]); // B6: system#2 churns bytes per arm
  assert.equal(assertKnobTook(witness, arm, 'x'), true);
});

test('assertKnobTook: a knob that took but nets to ~0 bytes (substitution) still exits 0', () => {
  // Denying Bash removes tool:Bash but brings Glob+Grep back — a nil/negative NET
  // delta, yet the SLOT SET differs, so it is a real measurement (§4), not Guard 1.
  const witness = view([['tool:Bash', 4600]]);
  const arm = view([['tool:Glob', 981], ['tool:Grep', 3640]]); // ~= same total, different slots
  assert.equal(assertKnobTook(witness, arm, 'permissions.deny'), true);
});

// Scope classification — Tool(*) and an empty scope behave as a bare name (§3, B6)

test('parseDenyEntry: bare name, empty scope and * scope all mean whole-tool removal', () => {
  assert.deepEqual(parseDenyEntry('Workflow'), { name: 'Workflow', removal: true });
  assert.deepEqual(parseDenyEntry('Bash(*)'), { name: 'Bash', removal: true });
  assert.deepEqual(parseDenyEntry('Bash()'), { name: 'Bash', removal: true });
  // Discriminates on scope CONTENT, not the presence of a parenthesis.
  assert.deepEqual(parseDenyEntry('Bash(git:*)'), { name: 'Bash', removal: false });
  assert.deepEqual(parseDenyEntry('Read(./secret)'), { name: 'Read', removal: false });
});

test('removalNames: only removal-scoped deny entries name a removed tool', () => {
  const perms = { deny: ['Workflow', 'Bash(git:*)', 'Grep(*)'] };
  assert.deepEqual(removalNames(perms), ['Workflow', 'Grep']);
  assert.deepEqual(removalNames({}), []);
  assert.deepEqual(removalNames({ deny: 'nope' }), []);
});

// AC#2 (issue #62, §3, §10.3) — arm-01's deny targets are grounded in observation.

test('assertDenyTargetsObserved: every deny target must appear in the witness observed tools[]', () => {
  const witnessTools = ['Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Workflow'];
  // Workflow IS observed — the calibrated arm-01 choice (37% of the tools bucket, B6).
  assert.deepEqual(assertDenyTargetsObserved(['Workflow'], witnessTools, 'arm-01'), ['Workflow']);
  // A target the witness never carried is a "list written in advance" — FATAL, named.
  assert.throws(
    () => assertDenyTargetsObserved(['Workflow', 'NeverSeen'], witnessTools, 'arm-01'),
    /arm-01: permissions\.deny targets \[NeverSeen\] are not in the witness's observed tools/,
  );
  // No deny targets → nothing to ground.
  assert.deepEqual(assertDenyTargetsObserved([], witnessTools, 'arm-02'), []);
});

test('assertLeverIntegrity: an L1 arm grounds its deny targets when the witness tools[] is supplied', () => {
  const arm = { id: 'arm-01', lever: 'L1', label: 'L1 tools deny', settings: { permissions: { deny: ['Workflow'] } } };
  const witnessView = view([['tool:Workflow', 21525], ['system', 100]]);
  const armView = view([['system', 100]]); // Workflow removed
  // Grounded: Workflow is in the witness's observed tools[] → passes.
  const ok = assertLeverIntegrity({ arm, witnessView, armView, witnessTools: ['Read', 'Workflow'] });
  assert.ok(ok.sentinels.some((s) => s.name === 'L1 tools deny'));
  // Ungrounded: Workflow absent from the observed tools[] → FATAL (a list written in advance).
  assert.throws(
    () => assertLeverIntegrity({ arm, witnessView, armView, witnessTools: ['Read', 'Edit'] }),
    /not in the witness's observed tools/,
  );
  // Backward compatible: with no witnessTools supplied, the grounding check is skipped.
  assert.ok(assertLeverIntegrity({ arm, witnessView, armView }).sentinels);
});

// Guard 2 — "did the knob take on the RIGHT bytes?" (per-lever sentinels)

test('sentinelPresent: slot kind is set membership; literal kind is a substring of the request text', () => {
  const v = view([['tool:Workflow', 10]], `body ${PERSONA_SENTINEL} more`);
  assert.equal(sentinelPresent(sen({ name: 'L1', kind: 'slot', slots: ['tool:Workflow'] }), v), true);
  assert.equal(sentinelPresent(sen({ name: 'L1', kind: 'slot', slots: ['tool:Absent'] }), v), false);
  assert.equal(sentinelPresent(sen({ name: 'L2', kind: 'literal', text: PERSONA_SENTINEL }), v), true);
  assert.equal(sentinelPresent(sen({ name: 'L2', kind: 'literal', text: 'not-here' }), v), false);
  // An empty slot set is never "present".
  assert.equal(sentinelPresent(sen({ name: 'x', kind: 'slot', slots: [] }), v), false);
});

test('assertSentinel: present-in-witness AND absent-in-arm passes; either violation is FATAL', () => {
  const witness = view([['tool:Workflow', 10]], `has ${PERSONA_SENTINEL}`);
  const arm = view([['system', 5]], 'no sentinel here');
  const s = sen({ name: 'L2 hooks', kind: 'literal', text: PERSONA_SENTINEL });
  assert.deepEqual(assertSentinel(s, witness, arm), {
    name: 'L2 hooks',
    presentInWitness: true,
    absentInArm: true,
  });
  // Present in the arm → the knob did not remove it.
  assert.throws(() => assertSentinel(s, witness, witness), /still present in the lever arm/);
  // Absent from the witness → the reference is broken.
  assert.throws(() => assertSentinel(s, arm, arm), /absent from the witness/);
});

// Bundled-skills listing must be non-empty (§3, §5 step 19)

test('assertBundledSkillsNonEmpty: a non-empty listing returns its size; an empty one is FATAL', () => {
  assert.equal(assertBundledSkillsNonEmpty(['skill:a', 'skill:b']), 2);
  assert.throws(() => assertBundledSkillsNonEmpty([]), /bundled-skills listing is empty/);
  assert.throws(() => assertBundledSkillsNonEmpty(undefined), /bundled-skills listing is empty/);
});

// Sentinel declarations per arm (§3 table), read against the real committed manifest.

test('leverSentinels: the witness (lever null) declares none; each lever declares the right kind', () => {
  const m = readManifest(MANIFEST_PATH);
  const byId = (id) => m.arms.find((a) => a.id === id);

  assert.deepEqual(leverSentinels(byId('arm-00')), []);

  const s01 = leverSentinels(byId('arm-01'));
  assert.deepEqual(s01, [{ name: 'L1 tools deny', kind: 'slot', slots: ['tool:Workflow'] }]);

  const s02 = leverSentinels(byId('arm-02'));
  assert.equal(s02.length, 1);
  assert.equal(s02[0].kind, 'literal');
  assert.equal(s02[0].text, PERSONA_SENTINEL);

  const s03 = leverSentinels(byId('arm-03'));
  assert.equal(s03[0].text, CLAUDEMD_SENTINEL);

  const s04 = leverSentinels(byId('arm-04'));
  assert.equal(s04[0].kind, 'literal'); // a stub tool name

  const s06 = leverSentinels(byId('arm-06'));
  assert.equal(s06[0].kind, 'literal'); // an agent name from the loaded seed

  // arm-07 (all keys + seed bare) declares all four literal/name sentinels.
  const s07 = leverSentinels(byId('arm-07'));
  const texts07 = s07.filter((s) => s.kind === 'literal').map((s) => s.text);
  assert.ok(texts07.includes(PERSONA_SENTINEL));
  assert.ok(texts07.includes(CLAUDEMD_SENTINEL));
  assert.equal(texts07.filter(Boolean).length, 4, 'persona, claude.md, stub tool, agent');
});

// Orchestrator — the whole step, over synthetic arm views (zero API tokens).

test('assertLeverIntegrity: the witness is a no-op (it IS the reference)', () => {
  const arm = { id: 'arm-00', lever: null, settings: { hooks: { SessionStart: [{}] } } };
  assert.deepEqual(assertLeverIntegrity({ arm, witnessView: view([]), armView: view([]) }), { skipped: true });
});

test('assertLeverIntegrity: a clean L2 arm passes both guards', () => {
  const arm = { id: 'arm-02', lever: 'L2', label: 'L2 hooks', settings: { hooks: { SessionStart: [] } } };
  const witnessView = view([['system', 100], ['message#0', 8500]], `turn body ${PERSONA_SENTINEL}`);
  const armView = view([['system', 100], ['message#0', 300]], 'turn body without the persona');
  const r = assertLeverIntegrity({ arm, witnessView, armView });
  assert.deepEqual(r.sentinels, [{ name: 'L2 hooks', presentInWitness: true, absentInArm: true }]);
});

test('assertLeverIntegrity: a clean L1 arm passes Guard 2 by the SLOT sentinel (not a literal)', () => {
  // The only orchestrator path where Guard 2 rides a slot-kind sentinel: L1 removes
  // the whole `tool:Workflow` slot, so it must be PRESENT in the witness's slot set
  // and ABSENT from the arm's — never a substring of the request text.
  const arm = { id: 'arm-01', lever: 'L1', label: 'L1 tools deny', settings: { permissions: { deny: ['Workflow'] } } };
  const witnessView = view([['tool:Workflow', 21525], ['system', 100]]);
  const armView = view([['system', 100]]); // Workflow removed → Guard 1 ok, slot gone
  const r = assertLeverIntegrity({ arm, witnessView, armView });
  assert.deepEqual(r.sentinels, [{ name: 'L1 tools deny', presentInWitness: true, absentInArm: true }]);

  // The knob moved bytes (Guard 1 green) but left tool:Workflow behind → Guard 2 FATAL.
  const armKept = view([['tool:Workflow', 999], ['system', 100]]);
  assert.throws(() => assertLeverIntegrity({ arm, witnessView, armView: armKept }), /still present in the lever arm/);
});

test('assertLeverIntegrity: a knob that did not take is FATAL at Guard 1', () => {
  const arm = { id: 'arm-03', lever: 'L3', label: 'L3', settings: { claudeMdExcludes: ['CLAUDE.md'] } };
  const same = view([['message#0', 8500]], `body ${CLAUDEMD_SENTINEL}`);
  assert.throws(() => assertLeverIntegrity({ arm, witnessView: same, armView: same }), /never took/);
});

test('assertLeverIntegrity: the persona injected on the WRONG bytes (Guard 1 green, Guard 2 red)', () => {
  // A failing `cat` injects an error string: the arm differs from the witness (Guard
  // 1 passes) but the persona sentinel is still gone from the arm as expected AND the
  // arm re-introduces it — model the dangerous case where it lingers in the arm.
  const arm = { id: 'arm-02', lever: 'L2', label: 'L2', settings: { hooks: { SessionStart: [] } } };
  const witnessView = view([['message#0', 8500]], `ok ${PERSONA_SENTINEL}`);
  const armView = view([['message#0', 120]], `error string but still ${PERSONA_SENTINEL}`);
  assert.throws(() => assertLeverIntegrity({ arm, witnessView, armView }), /still present in the lever arm/);
});

test('assertLeverIntegrity: L5 asserts the witness skills listing non-empty and the arm strips it', () => {
  const arm = { id: 'arm-05', lever: 'L5', label: 'L5', settings: { disableBundledSkills: true } };
  const witnessView = view([['tool:Read', 10]]);
  const armView = view([['tool:Read', 10], ['x', 1]]); // slot set differs → Guard 1 ok
  // Happy path — witness has skills, the arm has none.
  const r = assertLeverIntegrity({
    arm, witnessView, armView,
    witnessSkills: ['skill:code-review', 'skill:tdd'],
    armSkills: [],
  });
  assert.ok(r.sentinels.some((s) => s.name === 'L5 skills'));
  // An empty witness listing is FATAL (L5 would be an empty arm).
  assert.throws(
    () => assertLeverIntegrity({ arm, witnessView, armView, witnessSkills: [], armSkills: [] }),
    /bundled-skills listing is empty/,
  );
  // A skill still present in the arm is FATAL (the knob did not take).
  assert.throws(
    () =>
      assertLeverIntegrity({
        arm, witnessView, armView,
        witnessSkills: ['skill:tdd'],
        armSkills: ['skill:tdd'],
      }),
    /bundled skills still present/,
  );
});

test('assertLeverIntegrity: arm-07 checks all four literal sentinels absent from the arm', () => {
  const m = readManifest(MANIFEST_PATH);
  const arm = m.arms.find((a) => a.id === 'arm-07');
  const stubTool = leverSentinels(arm).filter((s) => s.kind === 'literal').map((s) => s.text)[2];
  const agent = leverSentinels(arm).filter((s) => s.kind === 'literal').map((s) => s.text)[3];
  // Witness carries every sentinel; the arm (seed bare + all keys) carries none.
  const witnessView = view(
    [['tool:Workflow', 100], ['message#0', 8500]],
    `${PERSONA_SENTINEL} ${CLAUDEMD_SENTINEL} ${stubTool} ${agent}`,
  );
  const armView = view([['message#0', 120]], 'nothing subtractive survived');
  const r = assertLeverIntegrity({
    arm, witnessView, armView,
    witnessSkills: ['skill:tdd'],
    armSkills: [],
  });
  assert.ok(r.sentinels.length >= 4);
  // If any one sentinel lingers in the arm, it is FATAL.
  const armWithAgent = view([['message#0', 120]], `leaked ${agent}`);
  assert.throws(
    () => assertLeverIntegrity({ arm, witnessView, armView: armWithAgent, witnessSkills: ['skill:tdd'], armSkills: [] }),
    /still present in the lever arm/,
  );
});
