// Fine-tune engine (fine-tune-spec.md; FT1 = issue #71 — the skeleton slice).
//
// A pure consumer of a captured session, like report. It loads ONE session,
// intersects the session's shipped tools[] names with the built-in denylist
// (data/builtin-denylist.json), and emits a minimal CLI text diagnostic plus a
// paste-ready, pure-JSON settings.json block whose `permissions.deny` is that
// intersection (bare names). Bytes/per-lever tables, the corpus scan, and the
// MCP/hooks/CLAUDE.md levers are later tickets (T4–T6); FT1 is the tracer bullet.
//
// Non-negotiables inherited from the spec: bytes never tokens (the diagnostic
// figures come from Segment.bytes); output is advice-to-copy, never auto-applied.
// Tool names are reused from the segmentRequest slots already attached to each
// exchange by loadSession — no re-parsing of the request bodies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSession, resolveRoots, listSessions, pickLatestSession } from './report.js';

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
 * Render the FT1 diagnostic + paste-ready settings.json block (spec Part 5).
 * Minimal for this slice: a session header, a one-line-per-denied-tool list, the
 * cache-invalidation warning (above a non-empty deny), and the pure-JSON block —
 * no comments (caveats live in the text, never in the block). The per-lever
 * shipped/waste byte table arrives with the later lever tickets (T5/T6).
 *
 * @param {{ sessionId: string, requests: number, shipped: string[], deny: string[], denylist: DenylistEntry[] }} ctx
 * @returns {{ lines: string[], settingsJson: string }}
 */
export function renderFineTune({ sessionId, requests, shipped, deny, denylist }) {
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
  lines.push('');
  if (deny.length > 0) {
    lines.push('⚠ Applying this block invalidates the cache (tools[] changes → prefix broken).');
  }
  // Pure, comment-free, paste-ready JSON. permissions.deny is always present
  // (spec §3.1 — unconditional); other levers join with their tickets.
  const settingsJson = JSON.stringify({ permissions: { deny } }, null, 2);
  lines.push('settings.json (paste-ready):');
  lines.push(settingsJson);
  return { lines, settingsJson };
}

/**
 * FT1 skeleton entry point. Resolve + load ONE session (mirroring
 * {@link module:report.generateReport} discovery), intersect its shipped tools
 * with the denylist, and render the diagnostic + JSON block. Single-session only
 * — no corpus, no MCP/hooks/CLAUDE.md emission yet.
 *
 * @param {{ cwd?: string, root?: string, session?: string, all?: boolean, denylistPath?: string }} [opts]
 * @returns {{ sessionId: string, requests: number, shipped: string[], deny: string[], lines: string[], settingsJson: string }}
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
  const { lines, settingsJson } = renderFineTune({
    sessionId: model.sessionId,
    requests: model.exchanges.length,
    shipped,
    deny,
    denylist,
  });

  return { sessionId: model.sessionId, requests: model.exchanges.length, shipped, deny, lines, settingsJson };
}
