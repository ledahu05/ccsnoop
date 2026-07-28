// FT0 (issue #70) — the fine-tune fixture integrity gate.
//
// A committed REAL captured Claude Code session under
// `test/fixtures/finetune/session-<id>/` is the substrate every downstream
// fine-tune ticket (T1–T7, fine-tune-spec.md) tests against. Without it the
// attribution heuristics and response parsing can't be trusted against real CC,
// so this gate turns FT0's acceptance criteria into executable checks: a freshly
// committed fixture is validated automatically against AC #1–#4.
//
// RGR posture — this is the RED step. While NO fixture is committed the suite
// SELF-SKIPS (so `npm test` stays green). That is today's state: the canonical
// capture path — claude.ai OAuth → api.anthropic.com via the bench
// (bench/SPEC.md §0, fatal `copyCredentials` step 10) — is not executable in
// every agent sandbox (no `~/.claude/.credentials.json`, subscription auth not
// active), and AC #5 forbids synthesizing a fake capture. The moment a real
// fixture lands, the gate ACTIVATES and enforces AC #1–#4. See the escalation
// comment on issue #70.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseRequestBlob } from '../src/report.js';
import { DENY, REDACTED } from '../src/capture.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

// Bench-written lever markers — the on-wire proof of each lever. The fixture is
// generated THROUGH the bench per issue #70's updated plan, so the bench's own
// sentinels (bench/fixture/hook-persona.txt, bench/fixture/CLAUDE.md) and the
// L4 MCP stub tool name are the evidence; scripts/bench/run.mjs asserts these
// same markers in its lever guards.
//
// The stub declares bare names (`t00`…`t63`) but the wire carries
// `mcp__<server>__<tool>` — pinned by the first paying run, and the reason the
// previous `/\bt00\b/` marker could never match a real capture (`_` is a word
// char, so the word boundary never lands before `t00` in `mcp__stub__t00`).
const PERSONA_RE = /CCSNOOP-BENCH-SENTINEL-PERSONA-[0-9a-f]+/;
const CLAUDEMD_RE = /CCSNOOP-BENCH-SENTINEL-CLAUDEMD-[0-9a-f]+/;
const MCP_STUB_TOOL_RE = /mcp__[a-z0-9_-]+__t\d\d\b/i;

// bench-run-local roots that must not leak into a committed fixture's manifest.
const LOCAL_PATH_RE = /\/tmp\/|\/home\/|ccsnoop-bench/i;

/** Session fixture dirs under FIXTURES_DIR (`session-*`), sorted. Missing root → []. */
function sessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => path.join(FIXTURES_DIR, e.name))
    .sort();
}

/** Decode a captured `.response.sse` blob to UTF-8 — gunzip on the `1f 8b` magic
 *  (Anthropic serves SSE gzip-compressed), plain bytes otherwise. */
function decodeResponse(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf).toString('utf8');
    } catch {
      return buf.toString('utf8'); // truncated gzip — reads as best-effort text
    }
  }
  return buf.toString('utf8');
}

/** Parsed `data:` JSON payloads from an SSE text stream; malformed lines skipped. */
function sseEvents(text) {
  /** @type {any[]} */
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // partial / unterminated event line — ignore
    }
  }
  return out;
}

/** True iff a decoded SSE stream carries a `tool_use` content block (AC #3). */
function hasToolUse(text) {
  for (const ev of sseEvents(text)) {
    const block = ev?.content_block ?? ev?.delta;
    if (block && block.type === 'tool_use') return true;
    if (Array.isArray(ev?.message?.content)) {
      for (const c of ev.message.content) {
        if (c?.type === 'tool_use') return true;
      }
    }
  }
  return false;
}

/** Parse a session's `manifest.jsonl` into its exchange lines (AC #1). */
function readManifest(dir, id) {
  const manifestPath = path.join(dir, 'manifest.jsonl');
  assert.ok(fs.existsSync(manifestPath), `${id}: AC#1 manifest.jsonl missing`);
  const lines = fs
    .readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.ok(lines.length > 0, `${id}: AC#1 manifest.jsonl has no exchanges`);
  return lines;
}

// ── the gate ────────────────────────────────────────────────────────────────

const dirs = sessionDirs();
const testOpts = dirs.length === 0
  ? {
      skip:
        'no fixture committed under test/fixtures/finetune/ — issue #70 blocked in this sandbox ' +
        '(no claude.ai OAuth / api.anthropic.com access; AC #5 forbids a synthetic capture)',
    }
  : {};

test('FT0 fine-tune fixture integrity — AC #1–#4 (issue #70)', testOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const lines = readManifest(dir, id);

    // AC #1 — structure: every manifest line names a present .request.http + .response.sse.
    for (const line of lines) {
      assert.ok(line.request_blob, `${id}: manifest line missing request_blob`);
      assert.ok(line.response_blob, `${id}: manifest line missing response_blob`);
      assert.ok(
        fs.existsSync(path.join(dir, line.request_blob)),
        `${id}: AC#1 ${line.request_blob} missing`,
      );
      assert.ok(
        fs.existsSync(path.join(dir, line.response_blob)),
        `${id}: AC#1 ${line.response_blob} missing`,
      );
    }

    // Union the lever evidence across every turn.
    let toolsNonEmpty = false;
    let persona = false;
    let claudemd = false;
    let mcpDeferred = false;
    let toolUse = false;
    /** @type {string[]} */
    const scrubFailures = [];

    for (const line of lines) {
      // AC #4 (scrub) — every secret-header denylist value must be redacted.
      const req = parseRequestBlob(fs.readFileSync(path.join(dir, line.request_blob)));
      for (const h of req.headers) {
        if (DENY.test(h.name) && h.value !== REDACTED) {
          scrubFailures.push(`${id}/${line.request_blob}: header '${h.name}' not redacted`);
        }
      }

      // AC #2 — the four levers.
      if (Array.isArray(req.json?.tools) && req.json.tools.length > 0) toolsNonEmpty = true;
      if (PERSONA_RE.test(req.text)) persona = true;
      if (CLAUDEMD_RE.test(req.text)) claudemd = true;
      if (MCP_STUB_TOOL_RE.test(req.text)) mcpDeferred = true;

      // AC #3 — at least one response carries a tool_use content_block.
      if (hasToolUse(decodeResponse(fs.readFileSync(path.join(dir, line.response_blob))))) {
        toolUse = true;
      }
    }

    // AC #4 (scrub) — no bench-run-local paths leaked into the manifest.
    const manifestText = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8');
    if (LOCAL_PATH_RE.test(manifestText)) {
      scrubFailures.push(`${id}: AC#4 local path present in manifest.jsonl`);
    }

    assert.ok(toolsNonEmpty, `${id}: AC#2 no built-in tools[] found`);
    assert.ok(persona, `${id}: AC#2 no SessionStart-hook persona block found`);
    assert.ok(claudemd, `${id}: AC#2 no CLAUDE.md-derived system content found`);
    assert.ok(mcpDeferred, `${id}: AC#2 no MCP deferred listing found`);
    assert.ok(toolUse, `${id}: AC#3 no tool_use content_block in any response`);
    assert.deepEqual(scrubFailures, [], `${id}: AC#4 scrub failures`);
  }
});
