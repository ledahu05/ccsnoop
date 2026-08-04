// Subagent context-isolation diagnostic (issue #102, epic #93 part 4).
//
// A PURE function of a captured session: it quantifies how much context ran in
// **subagent threads** (isolated from — and discarded by — the main window) versus
// how much ran in the **main thread**, and frames an **if-inlined counterfactual**:
// had the subagent's work been done inline, the main window would have carried its
// context. The recommendation fires when the isolated context is a material fraction
// of that counterfactual — i.e. routing context-heavy exploration to subagents paid off.
//
// Lineage reuse (already captured, spec §1.6): every exchange carries `threadId`
// (its own session) and `parentSessionId` (set on subagent runs). Subagent threads are
// exactly those with `parentSessionId != null`. The on-disk capture folds a subagent's
// exchanges into its root session's dir (`folderSessionId`, capture.js), so ONE session
// dir's manifest carries both the main thread and every subagent it spawned — which is
// what makes the cross-thread split a single-dir computation.
//
// Non-negotiables honoured here (inherited from the epic / #89):
//   • NEVER re-tokenize. The per-thread cost is a SUM of the captured `usage`; bytes
//     appear only as a labelled fallback, never as the headline currency.
//   • The "input token" currency is the **prompt footprint** = input + cacheRead +
//     cacheCreation — the full prompt each turn processed (the three are disjoint
//     subsets of one turn's prompt). That is what "context that ran in this thread"
//     means; the raw non-cached `input_tokens` alone would undercount a cached CC
//     session to near-zero. The breakdown is retained so the figure is auditable.
//   • Honest "none": a session with no subagent threads says so, and emits no reco.

import { resolveRoots, listSessions, pickLatestSession, loadExchanges } from './report.js';

/**
 * Default isolation threshold (issue #102: "a material fraction"). A session whose
 * isolated context is ≥ 25 % of the if-inlined counterfactual has materially benefited
 * from subagent routing. Tunable via {@link isolateAnalyze}'s `threshold` option.
 */
export const DEFAULT_ISOLATION_THRESHOLD = 0.25;

/** @typedef {import('./report.js').Usage} Usage */

/**
 * @typedef {object} ThreadTotals
 * @property {string} threadId             The thread's own session id.
 * @property {boolean} isSubagent          `parentSessionId != null` for this thread.
 * @property {string | null} parentSessionId  The root session a subagent folds into; null on main.
 * @property {number} exchanges            Exchange count in this thread.
 * @property {number} inputTokens          Σ prompt footprint (input + cacheRead + cacheCreation).
 * @property {{ input: number, cacheRead: number, cacheCreation: number }} inputTokensBreakdown
 * @property {number} requestBytes         Σ raw request bytes — the labelled fallback proxy.
 */

/**
 * @typedef {object} IsolationDiagnostic
 * @property {string | null} mainThreadId   The (first) main thread id, or null if none present.
 * @property {ThreadTotals[]} threads       One entry per distinct threadId, sorted (main first, then subagents).
 * @property {number} mainTotal             Σ inputTokens over main threads (the actual main-only figure).
 * @property {number} subagentTotal         Σ inputTokens over subagent threads (the isolated context).
 * @property {number} subagentCount         Number of distinct subagent threads.
 * @property {boolean} hasSubagents         `subagentCount > 0`.
 * @property {number} inlinedCounterfactual mainTotal + subagentTotal — what inlining would have processed.
 * @property {number | null} isolationRatio subagentTotal / inlinedCounterfactual; null when the counterfactual is 0.
 * @property {{ kind: 'route-to-subagent', text: string } | null} recommendation  Fires when isolation is material.
 */

/**
 * The prompt footprint of one exchange's `usage` — input + cacheRead + cacheCreation
 * (the disjoint parts of a single turn's prompt). Never estimates; null usage ⇒ 0.
 * @param {Usage | null | undefined} u
 * @returns {{ prompt: number, input: number, cacheRead: number, cacheCreation: number }}
 */
function promptFootprint(u) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = n(u?.inputTokens);
  const cacheRead = n(u?.cacheReadInputTokens);
  const cacheCreation = n(u?.cacheCreationInputTokens);
  return { prompt: input + cacheRead + cacheCreation, input, cacheRead, cacheCreation };
}

/**
 * Quantify subagent context-isolation for one session. PURE: no I/O, no wall clock.
 *
 * Each input exchange needs at least `{ threadId, parentSessionId, usage, requestBytes }`
 * — exactly the projection the report session reader (`loadExchanges`) yields. Threads
 * with `parentSessionId != null` are subagents (isolated, discarded); the rest are main.
 *
 * @param {Array<{ threadId: string | null, parentSessionId: string | null, usage: Usage | null, requestBytes?: number }>} exchanges
 * @param {{ threshold?: number }} [opts]
 * @returns {IsolationDiagnostic}
 */
export function isolateAnalyze(exchanges, opts = {}) {
  const threshold = typeof opts.threshold === 'number' && Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_ISOLATION_THRESHOLD;
  const list = Array.isArray(exchanges) ? exchanges : [];

  // Group by threadId (null bucketed under a stable sentinel). The subagent flag is
  // derived from parentSessionId — never from the id string — so a subagent whose id
  // happens to look "main-like" is still classified correctly.
  /** @type {Map<string, { threadId: string, parentSessionId: string | null, exchanges: number, input: number, cacheRead: number, cacheCreation: number, requestBytes: number }>} */
  const byThread = new Map();
  const NULL_KEY = '(no thread id)';
  for (const e of list) {
    const key = e.threadId ?? NULL_KEY;
    let agg = byThread.get(key);
    if (!agg) {
      agg = { threadId: e.threadId ?? NULL_KEY, parentSessionId: e.parentSessionId ?? null, exchanges: 0, input: 0, cacheRead: 0, cacheCreation: 0, requestBytes: 0 };
      byThread.set(key, agg);
    }
    agg.exchanges += 1;
    const fp = promptFootprint(e.usage);
    agg.input += fp.input;
    agg.cacheRead += fp.cacheRead;
    agg.cacheCreation += fp.cacheCreation;
    agg.requestBytes += typeof e.requestBytes === 'number' && Number.isFinite(e.requestBytes) ? e.requestBytes : 0;
  }

  /** @type {ThreadTotals[]} */
  const threads = [...byThread.values()].map((a) => ({
    threadId: a.threadId,
    isSubagent: a.parentSessionId != null,
    parentSessionId: a.parentSessionId,
    exchanges: a.exchanges,
    inputTokens: a.input + a.cacheRead + a.cacheCreation,
    inputTokensBreakdown: { input: a.input, cacheRead: a.cacheRead, cacheCreation: a.cacheCreation },
    requestBytes: a.requestBytes,
  }));
  // Stable order: main threads first, then subagents; within each, by token mass desc.
  threads.sort((a, b) => {
    if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
    return b.inputTokens - a.inputTokens;
  });

  const mainThreads = threads.filter((t) => !t.isSubagent);
  const subThreads = threads.filter((t) => t.isSubagent);
  const mainTotal = mainThreads.reduce((s, t) => s + t.inputTokens, 0);
  const subagentTotal = subThreads.reduce((s, t) => s + t.inputTokens, 0);
  const inlinedCounterfactual = mainTotal + subagentTotal;
  const isolationRatio = inlinedCounterfactual > 0 ? subagentTotal / inlinedCounterfactual : null;

  /** @type {{ kind: 'route-to-subagent', text: string } | null} */
  let recommendation = null;
  if (subThreads.length > 0 && isolationRatio != null && isolationRatio >= threshold) {
    recommendation = {
      kind: 'route-to-subagent',
      text:
        `Subagents isolated ${fmtPct(isolationRatio)} of the inlinable context ` +
        `(${fmt(subagentTotal)} of ${fmt(inlinedCounterfactual)} prompt tokens kept out of the main window). ` +
        `Route context-heavy exploration to subagents so its context never enters the main window.`,
    };
  }

  return {
    mainThreadId: mainThreads.length > 0 ? mainThreads[0].threadId : null,
    threads,
    mainTotal,
    subagentTotal,
    subagentCount: subThreads.length,
    hasSubagents: subThreads.length > 0,
    inlinedCounterfactual,
    isolationRatio,
    recommendation,
  };
}

// ── formatting helpers (shared by the text + HTML renderers) ─────────────────

/** Thousands-separated integer. */
function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** A percentage like "75%" (one decimal only when it is not a round number). */
function fmtPct(r) {
  const pct = r * 100;
  return (Math.round(pct) === pct ? pct.toFixed(0) : pct.toFixed(1)) + '%';
}

const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
/** Escape a value for HTML text/attribute context (a thread id is attacker-shaped input). */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * The text render of {@link IsolationDiagnostic} — per-thread rows, the main/isolated
 * split, the if-inlined counterfactual, and the reco when it fired. The honest
 * "no subagent threads" line is emitted when `hasSubagents` is false.
 * @param {IsolationDiagnostic} d
 * @param {{ sessionId?: string }} [opts]
 * @returns {{ lines: string[], html: string }}
 */
export function renderIsolate(d, opts = {}) {
  const sessionId = opts.sessionId ?? '(no id)';
  /** @type {string[]} */
  const lines = [];
  lines.push(`ccsnoop isolate — session ${sessionId}`);
  const subLabel = d.hasSubagents ? `${d.subagentCount} subagent thread${d.subagentCount === 1 ? '' : 's'}` : 'no subagent threads';
  lines.push(`  ${d.threads.length} thread(s) · ${subLabel}`);
  lines.push('');

  if (!d.hasSubagents) {
    lines.push('No subagent threads — nothing was isolated; all context ran in the main window.');
    lines.push('');
  } else {
    lines.push('per-thread input tokens (prompt: input + cache-read + cache-creation):');
    for (const t of d.threads) {
      const tag = t.isSubagent ? 'subagent' : 'main';
      const parent = t.isSubagent ? ` ← ${t.parentSessionId}` : '';
      lines.push(
        `  ${tag}  ${t.threadId}${parent}  · ${t.exchanges} exch · ${fmt(t.inputTokens)} tok ` +
          `(in ${fmt(t.inputTokensBreakdown.input)} / rd ${fmt(t.inputTokensBreakdown.cacheRead)} / wr ${fmt(t.inputTokensBreakdown.cacheCreation)})`,
      );
    }
    lines.push('');
    lines.push(`main (actual):             ${fmt(d.mainTotal)} tok`);
    lines.push(`subagent (isolated):       ${fmt(d.subagentTotal)} tok`);
    lines.push(`if-inlined counterfactual: ${fmt(d.inlinedCounterfactual)} tok   (main + subagent)`);
    if (d.isolationRatio != null) lines.push(`isolation ratio:           ${fmtPct(d.isolationRatio)}`);
    lines.push('');
    if (d.recommendation) lines.push(`reco: ${d.recommendation.text}`);
    else lines.push('reco: isolation is not a material fraction of the counterfactual — no routing change suggested.');
  }

  const html = renderIsolateHtml(d, { sessionId });
  return { lines, html };
}

/**
 * The self-contained HTML render of the SAME data the text renderer emits. One file,
 * no external assets.
 * @param {IsolationDiagnostic} d
 * @param {{ sessionId: string }} ctx
 * @returns {string}
 */
function renderIsolateHtml(d, { sessionId }) {
  const rows = d.threads
    .map(
      (t) =>
        `      <tr class="${t.isSubagent ? 'sub' : 'main'}">` +
        `<td>${escHtml(t.isSubagent ? 'subagent' : 'main')}</td>` +
        `<td>${escHtml(t.threadId)}${t.isSubagent ? `<span class="parent"> ← ${escHtml(t.parentSessionId ?? '')}</span>` : ''}</td>` +
        `<td>${t.exchanges}</td>` +
        `<td>${fmt(t.inputTokens)}</td>` +
        `<td>${fmt(t.requestBytes)}</td>` +
        `</tr>`,
    )
    .join('\n');

  const none = !d.hasSubagents
    ? '    <p class="muted">No subagent threads — nothing was isolated; all context ran in the main window.</p>'
    : '';

  const split = d.hasSubagents
    ? `    <div class="split">
      <div class="cell"><span>main (actual)</span><b>${fmt(d.mainTotal)}</b></div>
      <div class="cell"><span>subagent (isolated)</span><b>${fmt(d.subagentTotal)}</b></div>
      <div class="cell"><span>if-inlined</span><b>${fmt(d.inlinedCounterfactual)}</b></div>
${d.isolationRatio != null ? `      <div class="cell"><span>isolation ratio</span><b>${fmtPct(d.isolationRatio)}</b></div>` : ''}
    </div>`
    : '';

  const reco = d.recommendation
    ? `    <p class="reco"><b>reco:</b> ${escHtml(d.recommendation.text)}</p>`
    : '';

  const title = `ccsnoop isolate — ${escHtml(sessionId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${ISOLATE_CSS}</style>
</head>
<body>
<header class="topbar">
  <h1>ccsnoop isolate</h1>
  <div class="session-id">session ${escHtml(sessionId)}</div>
  <div class="meta">${d.threads.length} thread(s) · ${d.hasSubagents ? `${d.subagentCount} subagent` : 'no subagent threads'}</div>
</header>
<main>
  <section class="threads" aria-label="per-thread tokens">
    <table>
      <thead><tr><th>kind</th><th>thread</th><th>exch</th><th>input tokens</th><th>bytes (fallback)</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>
${none}
${split}
${reco}
</main>
</body>
</html>`;
}

const ISOLATE_CSS = `
:root{--bg:#0f1117;--panel:#171a23;--edge:#252a37;--fg:#e6e9ef;--muted:#8b93a7;--accent:#5b9dff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.topbar{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--edge);background:var(--panel)}
.topbar h1{margin:0;font-size:16px;letter-spacing:.5px;color:var(--accent)}
.session-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px}
.meta{margin-left:auto;color:var(--muted);font-size:12px}
main{max-width:920px;margin:0 auto;padding:18px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--edge);border-radius:8px;overflow:hidden;font-variant-numeric:tabular-nums}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--edge)}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
tr.sub td:first-child{color:#9ad19a}
tr.main td:first-child{color:var(--accent)}
.parent{color:var(--muted);font-size:11px}
.split{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}
.split .cell{flex:1;min-width:150px;background:var(--panel);border:1px solid var(--edge);border-radius:6px;padding:8px 12px}
.split .cell span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.reco{margin-top:18px;background:var(--panel);border:1px solid var(--edge);border-left:3px solid #9ad19a;border-radius:8px;padding:12px 16px}
.reco b{color:var(--muted)}
.muted{color:var(--muted);font-size:13px}
`;

/**
 * The `isolate` subcommand entry point (issue #102). Discover + load ONE session,
 * run the pure {@link isolateAnalyze}, and render it (text by default; the same data as
 * HTML). Discovery reuses the report resolver so `isolate` finds exactly what
 * `report` / `cache` do; loading reuses the report session reader so all three see the
 * same exchanges. No corpus mode — isolation is a per-conversation property.
 *
 * The input projection is the minimal slice `isolateAnalyze` needs: `{ threadId,
 * parentSessionId, usage, requestBytes }` (the report `loadExchanges` models carry all four).
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, session?: string, threshold?: number }} [opts]
 * @returns {{ sessionId: string, diagnostic: IsolationDiagnostic, lines: string[], html: string }}
 */
export function isolate(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = resolveRoots({ cwd, root: opts.root, all: false, sessionsDir: opts.sessionsDir });
  const sessions = roots.flatMap((r) => listSessions(r));
  if (sessions.length === 0) {
    throw new Error(
      `no captured sessions found under ${roots.join(', ')} — run 'ccsnoop start' first, or pass --root <path>`,
    );
  }

  let chosen;
  if (opts.session) {
    chosen = sessions.find((s) => s.id === opts.session);
    if (!chosen) {
      throw new Error(`session '${opts.session}' not found (have: ${sessions.map((s) => s.id).join(', ')})`);
    }
  } else {
    // No `--session` ⇒ the most-recent session (default-latest, mirroring report / cache).
    chosen = /** @type {{ id: string, dir: string, mtimeMs: number }} */ (pickLatestSession(sessions));
  }

  const exchanges = loadExchanges(chosen.dir).map((e) => ({
    threadId: e.threadId,
    parentSessionId: e.parentSessionId,
    usage: e.usage,
    requestBytes: e.requestBytes,
  }));
  const diagnostic = isolateAnalyze(exchanges, { threshold: opts.threshold });
  const { lines, html } = renderIsolate(diagnostic, { sessionId: chosen.id });
  return { sessionId: chosen.id, diagnostic, lines, html };
}
