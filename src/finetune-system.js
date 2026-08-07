// Fine-tune: split the `system` bucket by source (fine-tune-spec §2.3, issue #73 / FT3).
//
// `src/waste.js` already segments every request into `system` / `tools` /
// `history` / `currentTurn`, one `system#<i>` segment per `system` block. But the
// `system` bucket itself MIXES seven sources the fine-tune levers care about:
//
//   • claude-md      — CLAUDE.md-derived memory (project `./CLAUDE.md`, global, …)
//   • hook           — SessionStart-hook output injected into the system prompt
//   • mcp-deferred   — the MCP servers still connecting; the deferred listing's MCP sub-list
//   • deferred-tools — the ToolSearch listing of deferred BUILT-IN tools
//   • skills-catalog — the Skill-tool catalog
//   • agent-types    — the Agent-tool catalog
//   • harness        — the CC identity/capabilities preamble; the incompressible floor
//
// This module attributes each `system` block to exactly one of them so the
// downstream fine-tune levers (T5/T6) can charge `Segment.bytes` to the right
// place and flag the harness floor as "shown but never actionable".
//
// ── One authority for "which lever is this block" (issue #116 / ADR-0005) ────────
// The three catalog populations used to be detected TWICE: here, where any block
// saying "deferred tool" was swept into `mcp-deferred`, and in `src/floor-catalog.js`
// (#109/#113), which already told them apart but stayed a deliberate pure consumer so
// as not to preempt this decision. The layering now inverts — the header detection
// lives HERE and `floor-catalog.js` consumes it — with two consequences:
//
//   • a block may carry SEVERAL populations, so classification is span-based
//     ({@link classifySystemSpans}); the spans TILE the block, which is what stops a
//     split from charging bytes the gain model never saw;
//   • `mcp-deferred` shrinks to what it actually names — the connecting-servers
//     sub-list — at the MODEL level, not just in `floor`'s display. A repo with no MCP
//     server now reports zero `mcp-deferred` bytes, as it always should have.
//
// It is a PURE CONSUMER on top of the existing segmentation — it does NOT touch
// `segmentRequest` (the bench forbids sub-segmenting `src/waste.js`: "modifie le
// produit sous test", bench/SPEC.md §4). Bytes are read through waste.js'
// `canonicalize` so an attribution's `.bytes` is byte-for-byte identical to the
// matching `Segment.bytes` — one byte accounting, summed per lever downstream.
//
// ── Heuristics & CC-version assumption (AC #4) ──────────────────────────────────
// "content + order" per the issue. v1 is CONTENT-driven and sentinel-grounded:
// the bench deliberately embeds a UNIQUE sentinel in each lever's fixture content
// (bench/fixture/CLAUDE.md, hook-persona.txt, the L4 MCP stub tool `t00`), and the
// FT0 fixture is produced THROUGH the bench (issue #70), so those sentinels are
// the on-wire proof of each lever. A block carrying a sentinel maps to its lever
// regardless of position; everything unmatched falls to `harness` (the floor).
//
// Assumed CC build: v2.1.220 linux-x64 sdk-cli, model claude-haiku-4-5-20251001,
// ENABLE_TOOL_SEARCH=true (bench/SPEC.md §0). The textual markers (`<file path=…>`
// AND the real-capture `Contents of <path> (<scope> instructions)` for CLAUDE.md;
// `<session-start-hook` AND the real `SessionStart:<event> hook <status>` line;
// "deferred tool(s)") match a REAL session's blocks, which carry no bench sentinel.
// They were CONFIRMED against the committed FT0 capture (issue #75 / FT5 refined
// them: a real CLAUDE.md block carries only the Contents-of line, a real hook only
// the SessionStart line) — see the self-activating gate in
// test/finetune-system.test.js (AC #1–#2). The `opts`
// seam on `classifySystemBlock` reserves ORDER as a version-specific tie-breaker
// for that refinement pass; v1 never needs it (sentinels + floor-fallback are
// unambiguous), so it is accepted but not yet decisive.

import { canonicalize } from './waste.js';

/** The seven system-bucket sources, in canonical order. */
export const SYSTEM_LEVERS = /** @type {const} */ ([
  'claude-md',
  'hook',
  'mcp-deferred',
  'deferred-tools',
  'skills-catalog',
  'agent-types',
  'harness',
]);

/**
 * The subset of levers that are CATALOG POPULATIONS — the `<system-reminder>` listings
 * Claude Code injects, several of which may ride one block and therefore be carved out of
 * it. In the order a block presents them, which is also `floor`'s stable row order.
 */
export const CATALOG_LEVERS = /** @type {const} */ (['deferred-tools', 'agent-types', 'skills-catalog']);

/**
 * @typedef {(typeof SYSTEM_LEVERS)[number]} SystemLever
 */

/**
 * @typedef {(typeof CATALOG_LEVERS)[number]} CatalogLever
 */

/**
 * @typedef {object} SystemAttribution
 * @property {string} slot          `system#<i>` (or `system` for a bare-string system).
 * @property {SystemLever} lever    The source lever.
 * @property {boolean} floor        True iff this is the incompressible floor (harness / unattributable).
 * @property {string | null} source Per-file source for CLAUDE.md where a path marker is present; else null.
 * @property {number} bytes         Canonical byte length — identical to the waste.js `Segment.bytes` for this slot.
 */

/**
 * @typedef {object} SystemLeverVerdict
 * @property {SystemLever} lever
 * @property {boolean} floor
 * @property {string | null} source
 */

/**
 * One lever's share of a single block. A block carrying several catalog populations
 * yields several spans; the spans of a block TILE it — their texts concatenate back to
 * the block's text and their `.bytes` sum to its canonical byte length.
 * @typedef {object} SystemSpan
 * @property {SystemLever} lever
 * @property {boolean} floor
 * @property {string | null} source
 * @property {string} text    This span's slice of the block's text.
 * @property {number} bytes   This span's share of the block's canonical byte length.
 */

// Bench lever sentinels — the on-wire fingerprint of each lever (issue #70 fixture plan).
const CLAUDEMD_SENTINEL = /CCSNOOP-BENCH-SENTINEL-CLAUDEMD-[0-9a-f]+/;
const PERSONA_SENTINEL = /CCSNOOP-BENCH-SENTINEL-PERSONA-[0-9a-f]+/;
// The L4 MCP stub registers 64 short-named tools; `t00` is the probe name the bench
// (and FT0) assert on. A bare-word match is unambiguous for these stub names.
const MCP_STUB_TOOL = /\bt00\b/;
// The REAL on-wire spelling of an MCP tool is `mcp__<server>__<tool>` — `_` is a word
// character, so the bare-`t00` sentinel above can never match a capture (fixtures
// README, §"the on-wire spelling"). This is the marker that catches an MCP deferred
// listing whose headers a future build words differently: better one coarse
// `mcp-deferred` row than ~30 KB silently dropped to the floor.
const MCP_TOOL_NAME = /\bmcp__[A-Za-z0-9_.-]+__/;

// ── catalog headers — the ONE detection (moved down from floor-catalog.js, #116) ──
//
// Case-sensitive, multiline-anchored: each matches exactly its population (no
// cross-matches), and none appears in a real `body.system` preamble. The `m` flag lets
// `^` match after a newline inside a multi-line block (the header sits one line below the
// `<system-reminder>` wrapper); on a single trimmed line `.test` matches regardless.
const DEFERRED_TOOLS_HDR = /^The following deferred tools are now available via ToolSearch\./m;
const AGENT_TYPES_HDR = /^Available agent types for the Agent tool:/m;
const SKILLS_HDR = /^The following skills are available for use with the Skill tool:/m;
// The MCP sub-list of the deferred listing. This — and ONLY this — is what
// `mcp-deferred` names now: a repo with no MCP server never emits this header, so it
// never reports `mcp-deferred` bytes (issue #116's exit criterion).
const MCP_CONNECTING_HDR = /^The following MCP servers are still connecting/m;

/**
 * The carve points inside one block, in the order they are searched. `mcp-deferred`
 * rides here alongside the three catalogs because on the wire the connecting-servers
 * sub-list sits INSIDE the deferred-tools listing — carving is the only way to charge
 * each half to the lever that owns it.
 * @type {{ lever: SystemLever, re: RegExp }[]}
 */
const POPULATION_HEADERS = [
  { lever: 'deferred-tools', re: DEFERRED_TOOLS_HDR },
  { lever: 'agent-types', re: AGENT_TYPES_HDR },
  { lever: 'skills-catalog', re: SKILLS_HDR },
  { lever: 'mcp-deferred', re: MCP_CONNECTING_HDR },
];

/**
 * The two headers an ENTRY parser must recognize to split the deferred listing into its
 * named items (`floor --detail`): they open the built-in-tool sub-list and the
 * connecting-server sub-list respectively. Exported so the parser reads the same spelling
 * the classifier carves on — DETECTION itself never happens outside this module.
 */
export const SUBLIST_HEADERS = /** @type {const} */ ({
  'deferred-tools': DEFERRED_TOOLS_HDR,
  'mcp-deferred': MCP_CONNECTING_HDR,
});

/**
 * Is this lever one of the catalog populations — the levers a block can be carved into
 * and that `floor` gives a named row to? The single predicate; `finetune-gain.js` and
 * `floor-catalog.js` both ask it rather than each re-deriving the rule, so an eighth lever
 * added later cannot silently be treated as a catalog by one of them and not the other.
 * @param {SystemLever} lever
 * @returns {boolean}
 */
export function isCatalogLever(lever) {
  return /** @type {readonly string[]} */ (CATALOG_LEVERS).includes(lever);
}

// Real-capture markers (CC v2.1.220, the FT0 fixture's format). The sentinels
// above prove each lever in the bench; these match a REAL session's blocks, which
// carry no bench sentinel. `extractSourcePath` / the hook branch consume them; the
// module header promised they would be refined against the capture the instant it
// landed — it has (test/fixtures/finetune/session-963204f5…). The hook envelope
// keys on the `SessionStart:<event> hook <status>` line so a CLAUDE.md file that
// merely *mentions* "SessionStart hook" (no colon, no status) is not swallowed.
const SESSIONSTART_HOOK = /SessionStart:\S+\s+hook\s+(?:success|error|output)/i;
// The path group excludes newlines: a real injection puts path and `(<scope>
// instructions` on ONE line, and letting the group span lines would splice prose
// from the file's body into the "path" — which the CLAUDE.md lever then pastes
// verbatim into `claudeMdExcludes`. A body that merely mentions
// "(project instructions)" on a later line now yields no path (→ managed, cost
// only) instead of a multi-line bogus one.
const CONTENTS_OF_PATH = /Contents of (\S[^()\n]*?)\s+\((?:project|user|local)\s+instructions/i;

/**
 * The text payload of a `system` block — a bare string, or the `text` field of a
 * `{ type: 'text', text, cache_control? }` content block. Never throws.
 * @param {any} block
 * @returns {string}
 */
function blockText(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Extract a per-file source path from a CLAUDE.md block when CC injects one. Two
 * shapes: the interactive `<file path="…">` convention, and the real CC v2.1.220
 * `Contents of <path> (<scope> instructions, …)` line (the FT0 fixture's format).
 * Best-effort — returns null when neither marker is present (a managed/policy
 * block, or an unattributable whole), in which case the block is attributed as a
 * whole (spec §2.3) and the downstream CLAUDE.md lever treats it as inexcludable.
 * @param {string} t
 * @returns {string | null}
 */
function extractSourcePath(t) {
  const file = t.match(/<file\s+path=["']?([^"'>\s]+)["']?/i);
  if (file) return file[1];
  const contents = t.match(CONTENTS_OF_PATH);
  return contents ? contents[1].trim() : null;
}

/**
 * Classify a WHOLE block's text, ignoring any catalog population it may carry. The two
 * levers that own a real action (CLAUDE.md's `claudeMdExcludes`, the hook's
 * `hooks.SessionStart`) are tested FIRST, so a memory file that merely quotes a catalog
 * header stays CLAUDE.md rather than becoming one. Returns null when nothing but a
 * catalog header could still decide the block.
 * @param {string} t
 * @returns {SystemLeverVerdict | null}
 */
function classifyWhole(t) {
  // CLAUDE.md — bench sentinel, an injectable `<file path=…>` marker, or the real
  // CC `Contents of <path> (<scope> instructions)` injection (the FT0 capture's
  // format — a real CLAUDE.md block carries no bench sentinel, so the Contents-of
  // line is what detects it).
  if (CLAUDEMD_SENTINEL.test(t) || /<file\s+path=/i.test(t) || CONTENTS_OF_PATH.test(t)) {
    return { lever: 'claude-md', floor: false, source: extractSourcePath(t) };
  }
  // SessionStart hook — bench persona sentinel, a `<session-start-hook` envelope,
  // or the real CC `SessionStart:<event> hook <status>` output line.
  if (PERSONA_SENTINEL.test(t) || /<session-start-hook/i.test(t) || SESSIONSTART_HOOK.test(t)) {
    return { lever: 'hook', floor: false, source: null };
  }
  return null;
}

/**
 * Locate every catalog population present in a block's text, by char offset, in text
 * order. Empty when the block carries none.
 * @param {string} t
 * @returns {{ lever: SystemLever, at: number }[]}
 */
function populationHits(t) {
  /** @type {{ lever: SystemLever, at: number }[]} */
  const hits = [];
  for (const h of POPULATION_HEADERS) {
    const m = h.re.exec(t);
    if (m) hits.push({ lever: h.lever, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * Carve one `system`/message block into its lever SPANS — the single authority for
 * "which lever owns which bytes of this block" (issue #116). Always returns at least one
 * span, and the spans TILE the block: their texts concatenate back to the block's text
 * and their `.bytes` sum to the block's own canonical byte length. That invariant is what
 * makes a split safe — the gain model can charge each span without a carve ever inventing
 * or losing bytes.
 *
 * Three shapes, in precedence order:
 *   • an actionable lever (CLAUDE.md / hook) claims the whole block;
 *   • one or more catalog headers → one span per population, each running from its header
 *     to the next (the first span starts at char 0, so the `<system-reminder>` envelope is
 *     not lost);
 *   • otherwise one span: an MCP deferred listing by its `mcp__<server>__*` names, else
 *     the harness floor.
 *
 * @param {any} block  One `body.system[i]` or `messages[*].content[j]`.
 * @returns {SystemSpan[]}  Non-empty.
 */
export function classifySystemSpans(block) {
  const t = blockText(block);
  const total = segBytes(block);

  const whole = classifyWhole(t);
  if (whole) return [{ ...whole, text: t, bytes: total }];

  const hits = populationHits(t);
  if (hits.length === 0) {
    const lever = MCP_TOOL_NAME.test(t) || MCP_STUB_TOOL.test(t) ? 'mcp-deferred' : 'harness';
    return [{ lever, floor: lever === 'harness', source: null, text: t, bytes: total }];
  }

  /** @type {SystemSpan[]} */
  const spans = hits.map((h, k) => ({
    lever: h.lever,
    floor: false,
    source: null,
    text: t.slice(k === 0 ? 0 : h.at, k + 1 < hits.length ? hits[k + 1].at : t.length),
    bytes: 0,
  }));
  // Tail spans are measured on their own escaped length; the HEAD span absorbs the
  // remainder — the block's JSON envelope, plus any `cache_control` key `canonicalize`
  // counts. Σ spans is therefore `total` by construction, on any block shape.
  let tail = 0;
  for (let k = 1; k < spans.length; k++) {
    spans[k].bytes = spanBytes(spans[k].text);
    tail += spans[k].bytes;
  }
  spans[0].bytes = total - tail;
  return spans;
}

/**
 * Classify a single `system` block to its source lever (AC #1). The single-verdict view
 * of {@link classifySystemSpans}: a block's lever is its FIRST span's — its dominant
 * population. `opts.index` is reserved for an order-based refinement (v1 is
 * content-sufficient).
 *
 * @param {any} block   One `body.system[i]` (string or `{type:'text',text}` block).
 * @param {{ index?: number, total?: number }} [opts]  Order context (reserved; v1 unused).
 * @returns {SystemLeverVerdict}
 */
export function classifySystemBlock(block, opts = {}) {
  void opts; // order seam — see module header; sentinels + floor-fallback decide v1.
  const { lever, floor, source } = classifySystemSpans(block)[0];
  return { lever, floor, source };
}

/**
 * Attribute every `system` block of a parsed request body (AC #1). One
 * `SystemAttribution` per block, in order; a bare-string `system` yields a single
 * `{ slot: 'system' }` entry. Null-safe. `.bytes` is the canonical byte length,
 * identical to the waste.js `Segment.bytes` for the same slot.
 *
 * @param {any} body  Parsed request JSON (null-safe).
 * @returns {SystemAttribution[]}
 */
export function attributeSystemBlocks(body) {
  if (!body || typeof body !== 'object') return [];
  const sys = body.system;
  if (sys == null) return [];

  if (!Array.isArray(sys)) {
    const v = classifySystemBlock(sys);
    return [{ slot: 'system', ...v, bytes: segBytes(sys) }];
  }

  /** @type {SystemAttribution[]} */
  const out = [];
  sys.forEach((block, i) => {
    out.push({ slot: `system#${i}`, ...classifySystemBlock(block, { index: i, total: sys.length }), bytes: segBytes(block) });
  });
  return out;
}

/**
 * Drop the incompressible-floor blocks (AC #3): the harness and anything
 * unattributable are SHOWN in the diagnostic but NEVER emitted downstream. Returns
 * only the actionable-lever attributions.
 *
 * @param {SystemAttribution[]} attribs
 * @returns {SystemAttribution[]}
 */
export function filterFloor(attribs) {
  return attribs.filter((a) => !a.floor);
}

/**
 * Canonical byte length of a block — delegated to waste.js' `canonicalize` so an
 * attribution's `.bytes` matches the corresponding `Segment.bytes` exactly.
 * @param {any} value
 * @returns {number}
 */
function segBytes(value) {
  return value === undefined || value === null ? 0 : Buffer.byteLength(canonicalize(value), 'utf8');
}

/**
 * The canonical envelope of an EMPTY text block — `{"text":"","type":"text"}`. JSON string
 * escaping is per-character, so `canonicalBytes(t) === ENVELOPE + escaped(t)` and therefore
 * `escaped(a + b) === escaped(a) + escaped(b)`: a span's own byte weight is its escaped
 * text, envelope-free, which is exactly what makes carved spans tile their block.
 */
const ENVELOPE = segBytes({ type: 'text', text: '' });

/**
 * The byte weight of a text SPAN — its escaped length with no block envelope, so the
 * spans of one block sum to that block's canonical byte length.
 * @param {string} textSpan
 * @returns {number}
 */
function spanBytes(textSpan) {
  return segBytes({ type: 'text', text: textSpan }) - ENVELOPE;
}
