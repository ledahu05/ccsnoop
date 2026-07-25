#!/usr/bin/env node
// Probe for ccsnoop issue #47 — "how does a bench run get an ISOLATED environment
// (tuned settings + valid creds) without ever mutating the dev's ~/.claude/?"
//
// ZERO BILLED TOKENS BY DESIGN — two tricks, no API call ever reaches Anthropic:
//
//   auth sweep : `claude auth status` prints JSON (loggedIn/authMethod/…) and makes
//                no inference call. Run it under each candidate isolation channel
//                and you learn whether credentials survive it.        → Q2
//   init sweep : point ANTHROPIC_BASE_URL at a dead port (127.0.0.1:1). Claude Code
//                loads every settings scope, runs SessionStart hooks, and emits the
//                `system/init` stream event (tools, mcp_servers, slash_commands,
//                plugins, agents) BEFORE it tries to POST — then dies on
//                ECONNREFUSED in a couple of seconds.            → Q1, Q4
//
// READ-ONLY on the real ~/.claude. The only thing touched there is a byte-for-byte
// copy of `.credentials.json` into a scratch config dir (cells D/D2); its contents
// are never parsed, logged or printed.
//
// Usage:
//   node bench-isolation-probe.mjs auth        # credential-survival sweep
//   node bench-isolation-probe.mjs init        # settings/leak sweep
//   node bench-isolation-probe.mjs init E F    # named init cells only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MODEL = 'claude-haiku-4-5-20251001';
const DEAD_URL = 'http://127.0.0.1:1/ccsnoop-probe'; // nothing listens on port 1 → fast ECONNREFUSED
const REAL_CLAUDE = path.join(os.homedir(), '.claude');
const SCRATCH = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ?? os.tmpdir(), 'bench-iso-'));

// A real git work tree: `ccsnoop init` anchors to the git top-level (src/init.js
// resolvePaths → gitTopLevel); since #27 a non-git cwd falls back to cwd itself.
const PROJECT = path.join(SCRATCH, 'project');
fs.mkdirSync(PROJECT, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: PROJECT });

/** An empty scratch HOME (or config dir) named `n`. Returns the HOME path. */
function freshHome(n) {
  const h = path.join(SCRATCH, 'home-' + n);
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  return h;
}
/** Copy the dev's OAuth credential file into `<home>/.claude/`. */
function seedCreds(home) {
  try {
    const dst = path.join(home, '.claude', '.credentials.json');
    fs.copyFileSync(path.join(REAL_CLAUDE, '.credentials.json'), dst);
    fs.chmodSync(dst, 0o600);
    return true;
  } catch {
    return false; // no file-backed creds on this box (keychain-only)
  }
}

/** process.env minus every marker that could leak the outer session or its auth. */
function baseEnv() {
  const e = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_AGENT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
  ])
    delete e[k];
  return e;
}

// ─────────────────────────────────────────────────── the settings files an arm injects
const TUNED = path.join(SCRATCH, 'tuned-settings.json');
fs.writeFileSync(
  TUNED,
  JSON.stringify(
    {
      // omniris_tuning.md §"`~/.claude/settings.json` — prêt à coller"
      permissions: { deny: ['Workflow', 'Artifact', 'AskUserQuestion', 'ScheduleWakeup', 'ReportFindings'] },
      disableClaudeAiConnectors: true,
      disableAllHooks: true,
    },
    null,
    2,
  ) + '\n',
);
/** Deliberately malformed, to test the `-p` "silently ignored" claim in `claude --help`. */
const BROKEN = path.join(SCRATCH, 'broken-settings.json');
fs.writeFileSync(BROKEN, '{ "permissions": { "deny": [ "Workflow" ]\n');

// ────────────────────────────────────────────────────────────── auth sweep (Q2)
const AUTH_CELLS = {
  A: () => ({ note: 'control — real HOME, real ~/.claude', env: {} }),
  B: () => ({ note: 'HOME rewritten to an empty scratch dir', env: { HOME: freshHome('B') } }),
  C: () => {
    const h = freshHome('C');
    return { note: 'real HOME + CLAUDE_CONFIG_DIR=scratch', env: { CLAUDE_CONFIG_DIR: path.join(h, '.claude') } };
  },
  D: () => {
    const h = freshHome('D');
    const ok = seedCreds(h);
    return { note: `scratch HOME + .credentials.json copied in (copied=${ok})`, env: { HOME: h } };
  },
  D2: () => {
    const h = freshHome('D2');
    const ok = seedCreds(h);
    return {
      note: `real HOME + CLAUDE_CONFIG_DIR=scratch with .credentials.json copied in (copied=${ok})`,
      env: { CLAUDE_CONFIG_DIR: path.join(h, '.claude') },
    };
  },
};

function runAuth(name) {
  const spec = AUTH_CELLS[name]();
  const env = { ...baseEnv(), ...spec.env };
  const r = spawnSync('claude', ['auth', 'status'], { cwd: PROJECT, env, encoding: 'utf8', timeout: 60_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout ?? '');
    if (parsed && parsed.email) parsed.email = '<redacted>'; // never echo the account
    if (parsed && parsed.orgId) parsed.orgId = '<redacted>';
  } catch {
    /* not JSON — keep the raw text below */
  }
  return {
    cell: name,
    note: spec.note,
    env_overrides: spec.env,
    exit_code: r.status,
    auth_status: parsed,
    stdout_raw: parsed ? undefined : (r.stdout ?? '').trim().slice(0, 500),
    stderr: (r.stderr ?? '').trim().slice(0, 500),
  };
}

// ────────────────────────────────────────────── init sweep (Q1 + Q4), zero tokens
const INIT_CELLS = {
  A: () => ({ note: 'control — real HOME, everything the dev has loaded', env: {}, args: [] }),
  B: () => ({ note: 'HOME=scratch', env: { HOME: freshHome('iB') }, args: [] }),
  C: () => {
    const h = freshHome('iC');
    return { note: 'CLAUDE_CONFIG_DIR=scratch', env: { CLAUDE_CONFIG_DIR: path.join(h, '.claude') }, args: [] };
  },
  E: () => ({
    note: '--settings tuned.json — does it REPLACE or MERGE the dev\'s ~/.claude/settings.json?',
    env: {},
    args: ['--settings', TUNED],
  }),
  F: () => ({
    note: '--setting-sources project,local (drops `user`)',
    env: {},
    args: ['--setting-sources', 'project,local'],
  }),
  G: () => ({ note: '--safe-mode — measures the un-disable-able floor', env: {}, args: ['--safe-mode'] }),
  H: () => ({
    note: '--settings <malformed JSON> — help says -p silently ignores it',
    env: {},
    args: ['--settings', BROKEN],
  }),
  I: () => ({
    note: 'CLAUDE_CONFIG_DIR=scratch + --settings tuned.json — the candidate bench recipe',
    env: { CLAUDE_CONFIG_DIR: path.join(freshHome('iI'), '.claude') },
    args: ['--settings', TUNED],
  }),

  // ── J/K/L: no ANTHROPIC_API_KEY, so reaching the request stage at all proves
  // credentials resolved. `api_retry` events (connection error to the dead port)
  // mean CC got as far as POSTing → auth was fine. An auth error instead means it
  // never got there. Still zero tokens: nothing leaves the machine.
  J: () => ({ note: 'control, NO api key — creds come from real ~/.claude', env: {}, args: [], noKey: true }),
  K: () => ({
    note: 'CLAUDE_CONFIG_DIR=scratch, NO api key — expect auth failure (creds live in the config dir)',
    env: { CLAUDE_CONFIG_DIR: path.join(freshHome('iK'), '.claude') },
    args: [],
    noKey: true,
  }),
  L: () => ({
    note: '--setting-sources project,local, NO api key — does dropping the USER SETTINGS scope also drop creds?',
    env: {},
    args: ['--setting-sources', 'project,local'],
    noKey: true,
  }),
};

function runInit(name) {
  const spec = INIT_CELLS[name]();
  const env = { ...baseEnv(), ANTHROPIC_BASE_URL: DEAD_URL, ...spec.env };
  if (!spec.noKey) env.ANTHROPIC_API_KEY = 'sk-ant-probe-dummy';
  const args = ['-p', 'hi', '--model', MODEL, '--output-format', 'stream-json', '--verbose', ...spec.args];
  const r = spawnSync('claude', args, { cwd: PROJECT, env, encoding: 'utf8', timeout: 120_000 });

  let init = null;
  const hooks = [];
  const errors = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init')
      init = {
        tools: ev.tools,
        tool_count: (ev.tools ?? []).length,
        mcp_servers: (ev.mcp_servers ?? []).map((m) => m?.name ?? m),
        plugins: (ev.plugins ?? []).map((p) => p?.name ?? p),
        plugin_errors: ev.plugin_errors,
        agents: ev.agents,
        slash_command_count: (ev.slash_commands ?? []).length,
        slash_commands: ev.slash_commands,
        permissionMode: ev.permissionMode,
      };
    if (ev.type === 'system' && ev.subtype === 'hook_response')
      hooks.push({ hook: ev.hook_name, head: String(ev.output ?? '').slice(0, 60).replace(/\s+/g, ' ') });
    if (ev.type === 'system' && ev.subtype === 'api_retry') errors.push(ev.error);
    if (ev.type === 'result' && ev.subtype !== 'success') errors.push(String(ev.subtype));
  }
  return {
    cell: name,
    note: spec.note,
    argv: args.join(' '),
    env_overrides: spec.env,
    exit_code: r.status,
    session_start_hooks: hooks,
    errors,
    system_init: init,
    stderr: (r.stderr ?? '').trim().split('\n').slice(-4).join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────── driver
const mode = process.argv[2] ?? 'auth';
const table = mode === 'init' ? INIT_CELLS : AUTH_CELLS;
const run = mode === 'init' ? runInit : runAuth;
const picked = process.argv.slice(3).filter((a) => a in table);
const cells = picked.length ? picked : Object.keys(table);

console.error(`[probe] mode=${mode} scratch=${SCRATCH} project=${PROJECT}`);
const out = [];
for (const n of cells) {
  console.error(`[probe] cell ${n} …`);
  out.push(run(n));
}
console.log(JSON.stringify({ mode, scratch: SCRATCH, project: PROJECT, cells: out }, null, 2));
