#!/usr/bin/env node
// ccsnoop — single CLI entrypoint with argv-subcommand dispatch.
// Only `start` is live in this slice; the rest print a stub notice.

import path from 'node:path';
import { start } from '../src/proxy.js';

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

  // Stubs for the not-yet-live subcommands (lifecycle/routing/report slices).
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
 * Read a `--flag value` pair from argv.
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function printUsage() {
  console.log(`ccsnoop — snoop raw Claude Code ↔ Anthropic traffic

Usage: ccsnoop <command> [options]

Commands:
  start    Run the capture proxy (foreground)
             --port <n>           listen port (default 8118, env CCSNOOP_PORT)
             --sessions-dir <p>   capture root (default ./sessions)
  init      (stub) prepare settings.local.json + gitignore
  stop      (stub) stop the daemon
  status    (stub) daemon status
  report    (stub) render the static HTML report`);
}

main().catch((err) => {
  console.error('ccsnoop:', err?.message ?? err);
  process.exit(1);
});
