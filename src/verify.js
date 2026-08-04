// ccsnoop verify — the before/after floor delta (issue #96, epic #94).
//
// `verify` closes the tuning loop the context-tuning skill (#94) drives. Given two
// already-captured sessions — a **before** and an **after** that together form one
// *tuning session* — it computes the turn-1 floor (#99, `computeFloor`) on each and
// diffs them, proving whether the tuning **lowered** the floor and by how much. `floor`
// (#99) is the measurement; `verify` is the proof — the before/after delta that turns a
// one-shot metric into a tuning result.
//
// It is explicitly the post-MVP phase per #94's recommended phasing — but only on the
// skill side. The ccsnoop primitive itself is independent of the skill artifact (#97)
// and the apply tier (#98): #97's own acceptance says "verify delegates to gap 4", so
// the skill calls this command. Shipping the ccsnoop-side primitive now de-risks #97.
//
// This is two `computeFloor` calls + a diff + a renderer, NOT new measurement:
//   • Headline delta — REAL turn-1 input tokens, read from each side's captured `usage`
//     (`input + cacheCreation + cacheRead`). Never re-tokenized (aligns #89).
//   • Per-block delta — a BYTE proxy, matched block-by-block across the two floors and
//     ranked by the size of the change, so a reader sees which contributors grew and
//     which shrank.
//
// A pure offline reader of two already-captured sessions. It does NOT drive capture
// (the daemon's job via `start`/`stop`, orchestrated by the skill in #97) and does NOT
// decide which two sessions pair (the skill's job). It takes `--before <id>` and
// `--after <id>`, resolves each via the shared report discovery, and diffs.

import { loadSession, resolveRoots, listSessions } from './report.js';
import { computeFloor, DEFAULT_WINDOW_TOKENS, fmtBytes, fmtTokens, blockLabel } from './floor.js';
import { SCHEMA_URL, SCHEMA_VERSION } from './finetune-json.js';
import { fitLabel } from './format.js';

/**
 * The contract note — every token figure is real captured usage; every per-block
 * figure is a byte-length proxy; the window is scored identically on both sides so the
 * delta is apples-to-apples; ccsnoop emits the pairing, it does not decide it.
 */
const NOTE =
  'Before/after floor delta for two captured sessions (a tuning session). The token ' +
  'headline delta is real turn-1 captured usage (input + cacheCreation + cacheRead), ' +
  'never re-tokenized; every per-block figure is a byte-length proxy (Segment.bytes). ' +
  'The window is scored identically on both sides so the delta is apples-to-apples. ' +
  'ccsnoop emits the session pairing (session.before / session.after); it does not ' +
  'decide which two sessions pair.';

/**
 * @typedef {'lowered' | 'raised' | 'flat'} Verdict
 */

/**
 * @typedef {object} BlockDelta
 * @property {import('./floor.js').FloorBlock['kind']} kind  The contributor class.
 * @property {string} label       Short human label (tool name, or the lever name).
 * @property {string | null} detail  Per-file source for CLAUDE.md; null otherwise.
 * @property {number} beforeBytes The before floor's byte cost for this block (0 when absent).
 * @property {number} afterBytes  The after floor's byte cost for this block (0 when absent).
 * @property {number} delta       afterBytes − beforeBytes (negative = shrank).
 * @property {'grew' | 'shrank' | 'flat'} direction  Sign of `delta` as a word.
 */

/**
 * Resolve the context window the same way `computeFloor` does, so a caller passing a
 * usable override and a caller passing nothing both land on one value scored identically
 * on both sides. Garbage (0, negative, NaN) falls back to the conservative 200k default.
 * @param {number | undefined} v
 * @returns {number}
 */
function resolveWindow(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_TOKENS;
}

/**
 * The verdict from two comparable headline figures (tokens when both sides captured
 * usage, bytes otherwise). `after < before` ⇒ the tuning lowered the floor.
 * @param {number} before
 * @param {number} after
 * @returns {Verdict}
 */
function verdictOf(before, after) {
  if (after < before) return 'lowered';
  if (after > before) return 'raised';
  return 'flat';
}

/**
 * The relative delta as an integer % of the before floor: round(Δ / before * 100). Null
 * when the before floor is zero (no meaningful % of zero) — the absolute Δ still stands.
 * @param {number} absolute
 * @param {number} before
 * @returns {number | null}
 */
function relativeOf(absolute, before) {
  return before !== 0 ? Math.round((absolute / before) * 100) : null;
}

/**
 * The stable key two attribution blocks match across the before/after floors on. A block
 * is the same contributor iff its kind, label and detail agree. `JSON.stringify` of the
 * `[kind, label, detail]` triple is collision-free for ANY field contents (a CLAUDE.md
 * path may contain spaces or punctuation; this never smushes two triples together) and,
 * unlike a raw delimiter, holds no control byte. Internal — not serialized in the block.
 * @param {{ kind: string, label: string, detail: string | null }} b
 * @returns {string}
 */
function blockKey(b) {
  return JSON.stringify([b.kind, b.label, b.detail ?? null]);
}

/**
 * Match the two floors' attribution block-by-block and produce the per-block byte delta.
 * A block present on only one side reads 0 on the other (a tool added after = "grew", a
 * tool removed after = "shrank"). Ranked by the ABSOLUTE change (biggest movers first),
 * tiebroken by total size, then label, then detail so the order is total and deterministic.
 *
 * @param {Array<{ kind: import('./floor.js').FloorBlock['kind'], label: string, detail: string | null, bytes: number }>} beforeAttr
 * @param {Array<{ kind: import('./floor.js').FloorBlock['kind'], label: string, detail: string | null, bytes: number }>} afterAttr
 * @returns {BlockDelta[]}
 */
function computeBlockDeltas(beforeAttr, afterAttr) {
  const beforeMap = new Map(beforeAttr.map((b) => [blockKey(b), b]));
  const afterMap = new Map(afterAttr.map((b) => [blockKey(b), b]));
  /** @type {BlockDelta[]} */
  const rows = [];
  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const bb = beforeMap.get(key);
    const ab = afterMap.get(key);
    const ref = ab ?? bb; // present on at least one side; carry its kind/label/detail
    const beforeBytes = bb?.bytes ?? 0;
    const afterBytes = ab?.bytes ?? 0;
    const delta = afterBytes - beforeBytes;
    rows.push({
      kind: ref.kind,
      label: ref.label,
      detail: ref.detail ?? null,
      beforeBytes,
      afterBytes,
      delta,
      direction: delta < 0 ? 'shrank' : delta > 0 ? 'grew' : 'flat',
    });
  }
  rows.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      b.beforeBytes + b.afterBytes - (a.beforeBytes + a.afterBytes) ||
      a.label.localeCompare(b.label) ||
      // Two CLAUDE.md blocks share one label; `detail` (the source path) is what
      // distinguishes them, so it completes the order.
      (a.detail ?? '').localeCompare(b.detail ?? '')
  );
  return rows;
}

/**
 * A byte figure with an explicit sign for a delta cell: `+2.1K` / `-2.1K` / `0`.
 * @param {number} n
 * @returns {string}
 */
function signedBytes(n) {
  const mag = fmtBytes(Math.abs(n));
  return n > 0 ? `+${mag}` : n < 0 ? `-${mag}` : mag;
}

/**
 * A token figure with an explicit sign for a delta cell: `+600` / `-600` / `0`.
 * @param {number} n
 * @returns {string}
 */
function signedTokens(n) {
  const mag = fmtTokens(Math.abs(n));
  return n > 0 ? `+${mag}` : n < 0 ? `-${mag}` : mag;
}

/**
 * The parenthetical that qualifies a delta cell: `+20% of the before floor` /
 * `-20% of the before floor`. A null relative (a zero before baseline) is rendered as
 * words — the WHOLE phrase, not just the figure, so the caller's parentheses wrap one
 * legible clause instead of nesting a second pair inside them.
 * @param {number | null} rel
 * @returns {string}
 */
function relPhrase(rel) {
  if (rel === null) return 'no % — zero before baseline';
  return `${rel > 0 ? '+' : ''}${rel}% of the before floor`;
}

/**
 * The pure delta core: compute the floor on each side via `computeFloor`, then diff.
 * Turn-1 isolation is inherited from `computeFloor` (each side profiles only its first
 * exchange); the headline delta is the real captured `usage`; the per-block delta is a
 * byte proxy. Never re-tokenizes. Null-safe: a side with no usage yields a null token
 * headline, and the verdict then falls back to the byte proxy.
 *
 * @param {{ sessionId?: string, exchanges?: Array<Record<string, any>> }} beforeModel
 * @param {{ sessionId?: string, exchanges?: Array<Record<string, any>> }} afterModel
 * @param {{ windowTokens?: number }} [opts]
 * @returns {{
 *   before: import('./floor.js').FloorContext,
 *   after: import('./floor.js').FloorContext,
 *   windowTokens: number,
 *   delta: {
 *     tokens: { before: number | null, after: number | null, absolute: number | null, relative: number | null, source: string },
 *     bytes: { before: number, after: number, absolute: number, relative: number | null, source: string, blocks: BlockDelta[] },
 *     verdict: Verdict,
 *     basis: 'tokens' | 'bytes',
 *   },
 * }}
 */
export function computeVerify(beforeModel, afterModel, opts = {}) {
  const windowTokens = resolveWindow(opts.windowTokens);
  const before = computeFloor(beforeModel, { windowTokens });
  const after = computeFloor(afterModel, { windowTokens });

  // ── headline: real turn-1 tokens, diffed ─────────────────────────────────────
  const beforeTokens = before.headline.tokens;
  const afterTokens = after.headline.tokens;
  const tokenBasis = beforeTokens !== null && afterTokens !== null;
  const tokensAbsolute = tokenBasis ? afterTokens - beforeTokens : null;
  const tokensRelative = tokenBasis ? relativeOf(/** @type {number} */ (tokensAbsolute), beforeTokens) : null;

  // ── byte proxy: total + per-block deltas ─────────────────────────────────────
  const beforeBytes = before.totalBytes;
  const afterBytes = after.totalBytes;
  const bytesAbsolute = afterBytes - beforeBytes;
  const bytesRelative = relativeOf(bytesAbsolute, beforeBytes);
  const blocks = computeBlockDeltas(before.attribution, after.attribution);

  // ── verdict: tokens when both sides captured usage, else the byte proxy ──────
  const basis = tokenBasis ? 'tokens' : 'bytes';
  const verdict = basis === 'tokens' ? verdictOf(beforeTokens, afterTokens) : verdictOf(beforeBytes, afterBytes);

  return {
    before,
    after,
    windowTokens,
    delta: {
      tokens: {
        before: beforeTokens,
        after: afterTokens,
        absolute: tokensAbsolute,
        relative: tokensRelative,
        source: 'real turn-1 captured usage (input + cacheCreation + cacheRead), never re-tokenized',
      },
      bytes: {
        before: beforeBytes,
        after: afterBytes,
        absolute: bytesAbsolute,
        relative: bytesRelative,
        source: 'byte-length proxy (Segment.bytes), never re-tokenized',
        blocks,
      },
      verdict,
      basis,
    },
  };
}

/**
 * Per-block table column widths; the header, rule and every row share them. Every block
 * label passes through {@link module:format.fitLabel}, which pads OR elides to exactly
 * `block` characters — a CLAUDE.md source is an absolute path and would otherwise shove
 * the before/after/Δ cells right on precisely the rows this table exists to compare.
 */
const VCOL = { block: 44, before: 8, after: 8, delta: 10 };
const VRULE = '─'.repeat(VCOL.block + 1 + VCOL.before + 1 + VCOL.after + 2 + VCOL.delta);

/**
 * One row of the per-block delta table in the shared columns: the block label (fitted to
 * the label column — padded, or middle-elided when it overruns), the before / after byte
 * cells and the signed Δbytes cell (right-aligned). Cells are pre-rendered strings so the
 * same formatter lays out the header, every block row and the total.
 * @param {string} block
 * @param {string} beforeCell
 * @param {string} afterCell
 * @param {string} deltaCell
 * @returns {string}
 */
function vRow(block, beforeCell, afterCell, deltaCell) {
  return `  ${fitLabel(block, VCOL.block)} ${beforeCell.padStart(VCOL.before)} ${afterCell.padStart(VCOL.after)}  ${deltaCell.padStart(VCOL.delta)}`;
}

/**
 * The one-line verdict summary. Names the verdict, the magnitude (tokens when both sides
 * captured usage, else the byte proxy), the % of the before floor, and — for the byte
 * basis — that real tokens were unavailable. The byte-basis caveat is appended to EVERY
 * verdict including `flat`: "the floors match" on a byte proxy is a weaker claim than the
 * same words backed by real tokens, and the reader has to be able to tell which they got.
 * @param {{ verdict: Verdict, basis: 'tokens' | 'bytes',
 *   tokens: { absolute: number | null, relative: number | null },
 *   bytes: { absolute: number, relative: number | null } }} delta
 * @returns {string}
 */
function verdictLine(delta) {
  const basisNote = delta.basis === 'tokens' ? '' : ' — real tokens unavailable; byte-proxy basis';
  if (delta.verdict === 'flat') return `verdict: FLAT — the before and after floors match${basisNote}`;
  const word = delta.verdict === 'lowered' ? 'LOWERED' : 'RAISED';
  const dir = delta.verdict === 'lowered' ? 'below' : 'above';
  const d = delta.basis === 'tokens' ? delta.tokens : delta.bytes;
  const mag =
    delta.basis === 'tokens' ? `${fmtTokens(Math.abs(d.absolute))} tokens` : `${fmtBytes(Math.abs(d.absolute))} bytes`;
  const pct = d.relative !== null ? `(${Math.abs(d.relative)}% of the before floor)` : '(zero before baseline)';
  return `verdict: FLOOR ${word} — the after floor sits ${mag} ${pct} ${dir} the before floor${basisNote}`;
}

/**
 * Render a verify context as CLI text: the session pairing + window, the real-token
 * headline delta, the byte-proxy total delta, the ranked per-block table, and the
 * verdict line. Pure — give it the context, get back the lines. Mirrors the shape of
 * `renderFloor`.
 *
 * @param {ReturnType<typeof computeVerify>} ctx
 * @returns {{ lines: string[] }}
 */
export function renderVerify(ctx) {
  /** @type {string[]} */
  const lines = [];
  lines.push('ccsnoop verify — before/after floor delta');
  lines.push(`before: ${ctx.before.sessionId ?? '?'}    after: ${ctx.after.sessionId ?? '?'}`);
  lines.push(`window: ${fmtTokens(ctx.windowTokens)} tokens — scored identically on both sides`);
  lines.push('');

  // Headline — real turn-1 tokens from captured usage.
  const t = ctx.delta.tokens;
  lines.push('Headline — real turn-1 tokens from captured usage');
  if (t.before !== null && t.after !== null) {
    lines.push(`  before: ${fmtTokens(t.before)} tokens  (${ctx.before.headline.pctOfWindow}% of window)`);
    lines.push(`  after:  ${fmtTokens(t.after)} tokens  (${ctx.after.headline.pctOfWindow}% of window)`);
    lines.push(`  delta:  ${signedTokens(/** @type {number} */ (t.absolute))} tokens  (${relPhrase(t.relative)})`);
  } else {
    lines.push('  real turn-1 tokens unavailable on at least one side (no captured usage)');
    lines.push('  delta:  verdict falls back to the byte proxy below');
  }
  lines.push('');

  // Byte proxy — per-block byte-length totals.
  const b = ctx.delta.bytes;
  lines.push('Byte proxy — per-block byte-length totals (never re-tokenized)');
  lines.push(`  before: ${fmtBytes(b.before)} bytes`);
  lines.push(`  after:  ${fmtBytes(b.after)} bytes`);
  lines.push(`  delta:  ${signedBytes(b.absolute)} bytes  (${relPhrase(b.relative)})`);
  lines.push('');

  // Per-block delta, ranked by absolute byte change.
  lines.push('Per-block delta — ranked by absolute byte change (proxy; − shrank, + grew)');
  lines.push(vRow('block', 'before', 'after', 'Δbytes'));
  lines.push(`  ${VRULE}`);
  if (b.blocks.length === 0) {
    lines.push('  (nothing attributed on either side — no turn-1 request body captured)');
  }
  for (const row of b.blocks) {
    lines.push(vRow(blockLabel(row), fmtBytes(row.beforeBytes), fmtBytes(row.afterBytes), signedBytes(row.delta)));
  }
  if (b.blocks.length > 0) {
    lines.push(`  ${VRULE}`);
    lines.push(vRow('total', fmtBytes(b.before), fmtBytes(b.after), signedBytes(b.absolute)));
  }
  lines.push('');

  lines.push(verdictLine(ctx.delta));
  return { lines };
}

/**
 * Project one {@link computeFloor} result into the JSON block shape (`id` + `headline`
 * + `attribution`) the `tuning-session` contract carries for each side.
 * @param {import('./floor.js').FloorContext} fc
 */
function floorBlock(fc) {
  return { id: fc.sessionId, headline: fc.headline, attribution: fc.attribution };
}

/**
 * Build the versioned `tuning-session/v1` contract from a verify context. Pure — no I/O.
 * The return value is JSON-serializable as-is. Reuses the generic `tuning-report/v1`
 * envelope (issue #95) with `kind: "tuning-session"`; a consumer switches on `kind`.
 *
 * The contract carries a `before` block and an `after` block (each the floor headline +
 * attribution) and a `delta` block (token delta, byte delta with per-block breakdown,
 * verdict). The two session ids are serialized at `session.before` / `session.after` so
 * the pairing is durable in the artifact ccsnoop emits.
 *
 * @param {ReturnType<typeof computeVerify>} ctx
 * @returns {Record<string, any>}
 */
export function buildVerifyJson(ctx) {
  return {
    $schema: SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    kind: 'tuning-session',
    unit: 'tokens',
    session: { before: ctx.before.sessionId, after: ctx.after.sessionId },
    window: ctx.windowTokens,
    note: NOTE,
    before: floorBlock(ctx.before),
    after: floorBlock(ctx.after),
    delta: {
      tokens: ctx.delta.tokens,
      bytes: ctx.delta.bytes,
      verdict: ctx.delta.verdict,
      basis: ctx.delta.basis,
    },
  };
}

/**
 * Entry point. Resolve + load the two named sessions, compute each floor, and report the
 * before/after delta. Discovery mirrors `floor` / `report` / `fine-tune` (`--root` /
 * `--sessions-dir`); `--before` and `--after` are required (ccsnoop emits the pairing,
 * it does not decide it). A missing id errors naming the available sessions, mirroring
 * `floor()`. An offline reader of `sessions/`; the daemon is not required.
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, before?: string, after?: string, windowTokens?: number }} [opts]
 * @returns {ReturnType<typeof computeVerify> & { lines: string[], json: Record<string, any> }}
 */
export function verify(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = resolveRoots({ cwd, root: opts.root, all: false, sessionsDir: opts.sessionsDir });
  const sessions = roots.flatMap((r) => listSessions(r));
  if (sessions.length === 0) {
    throw new Error(
      `no captured sessions found under ${roots.join(', ')} — run 'ccsnoop start' first, or pass --root <path>`
    );
  }
  const available = sessions.map((s) => s.id).join(', ');
  if (!opts.before || !opts.after) {
    throw new Error(`verify needs --before <id> and --after <id> (have: ${available})`);
  }
  /** @param {string} id @param {'before' | 'after'} which */
  const resolve = (id, which) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new Error(`${which} session '${id}' not found (have: ${available})`);
    return s;
  };
  const beforeModel = loadSession(resolve(opts.before, 'before').dir, opts.before);
  const afterModel = loadSession(resolve(opts.after, 'after').dir, opts.after);

  const ctx = computeVerify(beforeModel, afterModel, { windowTokens: opts.windowTokens });
  const { lines } = renderVerify(ctx);
  const json = buildVerifyJson(ctx);
  return { ...ctx, lines, json };
}
