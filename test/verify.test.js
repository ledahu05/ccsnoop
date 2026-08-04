// ccsnoop verify — before/after floor delta (issue #96, epic #94).
//
// `verify` closes the tuning loop the context-tuning skill (#94) drives: given two
// captured sessions (a before and an after — one tuning session), it computes the
// turn-1 floor on each via `computeFloor` (#99) and diffs them, proving whether the
// tuning lowered the floor and by how much. The headline delta is REAL turn-1 tokens
// (captured `usage`, never re-tokenized); every per-block figure is a labelled byte
// proxy. A pure offline reader of `sessions/`; the daemon is not required.
//
// `verify` is two `computeFloor` calls + a diff + a renderer, not new measurement.
// These tests assert: the pure delta (token + byte, exact known values from
// synthesized before/after models), the lowered/raised/flat verdict, the byte-basis
// fallback when one side has no usage, the versioned `tuning-session/v1` JSON
// contract (mirroring `test/finetune-json.test.js`), and CLI dispatch + error paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeVerify, renderVerify, verify, buildVerifyJson } from '../src/verify.js';
import { computeFloor } from '../src/floor.js';
import { SCHEMA_URL, SCHEMA_VERSION } from '../src/finetune-json.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

/**
 * Build an in-memory 1-exchange session model whose turn-1 floor is fully known. Same
 * system blocks as `test/floor.test.js`'s `synthModel` (a harness, a CLAUDE.md, a hook,
 * an MCP block) so every lever kind is attributed; the tool set + sizes + usage are
 * parameterized so a before/after pair can differ by an exact, known amount.
 *
 * Tool bytes come from `segments` (`tool:<name>`); the body's `tools[]` is kept in sync
 * for realism (the gain model attributes tools from segments, not from the body array).
 * @param {{ sessionId?: string, tools?: Record<string, number>, usage?: any }} [cfg]
 */
function synthModel({ sessionId = 'synth', tools = { Read: 4000, Write: 1500 }, usage } = {}) {
  const harnessTxt = 'system prompt identity' + 'H'.repeat(200); // harness (no lever marker)
  const claudeMdTxt = 'Contents of ./CLAUDE.md (project instructions)' + 'C'.repeat(300);
  const hookTxt = 'SessionStart:startup hook success: persona output' + 'K'.repeat(120);
  const mcpTxt = 'deferred tools: mcp__stub__t00 listing' + 'M'.repeat(60);

  const body = {
    model: 'claude-test',
    system: [
      { type: 'text', text: harnessTxt },
      { type: 'text', text: claudeMdTxt },
      { type: 'text', text: hookTxt },
      { type: 'text', text: mcpTxt },
    ],
    tools: Object.keys(tools).map((name) => ({ name })),
    messages: [{ role: 'user', content: 'hello' }],
  };
  const requestBlob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify(body)),
  });
  const segments = [
    { slot: 'system#0', bytes: 1, kind: 'reused-cached' },
    { slot: 'system#1', bytes: 1, kind: 'reused-cached' },
    { slot: 'system#2', bytes: 1, kind: 'reused-cached' },
    { slot: 'system#3', bytes: 1, kind: 'reused-cached' },
    ...Object.entries(tools).map(([name, bytes]) => ({ slot: `tool:${name}`, bytes, kind: 'reused-cached' })),
  ];
  return { sessionId, exchanges: [{ turn: 1, usage, requestBlob, segments }] };
}

/** A canonical before/after pair: the after floor is LOWER (fewer tokens, smaller Read). */
function loweredPair() {
  return {
    before: synthModel({
      sessionId: 'before',
      tools: { Read: 4000, Write: 1500 },
      usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0, outputTokens: 0 },
    }),
    after: synthModel({
      sessionId: 'after',
      tools: { Read: 1800, Write: 1500 },
      usage: { inputTokens: 800, cacheCreationInputTokens: 1600, cacheReadInputTokens: 0, outputTokens: 0 },
    }),
  };
}

// ── computeVerify: the pure delta (token + byte, exact known values) ───────────

test('computeVerify scores both sides via turn-1 isolation and exposes each floor', () => {
  const { before, after } = loweredPair();
  const v = computeVerify(before, after);
  assert.equal(v.before.headline.tokens, 3000, 'before turn-1 tokens');
  assert.equal(v.after.headline.tokens, 2400, 'after turn-1 tokens');
  // Each side IS a computeFloor result — verify delegates measurement, it does not redo it.
  assert.deepEqual(v.before, computeFloor(before));
  assert.deepEqual(v.after, computeFloor(after));
});

test('computeVerify token delta = after − before; relative = round(Δ / before * 100)', () => {
  const { before, after } = loweredPair();
  const v = computeVerify(before, after);
  assert.equal(v.delta.tokens.before, 3000);
  assert.equal(v.delta.tokens.after, 2400);
  assert.equal(v.delta.tokens.absolute, -600, 'absolute is after − before');
  assert.equal(v.delta.tokens.relative, -20, 'relative is % of the before floor');
  assert.match(v.delta.tokens.source, /never re-tokeniz/i, 'source labels the no-retokenize guardrail');
});

test('computeVerify byte delta is the byte-proxy total change (only the differing block moves)', () => {
  const { before, after } = loweredPair();
  const v = computeVerify(before, after);
  // Read shrank 4000 → 1800; every other block is identical, so the byte delta is −2200.
  assert.equal(v.delta.bytes.absolute, -2200);
  assert.equal(v.delta.bytes.before, v.before.totalBytes);
  assert.equal(v.delta.bytes.after, v.after.totalBytes);
  assert.equal(v.delta.bytes.relative, Math.round((-2200 / v.before.totalBytes) * 100));
  assert.match(v.delta.bytes.source, /proxy/i);
});

test('computeVerify verdict is lowered when the after floor is below the before', () => {
  const { before, after } = loweredPair();
  const v = computeVerify(before, after);
  assert.equal(v.delta.verdict, 'lowered');
  assert.equal(v.delta.basis, 'tokens', 'tokens drive the verdict when both sides captured usage');
});

test('computeVerify verdict is raised when the after floor is above the before', () => {
  const before = synthModel({ usage: { inputTokens: 800, cacheCreationInputTokens: 1600, cacheReadInputTokens: 0 } });
  const after = synthModel({ usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 } });
  assert.equal(computeVerify(before, after).delta.verdict, 'raised');
});

test('computeVerify verdict is flat when the two floors match', () => {
  const before = synthModel({ usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 } });
  const after = synthModel({ usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 } });
  const v = computeVerify(before, after);
  assert.equal(v.delta.verdict, 'flat');
  assert.equal(v.delta.tokens.absolute, 0);
  assert.equal(v.delta.tokens.relative, 0);
});

test('computeVerify falls back to the byte basis when one side has no captured usage', () => {
  const before = synthModel({
    sessionId: 'before',
    tools: { Read: 4000 },
    usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 },
  });
  const after = synthModel({ sessionId: 'after', tools: { Read: 1800 }, usage: null });
  const v = computeVerify(before, after);
  // No after usage ⇒ no token delta; the verdict falls back to the byte proxy.
  assert.equal(v.delta.tokens.before, 3000);
  assert.equal(v.delta.tokens.after, null, 'after tokens null without usage');
  assert.equal(v.delta.tokens.absolute, null);
  assert.equal(v.delta.tokens.relative, null);
  assert.equal(v.delta.basis, 'bytes');
  assert.equal(v.delta.verdict, 'lowered', 'byte delta (−2200) still drives a verdict');
  assert.equal(v.delta.bytes.absolute, -2200);
});

test('computeVerify: relative is null on a zero before baseline (no % of zero)', () => {
  // A real zero-token before floor (usage captured, all components 0) ≠ usage absent.
  const before = synthModel({
    tools: { Read: 0 },
    usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  });
  const after = synthModel({
    tools: { Read: 1000 },
    usage: { inputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  });
  const v = computeVerify(before, after);
  assert.equal(v.delta.tokens.before, 0);
  assert.equal(v.delta.tokens.absolute, 500, 'absolute still computes off a zero baseline');
  assert.equal(v.delta.tokens.relative, null, 'no meaningful % of zero');
  assert.equal(v.delta.verdict, 'raised');
});

test('computeVerify scores the window identically on both sides (apples-to-apples)', () => {
  const { before, after } = loweredPair();
  const v = computeVerify(before, after, { windowTokens: 6000 });
  assert.equal(v.windowTokens, 6000);
  assert.equal(v.before.windowTokens, 6000);
  assert.equal(v.after.windowTokens, 6000);
  // Each side's % of window uses the same denominator.
  assert.equal(v.before.headline.pctOfWindow, Math.round((3000 / 6000) * 100));
  assert.equal(v.after.headline.pctOfWindow, Math.round((2400 / 6000) * 100));
});

test('computeVerify falls back to the default window on an unusable override', () => {
  const { before, after } = loweredPair();
  for (const windowTokens of [0, -5, NaN, Infinity]) {
    const v = computeVerify(before, after, { windowTokens });
    assert.equal(v.windowTokens, 200000, `window for ${String(windowTokens)}`);
  }
});

// ── computeVerify: per-block byte deltas (grew / shrank / flat) ────────────────

test('computeVerify per-block deltas match contributors across the two floors', () => {
  const { before, after } = loweredPair();
  const blocks = computeVerify(before, after).delta.bytes.blocks;
  const byKey = new Map(blocks.map((b) => [b.label, b]));
  const read = byKey.get('Read');
  assert.deepEqual({ before: read.beforeBytes, after: read.afterBytes, delta: read.delta, direction: read.direction }, {
    before: 4000,
    after: 1800,
    delta: -2200,
    direction: 'shrank',
  });
  const write = byKey.get('Write');
  assert.equal(write.direction, 'flat', 'unchanged block is flat');
  assert.equal(write.delta, 0);
  // The non-tool levers are identical across the pair → flat.
  for (const label of ['system[] preamble', 'CLAUDE.md', 'SessionStart hook', 'MCP deferred listing']) {
    const b = blocks.find((x) => x.label === label);
    assert.ok(b, `${label} attributed`);
    assert.equal(b.direction, 'flat', `${label} unchanged`);
  }
});

test('computeVerify: a block grown from zero is "grew"; one shrunk to zero is "shrank"', () => {
  const before = synthModel({ tools: { Read: 4000, Write: 1500 } });
  const after = synthModel({ tools: { Read: 4000, Grep: 3000 } }); // drops Write, adds Grep
  const blocks = computeVerify(before, after).delta.bytes.blocks;
  const write = blocks.find((b) => b.label === 'Write');
  const grep = blocks.find((b) => b.label === 'Grep');
  assert.deepEqual({ delta: write.delta, direction: write.direction }, { delta: -1500, direction: 'shrank' });
  assert.deepEqual({ before: grep.beforeBytes, after: grep.afterBytes, delta: grep.delta, direction: grep.direction }, {
    before: 0,
    after: 3000,
    delta: 3000,
    direction: 'grew',
  });
});

test('computeVerify ranks per-block deltas by absolute change, descending', () => {
  const before = synthModel({ tools: { Read: 4000, Write: 1500 } });
  const after = synthModel({ tools: { Read: 1800, Write: 4500 } }); // Read −2200, Write +3000
  const mags = computeVerify(before, after).delta.bytes.blocks.map((b) => Math.abs(b.delta));
  assert.deepEqual(mags, [...mags].sort((a, b) => b - a), 'biggest movers first');
});

test('computeVerify is null-safe on two empty models (flat, no blocks)', () => {
  const v = computeVerify({ sessionId: 'a', exchanges: [] }, { sessionId: 'b', exchanges: [] });
  assert.equal(v.delta.tokens.before, null);
  assert.equal(v.delta.verdict, 'flat');
  assert.equal(v.delta.basis, 'bytes');
  assert.deepEqual(v.delta.bytes.blocks, []);
});

// ── renderVerify: text output ─────────────────────────────────────────────────

test('renderVerify prints both headlines, the signed delta, and a clear verdict', () => {
  const { before, after } = loweredPair();
  const out = renderVerify(computeVerify(before, after)).lines.join('\n');
  assert.match(out, /before/i);
  assert.match(out, /after/i);
  // Both real-token headlines appear.
  assert.match(out, /3[ ,]?000 tokens/);
  assert.match(out, /2[ ,]?400 tokens/);
  // The signed token delta + its % of the before floor.
  assert.match(out, /-600 tokens/);
  assert.match(out, /-20%/);
  // A clear lowered verdict naming the magnitude.
  assert.match(out, /FLOOR LOWERED/i);
  assert.match(out, /600 tokens/);
});

test('renderVerify prints a ranked per-block delta table with before/after/Δbytes', () => {
  const { before, after } = loweredPair();
  const out = renderVerify(computeVerify(before, after)).lines.join('\n');
  assert.match(out, /Per-block delta/i);
  assert.match(out, /Δbytes|delta/i);
  // Read's shrinkage appears as a labelled row; bytes are K-grouped by the shared proxy.
  assert.match(out, /Read/);
  assert.match(out, /shrank/i);
  assert.match(out, /\d+(\.\d)?K/);
});

test('renderVerify notes the byte-proxy basis when real tokens are unavailable', () => {
  const before = synthModel({ tools: { Read: 4000 }, usage: { inputTokens: 1 } });
  const after = synthModel({ tools: { Read: 1800 }, usage: null });
  const out = renderVerify(computeVerify(before, after)).lines.join('\n');
  assert.match(out, /unavailable/i);
  assert.match(out, /byte-proxy basis|byte proxy/i);
  // The verdict still renders off the byte delta.
  assert.match(out, /FLOOR LOWERED/i);
});

test('renderVerify: the per-block table rows share one column layout', () => {
  const { before, after } = loweredPair();
  const lines = renderVerify(computeVerify(before, after)).lines;
  const start = lines.findIndex((l) => /^\s+block\s+before/.test(l));
  assert.ok(start > -1, 'header row found');
  // The table is the contiguous non-blank run from the header through the total row;
  // a verdict summary follows it (unlike renderFloor, which ends at the table).
  const tableLines = [];
  for (const l of lines.slice(start)) {
    if (l === '') break;
    tableLines.push(l);
  }
  const widths = new Set(tableLines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `table rows differ in width: ${[...widths].join(', ')}`);
});

// ── buildVerifyJson: the versioned tuning-session/v1 contract ─────────────────

test('buildVerifyJson emits the versioned tuning-session envelope', () => {
  const { before, after } = loweredPair();
  const j = buildVerifyJson(computeVerify(before, after));
  assert.equal(j.$schema, SCHEMA_URL);
  assert.equal(j.schemaVersion, SCHEMA_VERSION);
  assert.equal(j.kind, 'tuning-session');
  assert.equal(typeof j.note, 'string');
  assert.ok(j.note.length > 0);
});

test('buildVerifyJson serializes the two session ids (durable pairing)', () => {
  const { before, after } = loweredPair();
  const j = buildVerifyJson(computeVerify(before, after));
  assert.equal(j.session.before, 'before');
  assert.equal(j.session.after, 'after');
  assert.equal(j.before.id, 'before');
  assert.equal(j.after.id, 'after');
});

test('buildVerifyJson: before/after carry the floor headline + attribution; delta has tokens/bytes/verdict', () => {
  const { before, after } = loweredPair();
  const j = buildVerifyJson(computeVerify(before, after));
  for (const side of ['before', 'after']) {
    assert.ok('headline' in j[side], `${side} headline`);
    assert.ok('attribution' in j[side], `${side} attribution`);
    assert.ok(Array.isArray(j[side].attribution));
  }
  assert.equal(j.before.headline.tokens, 3000);
  assert.equal(j.after.headline.tokens, 2400);
  assert.equal(j.delta.tokens.absolute, -600);
  assert.equal(j.delta.bytes.absolute, -2200);
  assert.equal(j.delta.verdict, 'lowered');
  assert.equal(j.delta.basis, 'tokens');
  assert.ok(Array.isArray(j.delta.bytes.blocks), 'per-block byte delta in the contract');
});

test('buildVerifyJson labels every per-block figure a byte proxy and never re-tokenizes', () => {
  const { before, after } = loweredPair();
  const j = buildVerifyJson(computeVerify(before, after));
  // The contract note + the byte source both state the byte-proxy / no-retokenize guardrail.
  assert.match(j.note, /byte-length proxy/i);
  assert.match(j.note, /never re-tokeniz/i);
  assert.match(j.delta.tokens.source, /never re-tokeniz/i);
  assert.match(j.delta.bytes.source, /proxy/i);
});

// ── verify() end-to-end + CLI dispatch ────────────────────────────────────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-verify-'));
}

/** A one-turn session dir with a known tools[] + a usage-bearing response. */
function writeSession(dir, id, tools, usage) {
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
    `data: {"type":"message_start","message":{"usage":${JSON.stringify(usage)}}}\n\n`
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

test('verify() resolves two sessions and reports the before/after delta', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'before'), 'before', [{ name: 'Bash' }], {
    input_tokens: 5000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  writeSession(path.join(root, 'sessions', 'after'), 'after', [{ name: 'Bash' }], {
    input_tokens: 3000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  const res = verify({ cwd: '/nonexistent', root, before: 'before', after: 'after' });
  assert.equal(res.before.sessionId, 'before');
  assert.equal(res.after.sessionId, 'after');
  assert.equal(res.delta.tokens.absolute, -2000);
  assert.equal(res.delta.verdict, 'lowered');
  assert.ok(res.lines.length > 0, 'text lines rendered');
  assert.equal(res.json.kind, 'tuning-session', 'json contract attached');
});

test('verify() throws naming the available ids when --before / --after is missing', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'only'), 'only', [{ name: 'Bash' }], { input_tokens: 1 });
  assert.throws(
    () => verify({ cwd: '/nonexistent', root, before: 'only' }),
    /needs --before.+--after.+have: only/
  );
});

test('verify() throws on no captured sessions (mirrors floor / report / fine-tune)', () => {
  const root = mkTmpDir();
  assert.throws(() => verify({ cwd: '/nonexistent', root, before: 'a', after: 'b' }), /no captured sessions found/);
});

test('verify() throws naming the missing side when a session id does not match', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'real'), 'real', [{ name: 'Bash' }], { input_tokens: 1 });
  assert.throws(
    () => verify({ cwd: '/nonexistent', root, before: 'real', after: 'typo' }),
    /after session 'typo' not found \(have: real\)/
  );
});

test('ccsnoop verify --before --after prints the verdict + delta (exit 0)', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'before'), 'before', [{ name: 'Bash' }], { input_tokens: 5000, output_tokens: 1 });
  writeSession(path.join(sessionsDir, 'after'), 'after', [{ name: 'Bash' }], { input_tokens: 3000, output_tokens: 1 });
  const r = spawnSync(
    process.execPath,
    [BIN, 'verify', '--sessions-dir', sessionsDir, '--before', 'before', '--after', 'after'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /FLOOR LOWERED/i);
  assert.match(r.stdout, /2[ ,]?000 tokens/);
});

test('ccsnoop verify --json exits 0 and emits the tuning-session contract (smoke, AC)', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'before'), 'before', [{ name: 'Bash' }, { name: 'Workflow' }], {
    input_tokens: 5000,
    output_tokens: 1,
  });
  writeSession(path.join(sessionsDir, 'after'), 'after', [{ name: 'Bash' }], { input_tokens: 3000, output_tokens: 1 });
  const r = spawnSync(
    process.execPath,
    [BIN, 'verify', '--sessions-dir', sessionsDir, '--before', 'before', '--after', 'after', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  for (const key of ['$schema', 'schemaVersion', 'kind', 'session', 'before', 'after', 'delta']) {
    assert.ok(key in parsed, `required field ${key} present`);
  }
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.kind, 'tuning-session');
  assert.deepEqual(parsed.session, { before: 'before', after: 'after' });
  assert.equal(parsed.delta.verdict, 'lowered');
  assert.equal(parsed.delta.tokens.absolute, -2000);
});

test('default (no --json) output is the human text table, unchanged', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'before'), 'before', [{ name: 'Bash' }], { input_tokens: 5000, output_tokens: 1 });
  writeSession(path.join(sessionsDir, 'after'), 'after', [{ name: 'Bash' }], { input_tokens: 3000, output_tokens: 1 });
  const r = spawnSync(
    process.execPath,
    [BIN, 'verify', '--sessions-dir', sessionsDir, '--before', 'before', '--after', 'after'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /ccsnoop verify/i);
  assert.throws(() => JSON.parse(r.stdout), 'no --json ⇒ not a JSON document');
});

test('ccsnoop verify rejects an unusable --window', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'before'), 'before', [{ name: 'Bash' }], { input_tokens: 100 });
  writeSession(path.join(sessionsDir, 'after'), 'after', [{ name: 'Bash' }], { input_tokens: 100 });
  for (const bad of ['abc', '0', '-1', '']) {
    const r = spawnSync(
      process.execPath,
      [BIN, 'verify', '--sessions-dir', sessionsDir, '--before', 'before', '--after', 'after', '--window', bad],
      { encoding: 'utf8' }
    );
    assert.notEqual(r.status, 0, `--window '${bad}' should fail`);
    assert.match(r.stderr, /--window expects a positive number of tokens/);
  }
});

test('ccsnoop verify exits 1 naming the available ids when --after is missing', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'before'), 'before', [{ name: 'Bash' }], { input_tokens: 100 });
  const r = spawnSync(
    process.execPath,
    [BIN, 'verify', '--sessions-dir', sessionsDir, '--before', 'before'],
    { encoding: 'utf8' }
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /have: before/);
});
