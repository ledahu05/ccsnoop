// Subagent isolation — the committed-fixture integration proof (issue #102).
//
// Two minimal committed sessions under `test/fixtures/isolate/` are run end-to-end
// through `isolate`'s pipeline (the report session reader → `isolateAnalyze`), asserting
// the exact per-thread split, the main-vs-isolated totals, and the if-inlined
// counterfactual. The pure-logic edge cases (nesting, null usage, threshold) live in
// `test/isolate.test.js`; this proves the seam holds on the real on-disk capture shape
// (SSE `usage` read back, lineage fields parsed from the manifest).
//
// RGR posture: the fixtures are committed today, so this gate runs (no self-skip).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExchanges } from '../src/report.js';
import { isolateAnalyze } from '../src/isolate.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/isolate', import.meta.url));

/** Project a loaded exchange onto the minimal slice `isolateAnalyze` consumes. */
function loadForIsolate(dir) {
  return loadExchanges(dir).map((e) => ({
    threadId: e.threadId,
    parentSessionId: e.parentSessionId,
    usage: e.usage,
    requestBytes: e.requestBytes,
  }));
}

test('isolate fixture: a main thread + one subagent splits exactly (issue #102 acceptance)', () => {
  const dir = path.join(FIXTURES_DIR, 'session-with-subagent');
  const d = isolateAnalyze(loadForIsolate(dir));

  // Two threads, the subagent flagged by parentSessionId (not id matching).
  assert.equal(d.threads.length, 2);
  const main = d.threads.find((t) => t.threadId === 'ccsnoop-main-aaaa1111');
  const sub = d.threads.find((t) => t.threadId === 'ccsnoop-sub-bbbb2222');
  assert.ok(main && !main.isSubagent);
  assert.ok(sub && sub.isSubagent);
  assert.equal(sub.parentSessionId, 'ccsnoop-main-aaaa1111');

  // Per-thread input tokens summed straight from the captured `usage` (never re-tokenized).
  assert.equal(main.inputTokens, 2150);
  assert.equal(main.exchanges, 2);
  assert.equal(sub.inputTokens, 6570);
  assert.equal(sub.exchanges, 3);

  // The main-vs-isolated split + the if-inlined counterfactual.
  assert.equal(d.mainThreadId, 'ccsnoop-main-aaaa1111');
  assert.equal(d.mainTotal, 2150);
  assert.equal(d.subagentTotal, 6570);
  assert.equal(d.subagentCount, 1);
  assert.equal(d.hasSubagents, true);
  assert.equal(d.inlinedCounterfactual, 8720); // main + subagent
  assert.ok(d.isolationRatio > 0.75 && d.isolationRatio < 0.76);

  // Material isolation ⇒ reco fires, and it carries the counterfactual.
  assert.equal(d.recommendation.kind, 'route-to-subagent');
  assert.match(d.recommendation.text, /6,570/);
  assert.match(d.recommendation.text, /8,720/);
});

test('isolate fixture: tokens come from captured usage; bytes only as a labelled fallback', () => {
  const dir = path.join(FIXTURES_DIR, 'session-with-subagent');
  const d = isolateAnalyze(loadForIsolate(dir));
  // Every thread exposes a non-negative byte total, but the headline currency is tokens.
  for (const t of d.threads) {
    assert.equal(typeof t.requestBytes, 'number');
    assert.ok(t.requestBytes > 0);
    assert.equal(typeof t.inputTokens, 'number');
    assert.ok(t.inputTokens >= 0);
    // The breakdown accounts for the whole headline (no hidden mass).
    const b = t.inputTokensBreakdown;
    assert.equal(b.input + b.cacheRead + b.cacheCreation, t.inputTokens);
  }
});

test('isolate fixture: a session with no subagents reports "none" honestly', () => {
  const dir = path.join(FIXTURES_DIR, 'session-no-subagent');
  const d = isolateAnalyze(loadForIsolate(dir));

  assert.equal(d.hasSubagents, false);
  assert.equal(d.subagentCount, 0);
  assert.equal(d.subagentTotal, 0);
  assert.equal(d.mainTotal, 1120); // (500) + (20 + 600)
  assert.equal(d.mainThreadId, 'ccsnoop-solo-cccc3333');
  assert.equal(d.inlinedCounterfactual, 1120);
  assert.equal(d.isolationRatio, 0);
  assert.equal(d.recommendation, null);
});
