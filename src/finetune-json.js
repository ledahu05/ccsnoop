// Fine-tune: the machine-readable JSON emit contract (issue #95, epic #94).
//
// Every other ccsnoop surface is human-facing — text tables, HTML, or a JSON block
// embedded in prose. This is the stable, versioned, parseable contract the
// context-tuning skill (gap 2) consumes to drive ccsnoop programmatically. It is a
// PURE function of the same ctx {@link module:finetune.renderFineTune} renders from,
// so the text diagnostic and the JSON contract can never disagree about what a lever
// costs or what lands in settings.json.
//
// The contract's reason to exist (GAP A in the prototype comment): the **safe
// (auto-write) vs advice (paste-only) split** is implicit in the code path today and
// never serialized. The skill cannot infer the tier from a monolithic settings block
// — it would have to re-derive which levers carry dynamic proof. So this module
// produces the split INSIDE fine-tune, in two mirrored places:
//
//   • lever tiers — `safeLevers` (tools, mcp: dynamic proof → auto-appliable) and
//     `adviceLevers` (hooks, claudeMd: no dynamic proof → paste-only).
//   • settings    — `settings.auto` (the keys the skill may write on approval) and
//     `settings.advice` (the keys it must only surface for the user to paste).
//
// Together `settings.auto ∪ settings.advice` reconstructs the exact paste-ready
// block the text renderer emits — the contract serializes a distinction the code
// already makes, it does not invent a second block.
//
// Non-negotiables inherited from the spec: bytes never tokens (every figure is a
// Segment.bytes length — never re-tokenized); output is advice-to-copy, never
// auto-applied (the skill writes the safe subset only on explicit approval).
//
// Reuse: the envelope (`$schema` / `schemaVersion` / `kind` / `session` / `unit` /
// `note` / `totals`) is generic so `floor --json` (#93) can emit the same envelope
// with a different `kind` once it lands.

import { DEFAULT_WASTE_CONFIG } from './waste.js';
import { NULL_SOURCE, HOOK_INTENT_CAVEAT } from './finetune-levers.js';
import { mcpServerOf, MCP_GUARD_MIN_SESSIONS } from './finetune-mcp.js';

/**
 * The pinned URI of this contract version. Resolves to the in-tree schema doc
 * (`docs/tuning-report-schema.md`); the skill pins a version via `schemaVersion`.
 */
export const SCHEMA_URL = 'https://ccsnoop.dev/schemas/tuning-report/v1.json';

/** The integer contract version a consumer pins (`schemaVersion === 1`). */
export const SCHEMA_VERSION = 1;

/** The single reused cost floor (spec §3.5) gating the hooks + CLAUDE.md levers. */
const BLOAT_FLOOR = DEFAULT_WASTE_CONFIG.bloatFloorBytes;

/** The top-level note — every figure is a byte-length proxy; scopes explained inline. */
const NOTE =
  'Every byte figure is a byte-length proxy (Segment.bytes), never re-tokenized. ' +
  '"shipped" = gross bytes on the wire per request; "waste" = reused-uncached bytes ' +
  're-paid after a cache break. Byte-cost scope is the PRIMARY session; MCP deny ' +
  'verdicts are corpus-scoped (see safeLevers[mcp].scope). ' +
  'totals.recoverable = Σ waste over the actionable levers only.';

const FLOOR_NOTE = 'Incompressible harness system[] preamble — shown for context, never recoverable.';

/**
 * The levers that actually act, and the byte sums behind the headline. Shared by the
 * text renderer ({@link module:finetune.renderFineTune}) and the JSON contract so the
 * two surfaces are one source of truth for "what is denied" and "what is recoverable".
 *
 * `recoverable` is the conservative, cache-aware headline: Σ `waste` over the
 * ACTIONABLE levers only (denied tools, MCP under the T4 guard, above-floor hooks,
 * excludable-above-floor CLAUDE.md). Non-actionable waste (flag-only MCP, below-floor
 * hook, managed CLAUDE.md, the harness floor) is shown but never counted.
 *
 * @param {{ deny: string[], mcp: import('./finetune-mcp.js').McpCorpus,
 *   levers: import('./finetune-levers.js').LeverVerdicts,
 *   gain: import('./finetune-gain.js').GainModel }} ctx
 * @returns {{ hook: import('./finetune-levers.js').HookVerdict, mcpDeny: string[],
 *   claudeMdExclude: string[], hookDeny: boolean, recoverable: number }}
 */
export function summarizeLevers({ deny, mcp, levers, gain }) {
  const hook = levers.hook;
  const mcpDeny = mcp.servers.filter((s) => s.deny).map((s) => s.name);
  // deny ⇒ excludable ⇒ source is a non-null path, so these are plain strings.
  const claudeMdExclude = levers.claudeMd.filter((c) => c.deny).map((c) => /** @type {string} */ (c.source));

  const deniedToolsWaste = deny.reduce((s, n) => s + (gain.tool.get(n)?.waste ?? 0), 0);
  const mcpWaste = mcpDeny.length > 0 ? gain.mcp.waste : 0;
  const hookDeny = Boolean(hook.deny);
  const hookWaste = hookDeny ? gain.hook.waste : 0;
  const claudeMdWaste = levers.claudeMd
    .filter((c) => c.deny)
    .reduce((s, c) => s + (gain.claudeMd.get(c.source ?? NULL_SOURCE)?.waste ?? 0), 0);

  return { hook, mcpDeny, claudeMdExclude, hookDeny, recoverable: deniedToolsWaste + mcpWaste + hookWaste + claudeMdWaste };
}

/**
 * Sum `mcp__<server>__*` tool-def segments per server → per-server byte attribution
 * (GAP B). MCP servers ship name-only in the deferred listing, so per-server bytes
 * come from the tool DEFINITIONS a server has in `tools[]` (the `mcp__<server>__*`
 * segments the gain model already attributes individually). A deferred-only server
 * has no such segments → 0, which is honest (its schema isn't shipped) — not "free".
 *
 * @param {Map<string, { shipped: number, waste: number }>} toolMap
 * @returns {Map<string, { shipped: number, waste: number }>}
 */
function sumMcpServerBytes(toolMap) {
  /** @type {Map<string, { shipped: number, waste: number }>} */
  const acc = new Map();
  for (const [name, g] of toolMap) {
    const server = mcpServerOf(name);
    if (server === null) continue; // a built-in tool, not an MCP tool def
    let e = acc.get(server);
    if (!e) {
      e = { shipped: 0, waste: 0 };
      acc.set(server, e);
    }
    e.shipped += g.shipped;
    e.waste += g.waste;
  }
  return acc;
}

/** True for a built-in tool name — an `mcp__*` def belongs to the MCP lever, not this one. */
function isBuiltinTool(name) {
  return !name.startsWith('mcp__');
}

/**
 * The built-in tools lever (safe tier). `permissions.deny` is the intersection with
 * the pre-validated denylist — always emitted (spec §3.1). Items list EVERY shipped
 * built-in tool with a `deny` flag, so a consumer sees the full shipped-tool picture
 * plus which names are recoverable. MCP tool defs (`mcp__*`) belong to the MCP lever.
 *
 * Items are keyed off the union of `shipped`, `deny` and the gain model's tool names.
 * Through {@link module:finetune.fineTune} those three agree by construction (all
 * three walk the same `tool:<name>` segments), but the union makes `names ⊆ items`
 * hold for ANY caller: a denied name whose bytes the gain model never charged still
 * gets a `0/0` row rather than vanishing from the table it is named in.
 *
 * `allowed` names the shipped denylist entries that `--deny-allow` dropped for this
 * run (T7). Without it a consumer cannot tell "nothing intersects the denylist" from
 * "it matched and was allowed away" — the same distinction the text renderer spells
 * out in its Tools note.
 *
 * @param {{ shipped: string[], deny: string[], denyAllowed: string[],
 *   gain: import('./finetune-gain.js').GainModel }} ctx
 */
function buildToolsEntry({ shipped, deny, denyAllowed, gain }) {
  const denied = deny.filter(isBuiltinTool);
  const denySet = new Set(denied);
  const itemOf = (name) => {
    const g = gain.tool.get(name) ?? { shipped: 0, waste: 0 };
    return { name, shipped: g.shipped, waste: g.waste, deny: denySet.has(name) };
  };
  // Denied tools first (denylist order — deterministic), then the rest by name.
  const rest = [...new Set([...shipped, ...gain.tool.keys()])]
    .filter((name) => isBuiltinTool(name) && !denySet.has(name))
    .sort();
  const items = [...denied, ...rest].map(itemOf);
  return {
    lever: 'tools',
    tier: 'safe',
    verdict: denied.length > 0 ? 'deny' : 'none',
    action: 'permissions.deny',
    evidence:
      'shipped ∩ built-in denylist (data/builtin-denylist.json) — pre-validated by ' +
      'construction; no threshold, no false-positive guard.',
    shipped: items.reduce((s, i) => s + i.shipped, 0),
    waste: items.filter((i) => i.deny).reduce((s, i) => s + i.waste, 0),
    names: [...denied],
    allowed: [...denyAllowed],
    items,
  };
}

/**
 * The MCP lever (safe tier). `disabledMcpjsonServers` emits only under the T4 guard
 * (`sessionCount>=3 AND calledCount==0`, never in single-session mode); otherwise
 * flag-only. Per-server bytes are summed from `mcp__<server>__*` tool-def segments
 * (primary-session scope — see {@link sumMcpServerBytes}); the lever-level
 * `shipped`/`waste` is the deferred-listing block.
 * @param {{ mcp: import('./finetune-mcp.js').McpCorpus, gain: import('./finetune-gain.js').GainModel,
 *   perServer: Map<string, { shipped: number, waste: number }>, mcpDeny: string[] }} ctx
 */
function buildMcpEntry({ mcp, gain, perServer, mcpDeny }) {
  const items = mcp.servers.map((s) => {
    const g = perServer.get(s.name) ?? { shipped: 0, waste: 0 };
    return {
      name: s.name,
      shipped: g.shipped,
      waste: g.waste,
      shippedSessions: s.shippedSessions,
      calledCount: s.calledCount,
      deny: Boolean(s.deny),
    };
  });
  const verdict = mcpDeny.length > 0 ? 'deny' : mcp.servers.length > 0 ? 'flag-only' : 'none';
  return {
    lever: 'mcp',
    tier: 'safe',
    verdict,
    action: 'disabledMcpjsonServers',
    evidence:
      'corpus guard: sessionCount >= 3 AND calledCount == 0. Binary on absence — called ' +
      'even once ⇒ used ⇒ never denied. Never denies in single-session mode.',
    guard: {
      sessionCount: mcp.sessionCount,
      minSessions: MCP_GUARD_MIN_SESSIONS,
      singleSession: Boolean(mcp.singleSession),
    },
    scope:
      'Deny verdicts are corpus-scoped; per-server shipped/waste are summed from ' +
      'mcp__<server>__* tool-def segments in the PRIMARY session (a byte proxy). ' +
      'Deferred servers ship name-only, so per-server bytes may be 0 — unmeasured, not free.',
    shipped: gain.mcp.shipped,
    waste: mcpDeny.length > 0 ? gain.mcp.waste : 0,
    names: [...mcpDeny],
    items,
  };
}

/**
 * The SessionStart hooks lever (advice tier — no dynamic proof). Emits
 * `hooks.SessionStart` removal only above the floor, always carrying the
 * "intent unknown" caveat; never claims "unused".
 * @param {{ hook: import('./finetune-levers.js').HookVerdict, gain: import('./finetune-gain.js').GainModel }} ctx
 */
function buildHooksEntry({ hook, gain }) {
  const deny = Boolean(hook.deny);
  const verdict = deny ? 'remove' : hook.bytes > 0 ? 'below-floor' : 'none';
  return {
    lever: 'hooks',
    tier: 'advice',
    verdict,
    action: 'hooks.SessionStart',
    evidence: 'No dynamic proof — injected every session by construction; cost only, never "unused".',
    caveat: HOOK_INTENT_CAVEAT,
    floorBytes: BLOAT_FLOOR,
    aboveFloor: Boolean(hook.aboveFloor),
    shipped: gain.hook.shipped,
    waste: deny ? gain.hook.waste : 0,
    deny,
  };
}

/**
 * The CLAUDE.md lever (advice tier — no dynamic proof). Per-source byte cost;
 * `claudeMdExcludes` suggested only for excludable (non-managed) sources above the
 * floor. Never claims "unused".
 * @param {{ levers: import('./finetune-levers.js').LeverVerdicts, gain: import('./finetune-gain.js').GainModel }} ctx
 */
function buildClaudeMdEntry({ levers, gain }) {
  const items = levers.claudeMd.map((c) => {
    const g = gain.claudeMd.get(c.source ?? NULL_SOURCE) ?? { shipped: 0, waste: 0 };
    return {
      source: c.source,
      shipped: g.shipped,
      waste: g.waste,
      excludable: Boolean(c.excludable),
      deny: Boolean(c.deny),
      pctOfSystem: c.pct,
    };
  });
  const names = levers.claudeMd.filter((c) => c.deny).map((c) => /** @type {string} */ (c.source));
  return {
    lever: 'claudeMd',
    tier: 'advice',
    verdict: names.length > 0 ? 'exclude' : 'none',
    action: 'claudeMdExcludes',
    evidence:
      'No dynamic proof — injected every session; cost only, never "unused". ' +
      'claudeMdExcludes is suggested only for excludable (non-managed) sources above the floor.',
    floorBytes: BLOAT_FLOOR,
    shipped: items.reduce((s, i) => s + i.shipped, 0),
    waste: items.filter((i) => i.deny).reduce((s, i) => s + i.waste, 0),
    names,
    items,
  };
}

/** A finite number from a possibly-absent usage field; anything else counts as 0. */
function tok(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Primary-session token totals from the captured `usage` (GAP C). Tokens are NOT a
 * fine-tune figure — the diagnostic is byte-only by spec — so this is OPT-IN
 * (`--include-tokens`) and never re-tokenizes: it sums the `usage` blocks already
 * attached to each exchange by `loadSession`. An exchange with no `usage` (aborted /
 * error) contributes nothing.
 *
 * @param {Array<{ usage?: any }>} [exchanges]
 * @returns {{ input: number, output: number, cacheRead: number, cacheCreation: number, source: string }}
 */
function sumTokens(exchanges) {
  const tot = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const ex of exchanges ?? []) {
    const u = ex?.usage;
    if (!u) continue;
    tot.input += tok(u.inputTokens);
    tot.output += tok(u.outputTokens);
    tot.cacheRead += tok(u.cacheReadInputTokens);
    tot.cacheCreation += tok(u.cacheCreationInputTokens);
  }
  return { ...tot, source: 'primary-session captured usage (never re-tokenized)' };
}

/**
 * Build the versioned `tuning-report/v1` contract from the same ctx the text renderer
 * consumes. Pure — no I/O. The return value is JSON-serializable as-is.
 *
 * `scope` is `'corpus'` (default) or `'single'`; it records whether MCP verdicts had
 * corpus evidence. With `opts.includeTokens`, a `tokens` block (primary-session
 * `usage`) is attached; otherwise the contract is byte-only.
 *
 * `shipped` (every built-in tool the primary session ships) and `denyAllowed` (names
 * `--deny-allow` dropped for this run) both feed the tools lever — see
 * {@link buildToolsEntry}. Each defaults to `[]`, which costs a consumer only detail,
 * never a wrong verdict.
 *
 * @param {{ sessionId: string, requests: number, scope?: 'corpus' | 'single',
 *   shipped: string[], deny: string[], denyAllowed?: string[],
 *   mcp: import('./finetune-mcp.js').McpCorpus,
 *   levers: import('./finetune-levers.js').LeverVerdicts,
 *   gain: import('./finetune-gain.js').GainModel,
 *   exchanges?: Array<{ usage?: any }> }} ctx
 * @param {{ includeTokens?: boolean }} [opts]
 * @returns {Record<string, any>}
 */
export function buildJsonReport(ctx, opts = {}) {
  const { sessionId, requests, scope = 'corpus', shipped = [], deny, denyAllowed = [], mcp, levers, gain, exchanges } = ctx;
  const { mcpDeny, claudeMdExclude, hook, hookDeny, recoverable } = summarizeLevers({ deny, mcp, levers, gain });

  const toolsEntry = buildToolsEntry({ shipped, deny, denyAllowed, gain });
  const mcpEntry = buildMcpEntry({ mcp, gain, perServer: sumMcpServerBytes(gain.tool), mcpDeny });
  const hooksEntry = buildHooksEntry({ hook, gain });
  const claudeMdEntry = buildClaudeMdEntry({ levers, gain });

  const totalShipped =
    toolsEntry.shipped + mcpEntry.shipped + hooksEntry.shipped + claudeMdEntry.shipped + gain.harness.shipped;

  // settings.auto = the safe subset the skill may write on approval (built-in deny
  // always present, spec §3.1; MCP deny only under the guard). settings.advice = the
  // paste-only keys (hooks / claudeMdExcludes), each only when its lever acts.
  // Arrays are COPIED in: the report is a self-contained value a consumer may keep or
  // mutate, so it must never alias the caller's `deny` / the summary's own arrays.
  const auto = { permissions: { deny: [...deny] } };
  if (mcpDeny.length > 0) auto.disabledMcpjsonServers = [...mcpDeny];
  const advice = {};
  if (hookDeny) advice.hooks = { SessionStart: [] };
  if (claudeMdExclude.length > 0) advice.claudeMdExcludes = [...claudeMdExclude];

  /** @type {Record<string, any>} */
  const report = {
    $schema: SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    kind: 'tuning-report',
    unit: 'bytes',
    session: { id: sessionId, requests, scope },
    note: NOTE,
    totals: { shipped: totalShipped, recoverable },
    floor: { shipped: gain.harness.shipped, waste: null, action: 'none', note: FLOOR_NOTE },
    safeLevers: [toolsEntry, mcpEntry],
    adviceLevers: [hooksEntry, claudeMdEntry],
    settings: { auto, advice },
  };

  if (opts.includeTokens) report.tokens = sumTokens(exchanges);
  return report;
}
