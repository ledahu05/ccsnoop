// Fine-tune engine (fine-tune-spec.md).
//
// A pure consumer of captured sessions, like report. The built-in tools lever
// (FT1, issue #71) intersects the primary session's shipped tools[] names with
// the built-in denylist (data/builtin-denylist.json) and emits `permissions.deny`
// (bare names). The MCP lever (FT4, issue #74) aggregates shipped/called across
// the corpus and emits `disabledMcpjsonServers` under the T4 guard
// (`sessionCount>=3 AND calledCount==0`); the MCP corpus + guard live in
// `./finetune-mcp.js`. The two no-dynamic-proof levers (FT5, issue #75) — hooks
// and CLAUDE.md — emit only "costs N bytes", never "unused": hooks emit
// `hooks.SessionStart` removal above the floor (with the "intent unknown" caveat),
// CLAUDE.md emits `claudeMdExcludes` for excludable sources above the floor; both
// live in `./finetune-levers.js`. Per-lever shipped/waste byte tables are T6.
//
// Non-negotiables inherited from the spec: bytes never tokens (the diagnostic
// figures come from Segment.bytes); output is advice-to-copy, never auto-applied.
// Tool names are reused from the segmentRequest slots already attached to each
// exchange by loadSession — no re-parsing of the request bodies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSession, resolveRoots, listSessions, pickLatestSession } from './report.js';
import { sessionMcpProfile, aggregateMcpCorpus } from './finetune-mcp.js';
import {
  sessionLeverProfile,
  buildLeverVerdicts,
  EMPTY_LEVER_VERDICTS,
  HOOK_INTENT_CAVEAT,
} from './finetune-levers.js';
import { computeGain, EMPTY_GAIN, NULL_SOURCE } from './finetune-gain.js';
import { DEFAULT_WASTE_CONFIG } from './waste.js';

/** The single reused cost floor (spec §3.5) gating the hooks + CLAUDE.md levers. */
const BLOAT_FLOOR = DEFAULT_WASTE_CONFIG.bloatFloorBytes;

/**
 * A byte count as a compact human string (e.g. 8192 → "8.0K"). The diagnostic's
 * size context only — never re-tokenized; this just renders an already-computed
 * byte length.
 * @param {number} bytes
 * @returns {string}
 */
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Column widths of the FT6 diagnostic table. The header and every data row are
 * formatted through {@link tableRow} with these widths, so a column label can never
 * drift out of alignment with the figures printed under it.
 */
const COL = { lever: 18, entry: 28, bytes: 7 };

/** Width of the table's horizontal rules — the full formatted row width. */
const TABLE_WIDTH = COL.lever + 1 + COL.entry + 1 + COL.bytes + 2 + COL.bytes + 4 + 6;

/**
 * One line of the diagnostic table in the shared columns: lever, entry, then the
 * right-aligned `shipped` / `waste` cells and the action. Cells are pre-rendered
 * strings so the same formatter lays out the header, the byte rows and the dash the
 * harness floor prints for its unmodelled waste.
 * @param {string} lever
 * @param {string} entry
 * @param {string} shippedCell
 * @param {string} wasteCell
 * @param {string} action
 * @returns {string}
 */
function tableRow(lever, entry, shippedCell, wasteCell, action) {
  return (
    `${lever.padEnd(COL.lever)} ${entry.padEnd(COL.entry)} ` +
    `${shippedCell.padStart(COL.bytes)}  ${wasteCell.padStart(COL.bytes)}    ${action}`
  ).trimEnd();
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default location of the versioned built-in denylist (spec Part 4). */
export const DEFAULT_DENYLIST_PATH = path.join(PKG_ROOT, 'data', 'builtin-denylist.json');

/**
 * @typedef {object} DenylistEntry
 * @property {string} name      Bare tool name — the only field ever emitted (T1).
 * @property {string} category  Lever grouping shown in the diagnostic.
 * @property {string} note      One-line reason shown in the diagnostic.
 */

/**
 * Load and shape-validate the built-in tools denylist (spec Part 4). The file is
 * the source of truth (not a hardcoded constant); each entry must be the full
 * `{ name, category, note }` triple so the diagnostic can show a reason. Only
 * `name` is ever emitted. Throws on any shape violation so a corrupt override
 * fails loudly rather than silently narrowing the deny.
 *
 * @param {string} [denylistPath]
 * @returns {DenylistEntry[]}
 */
export function loadBuiltinDenylist(denylistPath = DEFAULT_DENYLIST_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(denylistPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read built-in denylist at ${denylistPath}: ${err?.message ?? err}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`built-in denylist at ${denylistPath} is not a JSON array`);
  }
  /** @type {DenylistEntry[]} */
  const out = [];
  /** @type {Set<string>} */
  const seenNames = new Set();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`built-in denylist entry #${i} is not an object`);
    }
    for (const key of ['name', 'category', 'note']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        throw new Error(`built-in denylist entry #${i} (${entry.name ?? '?'}): missing non-empty '${key}'`);
      }
    }
    // The denylist is a set keyed by name — a duplicate would emit that name twice
    // in permissions.deny. Reject it loudly rather than ship an invalid block.
    if (seenNames.has(entry.name)) {
      throw new Error(`built-in denylist entry #${i}: duplicate name '${entry.name}'`);
    }
    seenNames.add(entry.name);
    out.push({ name: entry.name, category: entry.category, note: entry.note });
  }
  return out;
}

/**
 * Bare names of every tool shipped in the session — the union of `tools[]`
 * across exchanges. Derived from the `segmentRequest` slots already attached to
 * each exchange by {@link module:report.loadSession} (`tool:<name>`), so the
 * request bodies are not re-parsed. Anonymous tools (slotted `tool:#<i>`) are
 * excluded: they carry no name to deny.
 *
 * @param {{ exchanges?: Array<{ segments?: Array<{ slot: string }> }> }} model
 * @returns {string[]}
 */
export function shippedToolNames(model) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const ex of model?.exchanges ?? []) {
    for (const seg of ex.segments ?? []) {
      if (typeof seg.slot !== 'string' || seg.slot.indexOf('tool:') !== 0) continue;
      const name = seg.slot.slice(5);
      if (name.length === 0 || name[0] === '#') continue; // anonymous tool — no name
      names.add(name);
    }
  }
  return [...names];
}

/**
 * `permissions.deny` = intersection of the session's shipped tools with the
 * denylist (spec §3.1). Bare names, always emitted — the list is pre-validated
 * by construction, so there is no threshold and no false-positive guard. Order
 * is the denylist's order so the emitted block is deterministic across runs.
 *
 * @param {string[]} shipped
 * @param {DenylistEntry[]} denylist
 * @returns {string[]}
 */
export function denyIntersection(shipped, denylist) {
  const have = new Set(shipped);
  return denylist.map((e) => e.name).filter((name) => have.has(name));
}

/**
 * Render the diagnostic + paste-ready settings.json block (spec Part 5 / FT6).
 *
 * The diagnostic is a CLI TEXT table — one row per lever entry with `shipped` /
 * `waste` / `action` columns, totals, the headline recoverable bytes (Σ `waste` over
 * the actionable levers), a one-line cache caveat, then the settings block. Figures
 * come from the gain model ({@link module:finetune-gain.computeGain}), all byte-
 * lengths via `Segment.bytes` — never re-tokenized.
 *
 * Levers: built-in tools (FT1) always emit `permissions.deny`; the MCP lever (FT4)
 * emits `disabledMcpjsonServers` only under the T4 guard (`sessionCount>=3 AND
 * calledCount==0`, never in single-session mode); the **hooks** lever (FT5) emits
 * `hooks.SessionStart` removal only above the floor (with the "intent unknown"
 * caveat); the **CLAUDE.md** lever emits `claudeMdExcludes` only for excludable
 * sources above the floor. Neither no-dynamic-proof lever ever says "unused" — only
 * "costs N bytes". The settings block stays pure, comment-free JSON; every lever key
 * is OMITTED when it has no action, so a corpus with only tools keeps the FT1 shape.
 *
 * `mcp` and `levers` are required: every run computes both (empty when nothing was
 * captured), so one diagnostic shape covers every case. `gain` defaults to empty
 * (zeros) so the renderer is callable without a session model.
 *
 * @param {{ sessionId: string, requests: number, shipped: string[], deny: string[],
 *   mcp: import('./finetune-mcp.js').McpCorpus,
 *   levers?: import('./finetune-levers.js').LeverVerdicts,
 *   gain?: import('./finetune-gain.js').GainModel }} ctx
 * @returns {{ lines: string[], settingsJson: string }}
 */
export function renderFineTune({ sessionId, requests, shipped, deny, mcp, levers = EMPTY_LEVER_VERDICTS, gain = EMPTY_GAIN }) {
  const hook = levers.hook;
  const mcpDeny = mcp.servers.filter((s) => s.deny).map((s) => s.name);
  const claudeMdExclude = levers.claudeMd.filter((c) => c.deny).map((c) => /** @type {string} */ (c.source));

  /** @type {{ lever: string, label: string, shipped: number, waste: number | null, action: string }[]} */
  const rows = [];
  /** A table row: lever label, entry label, shipped, waste (or null for the floor's dash), action. */
  const pushRow = (lever, label, shippedB, wasteB, action) => {
    rows.push({ lever, label, shipped: shippedB, waste: wasteB, action });
  };

  // ── per-lever rows (spec mockup order: tools, MCP, hooks, CLAUDE.md, harness) ──

  // Built-in tools — one row per DENIED tool (the recoverable intersection). Only the
  // denied tools are recoverable; primitives / non-denylist tools ship but aren't cut.
  for (const name of deny) {
    const g = gain.tool.get(name);
    pushRow('tools', name, g?.shipped ?? 0, g?.waste ?? 0, 'deny ✓');
  }

  // MCP lever — the deferred-listing bytes are one figure for the lever (the listing
  // is a single block naming every server). Per-server deny/flag detail follows as
  // indented action lines so the reader still sees which servers the guard clears.
  if (mcp.servers.length > 0) {
    const action = mcpDeny.length > 0 ? `deny ✓ (${mcpDeny.length})` : 'flag-only';
    pushRow('MCP', 'deferred listing', gain.mcp.shipped, gain.mcp.waste, action);
  }

  // Hooks lever (FT5, spec §3.3) — costs N bytes, NEVER "unused". Above the floor it
  // emits the removal (carrying the "intent unknown" caveat); below the floor it is
  // shown, not emitted. No hook output → a one-line note, not a row.
  if (hook.bytes > 0) {
    const action = hook.deny ? `remove ⚠ ${HOOK_INTENT_CAVEAT}` : `below ${fmtBytes(BLOAT_FLOOR)} floor`;
    pushRow('hooks', 'SessionStart', gain.hook.shipped, gain.hook.waste, action);
  }

  // CLAUDE.md lever (FT5, spec §3.4) — advice-only, NEVER "unused". Per source: byte
  // cost; claudeMdExcludes only for excludable (non-managed) sources above the floor.
  for (const c of levers.claudeMd) {
    const key = c.source ?? NULL_SOURCE;
    const g = gain.claudeMd.get(key);
    const action = c.deny ? 'advice (excludable)' : c.excludable ? 'advice (below floor)' : 'advice (managed)';
    pushRow('CLAUDE.md', c.source ?? '(managed)', g?.shipped ?? c.bytes, g?.waste ?? 0, action);
  }

  // Harness — the incompressible floor (system[] preamble). Shown for context; its
  // waste is a dash (never recoverable, not modelled).
  if (gain.harness.shipped > 0) {
    pushRow('harness', 'system', gain.harness.shipped, null, 'incompressible floor (not actionable)');
  }

  // ── the headline: Σ waste over the ACTIONABLE levers (conservative, cache-aware) ─
  // Non-actionable rows (flag-only MCP, below-floor hook, managed CLAUDE.md, harness)
  // are shown but never counted — bytes you cannot cut are not bytes you recover.
  const deniedToolsWaste = deny.reduce((s, n) => s + (gain.tool.get(n)?.waste ?? 0), 0);
  const mcpWaste = mcpDeny.length > 0 ? gain.mcp.waste : 0;
  const hookWaste = hook.deny ? gain.hook.waste : 0;
  const claudeMdWaste = levers.claudeMd
    .filter((c) => c.deny)
    .reduce((s, c) => s + (gain.claudeMd.get(c.source ?? NULL_SOURCE)?.waste ?? 0), 0);
  const recoverable = deniedToolsWaste + mcpWaste + hookWaste + claudeMdWaste;
  const totalShipped = rows.reduce((s, r) => s + r.shipped, 0);

  // ── emit ──────────────────────────────────────────────────────────────────────
  /** @type {string[]} */
  const lines = [];
  lines.push(`ccsnoop fine-tune — session ${sessionId} (${requests} request${requests === 1 ? '' : 's'})`);
  lines.push('');
  lines.push(tableRow('Lever', 'entry', 'shipped', 'waste', 'action'));
  lines.push('─'.repeat(TABLE_WIDTH));
  for (const r of rows) {
    // The harness floor prints a dash: its waste is real but never recoverable, so
    // there is no figure to show in a column that means "what you'd stop re-paying".
    const wasteCell = r.waste === null ? '—' : fmtBytes(r.waste);
    lines.push(tableRow(r.lever, r.label, fmtBytes(r.shipped), wasteCell, r.action));
    // Per-server MCP detail (deny ✓ / flag calledCount/sessionCount) under the MCP row.
    if (r.lever === 'MCP') {
      for (const s of mcp.servers) {
        const detail = s.deny ? 'deny ✓' : `flag (called ${s.calledCount}/${mcp.sessionCount})`;
        lines.push(`    ${s.name.padEnd(26)} ${detail}`);
      }
    }
  }
  // A lever with nothing to cost gets a one-line note instead of a row.
  //
  // The tools note reports the SCAN, not the table: a session can ship dozens of tools
  // and still produce no tools row, because only the denylist intersection is
  // recoverable. Saying nothing there would let a table with no rows read as "this
  // session shipped no tool context", which is false — hence the shipped count.
  if (deny.length === 0) {
    lines.push(`Tools: ${shipped.length} shipped, none intersect the built-in denylist`);
  }
  if (hook.bytes === 0) {
    lines.push('Hooks: (no SessionStart hook output seen)');
  }
  lines.push('─'.repeat(TABLE_WIDTH));
  lines.push(tableRow('Total', '', fmtBytes(totalShipped), fmtBytes(recoverable), ''));

  lines.push('');
  lines.push(`Recoverable (waste, conservative): ~${fmtBytes(recoverable)} bytes — Σ reused-uncached over the actionable levers.`);
  lines.push('Cache: <shipped> travels every request; <waste> is re-paid after a cache break. Cutting a lever may also restore cache hits (not modeled).');

  lines.push('');
  // Cache-invalidation warning above any block that changes the prompt prefix —
  // tools[], MCP load, the hook output, or an excluded CLAUDE.md file all do.
  if (deny.length > 0 || mcpDeny.length > 0 || hook.deny || claudeMdExclude.length > 0) {
    lines.push('⚠ Applying this block invalidates the cache (tools[] / system content changes → prefix broken).');
  }
  // Pure, comment-free, paste-ready JSON. permissions.deny is always present
  // (spec §3.1 — unconditional); each downstream key joins ONLY when its lever
  // acts (omitted otherwise, so the block keeps the minimal shape).
  const block = { permissions: { deny } };
  if (mcpDeny.length > 0) block.disabledMcpjsonServers = mcpDeny;
  if (hook.deny) block.hooks = { SessionStart: [] };
  if (claudeMdExclude.length > 0) block.claudeMdExcludes = claudeMdExclude;
  const settingsJson = JSON.stringify(block, null, 2);
  lines.push('settings.json (paste-ready):');
  lines.push(settingsJson);
  return { lines, settingsJson };
}

/**
 * Sessions with a repeated id collapsed to their first occurrence. Discovery can
 * surface one session twice — `listSessions` scans `<root>/sessions/` *and*
 * `<root>/` itself, and `--all` may add a route root that is already the cwd root.
 * The MCP guard counts sessions as evidence (`sessionCount>=3`), so a session
 * counted twice would let a deny fire on evidence the corpus does not have.
 *
 * @template {{ id: string }} T
 * @param {T[]} sessions
 * @returns {T[]}
 */
function uniqueById(sessions) {
  /** @type {Map<string, T>} */
  const byId = new Map();
  for (const s of sessions) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}

/**
 * Entry point. Resolve + load sessions, intersect the primary session's shipped
 * tools with the denylist, aggregate the MCP corpus, and render the diagnostic +
 * JSON block.
 *
 * Scope (spec §3.2 / T4): **default = corpus** — aggregate every session under the
 * resolved roots so the MCP "never used" guard has the evidence to fire. A run is
 * **single-session** (weak-evidence) under `--session` / `--latest`: the MCP lever
 * then NEVER denies (one session is too thin for a global verdict). The built-in
 * tools deny is always taken from the primary session (latest, or the `--session`
 * id) — its corpus story is a later ticket.
 *
 * @param {{ cwd?: string, root?: string, session?: string, latest?: boolean, all?: boolean, denylistPath?: string }} [opts]
 * @returns {{ sessionId: string, requests: number, shipped: string[], deny: string[],
 *   mcp: import('./finetune-mcp.js').McpCorpus, levers: import('./finetune-levers.js').LeverVerdicts,
 *   gain: import('./finetune-gain.js').GainModel, lines: string[], settingsJson: string }}
 */
export function fineTune(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = resolveRoots({ cwd, root: opts.root, all: opts.all });
  const sessions = roots.flatMap((r) => listSessions(r));
  if (sessions.length === 0) {
    throw new Error(
      `no captured sessions found under ${roots.join(', ')} — run 'ccsnoop start' first, or pass --root <path>`
    );
  }

  // Single-session = weak-evidence mode (--session picks one, --latest pins the
  // most-recent one). Default (no flag) is corpus mode over every session.
  const singleSession = Boolean(opts.session || opts.latest);
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
  const denylist = loadBuiltinDenylist(opts.denylistPath);
  const shipped = shippedToolNames(model);
  const deny = denyIntersection(shipped, denylist);

  // MCP corpus (FT4) — over the chosen session in single-session mode, over the
  // whole corpus otherwise. On the fly each run; nothing persisted.
  const mcpSessions = singleSession ? [chosen] : uniqueById(sessions);
  const profiles = mcpSessions.map((s) => sessionMcpProfile(s.dir, s.id));
  const mcp = aggregateMcpCorpus(profiles, { singleSession });

  // Hooks + CLAUDE.md levers (FT5) — static by construction (injected every
  // session), so profiled on the chosen (primary) session, the same single-session
  // story the built-in tools deny uses. The floor gates both; never "unused".
  const levers = buildLeverVerdicts(sessionLeverProfile(chosen.dir, chosen.id));

  // Byte-accounted gain model (FT6, spec Part 5) — `shipped` + `waste` per lever,
  // computed over the chosen (primary) session's classified segments (the same
  // single-session story). `waste` is the reused-uncached classification waste.js
  // already produced; `shipped` is the canonical lever size. Never re-tokenized.
  const gain = computeGain(model);

  const { lines, settingsJson } = renderFineTune({
    sessionId: model.sessionId,
    requests: model.exchanges.length,
    shipped,
    deny,
    mcp,
    levers,
    gain,
  });

  return {
    sessionId: model.sessionId,
    requests: model.exchanges.length,
    shipped,
    deny,
    mcp,
    levers,
    gain,
    lines,
    settingsJson,
  };
}
