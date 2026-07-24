#!/usr/bin/env node
// ccsnoop — single CLI entrypoint with argv-subcommand dispatch.
// Live: start / stop / status (daemon lifecycle, spec §3.4) + report (spec §3.5). init stubbed.

import { start } from '../src/proxy.js';
import * as daemon from '../src/daemon.js';
import { generateReport } from '../src/report.js';

const SUBCOMMANDS = ['init', 'start', 'stop', 'status', 'report'];

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  // Internal: the detached daemon re-execs the CLI as `__serve` to run the proxy
  // in the foreground with its stdio wired to daemon.log. Not user-facing.
  if (sub === '__serve') {
    await runServe(argv.slice(1));
    return;
  }

  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    process.exit(sub ? 0 : 1);
  }

  if (!SUBCOMMANDS.includes(sub)) {
    console.error(`ccsnoop: unknown subcommand '${sub}'`);
    printUsage();
    process.exit(1);
  }

  const args = argv.slice(1);
  const home = getFlag(args, '--home') ?? daemon.defaultHome();

  if (sub === 'start') return runStart(home, args);
  if (sub === 'stop') return runStop(home, args);
  if (sub === 'status') return runStatus(home, args);
  if (sub === 'report') return runReport(args);

  // Stub for the not-yet-live subcommands (init slice).
  console.log(`ccsnoop ${sub}: not implemented yet (stub)`);
}

/**
 * `start` — daemonize the capture proxy and return to the shell immediately
 * (spec §3.4). Prints pid + port, or `already running`, or a fail-fast message.
 * @param {string} home
 * @param {string[]} args
 */
async function runStart(home, args) {
  const portFlag = getFlag(args, '--port');
  const result = await daemon.start(home, {
    port: portFlag != null ? Number(portFlag) : null,
    sessionsDir: getFlag(args, '--sessions-dir'),
  });
  const stream = result.exitCode === 0 ? console.log : console.error;
  stream(result.line);
  process.exit(result.exitCode);
}

/**
 * `stop` — SIGTERM (drain) → SIGKILL fallback → remove pidfile (spec §3.4).
 * @param {string} home
 * @param {string[]} args
 */
async function runStop(home, args) {
  const result = await daemon.stop(home);
  console.log(result.line);
  process.exit(result.exitCode);
}

/**
 * `status` — running (exit 0) / stopped (exit 1) (spec §3.4).
 * @param {string} home
 * @param {string[]} args
 */
async function runStatus(home, args) {
  const result = daemon.statusReport(home);
  const stream = result.running ? console.log : console.error;
  stream(result.line);
  process.exit(result.exitCode);
}

/**
 * The daemon body: run the proxy in the foreground, draining on SIGTERM. Invoked
 * only by {@link daemon.spawnDaemon}; stdio is already redirected to daemon.log.
 * @param {string[]} args
 */
async function runServe(args) {
  const home = getFlag(args, '--home') ?? daemon.defaultHome();
  const port = Number(getFlag(args, '--port') ?? daemon.configuredPort(home));
  const host = getFlag(args, '--host') ?? '127.0.0.1';
  const sessionsDir = getFlag(args, '--sessions-dir')
    ?? process.env.CCSNOOP_SESSIONS_DIR
    ?? daemon.paths(home).sessions;

  try {
    const server = await start({ port, host, sessionsDir });
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[ccsnoop] daemon up: pid ${process.pid}, http://${host}:${boundPort}, capturing to ${sessionsDir}`);

    const shutdown = () => {
      console.log(`[ccsnoop] draining and shutting down (pid ${process.pid})`);
      server.close(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    // EADDRINUSE lost the race after the parent's pre-check, or another bind
    // error — log and exit non-zero so the pidfile is left stale, not live.
    console.error(`[ccsnoop] daemon failed to start on ${host}:${port}: ${err?.message ?? err}`);
    process.exit(1);
  }
}

/**
 * Render the static HTML report from a captured session (spec §2, §3.5).
 * @param {string[]} args
 */
function runReport(args) {
  const result = generateReport({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    session: getFlag(args, '--session'),
    out: getFlag(args, '--out'),
    all: hasFlag(args, '--all'),
  });
  console.log(`ccsnoop report: wrote ${result.outPath}`);
  console.log(`  session: ${result.sessionId} (${result.exchanges} request${result.exchanges === 1 ? '' : 's'})`);
  console.log(`  open it in a browser — self-contained, works offline`);
}

/**
 * Read a `--flag value` pair from argv.
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Test whether a boolean flag is present in argv.
 * @param {string[]} args
 * @param {string} name
 * @returns {boolean}
 */
function hasFlag(args, name) {
  return args.includes(name);
}

function printUsage() {
  console.log(`ccsnoop — snoop raw Claude Code ↔ Anthropic traffic

Usage: ccsnoop <command> [options]

Commands:
  start    Start the capture-proxy daemon (detached; returns immediately)
             --port <n>           listen port (persisted to ~/.ccsnoop/config.json)
             --sessions-dir <p>   capture root (default ~/.ccsnoop/sessions)
  stop     Stop the daemon (drain, then terminate)
  status   Report daemon status (running → exit 0, stopped → exit 1)
  report   Render a captured session to a self-contained static HTML file
             --root <path>        capture root (default ./.ccsnoop)
             --session <id>       session to render (default: latest)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --out <path>         output file (default <session-dir>/report.html)
  init      (stub) prepare settings.local.json + gitignore`);
}

main().catch((err) => {
  console.error('ccsnoop:', err?.message ?? err);
  process.exit(1);
});
