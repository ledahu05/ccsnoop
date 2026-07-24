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
 * @param {string} home
 * @param {object} [opts]
 * @param {number} [opts.graceMs] Drain window before SIGKILL (default 5000).
 * @param {number} [opts.pollMs]  Liveness poll interval (default 100).
 * @param {number} [opts.now]     Injected clock for testing.
 */
export async function stop(home, opts = {}) {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const clock = () => (opts.now != null ? opts.now : Date.now());

  const pid = readPid(home);
  if (!pid || !isAlive(pid)) {
    removePid(home); // clean a stale pidfile
    return { stopped: false, line: 'not running', exitCode: 0 };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // race: already gone.
  }

  const deadline = clock() + graceMs;
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
    line: `stopped (pid ${pid})`,
    exitCode: 0,
  };
}
