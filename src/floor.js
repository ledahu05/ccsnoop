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
import { findCatalogBlocks, parseCatalogEntries } from './floor-catalog.js';

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
 * @property {'tool'|'claude-md'|'hook'|'mcp-deferred'|'deferred-tools'|'agent-types'|'skills-catalog'|'harness'} kind  The contributor class.
 * @property {string} label   Short human label (tool name, or the lever/catalog name).
 * @property {string | null} detail  Per-file source for CLAUDE.md; null otherwise.
 * @property {number} bytes          The turn-1 byte cost (proxy).
 * @property {number} pctOfFloor     round(bytes / totalBytes * 100); 0 when the floor is empty.
 * @property {{ name: string, bytes: number, group?: 'tools'|'servers'|null }[] | null} [entries]  Per-entry breakdown for catalog blocks (issue #109), shown by `--detail`; null/absent otherwise.
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
 * @property {number | null} turn1Index Index of the exchange the floor was taken from — the exchange shipping the static floor (NOT always 0: an interactive session's exchanges[0] is a preflight probe, a `-p` session's is an auxiliary round-trip). Null when empty.
 * @property {string | null} model     Captured request model name (display only).
 * @property {number} windowTokens     The window the headline % was scored against.
 * @property {FloorHeadline} headline
 * @property {FloorBlock[]} attribution  Ranked by `bytes` descending.
 * @property {number} totalBytes         Σ attribution bytes.
 */

/**
 * The byte floor below which a request is assumed to carry no static floor. Claude Code's
 * interactive preflight is a ~1 KB probe and a `-p` session's auxiliary round-trip ~2.3 KB
 * (#120); a real conversation opening is tens of KB. Read twice by {@link findTurn1}: as
 * the "substantial" half of {@link isOpening}, which is what tells an auxiliary call
 * carrying a `system[]` from a tool-less opening carrying one; and as the last fallback
 * for a degraded capture whose body never parsed, to pick a substantial request over a
 * tiny one.
 */
const TURN1_BYTE_FLOOR = 4096;

/**
 * The `label` field carried by each catalog block. `verify` matches contributors across
 * two sessions on `(kind, label, detail)`, so these strings are part of that identity and
 * must stay stable — they are the catalog equivalent of a tool block's tool name. The
 * longer display string lives in {@link blockLabel}.
 * @type {Record<'deferred-tools' | 'agent-types' | 'skills-catalog', string>}
 */
const CATALOG_LABEL = {
  'deferred-tools': 'deferred tools',
  'agent-types': 'agent types',
  'skills-catalog': 'skills',
};

/**
 * Whether an exchange ships a PROMPT SURFACE — a non-empty `tools[]`, or one of the three
 * catalog populations. This is the strong signal that an exchange is the conversation's
 * opening, and it is the one all three research probes (#52, #115, the bench comparability
 * probe) had already re-implemented for themselves, each because {@link carriesSystem}
 * alone was not enough. Issue #120 brought it down here so `floor` — and `verify`, which
 * inherits its turn-1 isolation — stop disagreeing with the probes about which request is
 * the opening.
 *
 * The catalog half matters as well as the tools half: an opening ships tools[] AND the
 * catalogs together in practice, but reading only `tools[]` would make the criterion a
 * restatement of one probe's convenience rather than of what a floor IS — the static
 * prompt Claude Code re-ships every turn.
 * @param {any} body  A parsed request body, or null.
 * @returns {boolean}
 */
function carriesPromptSurface(body) {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return findCatalogBlocks(body).length > 0;
}

/**
 * Whether an exchange ships a non-empty `system[]` (or a non-empty bare `system` string —
 * both are valid per the Anthropic API). The #107 predicate, kept as the weaker fallback
 * signal: `system: ""` and an absent `system` are not a floor.
 * @param {any} body  A parsed request body, or null.
 * @returns {boolean}
 */
function carriesSystem(body) {
  if (!body || typeof body !== 'object') return false;
  const sys = body.system;
  if (Array.isArray(sys)) return sys.length > 0;
  if (typeof sys === 'string') return sys.length > 0;
  return false;
}

/**
 * The byte length of an exchange's captured request. `requestBlob` is a string on a loaded
 * session and a Buffer on a hand-built test model ({@link module:capture.buildRequestBlob});
 * size both the same way.
 * @param {any} ex
 * @returns {number}
 */
function blobBytes(ex) {
  const blob = ex?.requestBlob;
  return typeof blob === 'string' ? Buffer.byteLength(blob, 'utf8') : Buffer.isBuffer(blob) ? blob.length : 0;
}

/**
 * Whether an exchange reads as the conversation's OPENING — the request the static floor
 * is attributed from. Two ways to qualify, and a capture needs only one:
 *
 *   • it ships a prompt surface ({@link carriesPromptSurface}) — the strong signal; or
 *   • it ships a `system[]` ({@link carriesSystem}) AND is substantial (at least
 *     {@link TURN1_BYTE_FLOOR} bytes).
 *
 * The second clause is what keeps #120's fix from costing more than it recovers. A
 * legitimate opening CAN ship an empty `tools[]` and no catalog — a restricted sub-agent,
 * or a run with every tool denied — so a prompt surface must not be *required*. But
 * `system[]` alone is what let the auxiliary round-trip through in the first place, so
 * size is what separates the two: the auxiliary call in #120 is 2.3 KB, an opening is
 * tens of KB. This is the issue's own wording — "la première requête **substantielle**
 * portant un catalogue ou des outils".
 *
 * ⚠ The premise of that second clause — that an opening can ship no tools at all — is
 * REASONED, not measured: no capture of a `--tools none` run or a restricted sub-agent has
 * been taken. It is deliberately the conservative side of the unknown (a false accept
 * costs a slightly wrong anchor; a false reject re-zeroes the whole metric, which is the
 * bug being fixed). Worth a probe before this clause is ever tightened.
 *
 * @param {any} ex
 * @returns {boolean}
 */
function isOpening(ex) {
  const body = parseRequestBlob(ex?.requestBlob ?? '').json;
  if (carriesPromptSurface(body)) return true;
  return carriesSystem(body) && blobBytes(ex) >= TURN1_BYTE_FLOOR;
}

/**
 * Locate turn 1 — the exchange that ships the static floor — and its index.
 *
 * Index 0 is NOT reliably turn 1, and it is wrong in two DIFFERENT ways depending on how
 * the session was started:
 *
 *   • interactive (#107) — Claude Code emits a preflight probe carrying neither tools[]
 *     nor system[] (sometimes a non-JSON HEAD that does not even parse). Anchoring on it
 *     zeroed the whole metric.
 *   • scripted, `claude -p` (#120) — the session opens with an auxiliary round-trip that
 *     ships a real, non-empty `system[]` and no tools[] and no catalog. It satisfies the
 *     #107 predicate, so `floor` anchored on it and reported the ~500 tokens of an
 *     auxiliary call as the floor, with `--detail` announcing "no catalog blocks" on a
 *     capture carrying three. `-p` is the shape the probes and the bench use, so this
 *     silently corrupted every scripted measurement.
 *
 * Selection is FIRST-MATCH on one predicate ({@link isOpening}) — deliberately not a
 * session-wide preference for the strongest signal. Ranking the whole session by "has a
 * prompt surface" would let any later sub-agent side-call, which ships its own small
 * `tools[]`, outrank a legitimate tool-less opening and re-zero the very captures
 * {@link isOpening}'s second clause exists to protect. The opening is the FIRST request
 * that looks like one; later ones are the conversation, not a better candidate.
 *
 * Falls back, in order, to the first exchange of at least {@link TURN1_BYTE_FLOOR} bytes
 * (a degraded capture whose body never parsed), then to index 0, so a session still
 * renders rather than reading as an empty floor.
 *
 * @param {Array<Record<string, any>>} exchanges
 * @returns {{ turn1: Record<string, any> | null, turn1Index: number | null }}
 */
function findTurn1(exchanges) {
  for (let i = 0; i < exchanges.length; i++) {
    if (isOpening(exchanges[i])) return { turn1: exchanges[i], turn1Index: i };
  }
  for (let i = 0; i < exchanges.length; i++) {
    if (blobBytes(exchanges[i]) >= TURN1_BYTE_FLOOR) return { turn1: exchanges[i], turn1Index: i };
  }
  return { turn1: exchanges[0] ?? null, turn1Index: exchanges.length > 0 ? 0 : null };
}

/**
 * The pure attribution core: isolate turn 1 and build the floor context from a
 * loaded session model. Turn-1 isolation profiles ONLY the exchange that ships the
 * static floor — every static block is re-shipped each turn, so that opening is the
 * canonical floor, and ignoring later turns drops any mid-session mutation from the
 * baseline. The opening is NOT always `exchanges[0]`: an interactive session begins with
 * a preflight probe carrying no floor (#107) and a `-p` session with an auxiliary
 * round-trip carrying a `system[]` but no prompt surface (#120), so {@link findTurn1}
 * skips past both.
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

  // Turn-1 isolation: attribute the floor from the exchange that SHIPS it. The opening is
  // not always exchanges[0] — an interactive session opens with a preflight probe (#107)
  // and a `-p` session with an auxiliary round-trip (#120), either of which would anchor
  // the metric on a request that is not the opening. `findTurn1` skips past both.
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

  const turn1Body = parseRequestBlob(turn1?.requestBlob ?? '').json;

  // ── per-block attribution: one block per contributor, then rank by byte cost ─
  /** @type {{ kind: FloorBlock['kind'], label: string, detail: string | null, bytes: number, entries?: FloorBlock['entries'] }[]} */
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

  // Catalog populations (issue #109) — the deferred-tools listing, the agent-types
  // catalog and the skills catalog, each as its own named, byte-costed row, from the
  // shared classifier's spans ({@link module:floor-catalog.findCatalogBlocks}). Before
  // #109 two of the three were INVISIBLE: they ride `messages[*].content`, classified to
  // `harness`, and `chargeExchange` charges harness only on the `system` surface — so
  // they contributed zero. Making them visible RAISES the floor total; that is the
  // correctness half of #109. Since #116 they are levers of the shared model too, so the
  // gain model no longer folds any of them into the harness figure.
  //
  // These rows are therefore the ONE place floor's total and the gain model's total are
  // reached by different routes: the fold below replaces `gain.mcp` inside a catalog row
  // rather than adding to it, and `gain.catalog` splits the same bytes the other way. The
  // two totals must still be equal — the reconciliation gate in test/floor.test.js (#117)
  // freezes that on the committed capture and on every shape the fold has to handle.
  const catalogs = findCatalogBlocks(turn1Body);
  // A population that absorbed the connecting-servers sub-list reports `chargedTo: 'mcp'`
  // — `gain.mcp` holds that share, so its row must be dropped, not shown alongside.
  const replacesMcp = catalogs.some((c) => c.chargedTo === 'mcp');

  // The `mcp-deferred` row is the connecting-servers listing on its own — and the
  // fallback for a capture whose deferred listing the shared classifier recognizes by its
  // `mcp__<server>__*` names but whose headers this build of Claude Code words
  // differently. Better one coarse row than a silently dropped one.
  if (gain.mcp.shipped > 0 && !replacesMcp) {
    blocks.push({ kind: 'mcp-deferred', label: 'MCP deferred listing', detail: null, bytes: gain.mcp.shipped });
  }
  if (gain.harness.shipped > 0) {
    blocks.push({ kind: 'harness', label: 'system[] preamble', detail: null, bytes: gain.harness.shipped });
  }
  for (const c of catalogs) {
    blocks.push({
      kind: c.kind,
      label: CATALOG_LABEL[c.kind],
      detail: null,
      bytes: c.bytes,
      entries: parseCatalogEntries(c.kind, c.text).sort((a, b) => b.bytes - a.bytes),
    });
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
      // Since #116 this row is the connecting-servers sub-list — the only part of the
      // deferred listing an MCP setting can act on. It also stays the coarse fallback for
      // a capture whose catalog headers this build words differently, so the label names
      // the lever rather than promising a shape.
      return 'MCP — deferred server listing';
    // The three catalog populations #109 split that opaque row into. None says "MCP":
    // the listing costs bytes whether or not a single MCP server is configured, and the
    // old name sent users hunting one that was not there.
    case 'deferred-tools':
      return 'deferred tools — ToolSearch listing';
    case 'agent-types':
      return 'agent types — Agent tool catalog';
    case 'skills-catalog':
      return 'skills — Skill tool catalog';
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
 * `opts.detail` appends the per-entry breakdown of the catalog blocks (issue #109) as a
 * SEPARATE section below the total, never as extra rows inside the ranked table — the
 * table stays one row per floor block, so its columns and its 100% total keep meaning
 * what they meant.
 *
 * @param {FloorContext} ctx
 * @param {{ detail?: boolean }} [opts]
 * @returns {{ lines: string[] }}
 */
export function renderFloor(ctx, opts = {}) {
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
  if (opts.detail) lines.push(...renderDetail(ctx));
  return { lines };
}

/**
 * The `--detail` section: for each catalog block, its entries ranked by byte cost, with
 * the percentages taken against THAT BLOCK (an entry is a fraction of its catalog, not of
 * the floor — at floor scale every entry would round to 0%). Entry bytes are raw text
 * lengths and so always sum to less than the block's canonical bytes; the shortfall is
 * shown as an explicit remainder row rather than left as an unexplained gap.
 * @param {FloorContext} ctx
 * @returns {string[]}
 */
function renderDetail(ctx) {
  const withEntries = ctx.attribution.filter((a) => a.entries && a.entries.length > 0);
  /** @type {string[]} */
  const lines = ['', 'Per-entry breakdown (--detail) — percentages are of the block, not the floor'];
  if (withEntries.length === 0) {
    lines.push('  (no catalog blocks in this floor — nothing to break down)');
    return lines;
  }
  for (const a of withEntries) {
    const entries = /** @type {NonNullable<FloorBlock['entries']>} */ (a.entries);
    const pct = (n) => (a.bytes > 0 ? `${Math.round((n / a.bytes) * 100)}%` : '0%');
    lines.push('');
    lines.push(tableRow(`${blockLabel(a)}  (${entries.length})`, fmtBytes(a.bytes), `${a.pctOfFloor}%`));
    let accounted = 0;
    for (const e of entries) {
      accounted += e.bytes;
      // A connecting MCP server rides the same listing as the deferred built-in tools;
      // marking it keeps the two populations legible in one list.
      const name = e.group === 'servers' ? `${e.name} (mcp server)` : e.name;
      lines.push(tableRow(`    · ${name}`, fmtBytes(e.bytes), pct(e.bytes)));
    }
    const rest = a.bytes - accounted;
    if (rest > 0) lines.push(tableRow('    · (headers, separators, envelope)', fmtBytes(rest), pct(rest)));
  }
  return lines;
}

/**
 * Entry point. Resolve + load one session, isolate turn 1, and report the floor.
 * Discovery mirrors `report` / `fine-tune` / `cache` (`--root` / `--sessions-dir` /
 * `--session`); the default is the most-recent session — `floor` is a per-session,
 * turn-1 metric, so there is no corpus mode. `--latest` is accepted for symmetry and
 * is a no-op (the default already is latest). An offline reader of `sessions/`; the
 * daemon is not required.
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, session?: string, windowTokens?: number, detail?: boolean }} [opts]
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
  const { lines } = renderFloor(ctx, { detail: opts.detail });
  return { ...ctx, lines };
}
