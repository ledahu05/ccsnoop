// Lifetime metric (issue #101) — promote compaction (the cache diagnostic's
// STRUCTURAL·TRUNCATED signal) to a first-class context-lifetime metric.
//
// This pins the PURE seam `diagnoseLifetime` (mirrors `diagnoseCache`'s posture in
// cache.test.js): it reuses the waste substrate (`computeWaste`) to locate the turns
// a captured session SHRANK vs its baseline (`end < baselineLength` — compaction),
// and reports compaction count, turns/wall-time to the first compaction, and the
// per-event bytes-dropped. No wall clock: time comes from the captured per-turn
// timestamps. No re-tokenization: bytes come from the already-sized segment extents.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseLifetime, renderLifetime } from '../src/lifetime.js';
import { segmentRequest } from '../src/waste.js';

/** Mirrors the usage() helper in cache.test.js — only shape matters here. */
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

const T0_RECV = '2026-07-28T07:50:00.000Z';
const T0_DONE = '2026-07-28T07:50:01.000Z';

// ── detection: a shrinking turn is a compaction ───────────────────────────────

test('diagnoseLifetime: a turn that shrank vs its baseline is one compaction event', () => {
  const baseBody = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] };
  const curBody = { system: 'sys', messages: [{ role: 'user', content: 'COMPACTED-SUMMARY' }] };
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: baseBody, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: curBody, usage: usage({ input: 900, cacheRead: 0 }), requestReceivedAt: '2026-07-28T07:53:00.000Z', responseCompletedAt: '2026-07-28T07:53:01.000Z' },
  ]);

  assert.equal(d.compactionCount, 1);
  assert.equal(d.turnCount, 2);
  assert.equal(d.events.length, 1);

  const ev = d.events[0];
  assert.equal(ev.turn, 2, 'the compaction is on turn 2 (the shrinking turn)');

  // bytes-dropped = byte extent of the baseline tail that disappeared. Cross-checked
  // against the waste substrate's own segmenter (no re-tokenization here either).
  const baseSegs = segmentRequest(baseBody);
  const curSegs = segmentRequest(curBody);
  const expectedDroppedBytes = baseSegs.slice(curSegs.length).reduce((s, x) => s + x.bytes, 0);
  assert.equal(ev.bytesDropped, expectedDroppedBytes, 'bytes-dropped = Σ dropped baseline segment bytes');
  assert.equal(ev.segmentsDropped, baseSegs.length - curSegs.length, 'segments-dropped = baselineLength − end');
  assert.ok(ev.bytesDropped > 0, 'content was actually removed');

  // Wall-time = first turn's request_received_at → first compaction's request_received_at.
  assert.equal(d.firstCompactionWallMs, 3 * 60 * 1000, '3 min from session start to the first compaction');
  assert.equal(d.sessionStartMs, Date.parse(T0_RECV));
  assert.equal(d.firstCompaction.turn, 2);
});

test('diagnoseLifetime: turns-to-first-compact + wall-time across several turns', () => {
  // Grow the window for 3 turns, then compact on turn 4.
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00.000Z', responseCompletedAt: '2026-07-28T07:50:01.000Z' },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' },
    { threadId: 'A', turn: 3, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:52:00.000Z', responseCompletedAt: '2026-07-28T07:52:01.000Z' },
    { threadId: 'A', turn: 4, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'SUMMARY' }] }, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:56:00.000Z', responseCompletedAt: '2026-07-28T07:56:01.000Z' },
  ]);

  assert.equal(d.compactionCount, 1);
  assert.equal(d.firstCompaction.turn, 4, 'turns-to-first-compact = the turn the window first shrank');
  assert.equal(d.firstCompactionWallMs, 6 * 60 * 1000, '6 min from session start (07:50) to the compaction (07:56)');
});

test('diagnoseLifetime: multiple compactions are each counted as separate events', () => {
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00.000Z', responseCompletedAt: '2026-07-28T07:50:01.000Z' },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' }, // compact
    { threadId: 'A', turn: 3, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:52:00.000Z', responseCompletedAt: '2026-07-28T07:52:01.000Z' },
    { threadId: 'A', turn: 4, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:53:00.000Z', responseCompletedAt: '2026-07-28T07:53:01.000Z' }, // compact again
  ]);

  assert.equal(d.compactionCount, 2);
  assert.deepEqual(d.events.map((e) => e.turn), [2, 4], 'one event per shrinking turn, in turn order');
  assert.equal(d.firstCompaction.turn, 2);
});

test('diagnoseLifetime: a warm compaction (cache held) still counts — the window was truncated', () => {
  // turn 2 shrank to a prefix of turn 1 AND the cache served it warmly (cacheRead > 0).
  // For the LIFETIME metric this is still a compaction: the context window was truncated,
  // independent of whether the surviving prefix was a cache HIT (see cache.test.js).
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' },
  ]);
  assert.equal(d.compactionCount, 1, 'a warm compaction is still a compaction event');
  assert.equal(d.firstCompaction.turn, 2);
});

// ── honesty: no compaction, no fabricated metric ──────────────────────────────

test('diagnoseLifetime: a session that never shrank reports no compaction honestly', () => {
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' },
    { threadId: 'A', turn: 3, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 5, cacheRead: 2000 }), requestReceivedAt: '2026-07-28T07:52:00.000Z', responseCompletedAt: '2026-07-28T07:52:01.000Z' },
  ]);

  assert.equal(d.compactionCount, 0);
  assert.equal(d.events.length, 0);
  assert.equal(d.firstCompaction, null);
  assert.equal(d.firstCompactionWallMs, null, 'no compaction ⇒ no fabricated wall-time');
  assert.equal(d.turnCount, 3);
});

// ── robustness: probes, missing timestamps ────────────────────────────────────

test('diagnoseLifetime: a probe turn (max_tokens===1) is never counted as a compaction', () => {
  // A probe is not a conversation turn and is filtered before analysis (cache spec §2.3).
  // Even if its tiny body "shrank" vs the baseline, it must not register as compaction.
  // `maxTokens` is the top-level field `toAnalysisInput` sets from `requestJson.max_tokens`
  // — the same field `computeWaste` reads, so the test mirrors the real input shape.
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, maxTokens: 1024, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, maxTokens: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'p' }] }, usage: usage({ input: 1 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' },
  ]);
  assert.equal(d.compactionCount, 0, 'the probe turn is filtered, never a compaction');
  assert.equal(d.turnCount, 1, 'only the non-probe turn counts toward turnCount');
});

test('diagnoseLifetime: missing timestamps leave wall-time null, but compaction is still reported', () => {
  // The window clearly shrank (turn 2 < turn 1) but no captured timestamps ⇒ the
  // compaction is still counted; only the wall-time is honestly unknown.
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 10 }), requestReceivedAt: null, responseCompletedAt: null },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 900 }), requestReceivedAt: null, responseCompletedAt: null },
  ]);
  assert.equal(d.compactionCount, 1, 'compaction is structural — detectable without timestamps');
  assert.equal(d.firstCompaction.turn, 2);
  assert.equal(d.sessionStartMs, null);
  assert.equal(d.firstCompactionWallMs, null, 'no timestamps ⇒ no fabricated wall-time');
});

test('diagnoseLifetime: an empty session reports no compaction without throwing', () => {
  const d = diagnoseLifetime([]);
  assert.equal(d.compactionCount, 0);
  assert.equal(d.firstCompaction, null);
  assert.equal(d.turnCount, 0);
});

// ── renderLifetime (text): shape over the structured Lifetime ─────────────────

test('renderLifetime (text): rollup names the lifetime in turns + minutes and lists per-event bytes', () => {
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'SUMMARY' }] }, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:53:00.000Z', responseCompletedAt: '2026-07-28T07:53:01.000Z' },
  ]);
  const out = renderLifetime(d, { sessionId: 'sess-x' }).lines.join('\n');

  assert.match(out, /lifetime/);
  assert.match(out, /sess-x/);
  assert.match(out, /effective lifetime/);
  assert.match(out, /2 turns/, 'turns-to-first-compact surfaced');
  assert.match(out, /3 min/, 'wall-time-to-first-compact surfaced');
  assert.match(out, /turn 2/, 'the compaction event is listed');
  assert.match(out, /bytes/, 'per-event bytes-dropped surfaced');
});

test('renderLifetime (text): a no-compaction session says so honestly and invents no lifetime', () => {
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:01.000Z' },
  ]);
  const out = renderLifetime(d, { sessionId: 'clean' }).lines.join('\n');

  assert.match(out, /no compaction/i);
  assert.doesNotMatch(out, /effective lifetime = \d+ turns/, 'no fabricated lifetime number');
});

test('renderLifetime (html): a self-contained HTML doc renders the same data', () => {
  const d = diagnoseLifetime([
    { threadId: 'A', turn: 1, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 10 }), requestReceivedAt: T0_RECV, responseCompletedAt: T0_DONE },
    { threadId: 'A', turn: 2, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'SUMMARY' }] }, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:53:00.000Z', responseCompletedAt: '2026-07-28T07:53:01.000Z' },
  ]);
  const html = renderLifetime(d, { sessionId: 'sess-x' }).html;
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /sess-x/);
  assert.match(html, /compaction/i);
});
