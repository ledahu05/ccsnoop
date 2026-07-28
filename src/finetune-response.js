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
//   • Degrade, never throw, on a corrupt/truncated/absent blob OR a half-written
//     manifest line: a capture cut mid-stream must not take the whole diagnostic
//     down — such a turn is counted as `missing`, and the turns around it still
//     report. The only hard error is a session dir with no readable
//     `manifest.jsonl` at all (that is a caller mistake).

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
 * @property {number} missing                 Turns that yielded no readable response — blob absent
 *                                            or unreadable, or the manifest line itself unparseable.
 *                                            `responses + missing === perTurn.length` always.
 */

/**
 * The tool names one captured response called, in emission order. Duplicates are
 * KEPT — a turn calling `Read` twice (two `tool_use` blocks) yields
 * `['Read','Read']` so the caller can count calls, not just distinct names;
 * {@link calledToolSet} derives the set. One block reported twice by the stream is
 * still one call — see {@link pushIfToolUse}.
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
  /** @type {Set<string>} */
  const seenIds = new Set();

  // Streamed path — one `content_block_start` per block; `tool_use` carries the
  // name up front (the `input_json_delta`s that follow are the arguments).
  const events = parseSseEvents(text);
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    pushIfToolUse(names, seenIds, e.content_block);
    // A `message_start` may already carry finished blocks (replayed/short turns).
    if (e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) pushIfToolUse(names, seenIds, block);
    }
  }
  if (events.length > 0) return names;

  // Non-streaming path — a single JSON body with the assembled `content[]`.
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.content)) {
      for (const block of parsed.content) pushIfToolUse(names, seenIds, block);
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
 * One block can surface TWICE in a single stream — inlined in `message_start`'s
 * `content[]` and again as a `content_block_start` — which would inflate the call
 * counts {@link calledToolSet} reports. Count each block id once; genuine repeat
 * calls carry distinct ids, so `Read` twice in a turn still counts twice. A block
 * with no id cannot be deduped and is counted as seen.
 *
 * @param {string[]} names       Names collected so far, in emission order.
 * @param {Set<string>} seenIds  Block ids already counted for this blob.
 * @param {any} block
 */
function pushIfToolUse(names, seenIds, block) {
  if (!block || typeof block !== 'object') return;
  if (block.type !== 'tool_use') return;
  if (typeof block.name !== 'string' || block.name.length === 0) return;
  if (typeof block.id === 'string' && block.id.length > 0) {
    if (seenIds.has(block.id)) return;
    seenIds.add(block.id);
  }
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
  /** @type {string} */
  let manifest;
  try {
    manifest = fs.readFileSync(manifestPath, 'utf8');
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

  for (const rawLine of manifest.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    const turn = readTurn(dir, rawLine);
    perTurn.push(turn);
    if (turn.decoded) responses += 1;
    else missing += 1;
    for (const name of turn.names) {
      names.add(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return { sessionId: id ?? path.basename(dir), names, counts, perTurn, responses, missing };
}

/**
 * One manifest line → the tools that turn called. Every way a turn can fail to
 * yield names degrades to the same `decoded: false` record rather than throwing:
 * a line `manifest.jsonl` was cut off mid-append, a line naming no response blob,
 * and a blob that never landed (aborted exchange) all mean "this turn is
 * unreadable", which is what {@link CalledTools}.missing counts. Dropping a whole
 * session because its last line is half-written would hand T4's MCP guard a
 * falsely-empty called set — i.e. deny tools that were in fact used.
 *
 * @param {string} dir      The session directory.
 * @param {string} rawLine  One raw `manifest.jsonl` line (non-blank).
 * @returns {TurnCalls}
 */
function readTurn(dir, rawLine) {
  /** @type {TurnCalls} */
  const unreadable = { turn: null, blob: null, names: [], decoded: false };
  /** @type {any} */
  let line;
  try {
    line = JSON.parse(rawLine);
  } catch {
    return unreadable;
  }
  // A fragment that parses but is not an object (`null`, a bare number) is just
  // as unreadable — guard before touching properties so nothing throws here.
  if (!line || typeof line !== 'object') return unreadable;
  const blob = typeof line.response_blob === 'string' ? line.response_blob : null;
  const turn = typeof line.turn === 'number' ? line.turn : null;
  if (blob === null) return { turn, blob: null, names: [], decoded: false };
  /** @type {Buffer} */
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, blob));
  } catch {
    // Aborted exchange — the manifest line exists, the blob never landed.
    return { turn, blob, names: [], decoded: false };
  }
  return { turn, blob, names: toolUseNames(buf), decoded: true };
}
