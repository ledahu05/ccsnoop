// Fine-tune: the two no-dynamic-proof levers — SessionStart hooks + CLAUDE.md
// (fine-tune-spec §3.3–§3.4, issue #75 / FT5).
//
// The unifying principle (spec Part 3): only levers WITH dynamic proof (built-in
// tools = pre-validated list; MCP = sent-vs-used) may say "unused → remove". Hooks
// and CLAUDE.md have NO dynamic proof — their output is injected every session by
// construction — so they may say only *"costs N bytes"*, **never "unused"**.
//
//   • Hooks — emit removal of `hooks.SessionStart` ONLY when the injected output
//     ≥ `bloatFloorBytes` (the existing waste.js floor — one threshold knob). Below
//     the floor: diagnostic-only. Every emitted removal carries the marker
//     "intent unknown — injected every session; review before applying"; a guard
//     expressed as a caveat, not a confidence threshold (none exists).
//
//   • CLAUDE.md — advice-only (no settings line trims content). Per source file:
//     byte cost + % of system. Suggest `claudeMdExcludes` ONLY for excludable
//     (non-managed) files above the floor; managed files → cost only. Never
//     "unused".
//
// Both scan the request body's TEXT SURFACES — `system[]` AND every
// `messages[*].content` block — because under `-p` CC injects this content into
// the FIRST user message (a `<system-reminder>`), not into `system[]` (the FT0
// fixture confirms it; bench/SPEC.md §4). The lever decision reuses FT3's
// `classifySystemBlock` (the single source of "which lever is this block"); byte
// cost is the canonical byte length (the spec's byte-length proxy — never
// re-tokenized), byte-aligned with how FT3 charges `Segment.bytes`.
//
// Static by construction: the hook output and CLAUDE.md content are identical
// across the corpus (and across a session's turns — every request re-ships them),
// so the lever is profiled on the CHOSEN (primary) session and deduped by taking
// the max block size — the same single-session story the built-in tools deny uses.
//
// Non-negotiables inherited from the spec: bytes never tokens; output is
// advice-to-copy, never auto-applied.

import fs from 'node:fs';
import path from 'node:path';

import { parseRequestBlob } from './report.js';
import { canonicalize, DEFAULT_WASTE_CONFIG } from './waste.js';
import { classifySystemBlock } from './finetune-system.js';

/**
 * The diagnostic caveat every emitted hook removal carries (spec §3.3). A guard
 * expressed in plain words, not a confidence score (no such signal exists for a
 * lever with no dynamic proof).
 */
export const HOOK_INTENT_CAVEAT = 'intent unknown — injected every session; review before applying';

/**
 * Map key standing in for a CLAUDE.md source with no extractable path (managed /
 * unattributable). NUL is the one byte no filesystem path can contain, so it can
 * never collide with a real source. Written as an escape, not a literal control
 * byte, so this file stays text (a raw NUL makes git treat it as binary and the
 * module undiffable).
 */
export const NULL_SOURCE = '\u0000';

/**
 * @typedef {object} ClaudeMdBlock
 * @property {string | null} source  Per-file path (when attribution supports it); null = managed.
 * @property {number} bytes          Canonical byte length of this source's block.
 */

/**
 * @typedef {object} RequestLeverScan
 * @property {number} hookBytes             SessionStart hook output bytes this request.
 * @property {ClaudeMdBlock[]} claudeMd     Per-source CLAUDE.md blocks (deduped by source).
 * @property {number} systemBytes           Bytes of the STATIC system context — `system[]`, every
 *                                          lever block, and every `<system-reminder>`; plain
 *                                          conversation history is excluded (see `visitBlock`).
 *                                          The "% of system" denominator.
 */

/**
 * @typedef {object} LeverProfile
 * @property {string} sessionId
 * @property {number} hookBytes              Max hook output bytes across the session's requests.
 * @property {ClaudeMdBlock[]} claudeMd      Per-source CLAUDE.md blocks, max bytes across requests.
 * @property {number} systemBytes            Max single-request system-context bytes.
 */

/**
 * @typedef {object} HookVerdict
 * @property {number} bytes        SessionStart hook output bytes (the corpus's canonical block size).
 * @property {boolean} aboveFloor  True iff a hook shipped (bytes > 0) AND bytes ≥ `bloatFloorBytes`.
 * @property {boolean} deny        True iff aboveFloor → emit the `hooks.SessionStart` removal.
 */

/**
 * @typedef {object} ClaudeMdSourceVerdict
 * @property {string | null} source  Per-file path, or null (managed / unattributable).
 * @property {number} bytes          Canonical byte length of this source.
 * @property {number} pct            % of the system context, rounded (0 when the context is empty).
 * @property {boolean} excludable    True iff non-managed (a path `claudeMdExcludes` can take).
 * @property {boolean} deny          True iff excludable AND it shipped bytes ≥ floor → suggest
 *                                   `claudeMdExcludes`.
 */

/**
 * @typedef {object} LeverVerdicts
 * @property {number} systemBytes           The % denominator.
 * @property {HookVerdict} hook
 * @property {ClaudeMdSourceVerdict[]} claudeMd
 */

/** Verdicts for a session that ships neither lever — the no-op input for the renderer. */
export const EMPTY_LEVER_VERDICTS = /** @type {LeverVerdicts} */ ({
  systemBytes: 0,
  hook: { bytes: 0, aboveFloor: false, deny: false },
  claudeMd: [],
});

/**
 * The text payload of a content block — a bare string, or the `text` field of a
 * `{ type: 'text', text }` block. Null-safe. (Mirrors the FT3/FT4 helpers.)
 * @param {any} block
 * @returns {string}
 */
function blockTextOf(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Canonical byte length of a block — delegated to waste.js' `canonicalize` so a
 * lever block's bytes use the SAME byte-length proxy as FT3's `Segment.bytes`
 * (one byte accounting, never re-tokenized). Null/undefined → 0.
 * @param {any} block
 * @returns {number}
 */
function blockBytes(block) {
  if (block === undefined || block === null) return 0;
  return Buffer.byteLength(canonicalize(block), 'utf8');
}

/**
 * Whether a CLAUDE.md source is EXCLUDABLE (non-managed): it has a file path
 * `claudeMdExcludes` can take. A managed/policy block (no path marker) is
 * inexcludable — loaded unconditionally, cost only, never an exclude suggestion.
 * @param {string | null} source
 * @returns {boolean}
 */
function isExcludable(source) {
  return source !== null;
}

/**
 * Visit one text surface of a request body, charging its bytes to the right lever
 * (or just the system-context denominator for mcp-deferred / harness reminders).
 *
 * `fromSystem` marks `body.system[]` blocks. The "% of system" denominator is the
 * STATIC system context — `system[]`, any lever block, and any `<system-reminder>`
 * envelope (agents/skills listings CC injects) — NOT plain conversation history,
 * which grows turn over turn and would dilute the percentage.
 * @param {any} block
 * @param {{ hookBytes: number, claudeMd: Map<string, number>, systemBytes: number }} acc
 * @param {boolean} fromSystem
 */
function visitBlock(block, acc, fromSystem) {
  const verdict = classifySystemBlock(block);
  const bytes = blockBytes(block);
  if (fromSystem || verdict.lever !== 'harness' || /<system-reminder/i.test(blockTextOf(block))) {
    acc.systemBytes += bytes;
  }
  if (verdict.lever === 'hook') {
    acc.hookBytes += bytes;
  } else if (verdict.lever === 'claude-md') {
    // Dedup by source within a request (a block re-sent in the same body): keep
    // the larger — the canonical size of that source's contribution.
    const key = verdict.source ?? NULL_SOURCE;
    acc.claudeMd.set(key, Math.max(acc.claudeMd.get(key) ?? 0, bytes));
  }
}

/**
 * Materialize the accumulator's source→bytes map as a `ClaudeMdBlock[]` (null
 * source restored from the placeholder key), in first-seen order.
 * @param {Map<string, number>} map
 * @returns {ClaudeMdBlock[]}
 */
function claudeMdToList(map) {
  return [...map.entries()].map(([k, bytes]) => ({ source: k === NULL_SOURCE ? null : k, bytes }));
}

/**
 * Scan ONE parsed request body's text surfaces (`system[]` + every
 * `messages[*].content` block) for hook + CLAUDE.md lever blocks (AC: the lever
 * finds its blocks wherever CC injects them). Returns per-request byte costs and
 * the total system-context bytes (the "% of system" denominator). Null-safe.
 *
 * @param {any} body  Parsed request JSON.
 * @returns {RequestLeverScan}
 */
export function scanRequestLeverBlocks(body) {
  if (!body || typeof body !== 'object') return { hookBytes: 0, claudeMd: [], systemBytes: 0 };

  /** @type {{ hookBytes: number, claudeMd: Map<string, number>, systemBytes: number }} */
  const acc = { hookBytes: 0, claudeMd: new Map(), systemBytes: 0 };

  const sys = body.system;
  const sysBlocks = Array.isArray(sys) ? sys : sys == null ? [] : [sys];
  for (const b of sysBlocks) visitBlock(b, acc, true);

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c) visitBlock(b, acc, false);
    } else {
      visitBlock(c, acc, false); // a bare-string message content
    }
  }

  return { hookBytes: acc.hookBytes, claudeMd: claudeMdToList(acc.claudeMd), systemBytes: acc.systemBytes };
}

/**
 * The lever profile of ONE captured session: the SessionStart hook output size,
 * the per-source CLAUDE.md blocks, and the system-context size. Walks
 * `manifest.jsonl` in capture order; because every request re-ships the static
 * content, each size is the MAX across requests — robust to a truncated/aborted
 * turn (it contributes nothing rather than shrinking the verdict). The only hard
 * error is a session dir with no readable `manifest.jsonl` (a caller mistake).
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @returns {LeverProfile}
 */
export function sessionLeverProfile(dir, id = path.basename(dir)) {
  const manifestPath = path.join(dir, 'manifest.jsonl');
  /** @type {string} */
  let manifest;
  try {
    manifest = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read manifest.jsonl in ${dir}: ${/** @type {Error} */ (err)?.message ?? err}`);
  }

  let hookBytes = 0;
  /** @type {Map<string, number>} */
  const claudeMd = new Map();
  let systemBytes = 0;

  for (const rawLine of manifest.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    /** @type {any} */
    let line;
    try {
      line = JSON.parse(rawLine);
    } catch {
      continue; // a half-written manifest line — skip, don't crash (mirrors FT2/FT4).
    }
    if (!line || typeof line !== 'object' || typeof line.request_blob !== 'string') continue;
    /** @type {Buffer} */
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, line.request_blob));
    } catch {
      continue; // aborted exchange (request blob never landed) — contributes nothing.
    }
    const scan = scanRequestLeverBlocks(parseRequestBlob(buf).json);
    hookBytes = Math.max(hookBytes, scan.hookBytes);
    systemBytes = Math.max(systemBytes, scan.systemBytes);
    for (const { source, bytes } of scan.claudeMd) {
      const key = source ?? NULL_SOURCE;
      claudeMd.set(key, Math.max(claudeMd.get(key) ?? 0, bytes));
    }
  }

  return { sessionId: id, hookBytes, claudeMd: claudeMdToList(claudeMd), systemBytes };
}

/**
 * Apply the cost floor to a session's lever profile → the emit verdicts (AC).
 * Pure — give it the profile, get back the verdicts; this is what the synthetic
 * floor tests exercise directly. The single reused `bloatFloorBytes` knob gates
 * BOTH levers (spec §3.5 — no new thresholds). CLAUDE.md sources are sorted
 * (excludable paths first, then managed) for a deterministic, paste-ready block.
 *
 * @param {LeverProfile} profile
 * @param {{ floorBytes?: number }} [opts]
 * @returns {LeverVerdicts}
 */
export function buildLeverVerdicts(profile, opts = {}) {
  const floor =
    typeof opts.floorBytes === 'number' && Number.isFinite(opts.floorBytes)
      ? opts.floorBytes
      : DEFAULT_WASTE_CONFIG.bloatFloorBytes;

  const systemBytes = profile?.systemBytes ?? 0;
  const hookBytes = profile?.hookBytes ?? 0;
  // `bytes > 0` is load-bearing, not defensive: a floor of 0 (a caller override)
  // would otherwise clear `bytes >= floor` for a lever that shipped NOTHING, and
  // the block would tell the user to delete a hook / exclude a file never observed.
  // Nothing seen → nothing to emit, at every floor.
  const hookAboveFloor = hookBytes > 0 && hookBytes >= floor;
  const hook = { bytes: hookBytes, aboveFloor: hookAboveFloor, deny: hookAboveFloor };

  /** @type {ClaudeMdSourceVerdict[]} */
  const claudeMd = (profile?.claudeMd ?? []).map(({ source, bytes }) => {
    const excludable = isExcludable(source);
    return {
      source,
      bytes,
      pct: systemBytes > 0 ? Math.round((bytes / systemBytes) * 100) : 0,
      excludable,
      deny: excludable && bytes > 0 && bytes >= floor,
    };
  });
  // Deterministic order: named (excludable) sources alphabetically, managed (null) last.
  claudeMd.sort((a, b) => {
    if (a.source === null && b.source === null) return 0;
    if (a.source === null) return 1;
    if (b.source === null) return -1;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });

  return { systemBytes, hook, claudeMd };
}
