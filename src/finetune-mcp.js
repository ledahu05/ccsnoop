// Fine-tune: the MCP lever — deferred listing, corpus aggregation, T4 guard
// (fine-tune-spec §3.2, issue #74 / FT4).
//
// MCP is the only lever that still consumes the sent-vs-used signal (spec §3.2).
// A server is shipped as **name only** inside a `<system-reminder>` — "The
// following MCP servers are still connecting" — and it is "used" iff one of its
// tools is *called*. On the wire an MCP call is `mcp__<server>__<tool>` (confirmed
// by the FT0 fixture's turn-3 ToolSearch load + the FT2 called-tool set). So:
//
//   shipped(server)  = the name appears in the deferred listing (any request).
//   called(server)   = a `tool_use` name `mcp__<server>__*` appears in a response.
//
// `ccsnoop fine-tune` aggregates shipped/called across the WHOLE corpus and may
// emit `disabledMcpjsonServers` ONLY under the T4 guard:
//
//     corpus.sessionCount >= 3  AND  calledCount(server) == 0
//
// Binary on absence — called even once → used → never "never used". No percentage,
// no recency window (capture is opportunistic; a time threshold would dress up
// precision the data doesn't have). Otherwise it is **flag-only** (the diagnostic
// shows `sessionCount` + `calledCount` per server), and in single-session mode it
// **never** denies — one session is too thin for a global config verdict.
//
// Non-negotiables inherited from the spec: bytes never tokens (this lever emits
// server NAMES, not figures — byte accounting arrives with T5/T6); output is
// advice-to-copy, never auto-applied. The called half reuses FT2's
// `calledToolSet` (issue #72) — one response decoder, not a second copy.

import fs from 'node:fs';
import path from 'node:path';

import { parseRequestBlob } from './report.js';
import { calledToolSet } from './finetune-response.js';

/** The minimum corpus size before "never called" is trusted enough to deny. */
export const MCP_GUARD_MIN_SESSIONS = 3;

/**
 * @typedef {object} McpSessionProfile
 * @property {string} sessionId
 * @property {Set<string>} shipped    MCP server names this session ships (deferred listing).
 * @property {Set<string>} called     MCP server names this session called (≥1 tool_use).
 */

/**
 * @typedef {object} McpServerVerdict
 * @property {string} name            Server name (from the deferred listing).
 * @property {number} shippedSessions Sessions whose deferred listing named this server.
 * @property {number} calledCount     Number of SESSIONS that called this server (≥1 tool_use).
 * @property {boolean} deny           True iff `sessionCount>=3 AND calledCount===0` (and not single-session).
 */

/**
 * @typedef {object} McpCorpus
 * @property {number} sessionCount        Number of sessions aggregated.
 * @property {boolean} singleSession      True iff the run is single-session (deny forced off).
 * @property {McpServerVerdict[]} servers Every shipped server, in sorted name order.
 */

// The CC deferred-listing header that precedes the connecting-server names. Pinned
// to the FT0 capture's real phrasing (bench/SPEC.md §0, CC v2.1.220) — the server
// names follow this line, one per line, until a blank line ends the list.
const MCP_CONNECTING_HEADER = /MCP servers are still connecting/i;

/**
 * Parse the **deferred MCP listing** from a system-reminder text — the server
 * names listed under "The following MCP servers are still connecting" (AC #1).
 *
 * The same `<system-reminder>` also lists deferred *built-in tools* (CronCreate,
 * WebSearch, …) one paragraph ABOVE the server list; those are NOT servers and
 * must not leak into the shipped-MCP set. The parser keys on the connecting-header
 * phrase and reads only the single-token names that follow it, stopping at the
 * first blank line (the trailing "If the user's request…" prose) — so a server
 * name is always a bare token with no spaces, the shape `.mcp.json` keys take.
 *
 * @param {string} text  The text of a system block (may span multiple reminders).
 * @returns {string[]}   Distinct server names, in first-seen order.
 */
export function parseDeferredMcpServers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  /** @type {string[]} */
  const names = [];
  /** @type {Set<string>} */
  const seen = new Set();
  // A text may carry MORE than one listing (a session re-sends it every request,
  // and shippedServersInBody may hand us several blocks at once), so find EVERY
  // occurrence of the header and read the names that follow each.
  let cursor = 0;
  for (;;) {
    const m = text.slice(cursor).match(MCP_CONNECTING_HEADER);
    if (!m) break;
    const base = cursor + m.index + m[0].length;
    cursor = base; // advance past this header so the next iteration finds the next one
    // The rest of the header line ("…will appear shortly:") and the names follow.
    // A name is a single token; a line with spaces is prose and ends the list.
    let started = false;
    for (const rawLine of text.slice(base).split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) break; // a blank line ends this listing
      if (line === '</system-reminder>') break;
      if (/\s/.test(line)) {
        // Prose before any name = header continuation (skip); prose after a name
        // cannot occur (a blank line separates the list from the caveat) — stop.
        if (started) break;
        continue;
      }
      started = true;
      if (!seen.has(line)) {
        seen.add(line);
        names.push(line);
      }
    }
  }
  return names;
}

/**
 * The MCP server a called tool belongs to, or `null` for a non-MCP (built-in)
 * tool. On the wire an MCP call is `mcp__<server>__<tool>`; a built-in call
 * (`Read`, `Bash`, …) has no such prefix and must never be attributed to a
 * server — otherwise a built-in tool could mark a same-named server as used.
 *
 * @param {string} toolName
 * @returns {string | null}
 */
export function mcpServerOf(toolName) {
  if (typeof toolName !== 'string') return null;
  const m = toolName.match(/^mcp__([A-Za-z0-9_.-]+)__/);
  return m ? m[1] : null;
}

/**
 * The text payload of a content block — a bare string, or the `text` field of a
 * `{ type: 'text', text }` block. Null-safe.
 * @param {any} block
 * @returns {string}
 */
function blockTextOf(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Yield every text payload a request body carries — the `system` blocks AND the
 * `messages[*].content` blocks. The deferred MCP listing rides a
 * `<system-reminder>`, and CC injects it into the FIRST USER message's content
 * (confirmed by the FT0 fixture: `messages[0].content[1]`, every turn — NOT
 * `body.system`). Scanning both surfaces finds the listing wherever CC places it.
 * @param {any} body  Parsed request JSON.
 * @returns {Generator<string>}
 */
function* bodyTexts(body) {
  if (!body || typeof body !== 'object') return;
  const sys = body.system;
  const sysBlocks = Array.isArray(sys) ? sys : sys == null ? [] : [sys];
  for (const block of sysBlocks) {
    const t = blockTextOf(block);
    if (t.length > 0) yield t;
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (typeof c === 'string') {
      if (c.length > 0) yield c;
    } else if (Array.isArray(c)) {
      for (const block of c) {
        const t = blockTextOf(block);
        if (t.length > 0) yield t;
      }
    }
  }
}

/**
 * Every MCP server a parsed request body ships — the union of the deferred
 * listing across all of its text surfaces (system + messages). Null-safe.
 * @param {any} body  Parsed request JSON.
 * @returns {Set<string>}
 */
function shippedServersInBody(body) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const text of bodyTexts(body)) {
    for (const name of parseDeferredMcpServers(text)) out.add(name);
  }
  return out;
}

/**
 * The MCP profile of ONE captured session (AC #2, per-session half): the servers
 * it ships (deferred listing, unioned across requests) and the servers it called
 * (the FT2 called-tool set, mapped back through {@link mcpServerOf}).
 *
 * Ships are read straight from the request blobs — `loadSession` (report.js)
 * keeps only derived segments, not the system text. Calls reuse FT2's
 * `calledToolSet` (one response decoder). Both degrade, never throw, on a
 * corrupt/truncated capture: a half-written turn contributes nothing rather than
 * taking the verdict down. The only hard error is a session dir with no readable
 * `manifest.jsonl` (a caller mistake, surfaced by `calledToolSet`).
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @returns {McpSessionProfile}
 */
export function sessionMcpProfile(dir, id = path.basename(dir)) {
  const manifestPath = path.join(dir, 'manifest.jsonl');
  /** @type {string} */
  let manifest;
  try {
    manifest = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read manifest.jsonl in ${dir}: ${/** @type {Error} */ (err)?.message ?? err}`);
  }

  /** @type {Set<string>} */
  const shipped = new Set();
  for (const rawLine of manifest.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    /** @type {any} */
    let line;
    try {
      line = JSON.parse(rawLine);
    } catch {
      continue; // a half-written manifest line — skip, don't crash (see FT2).
    }
    if (!line || typeof line !== 'object' || typeof line.request_blob !== 'string') continue;
    /** @type {Buffer} */
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, line.request_blob));
    } catch {
      continue; // aborted exchange (request blob never landed) — contributes nothing.
    }
    for (const name of shippedServersInBody(parseRequestBlob(buf).json)) shipped.add(name);
  }

  // Called half: FT2 already decoded every response into a called-tool set + counts.
  const called = calledToolSet(dir, id);
  /** @type {Set<string>} */
  const calledServers = new Set();
  for (const toolName of called.names) {
    const server = mcpServerOf(toolName);
    if (server !== null) calledServers.add(server);
  }

  return { sessionId: id, shipped, called: calledServers };
}

/**
 * Aggregate per-session MCP profiles into a corpus verdict with the T4 guard
 * applied (AC #2–#3). Pure — give it the profiles, get back the verdict; this is
 * what the synthetic multi-session guard tests exercise directly.
 *
 * Each profile is `{ shipped?: Iterable<string>, called?: Iterable<string> }`;
 * `called` is the DISTINCT servers that session called (the Set
 * {@link sessionMcpProfile} emits), so `calledCount` = the number of SESSIONS that
 * called the server — the spec mockup's "appelé 0/3" form. Binary on absence:
 * called in any session → used → never "never used".
 *
 * @param {Array<{ shipped?: Iterable<string>, called?: Iterable<string>, sessionId?: string }>} profiles
 * @param {{ singleSession?: boolean }} [opts]
 * @returns {McpCorpus}
 */
export function aggregateMcpCorpus(profiles, opts = {}) {
  const singleSession = Boolean(opts.singleSession);
  const list = Array.isArray(profiles) ? profiles : [];
  const sessionCount = list.length;

  // shippedSessions + calledCount per server, accumulated in one pass.
  /** @type {Map<string, { shippedSessions: number, calledCount: number }>} */
  const acc = new Map();
  const touch = (name) => {
    let e = acc.get(name);
    if (!e) {
      e = { shippedSessions: 0, calledCount: 0 };
      acc.set(name, e);
    }
    return e;
  };
  for (const profile of list) {
    if (!profile) continue;
    for (const name of profile.shipped ?? []) touch(name).shippedSessions += 1;
    for (const name of profile.called ?? []) touch(name).calledCount += 1;
  }

  // Sorted by name for a deterministic, paste-ready block (discovery order via
  // readdir is not stable across platforms).
  /** @type {McpServerVerdict[]} */
  const servers = [...acc.keys()]
    .sort()
    .map((name) => {
      const e = /** @type {{ shippedSessions: number, calledCount: number }} */ (acc.get(name));
      const deny = !singleSession && sessionCount >= MCP_GUARD_MIN_SESSIONS && e.calledCount === 0;
      return { name, shippedSessions: e.shippedSessions, calledCount: e.calledCount, deny };
    });

  return { sessionCount, singleSession, servers };
}
