// Fine-tune engine (fine-tune-spec.md).
//
// A pure consumer of captured sessions, like report. The built-in tools lever
// (FT1, issue #71) intersects the primary session's shipped tools[] names with
// the built-in denylist (data/builtin-denylist.json) and emits `permissions.deny`
// (bare names). The MCP lever (FT4, issue #74) aggregates shipped/called across
// the corpus and emits `disabledMcpjsonServers` under the T4 guard
// (`sessionCount>=3 AND calledCount==0`); the MCP corpus + guard live in
// `./finetune-mcp.js`. Bytes/per-lever shipped-waste tables and the hooks /
// CLAUDE.md levers are later tickets (T5/T6).
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
 * Render the diagnostic + paste-ready settings.json block (spec Part 5).
 *
 * Built-in tools (FT1) always emit `permissions.deny`. The MCP lever (FT4) emits
 * `disabledMcpjsonServers` — the denied server names — **only under the T4 guard**
 * (`sessionCount>=3 AND calledCount==0`, never in single-session mode); every
 * shipped server is otherwise shown flag-only with its `calledCount`. The
 * settings block stays pure, comment-free JSON; `disabledMcpjsonServers` is OMITTED
 * entirely when no server is denied, so a corpus with no MCP action keeps the FT1
 * block shape (`{ permissions: { deny } }`). The per-lever shipped/waste byte
 * table arrives with the later lever tickets (T5/T6).
 *
 * @param {{ sessionId: string, requests: number, shipped: string[], deny: string[],
 *   denylist: DenylistEntry[], mcp?: import('./finetune-mcp.js').McpCorpus }} ctx
 * @returns {{ lines: string[], settingsJson: string }}
 */
export function renderFineTune({ sessionId, requests, shipped, deny, denylist, mcp }) {
  const byName = new Map(denylist.map((e) => [e.name, e]));
  /** @type {string[]} */
  const lines = [];
  lines.push(`ccsnoop fine-tune — session ${sessionId} (${requests} request${requests === 1 ? '' : 's'})`);
  lines.push('');
  lines.push(`Built-in tools: ${shipped.length} shipped, ${deny.length} to deny`);
  for (const name of deny) {
    const entry = byName.get(name);
    lines.push(`  ${name.padEnd(18)} ${(entry?.category ?? '').padEnd(14)} deny`);
  }
  if (deny.length === 0) {
    lines.push('  (no shipped tool intersects the built-in denylist)');
  }

  // MCP lever (FT4) — deny only under the T4 guard, else flag-only with counts.
  const mcpServers = mcp?.servers ?? [];
  const mcpDeny = mcpServers.filter((s) => s.deny).map((s) => s.name);
  if (mcp) {
    const scope = mcp.singleSession
      ? 'single-session — flag-only'
      : `corpus, ${mcp.sessionCount} session${mcp.sessionCount === 1 ? '' : 's'}`;
    lines.push('');
    lines.push(`MCP servers: ${mcpServers.length} shipped (${scope})`);
    for (const s of mcpServers) {
      const action = s.deny ? 'deny ✓' : `flag (called ${s.calledCount}/${mcp.sessionCount})`;
      lines.push(`  ${s.name.padEnd(18)} ${action}`);
    }
    if (mcpServers.length === 0) {
      lines.push('  (no MCP server shipped in the corpus)');
    }
  }

  lines.push('');
  // Cache-invalidation warning above any block that changes `tools[]` / MCP load.
  if (deny.length > 0 || mcpDeny.length > 0) {
    lines.push('⚠ Applying this block invalidates the cache (tools[] changes → prefix broken).');
  }
  // Pure, comment-free, paste-ready JSON. permissions.deny is always present
  // (spec §3.1 — unconditional); disabledMcpjsonServers joins ONLY when the T4
  // guard denies ≥1 server (omitted otherwise, so the FT1 shape is preserved).
  const block = { permissions: { deny } };
  if (mcpDeny.length > 0) block.disabledMcpjsonServers = mcpDeny;
  const settingsJson = JSON.stringify(block, null, 2);
  lines.push('settings.json (paste-ready):');
  lines.push(settingsJson);
  return { lines, settingsJson };
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
 *   mcp: import('./finetune-mcp.js').McpCorpus, lines: string[], settingsJson: string }}
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
  const mcpSessions = singleSession ? [chosen] : sessions;
  const profiles = mcpSessions.map((s) => sessionMcpProfile(s.dir, s.id));
  const mcp = aggregateMcpCorpus(profiles, { singleSession });

  const { lines, settingsJson } = renderFineTune({
    sessionId: model.sessionId,
    requests: model.exchanges.length,
    shipped,
    deny,
    denylist,
    mcp,
  });

  return { sessionId: model.sessionId, requests: model.exchanges.length, shipped, deny, mcp, lines, settingsJson };
}
