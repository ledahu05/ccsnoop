#!/usr/bin/env node
// Issue #97 — skill gap 2: the context-tuning skill's guided-bootstrap state
// machine. Part of epic #94 (the publishable context-tuning skill).
//
// The skill is a thin layer that REQUIRES ccsnoop — it drives the instrument, it
// does not re-measure. Before it can run the tuning loop it must get the user to a
// captureable state. That is this script's one job: detect which of four states
// ccsnoop is in and emit the correct guidance — WITHOUT ever executing an install
// itself (the skill points, it does not install; never auto-installs npm/globals).
//
//   absent       → ccsnoop isn't on PATH             → point to install instructions
//   daemon-down  → installed, but `ccsnoop status` is down → guide `ccsnoop start`
//   un-init      → up, but this repo isn't wired for capture → guide `ccsnoop init` + restart
//   ready        → up + this repo's route is registered      → enter the tuning loop
//
// STANDALONE BY DESIGN: this file ships inside the skill and runs in any host repo.
// It imports ONLY node builtins — never anything from ccsnoop's `src/` — so the
// host repo does not need ccsnoop's source on disk, only the `ccsnoop` CLI on PATH.
// It consumes ccsnoop strictly through its scriptable surfaces:
//   • `ccsnoop --help`  → exit 0 ⇒ on PATH (no `--version` flag exists)
//   • `ccsnoop status`  → exit 0 ⇒ daemon running
//   • `~/.ccsnoop/routes.json` → the token→dir map `ccsnoop init` writes
// and reads no capture data (redaction contract, spec §1.3: `.ccsnoop/` bodies are
// inviolable; this script never opens a session file).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The spawn shape this module depends on: a command, its args, and an optional
 * `{ cwd }`. The return is intentionally permissive (`stdout`/`stderr` may be a
 * Buffer or a string) so both the real `spawnSync` and a plain test fake satisfy
 * it. Defined as a single-signature wrapper around the (overloaded) node import so
 * the default is assignable without overload-resolution pain.
 *
 * @typedef {(cmd: string, args: string[], options?: { cwd?: string }) => { status: number | null, stdout: string | Buffer, stderr?: string | Buffer }} SpawnFn
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {{ status: number | null, stdout: string | Buffer, stderr?: string | Buffer }}
 */
function runSync(cmd, args, opts) {
  return spawnSync(cmd, args, opts);
}

/** The four states, in detection (priority) order. */
export const STATES = /** @type {const} */ (['absent', 'daemon-down', 'un-init', 'ready']);

/** Where ccsnoop's machine-level home is (mirrors `src/daemon.js` `defaultHome`). */
function defaultHome(env = process.env) {
  return env.CCSNOOP_HOME || path.join(os.homedir(), '.ccsnoop');
}

/**
 * The install pointer the `absent` state hands the user. The skill never runs it.
 * Kept as a constant so the guidance and the test agree on the exact wording.
 */
const INSTALL_POINTER = [
  'ccsnoop is not on your PATH. Install it (the skill will not run installs for you):',
  '  git clone https://github.com/ledahu05/ccsnoop.git',
  '  cd ccsnoop && npm install -g .',
  'See the README "Install ccsnoop" section, then re-run this skill.',
].join('\n');

/**
 * PURE decision over the three probes. Priority is fixed: an absent install
 * short-circuits before the daemon/repo probes, and a down daemon before the repo
 * probe — each later probe presupposes the earlier one. No I/O.
 *
 * @param {{ installed: boolean, daemonRunning: boolean, repoInitialized: boolean }} probes
 * @returns {{ state: (typeof STATES)[number], detail: string, guidance: string[] }}
 */
export function decideState({ installed, daemonRunning, repoInitialized }) {
  if (!installed) {
    return {
      state: 'absent',
      detail: 'ccsnoop is not installed (not on PATH).',
      guidance: INSTALL_POINTER.split('\n'),
    };
  }
  if (!daemonRunning) {
    return {
      state: 'daemon-down',
      detail: 'ccsnoop is installed but the capture daemon is not running.',
      guidance: [
        'Start the daemon (returns immediately; detached):',
        '  ccsnoop start',
        'Then re-run this skill to continue.',
      ],
    };
  }
  if (!repoInitialized) {
    return {
      state: 'un-init',
      detail: 'Daemon is up, but this repo is not wired for capture.',
      guidance: [
        'Activate capture for this repo:',
        '  ccsnoop init',
        'Then RESTART Claude Code — init writes the env block, but the cached',
        'ANTHROPIC_BASE_URL only clears on restart. After restart, re-run this skill.',
      ],
    };
  }
  return {
    state: 'ready',
    detail: 'Daemon is up and this repo is wired for capture.',
    guidance: [
      'Ready to tune. Capture a representative Claude Code session, then run the loop:',
      '  ccsnoop fine-tune --json > report.json     # diagnose (the #95 contract)',
      '  ccsnoop apply --from report.json --dry-run # review the safe-subset diff',
      '  ccsnoop apply --from report.json --yes     # apply the safe levers on approval',
      '  ccsnoop verify --before <id> --after <id>  # prove the floor moved (re-capture)',
      'If a fresh capture comes up empty, restart Claude Code to clear the cached base URL.',
    ],
  };
}

/**
 * The capture dir ccsnoop would route this repo to: `<git-top-level>/.ccsnoop`, or
 * `<cwd>/.ccsnoop` when not inside a git repo. Mirrors `src/init.js` `resolvePaths`
 * (git top-level wins; non-git anchors to CC's project dir).
 *
 * @param {string} cwd
 * @param {SpawnFn} [spawnSyncFn]
 * @returns {string}
 */
export function repoCaptureDir(cwd, spawnSyncFn = runSync) {
  const r = spawnSyncFn('git', ['rev-parse', '--show-toplevel'], { cwd });
  const top = r.status === 0 ? String(r.stdout || '').trim() : '';
  const anchor = top || path.resolve(cwd);
  return path.join(anchor, '.ccsnoop');
}

/**
 * Find the route token registered for this repo's capture dir, if any. Reuses the
 * exact mapping `ccsnoop init` writes (token → abs capture dir) without importing
 * ccsnoop — a path-resolve equality, so trailing slashes / `.` segments don't cause
 * a false negative.
 * @param {Record<string, string>} routes
 * @param {string} captureDir
 * @returns {string | null}
 */
function tokenFor(routes, captureDir) {
  const want = path.resolve(captureDir);
  for (const [token, dir] of Object.entries(routes || {})) {
    if (path.resolve(dir) === want) return token;
  }
  return null;
}

/**
 * Is this repo initialized? True iff some route in `routes.json` resolves to this
 * repo's capture dir — i.e. {@link tokenFor} found a match. A thin boolean view of
 * the same resolve-and-compare walk (kept because the decision reads as a boolean).
 * @param {Record<string, string>} routes token → absolute capture dir
 * @param {string} captureDir
 * @returns {boolean}
 */
export function isRepoInitialized(routes, captureDir) {
  return tokenFor(routes, captureDir) != null;
}

/**
 * Read `~/.ccsnoop/routes.json` (token → dir). Missing/malformed → `{}`. Mirrors
 * `src/daemon.js` `readState`'s "never throw on a missing home file" leniency.
 * @param {string} home
 * @returns {Record<string, string>}
 */
export function readRoutesFile(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'routes.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Collect the three probes from the environment and decide. All I/O is via
 * injectable `spawnSync` / `readRoutes` so the decision matrix is testable without a
 * real daemon or routes file. Defaults do the real work when run as a CLI.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {SpawnFn} [opts.spawnSync]
 * @param {() => Record<string, string>} [opts.readRoutes]
 * @returns {{ state: (typeof STATES)[number], detail: string, guidance: string[], captureDir: string, routeToken: string|null, installed: boolean, daemonRunning: boolean }}
 */
export function detectState(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const home = opts.home || defaultHome(opts.env);
  const spawnFn = opts.spawnSync || runSync;
  const readRoutes = opts.readRoutes || (() => readRoutesFile(home));

  // Probe 1 — installed: `ccsnoop --help` exits 0 iff our CLI is on PATH. (There is
  // no `--version` flag; an unknown subcommand exits 1, so `--help` is the safe
  // exit-0 surface. An absent binary surfaces as a non-zero status / ENOENT.)
  const help = spawnFn('ccsnoop', ['--help']);
  const installed = help.status === 0;

  // Probe 2 — daemon running: `ccsnoop status` is exit 0 / exit 1 (systemctl-style).
  // Only probe when installed — `&&` short-circuits the RESULT, not the spawn, so
  // guarding avoids a redundant (and doomed) `ccsnoop status` on the absent path.
  const status = installed ? spawnFn('ccsnoop', ['status']) : null;
  const daemonRunning = status !== null && status.status === 0;

  // Probe 3 — this repo initialized: a route registered for its capture dir.
  const captureDir = repoCaptureDir(cwd, spawnFn);
  const routes = readRoutes();
  const repoInitialized = isRepoInitialized(routes, captureDir);
  const routeToken = tokenFor(routes, captureDir);

  const decision = decideState({ installed, daemonRunning, repoInitialized });
  return { ...decision, captureDir, routeToken, installed, daemonRunning };
}

// ─── CLI entry: `node bootstrap.mjs [--json] [--cwd <path>] [--home <path>]` ───
// Emitted for the skill (and a human). `--json` is the machine surface the skill's
// loop reads; plain text is the guided walkthrough. Exit is 0 regardless of state —
// this is a detector that reports a state, not a pass/fail gate.

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const wantJson = args.includes('--json');
  const result = detectState({ cwd: flag('--cwd'), home: flag('--home') });

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`ccsnoop bootstrap: ${result.state}\n${result.detail}\n\n`);
    process.stdout.write(result.guidance.join('\n') + '\n');
  }
}
