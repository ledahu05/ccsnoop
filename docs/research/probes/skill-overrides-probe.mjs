#!/usr/bin/env node
// Probe for ccsnoop issue #115 (lever 5, tranche 0) — "does `skillOverrides: name-only`
// actually stop shipping a skill's description on the wire, and does `/name` survive it?"
//
// ADR-0005 makes `name-only` the ACTION of lever 5a. Its whole claim to the `safe` tier is
// that the false positive is BOUNDED: the skill stays invocable, only the description
// stops shipping. That claim has two halves, and each needs its own instrument:
//
//   sweep   ZERO billed tokens. ANTHROPIC_BASE_URL points at a dead port; Claude Code
//           loads every settings scope and emits `system/init` (which carries BOTH a
//           `skills` list — what the model can see — and `slash_commands` — what the user
//           can type) BEFORE it POSTs, then dies. This is the instrument for the BOUNDED
//           half: under `name-only` the skill must stay in both lists; `user-invocable-only`
//           must drop it from `skills` only; `off` from both.
//           ⚠ CEILING: `system/init` cannot see the wire. A skill still listed there says
//           nothing about whether its DESCRIPTION was shipped — that is the capture's job.
//           And a LISTING is not an invocation, which is what `slash` is for.
//
//   slash   ZERO billed tokens. Runs `/name` for real against the dead port: a known
//           command becomes a turn that then fails to POST, an unknown one never becomes a
//           turn. Upgrades "`/name` is still listed" to "`/name` still RUNS" — the claim
//           ADR-0005's bounded-action argument actually rests on.
//
//   capture Two real `claude -p` runs through ccsnoop, differing ONLY by
//           <arm>/.claude/settings.json. Answers the byte half: what does the
//           `skills-catalog` block weigh with and without the descriptions?
//
//   analyze Per-entry byte diff of the two captures using the repo's OWN catalog parser
//           (`findCatalogBlocks` / `parseCatalogEntries` from src/floor-catalog.js) — the
//           same code path `ccsnoop floor --detail` uses. No second parser.
//
// NON-NEGOTIABLE: never re-tokenize. Every size here is BYTES.
//
// Hygiene: never writes to the dev's ~/.claude or ~/.ccsnoop. Copies
// ~/.claude/.credentials.json into each arm's config dir (0600) and deletes it right after
// the run and in `clean`. Arms run SEQUENTIALLY (B1's unresolved OAuth-refresh risk).
//
// Usage:
//   node skill-overrides-probe.mjs sweep
//   node skill-overrides-probe.mjs slash
//   node skill-overrides-probe.mjs capture [port]
//   node skill-overrides-probe.mjs analyze <controlSessionDir> <nameOnlySessionDir>
//   node skill-overrides-probe.mjs clean

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCatalogBlocks, parseCatalogEntries } from '../../../src/floor-catalog.js';
import { loadSession, computeAnatomy } from '../../../src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MODEL = 'claude-haiku-4-5-20251001';
const DEAD_URL = 'http://127.0.0.1:1/ccsnoop-probe';
const ROOT = '/tmp/ccsnoop-115';
const PROJECT = path.join(ROOT, 'repo');
const CCSNOOP_HOME = path.join(ROOT, 'ccsnoop-home');
const PROMPT = 'Read the file FIXED.txt and reply with only its first word.'; // B2's canonical bench prompt

// ── the targets ─────────────────────────────────────────────────────────────
// Two scopes, both reachable by `skillOverrides` per ADR-0005 fact 3:
//   `dataviz`      BUNDLED — the heaviest bundled entry in #105's manual count (1 210 B).
//   `probe-heavy`  PROJECT — written into the fixture repo below, with a deliberately
//                  long description so a per-entry delta is unmissable.
// PLUGIN scope is deliberately NOT probed: the resolver returns "on" unconditionally for
// `source === "plugin"`, so there is nothing to measure — that exemption is lever 5b's
// premise and is confirmed statically (see the research note), not here.
const BUNDLED_TARGET = 'dataviz';
const PROJECT_TARGET = 'probe-heavy';
const TARGETS = [BUNDLED_TARGET, PROJECT_TARGET];

const ARMS = {
  control: {},
  'name-only': { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'name-only'])) },
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
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
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

/**
 * The PROJECT-scope target: a real skill in the fixture repo, with a fat description.
 *
 * ⚠ The description is QUOTED and contains no `#`. Frontmatter is YAML: in an unquoted
 * scalar a ` #` opens a comment, so the first run of this probe silently shipped a
 * 66-character description instead of the intended one — and a truncated fixture would
 * have understated the very delta the probe exists to measure.
 */
const PROBE_SKILL = `---
name: ${PROJECT_TARGET}
description: "A deliberately verbose project skill used only by the ccsnoop issue 115 probe, to make a per-entry byte delta unmissable on the wire. It exists to be listed in the skills catalog and to have its description withheld under a name-only override, and for no other purpose. It does nothing, it is never invoked, and it should never be invoked. Use it when measuring the byte cost of a skill catalog entry, and never otherwise. Padding follows so the entry is comfortably larger than its own name: alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu."
---

# ${PROJECT_TARGET}

This skill is inert. It is a measurement fixture for ccsnoop issue #115.
`;

function ensureProject() {
  fs.mkdirSync(PROJECT, { recursive: true });
  if (!fs.existsSync(path.join(PROJECT, '.git'))) sh('git', ['init', '-q'], { cwd: PROJECT });
  fs.writeFileSync(path.join(PROJECT, 'FIXED.txt'), 'anvil stone quiet ledger\n');
  const skillDir = path.join(PROJECT, '.claude', 'skills', PROJECT_TARGET);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), PROBE_SKILL);
  sh('git', ['add', '-A'], { cwd: PROJECT });
  sh('git', ['-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-qm', 'fixture'], { cwd: PROJECT });
}

// ── sweep: zero-token `system/init` cells ───────────────────────────────────
function initEvent(env, args = []) {
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

/**
 * The BOUNDED-action matrix. `skills` is the model-facing list; `slash_commands` is what
 * the user can still type. ADR-0005 rests on `name-only` keeping BOTH — that is the whole
 * difference between "gentler action" and "removal".
 */
function sweep() {
  ensureProject();
  const cells = [
    ['control', {}],
    ['name-only', { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'name-only'])) }],
    ['user-invocable-only', { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'user-invocable-only'])) }],
    ['off', { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'off'])) }],
    ['disableBundledSkills', { disableBundledSkills: true }],
    // ADR-0005 fact 2: a plugin skill ignores its override. With no plugin installed this
    // cell only proves the override is inert on a NON-existent name — the exemption itself
    // is a static read. Kept so the negative is on the record, not inferred.
    ['override-unknown-name', { skillOverrides: { 'no-such-skill-anywhere': 'off' } }],
  ];

  let base = null;
  for (const [name, settings] of cells) {
    const ev = initEvent({ CLAUDE_CONFIG_DIR: armDir('sweep-' + name, settings, { creds: false }) });
    const skills = (ev.skills ?? []).slice().sort();
    const cmds = (ev.slash_commands ?? []).slice().sort();
    if (name === 'control') base = { skills, cmds };
    console.log(`\n## ${name}`);
    if (ev._error !== undefined) console.log('   ERROR', ev._exit, ev._error);
    console.log(`   version=${ev.claude_code_version} skills=${skills.length} slash_commands=${cmds.length}`);
    for (const t of TARGETS) {
      console.log(
        `   ${t.padEnd(12)} model-visible(skills)=${skills.includes(t) ? 'YES' : 'no '}   user-typable(/${t})=${cmds.includes(t) ? 'YES' : 'no'}`,
      );
    }
    if (base && name !== 'control') {
      const gone = base.skills.filter((s) => !skills.includes(s));
      const goneCmd = base.cmds.filter((c) => !cmds.includes(c));
      console.log(`   dropped from skills vs control: ${gone.length ? gone.join(', ') : '(none)'}`);
      console.log(`   dropped from slash_commands   : ${goneCmd.length ? goneCmd.join(', ') : '(none)'}`);
    }
  }
}

// ── slash: does `/name` still RUN, not merely still appear in a list? ────────
//
// The sweep only reads `system/init.slash_commands` — a listing, and that payload's sibling
// list (`skills`) was shown NOT to reflect what the model sees, so a listing is weak
// evidence. This cell exercises the command for real, still at zero billed tokens: with
// ANTHROPIC_BASE_URL on a dead port, Claude Code expands a KNOWN command into a turn and
// then fails to POST it, while an UNKNOWN one never becomes a turn at all. The result
// envelope separates the two cleanly:
//
//   known    → num_turns >= 1, is_error true  (the turn existed; the dead port killed it)
//   unknown  → num_turns === 0, is_error false (nothing was ever run)
//
// So `num_turns >= 1` is the "the slash command RAN" signal.
function slashRuns(cfg, cmd) {
  const r = sh('claude', ['-p', cmd, '--model', MODEL, '--output-format', 'json'], {
    cwd: PROJECT,
    env: { ...baseEnv(), CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: DEAD_URL },
    timeout: 90_000,
  });
  try {
    const ev = JSON.parse((r.stdout ?? '').trim());
    return { ran: (ev.num_turns ?? 0) >= 1, turns: ev.num_turns, cost: ev.total_cost_usd };
  } catch {
    return { ran: null, turns: null, raw: (r.stdout ?? r.stderr ?? '').slice(0, 200) };
  }
}

function slash() {
  ensureProject();
  const cells = [
    ['control', {}],
    ['name-only', { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'name-only'])) }],
    ['off', { skillOverrides: Object.fromEntries(TARGETS.map((n) => [n, 'off'])) }],
  ];
  // The negative control: a command that does not exist under ANY setting. Without it,
  // "ran" could just mean "claude -p always reports a turn".
  const UNKNOWN = '/no-such-command-anywhere';
  for (const [name, settings] of cells) {
    const cfg = armDir('slash-' + name, settings, { creds: false });
    console.log(`\n## ${name}`);
    for (const cmd of [...TARGETS.map((t) => '/' + t), UNKNOWN]) {
      const r = slashRuns(cfg, cmd);
      console.log(`   ${cmd.padEnd(26)} ran=${r.ran === null ? '??' : r.ran ? 'YES' : 'no '}  num_turns=${r.turns}  cost=${r.cost ?? 0}`);
    }
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
  // The dev's own daemon already holds ccsnoop's default port, so this probe needs its
  // own. `start --port` persists it to <home>/config.json and `init` reads that back
  // (src/init.js: daemon.configuredPort) — hence the start/undo/init/start dance.
  const PORT = Number(process.argv[3] ?? 41998);
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

  // A SPAWNED child must reach the daemon (B1 saw loopback blocked for spawned processes).
  // Prove it before burning tokens. `start` is detached and returns before the socket binds.
  let reach;
  for (let i = 0; i < 15; i++) {
    reach = sh('node', [
      '-e',
      `require('http').get(${JSON.stringify(baseUrl)}+'/api/hello',r=>{console.log('HTTP',r.statusCode);process.exit(0)}).on('error',e=>{console.log('ERR',e.message);process.exit(1)})`,
    ]);
    if (reach.status === 0) break;
    sh('sleep', ['1']);
  }
  console.log('spawned-child reachability:', (reach.stdout ?? '').trim(), (reach.stderr ?? '').trim());
  if (reach.status !== 0) throw new Error('spawned child cannot reach the daemon — abort before spending tokens');

  for (const [name, settings] of Object.entries(ARMS)) {
    const cfg = armDir(name, settings);
    // Pre-flight: the SAME dir the live run will use must parse (B1: a malformed settings
    // file is SILENTLY IGNORED under `-p`, which would make the arms identical and the
    // measured delta a fiction).
    const pre = initEvent({ CLAUDE_CONFIG_DIR: cfg });
    console.log(`\n[${name}] pre-flight version=${pre.claude_code_version} skills=${(pre.skills ?? []).length}`);
    if (!pre.skills) throw new Error(`arm ${name}: settings did not load`);
    for (const t of TARGETS) {
      if (!(pre.skills ?? []).includes(t)) throw new Error(`arm ${name}: target ${t} is not in the catalog at all`);
    }
    const r = sh(
      'claude',
      ['-p', PROMPT, '--model', MODEL, '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      {
        cwd: PROJECT,
        env: { ...baseEnv(), CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: baseUrl, ENABLE_TOOL_SEARCH: 'true' },
        timeout: 300_000,
      },
    );
    console.log(`[${name}] exit=${r.status} out=${(r.stdout ?? '').trim().slice(0, 300)}`);
    if (r.stderr?.trim()) console.log(`[${name}] stderr=${r.stderr.trim().slice(0, 300)}`);
    fs.rmSync(path.join(cfg, '.credentials.json'), { force: true }); // secret lives as briefly as possible
  }
  console.log(ccsnoop(['stop']).stdout ?? '');
  console.log('sessions:', path.join(PROJECT, '.ccsnoop', 'sessions'));
}

// ── analyze: per-entry byte diff via the repo's own catalog parser ───────────
//
// Why this selects on `tools[]` rather than calling `computeFloor`: on a `-p` capture, turn 1
// is a tool-less auxiliary round-trip and `floor` anchors on it, reporting no catalog at all
// (issue #120). A non-empty `tools[]` is the discriminator that finds the real opening.
function firstToolRequest(dir) {
  loadSession(dir); // smoke-test the repo's own session loader on this capture before reading it
  const lines = fs
    .readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const m of lines) {
    if (!m.request_blob) continue;
    const text = fs.readFileSync(path.join(dir, m.request_blob), 'utf8');
    const sep = text.indexOf('\r\n\r\n');
    let body;
    try {
      body = JSON.parse(sep >= 0 ? text.slice(sep + 4) : text);
    } catch {
      continue;
    }
    if (Array.isArray(body.tools) && body.tools.length) return { body, turn: m.turn };
  }
  throw new Error('no request with a non-empty tools[] in ' + dir);
}

/** The skills-catalog block of a turn-1 body, as `floor --detail` sees it. */
function skillsCatalog(body) {
  const block = findCatalogBlocks(body).find((b) => b.kind === 'skills-catalog');
  if (!block) throw new Error('no skills-catalog block found in this request');
  return { block, entries: parseCatalogEntries('skills-catalog', block.text) };
}

function analyze(dirA, dirB) {
  const a = firstToolRequest(path.resolve(dirA));
  const b = firstToolRequest(path.resolve(dirB));
  for (const [label, x] of [
    ['control', a],
    ['name-only', b],
  ]) {
    const an = computeAnatomy(x.body);
    console.log(
      `${label}: turn=${x.turn} total=${an.total} system=${an.system} tools=${an.tools} history=${an.history} currentTurn=${an.currentTurn}`,
    );
  }

  const ca = skillsCatalog(a.body);
  const cb = skillsCatalog(b.body);
  console.log(
    `\nskills-catalog block: ${ca.block.bytes} -> ${cb.block.bytes} B  (delta ${cb.block.bytes - ca.block.bytes}) ` +
      `| entries ${ca.entries.length} -> ${cb.entries.length}`,
  );

  const ea = new Map(ca.entries.map((e) => [e.name, e.bytes]));
  const eb = new Map(cb.entries.map((e) => [e.name, e.bytes]));
  console.log('\nper-entry bytes (parseCatalogEntries — the `floor --detail` path):');
  let moved = 0;
  for (const name of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(name) ?? 0;
    const y = eb.get(name) ?? 0;
    if (x === y && !TARGETS.includes(name)) continue;
    moved += x - y;
    const mark = TARGETS.includes(name) ? 'TARGET' : y === 0 ? 'GONE' : x === 0 ? 'ADDED' : 'CHANGED';
    console.log(`  ${String(x).padStart(6)} -> ${String(y).padStart(6)}  ${mark.padEnd(8)} ${name}`);
  }
  console.log(`  net moved: ${moved} B`);

  // The BOUNDED claim, read off the wire rather than off `system/init`: each target must
  // still be present as an entry, and must now cost exactly its name line.
  console.log('\nbounded-action check (on the wire):');
  for (const t of TARGETS) {
    const present = eb.has(t);
    const nameLine = Buffer.byteLength(`- ${t}\n`, 'utf8');
    console.log(
      `  ${t.padEnd(12)} still listed=${present ? 'YES' : 'NO '}  bytes=${eb.get(t) ?? 0}  (bare name line = ${nameLine})`,
    );
  }

  // Residue: does the withheld description survive anywhere else in the request? A verdict
  // that "recovers" bytes CC re-ships elsewhere would be a fiction.
  const bodyText = JSON.stringify(b.body);
  console.log('\nresidue of the withheld descriptions:');
  for (const t of TARGETS) {
    const desc = (ca.entries.find((e) => e.name === t)?.bytes ?? 0) > 0 ? descriptionOf(ca.block.text, t) : '';
    const probe = desc.slice(0, 60);
    console.log(
      `  ${t.padEnd(12)} first 60 chars of its control description occur ${probe ? bodyText.split(probe).length - 1 : 0}x in the name-only request`,
    );
  }
}

/** The description text of `name` in a catalog block, for the residue probe. */
function descriptionOf(text, name) {
  const line = text.split('\n').find((l) => l.trim().startsWith(`- ${name}: `));
  return line ? line.trim().slice(`- ${name}: `.length) : '';
}

function clean() {
  ccsnoop(['stop']);
  ccsnoop(['init', '--undo']);
  for (const f of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])
    if (f.startsWith('arm-')) fs.rmSync(path.join(ROOT, f, '.claude', '.credentials.json'), { force: true });
  console.log('stopped daemon, undid route; credential copies deleted. `rm -rf ' + ROOT + '` when done.');
}

const mode = process.argv[2];
if (mode === 'sweep') sweep();
else if (mode === 'slash') slash();
else if (mode === 'capture') capture();
else if (mode === 'analyze') analyze(process.argv[3], process.argv[4]);
else if (mode === 'clean') clean();
else {
  console.error('usage: skill-overrides-probe.mjs sweep|slash|capture [port]|analyze <ctlDir> <nameOnlyDir>|clean');
  process.exit(2);
}
