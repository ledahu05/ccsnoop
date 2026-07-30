// Cache diagnostic — T3 (#84), the single logic seam.
//
// These tests exercise ONLY the structured `Diagnostic` returned by the pure
// `diagnoseCache` function (cache spec §3): one synthetic case per verdict and edge,
// built with a `usage()` helper that mirrors the waste test's. No internal steps,
// rendering, or I/O are asserted — only "given this session, the diagnostic emits
// this verdict / region partition / culprit". Cost (T4 #85) and recos (T5 #86) are
// out of scope here; this pins the verdict taxonomy and the region partition.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, DEFAULT_CACHE_TTL_MS } from '../src/cache.js';

/** Build a usage object the way readUsage() would (mirrors test/waste.test.js). */
function usage({ input = 0, cacheRead = 0, cacheCreation = 0, output = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    stopReason: null,
    streaming: true,
  };
}

/** The Claude Code breakpoint layout (cache spec §2.2): all `ttl:"1h"`. */
const CC = { type: 'ephemeral', ttl: '1h' };

/** First region of a card matching `pred`. */
const region = (card, pred) => card.regions.find(pred);
/** All regions of a card carrying `verdict`. */
const regionsOf = (card, verdict) => card.regions.filter((r) => r.verdict === verdict);

// Two reference instants; gaps are set by spacing t1's `requestReceivedAt` off t0's
// `responseCompletedAt` (the prior same-lineage turn's completion — what `idleMs` measures).
const T0_RECV = '2026-07-28T07:50:00.000Z';
const T0_DONE = '2026-07-28T07:50:01.000Z';

// ── HIT ───────────────────────────────────────────────────────────────────────

test('HIT: a warm append-only turn whose prefix stayed fully cached', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  // Turn 1 (first, no baseline) is skipped; turn 2 is a HIT.
  assert.deepEqual(d.transitions.map((c) => c.turn), [2]);
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'HIT');
  assert.equal(card.composite, false);
  assert.equal(d.rollup.byVerdict.HIT, 1);
  assert.equal(d.rollup.totalTransitions, 1);
  assert.equal(d.rollup.coldTransitions, 0);
});

// ── STRUCTURAL · KEY ──────────────────────────────────────────────────────────

test('STRUCTURAL·KEY: a tools mutation diverges the prefix at render position 0', () => {
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  const card = d.transitions[0];
  const structural = region(card, (r) => r.verdict === 'STRUCTURAL');
  assert.ok(structural, 'a structural region is emitted');
  assert.equal(structural.structMode, 'KEY');
  assert.equal(structural.culpritSlot, 'tool:Bash');
  assert.equal(structural.range[0], 0, 'a tools mutation invalidates the whole rendered prefix (position 0)');
  assert.equal(card.culpritSlot, 'tool:Bash', 'the card names the structural culprit');
  assert.equal(card.headline.verdict, 'STRUCTURAL');
});

test('STRUCTURAL·KEY: a system-block mutation is also a KEY invalidation', () => {
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'CHANGED sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  const structural = region(d.transitions[0], (r) => r.verdict === 'STRUCTURAL');
  assert.equal(structural.structMode, 'KEY');
  assert.equal(structural.culpritSlot, 'system#0');
});

// ── STRUCTURAL · PREFIX ───────────────────────────────────────────────────────

test('STRUCTURAL·PREFIX: a history edit keeps the head cached, re-writes the tail', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'A-EDITED' }, { role: 'user', content: 'B' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    // Warm enough that the head (system) stays cached; only the mutated tail is re-written.
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 100000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  const card = d.transitions[0];
  const structural = region(card, (r) => r.verdict === 'STRUCTURAL');
  assert.equal(structural.structMode, 'PREFIX');
  assert.equal(structural.culpritSlot, 'message#0');
  assert.equal(card.culpritSlot, 'message#0');
  assert.equal(card.headline.verdict, 'STRUCTURAL');
  // The head (system, before the divergence) is not in the structural region.
  assert.equal(structural.range[0], 1);
});

// ── STRUCTURAL · TRUNCATED ────────────────────────────────────────────────────

test('STRUCTURAL·TRUNCATED: a turn that shrank vs its baseline reads as compaction', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'COMPACTED-SUMMARY' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  const structural = region(d.transitions[0], (r) => r.verdict === 'STRUCTURAL');
  assert.equal(structural.structMode, 'TRUNCATED');
});

test('a warm compaction (turn shrank to a prefix but the cache held) is a HIT, not cold', () => {
  // cur is a strict prefix of the baseline (compaction dropped the tail) but the cache
  // served everything cur sent (cacheBoundary == end). That is a HIT — the dropped content
  // was removed, not left unserved — never an empty/mis-partitioned card.
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'HIT');
  assert.ok(card.regions.length === 1, 'a HIT card carries exactly one region');
});

// ── TEMPORAL ──────────────────────────────────────────────────────────────────

test('TEMPORAL: an append-only turn cold because the gap exceeded the TTL (high confidence)', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // T0_DONE 07:50:01 → t1 received 07:52:01 = 120 000 ms gap; ttl 60 000 ms.
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ], { ttl: 60000 });
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'TEMPORAL');
  const temporal = region(card, (r) => r.verdict === 'TEMPORAL');
  assert.equal(temporal.confidence, 'high');
  assert.ok(temporal.cause && temporal.cause.includes('expired'));
  assert.equal(card.composite, false);
});

test('TEMPORAL: a gap just past the TTL is low confidence (straddle)', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // T0_DONE 07:50:01 → t1 received 07:51:06 = 65 000 ms gap; ttl 60 000 ms (within the 1.2× straddle).
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:51:06.000Z', responseCompletedAt: '2026-07-28T07:51:07.000Z' },
  ], { ttl: 60000 });
  const temporal = region(d.transitions[0], (r) => r.verdict === 'TEMPORAL');
  assert.equal(temporal.confidence, 'low');
});

// ── UNEXPLAINED ───────────────────────────────────────────────────────────────

test('UNEXPLAINED: a cold turn inside the TTL has no fabricated cause', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // T0_DONE 07:50:01 → t1 received 07:50:31 = 30 000 ms gap; ttl 60 000 ms (under the TTL).
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:50:31.000Z', responseCompletedAt: '2026-07-28T07:50:32.000Z' },
  ], { ttl: 60000 });
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'UNEXPLAINED');
  const u = region(card, (r) => r.verdict === 'UNEXPLAINED');
  assert.equal(u.cause, null, 'UNEXPLAINED never invents a cause');
  assert.equal(u.uncachedByDesign, undefined, 'not the breakpoint↔LCP divorce');
});

test('UNEXPLAINED: cache_read with no captured antecedent (content-keyed cache)', () => {
  // The first captured turn nevertheless reads from cache — a content-keyed cache or a
  // partial capture served content we never saw written. UNEXPLAINED, not a HIT.
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10, cacheRead: 500 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
  ]);
  assert.equal(d.transitions.length, 1);
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'UNEXPLAINED');
  assert.ok(card.headline.cause && card.headline.cause.includes('no captured antecedent'));
});

// ── the breakpoint↔LCP divorce (diagnostic-only) ──────────────────────────────

test('divorce: stable content past the last breakpoint is UNCACHED-by-design, never blamed on time/mutation', () => {
  const base = {
    system: [{ type: 'text', text: 's0' }, { type: 'text', text: 's1', cache_control: CC }],
    messages: [{ role: 'user', content: 'm0' }, { role: 'user', content: 'm1' }, { role: 'user', content: 'm2' }],
  };
  const cur = {
    system: [{ type: 'text', text: 's0' }, { type: 'text', text: 's1', cache_control: CC }],
    messages: [{ role: 'user', content: 'm0' }, { role: 'user', content: 'm1' }, { role: 'user', content: 'm2' }, { role: 'user', content: 'm3-new' }],
  };
  // Render: s0(0), s1(1)[bp], m0(2), m1(3), m2(4) [base, len 5]. cur appends m3(5); lcp 5.
  // The only breakpoint is at s1 (pos 1) ⇒ lastMatchingBreakpoint 2 ⇒ divorce [2,5).
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ]);
  assert.equal(d.frontierModel, '3-frontier');
  const card = d.transitions[0];
  const divorce = region(card, (r) => r.uncachedByDesign === true);
  assert.ok(divorce, 'the divorce region is emitted');
  assert.deepEqual(divorce.range, [2, 5]);
  assert.equal(divorce.verdict, 'UNEXPLAINED');
  assert.ok(divorce.cause && divorce.cause.includes('no cache_control breakpoint'));
  // Never mis-blamed on time or a mutation:
  assert.equal(divorce.structMode, undefined);
  assert.equal(divorce.confidence, undefined);
});

// ── 2-frontier fallback ───────────────────────────────────────────────────────

test('2-frontier fallback: no cache_control ⇒ capability frontier unavailable, no divorce', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ], { ttl: 60000 });
  assert.equal(d.frontierModel, '2-frontier-fallback');
  assert.ok(d.note && d.note.includes('cache_control'), 'the fallback carries an honest note');
  const card = d.transitions[0];
  assert.equal(card.frontierModel, '2-frontier-fallback');
  assert.ok(!card.regions.some((r) => r.uncachedByDesign), 'no divorce without breakpoints');
  // The cold prefix is one TEMPORAL region, not split by a capability frontier.
  assert.equal(regionsOf(card, 'TEMPORAL').length, 1);
});

// ── __no_thread__ lane ────────────────────────────────────────────────────────

test('__no_thread__: an unreliable gap suppresses a confident TEMPORAL verdict', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // No threadId ⇒ the capture-order lane; its gap does not represent a real idle.
  const d = diagnoseCache([
    { requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ], { ttl: 60000 });
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'UNEXPLAINED', 'TEMPORAL is suppressed without a reliable gap');
  assert.equal(regionsOf(card, 'TEMPORAL').length, 0);
});

// ── probe filtering ───────────────────────────────────────────────────────────

test('probe turns (max_tokens===1) are filtered from the diagnostic', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, maxTokens: 1024, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, maxTokens: 1, requestBody: { system: 'DIFFERENT', messages: [{ role: 'user', content: 'x' }] }, usage: usage({ input: 1 }), requestReceivedAt: '2026-07-28T07:50:05.000Z', responseCompletedAt: '2026-07-28T07:50:06.000Z' },
    { threadId: 'A', turn: 3, maxTokens: 1024, requestBody: cur, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:20.000Z', responseCompletedAt: '2026-07-28T07:50:21.000Z' },
  ]);
  // Turn 1 (first, no baseline) skipped; the probe (turn 2) never becomes a card; turn 3 is HIT.
  assert.deepEqual(d.transitions.map((c) => c.turn), [3]);
  assert.equal(d.transitions[0].headline.verdict, 'HIT');
});

// ── composite ─────────────────────────────────────────────────────────────────

test('composite: a structural mutation plus a cold head → multiple regions + a named culprit', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'A-EDITED' }, { role: 'user', content: 'B' }] };
  // message#0 edited (structural) AND the cache cold past the TTL (temporal head).
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ], { ttl: 60000 });
  const card = d.transitions[0];
  assert.equal(card.composite, true);
  assert.equal(regionsOf(card, 'TEMPORAL').length, 1, 'a cold-head region');
  const structural = region(card, (r) => r.verdict === 'STRUCTURAL');
  assert.ok(structural);
  assert.equal(structural.structMode, 'PREFIX');
  // A structural culprit is named even if TEMPORAL is the headline.
  assert.equal(card.culpritSlot, 'message#0');
});

test('composite: the structural culprit is named even when TEMPORAL is the headline', () => {
  // A huge cold system (TEMPORAL, dominant bytes) + a small history edit (STRUCTURAL).
  const bigSys = 'STABLE SYSTEM BLOCK '.repeat(200);
  const base = { system: bigSys, messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  const cur = { system: bigSys, messages: [{ role: 'user', content: 'A-EDITED' }, { role: 'user', content: 'B' }] };
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ], { ttl: 60000 });
  const card = d.transitions[0];
  assert.equal(card.composite, true);
  assert.equal(card.headline.verdict, 'TEMPORAL', 'the dominant-cost region headlines');
  // ... yet the structural culprit is still named.
  assert.equal(card.culpritSlot, 'message#0');
  assert.equal(region(card, (r) => r.verdict === 'STRUCTURAL').structMode, 'PREFIX');
});

// ── purity (no wall clock) ────────────────────────────────────────────────────

test('diagnoseCache never calls Date.now() — time is injected', () => {
  const real = Date.now;
  Date.now = () => { throw new Error('Date.now() must not be called inside the cache diagnostic'); };
  try {
    const d = diagnoseCache([
      { threadId: 'A', turn: 1, requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:01.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
    ], { ttl: 60000 });
    assert.equal(d.transitions[0].headline.verdict, 'TEMPORAL');
  } finally {
    Date.now = real;
  }
});

test('DEFAULT_CACHE_TTL_MS is 1 h (the ttl Claude Code places)', () => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 60 * 60 * 1000);
});

// ── rollup ────────────────────────────────────────────────────────────────────

test('rollup counts headline verdicts and cold vs total transitions', () => {
  const d = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    { threadId: 'A', turn: 3, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:52:11.000Z', responseCompletedAt: '2026-07-28T07:52:12.000Z' },
  ], { ttl: 60000 });
  // Turn 1 skipped (no baseline); turn 2 HIT; turn 3 cold TEMPORAL (gap 120 000 ms ≥ 60 000).
  assert.equal(d.rollup.totalTransitions, 2);
  assert.equal(d.rollup.coldTransitions, 1);
  assert.equal(d.rollup.byVerdict.HIT, 1);
  assert.equal(d.rollup.byVerdict.TEMPORAL, 1);
});
