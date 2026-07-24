#!/usr/bin/env node
// ccsnoop — single CLI entrypoint with argv-subcommand dispatch.
// Only `start` is live in this slice; the rest print a stub notice.

import path from 'node:path';
import { start } from '../src/proxy.js';
import { generateReport } from '../src/report.js';

const SUBCOMMANDS = ['init', 'start', 'stop', 'status', 'report'];

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    process.exit(sub ? 0 : 1);
  }

  if (!SUBCOMMANDS.includes(sub)) {
    console.error(`ccsnoop: unknown subcommand '${sub}'`);
    printUsage();
    process.exit(1);
  }

  if (sub === 'start') {
    await runStart(argv.slice(1));
    return;
  }

  if (sub === 'report') {
    runReport(argv.slice(1));
    return;
  }

  // Stubs for the not-yet-live subcommands (lifecycle/routing slices).
  console.log(`ccsnoop ${sub}: not implemented yet (stub)`);
}

/** @param {string[]} args */
async function runStart(args) {
  const port = Number(getFlag(args, '--port') ?? process.env.CCSNOOP_PORT ?? 8118);
  const sessionsDir = getFlag(args, '--sessions-dir')
    ?? process.env.CCSNOOP_SESSIONS_DIR
    ?? path.resolve(process.cwd(), 'sessions');

  const server = await start({ port, sessionsDir });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`ccsnoop start: capture proxy on http://127.0.0.1:${boundPort}`);
  console.log(`  point Claude Code at it:`);
  console.log(`    ANTHROPIC_BASE_URL=http://127.0.0.1:${boundPort} ENABLE_TOOL_SEARCH=true claude`);
  console.log(`  capturing to: ${sessionsDir}`);
  console.log(`  (Ctrl-C to stop — daemonization lands in the lifecycle slice)`);

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  start    Run the capture proxy (foreground)
             --port <n>           listen port (default 8118, env CCSNOOP_PORT)
             --sessions-dir <p>   capture root (default ./sessions)
  report   Render a captured session to a self-contained static HTML file
             --root <path>        capture root (default ./.ccsnoop)
             --session <id>       session to render (default: latest)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --out <path>         output file (default <session-dir>/report.html)
  init      (stub) prepare settings.local.json + gitignore
  stop      (stub) stop the daemon
  status    (stub) daemon status`);
}

main().catch((err) => {
  console.error('ccsnoop:', err?.message ?? err);
  process.exit(1);
});
