// Issue #97 — skill gap 2: the context-tuning skill's guided-bootstrap state
// machine. Part of epic #94 (the publishable context-tuning skill).
//
// The skill is a thin layer that REQUIRES ccsnoop — it drives the instrument, it
// does not re-measure. Before it can run the tuning loop it must get the user to a
// captureable state. That is the bootstrap state machine's one job: detect which of
// four states ccsnoop is in and emit the correct guidance, WITHOUT ever executing
// an install itself (spec guardrail: the skill points, it does not install).
//
//   absent       → ccsnoop isn't on PATH             (point to install instructions)
//   daemon-down  → installed, but `ccsnoop status` is down   (guide `start`)
//   un-init      → up, but this repo isn't wired for capture (guide `init` + restart)
//   ready        → up + this repo's route is registered      (enter the tuning loop)
//
// `decideState` is the PURE decision over three boolean probes (priority order
// above); `detectState` collects those probes from the environment via injectable
// `spawnSync` / `readRoutes`, so the I/O is tested without touching the real
// machine. The script ships STANDALONE inside the skill (no imports from ccsnoop's
// `src/`) so it runs in any host repo that has the `ccsnoop` CLI on PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideState, detectState, repoCaptureDir, isRepoInitialized, STATES } from '../skill/scripts/bootstrap.mjs';

// ─── decideState: pure decision over the three probes ────────────────────────

test('decideState: not installed → absent, regardless of the other probes', () => {
  for (const daemonRunning of [true, false]) {
    for (const repoInitialized of [true, false]) {
      const r = decideState({ installed: false, daemonRunning, repoInitialized });
      assert.equal(r.state, 'absent');
    }
  }
});

test('decideState: installed but daemon down → daemon-down', () => {
  for (const repoInitialized of [true, false]) {
    const r = decideState({ installed: true, daemonRunning: false, repoInitialized });
    assert.equal(r.state, 'daemon-down');
  }
});

test('decideState: up but repo not initialized → un-init', () => {
  const r = decideState({ installed: true, daemonRunning: true, repoInitialized: false });
  assert.equal(r.state, 'un-init');
});

test('decideState: up and repo initialized → ready', () => {
  const r = decideState({ installed: true, daemonRunning: true, repoInitialized: true });
  assert.equal(r.state, 'ready');
});

test('decideState: every state carries a detail and non-empty human guidance', () => {
  const seen = new Set();
  for (const combo of [
    { installed: false, daemonRunning: false, repoInitialized: false },
    { installed: true, daemonRunning: false, repoInitialized: false },
    { installed: true, daemonRunning: true, repoInitialized: false },
    { installed: true, daemonRunning: true, repoInitialized: true },
  ]) {
    const r = decideState(combo);
    assert.ok(STATES.includes(r.state), `unknown state ${r.state}`);
    assert.equal(typeof r.detail, 'string');
    assert.ok(r.detail.length > 0);
    assert.ok(Array.isArray(r.guidance));
    assert.ok(r.guidance.length > 0);
    for (const line of r.guidance) assert.equal(typeof line, 'string');
    seen.add(r.state);
  }
  assert.deepEqual([...seen].sort(), [...STATES].sort(), 'all four states reachable');
});

// ─── guidance contract: point, never execute ─────────────────────────────────

test('absent guidance points the user at the install steps but never claims to run them', () => {
  const { guidance } = decideState({ installed: false, daemonRunning: false, repoInitialized: false });
  const text = guidance.join('\n');
  // The user runs the install; the skill does not. The guardrail is in the words.
  assert.match(text, /install/i);
  assert.doesNotMatch(text, /\bnpm install\b.*\bfor you\b/i);
});

test('daemon-down guidance tells the user to start the daemon', () => {
  const { guidance } = decideState({ installed: true, daemonRunning: false, repoInitialized: false });
  assert.match(guidance.join('\n'), /ccsnoop start/);
});

test('un-init guidance tells the user to init AND restart Claude Code', () => {
  const { guidance } = decideState({ installed: true, daemonRunning: true, repoInitialized: false });
  const text = guidance.join('\n');
  assert.match(text, /ccsnoop init/);
  // init writes the CC env block; the cached ANTHROPIC_BASE_URL only clears on restart.
  assert.match(text, /restart/i);
});

test('ready guidance enters the tuning loop (capture → diagnose → apply → verify)', () => {
  const { guidance } = decideState({ installed: true, daemonRunning: true, repoInitialized: true });
  const text = guidance.join('\n');
  assert.match(text, /ccsnoop fine-tune --json/);
});

test('absent guidance never suggests the daemon/init commands (those presuppose an install)', () => {
  const { guidance } = decideState({ installed: false, daemonRunning: false, repoInitialized: false });
  const text = guidance.join('\n');
  assert.doesNotMatch(text, /ccsnoop start/);
  assert.doesNotMatch(text, /ccsnoop init/);
});

// ─── repoCaptureDir: git-top-level anchoring, mirroring `ccsnoop init` ───────

test('repoCaptureDir: anchors at the git top-level when inside a work tree', () => {
  const spawnSync = (_cmd, args) => {
    if (args && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { status: 0, stdout: '/repos/acme\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'nope' };
  };
  assert.equal(repoCaptureDir('/repos/acme/packages/web', spawnSync), '/repos/acme/.ccsnoop');
});

test('repoCaptureDir: falls back to cwd when not inside a git repo (CC-anchored)', () => {
  const spawnSync = () => ({ status: 128, stdout: '', stderr: 'not a git repo' });
  assert.equal(repoCaptureDir('/home/me/notes', spawnSync), '/home/me/notes/.ccsnoop');
});

// ─── isRepoInitialized: route registered for THIS repo's capture dir ─────────

test('isRepoInitialized: true when a route value resolves to this repo capture dir', () => {
  const routes = { abcd1234: '/repos/acme/.ccsnoop', ef901234: '/repos/other/.ccsnoop' };
  assert.equal(isRepoInitialized(routes, '/repos/acme/.ccsnoop'), true);
});

test('isRepoInitialized: false when only OTHER repos are registered', () => {
  const routes = { ef901234: '/repos/other/.ccsnoop' };
  assert.equal(isRepoInitialized(routes, '/repos/acme/.ccsnoop'), false);
});

test('isRepoInitialized: false when routes is empty', () => {
  assert.equal(isRepoInitialized({}, '/repos/acme/.ccsnoop'), false);
});

test('isRepoInitialized: path-normalizes (trailing slash / relative segments)', () => {
  const routes = { abcd1234: '/repos/acme/.ccsnoop/' };
  assert.equal(isRepoInitialized(routes, '/repos/acme/./.ccsnoop'), true);
});

// ─── detectState: probes wired to decideState via injectable deps ────────────
// A fake spawnSync answering the three probes ccsnoop cares about, plus a canned
// routes reader. Lets us exercise the full matrix without a real daemon/routes.

/**
 * @param {object} opts
 * @returns {(cmd: string, args: string[]) => { status: number, stdout: string, stderr: string }}
 */
function fakeSpawn({ versionOk, statusOk }) {
  return (cmd, args) => {
    // `ccsnoop --help` is the real exit-0 surface (no `--version` flag exists);
    // an absent ccsnoop shows up as a non-zero status here.
    if (cmd === 'ccsnoop' && args[0] === '--help') {
      return versionOk ? { status: 0, stdout: 'ccsnoop — …\n', stderr: '' } : { status: 127, stdout: '', stderr: 'not found' };
    }
    if (cmd === 'ccsnoop' && args[0] === 'status') {
      return statusOk ? { status: 0, stdout: 'running\n', stderr: '' } : { status: 1, stdout: '', stderr: 'stopped' };
    }
    if (cmd === 'git') {
      return { status: 128, stdout: '', stderr: 'no git' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
}

test('detectState: absent when `ccsnoop --help` is not on PATH', () => {
  const r = detectState({
    cwd: '/repos/acme',
    spawnSync: fakeSpawn({ versionOk: false, statusOk: false }),
    readRoutes: () => ({}),
  });
  assert.equal(r.state, 'absent');
});

test('detectState: daemon-down when installed but status exits non-zero', () => {
  const r = detectState({
    cwd: '/repos/acme',
    spawnSync: fakeSpawn({ versionOk: true, statusOk: false }),
    readRoutes: () => ({ abcd1234: '/repos/acme/.ccsnoop' }),
  });
  assert.equal(r.state, 'daemon-down');
});

test('detectState: un-init when up but no route for this repo', () => {
  const r = detectState({
    cwd: '/repos/acme',
    spawnSync: fakeSpawn({ versionOk: true, statusOk: true }),
    readRoutes: () => ({ ef901234: '/repos/other/.ccsnoop' }),
  });
  assert.equal(r.state, 'un-init');
});

test('detectState: ready when up and this repo is registered', () => {
  const r = detectState({
    cwd: '/repos/acme',
    spawnSync: fakeSpawn({ versionOk: true, statusOk: true }),
    readRoutes: () => ({ abcd1234: '/repos/acme/.ccsnoop' }),
  });
  assert.equal(r.state, 'ready');
});

test('detectState: surfaces the resolved capture dir + matched token on ready (for the loop)', () => {
  const r = detectState({
    cwd: '/repos/acme',
    spawnSync: fakeSpawn({ versionOk: true, statusOk: true }),
    readRoutes: () => ({ abcd1234: '/repos/acme/.ccsnoop' }),
  });
  assert.equal(r.captureDir, '/repos/acme/.ccsnoop');
  assert.equal(r.routeToken, 'abcd1234');
});
