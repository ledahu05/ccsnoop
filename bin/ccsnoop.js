#!/usr/bin/env node
// ccsnoop — single CLI entrypoint with argv-subcommand dispatch.
// Live: init (spec §3.2) + start / stop / status (daemon lifecycle, §3.4) + report (§3.5).

import { start } from '../src/proxy.js';
import * as daemon from '../src/daemon.js';
import { generateReport } from '../src/report.js';
import { fineTune } from '../src/finetune.js';
import { cache } from '../src/cache.js';
import { floor } from '../src/floor.js';
import { lifetime } from '../src/lifetime.js';
import { isolate } from '../src/isolate.js';
import { verify } from '../src/verify.js';
import { init, undoAllRoutes } from '../src/init.js';

const SUBCOMMANDS = ['init', 'start', 'stop', 'status', 'report', 'fine-tune', 'cache', 'floor', 'lifetime', 'isolate', 'verify'];

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

  if (sub === 'init') return runInit(home, args);
  if (sub === 'start') return runStart(home, args);
  if (sub === 'stop') return runStop(home, args);
  if (sub === 'status') return runStatus(home, args);
  if (sub === 'report') return runReport(args);
  if (sub === 'fine-tune') return runFineTune(args);
  if (sub === 'cache') return runCache(args);
  if (sub === 'floor') return runFloor(args);
  if (sub === 'lifetime') return runLifetime(args);
  if (sub === 'isolate') return runIsolate(args);
  if (sub === 'verify') return runVerify(args);
}

/**
 * `init` — activate capture for the current repo (spec §3.2): settings.local.json
 * env surgery, gitignore, route registration; `--undo` reverts it.
 * @param {string} home
 * @param {string[]} args
 */
function runInit(home, args) {
  const result = init({
    cwd: process.cwd(),
    home,
    force: hasFlag(args, '--force'),
    undo: hasFlag(args, '--undo'),
  });
  for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
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
 * `stop` — SIGTERM (drain) → SIGKILL fallback → remove pidfile (spec §3.4). With
 * `--clean`, also un-routes every registered repo so a relaunched session isn't
 * left pointing at the now-dead port (issue #90, gap 1). Either way, warns about
 * sessions already running — their `ANTHROPIC_BASE_URL` is cached in-process and
 * only a restart clears it (issue #90, gap 2).
 * @param {string} home
 * @param {string[]} args
 */
async function runStop(home, args) {
  const clean = hasFlag(args, '--clean');
  const result = await daemon.stop(home);
  console.log(result.line);
  // The stranded-session warning is the highest-value part of issue #90 — print
  // it before --clean so an undo failure (e.g. a repo with non-strict settings)
  // can't suppress it. Advisory, on stderr so a `pid=$(ccsnoop stop)` capture
  // stays clean; exit stays 0 because we did stop successfully.
  if (result.stranded && result.stranded.length) {
    console.error(formatStrandedWarning(daemon.summarizeStranded(result.stranded)));
  }
  let cleanFailed = false;
  if (clean) {
    try {
      for (const line of undoAllRoutes(home).lines) console.log(line);
    } catch (err) {
      // Surface the undo failure without losing the daemon-stop / stranded info
      // already printed above.
      cleanFailed = true;
      console.error(`ccsnoop: --clean failed: ${err?.message ?? err}`);
    }
  }
  process.exit(cleanFailed ? 1 : result.exitCode);
}

/**
 * Render the stranded-session warning as one block. One line per working tree
 * (a session's main process + its subagents/hooks all share the cached env).
 * @param {{ count: number, groups: Array<{ cwd: string, pids: number[], token: string }> }} summary
 * @returns {string}
 */
function formatStrandedWarning(summary) {
  const lines = [
    `⚠ ${summary.count} Claude Code session${summary.count === 1 ? '' : 's'} still route${
      summary.count === 1 ? 's' : ''
    } through ccsnoop (now stopped) and will hit ConnectionRefused until restarted:`,
  ];
  for (const g of summary.groups) {
    lines.push(`    ${g.cwd}  [pid ${g.pids.join(', ')}]`);
  }
  lines.push(
    '  Restart them (or run `ccsnoop init --undo` in each repo) to clear the cached ANTHROPIC_BASE_URL.',
  );
  return lines.join('\n');
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

  // Default: path-token routing (spec §3.3) — one daemon serves many repos via
  // `routes.json`. An explicit `--sessions-dir` (or CCSNOOP_SESSIONS_DIR) pins
  // the daemon to a single capture dir instead (capture-core / testing mode).
  const sessionsDirOverride = getFlag(args, '--sessions-dir') ?? process.env.CCSNOOP_SESSIONS_DIR;
  const routesFile = sessionsDirOverride ? undefined : daemon.paths(home).routes;
  const sessionsDir = sessionsDirOverride ?? daemon.paths(home).sessions;
  const capturingTo = routesFile ? `routes.json (${daemon.countRoutes(home)} repos)` : sessionsDir;

  try {
    const server = await start({ port, host, sessionsDir, routesFile });
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[ccsnoop] daemon up: pid ${process.pid}, http://${host}:${boundPort}, capturing to ${capturingTo}`);

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
  const num = (name) => {
    const v = getFlag(args, name);
    return v === undefined ? undefined : Number(v);
  };
  const result = generateReport({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
    out: getFlag(args, '--out'),
    all: hasFlag(args, '--all'),
    // Waste-signal thresholds (spec §2.6) — sane defaults, overridable at report time.
    waste: {
      bloatFloorBytes: num('--bloat-floor'),
      bloatSiblingMultiplier: num('--bloat-multiplier'),
    },
  });
  console.log(`ccsnoop report: wrote ${result.outPath}`);
  console.log(`  session: ${result.sessionId} (${result.exchanges} request${result.exchanges === 1 ? '' : 's'})`);
  console.log(`  open it in a browser — self-contained, works offline`);
}

/**
 * `fine-tune` — print a CLI diagnostic + a paste-ready settings.json block
 * (fine-tune-spec.md). Built-in tools (FT1, issue #71) emit `permissions.deny`;
 * the MCP lever (FT4, issue #74) aggregates the corpus and emits
 * `disabledMcpjsonServers` under the T4 guard; the hooks + CLAUDE.md levers
 * (FT5, issue #75) emit `hooks.SessionStart` (only above the floor, with the
 * "intent unknown" caveat) and `claudeMdExcludes` (excludable sources only) —
 * neither ever says "unused", only "costs N bytes". Default scope = corpus;
 * `--session` / `--latest` drop to single-session mode (no MCP deny).
 * `--deny-extra <a,b>` / `--deny-allow <a>` apply the T7 one-run denylist override
 * (spec Part 4). Flags/dispatch mirror {@link runReport}.
 * @param {string[]} args
 */
function runFineTune(args) {
  const result = fineTune({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
    latest: hasFlag(args, '--latest'),
    all: hasFlag(args, '--all'),
    denyExtra: parseList(getFlag(args, '--deny-extra')),
    denyAllow: parseList(getFlag(args, '--deny-allow')),
    includeTokens: hasFlag(args, '--include-tokens'),
  });
  // `--json` emits the versioned tuning-report contract (issue #95) — the stable,
  // parseable surface the context-tuning skill consumes. Absent it, the default
  // human text diagnostic + paste-ready block is unchanged.
  if (hasFlag(args, '--json')) {
    process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
  } else {
    for (const line of result.lines) console.log(line);
  }
}

/**
 * `cache` — the cache-economy diagnostic (cache spec §6 / issue #87). One session: for
 * each turn where a cached prefix went cold, a per-transition card (turn → verdict →
 * cause → cost → reco) plus a lean session rollup. Text by default; `--html` renders the
 * same data as a self-contained document. Flags/dispatch mirror {@link runReport} /
 * {@link runFineTune}; discovery is the shared report resolver. No corpus mode.
 * @param {string[]} args
 */
function runCache(args) {
  // `--latest` is accepted for symmetry with report/fine-tune but needs no plumbing:
  // with no corpus mode, the most-recent session already IS the default.
  const ttlFlag = getFlag(args, '--ttl');
  const ttlSeconds = ttlFlag === undefined ? undefined : Number(ttlFlag);
  // A typo'd threshold would otherwise fall back to the 1 h default and quietly report a
  // different diagnostic than the one asked for.
  // (`Number('')` is 0, so a blank value is rejected explicitly rather than read as "0 s".)
  if (ttlFlag !== undefined && (ttlFlag.trim() === '' || !Number.isFinite(ttlSeconds) || ttlSeconds < 0)) {
    throw new Error(`--ttl expects a non-negative number of seconds, got '${ttlFlag}'`);
  }
  const result = cache({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
    ttlSeconds,
  });
  if (hasFlag(args, '--html')) {
    process.stdout.write(result.html + '\n');
  } else {
    for (const line of result.lines) console.log(line);
  }
}

/**
 * `floor` — the turn-1 baseline metric + per-block attribution (issue #99, epic #93).
 * The skill's verify KPI (#96): one headline number (the REAL turn-1 input tokens
 * from captured `usage`, plus a labelled byte proxy) and a ranked breakdown of every
 * contributor (each tool def, each CLAUDE.md source, each MCP tool, the SessionStart
 * hook output, and the incompressible harness `system[]` floor). Turn-1 isolation
 * profiles the first exchange; an offline reader of `sessions/`, daemon not required.
 * `--window` overrides the 200 000-token context window the headline % is scored
 * against (the 1M-context beta is not detectable from a capture). Flags/dispatch
 * mirror {@link runReport} / {@link runCache}; no corpus mode — the default is the
 * latest session, and `--latest` is accepted as a no-op for symmetry.
 * @param {string[]} args
 */
function runFloor(args) {
  const result = floor({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
    windowTokens: getWindowFlag(args),
  });
  for (const line of result.lines) console.log(line);
}

/**
 * `lifetime` — the effective context-lifetime metric (issue #101, part of epic #93).
 * Promotes compaction (the cache diagnostic's TRUNCATED signal) to a standalone metric:
 * compaction count, turns/wall-time to the first compaction, and per-event bytes-dropped.
 * One session; text by default, `--html` for a self-contained document. Flags/dispatch
 * mirror {@link runCache}; discovery is the shared report resolver. No corpus mode.
 * @param {string[]} args
 */
function runLifetime(args) {
  // `--latest` is accepted for symmetry with report/fine-tune/cache but needs no
  // plumbing: with no corpus mode, the most-recent session already IS the default.
  const result = lifetime({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
  });
  if (hasFlag(args, '--html')) {
    process.stdout.write(result.html + '\n');
  } else {
    for (const line of result.lines) console.log(line);
  }
}

/**
 * `isolate` — the subagent context-isolation diagnostic (issue #102, epic #93 part 4). One
 * session: groups exchanges by `threadId`, sums per-thread input tokens from `usage`
 * (never re-tokenizes), and frames isolated (subagent) context vs main plus an if-inlined
 * counterfactual. Recommends routing context-heavy exploration to subagents when the
 * isolated context is a material fraction of that counterfactual. Text by default; `--html`
 * renders the same data as a self-contained document. Flags/dispatch mirror `runCache`;
 * discovery is the shared report resolver. No corpus mode.
 * @param {string[]} args
 */
function runIsolate(args) {
  const thresholdFlag = getFlag(args, '--threshold');
  let threshold;
  if (thresholdFlag !== undefined) {
    const v = Number(thresholdFlag);
    if (thresholdFlag.trim() === '' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`--threshold expects a fraction in [0, 1], got '${thresholdFlag}'`);
    }
    threshold = v;
  }
  const result = isolate({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    session: getFlag(args, '--session'),
    threshold,
  });
  if (hasFlag(args, '--html')) {
    process.stdout.write(result.html + '\n');
  } else {
    for (const line of result.lines) console.log(line);
  }
}

/**
 * `verify` — the before/after floor delta (issue #96, epic #94): given two captured
 * sessions (a before and an after — one tuning session), compute the turn-1 floor on
 * each via `computeFloor` (#99) and report whether the tuning lowered the floor, and by
 * how much. The headline delta is real turn-1 captured `usage`; the per-block delta is a
 * labelled byte proxy. A pure offline reader of `sessions/`; the daemon is not required.
 *
 * `--before <id>` and `--after <id>` are required — ccsnoop emits the pairing, it does
 * not decide it (the skill in #97 picks the two sessions). `--window` overrides the
 * context window the headline % is scored against, identically on both sides so the
 * delta is apples-to-apples. Text by default; `--json` emits the versioned
 * `tuning-session/v1` contract (issue #95 envelope, `kind: "tuning-session"`). Flags
 * and discovery mirror {@link runFloor}; no corpus mode.
 * @param {string[]} args
 */
function runVerify(args) {
  const result = verify({
    cwd: process.cwd(),
    root: getFlag(args, '--root'),
    sessionsDir: getFlag(args, '--sessions-dir'),
    before: getFlag(args, '--before'),
    after: getFlag(args, '--after'),
    windowTokens: getWindowFlag(args),
  });
  if (hasFlag(args, '--json')) {
    process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
  } else {
    for (const line of result.lines) console.log(line);
  }
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
 * Read `--window <tokens>`, the context window the headline % is scored against. Shared
 * by `floor` and `verify` so both reject an unusable value identically: a typo'd window
 * would otherwise fall back to the 200k default and silently report the wrong %.
 * (`Number('')` is 0, so a blank value is rejected explicitly.)
 * @param {string[]} args
 * @returns {number | undefined} The parsed window, or undefined when the flag is absent.
 */
function getWindowFlag(args) {
  const raw = getFlag(args, '--window');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`--window expects a positive number of tokens, got '${raw}'`);
  }
  return n;
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

/**
 * Split a `--flag a,b,c` value into a clean bare-name list: comma-separated,
 * whitespace-trimmed, empties dropped. Undefined → `[]` so an absent flag is a
 * no-op override. Used by the T7 `--deny-extra` / `--deny-allow` run overrides.
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function printUsage() {
  console.log(`ccsnoop — snoop raw Claude Code ↔ Anthropic traffic

Usage: ccsnoop <command> [options]

Commands:
  init     Activate capture for the current repo (writes .claude/settings.local.json
           env, gitignores .ccsnoop/, registers the route). Restart Claude Code after.
             --force              overwrite a foreign ANTHROPIC_BASE_URL
             --undo               revert exactly what a prior init added
  start    Start the capture-proxy daemon (detached; returns immediately)
             --port <n>           listen port (persisted to ~/.ccsnoop/config.json)
             --sessions-dir <p>   capture root (default ~/.ccsnoop/sessions)
  stop     Stop the daemon (drain, then terminate). Warns about live Claude Code
           sessions still routed through it — restart those, or they'll retry on
           ConnectionRefused.
             --clean              also un-route every registered repo (init --undo for all)
  status   Report daemon status (running → exit 0, stopped → exit 1)
  report   Render a captured session to a self-contained static HTML file
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to render (default: latest)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --out <path>         output file (default <session-dir>/report.html)
             --bloat-floor <n>    bloat: absolute byte floor (default 4096)
             --bloat-multiplier <n>  bloat: sibling-outlier multiplier (default 3)
  fine-tune  Print a byte diagnostic + paste-ready settings.json (all sessions by default)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       one session (weak-evidence: no MCP deny)
             --latest             most-recent session (weak-evidence: no MCP deny)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --deny-extra <a,b>   add denylist names for this run only
             --deny-allow <a>     drop a denylist name for this run only
             --json               emit the versioned tuning-report contract (issue #95)
             --include-tokens     with --json, backfill primary-session token totals
  cache   Cache-economy diagnostic for one captured session (per-transition cards + rollup)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to diagnose (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --ttl <seconds>      TEMPORAL threshold (default 3600 = 1 h)
             --html               render the same data as a self-contained HTML document
  floor   Turn-1 baseline metric + ranked per-block attribution (the default context window)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to score (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --window <tokens>    context window for the headline % (default 200000)
  lifetime  Effective context-lifetime metric for one captured session (compaction count,
           turns/wall-time to the first compaction, per-event bytes-dropped)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to diagnose (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --html               render the same data as a self-contained HTML document
  isolate Subagent context-isolation for one captured session (isolated vs main + counterfactual)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to analyze (default: latest)
             --threshold <f>      isolation ratio that fires the reco, in [0,1] (default 0.25)
             --html               render the same data as a self-contained HTML document
  verify  Before/after floor delta for two captured sessions (a tuning session): did the
          tuning lower the turn-1 floor, and by how much? Computes floor (#99) on each
          side and diffs. A pure offline reader of sessions/; the daemon is not required.
             --before <id>       the baseline session (required)
             --after <id>        the tuned session (required)
             --root <path>       capture root (default ./.ccsnoop)
             --sessions-dir <p>  dir holding session subdirs (overrides --root)
             --window <tokens>   context window for the headline % (default 200000)
             --json              emit the versioned tuning-session contract (kind: tuning-session)`);
}

main().catch((err) => {
  console.error('ccsnoop:', err?.message ?? err);
  process.exit(1);
});
