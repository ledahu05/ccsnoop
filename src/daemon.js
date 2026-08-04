// Daemon lifecycle (spec §3.4) — `ccsnoop start | stop | status`.
//
// One machine-level daemon under `~/.ccsnoop/`, explicit start/stop, no wrapper
// and no always-on service. The port is the single source of truth in
// `config.json`; the running proxy is tracked by a `daemon.pid` pidfile with its
// stdout/stderr detached to `daemon.log`. Everything here is pure orchestration
// (filesystem + signals) so the actual proxy server stays in `proxy.js`.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Default listen port when no daemon has ever written `config.json` (spec §3.4). */
export const DEFAULT_PORT = 41377;

/** The machine-level ccsnoop home. Honours `$CCSNOOP_HOME` for tests/isolation. */
export function defaultHome() {
  return process.env.CCSNOOP_HOME || path.join(os.homedir(), '.ccsnoop');
}

/**
 * The fixed set of files under a ccsnoop home.
 * @param {string} home
 */
export function paths(home) {
  return {
    config: path.join(home, 'config.json'),
    pid: path.join(home, 'daemon.pid'),
    log: path.join(home, 'daemon.log'),
    routes: path.join(home, 'routes.json'),
    sessions: path.join(home, 'sessions'),
  };
}

/**
 * Read `config.json` — the single source of truth for the port. Missing or
 * malformed config is treated as empty (the caller falls back to the default).
 * @param {string} home
 * @returns {Record<string, unknown>}
 */
export function readConfig(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(home).config, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write `config.json` (pretty-printed, trailing newline). Creates the home dir.
 * @param {string} home
 * @param {Record<string, unknown>} config
 */
export function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(paths(home).config, JSON.stringify(config, null, 2) + '\n');
}

/**
 * The port from `config.json`, or {@link DEFAULT_PORT}. Non-integer/invalid
 * values fall back to the default rather than propagating garbage.
 * @param {string} home
 * @returns {number}
 */
export function configuredPort(home) {
  const raw = Number(readConfig(home).port);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

/**
 * Resolve the port for a `start`. An explicit `--port` override wins and is
 * **persisted back** to `config.json` so `init` and the daemon stay in sync
 * (spec §3.4). Otherwise the configured port (default 41377) is used.
 * @param {string} home
 * @param {number|null|undefined} override
 * @returns {number}
 */
export function resolvePort(home, override) {
  if (override != null) {
    const cfg = readConfig(home);
    cfg.port = override;
    writeConfig(home, cfg);
    return override;
  }
  return configuredPort(home);
}

/**
 * A daemon that has exited but not yet been reaped lingers as a `<defunct>`
 * zombie whose pid still answers `process.kill(pid, 0)`. The daemon is orphaned
 * the instant `start` returns (its launching shell exits), so it is reparented
 * to the OS init — normally reaped at once, but a non-reaping init (some
 * containers) can leave it around. A zombie is not serving, so we treat it as
 * dead. Linux-only via `/proc`; elsewhere `/proc` is absent and this is a no-op.
 * @param {number} pid
 * @returns {boolean}
 */
function isZombie(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Skip past `comm` (parenthesised, may contain spaces) to the state field.
    const state = stat.slice(stat.lastIndexOf(')') + 2).trimStart()[0];
    return state === 'Z';
  } catch {
    return false;
  }
}

/**
 * A live process still holding a ccsnoop-shaped `ANTHROPIC_BASE_URL` in its env
 * — a session a `stop` just stranded (issue #90).
 * @typedef {Object} StrandedRoute
 * @property {number} pid
 * @property {string} cwd   Working tree (empty if `/proc/<pid>/cwd` was unreadable).
 * @property {string} token The 8-hex route token cached in the URL.
 * @property {string} url   The full `http://localhost:<port>/<token>` base URL.
 */

/**
 * The result of {@link stop}.
 * @typedef {Object} StopResult
 * @property {boolean} stopped   True iff a live daemon was actually terminated.
 * @property {StrandedRoute[]} stranded Live sessions still routed at the daemon's port.
 * @property {string} line
 * @property {number} exitCode
 * @property {number} [pid]     Present only when a daemon was actually stopped.
 * @property {boolean} [killed] Present only when SIGKILL escalation was used.
 */

/**
 * One stranded working tree in a {@link StrandedSummary}: a session's main
 * process plus the children that inherited its cached env.
 * @typedef {Object} StrandedGroup
 * @property {string} cwd
 * @property {number[]} pids
 * @property {string} token
 */

/**
 * {@link summarizeStranded}'s output: stranded sessions collapsed by cwd.
 * @typedef {Object} StrandedSummary
 * @property {number} count          Number of distinct cwds (sessions).
 * @property {StrandedGroup[]} groups
 */

/**
 * The URL a live Claude Code session caches after `ccsnoop init`:
 * `http://localhost:<port>/<token>` (§3.2/§3.3), also accepting `127.0.0.1`.
 * Parameterised by port so {@link scanLiveRoutes} only flags sessions pointing
 * at the daemon we actually control.
 * @param {number} port
 * @returns {RegExp}
 */
function liveRouteUrlRe(port) {
  // Anchor to the env-var name so a ccsnoop-shaped URL appearing in some OTHER
  // env var (a debug/log value) can't false-positive: environ is NUL-separated
  // `KEY=VALUE`, so `ANTHROPIC_BASE_URL=` always precedes the cached URL. Group 1
  // = the base URL, group 2 = the token. `:<port>/` is anchored by the colon
  // before and the slash + 8-hex token after, so port 4137 never matches 41377.
  return new RegExp(
    `ANTHROPIC_BASE_URL=(https?://(?:localhost|127\\.0\\.0\\.1):${port}/([0-9a-f]{8}))`,
  );
}

/**
 * Scan `/proc/<pid>/environ` for live processes still holding a ccsnoop-shaped
 * `ANTHROPIC_BASE_URL` at `localhost:<port>` — i.e. the Claude Code sessions a
 * `stop` just stranded (issue #90, gap 2). CC caches that env at launch and
 * never re-reads it, so once the daemon dies these sessions retry on
 * `ConnectionRefused` forever; this lists them so the user knows which sessions
 * to restart.
 *
 * Returns `{pid, cwd, token, url}` per match. Linux-only via `/proc`; where
 * `/proc` is absent (macOS/Windows, or an injected test root) this is a no-op
 * returning `[]`. Processes whose environ we cannot read (owned by another user,
 * kernel threads, already-reaped) are skipped silently, and the calling process
 * is excluded. NB: a session launched under an older port (before `start --port`
 * changed it) carries that older port and won't be flagged — the scan keys off
 * the *current* configured port only.
 *
 * @param {number} port
 * @param {object} [opts]
 * @param {string} [opts.procRoot] Injectable `/proc` root (testing/isolation).
 * @param {number} [opts.selfPid]  pid to exclude (default `process.pid`).
 * @returns {StrandedRoute[]}
 */
export function scanLiveRoutes(port, opts = {}) {
  const procRoot = opts.procRoot ?? '/proc';
  const selfPid = opts.selfPid ?? process.pid;
  const re = liveRouteUrlRe(port);
  /** @type {StrandedRoute[]} */
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return found; // no /proc → nothing to scan (non-Linux, or an absent test root)
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue; // only numeric pid directories
    const pid = Number(name);
    if (pid === selfPid) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(procRoot, name, 'environ'), 'utf8');
    } catch {
      continue; // gone, kernel thread, or not readable (another user's process)
    }
    const match = raw.match(re);
    if (!match) continue;
    let cwd = '';
    try {
      cwd = fs.readlinkSync(path.join(procRoot, name, 'cwd'));
    } catch {
      cwd = ''; // unreadable cwd — still report the pid, just without a path
    }
    found.push({ pid, cwd, token: match[2], url: match[1] });
  }
  return found;
}

/**
 * Group raw {@link scanLiveRoutes} hits by working directory — a Claude Code
 * main process and the subagents/hooks it spawns all inherit the same cached
 * `ANTHROPIC_BASE_URL`, so one *session* ≈ one cwd. Used by `stop` to render a
 * concise stranded-session warning instead of a pid-per-child dump (issue #90).
 *
 * @param {StrandedRoute[]} stranded
 * @returns {StrandedSummary}
 *   `count` is the number of distinct cwds (sessions); pids are sorted ascending.
 */
export function summarizeStranded(stranded) {
  /** @type {Map<string, { pids: number[], token: string }>} */
  const byCwd = new Map();
  for (const s of stranded) {
    const key = s.cwd || '(unknown cwd)';
    const g = byCwd.get(key);
    if (g) g.pids.push(s.pid);
    else byCwd.set(key, { pids: [s.pid], token: s.token });
  }
  const groups = [...byCwd.entries()].map(([cwd, g]) => ({
    cwd,
    pids: g.pids.slice().sort((a, b) => a - b),
    token: g.token,
  }));
  return { count: groups.length, groups };
}

/**
 * Liveness check via `process.kill(pid, 0)` (spec §3.4). `EPERM` means the
 * process exists but is owned by someone else — still alive. A pid that exists
 * only as an unreaped zombie counts as dead (it is no longer serving).
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
  return !isZombie(pid);
}

/**
 * Read the pid from `daemon.pid`, or null if absent/garbage.
 * @param {string} home
 * @returns {number|null}
 */
export function readPid(home) {
  try {
    const pid = Number(fs.readFileSync(paths(home).pid, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Write `daemon.pid`. The file's mtime is the daemon's start time (spec §3.4
 * derives uptime from it). Creates the home dir.
 * @param {string} home
 * @param {number} pid
 */
export function writePid(home, pid) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(paths(home).pid, String(pid) + '\n');
}

/** Remove `daemon.pid` if present. @param {string} home */
export function removePid(home) {
  try {
    fs.rmSync(paths(home).pid);
  } catch {
    // already gone — nothing to do.
  }
}

/**
 * Current daemon state. A pidfile whose pid is dead is a **stale** pidfile and
 * counts as "not running" (spec §3.4) — this reader never mutates it.
 * @param {string} home
 * @returns {{ running: boolean, pid: number|null, startedAt: number|null }}
 *   `startedAt` is the pidfile mtime in ms epoch.
 */
export function readState(home) {
  const pid = readPid(home);
  if (pid && isAlive(pid)) {
    let startedAt = null;
    try {
      startedAt = fs.statSync(paths(home).pid).mtimeMs;
    } catch {
      startedAt = null;
    }
    return { running: true, pid, startedAt };
  }
  return { running: false, pid: null, startedAt: null };
}

/**
 * Count registered routes in `routes.json` (token → dir map). Missing file → 0.
 * @param {string} home
 * @returns {number}
 */
export function countRoutes(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(home).routes, 'utf8'));
    return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Humanise a millisecond duration as `1h 2m 3s` (largest non-zero unit first,
 * seconds always shown). Used for `status` uptime.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * `status` report (spec §3.4). Running → the descriptive line + exit 0; stopped
 * → `stopped` + exit 1 (systemctl-style, scriptable).
 * @param {string} home
 * @param {number} [now] Injected clock (ms epoch) for testing.
 */
export function statusReport(home, now = Date.now()) {
  const state = readState(home);
  if (!state.running) {
    return { running: false, exitCode: 1, line: 'stopped' };
  }
  const port = configuredPort(home);
  const routes = countRoutes(home);
  const uptimeMs = state.startedAt != null ? Math.max(0, now - state.startedAt) : 0;
  const line = `running — pid ${state.pid}, port ${port}, ${routes} routes, up ${formatDuration(uptimeMs)}`;
  return { running: true, exitCode: 0, line, pid: state.pid, port, routes, uptimeMs };
}

/**
 * Probe whether `port` is bindable on `host` — the fail-fast pre-check for
 * `EADDRINUSE` from a foreign process (spec §3.4: no auto-increment). Resolves
 * false only on `EADDRINUSE`; any other bind error is treated as "not us" and
 * left for the real listen to surface.
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      const busy = /** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE';
      tester.close();
      resolve(!busy);
    });
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Absolute path to the CLI entrypoint (the detached daemon re-execs it). */
function binPath() {
  return fileURLToPath(new URL('../bin/ccsnoop.js', import.meta.url));
}

/**
 * Spawn the proxy as a detached, unref'd daemon with stdout/stderr → `daemon.log`
 * (spec §3.4). Returns the child pid; the caller owns the pidfile.
 * @param {{ home: string, port: number, host?: string, sessionsDir?: string }} opts
 * @returns {number}
 */
export function spawnDaemon({ home, port, host = '127.0.0.1', sessionsDir }) {
  fs.mkdirSync(home, { recursive: true });
  const logFd = fs.openSync(paths(home).log, 'a');
  try {
    const args = ['__serve', '--home', home, '--port', String(port), '--host', host];
    if (sessionsDir) args.push('--sessions-dir', sessionsDir);
    const child = spawn(process.execPath, [binPath(), ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return /** @type {number} */ (child.pid);
  } finally {
    fs.closeSync(logFd); // the child holds its own dup of the fd
  }
}

/**
 * `start` (spec §3.4). Idempotent: a live pidfile → `already running`, exit 0; a
 * stale pidfile is cleaned and a fresh daemon spawned. `EADDRINUSE` from a
 * foreign process fails fast (no auto-increment). Returns immediately after the
 * detached spawn, having written the pidfile with the child's pid.
 *
 * @param {string} home
 * @param {object} [opts]
 * @param {number|null} [opts.port]        `--port` override (persisted).
 * @param {string} [opts.host]
 * @param {string} [opts.sessionsDir]
 * @param {(port:number, host:string)=>Promise<boolean>} [opts.checkPort] Injectable.
 * @param {(o:object)=>number} [opts.spawn] Injectable daemon spawner.
 */
export async function start(home, opts = {}) {
  const state = readState(home);
  if (state.running) {
    const port = configuredPort(home);
    return {
      started: false,
      alreadyRunning: true,
      pid: state.pid,
      port,
      line: `already running (pid ${state.pid}, port ${port})`,
      exitCode: 0,
    };
  }

  // Stale pidfile (or none) — clean it out before spawning fresh.
  removePid(home);

  const host = opts.host ?? '127.0.0.1';
  const port = resolvePort(home, opts.port ?? null);

  const checkPort = opts.checkPort ?? checkPortFree;
  const free = await checkPort(port, host);
  if (!free) {
    return {
      started: false,
      portBusy: true,
      port,
      line: `ccsnoop: port ${port} busy; run 'ccsnoop status' or start with --port <n>`,
      exitCode: 1,
    };
  }

  const doSpawn = opts.spawn ?? spawnDaemon;
  const pid = doSpawn({ home, port, host, sessionsDir: opts.sessionsDir });
  writePid(home, pid);
  return {
    started: true,
    pid,
    port,
    line: `ccsnoop start: pid ${pid}, port ${port}`,
    exitCode: 0,
  };
}

/**
 * `stop` (spec §3.4): `SIGTERM` (proxy drains via `server.close()`) → wait up to
 * ~5s → `SIGKILL` if still alive → remove the pidfile. Leaves `config.json` and
 * `routes.json` intact. No/stale pidfile → `not running`, exit 0.
 *
 * After the kill, scans for live Claude Code sessions still pointing at the
 * daemon's port (issue #90) and returns them as `stranded`; the CLI turns a
 * non-empty list into a "restart these sessions" warning. Un-routing repos is
 * *not* done here — the spec wants routes to survive a restart — that lives
 * behind the opt-in `stop --clean` in the CLI.
 *
 * @param {string} home
 * @param {object} [opts]
 * @param {number} [opts.graceMs] Drain window before SIGKILL (default 5000).
 * @param {number} [opts.pollMs]  Liveness poll interval (default 100).
 * @param {function(number): StrandedRoute[]} [opts.scanLiveRoutes]
 *   Injectable stranded-session scanner (default {@link scanLiveRoutes}).
 * @returns {Promise<StopResult>}
 */
export async function stop(home, opts = {}) {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const scan = opts.scanLiveRoutes ?? scanLiveRoutes;

  const pid = readPid(home);
  if (!pid || !isAlive(pid)) {
    removePid(home); // clean a stale pidfile
    return { stopped: false, stranded: scan(configuredPort(home)), line: 'not running', exitCode: 0 };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // race: already gone.
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(pollMs);
  }

  let killed = false;
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
      killed = true;
    } catch {
      // race: gone between the check and the signal.
    }
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(pollMs);
  }

  removePid(home);
  return {
    stopped: true,
    pid,
    killed,
    stranded: scan(configuredPort(home)),
    line: `stopped (pid ${pid})`,
    exitCode: 0,
  };
}
