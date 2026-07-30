import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  hashSegment,
  resolveWasteConfig,
  DEFAULT_WASTE_CONFIG,
  segmentRequest,
  detectBloat,
  breakpointPositions,
  classifySegments,
  computeWaste,
} from '../src/waste.js';

/** Build a usage object the way readUsage() would. */
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

// ── canonicalization / hashing ────────────────────────────────────────────────

test('canonicalize sorts object keys recursively so key order never changes the hash', () => {
  const a = { b: 1, a: { d: 2, c: 3 } };
  const b = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(hashSegment(a), hashSegment(b));
});

test('canonicalize preserves string content — real payload, not formatting', () => {
  assert.notEqual(hashSegment({ text: 'a b' }), hashSegment({ text: 'a  b' }));
});

// ── config ────────────────────────────────────────────────────────────────────

test('resolveWasteConfig locks sane defaults and accepts finite overrides only', () => {
  assert.deepEqual(resolveWasteConfig(), DEFAULT_WASTE_CONFIG);
  const cfg = resolveWasteConfig({ bloatFloorBytes: 100, bloatSiblingMultiplier: NaN, coldCacheTokens: -1 });
  assert.equal(cfg.bloatFloorBytes, 100);
  assert.equal(cfg.bloatSiblingMultiplier, DEFAULT_WASTE_CONFIG.bloatSiblingMultiplier, 'NaN override ignored');
  assert.equal(cfg.coldCacheTokens, DEFAULT_WASTE_CONFIG.coldCacheTokens, 'negative override ignored');
});

// ── segmentation ────────────────────────────────────────────────────────────

test('segmentRequest splits system blocks, each tool def, and each message (render order)', () => {
  // The prompt cache is a prefix of the RENDERED stream — tools come first — so
  // segments are emitted in API render order: tools → system → messages (cache spec
  // §2.1 / issue #82). A tools-only change must diverge the prefix at position 0.
  const body = {
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ],
  };
  const segs = segmentRequest(body);
  const slots = segs.map((s) => s.slot);
  assert.deepEqual(slots, [
    'tool:Bash', 'tool:Read',
    'system#0', 'system#1',
    'message#0', 'message#1', 'message#2',
  ]);
  // Buckets: last message is the current turn, the rest are history.
  assert.equal(segs.find((s) => s.slot === 'message#2').bucket, 'currentTurn');
  assert.equal(segs.find((s) => s.slot === 'message#0').bucket, 'history');
  assert.equal(segs.find((s) => s.slot === 'tool:Bash').bucket, 'tools');
  assert.ok(segs.every((s) => s.bytes > 0 && s.hash.length > 0));
});

// ── cache_control breakpoints (render-ordered metadata, issue #82 Part 2.2) ─────

test('segmentRequest parses cache_control and attaches it as per-segment metadata', () => {
  // The real Claude Code layout (fixture-confirmed): two system blocks + one message
  // block carry a breakpoint, all ttl:"1h", NEVER on a tool. The message breakpoint
  // can sit on ANY content block of the message (here, not the first) — every block
  // is scanned, nothing is hard-coded to position 0.
  const cc = { type: 'ephemeral', ttl: '1h' };
  const body = {
    tools: [{ name: 'Bash' }, { name: 'Read' }],
    system: [
      { type: 'text', text: 'preamble' },
      { type: 'text', text: 'env', cache_control: cc },
      { type: 'text', text: 'mem', cache_control: cc },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part-a' },
          { type: 'text', text: 'part-b', cache_control: cc },
        ],
      },
      { role: 'assistant', content: 'a' },
    ],
  };
  const segs = segmentRequest(body);
  const withBp = segs.filter((s) => s.cacheControl);
  // Exactly the three CC breakpoints, in render order; tools and the bare system#0 carry none.
  assert.deepEqual(withBp.map((s) => s.slot), ['system#1', 'system#2', 'message#0']);
  assert.ok(withBp.every((s) => s.cacheControl === cc), 'the parsed breakpoint object is attached verbatim');
  assert.equal(segs.find((s) => s.slot === 'tool:Bash').cacheControl, undefined, 'CC never breakpoints a tool');
  assert.equal(segs.find((s) => s.slot === 'system#0').cacheControl, undefined);
});

test('breakpointPositions returns render-ordered indices and is not hard-coded', () => {
  const cc = { type: 'ephemeral', ttl: '1h' };
  // A breakpoint on a LATER message yields a different index than "the first
  // message" would, and a tool breakpoint (legal in the API even if CC omits it) is
  // indexed too — proving nothing is pinned to a fixed slot/count.
  const body = {
    tools: [{ name: 'Bash', cache_control: cc }],
    system: [{ type: 'text', text: 'a', cache_control: cc }],
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'q2', cache_control: cc }] },
    ],
  };
  const segs = segmentRequest(body);
  // Render order: tool:Bash(0) → system#0(1) → message#0(2) → message#1(3) → message#2(4).
  assert.deepEqual(segs.map((s) => s.slot), ['tool:Bash', 'system#0', 'message#0', 'message#1', 'message#2']);
  assert.deepEqual(breakpointPositions(segs), [0, 1, 4]);
});

test('breakpointPositions is empty when cache_control is absent (older capture / non-CC)', () => {
  const body = {
    tools: [{ name: 'Bash' }],
    system: 'a bare-string system carries no breakpoint',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const segs = segmentRequest(body);
  assert.deepEqual(breakpointPositions(segs), []);
  assert.ok(segs.every((s) => s.cacheControl === undefined));
});

test('a malformed cache_control is not counted as a breakpoint', () => {
  // Only the object form is a breakpoint the API honours; a scalar or array under
  // that key must not produce a phantom breakpoint in the frontier list.
  const segs = segmentRequest({
    tools: [{ name: 'Bash', cache_control: 'ephemeral' }],
    system: [{ type: 'text', text: 'a', cache_control: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: [] }] }],
  });
  assert.deepEqual(breakpointPositions(segs), []);
  assert.ok(segs.every((s) => s.cacheControl === undefined));
});

test('a cache_control on the message object itself is ignored (the API only honours blocks)', () => {
  const segs = segmentRequest({
    messages: [{ role: 'user', content: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  });
  assert.deepEqual(breakpointPositions(segs), []);
});

test('breakpoint parsing is null-safe across ragged tools / system / content arrays', () => {
  const cc = { type: 'ephemeral', ttl: '1h' };
  const segs = segmentRequest({
    tools: [null, { name: 'Read' }],
    system: [null, { type: 'text', text: 'a', cache_control: cc }],
    messages: [null, { role: 'user', content: [null, 'bare', { type: 'text', text: 'q', cache_control: cc }] }],
  });
  assert.deepEqual(segs.map((s) => s.slot), ['tool:#0', 'tool:Read', 'system#0', 'system#1', 'message#0', 'message#1']);
  assert.deepEqual(breakpointPositions(segs), [3, 5]);
});

test('the last breakpointed content block of a message wins', () => {
  // A message is atomic at our granularity, so only one breakpoint can be attached;
  // the LAST one closes the cacheable region, and a later block without one (or with
  // a malformed one) must not clear it.
  const first = { type: 'ephemeral', ttl: '5m' };
  const last = { type: 'ephemeral', ttl: '1h' };
  const segs = segmentRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'a', cache_control: first },
        { type: 'text', text: 'b', cache_control: last },
        { type: 'text', text: 'c' },
      ],
    }],
  });
  assert.equal(segs[0].cacheControl, last);
});

test('a tools-only change diverges the cache prefix at position 0 (the reorder payoff)', () => {
  // The reason segmentation moved to render order: with system first, a changed tool
  // def read as "system intact, break in tools". In render order the prefix diverges
  // at position 0, so the whole prefix is cold and the intact system is waste.
  const body = (toolDesc) => ({
    tools: [{ name: 'Bash', description: toolDesc }],
    system: [{ type: 'text', text: 'a long stable system preamble' }],
    messages: [{ role: 'user', content: 'q1' }],
  });
  const base = segmentRequest(body('run a command'));
  const cur = segmentRequest(body('run a command (v2)'));
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  assert.equal(cls.cacheBoundary, 0, 'nothing stays cached once the rendered head changes');
  const byslot = Object.fromEntries(cur.map((s) => [s.slot, s.kind]));
  assert.equal(byslot['tool:Bash'], 'new');
  assert.equal(byslot['system#0'], 'reused-uncached', 'the intact system is re-sent past the break');
  assert.equal(byslot['message#0'], 'reused-uncached');
});

test('segmentRequest is null-safe and handles a bare-string system', () => {
  assert.deepEqual(segmentRequest(null), []);
  const segs = segmentRequest({ system: 'be brief', messages: [] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].slot, 'system');
});

// ── bloat (both floor AND sibling outlier) ────────────────────────────────────

test('detectBloat flags a sibling outlier above the floor, spares uniform results', () => {
  const big = 'x'.repeat(20000);
  const small = 'y'.repeat(100);
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', content: small },
        { type: 'tool_result', content: small },
        { type: 'tool_result', content: big },
      ],
    },
  ];
  const marks = detectBloat(messages, DEFAULT_WASTE_CONFIG);
  assert.ok(marks.has(0), 'the outlier message is flagged');
  assert.ok(marks.get(0) > 20000);

  // Uniformly large: above the floor but no outlier → not flagged.
  const uniform = [
    { role: 'user', content: [
      { type: 'tool_result', content: big },
      { type: 'tool_result', content: big },
    ] },
  ];
  assert.equal(detectBloat(uniform, DEFAULT_WASTE_CONFIG).size, 0);
});

test('detectBloat: a lone tool_result is governed by the floor alone', () => {
  const under = [{ role: 'user', content: [{ type: 'tool_result', content: 'small' }] }];
  assert.equal(detectBloat(under, DEFAULT_WASTE_CONFIG).size, 0);
  const over = [{ role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(20000) }] }];
  assert.equal(detectBloat(over, DEFAULT_WASTE_CONFIG).size, 1);
});

test('segmentRequest attaches bloat marks to the containing message segment', () => {
  const big = 'x'.repeat(20000);
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: 'tiny' }, { type: 'tool_result', content: big }] },
      { role: 'assistant', content: 'ok' },
    ],
  };
  const segs = segmentRequest(body);
  const m0 = segs.find((s) => s.slot === 'message#0');
  assert.equal(m0.bloated, true);
  assert.ok(m0.bloatBytes > 20000);
});

// ── re-sent diff (usage-arbitrated) ───────────────────────────────────────────

test('classifySegments marks a first request all-new (no baseline)', () => {
  const segs = segmentRequest({ system: 'a', messages: [{ role: 'user', content: 'hi' }] });
  const cls = classifySegments(segs, null, usage({ input: 10 }));
  assert.ok(segs.every((s) => s.kind === 'new'));
  assert.equal(cls.reusedUncachedBytes, 0);
});

test('classifySegments: warm-cache prefix is reused-cached, new tail is new', () => {
  const base = segmentRequest({
    system: 'sys',
    messages: [{ role: 'user', content: 'q1' }],
  });
  const cur = segmentRequest({
    system: 'sys',
    messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }],
  });
  // Warm cache: cache_read dominant so the whole reused prefix is confirmed cached.
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  const byslot = Object.fromEntries(cur.map((s) => [s.slot, s.kind]));
  assert.equal(byslot['system'], 'reused-cached');
  assert.equal(byslot['message#0'], 'reused-cached');
  assert.equal(byslot['message#1'], 'new');
  assert.ok(cls.cacheBoundary >= 2);
  assert.equal(cls.reusedUncachedBytes, 0);
});

test('classifySegments: cold cache collapses every reused segment to waste', () => {
  const base = segmentRequest({ system: 'sys', messages: [{ role: 'user', content: 'q1' }] });
  const cur = segmentRequest({ system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] });
  const cls = classifySegments(cur, base, usage({ input: 900, cacheRead: 0 }));
  const byslot = Object.fromEntries(cur.map((s) => [s.slot, s.kind]));
  assert.equal(byslot['system'], 'reused-uncached');
  assert.equal(byslot['message#0'], 'reused-uncached');
  assert.equal(byslot['message#1'], 'new');
  assert.equal(cls.cacheBoundary, 0);
  assert.ok(cls.cold);
  assert.ok(cls.reusedUncachedBytes > 0);
});

test('classifySegments: an identical segment past a divergence is reused-uncached', () => {
  // message#0 changes (cache prefix breaks) but message#1 is byte-identical → waste.
  const base = segmentRequest({
    messages: [{ role: 'user', content: 'ORIGINAL' }, { role: 'system', content: 'SHARED-BLOCK' }],
  });
  const cur = segmentRequest({
    messages: [{ role: 'user', content: 'CHANGED' }, { role: 'system', content: 'SHARED-BLOCK' }],
  });
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  const byslot = Object.fromEntries(cur.map((s) => [s.slot, s.kind]));
  assert.equal(byslot['message#0'], 'new', 'changed segment breaks the prefix');
  assert.equal(byslot['message#1'], 'reused-uncached', 'identical-but-past-divergence is waste');
  assert.ok(cls.reusedUncachedBytes > 0);
});

// ── whole-session waste (lineage + static + flagship) ──────────────────────────

test('computeWaste diffs against the prior request in the SAME thread lineage', () => {
  // main thread A: r0 then r2. subagent thread B: r1 interleaved. r1 must NOT be
  // r2's baseline — that would produce garbage classification (spec §1.6).
  const A = { system: 'mainsys', messages: [{ role: 'user', content: 'a1' }] };
  const A2 = { system: 'mainsys', messages: [{ role: 'user', content: 'a1' }, { role: 'user', content: 'a2' }] };
  const B = { system: 'subsys', messages: [{ role: 'user', content: 'b1' }] };
  const exchanges = [
    { threadId: 'A', requestBody: A, usage: usage({ input: 10 }) },
    { threadId: 'B', requestBody: B, usage: usage({ input: 10 }) },
    { threadId: 'A', requestBody: A2, usage: usage({ input: 5, cacheRead: 1000 }) },
  ];
  const { perExchange } = computeWaste(exchanges);
  const r2 = perExchange[2];
  const byslot = Object.fromEntries(r2.segments.map((s) => [s.slot, s.kind]));
  // system reused from A (its lineage), not treated as new against B's 'subsys'.
  assert.equal(byslot['system'], 'reused-cached');
  assert.equal(byslot['message#1'], 'new');
});

test('computeWaste surfaces static ∩ reused-uncached as the flagship case', () => {
  // A large system block stays identical across turns (static) but is re-sent on a
  // cold cache (reused-uncached) → flagship waste.
  const bigSys = 'S'.repeat(5000);
  const r0 = { system: bigSys, messages: [{ role: 'user', content: 'q1' }] };
  const r1 = { system: bigSys, messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const exchanges = [
    { threadId: 'A', requestBody: r0, usage: usage({ input: 10 }) },
    { threadId: 'A', requestBody: r1, usage: usage({ input: 900, cacheRead: 0 }) }, // cold
  ];
  const { perExchange, summary } = computeWaste(exchanges);
  const sys = perExchange[1].segments.find((s) => s.slot === 'system');
  assert.equal(sys.static, true);
  assert.equal(sys.kind, 'reused-uncached');
  assert.equal(sys.flagship, true);
  assert.ok(perExchange[1].flagshipCount >= 1);
  assert.ok(summary.flagshipBytes >= 5000);
  assert.ok(summary.reusedUncachedBytes >= 5000, 'headline waste = reused-uncached bytes');
});

test('computeWaste counts bloat separately from the re-sent tally', () => {
  const big = 'x'.repeat(20000);
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: 'tiny' }, { type: 'tool_result', content: big }] },
    ],
  };
  const { perExchange, summary } = computeWaste([{ threadId: 'A', requestBody: body, usage: usage({ input: 10 }) }]);
  assert.equal(summary.bloatCount, 1);
  assert.equal(perExchange[0].bloatCount, 1);
  // A first-request bloat is not re-sent waste — separate signal.
  assert.equal(summary.reusedUncachedBytes, 0);
});

test('a slot that appears only once is NOT static (single-appearance blocks never recur)', () => {
  // One request in its lineage — every slot appears exactly once, so nothing can be
  // "unchanged across turns". A brand-new one-off block must not carry a static flag.
  const { perExchange } = computeWaste([
    { threadId: 'A', requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }) },
  ]);
  assert.ok(perExchange[0].segments.every((s) => s.kind === 'new'));
  assert.ok(perExchange[0].segments.every((s) => s.static === false), 'no once-seen slot is static');
});

test('the final current turn (a one-off slot) is not mislabeled static across a growing lineage', () => {
  // As the conversation grows, the last message of each request is new that turn and
  // recurs (unchanged) as history later — so it IS static. But the LAST request\'s
  // current turn never recurs; it must stay non-static.
  const mk = (n) => ({ system: 'sys', messages: Array.from({ length: n }, (_, k) => ({ role: 'user', content: 'q' + k })) });
  const { perExchange } = computeWaste([
    { threadId: 'A', requestBody: mk(1), usage: usage({ input: 10 }) },
    { threadId: 'A', requestBody: mk(2), usage: usage({ input: 5, cacheRead: 1000 }) },
    { threadId: 'A', requestBody: mk(3), usage: usage({ input: 5, cacheRead: 1000 }) },
  ]);
  // message#0 recurs unchanged across all three → static.
  const m0 = perExchange[2].segments.find((s) => s.slot === 'message#0');
  assert.equal(m0.static, true);
  // message#2 is the final current turn, seen only in the last request → not static.
  const last = perExchange[2].segments.find((s) => s.slot === 'message#2');
  assert.equal(last.kind, 'new');
  assert.equal(last.static, false);
});

test('static requires unchanged content — a slot whose content changes is not static', () => {
  const { perExchange } = computeWaste([
    { threadId: 'A', requestBody: { system: 'v1', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }) },
    { threadId: 'A', requestBody: { system: 'v2', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 5, cacheRead: 1000 }) },
  ]);
  const sys = perExchange[1].segments.find((s) => s.slot === 'system');
  assert.equal(sys.static, false, 'content changed between turns → not static');
});

// ── enriched classification (cache T2, issue #83 / cache spec §2.3) ────────────
// Additive exposures consumed by the cache diagnostic (T3 #84). Verified
// structurally here + by the existing waste suite staying green (no separate
// seam — these are asserted through diagnoseCache once it exists).

test('classifySegments exposes lcp, hadBaseline, mutationSite, residual on a reused prefix', () => {
  // Append-only growth: system + message#0 reused (cached), message#1 is new.
  const base = segmentRequest({ system: 'sys', messages: [{ role: 'user', content: 'q1' }] });
  const cur = segmentRequest({
    system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }],
  });
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  // Content frontier: 2 leading segments match (system + message#0).
  assert.equal(cls.hadBaseline, true);
  assert.equal(cls.lcp, 2, 'system + message#0 form the reused content prefix');
  // Divergence sits at the appended turn (the structural frontier points there).
  assert.equal(cls.mutationSite, 'message#1');
  // Warm cache → no re-written region; only the new turn is genuinely-new content.
  assert.equal(cls.residual.rewrittenBytes, 0);
  assert.ok(cls.residual.newBytes > 0, 'the new turn is the genuinely-new write mass');
  assert.equal(cls.residual.total, cls.residual.newBytes);
});

test('classifySegments puts the mutationSite at the edited slot, not the tail', () => {
  // message#0 is edited → the prefix diverges at position 0; message#1 is identical
  // but re-sent past the break. The structural culprit is message#0.
  const base = segmentRequest({
    messages: [{ role: 'user', content: 'ORIGINAL' }, { role: 'system', content: 'SHARED' }],
  });
  const cur = segmentRequest({
    messages: [{ role: 'user', content: 'CHANGED' }, { role: 'system', content: 'SHARED' }],
  });
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  assert.equal(cls.lcp, 0, 'the edited message#0 breaks the prefix at position 0');
  assert.equal(cls.mutationSite, 'message#0', 'the culprit is the edited slot, not the tail');
  // SHARED is reused-uncached (re-written); CHANGED is genuinely new.
  assert.ok(cls.residual.rewrittenBytes > 0, 'the identical-but-past-divergence block is re-written');
  assert.ok(cls.residual.newBytes > 0);
  assert.equal(cls.residual.total, cls.residual.rewrittenBytes + cls.residual.newBytes);
});

test('classifySegments: cold cache attributes the whole reused prefix to the re-written region', () => {
  const base = segmentRequest({ system: 'sys', messages: [{ role: 'user', content: 'q1' }] });
  const cur = segmentRequest({
    system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }],
  });
  const cls = classifySegments(cur, base, usage({ input: 900, cacheRead: 0 }));
  assert.ok(cls.cold);
  // On a cold cache the reused prefix collapses to re-written waste.
  assert.ok(cls.residual.rewrittenBytes > 0);
  assert.ok(cls.residual.newBytes > 0, 'the new turn is still genuinely-new content');
});

test('classifySegments: no baseline ⇒ hadBaseline false, mutationSite null, residual null', () => {
  const segs = segmentRequest({ system: 'a', messages: [{ role: 'user', content: 'hi' }] });
  const cls = classifySegments(segs, null, usage({ input: 10 }));
  assert.equal(cls.hadBaseline, false);
  assert.equal(cls.lcp, 0);
  assert.equal(cls.mutationSite, null, 'nothing to diverge from on a first request');
  assert.equal(cls.residual, null, 'no re-write to attribute without a baseline');
});

test('classifySegments: a fully-identical request has no mutationSite (no divergence)', () => {
  const body = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const base = segmentRequest(body);
  const cur = segmentRequest(body);
  const cls = classifySegments(cur, base, usage({ input: 5, cacheRead: 1000 }));
  assert.equal(cls.lcp, base.length, 'every segment matches');
  assert.equal(cls.mutationSite, null, 'the prefix never diverges');
  assert.equal(cls.residual.rewrittenBytes, 0);
  assert.equal(cls.residual.newBytes, 0);
});

test('computeWaste injects now and a bounded idleMs from captured per-turn timestamps', () => {
  // Two turns in thread A. The gap is e1.requestReceivedAt − e0.responseCompletedAt.
  const exchanges = [
    {
      threadId: 'A',
      requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] },
      usage: usage({ input: 10 }),
      requestReceivedAt: '2026-07-28T07:50:59.375Z',
      responseCompletedAt: '2026-07-28T07:51:01.375Z',
    },
    {
      threadId: 'A',
      requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] },
      usage: usage({ input: 5, cacheRead: 1000 }),
      requestReceivedAt: '2026-07-28T07:51:09.375Z',
      responseCompletedAt: '2026-07-28T07:51:11.375Z',
    },
  ];
  const { perExchange } = computeWaste(exchanges);
  // First turn: a reference instant but no prior → no idle gap.
  assert.equal(perExchange[0].now, Date.parse('2026-07-28T07:50:59.375Z'));
  assert.equal(perExchange[0].idleMs, null);
  assert.equal(perExchange[0].idleMsReliable, true, 'a real thread_id gives a reliable gap');
  // Second turn: 09.375 − 01.375 = 8 000 ms after the prior turn completed.
  assert.equal(perExchange[1].now, Date.parse('2026-07-28T07:51:09.375Z'));
  assert.equal(perExchange[1].idleMs, 8000);
  assert.equal(perExchange[1].idleMsReliable, true);
});

test('computeWaste: idleMs is bounded — null when timestamps are missing, clamped ≥ 0', () => {
  // No timestamps on the prior turn ⇒ the gap is uncomputable (null), not NaN.
  const noStamp = { threadId: 'A', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }) };
  const withStamp = {
    threadId: 'A', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] },
    usage: usage({ input: 5, cacheRead: 1000 }),
    requestReceivedAt: '2026-07-28T07:51:09.375Z', responseCompletedAt: '2026-07-28T07:51:11.375Z',
  };
  const { perExchange: a } = computeWaste([noStamp, withStamp]);
  assert.equal(a[1].idleMs, null, 'no prior completion time ⇒ null, never NaN/Infinity');
  assert.equal(a[1].now, Date.parse('2026-07-28T07:51:09.375Z'));

  // A negative gap (prior completion AFTER this request — overlapping turns) is
  // clamped to 0 rather than reported as a negative idle.
  const early = {
    threadId: 'B', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }),
    requestReceivedAt: '2026-07-28T07:50:00.000Z', responseCompletedAt: '2026-07-28T07:52:00.000Z',
  };
  const overlap = {
    threadId: 'B', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }),
    requestReceivedAt: '2026-07-28T07:51:00.000Z', responseCompletedAt: '2026-07-28T07:51:02.000Z',
  };
  const { perExchange: b } = computeWaste([early, overlap]);
  assert.equal(b[1].idleMs, 0, 'a negative gap is bounded at 0');
});

test('computeWaste marks the __no_thread__ lineage as idleMs-unreliable', () => {
  // Exchanges without a thread_id share one capture-order lane; their inter-turn
  // gap does not represent a real same-conversation idle, so TEMPORAL verdicts
  // there must be suppressed/marked (issue #83 / cache spec §2.3).
  const exchanges = [
    { requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }),
      requestReceivedAt: '2026-07-28T07:50:00.000Z', responseCompletedAt: '2026-07-28T07:50:02.000Z' },
    { requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }),
      requestReceivedAt: '2026-07-28T07:55:00.000Z', responseCompletedAt: '2026-07-28T07:55:02.000Z' },
  ];
  const { perExchange } = computeWaste(exchanges);
  assert.equal(perExchange[1].idleMsReliable, false, '__no_thread__ idleMs is unreliable');
  // The gap is still computed (T3 may show it) but flagged so it cannot drive a
  // confident TEMPORAL verdict.
  assert.equal(perExchange[1].idleMs, 5 * 60 * 1000 - 2 * 1000);
});

test('computeWaste filters probe turns (max_tokens===1): never a baseline, marked probe', () => {
  // e0 real, e1 a max_tokens:1 probe with DIFFERENT content, e2 real again. e2 must
  // baseline against e0 (the prior REAL turn), not the probe — otherwise the probe's
  // 'DIFFERENT' system would make e2's intact system read as a divergence.
  const exchanges = [
    { threadId: 'A', maxTokens: 1024, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }),
      requestReceivedAt: '2026-07-28T07:50:00.000Z', responseCompletedAt: '2026-07-28T07:50:01.000Z' },
    { threadId: 'A', maxTokens: 1, requestBody: { system: 'DIFFERENT', messages: [{ role: 'user', content: 'x' }] }, usage: usage({ input: 1 }),
      requestReceivedAt: '2026-07-28T07:50:05.000Z', responseCompletedAt: '2026-07-28T07:50:06.000Z' },
    { threadId: 'A', maxTokens: 1024, requestBody: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }),
      requestReceivedAt: '2026-07-28T07:52:00.000Z', responseCompletedAt: '2026-07-28T07:52:02.000Z' },
  ];
  const { perExchange } = computeWaste(exchanges);
  assert.deepEqual(perExchange.map((e) => e.probe), [false, true, false]);
  // e2 baselined against e0 (lcp 2, system reused-cached), NOT the probe e1.
  const e2sys = perExchange[2].segments.find((s) => s.slot === 'system');
  assert.equal(e2sys.kind, 'reused-cached', 'the probe was not used as the baseline');
  assert.equal(perExchange[2].lcp, 2);
  // The probe's completion time is not the origin of e2's idle gap — e0's is.
  // 07:52:00 − 07:50:01 (e0 completed) = 119 000 ms; the probe's 07:50:06 would be 114 000.
  assert.equal(perExchange[2].idleMs, 119000, 'the probe did not supply the idle origin');
});

test('computeWaste never calls Date.now() — now/idleMs come from injected timestamps', () => {
  // `now` is injected from captured timestamps; the wall clock must stay out of the
  // waste/diagnostic logic (cache spec §2.3 / issue #83). If Date.now() were on the
  // path this override would throw.
  const real = Date.now;
  Date.now = () => { throw new Error('Date.now() must not be called inside waste logic'); };
  try {
    const { perExchange } = computeWaste([
      { threadId: 'A', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }] }, usage: usage({ input: 10 }),
        requestReceivedAt: '2026-07-28T07:50:59.375Z', responseCompletedAt: '2026-07-28T07:51:01.375Z' },
      { threadId: 'A', requestBody: { system: 's', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usage: usage({ input: 5, cacheRead: 1000 }),
        requestReceivedAt: '2026-07-28T07:51:09.375Z', responseCompletedAt: '2026-07-28T07:51:11.375Z' },
    ]);
    assert.equal(perExchange[1].idleMs, 8000);
    assert.ok(Number.isFinite(perExchange[1].now));
  } finally {
    Date.now = real;
  }
});
