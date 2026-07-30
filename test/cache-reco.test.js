// Cache diagnostic — T5 (#86): recommendations (cache spec §5).
//
// These tests exercise ONLY the structured recommendations the pure `diagnoseCache`
// adds: the per-card reco (one per cold turn, gated by the 3-condition legitimacy
// test), the confidence-aware counterfactual ("would have avoided re-writing ~X"), the
// chronicity pattern (a recurring culprit slot), the rollup's deduped session-pattern
// recos, and the fine-tune reco-bridge (sister map #29 — a tool-caused KEY surfaces its
// cache cost alongside its static-bloat cost). As with T3/T4, nothing internal, no
// rendering, and no I/O is asserted — only the structured `Reco` objects.
//
// Legitimacy test (cache spec §5): a reco is emitted iff the lever is (1) controllable,
// (2) causal on THIS transition, (3) non-trivial. HIT and UNEXPLAINED carry none.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, CHRONICITY_THRESHOLD } from '../src/cache.js';

/** Cost-aware usage builder: per-tier fields are set explicitly (mirrors readUsage). */
function usage({ input = 0, cacheRead = 0, cacheCreation = 0, c5m = 0, c1h = 0, output = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheCreation5mInputTokens: c5m,
    cacheCreation1hInputTokens: c1h,
    stopReason: null,
    streaming: true,
  };
}

/** The Claude Code breakpoint layout (cache spec §2.2): all `ttl:"1h"`. */
const CC = { type: 'ephemeral', ttl: '1h' };

// Two reference instants; gaps are set by spacing t1's `requestReceivedAt` off t0's
// `responseCompletedAt` (the prior same-lineage turn's completion — what `idleMs` measures).
const T0_RECV = '2026-07-28T07:50:00.000Z';
const T0_DONE = '2026-07-28T07:50:01.000Z';
const T1_RECV_COLD = '2026-07-28T07:52:01.000Z'; // +120 s ⇒ gap ≥ a 60 s TTL
const T1_DONE = '2026-07-28T07:52:02.000Z';
const TTL = 60000;

/** A warm continuation (cache held) for the establishing turn + its append. */
function warmSession() {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  return [
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
  ];
}

// ── 3-condition test: HIT / UNEXPLAINED carry no reco ──────────────────────────

test('HIT carries no reco — there is no waste to act on', () => {
  const d = diagnoseCache(warmSession());
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'HIT');
  assert.equal(card.reco, undefined, 'a warm turn fails the (causal/non-trivial) test');
});

test('UNEXPLAINED (hidden cause) carries no reco — the cause is not user-controllable', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // A 30 s gap is well inside the TTL, so the cold prefix has no temporal cause ⇒ UNEXPLAINED.
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:50:31.000Z', responseCompletedAt: '2026-07-28T07:50:32.000Z' },
    ],
    { ttl: TTL },
  );
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'UNEXPLAINED');
  assert.equal(card.reco, undefined, 'UNEXPLAINED never hands the user un-actionable advice');
  // ...but its hidden-cause candidates are surfaced as non-actionable context.
  assert.ok(Array.isArray(card.hiddenCauses) && card.hiddenCauses.length > 0, 'candidates are surfaced as context, not a reco');
});

// ── per-verdict recos ──────────────────────────────────────────────────────────

test('TEMPORAL: a resume-before-the-TTL reco with a confidence-aware counterfactual (high)', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.ok(r, 'a cold TEMPORAL turn carries a reco');
  assert.equal(r.kind, 'resume-before-ttl');
  assert.equal(r.form, 'avoidance');
  assert.equal(r.confidence, 'high');
  assert.ok(r.text.includes('TTL'), 'the lever is named');
  // The counterfactual is the wasted re-write, a lower bound: "would have avoided re-writing ~2000".
  assert.equal(r.counterfactual.equiv, 2000);
  assert.ok(r.text.includes('would have avoided'));
  assert.ok(r.text.includes('2000'));
});

test('TEMPORAL low-confidence (gap straddles the TTL): a conditional reco', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  // T0_DONE 07:50:01 → t1 received 07:51:06 = 65 000 ms; ttl 60 000 ms (within the 1.2× straddle).
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:51:06.000Z', responseCompletedAt: '2026-07-28T07:51:07.000Z' },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.equal(r.confidence, 'low', 'the straddle downgrades confidence');
  // Low confidence ⇒ the counterfactual is phrased conditionally.
  assert.ok(/if|low confidence/i.test(r.text), 'the reco is conditional, not a promise');
});

test('STRUCTURAL·KEY: a batch-invalidating reco (amortization), naming the culprit', () => {
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.ok(r);
  assert.equal(r.kind, 'batch-invalidating');
  assert.equal(r.form, 'amortization');
  assert.equal(r.confidence, 'high');
  assert.equal(r.slot, 'tool:Bash', 'the structural culprit is named on the reco');
  assert.ok(/batch/i.test(r.text));
});

test('STRUCTURAL·PREFIX: an edit-last-turn reco (avoidance), naming the offending slot', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'A-EDITED' }, { role: 'user', content: 'B' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 100000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.equal(r.kind, 'edit-last-turn');
  assert.equal(r.form, 'avoidance');
  assert.equal(r.slot, 'message#0', 'the offending slot is named (current[lcp].slot)');
  assert.ok(r.text.includes('message#0'));
});

test('STRUCTURAL·TRUNCATED: a weak diagnostic reco, not a strong lever', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'COMPACTED-SUMMARY' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.equal(r.weak, true, 'compaction is diagnostic-only');
  assert.equal(r.form, 'none', 'no reliable counterfactual lever');
});

test('divorce (uncached-by-design): a weak diagnostic reco when it headlines', () => {
  // A big stable tail past the last breakpoint (small capable-cold head) ⇒ the divorce
  // is the dominant, headline region.
  const big = 'STABLE TAIL '.repeat(300);
  const base = { system: [{ type: 'text', text: 's0' }, { type: 'text', text: 's1', cache_control: CC }], messages: [{ role: 'user', content: big }] };
  const cur = { system: [{ type: 'text', text: 's0' }, { type: 'text', text: 's1', cache_control: CC }], messages: [{ role: 'user', content: big }, { role: 'user', content: 'new' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    ],
  );
  const card = d.transitions[0];
  assert.equal(card.headline.uncachedByDesign, true, 'the divorce headlines this card');
  assert.ok(card.reco && card.reco.weak === true, 'the divorce carries a weak diagnostic reco');
});

// ── chronicity ────────────────────────────────────────────────────────────────

test('CHRONICITY_THRESHOLD is at least 2 (a one-off must never fire)', () => {
  assert.ok(CHRONICITY_THRESHOLD >= 2);
});

test('chronicity: a culprit recurring across ≥ threshold turns fires stabilize-volatile', () => {
  // tool:Bash mutates on turn 2 and turn 3 (each diffed against the prior turn) ⇒ the
  // same culprit slot recurs on 2 transitions ⇒ chronic.
  const mk = (desc) => ({ tools: [{ name: 'Bash', description: desc }], system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q' }] });
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: mk('v1'), usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: mk('v2'), usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: mk('v3'), usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
    ],
    { ttl: TTL },
  );
  const stabilize = d.rollup.rollupRecos.find((r) => r.kind === 'stabilize-volatile');
  assert.ok(stabilize, 'a recurring culprit is chronic');
  assert.equal(stabilize.slot, 'tool:Bash');
  assert.equal(stabilize.recurrence, 2, 'tool:Bash recurred on turns 2 and 3');
  assert.ok(/stabilize/i.test(stabilize.text));
});

test('chronicity: a one-off edit does NOT fire stabilize-volatile', () => {
  // tool:Bash changes once (turn 2), then stays stable and the cache holds (turn 3 warm).
  const mk = (desc) => ({ tools: [{ name: 'Bash', description: desc }], system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q' }] });
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: mk('v1'), usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: mk('v2'), usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: { ...mk('v2'), messages: [{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
    ],
    { ttl: TTL },
  );
  assert.equal(d.rollup.rollupRecos.find((r) => r.kind === 'stabilize-volatile'), undefined, 'a one-off edit is not chronic');
});

// ── rollup dedup (no per-event repetition) ─────────────────────────────────────

test('rollup dedup: session-pattern recos appear once, with a count — not per event', () => {
  // Three cold TEMPORAL turns ⇒ the "group your turns" pattern appears ONCE.
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: body, usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
      { threadId: 'A', turn: 4, requestBody: body, usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:56:01.000Z', responseCompletedAt: '2026-07-28T07:56:02.000Z' },
    ],
    { ttl: TTL },
  );
  const groups = d.rollup.rollupRecos.filter((r) => r.kind === 'group-turns');
  assert.equal(groups.length, 1, 'deduped to once at the rollup');
  assert.equal(groups[0].count, 3, 'the count spans the 3 cold turns');
  // The deduped counterfactual sums the three turns' re-writes.
  assert.equal(groups[0].counterfactual.equiv, 6000, '3 × 2000');
});

test('rollup dedup: the KEY batch reco appears once across several KEY turns', () => {
  const mk = (desc) => ({ tools: [{ name: 'Bash', description: desc }], system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q' }] });
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: mk('v1'), usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: mk('v2'), usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: mk('v3'), usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
    ],
    { ttl: TTL },
  );
  const batches = d.rollup.rollupRecos.filter((r) => r.kind === 'batch-invalidating');
  assert.equal(batches.length, 1, 'deduped to once');
  assert.equal(batches[0].count, 2, 'covers both KEY turns');
});

// ── counterfactual: confidence-aware lower bound ───────────────────────────────

test('the counterfactual mirrors the wasted re-write (a lower bound, not a guarantee)', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: usage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const r = d.transitions[0].reco;
  assert.equal(r.counterfactual.equiv, d.transitions[0].cost.equiv, 'the counterfactual IS the wasted basis');
  assert.equal(r.counterfactual.bounded, d.transitions[0].cost.bounded);
});

// ── fine-tune reco-bridge (sister map #29) ─────────────────────────────────────

test('fine-tune reco-bridge: a tool-caused KEY surfaces its cache cost', () => {
  const base = { tools: [{ name: 'advisor' }], system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'advisor', description: 'changed' }], system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const bridge = d.rollup.rollupRecos.find((r) => r.kind === 'fine-tune-bridge');
  assert.ok(bridge, 'a tool-caused KEY emits a fine-tune reco-bridge');
  assert.equal(bridge.slot, 'tool:advisor');
  assert.ok(bridge.counterfactual && bridge.counterfactual.equiv > 0, 'the cache re-write cost is surfaced');
  assert.ok(/fine-tune|static bloat/i.test(bridge.text), 'it ties the cache cost to the fine-tune axis');
});

test('fine-tune reco-bridge: a system-caused KEY does NOT emit the bridge', () => {
  // A system-block mutation is a KEY invalidation, but it is not a fine-tune deny/tool
  // lever, so the bridge must not fire.
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'stable sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'CHANGED sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.rollup.rollupRecos.find((r) => r.kind === 'fine-tune-bridge'), undefined);
});

// ── a clean session emits no recos at all ──────────────────────────────────────

test('a warm session emits no recos (per-card or rollup)', () => {
  const d = diagnoseCache(warmSession());
  assert.equal(d.transitions[0].reco, undefined);
  assert.deepEqual(d.rollup.rollupRecos, []);
});
