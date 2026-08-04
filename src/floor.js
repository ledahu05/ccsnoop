// ccsnoop floor — turn-1 baseline metric + per-block attribution
// (issue #99, epic #93 — the skill's verify KPI, #96).
//
// The "default context window" *is* the turn-1 floor: everything Claude Code ships
// before you type anything — the harness `system[]` preamble, every tool definition,
// every CLAUDE.md source, every MCP tool, the SessionStart hook output. `floor`
// reports it as one headline number plus a ranked per-block breakdown that shows
// where to cut.
//
// Two measures, kept honest and distinct (issue #99 acceptance):
//
//   • Headline — the REAL turn-1 input tokens, read from captured `usage`
//     (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`).
//     `usage` is request-aggregate and is the one signal we may treat as tokens
//     (aligns #89 — never re-tokenize). On turn 1 a prefix may already be cached
//     (a warm proxy / a resumed session), so all three components are summed — the
//     total is the whole turn-1 prompt regardless of cache state.
//
//   • Per-block breakdown — a BYTE proxy. Per-block TOKEN attribution would require
//     re-tokenizing each block, which is forbidden; byte length is the labelled
//     proxy the rest of ccsnoop uses (`Segment.bytes` via `canonicalize`). The
//     breakdown sums only the FLOOR blocks (tools + system levers) — the static
//     prompt — so it excludes the turn-1 user message, which is conversation, not
//     floor. The two measures therefore agree to within the trivial first message.
//
// Reuse (issue #99 / #93): no new byte accounting. Every per-block figure is the
// turn-1 slice of `computeGain` (`src/finetune-gain.js`) — `gain.tool` (ALL shipped
// tools, not only the denied ones), `gain.claudeMd`, `gain.hook`, `gain.mcp`, and
// `gain.harness` (the incompressible floor). `floor` adds only turn-1 isolation,
// the token headline, and the ranking exposure.
//
// A pure consumer of captured sessions, like report / fine-tune / cache: an offline
// reader of `sessions/`; the daemon is not required.

import { loadSession, resolveRoots, listSessions, pickLatestSession, parseRequestBlob } from './report.js';
import { computeGain } from './finetune-gain.js';
import { NULL_SOURCE } from './finetune-levers.js';

/**
 * The context window the headline % is scored against. The standard Claude window
 * (200 000 tokens) for haiku/sonnet/opus; the 1M-context beta is opt-in and not
 * detectable from a captured request, so the conservative default stands unless the
 * caller overrides it (`--window`). The % is a framing aid, not a measurement — it
 * is labelled with the window it used.
 */
export const DEFAULT_WINDOW_TOKENS = 200000;

/**
 * A byte count as a compact human string (e.g. 8192 → "8.0K"). Mirrors the proxy the
 * rest of the diagnostics use — renders an already-computed byte length, never a
 * re-tokenized estimate.
 * @param {number} bytes
 * @returns {string}
 */
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * An integer with a comma thousands separator (3000 → "3,000"). Tokens are the
 * headline's real unit; grouping them keeps the figure legible next to "200,000".
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @typedef {object} FloorBlock
 * @property {'tool'|'claude-md'|'hook'|'mcp-deferred'|'harness'} kind  The contributor class.
 * @property {string} label   Short human label (tool name, or the lever name).
 * @property {string | null} detail  Per-file source for CLAUDE.md; null otherwise.
 * @property {number} bytes          The turn-1 byte cost (proxy).
 * @property {number} pctOfFloor     round(bytes / totalBytes * 100); 0 when the floor is empty.
 */

/**
 * @typedef {object} FloorHeadline
 * @property {number | null} tokens                    Real turn-1 input tokens (input + cacheCreation + cacheRead), or null.
 * @property {number | null} pctOfWindow               round(tokens / windowTokens * 100); null when tokens is null.
 * @property {number} bytes                            The byte proxy total (Σ attribution bytes).
 * @property {number | null} inputTokens               Turn-1 usage component (null when no usage).
 * @property {number | null} cacheCreationInputTokens  Turn-1 usage component (null when no usage).
 * @property {number | null} cacheReadInputTokens      Turn-1 usage component (null when no usage).
 */

/**
 * @typedef {object} FloorContext
 * @property {string | null} sessionId
 * @property {number} turns            Total exchanges in the session.
 * @property {number | null} turn1Index Always 0 when there is a turn 1; null when empty.
 * @property {string | null} model     Captured request model name (display only).
 * @property {number} windowTokens     The window the headline % was scored against.
 * @property {FloorHeadline} headline
 * @property {FloorBlock[]} attribution  Ranked by `bytes` descending.
 * @property {number} totalBytes         Σ attribution bytes.
 */

/**
 * The pure attribution core: isolate turn 1 and build the floor context from a
 * loaded session model. Turn-1 isolation profiles ONLY the first exchange — every
 * static block is re-shipped each turn, so turn 1 is the canonical floor, and
 * ignoring later turns drops any mid-session mutation from the baseline.
 *
 * The byte figures are the turn-1 slice of {@link module:finetune-gain.computeGain};
 * the headline tokens are the real captured `usage`. Never re-tokenizes. Null-safe:
 * an empty model yields zero totals, an empty attribution, and a null token headline.
 *
 * `exchanges` is left open (`Record<string, any>`) so a loaded report model — whose
 * exchanges carry `turn`, `usage`, `requestBlob`, `segments`, `anatomy`, … — and a
 * hand-built test model both fit without restating the full report exchange type.
 *
 * @param {{ sessionId?: string, exchanges?: Array<Record<string, any>> }} model
 * @param {{ windowTokens?: number }} [opts]
 * @returns {FloorContext}
 */
export function computeFloor(model, opts = {}) {
  const windowTokens =
    typeof opts.windowTokens === 'number' && Number.isFinite(opts.windowTokens) && opts.windowTokens > 0
      ? opts.windowTokens
      : DEFAULT_WINDOW_TOKENS;
  const exchanges = model?.exchanges ?? [];
  const turn1 = exchanges[0] ?? null;
  const turns = exchanges.length;

  // Turn-1 isolation: attribute the floor from the FIRST exchange only.
  const gain = computeGain({ exchanges: turn1 ? [turn1] : [] });

  // ── headline: real turn-1 input tokens from captured usage ──────────────────
  const u = turn1?.usage ?? null;
  const hasUsage = Boolean(u);
  const inputTokens = u?.inputTokens ?? 0;
  const cacheCreationInputTokens = u?.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = u?.cacheReadInputTokens ?? 0;
  const tokens = hasUsage ? inputTokens + cacheCreationInputTokens + cacheReadInputTokens : null;
  const pctOfWindow = hasUsage && windowTokens > 0 ? Math.round((tokens / windowTokens) * 100) : null;

  // ── per-block attribution: one block per contributor, then rank by byte cost ─
  /** @type {{ kind: FloorBlock['kind'], label: string, detail: string | null, bytes: number }[]} */
  const blocks = [];
  // Tools — one block PER tool (gain.tool holds ALL shipped tools, not only denied).
  for (const [name, g] of gain.tool) {
    blocks.push({ kind: 'tool', label: name, detail: null, bytes: g.shipped });
  }
  // CLAUDE.md — one block per source (path, or NULL_SOURCE for managed).
  for (const [source, g] of gain.claudeMd) {
    blocks.push({
      kind: 'claude-md',
      label: 'CLAUDE.md',
      detail: source === NULL_SOURCE ? null : source,
      bytes: g.shipped,
    });
  }
  if (gain.hook.shipped > 0) {
    blocks.push({ kind: 'hook', label: 'SessionStart hook', detail: null, bytes: gain.hook.shipped });
  }
  if (gain.mcp.shipped > 0) {
    blocks.push({ kind: 'mcp-deferred', label: 'MCP deferred listing', detail: null, bytes: gain.mcp.shipped });
  }
  if (gain.harness.shipped > 0) {
    blocks.push({ kind: 'harness', label: 'system[] preamble', detail: null, bytes: gain.harness.shipped });
  }

  const totalBytes = blocks.reduce((s, b) => s + b.bytes, 0);
  const attribution = blocks
    .map((b) => ({ ...b, pctOfFloor: totalBytes > 0 ? Math.round((b.bytes / totalBytes) * 100) : 0 }))
    .sort((a, b) => b.bytes - a.bytes);

  const modelName = parseRequestBlob(turn1?.requestBlob ?? '').json?.model ?? null;

  return {
    sessionId: model?.sessionId ?? null,
    turns,
    turn1Index: turns > 0 ? 0 : null,
    model: modelName,
    windowTokens,
    headline: {
      tokens,
      pctOfWindow,
      bytes: totalBytes,
      inputTokens: hasUsage ? inputTokens : null,
      cacheCreationInputTokens: hasUsage ? cacheCreationInputTokens : null,
      cacheReadInputTokens: hasUsage ? cacheReadInputTokens : null,
    },
    attribution,
    totalBytes,
  };
}

/**
 * The display label for one attribution block (e.g. `tool: Read`, `CLAUDE.md <path>`).
 * @param {FloorBlock} a
 * @returns {string}
 */
function blockLabel(a) {
  switch (a.kind) {
    case 'tool':
      return `tool: ${a.label}`;
    case 'claude-md':
      return a.detail ? `CLAUDE.md ${a.detail}` : 'CLAUDE.md (managed)';
    case 'hook':
      return 'hook — SessionStart output';
    case 'mcp-deferred':
      return 'MCP — deferred tool listing';
    case 'harness':
      return 'harness — system[] preamble';
    default:
      return a.label;
  }
}

/** Column widths of the per-block table; the header and every row share them. */
const COL = { block: 42, bytes: 9, pct: 5 };
const RULE = '─'.repeat(COL.block + 1 + COL.bytes + 2 + COL.pct + 1);

/**
 * Render a floor context as CLI text: the headline (real tokens + % of the window,
 * then the byte proxy) and the ranked per-block table with a total. Pure — give it
 * the context, get back the lines. Mirrors the shape of `renderFineTune` /
 * `renderCache`.
 *
 * @param {FloorContext} ctx
 * @returns {{ lines: string[] }}
 */
export function renderFloor(ctx) {
  /** @type {string[]} */
  const lines = [];
  const turnLbl = ctx.turns > 0 ? `turn 1 of ${ctx.turns}` : 'turn 1 (no exchanges)';
  lines.push(`ccsnoop floor — session ${ctx.sessionId ?? '?'} (${turnLbl})`);
  if (ctx.model) lines.push(`model: ${ctx.model}`);
  lines.push('');

  // Headline.
  lines.push('Headline');
  if (ctx.headline.tokens !== null) {
    lines.push(
      `  floor: ${fmtTokens(ctx.headline.tokens)} tokens  ` +
        `(${ctx.headline.pctOfWindow}% of a ${fmtTokens(ctx.windowTokens)}-token window; pass --window to override)`
    );
  } else {
    lines.push('  floor: no captured usage — real tokens unavailable for this session');
  }
  lines.push(
    `  proxy: ${fmtBytes(ctx.totalBytes)} bytes — the turn-1 prompt's static blocks, by byte length (never re-tokenized)`
  );
  lines.push('');

  // Per-block attribution, ranked by byte cost.
  lines.push('Per-block attribution — ranked by byte cost (proxy)');
  lines.push(`  ${'block'.padEnd(COL.block)} ${'bytes'.padStart(COL.bytes)}  ${'% floor'.padStart(COL.pct)}`);
  lines.push(`  ${RULE}`);
  for (const a of ctx.attribution) {
    lines.push(
      `  ${blockLabel(a).padEnd(COL.block)} ${fmtBytes(a.bytes).padStart(COL.bytes)}  ${String(a.pctOfFloor).padStart(COL.pct)}%`
    );
  }
  lines.push(`  ${RULE}`);
  lines.push(`  ${'total'.padEnd(COL.block)} ${fmtBytes(ctx.totalBytes).padStart(COL.bytes)}  ${'100'.padStart(COL.pct)}%`);
  return { lines };
}

/**
 * Entry point. Resolve + load one session, isolate turn 1, and report the floor.
 * Discovery mirrors `report` / `fine-tune` / `cache` (`--root` / `--sessions-dir` /
 * `--session`); the default is the most-recent session — `floor` is a per-session,
 * turn-1 metric, so there is no corpus mode. `--latest` is accepted for symmetry and
 * is a no-op (the default already is latest). An offline reader of `sessions/`; the
 * daemon is not required.
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, session?: string, windowTokens?: number }} [opts]
 * @returns {FloorContext & { lines: string[] }}
 */
export function floor(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = resolveRoots({ cwd, root: opts.root, all: false, sessionsDir: opts.sessionsDir });
  const sessions = roots.flatMap((r) => listSessions(r));
  if (sessions.length === 0) {
    throw new Error(
      `no captured sessions found under ${roots.join(', ')} — run 'ccsnoop start' first, or pass --root <path>`
    );
  }

  let chosen;
  if (opts.session) {
    chosen = sessions.find((s) => s.id === opts.session);
    if (!chosen) {
      throw new Error(`session '${opts.session}' not found (have: ${sessions.map((s) => s.id).join(', ')})`);
    }
  } else {
    chosen = /** @type {{ id: string, dir: string, mtimeMs: number }} */ (pickLatestSession(sessions));
  }

  const model = loadSession(chosen.dir, chosen.id);
  const ctx = computeFloor(model, { windowTokens: opts.windowTokens });
  const { lines } = renderFloor(ctx);
  return { ...ctx, lines };
}
