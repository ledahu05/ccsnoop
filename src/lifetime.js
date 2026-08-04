// Context-lifetime metric (issue #101, part of epic #93 — the default-context-window
// optimization PRD). Promotes compaction — the cache diagnostic's STRUCTURAL·TRUNCATED
// signal — to a first-class context-lifetime metric.
//
// `diagnoseLifetime` is PURE: no I/O, no wall clock. It reuses the waste substrate
// (`computeWaste`, the same pipeline `diagnoseCache` builds on) to locate the turns a
// captured session SHRANK vs its baseline (`end < baselineLength` — the same signal
// cache.js reads as TRUNCATED, cache spec §3 / issue #84), and reports:
//   • compaction count,
//   • the turn + wall-time of the FIRST compaction (the effective lifetime), and
//   • the per-event bytes-dropped.
//
// Non-negotiables (inherited from the cache/waste substrate):
//   • NEVER re-tokenize and never call `Date.now()`. Time is INJECTED from the captured
//     per-turn timestamps (`request_received_at`, parsed by `computeWaste` into `now`);
//     bytes-dropped comes from the substrate's already-sized segment extents
//     (`compactedDroppedBytes`). Neither is estimated.
//   • A session with no compaction reports "no compaction" honestly — no fabricated
//     metric, no invented turns/minutes.
//   • A WARM compaction (the surviving prefix was a cache HIT) still counts: the window
//     was truncated regardless of cache warmth — lifetime is about the window, not the cache.

import { computeWaste } from './waste.js';
import { resolveRoots, listSessions, pickLatestSession, loadExchanges, toAnalysisInput } from './report.js';

/**
 * @typedef {object} CompactionEvent
 * @property {number} turn               The turn number that shrank (the compaction).
 * @property {number} segmentsDropped    `baselineLength − end` — segments removed.
 * @property {number} bytesDropped       Byte extent of the removed baseline tail (proxy;
 *     never re-tokenized — sums the substrate's already-sized segment bytes).
 * @property {number | null} receivedMs  Epoch ms of this turn's `request_received_at`;
 *     `null` when the capture carried no timestamp.
 */

/**
 * @typedef {object} Lifetime
 * @property {number} turnCount                  Non-probe turns analyzed.
 * @property {number} compactionCount            Compaction events this session.
 * @property {CompactionEvent[]} events          One per shrinking turn, in turn order.
 * @property {CompactionEvent | null} firstCompaction  `null` when the window never shrank.
 * @property {number | null} sessionStartMs      Epoch ms of the first turn's `request_received_at`;
 *     `null` when no non-probe turn carried a timestamp.
 * @property {number | null} firstCompactionWallMs  Wall-time (ms) from the session start to the
 *     first compaction; `null` when there was no compaction or a timestamp is missing.
 */

/**
 * Diagnose the effective context lifetime of a captured session. Pure: reuses
 * `computeWaste` for the per-turn classification, then locates the turns a compaction
 * shrank (the same `end < baselineLength` signal cache.js reads as TRUNCATED).
 *
 * @param {Array<{ threadId?: string|null, requestBody: any, usage: import('./report.js').Usage|null,
 *   requestReceivedAt?: string|null, responseCompletedAt?: string|null, maxTokens?: unknown,
 *   turn?: number }>} session  The same exchange shape `computeWaste`/`diagnoseCache` consume.
 * @returns {Lifetime}
 */
export function diagnoseLifetime(session) {
  const { perExchange } = computeWaste(session);

  /** @type {CompactionEvent[]} */
  const events = [];
  /** @type {number | null} */
  let sessionStartMs = null;
  let started = false;
  let turnCount = 0;

  for (let i = 0; i < session.length; i++) {
    const w = perExchange[i];
    if (w.probe) continue; // a one-shot probe is not a conversation turn (cache spec §2.3)
    turnCount++;
    if (!started) {
      // The first non-probe turn's request_received_at is the session-start reference.
      sessionStartMs = w.now;
      started = true;
    }
    const end = w.segments.length;
    // Compaction: the turn shrank vs its prior-turn baseline (cache.js' TRUNCATED signal).
    // A warm compaction (cache held) still shrank, so it still counts as a lifetime event.
    if (w.hadBaseline && end < w.baselineLength) {
      events.push({
        turn: turnOf(session[i], i),
        segmentsDropped: w.baselineLength - end,
        bytesDropped: w.compactedDroppedBytes,
        receivedMs: w.now,
      });
    }
  }

  const firstCompaction = events.length > 0 ? events[0] : null;
  const firstCompactionWallMs =
    firstCompaction && sessionStartMs != null && firstCompaction.receivedMs != null
      ? Math.max(0, firstCompaction.receivedMs - sessionStartMs)
      : null;

  return {
    turnCount,
    compactionCount: events.length,
    events,
    firstCompaction,
    sessionStartMs,
    firstCompactionWallMs,
  };
}

/** @param {object} e @param {number} index @returns {number} */
function turnOf(e, index) {
  return typeof e.turn === 'number' ? e.turn : index + 1;
}

// ── surface: the text + HTML renderer + the `lifetime` entry ───────────────────
//
// `diagnoseLifetime` stays PURE — this section is the I/O-bearing surface that turns a
// structured `Lifetime` into human-readable text (and the same data as HTML) and wires
// it to a captured session. Render is a pure function over structured data; the only
// I/O is the session discovery in `lifetime`, which reuses the report resolver
// (`resolveRoots`/`listSessions`/`pickLatestSession`) so `lifetime` discovers exactly
// what `report`/`fine-tune`/`cache` do. The unit is ONE session — there is no corpus mode.

/**
 * A number as a locale-stable, comma-grouped string (30874 → "30,874"). `toLocaleString`
 * is avoided so the output is identical across Node locales/icu builds (mirrors cache.js).
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  const rounded = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = String(rounded).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

/**
 * A millisecond span as a minute phrase: whole minutes as an int ("3 min"), a fraction
 * otherwise ("3.5 min"). `null` ⇒ "unknown" (an honest missing-value, never a fabricated
 * number — wall-time is uncomputable when a timestamp was not captured).
 * @param {number | null} ms
 * @returns {string}
 */
function fmtMinutes(ms) {
  if (ms == null) return 'unknown';
  const m = ms / 60000;
  return Number.isInteger(m) ? `${m} min` : `${Math.round(m * 10) / 10} min`;
}

/**
 * Render a structured `Lifetime` as human-readable text. Pure: no I/O, no wall clock.
 *
 * The headline is the rollup "effective lifetime = N turns / M min before the window was
 * first compacted" (N = the first compaction's turn, M = the wall-time from the session
 * start). Each compaction event is then listed with its bytes-dropped. A session with no
 * compaction says so honestly and invents no metric.
 *
 * @param {Lifetime} diag
 * @param {{ sessionId?: string }} [opts]
 * @returns {{ lines: string[], html: string }}
 */
export function renderLifetime(diag, opts = {}) {
  const sessionId = opts.sessionId ?? '(no id)';

  /** @type {string[]} */
  const lines = [];
  lines.push(`ccsnoop lifetime — session ${sessionId}`);
  lines.push(`  ${diag.turnCount} turn(s) analyzed · ${diag.compactionCount} compaction(s)`);
  lines.push('');

  const totalBytesDropped = diag.events.reduce((s, e) => s + e.bytesDropped, 0);

  if (diag.firstCompaction) {
    const fc = diag.firstCompaction;
    // The wall-time clause is omitted (not rendered as "unknown") when no timestamp was
    // captured — the turns figure still stands, the minutes figure is not invented.
    const timeClause =
      diag.firstCompactionWallMs != null ? ` / ${fmtMinutes(diag.firstCompactionWallMs)}` : '';
    lines.push(`effective lifetime = ${fc.turn} turn${fc.turn === 1 ? '' : 's'}${timeClause} before the window was first compacted`);
    lines.push(
      `  first compaction at turn ${fc.turn}` +
        ` · ${fmtNum(totalBytesDropped)} bytes dropped across ${diag.compactionCount} event${diag.compactionCount === 1 ? '' : 's'}`
    );
    lines.push('');
    lines.push('── compaction events ──────────');
    for (const e of diag.events) {
      lines.push(`  turn ${e.turn}: dropped ${e.segmentsDropped} segment(s) / ${fmtNum(e.bytesDropped)} bytes`);
    }
  } else {
    lines.push(
      `effective lifetime: no compaction — the context window was never truncated this session` +
        ` (${diag.turnCount} turn${diag.turnCount === 1 ? '' : 's'} analyzed).`
    );
  }

  const html = renderLifetimeHtml(diag, { sessionId, totalBytesDropped });
  return { lines, html };
}

const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/**
 * Escape a value for HTML text/attribute context. Every interpolation goes through here —
 * a session id is a directory name, i.e. attacker-shaped input (mirrors cache.js).
 * @param {unknown} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * The self-contained HTML render of the SAME data the text renderer emits — a render
 * target, not a separate model. One file, no external assets.
 * @param {Lifetime} diag
 * @param {{ sessionId: string, totalBytesDropped: number }} ctx
 * @returns {string}
 */
function renderLifetimeHtml(diag, { sessionId, totalBytesDropped }) {
  const eventsHtml = diag.events.length
    ? `<ul class="events">${diag.events
        .map(
          (e) =>
            `<li><span class="turn">turn ${escHtml(e.turn)}</span> ` +
            `dropped <b>${escHtml(e.segmentsDropped)}</b> segment(s) / <b>${escHtml(fmtNum(e.bytesDropped))}</b> bytes</li>`
        )
        .join('')}</ul>`
    : '<p class="muted">no compaction — the context window was never truncated this session.</p>';

  const headline = diag.firstCompaction
    ? `<p class="lifetime">effective lifetime = <b>${escHtml(diag.firstCompaction.turn)}</b> turn(s) / <b>${escHtml(fmtMinutes(diag.firstCompactionWallMs))}</b> before the window was first compacted</p>` +
      `<p class="meta">first compaction at turn ${escHtml(diag.firstCompaction.turn)} · ${escHtml(fmtNum(totalBytesDropped))} bytes dropped across ${escHtml(diag.compactionCount)} event(s)</p>`
    : '<p class="lifetime">effective lifetime: <b>no compaction</b> — the context window was never truncated this session.</p>';

  const title = `ccsnoop lifetime — ${escHtml(sessionId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${LIFETIME_CSS}</style>
</head>
<body>
<header class="topbar">
  <h1>ccsnoop lifetime</h1>
  <div class="session-id">session ${escHtml(sessionId)}</div>
  <div class="meta">${diag.turnCount} turn(s) analyzed · ${diag.compactionCount} compaction(s)</div>
</header>
<main>
  <section class="rollup" aria-label="effective lifetime">
    ${headline}
  </section>
  <section class="events" aria-label="compaction events">
    <h2>compaction events</h2>
    ${eventsHtml}
  </section>
</main>
</body>
</html>`;
}

const LIFETIME_CSS = `
:root{--bg:#0f1117;--panel:#171a23;--edge:#252a37;--fg:#e6e9ef;--muted:#8b93a7;--accent:#5b9dff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.topbar{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--edge);background:var(--panel)}
.topbar h1{margin:0;font-size:16px;letter-spacing:.5px;color:var(--accent)}
.session-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px}
.topbar .meta{margin-left:auto;color:var(--muted);font-size:12px}
main{max-width:920px;margin:0 auto;padding:18px}
.rollup{background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:14px 16px;margin-bottom:18px}
.rollup .lifetime{margin:0;font-size:15px}
.rollup .lifetime b{color:var(--accent)}
.rollup .meta{margin:6px 0 0;color:var(--muted);font-size:13px}
.events{background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:14px 16px}
.events h2{margin:0 0 10px;font-size:15px}
.events ul{margin:0;padding-left:18px}
.events li{margin:4px 0;font-variant-numeric:tabular-nums}
.events .turn{color:var(--muted);font-family:ui-monospace,monospace}
.muted{color:var(--muted);font-size:13px}
`;

/**
 * The `lifetime` subcommand entry point (issue #101). Discover + load ONE session (the
 * context lifetime is per-conversation — no corpus mode), run the pure `diagnoseLifetime`,
 * and render it (text by default; the same data as HTML). Discovery reuses the report
 * resolver so `lifetime` finds exactly what `report`/`fine-tune`/`cache` do, and loading
 * reuses the report's session reader so all see the same exchanges.
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, session?: string }} [opts]
 * @returns {{ sessionId: string, diagnostic: Lifetime, lines: string[], html: string }}
 */
export function lifetime(opts = {}) {
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
    // No `--session` ⇒ the most-recent session (default-latest, mirroring report/cache).
    // `--latest` is accepted by the CLI as the same signal — there is no corpus mode.
    chosen = /** @type {{ id: string, dir: string, mtimeMs: number }} */ (pickLatestSession(sessions));
  }

  const session = loadExchanges(chosen.dir).map(toAnalysisInput);
  const diagnostic = diagnoseLifetime(session);
  const { lines, html } = renderLifetime(diagnostic, { sessionId: chosen.id });
  return { sessionId: chosen.id, diagnostic, lines, html };
}
