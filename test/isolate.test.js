// Subagent context-isolation diagnostic — the PURE logic seam (issue #102).
//
// `isolateAnalyze` is pure: no I/O, no wall clock. It groups a session's exchanges
// by `threadId`, tags subagent threads (`parentSessionId != null`), sums per-thread
// input tokens straight from the captured `usage` (never re-tokenizes), and emits the
// isolated-vs-main split plus an if-inlined counterfactual. This file pins that seam
// with synthetic in-memory sessions; the committed on-disk fixtures + the CLI surface
// are exercised in `test/isolate-fixture.test.js` / `test/isolate-cli.test.js`.
//
// RGR posture: written first (RED) against the not-yet-existing `src/isolate.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolateAnalyze, renderIsolate, DEFAULT_ISOLATION_THRESHOLD } from '../src/isolate.js';

/** Build a normalized `usage` (the shape report.js `normalizeUsage` returns). */
function usage({ input = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    stopReason: null,
    streaming: true,
  };
}

/** One exchange in the minimal projection `isolateAnalyze` consumes. */
function ex(threadId, parentSessionId, u, requestBytes = 1000) {
  return { threadId, parentSessionId, usage: u, requestBytes };
}

// ── grouping + per-thread token sums ──────────────────────────────────────────

test('isolateAnalyze: groups exchanges by threadId and sums per-thread input tokens', () => {
  // main thread (parentSessionId null) + one subagent thread (parent set). Token figures
  // chosen so the per-thread split and the counterfactual are exact integers.
  const session = [
    ex('main', null, usage({ input: 1000 }), 1),
    ex('main', null, usage({ input: 50, cacheRead: 1100 }), 1),
    ex('sub-a', 'main', usage({ input: 2000 }), 1),
    ex('sub-a', 'main', usage({ input: 40, cacheRead: 2200 }), 1),
    ex('sub-a', 'main', usage({ input: 30, cacheRead: 2300 }), 1),
  ];
  const d = isolateAnalyze(session);

  // Two threads, classified by parentSessionId — never by id string-matching.
  assert.equal(d.threads.length, 2);
  const main = d.threads.find((t) => t.threadId === 'main');
  const sub = d.threads.find((t) => t.threadId === 'sub-a');
  assert.equal(main.isSubagent, false);
  assert.equal(main.exchanges, 2);
  assert.equal(sub.isSubagent, true);
  assert.equal(sub.parentSessionId, 'main');
  assert.equal(sub.exchanges, 3);

  // Per-thread input tokens = the prompt footprint (input + cacheRead + cacheCreation),
  // summed from `usage` — never re-tokenized.
  //   main: (1000) + (50 + 1100) = 2150
  //   sub:  (2000) + (40 + 2200) + (30 + 2300) = 6570
  assert.equal(main.inputTokens, 2150);
  assert.equal(sub.inputTokens, 6570);
  // The breakdown is retained so the headline figure is auditable.
  assert.deepEqual(main.inputTokensBreakdown, { input: 1050, cacheRead: 1100, cacheCreation: 0 });
  assert.deepEqual(sub.inputTokensBreakdown, { input: 2070, cacheRead: 4500, cacheCreation: 0 });
});

test('isolateAnalyze: identifies the main thread and sums main vs isolated totals', () => {
  const session = [
    ex('main', null, usage({ input: 1000 }), 1),
    ex('main', null, usage({ input: 50, cacheRead: 1100 }), 1),
    ex('sub-a', 'main', usage({ input: 2000 }), 1),
    ex('sub-a', 'main', usage({ input: 40, cacheRead: 2200 }), 1),
    ex('sub-a', 'main', usage({ input: 30, cacheRead: 2300 }), 1),
  ];
  const d = isolateAnalyze(session);

  assert.equal(d.mainThreadId, 'main');
  assert.equal(d.mainTotal, 2150); // main only
  assert.equal(d.subagentTotal, 6570); // Σ over subagent threads = the isolated context
  assert.equal(d.subagentCount, 1);
  assert.equal(d.hasSubagents, true);
});

// ── the if-inlined counterfactual ─────────────────────────────────────────────

test('isolateAnalyze: emits the if-inlined counterfactual (main + subagent) vs main-only', () => {
  const session = [
    ex('main', null, usage({ input: 1000 }), 1),
    ex('main', null, usage({ input: 50, cacheRead: 1100 }), 1),
    ex('sub-a', 'main', usage({ input: 2000 }), 1),
    ex('sub-a', 'main', usage({ input: 40, cacheRead: 2200 }), 1),
    ex('sub-a', 'main', usage({ input: 30, cacheRead: 2300 }), 1),
  ];
  const d = isolateAnalyze(session);

  // The counterfactual is exactly main + subagent sums (a conservative lower bound —
  // inlining would also re-process the subagent context on every later main turn).
  assert.equal(d.inlinedCounterfactual, 8720); // 2150 + 6570
  assert.equal(d.mainTotal, 2150); // the actual main-only figure
  // isolationRatio = isolated / counterfactual = 6570 / 8720 ≈ 0.7534.
  assert.ok(d.isolationRatio > 0.75 && d.isolationRatio < 0.76);
});

// ── recommendation fires only when isolation is material ──────────────────────

test('isolateAnalyze: recommends routing to subagents when isolation is a material fraction', () => {
  // 75% isolated ⇒ materially above the default threshold (0.25) ⇒ reco fires.
  const d = isolateAnalyze([
    ex('main', null, usage({ input: 1000 }), 1),
    ex('sub-a', 'main', usage({ input: 3000 }), 1),
  ]);
  assert.ok(d.recommendation, 'a material isolation ratio fires a reco');
  assert.equal(d.recommendation.kind, 'route-to-subagent');
  assert.match(d.recommendation.text, /subagent/i);
  // The reco carries the counterfactual so it is auditable, not a bare assertion.
  assert.match(d.recommendation.text, /8720|6570|4\d{2}%|75%/);
});

test('isolateAnalyze: no reco when subagents isolate a trivial fraction (below threshold)', () => {
  // A 1 %-isolated session: subagents ran but barely moved context. Honest "not material".
  const d = isolateAnalyze([
    ex('main', null, usage({ input: 10000 }), 1),
    ex('sub-a', 'main', usage({ input: 101 }), 1), // ~1% of the counterfactual
  ]);
  assert.equal(d.hasSubagents, true);
  assert.ok(d.isolationRatio < DEFAULT_ISOLATION_THRESHOLD);
  assert.equal(d.recommendation, null);
});

test('isolateAnalyze: threshold is configurable', () => {
  // Same 1 %-isolated session, but threshold lowered to 0.001 ⇒ now material.
  const d = isolateAnalyze(
    [
      ex('main', null, usage({ input: 10000 }), 1),
      ex('sub-a', 'main', usage({ input: 101 }), 1),
    ],
    { threshold: 0.001 },
  );
  assert.ok(d.recommendation, 'a lowered threshold promotes the trivial case to material');
});

// ── honesty: a session with no subagents ──────────────────────────────────────

test('isolateAnalyze: a session with no subagents reports "none" honestly', () => {
  const d = isolateAnalyze([
    ex('solo', null, usage({ input: 500 }), 1),
    ex('solo', null, usage({ input: 20, cacheRead: 600 }), 1),
  ]);
  assert.equal(d.hasSubagents, false);
  assert.equal(d.subagentCount, 0);
  assert.equal(d.subagentTotal, 0);
  assert.equal(d.mainTotal, 1120);
  // With no subagents the counterfactual collapses to the main total and nothing was isolated.
  assert.equal(d.inlinedCounterfactual, 1120);
  assert.equal(d.isolationRatio, 0);
  assert.equal(d.recommendation, null);
});

test('isolateAnalyze: handles a subagent whose parent is itself a subagent (nested)', () => {
  // Nested subagents both carry parentSessionId ⇒ both classified as isolated.
  const d = isolateAnalyze([
    ex('main', null, usage({ input: 100 }), 1),
    ex('sub-a', 'main', usage({ input: 1000 }), 1),
    ex('sub-b', 'sub-a', usage({ input: 500 }), 1),
  ]);
  assert.equal(d.hasSubagents, true);
  assert.equal(d.subagentCount, 2);
  assert.equal(d.subagentTotal, 1500);
  assert.equal(d.mainTotal, 100);
  assert.equal(d.inlinedCounterfactual, 1600);
});

test('isolateAnalyze: exchanges with no threadId are bucketed, not dropped', () => {
  // A malformed manifest line with a missing thread_id should not crash the analysis.
  const d = isolateAnalyze([
    ex(null, null, usage({ input: 100 }), 1),
    ex('sub-a', 'main', usage({ input: 1000 }), 1),
  ]);
  // The no-threadId exchange has parentSessionId null ⇒ main; the subagent is still counted.
  assert.equal(d.subagentCount, 1);
  assert.equal(d.mainTotal, 100);
  assert.equal(d.subagentTotal, 1000);
});

// ── degraded usage ────────────────────────────────────────────────────────────

test('isolateAnalyze: a turn with null usage contributes zero tokens (never re-tokenizes)', () => {
  // An aborted exchange reads null usage — it must not be estimated from bytes.
  const d = isolateAnalyze([
    ex('main', null, null, 5000),
    ex('sub-a', 'main', usage({ input: 1000 }), 1),
  ]);
  assert.equal(d.mainTotal, 0); // null usage ⇒ 0 tokens, despite 5000 request bytes
  assert.equal(d.subagentTotal, 1000);
  // Bytes survive as the labelled fallback, never as the headline currency.
  const main = d.threads.find((t) => t.threadId === 'main');
  assert.equal(main.requestBytes, 5000);
});

// ── renderer: the SAME data as text + the honest "no subagent threads" line ──

test('renderIsolate (text): main+subagent session renders the split + counterfactual + reco', () => {
  const d = isolateAnalyze([
    ex('main', null, usage({ input: 1000 }), 1),
    ex('main', null, usage({ input: 50, cacheRead: 1100 }), 1),
    ex('sub-a', 'main', usage({ input: 2000 }), 1),
    ex('sub-a', 'main', usage({ input: 40, cacheRead: 2200 }), 1),
    ex('sub-a', 'main', usage({ input: 30, cacheRead: 2300 }), 1),
  ]);
  const out = renderIsolate(d, { sessionId: 'sess-x' }).lines.join('\n');
  assert.match(out, /ccsnoop isolate/);
  assert.match(out, /sess-x/);
  // The two threads appear, the subagent flagged.
  assert.match(out, /main/);
  assert.match(out, /sub-a/);
  assert.match(out, /subagent/i);
  // The headline figures: main total, isolated total, counterfactual.
  assert.match(out, /2,150/);
  assert.match(out, /6,570/);
  assert.match(out, /8,720/);
  // The reco fired (75% isolated).
  assert.match(out, /reco/i);
});

test('renderIsolate (text): a no-subagent session renders the honest "none" line', () => {
  const d = isolateAnalyze([ex('solo', null, usage({ input: 500 }), 1)]);
  const out = renderIsolate(d, { sessionId: 'solo' }).lines.join('\n');
  assert.match(out, /no subagent threads/i);
  assert.doesNotMatch(out, /reco/i);
});

test('renderIsolate (html): emits a self-contained document with the same figures', () => {
  const d = isolateAnalyze([
    ex('main', null, usage({ input: 1000 }), 1),
    ex('sub-a', 'main', usage({ input: 2000 }), 1),
  ]);
  const html = renderIsolate(d, { sessionId: 'sess-x' }).html;
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /sess-x/);
  assert.match(html, /2,000|isolated/i);
});
