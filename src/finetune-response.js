// Fine-tune: decode the responses to a called-tool set (fine-tune-spec §2.2, issue #72 / FT2).
//
// `src/waste.js` reads REQUESTS only — what was *shipped*. The other half of
// sent-vs-used lives in the RESPONSES: a tool counts as **called** iff its name
// appears as the `name` of a `tool_use` content block (T2, issue #31). Anthropic
// serves those responses as an SSE stream with `content-encoding: gzip`, so the
// captured `.response.sse` blob is raw gzip bytes (issue #53) — read as-is it
// carries no events at all.
//
// This module is the missing substrate: session dir → the set of tool names that
// session actually called. Later levers consume it — the MCP guard (T4:
// `sessionCount>=3 AND calledCount==0`) and any future unused detection. It emits
// no diagnostic and no settings block; that is T5/T6.
//
// Non-negotiables:
//   • NEVER re-tokenize (spec §1.4). This reads SSE bytes only; it never touches
//     `usage`, and a stream with no `usage` at all still yields its called tools.
//   • One decoder. The gzip/SSE split is `report.js`'s `decodeResponseBlob` +
//     `parseSseEvents` — the same code path `readUsage` uses, not a second copy.
//   • Degrade, never throw, on a corrupt/truncated/absent blob: a capture cut
//     mid-stream must not take the whole diagnostic down. The only hard error is
//     a session dir with no `manifest.jsonl` (that is a caller mistake).

import fs from 'node:fs';
import path from 'node:path';

import { decodeResponseBlob, parseSseEvents } from './report.js';

/**
 * @typedef {object} TurnCalls
 * @property {number | null} turn   Turn number from the manifest line, when present.
 * @property {string | null} blob   The `.response.sse` filename, when the manifest names one.
 * @property {string[]} names       Tool names called in this turn, in emission order (repeats kept).
 * @property {boolean} decoded      False when the response blob was absent or unreadable.
 */

/**
 * @typedef {object} CalledTools
 * @property {string} sessionId               Session id (defaults to the dir basename).
 * @property {Set<string>} names              Distinct tool names called anywhere in the session.
 * @property {Map<string, number>} counts     Name → number of `tool_use` blocks across the session.
 * @property {TurnCalls[]} perTurn            One entry per manifest line, in capture order.
 * @property {number} responses               Response blobs successfully read.
 * @property {number} missing                 Manifest lines whose response blob was absent/unreadable.
 */

/**
 * The tool names one captured response called, in emission order. Duplicates are
 * KEPT — a turn calling `Read` twice yields `['Read','Read']` so the caller can
 * count calls, not just distinct names; {@link calledToolSet} derives the set.
 *
 * Handles both response shapes ccsnoop captures: the streamed SSE (a `tool_use`
 * arrives as the `content_block` of a `content_block_start`) and a non-streaming
 * JSON body (`content[]` carries the finished blocks). Anything unparseable —
 * empty, non-JSON, truncated gzip — reads as `[]`.
 *
 * Only the literal `tool_use` type counts. Server-side variants
 * (`server_tool_use`, `mcp_tool_use`) are executed API-side and are not tools
 * the user ships in `tools[]`, so denying them would be meaningless: including
 * them would let a server-side call mark a shipped tool as used.
 *
 * @param {Buffer | string} buf  Raw `.response.sse` bytes (gzip or plain), or text.
 * @returns {string[]}
 */
export function toolUseNames(buf) {
  const text = decodeResponseBlob(buf);
  if (text.trim().length === 0) return [];

  /** @type {string[]} */
  const names = [];

  // Streamed path — one `content_block_start` per block; `tool_use` carries the
  // name up front (the `input_json_delta`s that follow are the arguments).
  const events = parseSseEvents(text);
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    pushIfToolUse(names, e.content_block);
    // A `message_start` may already carry finished blocks (replayed/short turns).
    if (e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) pushIfToolUse(names, block);
    }
  }
  if (events.length > 0) return names;

  // Non-streaming path — a single JSON body with the assembled `content[]`.
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.content)) {
      for (const block of parsed.content) pushIfToolUse(names, block);
    }
  } catch {
    // Not SSE and not JSON — no called-tool signal in this blob.
  }
  return names;
}

/**
 * Append a content block's tool name when it is a named `tool_use`. An unnamed
 * `tool_use` (malformed/partial event) is skipped rather than emitted blank — a
 * blank name would later read as a shipped tool that matched nothing.
 *
 * @param {string[]} names
 * @param {any} block
 */
function pushIfToolUse(names, block) {
  if (!block || typeof block !== 'object') return;
  if (block.type !== 'tool_use') return;
  if (typeof block.name !== 'string' || block.name.length === 0) return;
  names.push(block.name);
}

/**
 * The called-tool set of ONE captured session (AC #1). Walks `manifest.jsonl` in
 * capture order, decodes each `.response.sse`, and folds every `tool_use` name
 * into a session-level set + per-name call counts, keeping the per-turn
 * breakdown so a turn with no `tool_use` stays visible rather than vanishing.
 *
 * Session-scoped by design: corpus aggregation and the `sessionCount>=3 AND
 * calledCount==0` guard are T4 (issue #74), which consumes one of these per
 * session. Responses are read straight from disk — `loadSession` (report.js)
 * keeps only the derived `usage`, not the response bytes.
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @returns {CalledTools}
 */
export function calledToolSet(dir, id) {
  const manifestPath = path.join(dir, 'manifest.jsonl');
  /** @type {Array<Record<string, any>>} */
  let lines;
  try {
    lines = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch (err) {
    throw new Error(`could not read manifest.jsonl in ${dir}: ${/** @type {Error} */ (err)?.message ?? err}`);
  }

  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {TurnCalls[]} */
  const perTurn = [];
  let responses = 0;
  let missing = 0;

  for (const line of lines) {
    const blob = typeof line.response_blob === 'string' ? line.response_blob : null;
    /** @type {Buffer | null} */
    let buf = null;
    if (blob) {
      try {
        buf = fs.readFileSync(path.join(dir, blob));
      } catch {
        // Aborted exchange — the manifest line exists, the blob never landed.
        buf = null;
      }
    }
    const called = buf === null ? [] : toolUseNames(buf);
    if (buf === null) missing += 1;
    else responses += 1;
    for (const name of called) {
      names.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    perTurn.push({
      turn: typeof line.turn === 'number' ? line.turn : null,
      blob,
      names: called,
      decoded: buf !== null,
    });
  }

  return { sessionId: id ?? path.basename(dir), names, counts, perTurn, responses, missing };
}
