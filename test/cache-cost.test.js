// Cache diagnostic — T4 (#85): cost maths (token-equivalents, tier ranges, exact rollup).
//
// These tests exercise ONLY the structured cost figures the pure `diagnoseCache` adds:
// the per-transition re-write cost (a TokEquiv with its multiplier breakdown), the honest
// degradation (tier-unknown range, usage-absent `—`), the exact-vs-bounded attribution,
// and the exact session-rollup totals + summed counterfactual. As with T3 (#84), nothing
// internal, no rendering, and no I/O is asserted — only the structured numbers.
//
// Cost unit (cache spec §4 / issue #85): the effective token-equivalent = tokens × tier
// multiplier (cache-write 5 m ×1.25, cache-write 1 h ×2, cache-read ×0.1). The tier and
// multiplier come ONLY from captured `usage` (`cacheCreation{5m,1h}`); `cache_control.ttl`
// is never used for cost. Token counts come ONLY from `usage` — never re-tokenized from
// byte lengths (sizes stay bytes; only the cost proxies onto tokens).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCache, TIER_MULTIPLIERS } from '../src/cache.js';

/** Cost-aware usage builder: per-tier fields are set explicitly (mirrors readUsage). */
function costUsage({ input = 0, cacheRead = 0, cacheCreation = 0, c5m = 0, c1h = 0, output = 0 } = {}) {
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

// Two reference instants; a 120 000 ms gap (≥ a 60 000 ms TTL) makes a clean TEMPORAL turn.
const T0_RECV = '2026-07-28T07:50:00.000Z';
const T0_DONE = '2026-07-28T07:50:01.000Z';
const T1_RECV_COLD = '2026-07-28T07:52:01.000Z'; // +120 s ⇒ gap ≥ TTL
const T1_DONE = '2026-07-28T07:52:02.000Z';

const TTL = 60000;

// ── multipliers ───────────────────────────────────────────────────────────────

test('TIER_MULTIPLIERS: 5 m ×1.25, 1 h ×2, read ×0.1 (cache spec §4)', () => {
  assert.deepEqual(TIER_MULTIPLIERS, { '5m': 1.25, '1h': 2, read: 0.1 });
});

// ── per-transition cost: the multiplier breakdown ─────────────────────────────

test('per-transition cost: a 1 h re-write is shown with its multiplier breakdown', () => {
  // Identical body, cache went cold past the TTL ⇒ the whole turn is a re-write (exact).
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10, cacheCreation: 50, c1h: 50 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ input: 0, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const card = d.transitions[0];
  assert.ok(card.cost, 'a cold turn with a write carries a per-transition cost');
  // The breakdown: 1 000 tok × 2 (1 h write) = 2 000 tok-équ.
  assert.equal(card.cost.rawTokens, 1000);
  assert.equal(card.cost.multiplier, 2);
  assert.equal(card.cost.tier, '1h');
  assert.equal(card.cost.equiv, 2000);
  assert.deepEqual(
    card.cost.components,
    [{ tier: '1h', rawTokens: 1000, multiplier: 2, equiv: 2000 }],
    'the multiplier breakdown is the per-tier component',
  );
  assert.equal(card.headline.cost, card.cost, 'the cost is mirrored onto the headline region');
});

test('per-transition cost: a 5 m re-write is billed at ×1.25', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c5m: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const cost = d.transitions[0].cost;
  assert.equal(cost.tier, '5m');
  assert.equal(cost.multiplier, 1.25);
  assert.equal(cost.equiv, 1250);
});

test('per-transition cost: a write spanning both tiers is mixed (no single multiplier)', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1200, c5m: 200, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const cost = d.transitions[0].cost;
  assert.equal(cost.tier, 'mixed', 'two tiers ⇒ mixed');
  assert.equal(cost.multiplier, null, 'a mixed write has no single multiplier');
  assert.equal(cost.equiv, 2250, '200×1.25 + 1000×2 = 250 + 2000');
  assert.equal(cost.components.length, 2);
});

// ── tier-unknown ⇒ range bound ────────────────────────────────────────────────

test('tier-unknown: flat cache_creation with no per-tier split ⇒ a range, never a false-precise number', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const cost = d.transitions[0].cost;
  assert.equal(cost.tier, 'unknown');
  assert.equal(cost.equiv, null, 'no false-precise single number');
  assert.equal(cost.multiplier, null);
  assert.deepEqual(cost.equivRange, [1250, 2000], 'the bound is [×1.25, ×2]');
  assert.deepEqual(cost.components, []);
});

// ── usage-absent ⇒ no cost line (—) ───────────────────────────────────────────

test('usage-absent: an error/HEAD turn carries no cost, but the verdict + cause are still shown', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: null, requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const card = d.transitions[0];
  assert.equal(card.cost, undefined, 'no cost line when usage is absent (—)');
  assert.ok(card.headline.verdict, 'the verdict is still shown');
  assert.ok(card.headline.cause != null, 'the cause is still shown');
  // And it contributes nothing to the session totals.
  assert.equal(d.rollup.totals.write.equiv, 0);
  assert.equal(d.rollup.totals.read.equiv, 0);
});

// ── exact vs bounded attribution ──────────────────────────────────────────────

test('exact: a re-write with no genuinely-new write (residual attributes fully) is exact', () => {
  // Identical body ⇒ every written token this turn is re-billed (newBytes 0) ⇒ exact.
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.transitions[0].cost.bounded, false, 'the whole write is the re-write ⇒ exact');
});

test('bounded: a re-write that also wrote genuinely-new content is an upper bound (≤ the write)', () => {
  // An append ⇒ the turn wrote the re-written prefix AND a genuinely-new message
  // (newBytes > 0); a request-aggregate `usage` can't split them ⇒ bounded.
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const cost = d.transitions[0].cost;
  assert.equal(cost.bounded, true, 'the figure is ≤ the turn write, not exact');
  assert.equal(cost.equiv, 2000, 'still expressed against the full write (the upper bound)');
});

test('HIT: a warm turn has no re-write cost', () => {
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: costUsage({ cacheRead: 1000, cacheCreation: 100, c1h: 100 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    ],
    { ttl: TTL },
  );
  const card = d.transitions[0];
  assert.equal(card.headline.verdict, 'HIT');
  assert.equal(card.cost, undefined, 'a HIT writes genuinely-new content, not a re-write');
});

// ── tier/multiplier from usage only; cache_control.ttl never used for cost ─────

test('ttl is never used for cost: a 1 h breakpoint with an unknown-tier usage still shows the range', () => {
  // The breakpoint carries ttl:"1h", but `usage` carries no per-tier split. Cost must
  // follow `usage` (the range), NOT inherit ×2 from the breakpoint's ttl.
  const base = { system: [{ type: 'text', text: 's0', cache_control: CC }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: [{ type: 'text', text: 's0', cache_control: CC }], messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: cur, usage: costUsage({ cacheCreation: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.frontierModel, '3-frontier', 'breakpoints are present (so ttl IS available)');
  const cost = d.transitions[0].cost;
  assert.equal(cost.tier, 'unknown', 'cost ignores ttl and follows the unknown-tier usage');
  assert.equal(cost.equiv, null);
  assert.deepEqual(cost.equivRange, [1250, 2000]);
});

// ── never re-tokenizes ────────────────────────────────────────────────────────

test('never re-tokenizes: the cost tracks `usage` tokens, never the byte size', () => {
  // A huge message body and a tiny one, each with the SAME cache_creation, must cost the
  // same — the cost is grounded in captured tokens, not a byte→token estimate.
  const big = 'X'.repeat(50000);
  const costFor = (content) =>
    diagnoseCache(
      [
        { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content }] }, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
        { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content }] }, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      ],
      { ttl: TTL },
    ).transitions[0].cost.equiv;
  assert.equal(costFor(big), 2000);
  assert.equal(costFor('x'), 2000);
});

// ── exact session-rollup totals ───────────────────────────────────────────────

test('rollup totals are exact: Σ cacheCreation1h×2 and Σ cacheRead×0.1, straight from usage', () => {
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: costUsage({ input: 10, cacheRead: 2000, cacheCreation: 3000, c1h: 3000 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: costUsage({ cacheRead: 5000, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    ],
    { ttl: TTL },
  );
  // write = (3000 + 1000) × 2 = 8000; read = (2000 + 5000) × 0.1 = 700. Exact, no range.
  assert.equal(d.rollup.totals.write.equiv, 8000);
  assert.equal(d.rollup.totals.write.equivRange, null);
  assert.equal(d.rollup.totals.write.raw['1h'], 4000);
  assert.equal(d.rollup.totals.read.equiv, 700);
  assert.equal(d.rollup.totals.read.raw.read, 7000);
});

test('rollup wasted sums the per-turn re-write cost and flags a bounded contribution', () => {
  // Turn 2: identical body, cold ⇒ exact re-write of 1000×2 = 2000.
  // Turn 3: append, cold ⇒ bounded re-write reported at its 1000×2 = 2000 upper bound.
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur3 = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: cur3, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
    ],
    { ttl: TTL },
  );
  // wasted = 2000 (turn 2, exact) + 2000 (turn 3, bounded) = 4000; bounded flag set.
  assert.equal(d.rollup.totals.wasted.equiv, 4000);
  assert.equal(d.rollup.totals.wasted.bounded, true, 'one bounded turn ⇒ the wasted total is a bound');
});

test('summedCounterfactual mirrors the wasted basis (would have avoided re-writing ~X)', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.rollup.summedCounterfactual.equiv, 2000);
  assert.equal(d.rollup.summedCounterfactual.bounded, false);
});

test('rollup: a session with an unknown-tier turn carries a write range, not a false-precise total', () => {
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: costUsage({ input: 10, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: costUsage({ cacheRead: 1000, cacheCreation: 2000 }), requestReceivedAt: '2026-07-28T07:50:10.000Z', responseCompletedAt: '2026-07-28T07:50:11.000Z' },
    ],
    { ttl: TTL },
  );
  // Turn 1: 1000×2 = 2000 (known). Turn 2: flat 2000, no per-tier ⇒ unknown [2000×1.25, 2000×2].
  // Write total = 2000 (known floor) + unknown span ⇒ a range [2000 + 2500, 2000 + 4000].
  const w = d.rollup.totals.write;
  assert.equal(w.equiv, null, 'no false-precise total when a turn is tier-unknown');
  assert.deepEqual(w.equivRange, [4500, 6000]);
});

// ── partial / dirty `usage`: no write mass is ever dropped or falsely exact ────

test('a per-tier write with no flat total is still costed (the tier fields are authoritative)', () => {
  // A capture that reports `cache_creation.ephemeral_1h_input_tokens` but no flat
  // `cache_creation_input_tokens`: the write is real and must not vanish from the total.
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 0, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.transitions[0].cost.equiv, 2000, 'the re-write is costed from the tier field');
  assert.equal(d.rollup.totals.write.equiv, 2000, 'and it reaches the session total');
});

test('a flat total the per-tier fields under-sum: the remainder is tier-unknown, so the figure is a bound', () => {
  // flat 1000 but only 600 attributed to the 1 h tier — the other 400 has no reported tier.
  // Pricing only the 600 would silently under-report; pricing all 1000 at ×2 would invent a
  // tier. The honest answer is a span: 600×2 + 400×[1.25, 2] = [1700, 2000].
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c1h: 600 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  const cost = d.transitions[0].cost;
  assert.equal(cost.rawTokens, 1000, 'the whole reported write mass is priced, none dropped');
  assert.equal(cost.equiv, null, 'no false-precise number while any mass is tier-unknown');
  assert.deepEqual(cost.equivRange, [1700, 2000]);
  assert.equal(d.rollup.totals.write.raw.unknown, 400, 'the unattributed mass is recorded as unknown');
  assert.equal(d.rollup.totals.write.raw['1h'], 600);
});

test('a dirty `usage` (NaN / negative / non-numeric fields) costs nothing rather than NaN', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      {
        threadId: 'A',
        turn: 2,
        requestBody: body,
        usage: { ...costUsage(), cacheCreationInputTokens: NaN, cacheCreation1hInputTokens: -5, cacheReadInputTokens: /** @type {any} */ ('700') },
        requestReceivedAt: T1_RECV_COLD,
        responseCompletedAt: T1_DONE,
      },
    ],
    { ttl: TTL },
  );
  assert.equal(d.transitions[0].cost, undefined, 'no write mass survives the guard ⇒ no cost line');
  assert.equal(d.rollup.totals.write.equiv, 0);
  assert.equal(d.rollup.totals.read.equiv, 0, 'a string token count is not coerced');
});

// ── the totals cover exactly the diagnosed turns ──────────────────────────────

test('probe turns (max_tokens 1) are excluded from the cost totals', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10, cacheCreation: 100, c1h: 100 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, maxTokens: 1, usage: costUsage({ cacheRead: 9999, cacheCreation: 9999, c1h: 9999 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
    ],
    { ttl: TTL },
  );
  assert.equal(d.rollup.totals.write.equiv, 200, 'only the real turn contributes (100×2)');
  assert.equal(d.rollup.totals.read.equiv, 0, "the probe's read is filtered out too");
});

test('the wasted total is a bound when a cold turn\'s tier is unknown', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const d = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: body, usage: costUsage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
      { threadId: 'A', turn: 2, requestBody: body, usage: costUsage({ cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: T1_RECV_COLD, responseCompletedAt: T1_DONE },
      { threadId: 'A', turn: 3, requestBody: body, usage: costUsage({ cacheCreation: 400 }), requestReceivedAt: '2026-07-28T07:54:01.000Z', responseCompletedAt: '2026-07-28T07:54:02.000Z' },
    ],
    { ttl: TTL },
  );
  // Turn 2: 1000×2 = 2000 exact. Turn 3: flat 400, tier unknown ⇒ 400×[1.25, 2] = [500, 800].
  const wasted = d.rollup.totals.wasted;
  assert.equal(wasted.equiv, null, 'one tier-unknown turn ⇒ no exact wasted total');
  assert.deepEqual(wasted.equivRange, [2500, 2800]);
  assert.deepEqual(d.rollup.summedCounterfactual.equivRange, [2500, 2800], 'the counterfactual mirrors it');
  assert.equal(d.rollup.summedCounterfactual.rawTokens, 1400, 'raw waste mass spans both tiers and the unknown');
});

// ── empty session ─────────────────────────────────────────────────────────────

test('an empty session yields zeroed cost totals, not a crash', () => {
  const d = diagnoseCache([]);
  assert.equal(d.rollup.totals.write.equiv, 0);
  assert.equal(d.rollup.totals.read.equiv, 0);
  assert.equal(d.rollup.totals.wasted.equiv, 0);
  assert.equal(d.rollup.summedCounterfactual.equiv, 0);
});
