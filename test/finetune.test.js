// FT1 (issue #71) — the fine-tune skeleton: --session dispatch + built-in tools deny.
//
// This slice wires a `ccsnoop fine-tune` subcommand that loads ONE session,
// intersects its shipped tools[] names with data/builtin-denylist.json, and emits
// a minimal CLI diagnostic + a paste-ready, pure-JSON settings.json block
// (permissions.deny). The full per-lever table (MCP/hooks/CLAUDE.md, bytes) is
// later tickets (T4–T6); FT1 is the tracer bullet.
//
// Tests run against a SYNTHETIC captured session (the same pattern as
// report.test.js) so the logic is exercised today, while the real-fixture
// integration check (AC #1) self-skips until FT0 commits a capture
// (finetune-fixture.test.js owns that gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadBuiltinDenylist,
  DEFAULT_DENYLIST_PATH,
  shippedToolNames,
  denyIntersection,
  renderFineTune,
  fineTune,
} from '../src/finetune.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-finetune-'));
}

/** A corpus with no MCP server in it — the FT4 lever's no-op input (see finetune-mcp.test.js). */
const EMPTY_MCP_CORPUS = { sessionCount: 0, singleSession: false, servers: [] };

// The 10 v1 denylist names in spec order (data/builtin-denylist.json).
const V1_NAMES = [
  'Workflow',
  'Artifact',
  'AskUserQuestion',
  'ScheduleWakeup',
  'ReportFindings',
  'EnterWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
];

/** Write a minimal captured session dir the way the proxy would, with a chosen
 *  tools[] so the deny intersection is deterministic. */
function writeFinetuneSession(root, id, tools) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: 'system prompt' }],
        tools,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(
    path.join(dir, '0001.response.sse'),
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n'
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

// ── loadBuiltinDenylist (AC #3: committed file + shape validation) ────────────

test('loadBuiltinDenylist reads the committed 10-entry v1 denylist in spec order', () => {
  // The committed file lives at the repo data path the loader defaults to.
  assert.equal(DEFAULT_DENYLIST_PATH, path.join(REPO_ROOT, 'data', 'builtin-denylist.json'));
  const list = loadBuiltinDenylist();
  assert.equal(list.length, 10, 'v1 ships exactly 10 entries');
  assert.deepEqual(
    list.map((e) => e.name),
    V1_NAMES,
    'names in spec Part 4 order'
  );
  // Every entry is the full {name,category,note} triple.
  for (const e of list) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.category, 'string');
    assert.equal(typeof e.note, 'string');
    assert.ok(e.name.length > 0 && e.category.length > 0 && e.note.length > 0);
  }
  // Core primitives are explicitly NOT in the list (spec Part 4 inclusion rule).
  for (const prim of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'TodoWrite']) {
    assert.ok(!list.some((e) => e.name === prim), `${prim} must never be denied`);
  }
});

test('loadBuiltinDenylist rejects a non-array file', () => {
  const p = path.join(mkTmpDir(), 'bad.json');
  fs.writeFileSync(p, JSON.stringify({ name: 'Workflow' }));
  assert.throws(() => loadBuiltinDenylist(p), /not a JSON array/);
});

test('loadBuiltinDenylist rejects an entry missing a required field', () => {
  const p = path.join(mkTmpDir(), 'bad.json');
  fs.writeFileSync(p, JSON.stringify([{ name: 'Workflow', category: 'orchestration' }]));
  assert.throws(() => loadBuiltinDenylist(p), /'note'/);
});

test('loadBuiltinDenylist rejects a non-string field', () => {
  const p = path.join(mkTmpDir(), 'bad.json');
  fs.writeFileSync(p, JSON.stringify([{ name: 7, category: 'x', note: 'y' }]));
  assert.throws(() => loadBuiltinDenylist(p), /'name'/);
});

test('loadBuiltinDenylist rejects a duplicate name (would emit a dup deny)', () => {
  const p = path.join(mkTmpDir(), 'bad.json');
  fs.writeFileSync(
    p,
    JSON.stringify([
      { name: 'Workflow', category: 'orchestration', note: 'a' },
      { name: 'Workflow', category: 'orchestration', note: 'b' },
    ])
  );
  assert.throws(() => loadBuiltinDenylist(p), /duplicate name 'Workflow'/);
});

// ── denyIntersection (AC #2: bare names, denylist order) ──────────────────────

test('denyIntersection returns bare names, denylist order, only shipped', () => {
  const denylist = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  // Shipped out of order + a primitive that is never denied + a denylist name not shipped.
  const shipped = ['CronCreate', 'Bash', 'Workflow', 'Read', 'Artifact'];
  assert.deepEqual(denyIntersection(shipped, denylist), ['Workflow', 'Artifact', 'CronCreate']);
});

test('denyIntersection is empty when nothing shipped intersects', () => {
  const denylist = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  assert.deepEqual(denyIntersection(['Bash', 'Read', 'TodoWrite'], denylist), []);
  assert.deepEqual(denyIntersection([], denylist), []);
});

// ── shippedToolNames (derived from the segmentRequest slots) ──────────────────

test('shippedToolNames unions tool names across exchanges and drops anonymous tools', () => {
  // Two exchanges; the second adds one tool. An anonymous tool (no name) is
  // slotted `tool:#0` and must be excluded — it has no name to deny.
  const model = {
    exchanges: [
      {
        segments: [
          { slot: 'system#0' },
          { slot: 'tool:Workflow' },
          { slot: 'tool:Bash' },
          { slot: 'tool:#0' }, // anonymous — dropped
          { slot: 'message#0' },
        ],
      },
      {
        segments: [{ slot: 'tool:Artifact' }, { slot: 'tool:Bash' }],
      },
    ],
  };
  assert.deepEqual(
    shippedToolNames(model).sort(),
    ['Artifact', 'Bash', 'Workflow'],
    'union of named tools, anonymous excluded'
  );
});

test('shippedToolNames is null-safe on a session with no tools', () => {
  assert.deepEqual(shippedToolNames({ exchanges: [{ segments: [{ slot: 'system#0' }] }] }), []);
  assert.deepEqual(shippedToolNames({ exchanges: [] }), []);
});

// ── renderFineTune (AC #4: pure, parseable JSON block, no comments) ───────────

test('renderFineTune emits a parseable pure-JSON block with permissions.deny', () => {
  const { lines, settingsJson } = renderFineTune({
    sessionId: 'sess-x',
    requests: 3,
    shipped: ['Bash', 'Workflow', 'Artifact'],
    deny: ['Workflow', 'Artifact'],
    mcp: EMPTY_MCP_CORPUS,
  });
  // The block is valid JSON, no comments.
  assert.doesNotThrow(() => JSON.parse(settingsJson));
  assert.ok(!/\/\//.test(settingsJson), 'no // comments in the block');
  assert.ok(!/\/\*/.test(settingsJson), 'no /* */ comments in the block');
  assert.deepEqual(JSON.parse(settingsJson), { permissions: { deny: ['Workflow', 'Artifact'] } });
  // Diagnostic header names the session + request count.
  assert.ok(lines.some((l) => /sess-x/.test(l) && /3 requests/.test(l)));
  // Cache-invalidation warning appears above a non-empty deny (spec Part 5).
  assert.ok(lines.some((l) => /invalidates the cache/.test(l)));
});

test('renderFineTune omits the cache warning when there is nothing to deny', () => {
  const { lines, settingsJson } = renderFineTune({
    sessionId: 'sess-y',
    requests: 1,
    shipped: ['Bash'],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
  });
  assert.deepEqual(JSON.parse(settingsJson), { permissions: { deny: [] } });
  assert.ok(!lines.some((l) => /invalidates the cache/.test(l)), 'no warning for an empty deny');
});

// ── the skills lever in the text diagnostic (issue #118, ADR-0005 lever 5a) ───

/** A skills corpus in the shape `aggregateSkillCorpus` emits. */
function skillCorpus(skills, { sessionCount = 3, singleSession = false, rosterSize = 0 } = {}) {
  return {
    sessionCount,
    singleSession,
    roster: { size: rosterSize, source: rosterSize ? 'data/bundled-skills.json' : null, readOn: ['2.1.224'], error: null },
    skills: skills.map((s) => ({
      reachable: true,
      shippedSessions: sessionCount,
      invokedCount: 0,
      override: true,
      scope: null,
      scopeKind: null,
      bundled: false,
      skill: s.name,
      ...s,
    })),
  };
}

/**
 * A gain model whose only charged bucket is the skills catalog.
 * @returns {import('../src/finetune-gain.js').GainModel}
 */
function skillsGain(shipped, waste = shipped) {
  return {
    tool: new Map(),
    claudeMd: new Map(),
    hook: { shipped: 0, waste: 0 },
    mcp: { shipped: 0, waste: 0 },
    catalog: new Map([['skills-catalog', { shipped, waste }]]),
    harness: { shipped: 0, waste: 0 },
  };
}

test('renderFineTune gives the skills catalog an ACTION and names each skill under it', () => {
  const { lines, settingsJson } = renderFineTune({
    sessionId: 'sess-s',
    requests: 4,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([
      { name: 'dataviz', bytes: 1157 },
      { name: 'tdd', bytes: 400, invokedCount: 2, override: false },
    ]),
  });
  const row = lines.find((l) => /skills-catalog/.test(l));
  assert.ok(/name-only/.test(row), `the row carries the action, got: ${row}`);
  // Per-skill detail, the way the MCP row lists its servers.
  assert.ok(lines.some((l) => /dataviz/.test(l) && /name-only/.test(l)));
  assert.ok(
    lines.some((l) => /\btdd\b/.test(l) && /invoked 2\/3/.test(l)),
    'an invoked skill is shown with its evidence, not silently dropped',
  );
  assert.deepEqual(JSON.parse(settingsJson).skillOverrides, { dataviz: 'name-only' });
  assert.ok(lines.some((l) => /invalidates the cache/.test(l)), 'the block changes the prompt prefix');
});

test('renderFineTune keeps the catalog row cost-only when no skill qualifies', () => {
  const { lines, settingsJson } = renderFineTune({
    sessionId: 'sess-s2',
    requests: 4,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([{ name: 'tdd', bytes: 400, invokedCount: 1, override: false }]),
  });
  const row = lines.find((l) => /skills-catalog/.test(l));
  assert.ok(!/name-only/.test(row), `no action claimed without a verdict, got: ${row}`);
  assert.ok(!('skillOverrides' in JSON.parse(settingsJson)));
  // One line saying why, instead of one "does not qualify" line per skill: with the guard
  // met, "none qualifies" means the skills are in use — a different fact from thin evidence.
  const note = lines.find((l) => /^Skills:/.test(l));
  assert.match(note, /none qualifies/);
  assert.match(note, /model-invoked/);
});

test('a catalog with too little evidence says so, and does not read as "already lean"', () => {
  const { lines } = renderFineTune({
    sessionId: 'sess-s3',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([{ name: 'dataviz', bytes: 1157, override: false }], { sessionCount: 1, singleSession: true }),
  });
  const note = lines.find((l) => /^Skills:/.test(l));
  assert.match(note, /1\/3 sessions/, 'the guard denominator, not a silent flag-only');
  assert.ok(!lines.some((l) => /keep \(invoked/.test(l)), 'no per-skill paragraph under a cost-only row');
});

test('renderFineTune counts the skills recovery once — the total is not inflated by the lever', () => {
  // The lever measures the SAME bytes as the catalog row it acts on, so adding a second row
  // would double the shipped total of a session that ships one catalog.
  const withLever = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([{ name: 'dataviz', bytes: 1157 }]),
  });
  const withoutLever = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
  });
  const total = (r) => r.lines.find((l) => /^Total/.test(l));
  assert.equal(
    total(withLever).match(/(\d[\d.]*K?)\s+\S+$/)[1],
    total(withoutLever).match(/(\d[\d.]*K?)\s+\S+$/)[1],
    'same shipped total with and without a verdict',
  );
});

// ── fineTune() end-to-end on a synthetic session ──────────────────────────────

test('fineTune intersects the session tools[] with the denylist (denylist order)', () => {
  const root = mkTmpDir();
  writeFinetuneSession(root, 'sess-ft', [
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'TodoWrite' }, // primitives — never denied
    { name: 'Workflow' },
    { name: 'Artifact' },
    { name: 'CronCreate' },
  ]);
  const res = fineTune({ cwd: '/nonexistent', root, session: 'sess-ft' });
  assert.equal(res.sessionId, 'sess-ft');
  assert.equal(res.requests, 1);
  assert.deepEqual(res.shipped.sort(), ['Artifact', 'Bash', 'CronCreate', 'Read', 'TodoWrite', 'Workflow']);
  assert.deepEqual(res.deny, ['Workflow', 'Artifact', 'CronCreate'], 'intersection in denylist order');
  assert.deepEqual(JSON.parse(res.settingsJson), { permissions: { deny: ['Workflow', 'Artifact', 'CronCreate'] } });
});

test('fineTune honors --session and defaults to the latest session', () => {
  const root = mkTmpDir();
  writeFinetuneSession(root, 'old', [{ name: 'Bash' }]);
  const newDir = writeFinetuneSession(root, 'new', [{ name: 'Artifact' }]);
  const future = new Date('2027-01-01T00:00:00Z');
  fs.utimesSync(path.join(newDir, 'manifest.jsonl'), future, future);

  assert.equal(fineTune({ cwd: '/nonexistent', root }).sessionId, 'new', 'latest by default');
  assert.equal(fineTune({ cwd: '/nonexistent', root, session: 'old' }).sessionId, 'old', '--session honored');
});

/**
 * Write a captured session whose turn-1 message carries a skills catalog listing `entries`,
 * and whose response invokes `invoked` through the `Skill` tool — the two halves of lever
 * 5a's evidence, in the shapes Claude Code actually puts on the wire.
 */
function writeSkillsSession(root, id, entries, invoked = []) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const catalog =
    '<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n' +
    entries.map(([name, desc]) => `- ${name}: ${desc}`).join('\n') +
    '\n</system-reminder>';
  fs.writeFileSync(
    path.join(dir, '0001.request.http'),
    buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(
        JSON.stringify({
          model: 'claude-x',
          system: [{ type: 'text', text: 'You are Claude Code.' }],
          tools: [{ name: 'Bash' }],
          messages: [{ role: 'user', content: [{ type: 'text', text: catalog }, { type: 'text', text: 'hi' }] }],
        })
      ),
    })
  );
  let sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n';
  invoked.forEach((skill, i) => {
    sse += `data: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `t${i}`, name: 'Skill' } })}\n\n`;
    sse += `data: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill }) } })}\n\n`;
  });
  fs.writeFileSync(path.join(dir, '0001.response.sse'), sse);
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

test('fineTune emits name-only over the corpus for a skill the model never invoked', () => {
  const root = mkTmpDir();
  const entries = [
    ['dataviz', 'a long description that costs real bytes on every single request'],
    ['tdd', 'red-green-refactor'],
  ];
  writeSkillsSession(root, 'sess-1', entries, ['tdd']);
  writeSkillsSession(root, 'sess-2', entries);
  writeSkillsSession(root, 'sess-3', entries);

  const res = fineTune({ cwd: '/nonexistent', root });
  assert.equal(res.skills.sessionCount, 3);
  assert.deepEqual(res.json.settings.auto.skillOverrides, { dataviz: 'name-only' }, 'tdd was invoked — spared');
  assert.deepEqual(JSON.parse(res.settingsJson).skillOverrides, { dataviz: 'name-only' });
  // The contract invariant: auto ∪ advice IS the paste-ready block (issue #95).
  assert.deepEqual({ ...res.json.settings.auto, ...res.json.settings.advice }, JSON.parse(res.settingsJson));
  const skills = res.json.safeLevers.find((l) => l.lever === 'skills');
  assert.ok(skills.items.find((i) => i.name === 'dataviz').bytes > 0, 'the verdict names bytes');
});

test('fineTune never emits a skills verdict in single-session mode', () => {
  const root = mkTmpDir();
  const entries = [['dataviz', 'a long description']];
  writeSkillsSession(root, 'sess-1', entries);
  writeSkillsSession(root, 'sess-2', entries);
  writeSkillsSession(root, 'sess-3', entries);

  const res = fineTune({ cwd: '/nonexistent', root, latest: true });
  assert.equal(res.skills.singleSession, true);
  assert.ok(!('skillOverrides' in res.json.settings.auto), 'one session is too thin for a global verdict');
  assert.equal(res.json.safeLevers.find((l) => l.lever === 'skills').verdict, 'flag-only');
});

test('fineTune throws like report on a missing session and on no sessions', () => {
  const root = mkTmpDir();
  writeFinetuneSession(root, 'only', [{ name: 'Bash' }]);
  assert.throws(() => fineTune({ cwd: '/nonexistent', root, session: 'missing' }), /not found/);

  const empty = mkTmpDir();
  assert.throws(() => fineTune({ cwd: '/nonexistent', root: empty }), /no captured sessions/);
});

// ── CLI dispatch (AC #5: flags/dispatch mirror report; --session honored) ──────

test('ccsnoop fine-tune dispatches and prints a diagnostic + JSON block (exit 0)', () => {
  const root = mkTmpDir();
  writeFinetuneSession(root, 'sess-cli', [
    { name: 'Bash' },
    { name: 'Workflow' },
    { name: 'CronList' },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'fine-tune', '--root', root, '--session', 'sess-cli'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /sess-cli/);
  assert.match(r.stdout, /settings\.json/);
  // The block sits in stdout and parses; permissions.deny is exactly the intersection.
  const block = JSON.parse(r.stdout.match(/\{[\s\S]*"permissions"[\s\S]*\}/)[0]);
  assert.deepEqual(block, { permissions: { deny: ['Workflow', 'CronList'] } });
});

test('ccsnoop fine-tune with no sessions exits non-zero like report', () => {
  const empty = mkTmpDir();
  const r = spawnSync(process.execPath, [BIN, 'fine-tune', '--root', empty], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no captured sessions/);
});

test('ccsnoop fine-tune mirrors report: unknown flags are ignored, not fatal (AC #5)', () => {
  // report has no unknown-flag validation — it reads the flags it knows and
  // ignores the rest. fine-tune mirrors that dispatch, so a stray flag must not
  // be treated as an error.
  const root = mkTmpDir();
  writeFinetuneSession(root, 'sess-flags', [{ name: 'Bash' }, { name: 'Workflow' }]);
  const r = spawnSync(
    process.execPath,
    [BIN, 'fine-tune', '--root', root, '--session', 'sess-flags', '--bogus-extra', 'x'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `unknown flag should not be fatal; stderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.match(/\{[\s\S]*"permissions"[\s\S]*\}/)[0]), {
    permissions: { deny: ['Workflow'] },
  });
});

// ── AC #1: runs against the real FT0 fixture when one is committed ────────────

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

function fixtureSessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => e.name)
    .sort();
}

const fixtureDirs = fixtureSessionDirs();
const fixtureOpts = fixtureDirs.length === 0
  ? {
      skip:
        'no fixture committed under test/fixtures/finetune/ — FT0 (issue #70) blocked in this sandbox; ' +
        'this integration check activates the moment a real capture lands',
    }
  : {};

test('fineTune runs against the committed FT0 fixture (AC #1)', fixtureOpts, () => {
  for (const id of fixtureDirs) {
    // `root` is FIXTURES_DIR itself, not its parent: listSessions(root) scans
    // `<root>/sessions/*` and `<root>/*`, and the manifests live one level down at
    // `finetune/session-*/manifest.jsonl`. Passing `test/fixtures` made the session
    // dirs grandchildren, so discovery found nothing and this gate could never pass
    // whatever fixture landed.
    const res = fineTune({
      cwd: '/nonexistent',
      root: FIXTURES_DIR,
      session: id,
    });
    // The block is valid JSON and permissions.deny is exactly the intersection
    // of the fixture's tools[] names with the denylist (bare names, AC #2). The
    // fixture also carries hook + CLAUDE.md levers (FT5), so those keys join the
    // block — only permissions.deny is asserted here (FT1's slice).
    assert.doesNotThrow(() => JSON.parse(res.settingsJson), `${id}: block must be parseable`);
    const expected = denyIntersection(res.shipped, loadBuiltinDenylist());
    assert.deepEqual(res.deny, expected, `${id}: deny must equal the bare-name intersection`);
    assert.deepEqual(JSON.parse(res.settingsJson).permissions, { deny: expected });
  }
});

// ── lever 5b (issue #119) — the two advice sections, and point 3 ─────────────

test('fixture: bundled skills are RECOVERABLE context, never part of the incompressible floor', () => {
  // ADR-0005 fact 3, and point 3 of issue #119: #105 assumed the bundled scope was
  // incompressible. It is not — `disableBundledSkills`, `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`
  // and per-name `skillOverrides` all reach it. This freezes that nothing in the byte
  // accounting quietly files them under the harness floor, where they would be shown as
  // bytes no lever can ever touch.
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR });
  const bundled = res.skills.skills.filter((s) => s.bundled);
  assert.ok(bundled.length > 0, 'the fixture ships a bundled catalog — otherwise this proves nothing');

  const catalogBytes = res.gain.catalog.get('skills-catalog').shipped;
  assert.ok(catalogBytes > 0, 'their bytes are charged to the skills-catalog population…');
  assert.equal(res.json.catalog.populations.find((p) => p.population === 'skills-catalog').shipped, catalogBytes);
  // …and the floor block is the harness preamble ALONE. If the catalog were folded in,
  // `floor.shipped` would carry these bytes under `action: 'none'` — unrecoverable by
  // construction, which is precisely the wrong answer.
  assert.equal(res.json.floor.shipped, res.gain.harness.shipped);
  assert.equal(res.json.floor.action, 'none');
  assert.ok(res.json.floor.shipped > catalogBytes, 'sanity: the two are distinct populations');
  // The proof that they are recoverable: lever 5a reaches every one of them by name.
  for (const s of bundled) assert.equal(s.reachable, true, `${s.name} is reachable by skillOverrides`);
});

test('fixture: the bundled bulk is surfaced even when withheld, and names its whole population', () => {
  // "No option shown" and "the option was withheld" are different facts, and only one of
  // them means the catalog is already lean. The fixture is one session, so the guard
  // withholds — and the section must still say so, and name what it would have dropped.
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR });
  const text = res.lines.join('\n');
  assert.match(text, /Bundled skills \(advice — disableBundledSkills\)/);
  assert.match(text, /not offered/);
  assert.match(text, /dataviz/);
  assert.match(text, /you lose \/name on each of them/, 'the caveat travels with the figure');
  // Withheld ⇒ absent from the paste-ready block, and from the contract's advice settings.
  assert.ok(!('disableBundledSkills' in JSON.parse(res.settingsJson)));
  assert.ok(!('disableBundledSkills' in res.json.settings.advice));
  assert.equal(res.json.adviceLevers.find((l) => l.lever === 'bundledSkills').verdict, 'none');
});

test('fixture: `apply` never touches a 5b key, whatever the report says', () => {
  // The exit criterion of #119: `ccsnoop apply` must have no path, even accidental, to
  // `enabledPlugins` or `disableBundledSkills`. The safe subset is the only thing it
  // writes, and neither key can appear there.
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR });
  const auto = JSON.stringify(res.json.settings.auto);
  assert.ok(!/disableBundledSkills|enabledPlugins/.test(auto), `safe subset leaked a 5b key: ${auto}`);
});

test('renderFineTune shows the plugin signalement in its own section, with BOTH halves', () => {
  // The tier boundary has to be legible: what `apply` writes on approval (5a) and what is
  // only shown (5b) must not read as one column. And a plugin's report must name the
  // skills the model DOES use, because `enabledPlugins` would take them down too.
  const { lines, settingsJson } = renderFineTune({
    sessionId: 'sess-p',
    requests: 4,
    shipped: [],
    deny: [],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([
      { name: 'mattpocock-skills:code-review', skill: 'code-review', bytes: 900, scope: 'mattpocock-skills', scopeKind: 'plugin', reachable: false, invokedCount: 6, override: false },
      { name: 'mattpocock-skills:naming', skill: 'naming', bytes: 501, scope: 'mattpocock-skills', scopeKind: 'plugin', reachable: false, override: false },
    ]),
  });
  const text = lines.join('\n');
  assert.match(text, /Scoped skills \(advice — enabledPlugins is yours to decide/);
  assert.match(text, /mattpocock-skills\s+.*2 skills, 1 invoked/);
  assert.ok(lines.some((l) => /code-review/.test(l) && /invoked 6×/.test(l)), 'the working skill is named');
  assert.ok(lines.some((l) => /naming/.test(l) && /never invoked/.test(l)));
  // Nothing written, and nothing offered to paste: the value is a judgment, not a figure.
  assert.ok(!/enabledPlugins/.test(settingsJson));
  assert.deepEqual(JSON.parse(settingsJson), { permissions: { deny: [] } });
});

test('renderFineTune offers the bundled bulk only when the whole population went un-invoked', () => {
  const bundled = [
    { name: 'dataviz', bytes: 1157, bundled: true },
    { name: 'simplify', bytes: 191, bundled: true },
  ];
  const render = (skills) =>
    renderFineTune({
      sessionId: 'sess-b',
      requests: 4,
      shipped: [],
      deny: [],
      mcp: EMPTY_MCP_CORPUS,
      gain: skillsGain(5119),
      skills: skillCorpus(skills, { rosterSize: 16 }),
    });

  const dead = render(bundled);
  assert.match(dead.lines.join('\n'), /would drop 2 skills/);
  assert.equal(JSON.parse(dead.settingsJson).disableBundledSkills, true, 'paste-ready, never auto-written');

  // One invoked bundled skill and the all-or-nothing gesture costs more than it returns:
  // from there it is lever 5a's per-name `name-only` that applies.
  const used = render([bundled[0], { ...bundled[1], invokedCount: 2, override: false }]);
  assert.match(used.lines.join('\n'), /not offered — 1 bundled skill\(s\) were model-invoked/);
  assert.ok(!('disableBundledSkills' in JSON.parse(used.settingsJson)));
  assert.deepEqual(JSON.parse(used.settingsJson).skillOverrides, { dataviz: 'name-only' });
});

test('the paste-ready block names its ADVICE keys — the two tiers must not read as one column', () => {
  // Issue #119's boundary requirement: what `apply` writes on approval and what is only
  // shown must not read the same. The block itself stays pure JSON (that is what makes it
  // pasteable), so the split is stated beside it — otherwise a proven deny and an
  // all-or-nothing gesture that costs `/name` look equally settled.
  const { lines } = renderFineTune({
    sessionId: 'sess-t',
    requests: 4,
    shipped: [],
    deny: ['Workflow'],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    levers: { systemBytes: 100, hook: { bytes: 8000, aboveFloor: true, deny: true }, claudeMd: [] },
    skills: skillCorpus([{ name: 'dataviz', bytes: 1157, bundled: true }], { rosterSize: 16 }),
  });
  const label = lines.find((l) => /ADVICE/.test(l));
  assert.ok(label, 'the advice keys are called out beside the block');
  assert.match(label, /disableBundledSkills/);
  assert.match(label, /hooks/);
  assert.match(label, /will NOT write/);
  assert.ok(!/permissions|skillOverrides/.test(label), 'the safe keys are not swept into the warning');
});

test('a block with only safe keys carries no advice warning — the label means something', () => {
  const { lines } = renderFineTune({
    sessionId: 'sess-t2',
    requests: 4,
    shipped: [],
    deny: ['Workflow'],
    mcp: EMPTY_MCP_CORPUS,
    gain: skillsGain(5119),
    skills: skillCorpus([{ name: 'dataviz', bytes: 1157 }]),
  });
  assert.ok(!lines.some((l) => /ADVICE/.test(l)));
});
