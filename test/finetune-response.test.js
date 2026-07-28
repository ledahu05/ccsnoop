// FT2 (issue #72) — response decoding to the called-tool set.
//
// waste.js reads REQUESTS only (what was shipped). The *actually-used* half of
// sent-vs-used lives in the RESPONSES: a tool counts as called iff its name
// appears as the `name` of a `tool_use` content block (fine-tune-spec §2.2).
// `src/finetune-response.js` decodes a session's gzip `.response.sse` blobs and
// returns that per-session called-tool set, the substrate the MCP guard (T4) and
// any future unused detection consume.
//
// Two layers of coverage, mirroring FT3:
//   • deterministic unit tests over synthetic SSE — they carry the contract
//     (gzip, multi-turn, no-tool_use turns, malformed events, missing blobs);
//   • a fixture gate over the committed FT0 capture (AC #2–#3) — it self-skips
//     while no `session-*` fixture is committed, and today it is ACTIVE: the
//     FT0 fixture has 6 turns, turns 1–5 each carrying a `tool_use`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { toolUseNames, calledToolSet } from '../src/finetune-response.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ft2-'));
}

/** One SSE `event:`/`data:` pair, the way Anthropic frames the stream. */
function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A streamed assistant turn calling `names` in order, framed like a real response. */
function turnCalling(names, { text = 'ok' } = {}) {
  let out = sse('message_start', { message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 1 } } });
  out += sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  out += sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  out += sse('content_block_stop', { index: 0 });
  names.forEach((name, i) => {
    out += sse('content_block_start', { index: i + 1, content_block: { type: 'tool_use', id: `toolu_${i}`, name, input: {} } });
    out += sse('content_block_delta', { index: i + 1, delta: { type: 'input_json_delta', partial_json: '{}' } });
    out += sse('content_block_stop', { index: i + 1 });
  });
  out += sse('message_delta', { delta: { stop_reason: names.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } });
  out += sse('message_stop', {});
  return out;
}

// ── toolUseNames: one response blob → the names it called ─────────────────────

test('toolUseNames gunzips a gzip-encoded SSE blob and reads its tool_use names', () => {
  // Anthropic serves the SSE stream `content-encoding: gzip`, so the captured
  // blob on disk is raw gzip bytes (issue #53): read as-is it yields nothing.
  const gz = zlib.gzipSync(Buffer.from(turnCalling(['Read', 'Bash']), 'utf8'));
  assert.equal(gz[0], 0x1f, 'fixture precondition: blob is gzip');
  assert.deepEqual(toolUseNames(gz), ['Read', 'Bash']);
});

test('toolUseNames reads a plain (uncompressed) SSE blob and a string', () => {
  const text = turnCalling(['Grep']);
  assert.deepEqual(toolUseNames(Buffer.from(text, 'utf8')), ['Grep']);
  assert.deepEqual(toolUseNames(text), ['Grep']);
});

test('toolUseNames returns [] for a turn with no tool_use (text-only answer)', () => {
  assert.deepEqual(toolUseNames(turnCalling([])), []);
});

test('toolUseNames keeps every occurrence in emission order (repeats included)', () => {
  // The set is derived downstream; per-blob the caller needs call counts, so a
  // tool called twice in one turn must appear twice.
  assert.deepEqual(toolUseNames(turnCalling(['Read', 'Read', 'Bash'])), ['Read', 'Read', 'Bash']);
});

test('toolUseNames reads a non-streaming JSON response body', () => {
  const body = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__stub__t00', input: {} },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.deepEqual(toolUseNames(body), ['mcp__stub__t00']);
});

test('toolUseNames ignores non-tool_use blocks (thinking, text, server-side deltas)', () => {
  let s = sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
  s += sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Read the file' } });
  s += sse('content_block_start', { index: 1, content_block: { type: 'text', text: 'Bash' } });
  assert.deepEqual(toolUseNames(s), []);
});

test('toolUseNames degrades to [] on empty, malformed and truncated-gzip blobs', () => {
  assert.deepEqual(toolUseNames(Buffer.alloc(0)), []);
  assert.deepEqual(toolUseNames(''), []);
  assert.deepEqual(toolUseNames('data: {not json\n\n'), []);
  // `1f 8b` magic then garbage — inflation throws; must not propagate.
  const truncated = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from('garbage')]);
  assert.deepEqual(toolUseNames(truncated), []);
});

test('toolUseNames skips an unnamed tool_use block rather than emitting a blank name', () => {
  const s = sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_x', input: {} } });
  assert.deepEqual(toolUseNames(s), []);
});

test('toolUseNames needs no usage — it reads SSE bytes only, never token accounting', () => {
  // AC #4 (never re-tokenizes): a stream stripped of every `usage` field still
  // yields its called tools, so the signal cannot be coupled to token figures.
  const s = sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'Edit' } });
  assert.ok(!s.includes('usage'), 'precondition: no usage in the stream');
  assert.deepEqual(toolUseNames(s), ['Edit']);
});

// ── calledToolSet: a session dir → its called-tool set ────────────────────────

/** Write a captured session dir with one response blob per turn (gzip, as captured). */
function writeSession(root, id, turns) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = turns.map((names, i) => {
    const n = String(i + 1).padStart(4, '0');
    fs.writeFileSync(path.join(dir, `${n}.request.http`), 'POST /v1/messages HTTP/1.1\r\n\r\n{}');
    if (names !== null) {
      fs.writeFileSync(path.join(dir, `${n}.response.sse`), zlib.gzipSync(Buffer.from(turnCalling(names), 'utf8')));
    }
    return JSON.stringify({
      turn: i + 1,
      thread_id: id,
      request_blob: `${n}.request.http`,
      response_blob: `${n}.response.sse`,
    });
  });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('calledToolSet unions the tool_use names across a multi-turn session', () => {
  const root = mkTmpDir();
  const dir = writeSession(root, 'sess-a', [['Read'], ['Bash', 'Read'], [], ['Grep']]);
  const called = calledToolSet(dir, 'sess-a');

  assert.equal(called.sessionId, 'sess-a');
  assert.deepEqual([...called.names].sort(), ['Bash', 'Grep', 'Read']);
  assert.equal(called.responses, 4, 'every response blob decoded');
  assert.equal(called.missing, 0);
});

test('calledToolSet counts every call, not every distinct name', () => {
  const root = mkTmpDir();
  const dir = writeSession(root, 'sess-b', [['Read', 'Read'], ['Read'], ['Bash']]);
  const called = calledToolSet(dir, 'sess-b');
  assert.equal(called.counts.get('Read'), 3);
  assert.equal(called.counts.get('Bash'), 1);
  assert.equal(called.counts.get('Edit'), undefined, 'a never-called tool has no entry');
});

test('calledToolSet reports per-turn detail, including turns with no tool_use', () => {
  const root = mkTmpDir();
  const dir = writeSession(root, 'sess-c', [['Read'], [], ['Bash']]);
  const called = calledToolSet(dir, 'sess-c');
  assert.deepEqual(
    called.perTurn.map((t) => [t.turn, t.names]),
    [
      [1, ['Read']],
      [2, []],
      [3, ['Bash']],
    ],
  );
});

test('calledToolSet defaults the session id to the directory basename', () => {
  const root = mkTmpDir();
  const dir = writeSession(root, 'sess-d', [['Read']]);
  assert.equal(calledToolSet(dir).sessionId, 'sess-d');
});

test('calledToolSet survives a missing response blob (aborted exchange)', () => {
  const root = mkTmpDir();
  // `null` = manifest line present, response blob never written.
  const dir = writeSession(root, 'sess-e', [['Read'], null]);
  const called = calledToolSet(dir, 'sess-e');
  assert.deepEqual([...called.names], ['Read']);
  assert.equal(called.responses, 1);
  assert.equal(called.missing, 1);
  assert.deepEqual(called.perTurn[1].names, [], 'the unreadable turn contributes nothing');
});

test('calledToolSet returns an empty set for a session that never called a tool', () => {
  const root = mkTmpDir();
  const dir = writeSession(root, 'sess-f', [[], []]);
  const called = calledToolSet(dir, 'sess-f');
  assert.equal(called.names.size, 0);
  assert.equal(called.counts.size, 0);
  assert.equal(called.responses, 2);
});

test('calledToolSet throws a named error when the session dir has no manifest', () => {
  const root = mkTmpDir();
  assert.throws(() => calledToolSet(path.join(root, 'nope')), /manifest\.jsonl/);
});

// ── AC #2–#3 — fixture gate over the committed FT0 capture ────────────────────
//
// Self-activating, like FT0's own gate: while no `session-*` fixture is committed
// this SKIPS. Today the FT0 fixture IS committed (6 turns, turns 1–5 each with a
// `tool_use`, turn 6 with none), so the gate is active and pins the called set
// against real captured Claude Code traffic.

/** Session fixture dirs under FIXTURES_DIR (`session-*`), sorted. Missing root → []. */
function sessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => path.join(FIXTURES_DIR, e.name))
    .sort();
}

const dirs = sessionDirs();
const gateOpts = dirs.length === 0
  ? { skip: 'no fixture committed under test/fixtures/finetune/ — FT2 (issue #72) confirms against the real FT0 capture the instant it lands' }
  : {};

test('FT2 called-tool set against the FT0 fixture — AC #2–#3 (issue #72)', gateOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const called = calledToolSet(dir);

    // AC #2 — the set matches the names actually present in the captured responses.
    // Re-derive the expectation from the blobs by an INDEPENDENT path (raw regex
    // over the decoded bytes) so the assertion is not the implementation restated.
    /** @type {Set<string>} */
    const expected = new Set();
    for (const line of manifestLines(dir)) {
      const blob = path.join(dir, line.response_blob);
      if (!fs.existsSync(blob)) continue;
      const text = decodeForTest(fs.readFileSync(blob));
      for (const m of text.matchAll(/"type"\s*:\s*"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/g)) {
        expected.add(m[1]);
      }
    }
    assert.ok(expected.size > 0, `${id}: fixture precondition — no tool_use found in any response`);
    assert.deepEqual([...called.names].sort(), [...expected].sort(), `${id}: AC#2 called set mismatch`);

    // AC #3 — multi-turn, and at least one turn with no tool_use is handled
    // (turn 6 of the committed fixture) without disturbing the union.
    assert.ok(called.perTurn.length > 1, `${id}: AC#3 expects a multi-turn fixture`);
    const quiet = called.perTurn.filter((t) => t.names.length === 0);
    assert.ok(quiet.length > 0, `${id}: AC#3 expects at least one turn with no tool_use`);
    assert.equal(called.missing, 0, `${id}: every fixture turn has a readable response blob`);
  }
});

/** Parsed `manifest.jsonl` lines for a fixture dir. */
function manifestLines(dir) {
  return fs
    .readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Test-local decode (gunzip on the `1f 8b` magic) — deliberately independent of src. */
function decodeForTest(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    ? zlib.gunzipSync(buf).toString('utf8')
    : buf.toString('utf8');
}
