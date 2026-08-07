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
// The skills lever (ADR-0005 lever 5a, issue #118) needs one thing the names alone
// cannot give: WHICH skill a `Skill` call invoked. That lives in the call's arguments,
// which a streamed response delivers as `input_json_delta` fragments after the name.
// So the decoder reassembles inputs too ({@link toolUseCalls}) and `toolUseNames`
// became its names-only view — one decoder, still, not two.
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
 * The built-in tool the model invokes a skill through. The skill's NAME is not the
 * tool name — it is the `skill` field of the call's input — so the skills lever
 * (ADR-0005 lever 5a, issue #118) needs the arguments half of the decode, not just
 * the names half. A user typing `/name` produces no `tool_use` at all, which is
 * exactly why "invoked by the model" is a decodable predicate.
 */
export const SKILL_TOOL = 'Skill';

/**
 * @typedef {object} TurnCalls
 * @property {number | null} turn   Turn number from the manifest line, when present.
 * @property {string | null} blob   The `.response.sse` filename, when the manifest names one.
 * @property {string[]} names       Tool names called in this turn, in emission order (repeats kept).
 * @property {string[]} skills      Skill names this turn invoked through the `Skill` tool.
 * @property {boolean} decoded      False when the response blob was absent or unreadable.
 */

/**
 * @typedef {object} ToolCall
 * @property {string} name              The `tool_use` name.
 * @property {Record<string, any> | null} input  The call's arguments, reassembled from the
 *                                     stream's `input_json_delta` fragments; null when they
 *                                     never formed valid JSON (a capture cut mid-stream).
 */

/**
 * @typedef {object} CalledTools
 * @property {string} sessionId               Session id (defaults to the dir basename).
 * @property {Set<string>} names              Distinct tool names called anywhere in the session.
 * @property {Set<string>} skills             Distinct skill names the MODEL invoked through the
 *                                            `Skill` tool. Slash-typed `/name` invocations are
 *                                            not tool calls and never appear here — the
 *                                            predicate ADR-0005 lever 5a asks for.
 * @property {Map<string, number>} counts     Name → number of `tool_use` blocks across the session.
 * @property {TurnCalls[]} perTurn            One entry per manifest line, in capture order.
 * @property {number} responses               Response blobs successfully read.
 * @property {number} missing                 Turns that yielded no readable response — blob absent
 *                                            or unreadable, or the manifest line itself unparseable.
 *                                            `responses + missing === perTurn.length` always.
 */

/**
 * The tool CALLS one captured response made — name plus reassembled input — in
 * emission order. {@link toolUseNames} is the names-only view of this, so there is one
 * decoder and not two.
 *
 * Handles both response shapes ccsnoop captures: the streamed SSE (a `tool_use`
 * arrives as the `content_block` of a `content_block_start`, its arguments following
 * as `input_json_delta` fragments keyed by block `index`) and a non-streaming JSON
 * body (`content[]` carries the finished blocks, input included). Anything
 * unparseable — empty, non-JSON, truncated gzip — reads as `[]`, and a call whose
 * fragments never form valid JSON keeps its name with `input: null`: the call
 * happened, so dropping it would understate use.
 *
 * Only the literal `tool_use` type counts. Server-side variants
 * (`server_tool_use`, `mcp_tool_use`) are executed API-side and are not tools
 * the user ships in `tools[]`, so denying them would be meaningless: including
 * them would let a server-side call mark a shipped tool as used.
 *
 * @param {Buffer | string} buf  Raw `.response.sse` bytes (gzip or plain), or text.
 * @returns {ToolCall[]}
 */
export function toolUseCalls(buf) {
  const text = decodeResponseBlob(buf);
  if (text.trim().length === 0) return [];

  /** @type {{ name: string, input: any, partial: string }[]} */
  const calls = [];
  /** Block id → the call record it produced, so a re-report resolves to the SAME record. */
  /** @type {Map<string, { name: string, input: any, partial: string }>} */
  const seenIds = new Map();

  // Streamed path — one `content_block_start` per block; `tool_use` carries the
  // name up front, and the `input_json_delta`s that follow carry the arguments,
  // addressed by the event's block `index`.
  const events = parseSseEvents(text);
  /** @type {Map<number, { name: string, input: any, partial: string }>} */
  const byIndex = new Map();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const started = pushIfToolUse(calls, seenIds, e.content_block);
    if (started && typeof e.index === 'number') byIndex.set(e.index, started);
    // Arguments arrive as fragments of one JSON document, per block index — two
    // concurrent blocks interleave theirs, so the index is the only safe key.
    if (e.delta && e.delta.type === 'input_json_delta' && typeof e.delta.partial_json === 'string') {
      const target = byIndex.get(e.index);
      if (target) target.partial += e.delta.partial_json;
    }
    // A `message_start` may already carry finished blocks (replayed/short turns).
    if (e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) pushIfToolUse(calls, seenIds, block);
    }
  }
  if (events.length > 0) return calls.map(finishCall);

  // Non-streaming path — a single JSON body with the assembled `content[]`.
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.content)) {
      for (const block of parsed.content) pushIfToolUse(calls, seenIds, block);
    }
  } catch {
    // Not SSE and not JSON — no called-tool signal in this blob.
  }
  return calls.map(finishCall);
}

/**
 * The tool names one captured response called, in emission order. Duplicates are
 * KEPT — a turn calling `Read` twice (two `tool_use` blocks) yields
 * `['Read','Read']` so the caller can count calls, not just distinct names;
 * {@link calledToolSet} derives the set. One block reported twice by the stream is
 * still one call — see {@link pushIfToolUse}.
 *
 * @param {Buffer | string} buf  Raw `.response.sse` bytes (gzip or plain), or text.
 * @returns {string[]}
 */
export function toolUseNames(buf) {
  return toolUseCalls(buf).map((c) => c.name);
}

/**
 * The skill a call invoked, or null when it is not a model skill invocation. The
 * `Skill` tool's `skill` argument IS the catalog name, so a call whose input never
 * decoded names no skill: it is dropped rather than counted blank, since a blank
 * would join no catalog entry and could only ever mislead.
 * @param {ToolCall} call
 * @returns {string | null}
 */
export function invokedSkillOf(call) {
  if (!call || call.name !== SKILL_TOOL) return null;
  const skill = call.input?.skill;
  return typeof skill === 'string' && skill.length > 0 ? skill : null;
}

/**
 * Finalize an accumulating call record into a {@link ToolCall}: the reassembled
 * fragments win over the (always empty) `content_block_start` input, and fragments
 * that do not parse — or parse to a non-object — leave `input` null.
 * @param {{ name: string, input: any, partial: string }} c
 * @returns {ToolCall}
 */
function finishCall(c) {
  let input = c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input : null;
  if (c.partial.length > 0) {
    try {
      const parsed = JSON.parse(c.partial);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
      else input = null;
    } catch {
      input = null; // a capture cut mid-arguments — the call stands, its input does not
    }
  }
  return { name: c.name, input };
}

/**
 * Append a content block as a call when it is a named `tool_use`, returning the record so
 * the caller can route this block's `input_json_delta`s into it (null when the block is not
 * a `tool_use` at all). An unnamed `tool_use` (malformed/partial event) is skipped rather
 * than emitted blank — a blank name would later read as a shipped tool that matched nothing.
 *
 * One block can surface TWICE in a single stream — inlined in `message_start`'s `content[]`
 * and again as a `content_block_start` — which would inflate the call counts
 * {@link calledToolSet} reports. Count each block id once; genuine repeat calls carry
 * distinct ids, so `Read` twice in a turn still counts twice. A block with no id cannot be
 * deduped and is counted as seen.
 *
 * A re-reported block returns its EXISTING record rather than null, so the deltas that
 * follow still accumulate into it: the inlined copy may carry an empty `input` while the
 * arguments arrive as fragments afterwards, and dropping them would leave a `Skill` call
 * with no skill name — i.e. an invoked skill reading as never-invoked, which is a
 * false-positive `name-only`.
 *
 * @param {{ name: string, input: any, partial: string }[]} calls  Calls so far, in emission order.
 * @param {Map<string, { name: string, input: any, partial: string }>} seenIds  Block id → its record.
 * @param {any} block
 * @returns {{ name: string, input: any, partial: string } | null}
 */
function pushIfToolUse(calls, seenIds, block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'tool_use') return null;
  if (typeof block.name !== 'string' || block.name.length === 0) return null;
  const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
  if (id !== null) {
    const seen = seenIds.get(id);
    if (seen) return seen; // same block, reported twice — one call, still accumulating
  }
  const call = { name: block.name, input: block.input ?? null, partial: '' };
  if (id !== null) seenIds.set(id, call);
  calls.push(call);
  return call;
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
  /** @type {Set<string>} */
  const skills = new Set();
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
    for (const skill of turn.skills) skills.add(skill);
  }

  return { sessionId: id ?? path.basename(dir), names, skills, counts, perTurn, responses, missing };
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
  const unreadable = { turn: null, blob: null, names: [], skills: [], decoded: false };
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
  if (blob === null) return { turn, blob: null, names: [], skills: [], decoded: false };
  /** @type {Buffer} */
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, blob));
  } catch {
    // Aborted exchange — the manifest line exists, the blob never landed.
    return { turn, blob, names: [], skills: [], decoded: false };
  }
  const calls = toolUseCalls(buf);
  /** @type {string[]} */
  const skills = [];
  for (const call of calls) {
    const skill = invokedSkillOf(call);
    if (skill !== null) skills.push(skill);
  }
  return { turn, blob, names: calls.map((c) => c.name), skills, decoded: true };
}
