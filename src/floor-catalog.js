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
// It USED to carry its own header detection, deliberately, so as not to preempt issue
// #105's decision about the shared lever model. That decision has landed (ADR-0005) and
// issue #116 inverted the layering: `src/finetune-system.js` is now the single authority
// for "which lever owns which bytes of this block", and this module CONSUMES its spans
// ({@link module:finetune-system.classifySystemSpans}) instead of doubling the detection.
// What remains here is presentation: naming the populations `floor` shows, parsing each
// into its entries for `--detail`, and reporting which existing floor row already carries
// a population's bytes.
//
// Two capture shapes are handled, both by the shared classifier:
//   • separate blocks — each population is its own `<system-reminder>` (the committed
//     fixture). The block's whole text is the population.
//   • one combined block — all three populations ride a single `<system-reminder>` (the
//     only way a real session can show one ~30 KB "MCP deferred listing" row — 19 tool
//     names are not 30 KB). The block is carved into one span per population.
//
// One fold happens on the way out. The classifier carves the connecting-servers sub-list
// (`mcp-deferred`) out of the deferred-tools listing it rides inside, because the gain
// model must charge each half to the lever that owns it. `floor` keeps showing the
// listing as ONE row — the servers are already visible as its `group: 'servers'` entries
// — so an `mcp-deferred` span folds back into the population it interrupted, and that
// population reports `chargedTo: 'mcp'` so the opaque MCP row is dropped rather than
// double-counted. Per-block bytes are therefore unchanged from #113: the inversion is a
// refactor of provenance, not of measurement.

import { classifySystemSpans, CATALOG_LEVERS, SUBLIST_HEADERS, isCatalogLever } from './finetune-system.js';

/**
 * The three catalog populations, as `floor`-block kinds — the shared classifier's
 * `CATALOG_LEVERS`, under the name `floor`'s attribution rows use.
 * @typedef {import('./finetune-system.js').CatalogLever} CatalogKind
 */

/**
 * A detected catalog population.
 * @typedef {object} CatalogBlock
 * @property {CatalogKind} kind
 * @property {number} bytes   This population's share of its source block's canonical byte
 *                            length, straight from the shared classifier's span — the same
 *                            basis every other floor block uses (so it is comparable in one
 *                            table), and the spans of one block tile it exactly.
 * @property {string} text    The population's text span (for `--detail` entry parsing).
 * @property {'mcp' | null} chargedTo  Which existing floor row already carries part of
 *                            these bytes, so the caller can drop it instead of
 *                            double-counting. Read off the SHARED classifier — the same
 *                            authority `chargeExchange` uses — so the two can never drift:
 *                            `mcp` when this population absorbed the connecting-servers
 *                            sub-list (whose bytes `chargeExchange` charged to `gain.mcp`),
 *                            null otherwise. Since #116 a catalog block classifies to its
 *                            own lever rather than to `harness`, so the gain model no
 *                            longer folds any of it into the harness figure.
 */

/**
 * One named entry within a catalog block (a skill, a deferred tool, an agent type).
 * @typedef {object} CatalogEntry
 * @property {string} name
 * @property {number} bytes                          Raw UTF-8 byte length of the entry's text.
 * @property {'tools' | 'servers' | null} [group]    Set only for `deferred-tools` entries,
 *                                                   to split built-in tools from connecting servers.
 */

// The header phrases, read off the shared classifier — the module that DETECTS them. Only
// the entry parsers below use them here, to recognize the line that opens each sub-list
// when splitting a population into its named items.
const DEFERRED_TOOLS_HDR = SUBLIST_HEADERS['deferred-tools'];
const MCP_CONNECTING_HDR = SUBLIST_HEADERS['mcp-deferred'];

/** A deferred-tool or connecting-server name is a bare token (the charset finetune-mcp.js uses). */
const BARE_TOKEN = /^[A-Za-z0-9_.-]+$/;
/** A bulleted catalog entry: `- <name>: <rest>`. The name stops at the first colon. */
const BULLET_ENTRY = /^-\s+([^:]+):\s*(.*)$/;
/**
 * A catalog entry listed WITHOUT its description: `- <name>`, nothing else on the line
 * (issue #115). Claude Code emits this shape from two independent paths — a
 * `skillOverrides` entry set to `name-only` (the action ADR-0005's lever 5a writes, and
 * the one `/skills` writes today), and its own catalog budget degrading the biggest
 * entries on overflow (`budgetTruncatedSkills`). Both were confirmed on the bench-pinned
 * build; see docs/research/skill-overrides-name-only.md.
 *
 * The discriminator is deliberately tight — ONE bare token after the dash, no space. A
 * description's continuation line that happens to start with `- ` is prose (it has
 * spaces) and must keep folding into the entry above, which is what the second #115 test
 * pins. A colon may JOIN two tokens so a scope-qualified name (`plugin:skill`, the shape
 * budget truncation can produce) stays whole rather than being split at its colon by
 * BULLET_ENTRY — hence this pattern is tried FIRST. It may not TRAIL: `- tdd:` is a skill
 * with an empty description, and belongs to BULLET_ENTRY, which strips the colon off the
 * name. Letting it match here would name that entry `tdd:` and break the join between two
 * captures of the same skill — the join a before/after override diff runs on.
 */
const NAME_ONLY_ENTRY = /^-\s+([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)\s*$/;
/** The `<system-reminder>` wrapper lines that carry these blocks. */
const REMINDER_TAG = /^<\/?system-reminder>/;

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
 * Visit every content block of a parsed request body — `body.system` and every
 * `messages[*].content` block. Mirrors the surface walk `finetune-gain.js` /
 * `finetune-mcp.js` use; floor needs its own because those modules' walks are private.
 * Null-safe.
 *
 * Both surfaces are walked because the fidelity question of WHERE CC injects these blocks
 * (`system[]` vs `message#0`) is exactly the open question FT3 left (test/fixtures/finetune/
 * README.md); detecting on both surfaces is robust across CC builds. The surface itself no
 * longer matters here: since #116 a catalog block classifies to its own lever on either
 * surface, so it is never folded into the harness figure it would have to be deducted from.
 * @param {any} body  Parsed request JSON.
 * @returns {Generator<{ block: any }>}
 */
function* walkBodyBlocks(body) {
  if (!body || typeof body !== 'object') return;
  const sys = body.system;
  const sysBlocks = Array.isArray(sys) ? sys : sys == null ? [] : [sys];
  for (const block of sysBlocks) yield { block };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const block of c) yield { block };
    } else {
      yield { block: c }; // a bare-string message content
    }
  }
}

/**
 * Find the catalog populations in a parsed turn-1 body. Walks every text block on both
 * surfaces, hands each to the shared classifier, and keeps the spans that are catalog
 * populations — one `CatalogBlock` each. The classifier covers both capture shapes: a
 * block carrying one header yields one span (its whole text), a combined block yields one
 * span per population, and the spans tile the block.
 *
 * A `mcp-deferred` span is FOLDED into the population it interrupts (see the module
 * header): `floor` shows the deferred listing as one row whose connecting servers are
 * already `group: 'servers'` entries, and the fold is what keeps that row's bytes
 * identical to #113's. A population re-sent elsewhere in the same request is counted once
 * (first wins). Never throws; a non-object body yields `[]`.
 * @param {any} body  Parsed request JSON (null-safe).
 * @returns {CatalogBlock[]}  0–3 blocks, in canonical kind order.
 */
export function findCatalogBlocks(body) {
  /** @type {CatalogBlock[]} */
  const out = [];
  /** @type {Set<CatalogKind>} */
  const seen = new Set();
  for (const { block } of walkBodyBlocks(body)) {
    if (!blockText(block)) continue;
    const spans = classifySystemSpans(block);
    if (!spans.some((s) => isCatalogLever(s.lever))) continue;

    /** The catalog spans of THIS block, each with any following MCP sub-list folded in. */
    /** @type {{ kind: CatalogKind, bytes: number, text: string, mcp: boolean }[]} */
    const folded = [];
    for (const span of spans) {
      if (isCatalogLever(span.lever)) {
        folded.push({ kind: /** @type {CatalogKind} */ (span.lever), bytes: span.bytes, text: span.text, mcp: false });
      } else if (span.lever === 'mcp-deferred' && folded.length > 0) {
        const host = folded[folded.length - 1];
        host.bytes += span.bytes;
        host.text += span.text;
        host.mcp = true;
      }
      // An `mcp-deferred` span with no catalog before it is NOT a catalog population: it
      // is the connecting-servers listing on its own, which `floor` shows as its own row
      // from `gain.mcp`. Dropping it here is what keeps that row from being duplicated.
    }

    for (const f of folded) {
      if (seen.has(f.kind)) continue;
      seen.add(f.kind);
      // `mcp` when this population absorbed the connecting-servers sub-list: `gain.mcp`
      // holds that share, so `floor` must drop its opaque MCP row rather than show those
      // bytes twice. See `chargedTo` on the typedef.
      out.push({ kind: f.kind, bytes: f.bytes, text: f.text, chargedTo: f.mcp ? 'mcp' : null });
    }
  }
  // Stable canonical-kind order (the byte-descending sort in floor re-orders for display).
  return out.sort((a, b) => CATALOG_LEVERS.indexOf(a.kind) - CATALOG_LEVERS.indexOf(b.kind));
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
 * An entry may also arrive WITHOUT its description (`- <name>`, no colon) — see
 * NAME_ONLY_ENTRY, which is tried first.
 *
 * For a described entry the name stops at the first colon. Scope-prefixed names
 * (`plugin:name`) are issue #105's territory and are not split here — none appears in the
 * committed fixture. A name-only entry is the one exception: there is no description to
 * separate, so its colons are part of the name.
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
    const m = line.match(NAME_ONLY_ENTRY) ?? line.match(BULLET_ENTRY);
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
