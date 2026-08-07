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
 * re-tokenized estimate. Exported so `verify`'s before/after byte cells format
 * identically to `floor`'s table — one byte proxy, one rendering.
 * @param {number} bytes
 * @returns {string}
 */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * An integer with a comma thousands separator (3000 → "3,000"). Tokens are the
 * headline's real unit; grouping them keeps the figure legible next to "200,000".
 * Exported so `verify`'s before/after token cells format identically to `floor`'s.
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n) {
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
 * @property {number | null} turn1Index Index of the exchange the floor was taken from — the first exchange shipping the static floor (NOT always 0: an interactive session's exchanges[0] is a preflight probe). Null when empty.
 * @property {string | null} model     Captured request model name (display only).
 * @property {number} windowTokens     The window the headline % was scored against.
 * @property {FloorHeadline} headline
 * @property {FloorBlock[]} attribution  Ranked by `bytes` descending.
 * @property {number} totalBytes         Σ attribution bytes.
 */

/**
 * The byte floor below which a request is assumed to carry no static floor. Claude
 * Code's interactive preflight is a ~1 KB probe; the real conversation opening is
 * tens of KB. Used only as the fallback when no exchange ships a recognizable
 * tools[]/system[] (a degraded capture), to pick a substantial request over a tiny one.
 */
const TURN1_BYTE_FLOOR = 4096;

/**
 * Whether an exchange ships the static floor — a non-empty `tools[]` and/or `system[]`
 * in its parsed request body. The interactive preflight Claude Code emits before turn 1
 * carries neither (a small probe, sometimes a non-JSON HEAD whose body does not parse),
 * so it reads as no tools and no system; every real conversation turn carries both.
 * Reads the same {@link parseRequestBlob} path `computeGain` does. Internal to turn-1
 * selection; not the gain model's notion of an attributed block.
 * @param {any} ex
 * @returns {boolean}
 */
function carriesFloor(ex) {
  const body = parseRequestBlob(ex?.requestBlob ?? '').json;
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  // `system` may be an array of blocks or a bare prompt string (both valid per the
  // Anthropic API); either is a floor only when non-empty — `system: ""` is not.
  const sys = body.system;
  if (Array.isArray(sys)) return sys.length > 0;
  if (typeof sys === 'string') return sys.length > 0;
  return false;
}

/**
 * Locate turn 1 — the first exchange that ships the static floor — and its index.
 * Index 0 is NOT reliably turn 1: an interactive session's first captured request is
 * Claude Code's preflight probe (no tools[], no system[]), not the opening, so
 * anchoring on `exchanges[0]` zeroed the whole metric (issue #107). Falls back, in
 * order, to the first exchange at least {@link TURN1_BYTE_FLOOR} bytes (a degraded
 * capture with no recognizable floor), then to index 0, so a session still renders
 * rather than reading as an empty floor.
 * @param {Array<Record<string, any>>} exchanges
 * @returns {{ turn1: Record<string, any> | null, turn1Index: number | null }}
 */
function findTurn1(exchanges) {
  for (let i = 0; i < exchanges.length; i++) {
    if (carriesFloor(exchanges[i])) return { turn1: exchanges[i], turn1Index: i };
  }
  for (let i = 0; i < exchanges.length; i++) {
    const blob = exchanges[i]?.requestBlob;
    // `requestBlob` is a string on a loaded session and a Buffer on a hand-built test
    // model (buildRequestBlob); size both the same way.
    const len = typeof blob === 'string' ? Buffer.byteLength(blob, 'utf8') : Buffer.isBuffer(blob) ? blob.length : 0;
    if (len >= TURN1_BYTE_FLOOR) {
      return { turn1: exchanges[i], turn1Index: i };
    }
  }
  return { turn1: exchanges[0] ?? null, turn1Index: exchanges.length > 0 ? 0 : null };
}

/**
 * The pure attribution core: isolate turn 1 and build the floor context from a
 * loaded session model. Turn-1 isolation profiles ONLY the exchange that ships the
 * static floor — every static block is re-shipped each turn, so that opening is the
 * canonical floor, and ignoring later turns drops any mid-session mutation from the
 * baseline. The opening is NOT always `exchanges[0]`: an interactive session begins
 * with a preflight probe that carries no floor, so {@link findTurn1} skips it
 * (issue #107).
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
  const turns = exchanges.length;

  // Turn-1 isolation: attribute the floor from the first exchange that SHIPS it. The
  // opening is not always exchanges[0] — Claude Code emits a preflight probe before the
  // first real turn on interactive sessions (#107), so index 0 can be a floor-less
  // request that would zero the whole metric. `findTurn1` skips past it.
  const { turn1, turn1Index } = findTurn1(exchanges);
  const gain = computeGain({ exchanges: turn1 ? [turn1] : [] });

  // ── headline: real turn-1 input tokens from captured usage ──────────────────
  const u = turn1?.usage ?? null;
  const hasUsage = Boolean(u);
  const inputTokens = u?.inputTokens ?? 0;
  const cacheCreationInputTokens = u?.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = u?.cacheReadInputTokens ?? 0;
  const tokens = hasUsage ? inputTokens + cacheCreationInputTokens + cacheReadInputTokens : null;
  // `windowTokens` is positive by construction above, so tokens is the only null case.
  const pctOfWindow = tokens === null ? null : Math.round((tokens / windowTokens) * 100);

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
    turn1Index,
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
 * Exported so `verify` labels the same contributors with the same strings `floor` does
 * — a delta row must read exactly like the rows it is the difference of. Typed on the
 * structural fields it reads (`kind` / `label` / `detail`), so a `FloorBlock` and a
 * verify `BlockDelta` (which carries `beforeBytes` / `afterBytes` instead of `bytes`)
 * both fit without restating the full attribution shape.
 * @param {{ kind: FloorBlock['kind'], label: string, detail: string | null }} a
 * @returns {string}
 */
export function blockLabel(a) {
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

/**
 * Column widths of the per-block table; the header and every row share them. A row's
 * percent cell is `pct` wide plus its trailing `%`, so the header cell — which has no
 * `%` of its own — is padded to `pct + 1` to line up with it.
 */
const COL = { block: 42, bytes: 9, pct: 6 };
const RULE = '─'.repeat(COL.block + 1 + COL.bytes + 2 + COL.pct + 1);

/**
 * One line of the per-block table in the shared columns: the block label, its
 * right-aligned byte cell, and its right-aligned percent cell (rendered without the
 * trailing `%` for the header). Cells are pre-rendered strings so the same formatter
 * lays out the header, every block row and the total.
 * @param {string} block
 * @param {string} bytesCell
 * @param {string} pctCell
 * @returns {string}
 */
function tableRow(block, bytesCell, pctCell) {
  return `  ${block.padEnd(COL.block)} ${bytesCell.padStart(COL.bytes)}  ${pctCell.padStart(COL.pct + 1)}`;
}

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
  lines.push(tableRow('block', 'bytes', '% floor'));
  lines.push(`  ${RULE}`);
  if (ctx.attribution.length === 0) {
    // No blocks to rank — an empty session, or a turn-1 request whose body did not
    // parse (an aborted capture). Say so rather than printing a "100% of 0" total.
    lines.push('  (nothing attributed — no turn-1 request body was captured)');
  }
  for (const a of ctx.attribution) {
    lines.push(tableRow(blockLabel(a), fmtBytes(a.bytes), `${a.pctOfFloor}%`));
  }
  if (ctx.attribution.length > 0) {
    lines.push(`  ${RULE}`);
    lines.push(tableRow('total', fmtBytes(ctx.totalBytes), '100%'));
  }
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
