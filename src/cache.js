// Cache-economy diagnostic — the single logic seam of the cache feature
// (cache spec §3 / issue #84). `diagnoseCache` is PURE: no I/O, no wall clock.
// It reuses the waste substrate (`computeWaste`, cache spec §2.3) for the enriched
// per-turn classification — lcp / cacheBoundary / mutationSite / residual / idleMs —
// and arbitrates the four verdicts (HIT / STRUCTURAL / TEMPORAL / UNEXPLAINED) by
// **region partition** over three layered frontiers.
//
// Non-negotiables honoured here:
//   • NEVER re-tokenize and never call `Date.now()`. Time is INJECTED: the per-turn
//     `idleMs` comes from the captured timestamps (computed by `computeWaste`); the
//     TTL threshold is a `{ ttl }` option (default 1 h). `now` is accepted for
//     signature fidelity with the spec and reserved for a session-wide reference —
//     the temporal axis is the exact captured inter-turn gap, not a live clock.
//   • `usage` is authoritative for what was cached (`cacheBoundary`); content and
//     breakpoint predictions never override it. A contradiction resolves to a
//     verdict, never to an override.
//   • UNEXPLAINED is first-class: the cache key is not exhaustively published, so the
//     diagnostic never invents a cause for it (cause stays `null`).

import { computeWaste, breakpointPositions } from './waste.js';

/** Default TTL threshold (cache spec AC #26): 1 h, the ttl Claude Code places. */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** @typedef {'HIT'|'STRUCTURAL'|'TEMPORAL'|'UNEXPLAINED'} Verdict */
/** @typedef {'KEY'|'PREFIX'|'TRUNCATED'} StructMode */
/** @typedef {'3-frontier'|'2-frontier-fallback'} FrontierModel */

/**
 * @typedef {object} Region
 * @property {[number, number]} range   Half-open segment-index range [start, end).
 * @property {Verdict} verdict
 * @property {StructMode} [structMode]  Set on STRUCTURAL regions.
 * @property {string | null} [cause]    Human cause; `null` for a truly unexplained region
 *     (never fabricated). A divorce / content-keyed region carries an OBSERVED cause.
 * @property {string} [culpritSlot]     The mutated slot (`current[lcp].slot`) on STRUCTURAL.
 * @property {boolean} [uncachedByDesign]  The breakpoint↔LCP divorce: stable content that no
 *     `cache_control` breakpoint covers, re-processed at full rate every turn. Diagnostic-only.
 * @property {'high'|'low'} [confidence]  TEMPORAL only: low when the gap straddles the TTL.
 * @property {number} bytes              Canonical byte extent of the range (cost proxy; T4 prices it).
 * @property {string} [note]             Honest limitation context (e.g. an unreliable gap).
 */

/**
 * @typedef {object} Card
 * @property {number} turn               The exchange's turn number.
 * @property {Region[]} regions          Non-empty regions of the partition.
 * @property {Region} headline           The dominant region (greatest byte extent; a structural
 *     culprit is always named via `culpritSlot` even when STRUCTURAL is not the headline).
 * @property {boolean} composite         More than one non-HIT region (verdict is composite).
 * @property {string | null} [culpritSlot]  The structural culprit, when any region is STRUCTURAL.
 * @property {FrontierModel} frontierModel  Per-turn: 3-frontier when breakpoints are present.
 * // `reco?` is added by T5 (#86); per-region `cost?` is added by T4 (#85).
 */

/**
 * @typedef {object} Rollup
 * @property {Record<Verdict, number>} byVerdict     Headline-verdict counts.
 * @property {Record<StructMode, number>} byStructMode  STRUCTURAL sub-mode counts.
 * @property {number} coldTransitions    Transitions whose headline is not HIT.
 * @property {number} totalTransitions   Every emitted card (incl. HIT).
 * // `totals` / `summedCounterfactual` (T4 #85) and `rollupRecos` (T5 #86) are added downstream.
 */

/**
 * @typedef {object} Diagnostic
 * @property {Card[]} transitions
 * @property {Rollup} rollup
 * @property {FrontierModel} frontierModel  Session-level: 3-frontier if any request carried
 *     `cache_control`, else the 2-frontier fallback.
 * @property {string} [note]  Set on the 2-frontier fallback (capability dimension unavailable).
 */

/**
 * Diagnose the cache economy of a captured session. Pure: reuses `computeWaste` for the
 * enriched classification, then partitions each transition into verdict regions.
 *
 * @param {Array<{ threadId?: string|null, requestBody: any, usage: import('./report.js').Usage|null,
 *   requestReceivedAt?: string|null, responseCompletedAt?: string|null, maxTokens?: unknown,
 *   turn?: number }>} session  The same exchange shape `computeWaste` consumes.
 * @param {{ ttl?: number, now?: number }} [opts]  `ttl` (ms, default 1 h); `now` reserved.
 * @returns {Diagnostic}
 */
export function diagnoseCache(session, opts = {}) {
  const ttl = typeof opts.ttl === 'number' && Number.isFinite(opts.ttl) && opts.ttl >= 0
    ? opts.ttl
    : DEFAULT_CACHE_TTL_MS;
  // `opts.now` is accepted for spec-faithful signature / a future session-wide reference,
  // but the temporal axis is the captured `idleMs` (computed by computeWaste) — never a
  // live clock — so it is intentionally not read here.

  const { perExchange } = computeWaste(session);

  /** @type {Card[]} */
  const transitions = [];
  let anyBreakpoints = false;

  for (let i = 0; i < session.length; i++) {
    const w = perExchange[i];
    if (w.probe) continue; // one-shot probes are filtered before the diagnostic (cache spec §2.3)
    const segs = w.segments;
    if (breakpointPositions(segs).length > 0) anyBreakpoints = true;
    const card = diagnoseTurn(session[i], i, w, ttl);
    if (card) transitions.push(card);
  }

  return finalize(transitions, anyBreakpoints);
}

/**
 * Diagnose one exchange into a card (or `null` when there is nothing to diagnose).
 * @param {object} e
 * @param {number} index
 * @param {import('./waste.js').ExchangeWaste} w
 * @param {number} ttl
 * @returns {Card | null}
 */
function diagnoseTurn(e, index, w, ttl) {
  const segs = w.segments;
  const end = segs.length;
  const c = w.cacheBoundary; // reality frontier (what was served)
  const l = w.lcp; // content frontier (mutation point)
  const b = w.baselineLength; // prior extent (baseline segment count)
  const { hasBreakpoints, lmb } = capabilityFrontier(segs, l);
  const compacted = end < b; // compaction/truncation shrank the turn vs its baseline
  // Cold = the cache stopped serving prior-prefix content that is STILL in this turn. The
  // prior extent still present is [0, min(b, end)) (compaction may have dropped the tail),
  // so a warm compaction — which served everything it sent (c == end) — is a HIT, not cold.
  const priorExtent = Math.min(b, end);
  const cold = c < priorExtent;

  // No baseline: either the establishing turn (nothing expired → skip) or a cache_read
  // with no captured antecedent (content-keyed cache → UNEXPLAINED, cache spec §3).
  if (!w.hadBaseline) {
    const cacheRead = e.usage ? e.usage.cacheReadInputTokens : 0;
    if (cacheRead > 0) {
      /** @type {Region} */
      const region = {
        range: range(0, end),
        verdict: 'UNEXPLAINED',
        cause: 'cache_read with no captured antecedent — a content-keyed cache or a partial capture served content we never saw written',
        bytes: extent(segs, 0, end),
      };
      return card(turnOf(e, index), [region], hasBreakpoints);
    }
    return null; // establishing turn: brand-new content, no prior prefix to expire
  }

  // HIT: the cache served the entire prior prefix (nothing expired or was dropped).
  if (!cold) {
    /** @type {Region} */
    const region = {
      range: range(0, c),
      verdict: 'HIT',
      cause: 'cached prefix served — nothing expired this turn',
      bytes: extent(segs, 0, c),
    };
    return card(turnOf(e, index), [region], hasBreakpoints);
  }

  // ── cold turn: partition [cacheBoundary, end) into verdict regions ──────────────
  /** @type {Region[]} */
  const regions = [];
  const gap = w.idleMs;
  const reliable = w.idleMsReliable;
  const purePrefixShrink = compacted && l === end; // shrank with no in-current divergence

  // (1) Identical-but-cold prefix [c, l): content matches the baseline yet was not served.
  //     A pure prefix-shrink compaction folds this into the TRUNCATED region below instead.
  if (l > c && !purePrefixShrink) {
    if (hasBreakpoints && lmb !== undefined) {
      // 3-frontier split: [c, lmb) capable-but-cold vs [lmb, l) stable-but-uncached (divorce).
      if (lmb > c) regions.push(capableColdRegion(c, Math.min(lmb, l), segs, gap, reliable, ttl));
      if (l > lmb) regions.push(divorceRegion(lmb, l, segs));
    } else {
      regions.push(capableColdRegion(c, l, segs, gap, reliable, ttl));
    }
  }

  // (2) Structural region: divergent baseline content re-written because of a mutation,
  //     or — for a compaction — the cold extent of a turn that lost content.
  const structuralEnd = priorExtent;
  if (l < structuralEnd) {
    const mode = compacted ? 'TRUNCATED' : structModeFor(w.mutationSite);
    regions.push(structuralRegion(l, structuralEnd, w.mutationSite, mode, segs));
  } else if (purePrefixShrink && c < end) {
    // Compaction dropped the tail with no surviving divergence: the cold prefix is
    // compaction-caused, not temporal.
    regions.push(structuralRegion(c, end, null, 'TRUNCATED', segs));
  }

  return card(turnOf(e, index), regions, hasBreakpoints);
}

/**
 * The capability frontier: what *could* have been cached, from the render-ordered
 * `cache_control` breakpoints (cache spec §3 / issue #84). A breakpoint at segment index p
 * covers the prefix [0, p]; the last breakpoint that sits within the stable prefix
 * (p < lcp) is `lastMatchingBreakpoint`, expressed as an exclusive length (p + 1). Content
 * beyond it up to lcp is stable but never cached (the divorce). `undefined` when no
 * breakpoints are present (the 2-frontier fallback).
 * @param {import('./waste.js').Segment[]} segments
 * @param {number} lcp
 * @returns {{ hasBreakpoints: boolean, lmb: number | undefined }}
 */
function capabilityFrontier(segments, lcp) {
  const bps = breakpointPositions(segments);
  if (bps.length === 0) return { hasBreakpoints: false, lmb: undefined };
  let maxMatching = -1;
  for (const p of bps) if (p < lcp && p > maxMatching) maxMatching = p;
  return { hasBreakpoints: true, lmb: maxMatching >= 0 ? maxMatching + 1 : 0 };
}

/**
 * TEMPORAL vs UNEXPLAINED for an identical-but-cold region. TEMPORAL only when the
 * inter-turn gap is known, reliable, and at least the TTL (the prefix expired); the
 * confidence is low when the gap straddles the TTL. Otherwise UNEXPLAINED — and never a
 * fabricated cause (the cache key is not exhaustively published).
 * @param {number} start
 * @param {number} endExclusive
 * @param {import('./waste.js').Segment[]} segs
 * @param {number | null} gap
 * @param {boolean} reliable
 * @param {number} ttl
 * @returns {Region}
 */
function capableColdRegion(start, endExclusive, segs, gap, reliable, ttl) {
  const base = { range: range(start, endExclusive), bytes: extent(segs, start, endExclusive) };
  if (gap != null && reliable && gap >= ttl) {
    const minutes = (ms) => Math.round(ms / 60000);
    return {
      ...base,
      verdict: 'TEMPORAL',
      cause: `cached prefix idle ${minutes(gap)} min ≥ TTL ${minutes(ttl)} min — it expired before this turn`,
      confidence: gap >= ttl * 1.2 ? 'high' : 'low',
    };
  }
  // gap < TTL but still cold, or the gap is unknown / unreliable → the cause is hidden.
  /** @type {Region} */
  const r = { ...base, verdict: 'UNEXPLAINED', cause: null };
  if (gap != null && !reliable && gap >= ttl) {
    // __no_thread__ lane: the gap does not represent a real same-conversation idle, so a
    // TEMPORAL cause cannot be confirmed (cache spec §2.3). Honest limitation, not a cause.
    r.note = 'inter-turn gap unreliable for this lineage (__no_thread__); TEMPORAL not confirmable';
  }
  return r;
}

/**
 * The breakpoint↔LCP divorce: stable content past the last covered point, never cached.
 * First-class and diagnostic-only — never mis-blamed on time or a mutation.
 * @param {number} start
 * @param {number} endExclusive
 * @param {import('./waste.js').Segment[]} segs
 * @returns {Region}
 */
function divorceRegion(start, endExclusive, segs) {
  return {
    range: range(start, endExclusive),
    verdict: 'UNEXPLAINED',
    cause: 'UNCACHED-by-design: this stable region has no cache_control breakpoint, so it is re-processed at full rate every turn',
    uncachedByDesign: true,
    bytes: extent(segs, start, endExclusive),
  };
}

/**
 * STRUCTURAL region with its sub-mode. KEY = a tools/system mutation invalidating from the
 * head; PREFIX = a history-only mutation (the head stays cached); TRUNCATED = compaction.
 * @param {number} start
 * @param {number} endExclusive
 * @param {string | null} culpritSlot
 * @param {StructMode} mode
 * @param {import('./waste.js').Segment[]} segs
 * @returns {Region}
 */
function structuralRegion(start, endExclusive, culpritSlot, mode, segs) {
  return {
    range: range(start, endExclusive),
    verdict: 'STRUCTURAL',
    structMode: mode,
    cause: structuralCause(mode, culpritSlot),
    culpritSlot: culpritSlot ?? undefined,
    bytes: extent(segs, start, endExclusive),
  };
}

/**
 * @param {StructMode} mode
 * @param {string | null} culpritSlot
 * @returns {string}
 */
function structuralCause(mode, culpritSlot) {
  const at = culpritSlot ? ` at ${culpritSlot}` : '';
  switch (mode) {
    case 'KEY':
      return `the cached prefix was invalidated${at} — a tools/system mutation re-writes the whole prefix`;
    case 'PREFIX':
      return `history mutated${at} — the head stays cached, the tail downstream is re-written`;
    case 'TRUNCATED':
      return 'compaction/truncation replaced or dropped history — the prefix was re-processed';
    default:
      return 'structural mutation re-wrote the prefix';
  }
}

/**
 * KEY vs PREFIX from the mutation slot. Tools and system blocks sit in the rendered head
 * (tools first), so a mutation there is a whole-prefix KEY invalidation; a message mutation
 * is a history-only PREFIX edit. (TRUNCATED is decided by compaction, not here.)
 * @param {string | null} mutationSite
 * @returns {StructMode}
 */
function structModeFor(mutationSite) {
  if (!mutationSite) return 'PREFIX';
  if (mutationSite.startsWith('tool:') || mutationSite.startsWith('system')) return 'KEY';
  return 'PREFIX'; // message#* → history edit
}

/**
 * Assemble a card: pick the headline (dominant byte extent; tie-broken toward STRUCTURAL
 * so a structural culprit headlines), flag composite, and surface the structural culprit.
 * @param {number} turn
 * @param {Region[]} regions
 * @param {boolean} hasBreakpoints
 * @returns {Card}
 */
function card(turn, regions, hasBreakpoints) {
  const priority = { STRUCTURAL: 0, TEMPORAL: 1, UNEXPLAINED: 2, HIT: 3 };
  let headline = regions[0];
  for (const r of regions) {
    if (r.bytes > headline.bytes) headline = r;
    else if (r.bytes === headline.bytes && priority[r.verdict] < priority[headline.verdict]) headline = r;
  }
  const structural = regions.find((r) => r.verdict === 'STRUCTURAL');
  const composite = regions.filter((r) => r.verdict !== 'HIT').length > 1;
  /** @type {Card} */
  const out = { turn, regions, headline, composite, frontierModel: hasBreakpoints ? '3-frontier' : '2-frontier-fallback' };
  if (structural) out.culpritSlot = structural.culpritSlot ?? null;
  return out;
}

/**
 * @param {Card[]} transitions
 * @param {boolean} anyBreakpoints
 * @returns {Diagnostic}
 */
function finalize(transitions, anyBreakpoints) {
  /** @type {Record<Verdict, number>} */
  const byVerdict = { HIT: 0, STRUCTURAL: 0, TEMPORAL: 0, UNEXPLAINED: 0 };
  /** @type {Record<StructMode, number>} */
  const byStructMode = { KEY: 0, PREFIX: 0, TRUNCATED: 0 };
  for (const c of transitions) {
    byVerdict[c.headline.verdict]++;
    if (c.headline.verdict === 'STRUCTURAL' && c.headline.structMode) byStructMode[c.headline.structMode]++;
  }
  const frontierModel = anyBreakpoints ? '3-frontier' : '2-frontier-fallback';
  /** @type {Diagnostic} */
  const out = {
    transitions,
    rollup: {
      byVerdict,
      byStructMode,
      coldTransitions: transitions.filter((c) => c.headline.verdict !== 'HIT').length,
      totalTransitions: transitions.length,
    },
    frontierModel,
  };
  if (!anyBreakpoints) {
    out.note =
      'cache_control is absent on these requests — the capability frontier (what could have been cached) is unavailable, so the breakpoint↔LCP divorce is not reported';
  }
  return out;
}

/** @param {number} s @param {number} e @returns {[number, number]} */
function range(s, e) {
  return [s, e];
}

/** Canonical byte extent of a segment range (the only legal size measure; never re-tokens). */
function extent(segs, start, endExclusive) {
  let s = 0;
  for (let i = start; i < endExclusive && i < segs.length; i++) s += segs[i].bytes;
  return s;
}

/** @param {object} e @param {number} index @returns {number} */
function turnOf(e, index) {
  return typeof e.turn === 'number' ? e.turn : index + 1;
}
