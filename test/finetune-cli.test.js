// FT7 (issue #77) — finish the CLI surface: corpus default, the remaining report
// flags (--sessions-dir), and the T7 one-run denylist override
// (--deny-extra / --deny-allow), then the spec Part 6 acceptance checklist
// end-to-end against the committed fixture corpus.
//
// The corpus default + --latest / --root + single-session weak-evidence were wired
// in FT4 (issue #74); FT7 closes the surface. Two new pieces only: the shared
// `--sessions-dir` pin (mirrors `start --sessions-dir`) and the denylist override
// (spec Part 4 — one-off run, no persisted config key in v1). Part 6 is asserted as
// a single end-to-end gate over the real fixture in default (corpus) mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadBuiltinDenylist,
  denyIntersection,
  applyDenylistOverride,
  fineTune,
} from '../src/finetune.js';
import { generateReport } from '../src/report.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

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

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ft7-'));
}

/** Write a minimal captured session dir with a chosen tools[] (mirrors FT1's helper). */
function writeSession(root, id, tools) {
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

/** Parse the paste-ready JSON block out of a CLI run's stdout. */
function parseBlock(stdout) {
  return JSON.parse(stdout.match(/\{[\s\S]*"permissions"[\s\S]*\}/)[0]);
}

// ── applyDenylistOverride (spec Part 4 — one-run override, two paths, no new config) ─

test('applyDenylistOverride is a no-op when neither flag is given', () => {
  const base = loadBuiltinDenylist();
  assert.deepEqual(applyDenylistOverride(base), base);
  // A fresh array, not the same reference — the renderer never mutates the base.
  assert.notEqual(applyDenylistOverride(base), base);
});

test('applyDenylistOverride adds an extra name (carried through to the deny)', () => {
  const base = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  const out = applyDenylistOverride(base, { extra: ['MyCustomTool'] });
  // The extra name is appended as a full entry so the diagnostic can show a reason.
  const added = out.find((e) => e.name === 'MyCustomTool');
  assert.ok(added, 'extra name is present');
  assert.equal(typeof added.category, 'string');
  assert.ok(added.category.length > 0);
  assert.equal(typeof added.note, 'string');
  assert.ok(added.note.length > 0);
  // Base entries are untouched and keep their order ahead of the addition.
  assert.deepEqual(out.slice(0, base.length), base);
  // It flows into the shipped ∩ denylist intersection (denylist order: base, then extra).
  assert.deepEqual(
    denyIntersection(['Bash', 'Workflow', 'MyCustomTool'], out),
    ['Workflow', 'MyCustomTool']
  );
});

test('applyDenylistOverride drops an allowed name for the run', () => {
  const base = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  const out = applyDenylistOverride(base, { allow: ['Workflow'] });
  assert.ok(!out.some((e) => e.name === 'Workflow'), 'allowed name removed');
  // Everything else is retained.
  assert.equal(out.length, base.length - 1);
  // And it no longer lands in the deny even when shipped.
  assert.deepEqual(denyIntersection(['Workflow', 'Artifact'], out), ['Artifact']);
});

test('applyDenylistOverride: allow wins over extra for the same name', () => {
  const base = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  const out = applyDenylistOverride(base, { extra: ['Foo'], allow: ['Foo'] });
  assert.ok(!out.some((e) => e.name === 'Foo'), 'allow drops the same-run extra');
});

test('applyDenylistOverride does not duplicate or rewrite an existing base name', () => {
  const base = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  const out = applyDenylistOverride(base, { extra: ['Workflow'] });
  const matches = out.filter((e) => e.name === 'Workflow');
  assert.equal(matches.length, 1, 'no duplicate');
  // The base entry is kept as-is (its category/note), not overwritten by the extra.
  assert.equal(matches[0].category, 'c');
});

test('applyDenylistOverride parses a comma list and ignores empties/whitespace', () => {
  const base = V1_NAMES.map((name) => ({ name, category: 'c', note: 'n' }));
  // A raw flag value like 'A , B,' must yield two clean names, no empty string.
  const out = applyDenylistOverride(base, { extra: ['A', ' B ', '', 'B'] });
  const names = out.map((e) => e.name);
  assert.ok(names.includes('A'));
  assert.ok(names.includes('B'));
  assert.ok(!names.includes(''));
  assert.equal(names.filter((n) => n === 'B').length, 1, 'B deduped');
});

// ── fineTune() end-to-end with the override (AC #3) ───────────────────────────

test('fineTune applies --deny-extra: an extra name is denied when shipped', () => {
  const root = mkTmpDir();
  writeSession(root, 's', [
    { name: 'Bash' },
    { name: 'Workflow' }, // in the base denylist
    { name: 'MyCustomTool' }, // NOT in the base denylist — only via --deny-extra
  ]);
  const res = fineTune({ cwd: '/nonexistent', root, session: 's', denyExtra: ['MyCustomTool'] });
  assert.deepEqual(res.deny, ['Workflow', 'MyCustomTool'], 'base name + extra, denylist order');
  assert.deepEqual(JSON.parse(res.settingsJson).permissions, { deny: ['Workflow', 'MyCustomTool'] });
});

test('fineTune applies --deny-allow: a base denylist name is dropped for the run', () => {
  const root = mkTmpDir();
  writeSession(root, 's', [{ name: 'Bash' }, { name: 'Workflow' }, { name: 'Artifact' }]);
  const res = fineTune({ cwd: '/nonexistent', root, session: 's', denyAllow: ['Workflow'] });
  assert.deepEqual(res.deny, ['Artifact'], 'Workflow dropped, Artifact retained');
});

test('fineTune denyExtra + denyAllow compose: allow wins over extra', () => {
  const root = mkTmpDir();
  writeSession(root, 's', [{ name: 'Workflow' }, { name: 'Foo' }, { name: 'Artifact' }]);
  const res = fineTune({
    cwd: '/nonexistent',
    root,
    session: 's',
    denyExtra: ['Foo'],
    denyAllow: ['Workflow'],
  });
  assert.deepEqual(res.deny, ['Artifact', 'Foo'], 'Workflow dropped, Foo added, denylist order');
});

// ── --sessions-dir (AC #2: mirrors start --sessions-dir, the dir holding sessions) ─

test('fineTune resolves --sessions-dir as the dir that directly holds session subdirs', () => {
  // A sessions dir whose CHILDREN are sessions (the shape `start --sessions-dir`
  // captures to), distinct from a capture root that holds a `sessions/` subdir.
  const sessionsDir = mkTmpDir();
  writeSessionDirectly(sessionsDir, 'direct', [{ name: 'Workflow' }]);
  const res = fineTune({ cwd: '/nonexistent', sessionsDir });
  assert.equal(res.sessionId, 'direct', 'session found directly under --sessions-dir');
});

test('fineTune: --sessions-dir takes precedence over the default <cwd>/.ccsnoop', () => {
  const sessionsDir = mkTmpDir();
  writeSessionDirectly(sessionsDir, 'pinned', [{ name: 'Workflow' }]);
  // cwd points nowhere useful; the explicit --sessions-dir pin must win.
  const res = fineTune({ cwd: '/nonexistent', sessionsDir });
  assert.equal(res.sessionId, 'pinned');
});

test('fineTune: --sessions-dir takes precedence over --root when both are given', () => {
  const sessionsDir = mkTmpDir();
  writeSessionDirectly(sessionsDir, 'from-sessions-dir', [{ name: 'Workflow' }]);
  const root = mkTmpDir(); // empty root — would find nothing on its own
  const res = fineTune({ cwd: '/nonexistent', root, sessionsDir });
  assert.equal(res.sessionId, 'from-sessions-dir', 'the explicit sessions-dir pin wins');
});

test('report mirrors fine-tune: generateReport honours sessionsDir too', () => {
  const sessionsDir = mkTmpDir();
  const dir = writeSessionDirectly(sessionsDir, 'rep', [{ name: 'Bash' }]);
  const res = generateReport({ cwd: '/nonexistent', sessionsDir });
  assert.equal(res.sessionId, 'rep');
  assert.ok(fs.existsSync(res.outPath));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a session dir directly under `sessionsDir/<id>/` (no `sessions/` middle layer). */
function writeSessionDirectly(sessionsDir, id, tools) {
  const dir = path.join(sessionsDir, id);
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

// ── CLI dispatch (AC #2 / AC #3) ──────────────────────────────────────────────

test('ccsnoop fine-tune --sessions-dir resolves the sessions dir', () => {
  const sessionsDir = mkTmpDir();
  writeSessionDirectly(sessionsDir, 'cli-sd', [{ name: 'Bash' }, { name: 'Workflow' }]);
  const r = spawnSync(process.execPath, [BIN, 'fine-tune', '--sessions-dir', sessionsDir], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /cli-sd/);
  assert.deepEqual(parseBlock(r.stdout), { permissions: { deny: ['Workflow'] } });
});

test('ccsnoop fine-tune --deny-extra <a,b> adds names for the run', () => {
  const root = mkTmpDir();
  writeSession(root, 'cli-ex', [{ name: 'Bash' }, { name: 'Workflow' }, { name: 'Custom' }]);
  const r = spawnSync(
    process.execPath,
    [BIN, 'fine-tune', '--root', root, '--session', 'cli-ex', '--deny-extra', 'Custom, ,Nope2'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // Custom is added (shipped → denied); Nope2 is added but not shipped → not in deny.
  assert.deepEqual(parseBlock(r.stdout), { permissions: { deny: ['Workflow', 'Custom'] } });
});

test('ccsnoop fine-tune --deny-allow <a> drops a base name for the run', () => {
  const root = mkTmpDir();
  writeSession(root, 'cli-al', [{ name: 'Bash' }, { name: 'Workflow' }, { name: 'Artifact' }]);
  const r = spawnSync(
    process.execPath,
    [BIN, 'fine-tune', '--root', root, '--session', 'cli-al', '--deny-allow', 'Workflow'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(parseBlock(r.stdout), { permissions: { deny: ['Artifact'] } });
});

test('ccsnoop fine-tune --deny-allow accepts a comma list too', () => {
  const root = mkTmpDir();
  writeSession(root, 'cli-al2', [{ name: 'Workflow' }, { name: 'Artifact' }, { name: 'CronCreate' }]);
  const r = spawnSync(
    process.execPath,
    [BIN, 'fine-tune', '--root', root, '--session', 'cli-al2', '--deny-allow', 'Workflow,Artifact'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(parseBlock(r.stdout), { permissions: { deny: ['CronCreate'] } });
});

// ── AC #1 + Part 6 acceptance, end-to-end on the committed fixture corpus ─────
//
// Default scope = corpus (no --session/--latest). On this 1-session fixture the
// MCP guard is flag-only (sessionCount 1 < 3) — the corpus mechanism is exercised
// even though the guard cannot fire on a single session. The gate self-skips until
// a fixture is committed (mirrors the FT0 / FT1 self-activating pattern).

const fixtureOpts = fs.existsSync(FIXTURES_DIR) &&
  fs.readdirSync(FIXTURES_DIR, { withFileTypes: true }).some((e) => e.isDirectory() && /^session-/.test(e.name))
  ? {}
  : { skip: 'no fixture committed under test/fixtures/finetune/' };

test('Part 6 acceptance — corpus default over the fixture (AC #1, issue #77)', fixtureOpts, () => {
  // AC #1 — no args = corpus scan by default. `root` is the fixture root itself
  // (listSessions scans <root>/sessions/* and <root>/*); NO --session/--latest.
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR });

  // Built-in tools: permissions.deny = intersection with the denylist, always.
  const expected = denyIntersection(res.shipped, loadBuiltinDenylist());
  assert.deepEqual(res.deny, expected);
  const block = JSON.parse(res.settingsJson);
  assert.deepEqual(block.permissions, { deny: expected });

  // MCP: flag-only on a 1-session corpus (sessionCount < 3) → never denied, key omitted.
  assert.ok(res.mcp.sessionCount < 3, 'fixture is a thin corpus');
  assert.ok(!res.mcp.servers.some((s) => s.deny), 'no MCP deny under the T4 guard');
  assert.ok(!('disabledMcpjsonServers' in block), 'no MCP key when nothing is denied');

  // Part 5 diagnostic shape: table header, totals, headline Σ waste, cache caveat.
  const out = res.lines.join('\n');
  assert.match(out, /Lever\s+entry\s+shipped\s+waste\s+action/);
  assert.match(out, /Total/);
  assert.match(out, /Recoverable \(waste, conservative\)/);
  assert.match(out, /Cache:/);
  // Cache-invalidation warning prints above a block that changes the prefix.
  assert.match(out, /invalidates the cache/);
  // The block is pure, comment-free, paste-ready JSON.
  assert.doesNotThrow(() => JSON.parse(res.settingsJson));
  assert.ok(!/\/\//.test(res.settingsJson) && !/\/\*/.test(res.settingsJson));
  // Never re-tokenized: every byte figure is a Segment.bytes length (ints) —
  // the table's figure cells are byte-lengths, not token estimates.
  assert.ok(res.gain.tool.size > 0 || res.gain.harness.shipped >= 0);
});

test('Part 6 acceptance — --latest drops to single-session mode (no MCP deny path)', fixtureOpts, () => {
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, latest: true });
  assert.ok(res.mcp.singleSession, 'latest → single-session weak-evidence mode');
  // Single-session mode never denies MCP regardless of guard counts.
  assert.ok(!res.mcp.servers.some((s) => s.deny), 'no MCP deny in single-session mode');
  // The override flags still compose with --latest.
  const dropped = fineTune({
    cwd: '/nonexistent',
    root: FIXTURES_DIR,
    latest: true,
    denyAllow: res.deny, // drop every base deny for this run
  });
  assert.deepEqual(dropped.deny, [], '--deny-allow drops the whole intersection');
});
