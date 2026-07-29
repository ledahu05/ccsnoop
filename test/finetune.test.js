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

// The 9 v1 denylist names in spec order (data/builtin-denylist.json).
const V1_NAMES = [
  'Workflow',
  'Artifact',
  'AskUserQuestion',
  'ScheduleWakeup',
  'ReportFindings',
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

test('loadBuiltinDenylist reads the committed 9-entry v1 denylist in spec order', () => {
  // The committed file lives at the repo data path the loader defaults to.
  assert.equal(DEFAULT_DENYLIST_PATH, path.join(REPO_ROOT, 'data', 'builtin-denylist.json'));
  const list = loadBuiltinDenylist();
  assert.equal(list.length, 9, 'v1 ships exactly 9 entries');
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
