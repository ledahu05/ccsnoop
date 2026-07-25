#!/usr/bin/env node
// Probe for ccsnoop issue #52 (map #46) — "does a BARE TOOL NAME in
// `permissions.deny` actually remove the tool's schema from `tools[]` on the wire?"
//
// Two instruments, deliberately different in cost and in what they can prove:
//
//   sweep   ZERO billed tokens. ANTHROPIC_BASE_URL points at a dead port; Claude Code
//           loads every settings scope and emits the `system/init` stream event
//           (tools, slash_commands, …) BEFORE it POSTs, then dies on ECONNREFUSED.
//           Answers "is the tool still KNOWN to the harness" → Q3 (scope), Q4 (inert
//           tools), and pre-flights each arm's settings file (B1: a malformed settings
//           file is SILENTLY IGNORED under `-p`).
//           ⚠ CEILING: the init tool list is NOT `tools[]` on the wire. With
//           `ENABLE_TOOL_SEARCH=true` (which `ccsnoop init` writes) most tools are
//           DEFERRED and never ship a schema, so a name vanishing from `system/init`
//           does not by itself mean bytes were saved.
//
//   capture Two real `claude -p` runs through ccsnoop (control arm vs deny arm),
//           differing ONLY by <arm>/.claude/settings.json. Answers Q1 (removal) and
//           Q2 (residue) in bytes.
//
//   analyze Per-tool byte diff of the two captures, using the repo's OWN parser
//           (`segmentRequest` from src/waste.js, `loadSession`/`computeAnatomy` from
//           src/report.js). No second parser.
//
// NON-NEGOTIABLE: never re-tokenize. Every size here is BYTES.
//
// Hygiene: never writes to the dev's ~/.claude or ~/.ccsnoop. Copies
// ~/.claude/.credentials.json into each arm's config dir (0600) and deletes it in
// `clean`. Arms run SEQUENTIALLY (B1's unresolved OAuth-refresh risk).
//
// Usage:
//   node bench-deny-mechanism-probe.mjs sweep
//   node bench-deny-mechanism-probe.mjs capture
//   node bench-deny-mechanism-probe.mjs analyze <controlSessionDir> <denySessionDir>
//   node bench-deny-mechanism-probe.mjs clean

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { segmentRequest } from '../../../src/waste.js';
import { loadSession, computeAnatomy } from '../../../src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MODEL = 'claude-haiku-4-5-20251001';
const DEAD_URL = 'http://127.0.0.1:1/ccsnoop-probe';
const ROOT = '/tmp/ccsnoop-b6';
const PROJECT = path.join(ROOT, 'repo');
const CCSNOOP_HOME = path.join(ROOT, 'ccsnoop-home');
const PROMPT = 'Read the file FIXED.txt and reply with only its first word.'; // B2's canonical bench prompt

// ── the arms ────────────────────────────────────────────────────────────────
// Deny targets chosen from B2's real haiku `-p` capture, i.e. tools CONFIRMED to
// ship a schema on the wire under ENABLE_TOOL_SEARCH:
//   Workflow 21,525 B · Bash 11,694 B · ScheduleWakeup 3,838 B
//   ReportFindings 2,181 B · ShareOnboardingGuide 1,299 B
// `Bash` doubles as the "is a core harness tool removable?" case (Q4).
// `Read(/etc/ccsnoop-nonexistent/**)` is the SCOPED entry (Q3): Read must survive.
const DENY = [
  'Workflow',
  'ScheduleWakeup',
  'ReportFindings',
  'ShareOnboardingGuide',
  'Bash',
  'Read(/etc/ccsnoop-nonexistent/**)',
];
const ARMS = {
  control: {},
  deny: { permissions: { deny: DENY } },
};

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
}

/** process.env minus every marker that could leak the outer CC session or its auth. */
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
    'CCSNOOP_HOME',
  ])
    delete e[k];
  return e;
}

/** A config dir holding exactly `settings`, plus a 0600 copy of the dev's creds. */
function armDir(name, settings, { creds = true } = {}) {
  const dir = path.join(ROOT, 'arm-' + name, '.claude');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  if (creds) {
    const dst = path.join(dir, '.credentials.json');
    fs.copyFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), dst);
    fs.chmodSync(dst, 0o600);
  }
  return dir;
}

function ensureProject() {
  fs.mkdirSync(PROJECT, { recursive: true });
  if (!fs.existsSync(path.join(PROJECT, '.git'))) sh('git', ['init', '-q'], { cwd: PROJECT });
  fs.writeFileSync(path.join(PROJECT, 'FIXED.txt'), 'anvil stone quiet ledger\n');
  sh('git', ['add', 'FIXED.txt'], { cwd: PROJECT });
  sh('git', ['-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-qm', 'fixture'], { cwd: PROJECT });
}

// ── sweep: zero-token `system/init` cells ───────────────────────────────────
function initEvent(env, args) {
  const r = sh('claude', ['-p', 'noop', '--model', MODEL, '--output-format', 'stream-json', '--verbose', ...args], {
    cwd: PROJECT,
    env: { ...baseEnv(), ANTHROPIC_BASE_URL: DEAD_URL, ...env },
    timeout: 90_000,
  });
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system' && ev.subtype === 'init') return ev;
    } catch {
      /* not json */
    }
  }
  return { _error: (r.stderr ?? '').trim().slice(0, 300), _exit: r.status };
}

function sweep() {
  ensureProject();
  const cells = [
    ['iso-control', armDir('sweep-control', ARMS.control, { creds: false }), []],
    ['iso-deny', armDir('sweep-deny', ARMS.deny, { creds: false }), []],
    ['iso-deny+bypass', armDir('sweep-deny-bypass', ARMS.deny, { creds: false }), ['--permission-mode', 'bypassPermissions']],
    // Isolates the substitution: does denying JUST `Bash` bring Glob/Grep back?
    ['iso-deny-bash-only', armDir('sweep-bash', { permissions: { deny: ['Bash'] } }, { creds: false }), []],
    [
      'iso-scoped-only',
      armDir('sweep-scoped', { permissions: { deny: ['Bash(rm:*)', 'Read(/etc/**)', 'Workflow(*)'] } }, { creds: false }),
      [],
    ],
    [
      'iso-deny-core',
      armDir(
        'sweep-core',
        {
          permissions: {
            deny: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Task', 'Agent', 'TodoWrite', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'NotebookEdit'],
          },
        },
        { creds: false },
      ),
      [],
    ],
    ['iso-malformed', null, []], // B1's silent-ignore trap, re-checked under CLAUDE_CONFIG_DIR
  ];

  const base = {};
  for (const [name, dir, args] of cells) {
    let cfg = dir;
    if (name === 'iso-malformed') {
      cfg = path.join(ROOT, 'arm-sweep-malformed', '.claude');
      fs.rmSync(cfg, { recursive: true, force: true });
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, 'settings.json'), '{ "permissions": { "deny": [ "Workflow" ]\n');
    }
    const ev = initEvent({ CLAUDE_CONFIG_DIR: cfg }, args);
    const tools = (ev.tools ?? []).slice().sort();
    if (name === 'iso-control') base.tools = tools;
    const missing = (base.tools ?? []).filter((t) => !tools.includes(t));
    const added = tools.filter((t) => !(base.tools ?? []).includes(t));
    console.log(`\n## ${name}`);
    if (ev._error !== undefined) console.log('   ERROR', ev._exit, ev._error);
    console.log(`   tools: ${tools.length}  commands: ${(ev.slash_commands ?? []).length}  mcp: ${JSON.stringify(ev.mcp_servers ?? [])}`);
    console.log(`   removed vs iso-control: ${missing.length ? missing.join(', ') : '(none)'}`);
    console.log(`   ADDED   vs iso-control: ${added.length ? added.join(', ') : '(none)'}`);
    console.log(`   list: ${tools.join(' ')}`);
  }
}

// ── capture: two live runs through ccsnoop ──────────────────────────────────
function ccsnoop(args, env = {}) {
  return sh('node', [path.join(REPO_ROOT, 'bin', 'ccsnoop.js'), ...args], {
    cwd: PROJECT,
    env: { ...baseEnv(), CCSNOOP_HOME, ...env },
  });
}

function capture() {
  ensureProject();
  fs.mkdirSync(CCSNOOP_HOME, { recursive: true });
  // The dev's own daemon already holds ccsnoop's default port, so the bench arm needs
  // its own. `start --port` persists it to <home>/config.json, and `init` reads that
  // (src/init.js: daemon.configuredPort) — hence the start/undo/init/start dance:
  // the URL written into settings.local.json must name the port the daemon listens on.
  const PORT = Number(process.argv[3] ?? 41999);
  ccsnoop(['init', '--undo']);
  console.log(ccsnoop(['start', '--port', String(PORT)]).stdout ?? '');
  ccsnoop(['stop']);
  console.log(ccsnoop(['init']).stdout ?? '');
  const started = ccsnoop(['start', '--port', String(PORT)]);
  console.log((started.stdout ?? '') + (started.stderr ?? ''));

  const routes = JSON.parse(fs.readFileSync(path.join(CCSNOOP_HOME, 'routes.json'), 'utf8'));
  const token = Object.keys(routes)[0];
  const local = JSON.parse(fs.readFileSync(path.join(PROJECT, '.claude', 'settings.local.json'), 'utf8'));
  const baseUrl = local.env?.ANTHROPIC_BASE_URL;
  console.log('route token:', token, 'base url:', baseUrl);
  if (!baseUrl || !baseUrl.includes(token)) throw new Error('routing not established');

  // Advisor #5: a SPAWNED child must reach the daemon (B1 saw loopback blocked for
  // spawned processes). Prove it before burning tokens.
  // `start` is detached and returns before the socket binds — retry.
  let reach;
  for (let i = 0; i < 15; i++) {
    reach = sh('node', ['-e', `require('http').get(${JSON.stringify(baseUrl)}+'/api/hello',r=>{console.log('HTTP',r.statusCode);process.exit(0)}).on('error',e=>{console.log('ERR',e.message);process.exit(1)})`]);
    if (reach.status === 0) break;
    sh('sleep', ['1']);
  }
  console.log('spawned-child reachability:', (reach.stdout ?? '').trim(), (reach.stderr ?? '').trim());
  if (reach.status !== 0) throw new Error('spawned child cannot reach the daemon — abort before spending tokens');

  for (const [name, settings] of Object.entries(ARMS)) {
    const cfg = armDir(name, settings);
    // Pre-flight (advisor #3): the SAME dir the live run will use must parse.
    const pre = initEvent({ CLAUDE_CONFIG_DIR: cfg }, []);
    console.log(`\n[${name}] pre-flight tools=${(pre.tools ?? []).length}`);
    if (!pre.tools) throw new Error(`arm ${name}: settings did not load`);
    const r = sh(
      'claude',
      ['-p', PROMPT, '--model', MODEL, '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      {
        cwd: PROJECT,
        env: { ...baseEnv(), CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: baseUrl, ENABLE_TOOL_SEARCH: 'true' },
        timeout: 300_000,
      },
    );
    console.log(`[${name}] exit=${r.status} out=${(r.stdout ?? '').trim().slice(0, 400)}`);
    if (r.stderr?.trim()) console.log(`[${name}] stderr=${r.stderr.trim().slice(0, 400)}`);
    fs.rmSync(path.join(cfg, '.credentials.json'), { force: true }); // secret lives as briefly as possible
  }
  console.log(ccsnoop(['stop']).stdout ?? '');
  console.log('sessions:', path.join(PROJECT, '.ccsnoop', 'sessions'));
}

// ── analyze: per-tool byte diff via the repo's own parser ────────────────────
function firstToolRequest(dir) {
  const model = loadSession(dir); // exercises the repo's own session loader on the capture
  const lines = fs
    .readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const m of lines) {
    const text = fs.readFileSync(path.join(dir, m.request_blob), 'utf8');
    const sep = text.indexOf('\r\n\r\n');
    let body;
    try {
      body = JSON.parse(sep >= 0 ? text.slice(sep + 4) : text);
    } catch {
      continue;
    }
    if (Array.isArray(body.tools) && body.tools.length) return { body, model, turn: m.turn };
  }
  throw new Error('no request with a non-empty tools[] in ' + dir);
}

function analyze(dirA, dirB) {
  const a = firstToolRequest(path.resolve(dirA));
  const b = firstToolRequest(path.resolve(dirB));
  for (const [label, x] of [
    ['control', a],
    ['deny', b],
  ]) {
    const an = computeAnatomy(x.body);
    console.log(
      `${label}: turn=${x.turn} total=${an.total} system=${an.system} tools=${an.tools} history=${an.history} currentTurn=${an.currentTurn} toolCount=${x.body.tools.length} exchanges=${x.model.exchanges.length}`,
    );
  }

  // segmentRequest emits one segment per tool ("tool:<name>") — the repo's own sizing.
  const segs = (x) => new Map(segmentRequest(x.body).filter((s) => s.slot.startsWith('tool:')).map((s) => [s.slot.slice(5), s.bytes]));
  const sa = segs(a);
  const sb = segs(b);
  console.log('\nper-tool bytes (segmentRequest slots):');
  let removed = 0;
  for (const name of new Set([...sa.keys(), ...sb.keys()])) {
    const x = sa.get(name) ?? 0;
    const y = sb.get(name) ?? 0;
    const mark = y === 0 ? 'REMOVED' : x === 0 ? 'ADDED' : x === y ? 'same' : 'CHANGED';
    if (y === 0) removed += x;
    if (mark !== 'same' || DENY.some((d) => d === name || d.startsWith(name + '(')))
      console.log(`  ${String(x).padStart(6)} -> ${String(y).padStart(6)}  ${mark.padEnd(8)} ${name}`);
  }
  console.log(`  removed total: ${removed} B`);

  // Q2 — residue: does each denied bare name still appear anywhere in the deny-arm body?
  console.log('\nresidue of denied names in the deny-arm request:');
  const bodyText = JSON.stringify(b.body);
  const slots = new Map(segmentRequest(b.body).map((s) => [s.slot, s.bytes]));
  for (const d of DENY) {
    const name = d.replace(/\(.*/, '');
    const where = [];
    for (const [slot] of slots) {
      const part = slot.startsWith('tool:')
        ? JSON.stringify(b.body.tools.find((t) => t.name === slot.slice(5)))
        : slot.startsWith('system#')
          ? JSON.stringify(b.body.system[Number(slot.slice(7))])
          : slot.startsWith('message#')
            ? JSON.stringify(b.body.messages[Number(slot.slice(8))])
            : '';
      if (part && part.includes(name)) where.push(slot);
    }
    console.log(`  ${d.padEnd(34)} occurrences=${bodyText.split(name).length - 1} slots=${where.join(',') || '(none)'}`);
  }

  // Q2 — did anything slide into the deferred-tool listing?
  for (const [label, x] of [
    ['control', a],
    ['deny', b],
  ]) {
    const blocks = (x.body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const def = blocks.find((bl) => typeof bl.text === 'string' && /deferred tools/.test(bl.text));
    console.log(`\n${label} deferred-tool listing: ${def ? Buffer.byteLength(JSON.stringify(def), 'utf8') + ' B' : 'ABSENT'}`);
    if (def) console.log('  names:', (def.text.match(/^[A-Za-z_][\w]*$/gm) ?? []).join(' '));
  }
}

function clean() {
  ccsnoop(['stop']);
  ccsnoop(['init', '--undo']);
  for (const f of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])
    if (f.startsWith('arm-')) fs.rmSync(path.join(ROOT, f, '.claude', '.credentials.json'), { force: true });
  console.log('stopped daemon, undid route; credential copies deleted. `rm -rf ' + ROOT + '` when captures are no longer needed.');
}

const mode = process.argv[2];
if (mode === 'sweep') sweep();
else if (mode === 'capture') capture();
else if (mode === 'analyze') analyze(process.argv[3], process.argv[4]);
else if (mode === 'clean') clean();
else {
  console.error('usage: bench-deny-mechanism-probe.mjs sweep|capture|analyze <ctlDir> <denyDir>|clean');
  process.exit(2);
}
