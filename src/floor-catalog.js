// ccsnoop floor — catalog-block detection (issue #109, point 1).
//
// `floor`'s per-block attribution used to fold the deferred-tools listing into one
// opaque "MCP deferred listing" row fed by `gain.mcp`, while the skills and agent-types
// catalogs — sibling `<system-reminder>` blocks Claude Code injects into
// `messages[0].content` — were INVISIBLE: they classify to `harness`, but `chargeExchange`
// only charges `harness` for the `system` surface (`src/finetune-gain.js`), so a
// message-surface block that misses every lever marker is dropped as "conversation" and
// contributes zero bytes. This module gives `floor` its own detection of the three catalog
// populations so each shows as a named, byte-costed block — and `--detail` drills into the
// per-entry lines.
//
// It is a PURE CONSUMER of the parsed request body: it does NOT touch the shared
// `classifySystemBlock` / `computeGain` (those feed the fine-tune lever model and the
// `tuning-report` contract; widening them is issue #105's job). Bytes are measured with
// the same `canonicalize` every other floor block uses, so a catalog block's figure is
// byte-consistent with the rest of the table.
//
// Two capture shapes are handled:
//   • separate blocks — each population is its own `<system-reminder>` (the committed
//     fixture). The block's whole text is the population, and its bytes match `gain.mcp`
//     for the deferred-tools block exactly.
//   • one combined block — all three populations ride a single `<system-reminder>` (the
//     only way a real session can show one ~30 KB "MCP deferred listing" row — 19 tool
//     names are not 30 KB). The block is carved into one span per population.

import { canonicalize } from './waste.js';
import { classifySystemBlock } from './finetune-system.js';

/**
 * The three catalog populations, as `floor`-block kinds.
 * @typedef {'deferred-tools' | 'agent-types' | 'skills-catalog'} CatalogKind
 */

/**
 * A detected catalog population.
 * @typedef {object} CatalogBlock
 * @property {CatalogKind} kind
 * @property {number} bytes   Canonical byte length — `canonicalize` of a `{type:'text'}`
 *                            block carrying the population's text span, the same basis every
 *                            other floor block uses (so it is comparable in one table).
 * @property {string} text    The population's text span (for `--detail` entry parsing).
 * @property {'mcp' | 'harness' | null} chargedTo  Which existing floor row already carries
 *                            these bytes, so the caller can drop/deduct instead of
 *                            double-counting. Read off the SHARED classifier — the same
 *                            authority `chargeExchange` uses — so the two can never drift:
 *                            `mcp` when the source block classifies `mcp-deferred`,
 *                            `harness` when it classifies `harness` on the `system` surface
 *                            (the only surface `chargeExchange` charges harness for), and
 *                            null when the gain model drops it as conversation — i.e. this
 *                            population is currently INVISIBLE in the floor.
 */

/**
 * One named entry within a catalog block (a skill, a deferred tool, an agent type).
 * @typedef {object} CatalogEntry
 * @property {string} name
 * @property {number} bytes                          Raw UTF-8 byte length of the entry's text.
 * @property {'tools' | 'servers' | null} [group]    Set only for `deferred-tools` entries,
 *                                                   to split built-in tools from connecting servers.
 */

// Header phrases that introduce each population. Case-sensitive, multiline-anchored: each
// matches exactly its block (no cross-matches), and none appears in `body.system` on the
// committed fixture. The `m` flag lets `^` match after a newline inside a multi-line block
// (the header sits one line below the `<system-reminder>` wrapper); on a single trimmed
// line `.test` matches the prefix regardless of the flag.
const DEFERRED_TOOLS_HDR = /^The following deferred tools are now available via ToolSearch\./m;
const AGENT_TYPES_HDR = /^Available agent types for the Agent tool:/m;
const SKILLS_HDR = /^The following skills are available for use with the Skill tool:/m;
const MCP_CONNECTING_HDR = /^The following MCP servers are still connecting/m;

/** A deferred-tool or connecting-server name is a bare token (the charset finetune-mcp.js uses). */
const BARE_TOKEN = /^[A-Za-z0-9_.-]+$/;
/** A bulleted catalog entry: `- <name>: <rest>`. The name stops at the first colon. */
const BULLET_ENTRY = /^-\s+([^:]+):\s*(.*)$/;
/** The `<system-reminder>` wrapper lines that carry these blocks. */
const REMINDER_TAG = /^<\/?system-reminder>/;

/** The headers in canonical (kind) order; used both for detection and for stable output. */
const HEADERS = /** @type {{ kind: CatalogKind, re: RegExp }[]} */ ([
  { kind: 'deferred-tools', re: DEFERRED_TOOLS_HDR },
  { kind: 'agent-types', re: AGENT_TYPES_HDR },
  { kind: 'skills-catalog', re: SKILLS_HDR },
]);

/**
 * The text payload of a content block — a bare string, or the `text` field of a
 * `{ type: 'text', text }` block. Null-safe (mirrors `finetune-system.js`'s `blockText`).
 * @param {any} block
 * @returns {string}
 */
function blockText(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Canonical byte length of a text span, on the same basis every floor block is measured:
 * `canonicalize` of a `{ type: 'text', text }` block. For a span that is a block's whole
 * text this reproduces the gain model's figure byte-for-byte (the catalog blocks carry no
 * `cache_control`, so `{ type:'text', text }` is their exact canonical shape).
 * @param {string} textSpan
 * @returns {number}
 */
function catalogBytes(textSpan) {
  return Buffer.byteLength(canonicalize({ type: 'text', text: textSpan }), 'utf8');
}

/**
 * The canonical envelope of an EMPTY text block — `{"text":"","type":"text"}`. JSON string
 * escaping is per-character, so `catalogBytes(t) === ENVELOPE + escaped(t)` and therefore
 * `escaped(a + b) === escaped(a) + escaped(b)`. Charging the envelope to the first span only
 * makes the spans of a carved block tile it EXACTLY: Σ span bytes === the whole block's
 * bytes, so splitting a combined block never invents bytes the gain model did not charge.
 */
const ENVELOPE = catalogBytes('');

/**
 * Visit every content block of a parsed request body — `body.system` and every
 * `messages[*].content` block — yielding `{ block, surface }`. Mirrors the surface walk
 * `finetune-gain.js` / `finetune-mcp.js` use; floor needs its own because those modules'
 * walks are private. Null-safe.
 *
 * Both surfaces are walked because the fidelity question of WHERE CC injects these blocks
 * (`system[]` vs `message#0`) is exactly the open question FT3 left (test/fixtures/finetune/
 * README.md); detecting on both surfaces is robust across CC builds.
 * @param {any} body  Parsed request JSON.
 * @returns {Generator<{ block: any, surface: 'system' | 'message' }>}
 */
function* walkBodyBlocks(body) {
  if (!body || typeof body !== 'object') return;
  const sys = body.system;
  const sysBlocks = Array.isArray(sys) ? sys : sys == null ? [] : [sys];
  for (const block of sysBlocks) yield { block, surface: 'system' };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const block of c) yield { block, surface: 'message' };
    } else {
      yield { block: c, surface: 'message' }; // a bare-string message content
    }
  }
}

/**
 * Find the catalog populations in a parsed turn-1 body. Walks every text block on both
 * surfaces; within each block, locates the catalog headers present and emits one
 * `CatalogBlock` per population:
 *   • one header in a block (the separate-block shape) → the whole block text is the
 *     population;
 *   • several headers in one block (the combined-block shape) → the text is carved into one
 *     span per population (the first span starts at the block's first character so the
 *     `<system-reminder>` envelope is not lost; spans tile the block text).
 * A population re-sent elsewhere in the same request is counted once (first wins). Never
 * throws; a non-object body yields `[]`.
 * @param {any} body  Parsed request JSON (null-safe).
 * @returns {CatalogBlock[]}  0–3 blocks, in canonical kind order.
 */
export function findCatalogBlocks(body) {
  /** @type {CatalogBlock[]} */
  const out = [];
  /** @type {Set<CatalogKind>} */
  const seen = new Set();
  for (const { block, surface } of walkBodyBlocks(body)) {
    const text = blockText(block);
    if (!text) continue;
    // Locate every catalog header present in THIS block, by char offset.
    /** @type {{ kind: CatalogKind, at: number }[]} */
    const hits = [];
    for (const h of HEADERS) {
      const m = h.re.exec(text);
      if (m) hits.push({ kind: h.kind, at: m.index });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.at - b.at);

    // What the gain model already charged for THIS source block. Asking the shared
    // classifier (rather than re-deriving the rule) is what keeps floor's deduction and
    // `chargeExchange`'s charge in lockstep — see `chargedTo` on the typedef.
    const lever = classifySystemBlock(block).lever;
    /** @type {CatalogBlock['chargedTo']} */
    const chargedTo = lever === 'mcp-deferred' ? 'mcp' : lever === 'harness' && surface === 'system' ? 'harness' : null;

    if (hits.length === 1) {
      const kind = hits[0].kind;
      if (seen.has(kind)) continue;
      seen.add(kind);
      out.push({ kind, bytes: catalogBytes(text), text, chargedTo });
    } else {
      // Combined block: carve one span per population. Span i runs from its header to the
      // next population's header; the last runs to end-of-text. The text before the first
      // header (the opening <system-reminder> envelope) folds into the first span, which
      // is also the span charged the canonical ENVELOPE so the spans tile the block exactly.
      for (let k = 0; k < hits.length; k++) {
        const kind = hits[k].kind;
        if (seen.has(kind)) continue;
        seen.add(kind);
        const start = k === 0 ? 0 : hits[k].at;
        const end = k + 1 < hits.length ? hits[k + 1].at : text.length;
        const span = text.slice(start, end);
        out.push({ kind, bytes: catalogBytes(span) - (k === 0 ? 0 : ENVELOPE), text: span, chargedTo });
      }
    }
  }
  // Stable canonical-kind order (the byte-descending sort in floor re-orders for display).
  return out.sort((a, b) => HEADERS.findIndex((h) => h.kind === a.kind) - HEADERS.findIndex((h) => h.kind === b.kind));
}

/**
 * Parse a catalog block's text into per-entry byte shares for `--detail`. Entry bytes are
 * raw UTF-8 text lengths (a sub-breakdown of the block's text; they sum to ≤ block bytes —
 * the header lines, separators and `<system-reminder>` envelope are the remainder). Never
 * throws; an empty/unrecognized text yields `[]`.
 * @param {CatalogKind} kind
 * @param {string} text  The population's text span (`CatalogBlock.text`).
 * @returns {CatalogEntry[]}
 */
export function parseCatalogEntries(kind, text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (kind === 'deferred-tools') return parseDeferredTools(text);
  return parseBulleted(text); // agent-types and skills share the `- name: desc` shape
}

/**
 * The deferred-tools block holds two bare-token sub-lists under distinct headers: the
 * deferred built-in tools, then the connecting MCP servers. A small line-by-line state
 * machine attributes each bare-token line to its sub-list, stopping a sub-list at the
 * first non-matching line (the blank separator or the trailing caveat) — the same
 * stop-on-non-match discipline `parseDeferredMcpServers` uses, so a reworded header cannot
 * pull prose into the entry list.
 * @param {string} text
 * @returns {CatalogEntry[]}
 */
function parseDeferredTools(text) {
  /** @type {CatalogEntry[]} */
  const out = [];
  /** @type {'tools' | 'servers' | null} */
  let group = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (DEFERRED_TOOLS_HDR.test(line)) {
      group = 'tools';
      continue;
    }
    if (MCP_CONNECTING_HDR.test(line)) {
      group = 'servers';
      continue;
    }
    if (REMINDER_TAG.test(line)) {
      group = null; // the wrapper tag closes the listing
      continue;
    }
    // A blank line does NOT end a sub-list: some builds of Claude Code put one between the
    // header and the first name. Only PROSE ends it (below) — which the trailing caveat
    // and any following paragraph reliably are, so nothing downstream can leak in.
    if (line === '') continue;
    if (group && BARE_TOKEN.test(line)) {
      out.push({ name: line, bytes: Buffer.byteLength(raw + '\n', 'utf8'), group });
    } else if (group) {
      group = null; // a prose line (the caveat) ends the sub-list
    }
  }
  return out;
}

/**
 * The agent-types and skills blocks are bulleted: `- <name>: <description>`. A new entry
 * starts at each `- ` line; a continuation line with no bullet (e.g. a skill whose
 * description spans several physical lines) folds into the preceding entry. The trailing
 * caveat paragraph (no bullet) and the wrapper tag are not entries.
 *
 * The name stops at the first colon. Scope-prefixed names (`plugin:name`) are issue #105's
 * territory and are not split here — none appears in the committed fixture.
 * @param {string} text
 * @returns {CatalogEntry[]}
 */
function parseBulleted(text) {
  /** @type {CatalogEntry[]} */
  const out = [];
  /** @type {{ name: string, lines: string[] } | null} */
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (REMINDER_TAG.test(line)) continue;
    const m = line.match(BULLET_ENTRY);
    if (m) {
      if (cur) flushBulleted(cur, out);
      cur = { name: m[1].trim(), lines: [raw] };
    } else if (cur) {
      if (line === '') {
        flushBulleted(cur, out); // a blank line ends the entry list (the caveat follows)
        cur = null;
      } else {
        cur.lines.push(raw); // a continuation line folds into the current entry
      }
    }
  }
  if (cur) flushBulleted(cur, out);
  return out;
}

/**
 * Materialize the accumulated entry: its bytes are its raw text lines joined, plus the
 * trailing newline each line carries on the wire.
 * @param {{ name: string, lines: string[] }} cur
 * @param {CatalogEntry[]} out
 */
function flushBulleted(cur, out) {
  out.push({ name: cur.name, bytes: Buffer.byteLength(`${cur.lines.join('\n')}\n`, 'utf8'), group: null });
}
