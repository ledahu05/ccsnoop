// Fine-tune: split the `system` bucket by source (fine-tune-spec §2.3, issue #73 / FT3).
//
// `src/waste.js` already segments every request into `system` / `tools` /
// `history` / `currentTurn`, one `system#<i>` segment per `system` block. But the
// `system` bucket itself MIXES four sources the fine-tune levers care about:
//
//   • claude-md      — CLAUDE.md-derived memory (project `./CLAUDE.md`, global, …)
//   • hook           — SessionStart-hook output injected into the system prompt
//   • mcp-deferred   — the MCP deferred tool listing (names only under tool-search)
//   • harness        — the CC identity/capabilities preamble; the incompressible floor
//
// This module attributes each `system` block to exactly one of them so the
// downstream fine-tune levers (T5/T6) can charge `Segment.bytes` to the right
// place and flag the harness floor as "shown but never actionable".
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
// ENABLE_TOOL_SEARCH=true (bench/SPEC.md §0). The conservative textual markers
// (`<file path=…>` for CLAUDE.md, `<session-start-hook`, "deferred tool(s)") are
// best-effort aids for real-CC blocks that carry no bench sentinel; they are
// CONFIRMED/REFINED against the real FT0 capture the instant it lands — see the
// self-activating gate in test/finetune-system.test.js (AC #1–#2). The `opts`
// seam on `classifySystemBlock` reserves ORDER as a version-specific tie-breaker
// for that refinement pass; v1 never needs it (sentinels + floor-fallback are
// unambiguous), so it is accepted but not yet decisive.

import { canonicalize } from './waste.js';

/** The four system-bucket sources, in canonical order. */
export const SYSTEM_LEVERS = /** @type {const} */ (['claude-md', 'hook', 'mcp-deferred', 'harness']);

/**
 * @typedef {(typeof SYSTEM_LEVERS)[number]} SystemLever
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

// Bench lever sentinels — the on-wire fingerprint of each lever (issue #70 fixture plan).
const CLAUDEMD_SENTINEL = /CCSNOOP-BENCH-SENTINEL-CLAUDEMD-[0-9a-f]+/;
const PERSONA_SENTINEL = /CCSNOOP-BENCH-SENTINEL-PERSONA-[0-9a-f]+/;
// The L4 MCP stub registers 64 short-named tools; `t00` is the probe name the bench
// (and FT0) assert on. A bare-word match is unambiguous for these stub names.
const MCP_STUB_TOOL = /\bt00\b/;

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
 * Extract a per-file source path from a CLAUDE.md block when CC injects one (the
 * `<file path="…">` convention). Best-effort — returns null when no marker is
 * present, in which case the block is attributed as a whole (spec §2.3).
 * @param {string} t
 * @returns {string | null}
 */
function extractSourcePath(t) {
  const m = t.match(/<file\s+path=["']?([^"'>\s]+)["']?/i);
  return m ? m[1] : null;
}

/**
 * Classify a single `system` block to its source lever (AC #1). Content-driven:
 * a bench sentinel (or a conservative real-CC marker) maps a block to its lever;
 * anything unmatched is the harness floor. `opts.index` is reserved for an
 * order-based refinement once the real FT0 capture lands (v1 is content-sufficient).
 *
 * @param {any} block   One `body.system[i]` (string or `{type:'text',text}` block).
 * @param {{ index?: number, total?: number }} [opts]  Order context (reserved; v1 unused).
 * @returns {SystemLeverVerdict}
 */
export function classifySystemBlock(block, opts = {}) {
  void opts; // order seam — see module header; sentinels + floor-fallback decide v1.
  const t = blockText(block);

  // CLAUDE.md — bench sentinel, or an injectable memory-file path marker.
  if (CLAUDEMD_SENTINEL.test(t) || /<file\s+path=/i.test(t)) {
    return { lever: 'claude-md', floor: false, source: extractSourcePath(t) };
  }
  // SessionStart hook — bench persona sentinel, or a hook-output envelope.
  if (PERSONA_SENTINEL.test(t) || /<session-start-hook/i.test(t)) {
    return { lever: 'hook', floor: false, source: null };
  }
  // MCP deferred listing — the L4 stub tool name, or a deferred-tools listing phrase.
  if (MCP_STUB_TOOL.test(t) || /deferred\s+(?:tool|mcp)/i.test(t)) {
    return { lever: 'mcp-deferred', floor: false, source: null };
  }
  // The CC harness / anything unattributable — the incompressible floor (AC #3).
  return { lever: 'harness', floor: true, source: null };
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
