import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as daemon from '../src/daemon.js';
import { init } from '../src/init.js';

const BIN = fileURLToPath(new URL('../bin/ccsnoop.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-daemon-'));
}

/** A fresh git repo in a temp dir (for the `stop --clean` CLI tests). */
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-stop-repo-'));
  const r = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(r.status, 0, 'git init failed');
  return dir;
}

/** Grab an ephemeral free port (released before the caller binds it). */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(p));
    });
  });
}

/** Safety net: ensure no daemon is left running under `home`. */
function killDaemon(home) {
  const pid = daemon.readPid(home);
  if (pid && daemon.isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** A pid guaranteed to be dead (or at least not this process's live daemon). */
function deadPid() {
  // Spawn a trivial child, wait for it to exit, reuse its pid.
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
}

// ── config.json / port ───────────────────────────────────────────────────────

test('resolvePort defaults to 41377 and override persists to config.json', () => {
  const home = mkHome();
  assert.equal(daemon.resolvePort(home, null), 41377);

  // Override wins and is written back.
  assert.equal(daemon.resolvePort(home, 5000), 5000);
  assert.equal(daemon.configuredPort(home), 5000);
  const cfg = JSON.parse(fs.readFileSync(daemon.paths(home).config, 'utf8'));
  assert.equal(cfg.port, 5000);

  // A later start with no override reads the persisted value.
  assert.equal(daemon.resolvePort(home, null), 5000);
});

test('override preserves other config.json keys', () => {
  const home = mkHome();
  daemon.writeConfig(home, { port: 41377, other: 'keep-me' });
  daemon.resolvePort(home, 6000);
  const cfg = daemon.readConfig(home);
  assert.equal(cfg.port, 6000);
  assert.equal(cfg.other, 'keep-me');
});

// ── liveness / pidfile / state ───────────────────────────────────────────────

test('isAlive: true for this process, false for a dead pid and garbage', () => {
  assert.equal(daemon.isAlive(process.pid), true);
  assert.equal(daemon.isAlive(deadPid()), false);
  assert.equal(daemon.isAlive(null), false);
  assert.equal(daemon.isAlive(-1), false);
});

test('readState: none / live / stale pidfile', () => {
  const home = mkHome();
  assert.deepEqual(daemon.readState(home).running, false);

  daemon.writePid(home, process.pid);
  const live = daemon.readState(home);
  assert.equal(live.running, true);
  assert.equal(live.pid, process.pid);
  assert.ok(typeof live.startedAt === 'number');

  daemon.writePid(home, deadPid());
  assert.equal(daemon.readState(home).running, false, 'a dead pid is a stale pidfile');
});

// ── routes / duration / status ───────────────────────────────────────────────

test('countRoutes: 0 without routes.json, N with entries', () => {
  const home = mkHome();
  assert.equal(daemon.countRoutes(home), 0);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(daemon.paths(home).routes, JSON.stringify({ tokA: {}, tokB: {} }));
  assert.equal(daemon.countRoutes(home), 2);
});

test('formatDuration', () => {
  assert.equal(daemon.formatDuration(0), '0s');
  assert.equal(daemon.formatDuration(3000), '3s');
  assert.equal(daemon.formatDuration(63000), '1m 3s');
  assert.equal(daemon.formatDuration(3661000), '1h 1m 1s');
});

test('statusReport: stopped → exit 1; running → exit 0 with pid/port/routes/uptime', () => {
  const home = mkHome();
  const stopped = daemon.statusReport(home);
  assert.equal(stopped.running, false);
  assert.equal(stopped.exitCode, 1);
  assert.equal(stopped.line, 'stopped');

  daemon.writeConfig(home, { port: 12345 });
  fs.writeFileSync(daemon.paths(home).routes, JSON.stringify({ t: {} }));
  daemon.writePid(home, process.pid);
  const started = daemon.statusReport(home, daemon.readState(home).startedAt + 5000);
  assert.equal(started.running, true);
  assert.equal(started.exitCode, 0);
  assert.match(started.line, /^running — pid \d+, port 12345, 1 routes, up 5s$/);
});

// ── start orchestration (injected spawn / port check) ────────────────────────

test('start is idempotent: a live pidfile → already running, exit 0, no spawn', async () => {
  const home = mkHome();
  daemon.writeConfig(home, { port: 41377 });
  daemon.writePid(home, process.pid);
  let spawned = false;
  const res = await daemon.start(home, { spawn: () => { spawned = true; return 1; } });
  assert.equal(res.alreadyRunning, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.line, /already running \(pid \d+, port 41377\)/);
  assert.equal(spawned, false);
});

test('start cleans a stale pidfile and spawns fresh', async () => {
  const home = mkHome();
  daemon.writePid(home, deadPid());
  const res = await daemon.start(home, {
    checkPort: async () => true,
    spawn: () => 4242,
  });
  assert.equal(res.started, true);
  assert.equal(res.pid, 4242);
  assert.equal(res.port, 41377);
  assert.equal(daemon.readPid(home), 4242, 'pidfile now holds the fresh child pid');
  assert.match(res.line, /pid 4242, port 41377/);
});

test('start fails fast on EADDRINUSE — no spawn, exit 1, actionable message', async () => {
  const home = mkHome();
  let spawned = false;
  const res = await daemon.start(home, {
    checkPort: async () => false,
    spawn: () => { spawned = true; return 1; },
  });
  assert.notEqual(res.started, true);
  assert.equal(res.portBusy, true);
  assert.equal(res.exitCode, 1);
  assert.equal(spawned, false, 'no daemon spawned on a busy port');
  assert.match(res.line, /busy/);
  assert.match(res.line, /--port/);
  assert.equal(daemon.readPid(home), null, 'no pidfile written on failure');
});

test('start persists --port override then spawns', async () => {
  const home = mkHome();
  const res = await daemon.start(home, { port: 7777, checkPort: async () => true, spawn: () => 99 });
  assert.equal(res.port, 7777);
  assert.equal(daemon.configuredPort(home), 7777);
});

// ── stop ─────────────────────────────────────────────────────────────────────

test('stop with no/stale pidfile → not running, exit 0, pidfile cleaned', async () => {
  const home = mkHome();
  const none = await daemon.stop(home);
  assert.equal(none.stopped, false);
  assert.equal(none.line, 'not running');
  assert.equal(none.exitCode, 0);

  daemon.writePid(home, deadPid());
  const stale = await daemon.stop(home);
  assert.equal(stale.stopped, false);
  assert.equal(stale.exitCode, 0);
  assert.equal(daemon.readPid(home), null, 'stale pidfile removed');
});

test('stop SIGTERMs a live process and removes the pidfile', async () => {
  const home = mkHome();
  // A child that just sleeps; default SIGTERM disposition terminates it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await sleep(100);
  daemon.writePid(home, child.pid);

  const exited = new Promise((r) => child.on('exit', r));
  const res = await daemon.stop(home, { graceMs: 3000, pollMs: 25 });
  await exited;

  assert.equal(res.stopped, true);
  assert.equal(res.pid, child.pid);
  assert.equal(daemon.isAlive(child.pid), false);
  assert.equal(daemon.readPid(home), null, 'pidfile removed after stop');
});

test('stop SIGKILLs a process that ignores SIGTERM', async () => {
  const home = mkHome();
  // Trap SIGTERM so only SIGKILL can end it — exercises the escalation path.
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ]);
  await sleep(150);
  daemon.writePid(home, child.pid);

  const exited = new Promise((r) => child.on('exit', r));
  const res = await daemon.stop(home, { graceMs: 300, pollMs: 25 });
  await exited;

  assert.equal(res.killed, true);
  assert.equal(daemon.isAlive(child.pid), false);
});

// ── scanLiveRoutes / stranded-session scan (issue #90, gap 2) ────────────────

/** Build a fake `/proc` tree from `{pid, env, cwd}` entries (cwd optional). */
function fakeProc(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-proc-'));
  for (const e of entries) {
    const d = path.join(root, String(e.pid));
    fs.mkdirSync(d, { recursive: true });
    const envVars = Object.entries(e.env).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(path.join(d, 'environ'), envVars.join('\0'));
    if (e.cwd) fs.symlinkSync(e.cwd, path.join(d, 'cwd'));
  }
  return root;
}

test('scanLiveRoutes finds a process holding the daemon port+token, with its cwd', () => {
  const proc = fakeProc([
    { pid: 12345, env: { ANTHROPIC_BASE_URL: 'http://localhost:41377/5805dc48' }, cwd: '/home/x/repo' },
  ]);
  const found = daemon.scanLiveRoutes(41377, { procRoot: proc, selfPid: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].pid, 12345);
  assert.equal(found[0].cwd, '/home/x/repo');
  assert.equal(found[0].token, '5805dc48');
  assert.equal(found[0].url, 'http://localhost:41377/5805dc48');
});

test('scanLiveRoutes also matches 127.0.0.1', () => {
  const proc = fakeProc([
    { pid: 2, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41377/abc12345' }, cwd: '/r' },
  ]);
  const found = daemon.scanLiveRoutes(41377, { procRoot: proc, selfPid: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].token, 'abc12345');
});

test('scanLiveRoutes ignores a wrong port, a foreign URL, a URL under another var, and non-numeric dirs', () => {
  const proc = fakeProc([
    { pid: 10, env: { ANTHROPIC_BASE_URL: 'http://localhost:9999/5805dc48' }, cwd: '/a' }, // wrong port
    { pid: 11, env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, cwd: '/b' },      // foreign
    { pid: 12, env: { OTHER: 'x' }, cwd: '/c' },                                           // no base url
    { pid: 13, env: { DEBUG_URL: 'http://localhost:41377/5805dc48' }, cwd: '/d' },         // right URL, wrong var
  ]);
  // A non-numeric dir entry must be skipped without error.
  fs.mkdirSync(path.join(proc, 'self'));
  fs.writeFileSync(path.join(proc, 'self', 'environ'), '');
  assert.deepEqual(daemon.scanLiveRoutes(41377, { procRoot: proc, selfPid: 1 }), []);
});

test('scanLiveRoutes does not throw on a missing cwd symlink (reports empty cwd)', () => {
  const proc = fakeProc([
    { pid: 20, env: { ANTHROPIC_BASE_URL: 'http://localhost:41377/5805dc48' } }, // no cwd link
  ]);
  const found = daemon.scanLiveRoutes(41377, { procRoot: proc, selfPid: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].cwd, '');
});

test('scanLiveRoutes is a no-op without /proc and never reports the calling process', () => {
  assert.deepEqual(daemon.scanLiveRoutes(41377, { procRoot: '/no/such/proc', selfPid: 1 }), []);

  const proc = fakeProc([
    { pid: 42, env: { ANTHROPIC_BASE_URL: 'http://localhost:41377/5805dc48' }, cwd: '/r' },
  ]);
  assert.deepEqual(
    daemon.scanLiveRoutes(41377, { procRoot: proc, selfPid: 42 }),
    [],
    'the calling process is excluded',
  );
});

test('summarizeStranded groups by cwd with sorted pids', () => {
  const summary = daemon.summarizeStranded([
    { pid: 5, cwd: '/a', token: 't1', url: 'u' },
    { pid: 3, cwd: '/a', token: 't1', url: 'u' }, // same cwd → grouped
    { pid: 9, cwd: '/b', token: 't2', url: 'u' },
    { pid: 7, cwd: '', token: 't3', url: 'u' },    // blank cwd bucketed
  ]);
  assert.equal(summary.count, 3);
  const a = summary.groups.find((g) => g.cwd === '/a');
  assert.deepEqual(a.pids, [3, 5], 'pids sorted ascending within a cwd');
  assert.ok(summary.groups.find((g) => g.cwd === '(unknown cwd)' && g.pids[0] === 7));
});

test('stop returns stranded sessions (injected scan) on the not-running path', async () => {
  const home = mkHome();
  const sentinel = [{ pid: 1, cwd: '/x', token: 't', url: 'u' }];
  const res = await daemon.stop(home, { scanLiveRoutes: () => sentinel });
  assert.equal(res.stopped, false);
  assert.equal(res.line, 'not running');
  assert.equal(res.stranded, sentinel, 'scan runs even when nothing was running');
});

test('stop returns stranded sessions (injected scan) after a real kill', async () => {
  const home = mkHome();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await sleep(100);
  daemon.writePid(home, child.pid);
  const sentinel = [{ pid: 2, cwd: '/y', token: 't2', url: 'u2' }];
  const exited = new Promise((r) => child.on('exit', r));
  const res = await daemon.stop(home, { graceMs: 3000, pollMs: 25, scanLiveRoutes: () => sentinel });
  await exited;
  assert.equal(res.stopped, true);
  assert.equal(res.stranded, sentinel, 'scan ran after the kill');
});

// ── end-to-end through the CLI ───────────────────────────────────────────────

/** Run the CLI to completion; resolve { code, stdout, stderr }. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: start (detached) → status → stop, on an ephemeral port', async () => {
  const home = mkHome();
  // Pick a free port to avoid clashing with the default.
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });

  try {
    const started = await runCli(['start', '--home', home, '--port', String(port)]);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`pid \\d+, port ${port}`));

    const pid = daemon.readPid(home);
    assert.ok(pid && daemon.isAlive(pid), 'daemon is alive after start returns');
    assert.equal(daemon.configuredPort(home), port, 'port persisted to config.json');

    // The daemon is actually listening.
    await sleep(200);
    const reachable = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
    });
    assert.equal(reachable, true, 'daemon accepts connections on the resolved port');

    // Idempotent second start.
    const again = await runCli(['start', '--home', home, '--port', String(port)]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already running/);

    // status → running, exit 0.
    const status = await runCli(['status', '--home', home]);
    assert.equal(status.code, 0);
    assert.match(status.stdout, new RegExp(`running — pid ${pid}, port ${port}, 0 routes, up`));

    // stop → drains, exit 0, pidfile gone, config.json survives.
    const stop = await runCli(['stop', '--home', home]);
    assert.equal(stop.code, 0);
    assert.equal(daemon.readPid(home), null);
    assert.ok(fs.existsSync(daemon.paths(home).config), 'config.json left intact');
    assert.equal(daemon.isAlive(pid), false, 'daemon process gone after stop');

    // status → stopped, exit 1.
    const after = await runCli(['status', '--home', home]);
    assert.equal(after.code, 1);
    assert.match(after.stderr + after.stdout, /stopped/);

    // stop when not running → not running, exit 0.
    const stopAgain = await runCli(['stop', '--home', home]);
    assert.equal(stopAgain.code, 0);
    assert.match(stopAgain.stdout, /not running/);
  } finally {
    // Safety net: ensure no daemon is left behind.
    const pid = daemon.readPid(home);
    if (pid && daemon.isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
});

// ── stop --clean (issue #90, gap 1) ──────────────────────────────────────────

test('CLI: stop --clean un-routes every registered repo', async () => {
  const home = mkHome();
  const repo = mkRepo();
  // Register a route + write settings into the repo (init needs no daemon).
  init({ cwd: repo, home });
  assert.equal(daemon.countRoutes(home), 1);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.local.json')));

  const port = await freePort();
  try {
    assert.equal((await runCli(['start', '--home', home, '--port', String(port)])).code, 0);
    const stop = await runCli(['stop', '--clean', '--home', home]);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /un-routing 1 repo/);
    assert.equal(daemon.countRoutes(home), 0, 'route removed by --clean');
    assert.ok(
      !fs.existsSync(path.join(repo, '.claude', 'settings.local.json')),
      'init-created settings removed',
    );
  } finally {
    killDaemon(home);
  }
});

test('CLI: plain stop leaves routes intact (only the daemon dies)', async () => {
  const home = mkHome();
  const repo = mkRepo();
  init({ cwd: repo, home });

  const port = await freePort();
  try {
    assert.equal((await runCli(['start', '--home', home, '--port', String(port)])).code, 0);
    const stop = await runCli(['stop', '--home', home]);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(daemon.countRoutes(home), 1, 'default stop does NOT un-route (spec §3.4)');
    assert.ok(
      fs.existsSync(path.join(repo, '.claude', 'settings.local.json')),
      'settings left intact by a plain stop',
    );
  } finally {
    killDaemon(home);
  }
});
