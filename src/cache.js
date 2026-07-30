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
//   • Cost (T4 #85) is in effective token-equivalents = tokens × tier multiplier, and the
//     tokens come ONLY from `usage` (`cacheCreation{5m,1h}` / `cacheRead`); `cache_control.ttl`
//     is never used for cost. Tier-unknown ⇒ a `[×1.25, ×2]` bound, never a false-precise
//     number; usage-absent ⇒ no cost line. Rollup totals are exact from `usage`.

import { computeWaste, breakpointPositions } from './waste.js';
import { resolveRoots, listSessions, pickLatestSession, loadExchanges, toAnalysisInput } from './report.js';

/** Default TTL threshold (cache spec AC #26): 1 h, the ttl Claude Code places. */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Chronicity threshold (cache spec §5 / issue #86): a structural culprit slot must recur
 * across this many transitions before the "stabilize the volatile block" reco fires. The
 * spec says "≥ 2–3 transitions — never on a one-off edit"; the floor (2) is used so a
 * single recurring slot qualifies while a genuine one-off (1) never does. It is also the
 * hard floor for the `chronicityThreshold` option: the "never on a one-off" invariant is
 * not configurable away — a caller may only ask for a stricter threshold.
 */
export const CHRONICITY_THRESHOLD = 2;

/**
 * Cache-tier effective-cost multipliers (cache spec §4 / issue #85). The cost unit is the
 * **effective token-equivalent** = tokens × tier multiplier (a cache-write is billed at
 * ×1.25 for a 5 m TTL or ×2 for a 1 h TTL; a cache-read at ×0.1), so a 1 h write and a
 * cache read are directly comparable. The tier comes ONLY from captured `usage`
 * (`cacheCreation{5m,1h}`); `cache_control.ttl` is never used for cost.
 */
export const TIER_MULTIPLIERS = Object.freeze({ '5m': 1.25, '1h': 2, read: 0.1 });

/**
 * The tier-unknown bound (cache spec §4): write mass the per-tier fields do not account for
 * — all of it when `usage` carries a flat `cache_creation` but neither per-tier field — is
 * somewhere in [×1.25, ×2]. Costed as a bound, never a false-precise single number.
 */
export const UNKNOWN_TIER_RANGE = Object.freeze([1.25, 2]);

/** @typedef {'HIT'|'STRUCTURAL'|'TEMPORAL'|'UNEXPLAINED'} Verdict */
/** @typedef {'KEY'|'PREFIX'|'TRUNCATED'} StructMode */
/** @typedef {'3-frontier'|'2-frontier-fallback'} FrontierModel */
/** @typedef {'5m'|'1h'|'read'} KnownTier */
/** @typedef {'5m'|'1h'|'read'|'mixed'|'unknown'} Tier */

/**
 * @typedef {object} TierCost
 * @property {KnownTier} tier
 * @property {number} rawTokens   Token count from captured `usage` (never estimated).
 * @property {number} multiplier  The tier multiplier (1.25 / 2 / 0.1).
 * @property {number} equiv       `rawTokens × multiplier` (effective token-equivalents).
 */

/**
 * @typedef {object} TokEquiv
 * @property {number} rawTokens                 Σ raw tokens priced here — `components` plus
 *     `unknownTokens`. Always the whole write mass `usage` reported; nothing is dropped.
 * @property {TierCost[]} components            The per-tier multiplier breakdown (one entry
 *     per known tier present; empty when no tier is known).
 * @property {number} unknownTokens             Raw tokens whose tier `usage` did not report
 *     (the flat `cache_creation` mass the per-tier fields leave unaccounted). Priced as a
 *     `[×1.25, ×2]` span, never as a point.
 * @property {number | null} equiv              Σ `components[].equiv` — the exact effective
 *     token-equivalents. `null` when any mass is tier-unknown (a false-precise single number
 *     is forbidden — see `equivRange`).
 * @property {number | null} multiplier         The single multiplier when exactly one tier
 *     applies to the whole write; `null` when the write is mixed or any mass is tier-unknown.
 * @property {Tier} tier
 * @property {[number, number] | null} equivRange  `[lo, hi]` bound when any mass is
 *     tier-unknown (the known equiv plus `unknownTokens × [1.25, 2]`); `null` otherwise.
 * @property {boolean} bounded                  `true` when the figure is an upper bound, not an
 *     exact figure (per-transition waste when a request-aggregate `usage` cannot be split
 *     between the re-written region and genuinely-new content).
 */

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
 * @property {TokEquiv} [cost]           The re-write cost in token-equivalents (T4 #85). Attached to a
 *     region only when it is the headline of a cold turn (a request-aggregate `usage` cannot be
 *     attributed across multiple regions without re-tokenizing, so the cost is not split per region).
 */

/** @typedef {'resume-before-ttl'|'group-turns'|'batch-invalidating'|'edit-last-turn'|'stabilize-volatile'|'fine-tune-bridge'|'weak-truncated'|'weak-divorce'} RecoKind */

/**
 * @typedef {object} Reco
 * @property {RecoKind} kind   Machine id (testing + rollup dedup).
 * @property {string} text     Human phrase, including the counterfactual.
 * @property {'avoidance'|'amortization'|'none'} form  Counterfactual form (cache spec §5).
 * @property {'high'|'low'} confidence  Counterfactual confidence — low ⇒ a conditional
 *     phrasing (a low-confidence TEMPORAL straddle never promises the saving).
 * @property {TokEquiv | null} counterfactual  The wasted basis — "would have avoided
 *     re-writing ~X tok-équ." (a lower bound, not a guarantee); `null` when the transition
 *     is uncosted (usage absent / no attributed re-write).
 * @property {boolean} [weak]  Diagnostic-only (TRUNCATED / the breakpoint↔LCP divorce) —
 *     the lever is known but not strongly user-controllable, so this is not a strong reco.
 * @property {string} [slot]   Culprit slot (PREFIX edit / chronicity / fine-tune bridge).
 * @property {number} [count]  Rollup-only: how many transitions this deduped reco covers.
 * @property {number} [recurrence]  Rollup-only (chronicity): how many turns the slot recurred.
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
 * @property {TokEquiv} [cost]              The per-transition WASTED (re-write) cost in
 *     token-equivalents (T4 #85). Absent on HIT/establishing turns and on usage-absent turns.
 * @property {Reco} [reco]                  The per-transition recommendation (T5 #86), emitted
 *     iff the lever passes the 3-condition legitimacy test (controllable ∧ causal ∧ non-trivial).
 *     Absent on HIT and hidden-cause UNEXPLAINED turns.
 * @property {string[]} [hiddenCauses]      Non-actionable candidate causes surfaced on a
 *     hidden-cause UNEXPLAINED turn (cache spec §5 — never fabricated, never a reco).
 */

/**
 * @typedef {object} CostTotal
 * @property {number | null} equiv       Exact effective-token-equivalent total when no
 *     contributing turn had an unknown tier; `null` when one did (see `equivRange`).
 * @property {[number, number] | null} equivRange  `[lo, hi]` bound when a tier-unknown turn
 *     contributed a span; `null` when the total is exact.
 * @property {{ '5m': number, '1h': number, read: number, unknown: number }} raw  Per-tier raw
 *     token sums (always exact — straight from `usage`).
 * @property {Tier} tier                 `'mixed'` — a session total aggregates tiers.
 * @property {boolean} bounded           `true` when any per-turn contribution was a bound
 *     rather than an exact figure (the `wasted` total, when a turn's residual can't fully
 *     attribute the write).
 */

/**
 * @typedef {object} Rollup
 * @property {Record<Verdict, number>} byVerdict     Headline-verdict counts.
 * @property {Record<StructMode, number>} byStructMode  STRUCTURAL sub-mode counts.
 * @property {number} coldTransitions    Transitions whose headline is not HIT.
 * @property {number} totalTransitions   Every emitted card (incl. HIT).
 * @property {{ write: CostTotal, read: CostTotal, wasted: CostTotal }} totals  Exact session
 *     cache-economy totals (T4 #85): `write`/`read` straight from `usage`; `wasted` the Σ of
 *     per-turn re-write cost (exact where the residual attributes it, else bounded).
 * @property {TokEquiv} summedCounterfactual  The summed counterfactual (T4 #85) — "would have
 *     avoided re-writing ~X tok-équ." — the wasted basis framed as a lower-bound saving.
 * @property {Reco[]} rollupRecos  The deduped session-pattern recommendations (T5 #86): each
 *     per-verdict pattern appears once (with a count) rather than per-event, plus the
 *     rollup-only patterns (group your turns, stabilize the volatile block, fine-tune bridge).
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
 * @param {{ ttl?: number, now?: number, chronicityThreshold?: number }} [opts]  `ttl` (ms,
 *   default 1 h); `now` reserved; `chronicityThreshold` (default and hard floor
 *   {@link CHRONICITY_THRESHOLD} — a smaller or non-integer value falls back to the default,
 *   so a one-off edit can never be reported as chronic).
 * @returns {Diagnostic}
 */
export function diagnoseCache(session, opts = {}) {
  const ttl = typeof opts.ttl === 'number' && Number.isFinite(opts.ttl) && opts.ttl >= 0
    ? opts.ttl
    : DEFAULT_CACHE_TTL_MS;
  const chronicityThreshold =
    Number.isInteger(opts.chronicityThreshold) && opts.chronicityThreshold >= CHRONICITY_THRESHOLD
      ? opts.chronicityThreshold
      : CHRONICITY_THRESHOLD;
  // `opts.now` is accepted for spec-faithful signature / a future session-wide reference,
  // but the temporal axis is the captured `idleMs` (computed by computeWaste) — never a
  // live clock — so it is intentionally not read here.

  const { perExchange } = computeWaste(session);

  /** @type {Card[]} */
  const transitions = [];
  let anyBreakpoints = false;
  // Cost accumulators (T4 #85): write/read come from EVERY non-probe turn's `usage`
  // (the whole session's cache economy); wasted is the Σ of per-turn re-write cost.
  const writeAcc = newCostAcc();
  const readAcc = newCostAcc();
  const wastedAcc = newCostAcc();

  for (let i = 0; i < session.length; i++) {
    const w = perExchange[i];
    if (w.probe) continue; // one-shot probes are filtered before the diagnostic (cache spec §2.3)
    addUsageCost(writeAcc, readAcc, session[i].usage); // exact, straight from `usage`
    const breakpoints = breakpointPositions(w.segments);
    if (breakpoints.length > 0) anyBreakpoints = true;
    const card = diagnoseTurn(session[i], i, w, ttl, breakpoints);
    if (card) {
      if (card.cost) addTokEquiv(wastedAcc, card.cost);
      annotate(card); // T5 (#86): per-transition reco (3-condition test) + hidden-cause context
      transitions.push(card);
    }
  }

  return finalize(transitions, anyBreakpoints, writeAcc, readAcc, wastedAcc, chronicityThreshold);
}

/**
 * Diagnose one exchange into a card (or `null` when there is nothing to diagnose).
 * @param {object} e
 * @param {number} index
 * @param {import('./waste.js').ExchangeWaste} w
 * @param {number} ttl
 * @param {number[]} breakpoints  Render-ordered `cache_control` positions for this turn.
 * @returns {Card | null}
 */
function diagnoseTurn(e, index, w, ttl, breakpoints) {
  const segs = w.segments;
  const end = segs.length;
  const cacheBoundary = w.cacheBoundary; // reality frontier (what was served)
  const lcp = w.lcp; // content frontier (mutation point)
  // Capability frontier (what COULD have been cached); null ⇒ the 2-frontier fallback.
  const lastMatchingBreakpoint = capabilityFrontier(breakpoints, lcp);
  const hasBreakpoints = lastMatchingBreakpoint !== null;
  const compacted = end < w.baselineLength; // the turn shrank vs its baseline
  // Cold = the cache stopped serving prior-prefix content that is STILL in this turn. The
  // prior extent still present is [0, min(baselineLength, end)) (compaction may have dropped
  // the tail), so a warm compaction — which served everything it sent — is a HIT, not cold.
  const priorExtent = Math.min(w.baselineLength, end);
  const cold = cacheBoundary < priorExtent;

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
      range: range(0, cacheBoundary),
      verdict: 'HIT',
      cause: 'cached prefix served — nothing expired this turn',
      bytes: extent(segs, 0, cacheBoundary),
    };
    return card(turnOf(e, index), [region], hasBreakpoints);
  }

  // ── cold turn: partition [cacheBoundary, end) into verdict regions ──────────────
  /** @type {Region[]} */
  const regions = [];
  const gap = w.idleMs;
  const reliable = w.idleMsReliable;
  const purePrefixShrink = compacted && lcp === end; // shrank with no in-current divergence

  // (1) Identical-but-cold prefix [cacheBoundary, lcp): content matches the baseline yet was
  //     not served. A pure prefix-shrink folds this into the TRUNCATED region below instead.
  if (lcp > cacheBoundary && !purePrefixShrink) {
    if (lastMatchingBreakpoint === null) {
      regions.push(capableColdRegion(cacheBoundary, lcp, segs, gap, reliable, ttl));
    } else {
      // 3-frontier split: [cacheBoundary, cut) capable-but-cold vs [cut, lcp) the divorce.
      // The cut is clamped to the cache boundary: a breakpoint below it covers content
      // `usage` says WAS served, and the divorce must never reach back over that (it would
      // bill served bytes as uncached-by-design and double-count them downstream).
      const cut = Math.max(lastMatchingBreakpoint, cacheBoundary);
      if (cut > cacheBoundary) regions.push(capableColdRegion(cacheBoundary, cut, segs, gap, reliable, ttl));
      if (lcp > cut) regions.push(divorceRegion(cut, lcp, segs));
    }
  }

  // (2) Structural region: divergent baseline content re-written because of a mutation,
  //     or — for a compaction — the cold extent of a turn that lost content.
  if (lcp < priorExtent) {
    const mode = compacted ? 'TRUNCATED' : structModeFor(w.mutationSite);
    regions.push(structuralRegion(lcp, priorExtent, w.mutationSite, mode, segs));
  } else if (purePrefixShrink) {
    // Compaction dropped the tail with no surviving divergence: the cold prefix is
    // compaction-caused, not temporal. (Cold guarantees cacheBoundary < priorExtent == end.)
    regions.push(structuralRegion(cacheBoundary, end, null, 'TRUNCATED', segs));
  }

  const out = card(turnOf(e, index), regions, hasBreakpoints);
  // T4 (#85): per-transition WASTED (re-write) cost. A request-aggregate `usage` cannot be
  // attributed across multiple regions without re-tokenizing, so the cost lives on the card
  // (the per-transition figure) and is mirrored onto the headline region — never split per
  // region. HIT/establishing turns and usage-absent turns carry no cost.
  const cost = wastedCost(e.usage, w.residual);
  if (cost) {
    out.cost = cost;
    out.headline.cost = cost;
  }
  return out;
}

/**
 * The capability frontier: what *could* have been cached, from the render-ordered
 * `cache_control` breakpoints (cache spec §3 / issue #84). A breakpoint at segment index p
 * covers the prefix [0, p]; the last breakpoint that sits within the stable prefix
 * (p < lcp) is `lastMatchingBreakpoint`, expressed as an exclusive length (p + 1). Content
 * beyond it up to lcp is stable but never cached (the divorce). `0` when the request carries
 * breakpoints but none of them covers the stable prefix; `null` when it carries none at all
 * (the 2-frontier fallback).
 * @param {number[]} breakpoints  Render-ordered breakpoint positions.
 * @param {number} lcp
 * @returns {number | null}
 */
function capabilityFrontier(breakpoints, lcp) {
  if (breakpoints.length === 0) return null;
  let maxMatching = -1;
  for (const p of breakpoints) if (p < lcp && p > maxMatching) maxMatching = p;
  return maxMatching + 1; // −1 (nothing covered) ⇒ 0; else the exclusive length
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
 * @param {CostAcc} writeAcc
 * @param {CostAcc} readAcc
 * @param {CostAcc} wastedAcc
 * @param {number} chronicityThreshold
 * @returns {Diagnostic}
 */
function finalize(transitions, anyBreakpoints, writeAcc, readAcc, wastedAcc, chronicityThreshold) {
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
      coldTransitions: transitions.length - byVerdict.HIT, // cold ≡ headline is not HIT
      totalTransitions: transitions.length,
      // T4 (#85): exact cache-economy totals + the summed counterfactual.
      totals: {
        write: accToTotal(writeAcc),
        read: accToTotal(readAcc),
        wasted: accToTotal(wastedAcc),
      },
      summedCounterfactual: counterfactual(wastedAcc),
      // T5 (#86): deduped session-pattern recommendations (no per-event repetition).
      rollupRecos: buildRollupRecos(transitions, chronicityThreshold),
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

/**
 * Canonical byte extent of a segment range (the only legal size measure; never re-tokens).
 * @param {import('./waste.js').Segment[]} segs
 * @param {number} start
 * @param {number} endExclusive
 * @returns {number}
 */
function extent(segs, start, endExclusive) {
  let s = 0;
  for (let i = start; i < endExclusive && i < segs.length; i++) s += segs[i].bytes;
  return s;
}

// ── cost maths (cache spec §4 / T4 #85) ──────────────────────────────────────
// All token figures come ONLY from captured `usage`; nothing is estimated from bytes
// (never re-tokenize). The unit is the effective token-equivalent = tokens × tier
// multiplier. See {@link TIER_MULTIPLIERS}.

/** Round a cost figure to 2 dp — display cleanliness only; values still come from `usage`. */
const round2 = (x) => Math.round(x * 100) / 100;

/** A non-negative finite number from a possibly-dirty `usage` field; else 0. */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
}

/**
 * @param {KnownTier} tier
 * @param {number} rawTokens
 * @returns {TierCost}
 */
function tierCost(tier, rawTokens) {
  return { tier, rawTokens, multiplier: TIER_MULTIPLIERS[tier], equiv: round2(rawTokens * TIER_MULTIPLIERS[tier]) };
}

/**
 * The turn's cache-WRITE cost in token-equivalents, straight from `usage`. `null` when
 * `usage` is absent or the turn wrote nothing.
 *
 * The per-tier fields (`cacheCreation{5m,1h}`) are authoritative for the TIER; the flat
 * `cache_creation` is authoritative for the write MASS. Mass the per-tier fields leave
 * unaccounted — all of it when neither field is reported, the remainder when they under-sum
 * the flat total — is tier-unknown and priced as a `[×1.25, ×2]` span, never as a
 * false-precise point and never silently dropped. A write spanning both tiers is `mixed`.
 * @param {import('./report.js').Usage | null} usage
 * @returns {TokEquiv | null}
 */
function writeTokEquiv(usage) {
  if (!usage) return null;
  const c5 = num(usage.cacheCreation5mInputTokens);
  const c1 = num(usage.cacheCreation1hInputTokens);
  const known = c5 + c1;
  const unknownTokens = Math.max(0, num(usage.cacheCreationInputTokens) - known);
  if (known <= 0 && unknownTokens <= 0) return null; // the turn wrote nothing
  /** @type {TierCost[]} */
  const components = [];
  if (c5 > 0) components.push(tierCost('5m', c5));
  if (c1 > 0) components.push(tierCost('1h', c1));
  const knownEquiv = round2(components.reduce((s, c) => s + c.equiv, 0));
  const base = { rawTokens: known + unknownTokens, components, unknownTokens, bounded: false };
  if (unknownTokens <= 0) {
    return {
      ...base,
      equiv: knownEquiv,
      multiplier: components.length === 1 ? components[0].multiplier : null,
      tier: components.length > 1 ? 'mixed' : components[0].tier,
      equivRange: null,
    };
  }
  return {
    ...base,
    equiv: null, // any tier-unknown mass forbids a single number
    multiplier: null,
    tier: components.length > 0 ? 'mixed' : 'unknown',
    equivRange: [
      round2(knownEquiv + unknownTokens * UNKNOWN_TIER_RANGE[0]),
      round2(knownEquiv + unknownTokens * UNKNOWN_TIER_RANGE[1]),
    ],
  };
}

/**
 * The turn's cache-READ cost (×0.1) in token-equivalents. `null` when `usage` is absent
 * or the turn read nothing.
 * @param {import('./report.js').Usage | null} usage
 * @returns {TokEquiv | null}
 */
function readTokEquiv(usage) {
  if (!usage) return null;
  const r = num(usage.cacheReadInputTokens);
  if (r <= 0) return null;
  const c = tierCost('read', r);
  return {
    rawTokens: r,
    components: [c],
    unknownTokens: 0,
    equiv: c.equiv,
    multiplier: c.multiplier,
    tier: 'read',
    equivRange: null,
    bounded: false,
  };
}

/**
 * The per-transition WASTED (re-write) cost: the turn's cache-creation write, attributed
 * to the re-written region by the T2 residual. EXACT when the residual attributes the
 * whole write to re-written content (`newBytes === 0` — nothing genuinely-new was written);
 * else BOUNDED (≤ the turn's write cost), because a request-aggregate `usage` cannot be
 * split between the re-write and genuinely-new content without re-tokenizing. `null` when
 * there is no write or no re-written mass (HIT / establishing / usage-absent turns).
 * @param {import('./report.js').Usage | null} usage
 * @param {import('./waste.js').UsageDiffResidual | null} residual
 * @returns {TokEquiv | null}
 */
function wastedCost(usage, residual) {
  if (!residual || residual.rewrittenBytes <= 0) return null; // nothing re-written ⇒ no waste
  const write = writeTokEquiv(usage);
  if (!write) return null;
  const attributesFully = residual.newBytes === 0; // the whole write is the re-write
  return { ...write, bounded: !attributesFully };
}

/**
 * @typedef {object} CostAcc  Accumulator for a rollup cost total.
 * @property {number} equiv       Σ exact (known-tier) equiv.
 * @property {number} rangeLo     Lower bound: Σ exact equiv + Σ unknown-tier × 1.25.
 * @property {number} rangeHi     Upper bound: Σ exact equiv + Σ unknown-tier × 2.
 * @property {boolean} hasRange   A tier-unknown (ranged) contribution is present.
 * @property {boolean} bounded    A bounded (non-exact) contribution is present.
 * @property {{ '5m': number, '1h': number, read: number, unknown: number }} raw  Per-tier raw sums.
 */

/** @returns {CostAcc} */
function newCostAcc() {
  return { equiv: 0, rangeLo: 0, rangeHi: 0, hasRange: false, bounded: false, raw: { '5m': 0, '1h': 0, read: 0, unknown: 0 } };
}

/**
 * Fold a TokEquiv into an accumulator. A known-tier figure is a point added to both the
 * exact total and the range floor/ceiling; a tier-unknown figure is a span added only to
 * the range (and flips the total to a bound). The per-tier raw is always recorded.
 * @param {CostAcc} acc
 * @param {TokEquiv | null} t
 */
function addTokEquiv(acc, t) {
  if (!t) return;
  if (t.equiv != null) {
    acc.equiv += t.equiv;
    acc.rangeLo += t.equiv;
    acc.rangeHi += t.equiv;
  }
  if (t.equivRange) {
    acc.rangeLo += t.equivRange[0];
    acc.rangeHi += t.equivRange[1];
    acc.hasRange = true;
  }
  for (const c of t.components) acc.raw[c.tier] += c.rawTokens;
  acc.raw.unknown += t.unknownTokens;
  if (t.bounded) acc.bounded = true;
}

/**
 * Add one turn's write + read cost (straight from `usage`) to the rollup accumulators.
 * @param {CostAcc} writeAcc
 * @param {CostAcc} readAcc
 * @param {import('./report.js').Usage | null} usage
 */
function addUsageCost(writeAcc, readAcc, usage) {
  addTokEquiv(writeAcc, writeTokEquiv(usage));
  addTokEquiv(readAcc, readTokEquiv(usage));
}

/**
 * An accumulator's total as the exact-or-bounded pair: an exact `equiv` unless a
 * tier-unknown span contributed, in which case only the `[lo, hi]` bound is honest.
 * @param {CostAcc} acc
 * @returns {{ equiv: number | null, equivRange: [number, number] | null }}
 */
function spanOf(acc) {
  if (acc.hasRange) return { equiv: null, equivRange: [round2(acc.rangeLo), round2(acc.rangeHi)] };
  return { equiv: round2(acc.equiv), equivRange: null };
}

/**
 * Build a rollup CostTotal from an accumulator.
 * @param {CostAcc} acc
 * @returns {CostTotal}
 */
function accToTotal(acc) {
  return { ...spanOf(acc), raw: { ...acc.raw }, tier: 'mixed', bounded: acc.bounded };
}

/**
 * The summed counterfactual — the wasted basis framed as "would have avoided re-writing
 * ~X tok-équ." (a lower bound, not a guarantee). Same numbers as `totals.wasted`.
 * @param {CostAcc} acc
 * @returns {TokEquiv}
 */
function counterfactual(acc) {
  return {
    ...spanOf(acc),
    rawTokens: acc.raw['5m'] + acc.raw['1h'] + acc.raw.unknown,
    components: [],
    unknownTokens: acc.raw.unknown,
    multiplier: null,
    tier: 'mixed',
    bounded: acc.bounded,
  };
}

/** @param {object} e @param {number} index @returns {number} */
function turnOf(e, index) {
  return typeof e.turn === 'number' ? e.turn : index + 1;
}

// ── recommendations (cache spec §5 / T5 #86) ─────────────────────────────────
// A reco is legitimate iff the lever is (1) controllable, (2) causal on THIS transition,
// (3) non-trivial. Verdicts that fail the test carry a diagnostic + cost, no reco. The
// counterfactual ("would have avoided re-writing ~X tok-équ.") is a confidence-aware lower
// bound drawn from the per-transition wasted cost — never a promise of a saving.

/**
 * Candidate hidden causes surfaced as non-actionable context on a truly-UNEXPLAINED turn
 * (cache spec §3.1 / user story #5) — never fabricated, never framed as a reco.
 */
const HIDDEN_CAUSE_CANDIDATES = Object.freeze([
  'overage fallback',
  'parallel-session eviction',
  'un-published cache-key components',
]);

/**
 * The counterfactual amount — the wasted basis framed as a lower bound. A known-tier cost is
 * a point; a tier-unknown cost is its `[lo, hi]` span; an uncosted transition carries no
 * figure (the reco still fires — the lever is real even when the cost is not captured). The
 * result is a bare noun phrase so every caller can read it after "re-writing …".
 * @param {TokEquiv | null} cf
 * @returns {string}
 */
function cfAmount(cf) {
  if (cf?.equiv != null) return `~${cf.equiv} tok-équ.`;
  if (cf?.equivRange) return `~${cf.equivRange[0]}–${cf.equivRange[1]} tok-équ.`;
  return 'an unmeasured amount';
}

/**
 * The structural culprit of a card: the mutated slot and sub-mode of its STRUCTURAL region
 * (the same region `card.culpritSlot` is drawn from), or `null` when the card has none.
 * @param {Card} card
 * @returns {{ slot: string, mode: StructMode } | null}
 */
function structuralCulprit(card) {
  const region = card.regions.find((r) => r.verdict === 'STRUCTURAL');
  if (!region || !region.culpritSlot || !region.structMode) return null;
  return { slot: region.culpritSlot, mode: region.structMode };
}

/**
 * The Σ of a group of cards' per-transition wasted costs — the deduped counterfactual for a
 * rollup reco. `null` when no card in the group carried a cost.
 * @param {Card[]} cards
 * @returns {TokEquiv | null}
 */
function summedCost(cards) {
  return sumTokEquiv(cards.map((c) => c.cost ?? null));
}

/**
 * The per-transition reco for a card, gated by the 3-condition legitimacy test. `null` when
 * the verdict carries no reco (HIT — no waste; hidden-cause UNEXPLAINED — not controllable).
 * @param {Card} card
 * @returns {Reco | null}
 */
function recoFor(card) {
  const h = card.headline;
  const cf = card.cost ?? null;
  switch (h.verdict) {
    case 'HIT':
      return null; // nothing expired — no waste to act on
    case 'TEMPORAL': {
      const lowConfidence = h.confidence === 'low';
      return {
        kind: 'resume-before-ttl',
        // A low-confidence straddle never promises the saving — it is phrased conditionally.
        text: `${lowConfidence ? 'if the cache had expired (low confidence), ' : ''}resume inside the TTL window — would have avoided re-writing ${cfAmount(cf)}`,
        form: 'avoidance',
        confidence: lowConfidence ? 'low' : 'high',
        counterfactual: cf,
      };
    }
    case 'STRUCTURAL': {
      const slot = card.culpritSlot ?? undefined;
      switch (h.structMode) {
        case 'TRUNCATED':
          return {
            kind: 'weak-truncated',
            text: 'compaction re-processed the prefix — not user-controllable; no reliable lever',
            form: 'none',
            confidence: 'low',
            counterfactual: null,
            weak: true,
          };
        case 'PREFIX':
          return {
            kind: 'edit-last-turn',
            text: `edit or add the last turn${slot ? ` rather than ${slot}` : ''} — would have avoided re-writing ${cfAmount(cf)}`,
            form: 'avoidance',
            confidence: 'high',
            counterfactual: cf,
            slot,
          };
        default:
          return {
            kind: 'batch-invalidating',
            text: `batch the invalidating changes${slot ? ` at ${slot}` : ''} into one turn — would have avoided re-writing ${cfAmount(cf)} (amortized)`,
            form: 'amortization',
            confidence: 'high',
            counterfactual: cf,
            slot,
          };
      }
    }
    case 'UNEXPLAINED':
      // The breakpoint↔LCP divorce has a KNOWN cause (no breakpoint) but an uncontrollable
      // lever ⇒ a weak diagnostic reco (cache spec §3.2). A hidden-cause UNEXPLAINED ⇒ none.
      if (h.uncachedByDesign) {
        return {
          kind: 'weak-divorce',
          text: 'stable content past the last cache_control breakpoint is re-processed every turn — add a breakpoint upstream if your client allows it',
          form: 'none',
          confidence: 'low',
          counterfactual: null,
          weak: true,
        };
      }
      return null;
  }
}

/**
 * Stamp a card with its per-transition reco (if legitimate) and, on a hidden-cause
 * UNEXPLAINED turn, its non-actionable candidate causes.
 * @param {Card} card
 */
function annotate(card) {
  const reco = recoFor(card);
  if (reco) card.reco = reco;
  const h = card.headline;
  if (h.verdict === 'UNEXPLAINED' && !h.uncachedByDesign && h.cause === null) {
    card.hiddenCauses = [...HIDDEN_CAUSE_CANDIDATES];
  }
}

/**
 * Sum an arbitrary set of per-turn costs into one {@link TokEquiv} (the deduped counterfactual
 * for a rollup reco). Reuses the cost accumulator — token figures stay `usage`-grounded.
 * Returns `null` when no turn contributed a cost (all uncosted), so the phrase stays
 * "an unmeasured re-write" instead of a misleading `~0`.
 * @param {(TokEquiv | null)[]} costs
 * @returns {TokEquiv | null}
 */
function sumTokEquiv(costs) {
  const acc = newCostAcc();
  let any = false;
  for (const c of costs) {
    if (c) {
      addTokEquiv(acc, c);
      any = true;
    }
  }
  return any ? counterfactual(acc) : null;
}

/**
 * The deduped session-pattern rollup recommendations (cache spec §5 / §6). Each per-verdict
 * pattern appears ONCE (with a count + summed counterfactual), never per-event. Weak per-card
 * recos (TRUNCATED / divorce) are diagnostic-only and stay off the rollup. The session-only
 * patterns follow: group-your-turns, chronicity (stabilize), and the fine-tune reco-bridge.
 * @param {Card[]} transitions
 * @param {number} chronicityThreshold
 * @returns {Reco[]}
 */
function buildRollupRecos(transitions, chronicityThreshold) {
  /** @type {Reco[]} */
  const recos = [];

  // (1) Dedup the actionable per-card recos by kind: TEMPORAL rolls up to "group your turns";
  //     KEY to "batch"; PREFIX to "edit the last turn".
  /** @type {Map<RecoKind, Card[]>} */
  const byKind = new Map();
  for (const c of transitions) {
    if (!c.reco) continue;
    const kind = c.reco.kind;
    if (kind === 'weak-truncated' || kind === 'weak-divorce') continue; // diagnostic-only
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(c);
  }
  for (const [kind, cards] of byKind) recos.push(rollupReco(kind, cards));

  // (2) Session-only patterns.
  recos.push(...chronicityRecos(transitions, chronicityThreshold));
  recos.push(...fineTuneBridgeRecos(transitions));
  return recos;
}

/**
 * One deduped rollup reco for a per-verdict kind. TEMPORAL's rollup form is "group your
 * turns" (the sliding-TTL session pattern); KEY/PREFIX keep their per-verdict phrasing.
 * @param {RecoKind} perCardKind
 * @param {Card[]} cards
 * @returns {Reco}
 */
function rollupReco(perCardKind, cards) {
  const count = cards.length;
  const cf = summedCost(cards);
  switch (perCardKind) {
    case 'resume-before-ttl':
      return {
        kind: 'group-turns',
        text: `group your turns to keep the sliding TTL alive (${count} cold turn${count === 1 ? '' : 's'} this session) — would have avoided re-writing ${cfAmount(cf)}`,
        form: 'avoidance',
        confidence: 'high',
        counterfactual: cf,
        count,
      };
    case 'batch-invalidating':
      return {
        kind: 'batch-invalidating',
        text: `batch your invalidating changes into one turn (${count}× this session) — would have avoided re-writing ${cfAmount(cf)} (amortized)`,
        form: 'amortization',
        confidence: 'high',
        counterfactual: cf,
        count,
      };
    default:
      return {
        kind: 'edit-last-turn',
        text: `edit or add the last turn rather than an old one (${count}× this session) — would have avoided re-writing ${cfAmount(cf)}`,
        form: 'avoidance',
        confidence: 'high',
        counterfactual: cf,
        count,
      };
  }
}

/**
 * Chronicity (cache spec §5): "stabilize the volatile block" fires once per culprit slot that
 * recurred across ≥ `threshold` transitions — never on a one-off edit. A recurring mutation
 * site is a pattern, not a series of one-offs, regardless of its KEY/PREFIX sub-mode.
 *
 * A TRUNCATED (compaction) culprit is excluded: the compactor rewrote that slot, not the user,
 * so telling them to "stabilize" it fails condition (1) of the legitimacy test — the same
 * reason the per-card TRUNCATED reco is weak and stays off the rollup.
 * @param {Card[]} transitions
 * @param {number} threshold
 * @returns {Reco[]}
 */
function chronicityRecos(transitions, threshold) {
  /** @type {Map<string, Card[]>} */
  const bySlot = new Map();
  for (const c of transitions) {
    const culprit = structuralCulprit(c);
    if (!culprit || culprit.mode === 'TRUNCATED') continue; // controllable culprits only
    if (!bySlot.has(culprit.slot)) bySlot.set(culprit.slot, []);
    bySlot.get(culprit.slot).push(c);
  }
  /** @type {Reco[]} */
  const out = [];
  for (const [slot, cards] of bySlot) {
    if (cards.length < threshold) continue;
    const cf = summedCost(cards);
    out.push({
      kind: 'stabilize-volatile',
      text: `stabilize the volatile block — slot ${slot} invalidated the cache on ${cards.length} turns; move the changing part out of the cached prefix (would have avoided re-writing ${cfAmount(cf)})`,
      form: 'amortization',
      confidence: 'high',
      counterfactual: cf,
      slot,
      recurrence: cards.length,
    });
  }
  // Loudest pattern first; the slot name breaks ties so the order is deterministic.
  out.sort((a, b) => (b.recurrence ?? 0) - (a.recurrence ?? 0) || compareSlots(a.slot, b.slot));
  return out;
}

/** Deterministic slot ordering for the rollup lists. @param {string} [a] @param {string} [b] */
function compareSlots(a = '', b = '') {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The fine-tune reco-bridge (sister map #29 / cache spec §5): a tool-caused KEY invalidation
 * (culprit `tool:*` — a built-in tool change or an MCP connect/disconnect) is BOTH a fine-tune
 * deny lever and a whole-prefix KEY invalidator, so its cache re-write cost is surfaced alongside
 * the fine-tune axis's static-bloat cost. One bridge reco per tool slot (a single denial is
 * already actionable, so unlike chronicity this needs no recurrence).
 *
 * The gate is the HEADLINE being that KEY region: the counterfactual is the whole turn's
 * re-write cost, which is only honest to hand to the tool lever when the KEY region dominates
 * the turn (else a mostly-temporal turn's cost would be billed to the tool).
 * @param {Card[]} transitions
 * @returns {Reco[]}
 */
function fineTuneBridgeRecos(transitions) {
  /** @type {Map<string, Card[]>} */
  const bySlot = new Map();
  for (const c of transitions) {
    if (c.headline.verdict !== 'STRUCTURAL' || c.headline.structMode !== 'KEY') continue;
    const slot = c.culpritSlot;
    if (!slot || !slot.startsWith('tool:')) continue; // system/compaction KEY is not a fine-tune tool lever
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(c);
  }
  /** @type {Reco[]} */
  const out = [];
  for (const [slot, cards] of bySlot) {
    const cf = summedCost(cards);
    out.push({
      kind: 'fine-tune-bridge',
      text: `slot ${slot} is also a fine-tune deny lever — denying it (fine-tune) avoids both its static bloat and re-writing ${cfAmount(cf)} of cache`,
      form: 'amortization',
      confidence: 'high',
      counterfactual: cf,
      slot,
      count: cards.length,
    });
  }
  out.sort((a, b) => compareSlots(a.slot, b.slot));
  return out;
}

// ── surface (T6 #87): the text + HTML renderer + the `cache` entry ─────────────
//
// `diagnoseCache` above stays PURE — this section is the I/O-bearing surface that
// turns a structured `Diagnostic` into a human-readable card/rollup (text by default,
// the same data as HTML) and wires it to a captured session. Render is a pure function
// over structured data; the only I/O is the session discovery in `cache`, which reuses
// the report resolver (`resolveRoots`/`listSessions`/`pickLatestSession`) so `cache`
// discovers exactly what `report`/`fine-tune` do. The unit of a cache diagnostic is
// ONE session — there is no corpus mode (a cache economy is per-conversation).

/** Tier label for the cost breakdown (`5m`/`1h`/`read` → a human phrase). */
const TIER_LABEL = Object.freeze({ '5m': '5 m write', '1h': '1 h write', read: 'read' });

/** Render order for the by-verdict / by-sub-mode counts — shared by the text and HTML renders. */
const VERDICT_ORDER = /** @type {Verdict[]} */ (Object.freeze(['HIT', 'STRUCTURAL', 'TEMPORAL', 'UNEXPLAINED']));
const STRUCT_MODE_ORDER = /** @type {StructMode[]} */ (Object.freeze(['KEY', 'PREFIX', 'TRUNCATED']));

/**
 * A number as a locale-stable, comma-grouped string (30874 → "30,874"; 18492.5 →
 * "18,492.5"). `toLocaleString` is avoided so the output is identical across Node
 * locales/icu builds — the renderer is asserted on for shape.
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
 * The per-tier multiplier breakdown in parens, shared by per-card `TokEquiv` (which
 * carries `components`) and rollup `CostTotal` (which carries `raw`). Tier-unknown mass
 * is priced as its `×1.25–×2` span and labelled — never a silent single number.
 *
 * Treated structurally: `components` lives on a per-card {@link TokEquiv}, `raw` on a
 * rollup {@link CostTotal} — both optional here so one helper renders both shapes.
 * @param {{ components?: TierCost[], raw?: { '5m': number, '1h': number, read: number, unknown: number }, unknownTokens?: number }} t
 * @returns {string}
 */
function tierBreakdown(t) {
  /** @type {string[]} */
  let parts = [];
  if (Array.isArray(t.components) && t.components.length) {
    parts = t.components.map((c) => `${fmtNum(c.rawTokens)} ×${c.multiplier} (${TIER_LABEL[c.tier] ?? c.tier})`);
  } else if (t.raw) {
    for (const k of ['5m', '1h', 'read']) {
      if (t.raw[k]) parts.push(`${fmtNum(t.raw[k])} ×${TIER_MULTIPLIERS[k]} (${TIER_LABEL[k]})`);
    }
  }
  const unknown = t.unknownTokens ?? (t.raw ? t.raw.unknown : 0);
  if (unknown > 0) parts.push(`${fmtNum(unknown)} ×1.25–×2 (tier unknown)`);
  return parts.length ? `  (${parts.join(' + ')})` : '';
}

/**
 * Render a cost figure (a per-card `TokEquiv`, a rollup `CostTotal`, or `undefined`).
 * `—` when there is no cost (usage absent / HIT / establishing); an exact point when the
 * tier is known; a `[lo, hi] (bound)` when any mass is tier-unknown; plus the per-tier
 * breakdown and a `[≤ this turn's write]` marker when the figure is a bounded attribute.
 * @param {TokEquiv | CostTotal | undefined | null} t
 * @returns {string}
 */
function fmtCost(t) {
  if (!t) return '—';
  let head = '~? tok-équ.';
  if (t.equiv != null) head = `~${fmtNum(t.equiv)} tok-équ.`;
  else if (t.equivRange) head = `~${fmtNum(t.equivRange[0])}–${fmtNum(t.equivRange[1])} tok-équ. (bound)`;
  return `${head}${tierBreakdown(t)}${t.bounded ? '  [≤ this turn’s write]' : ''}`;
}

/**
 * @param {[number, number]} r
 * @returns {string}
 */
function fmtRange(r) {
  return `[${r[0]}..${r[1]})`;
}

/**
 * The headline verdict of a region as a one-token label (e.g. `STRUCTURAL·KEY`,
 * `TEMPORAL (low confidence)`).
 * @param {Region} r
 * @returns {string}
 */
function verdictHeadline(r) {
  switch (r.verdict) {
    case 'HIT':
      return 'HIT';
    case 'STRUCTURAL':
      return `STRUCTURAL·${r.structMode ?? '?'}`;
    case 'TEMPORAL':
      return r.confidence === 'low' ? 'TEMPORAL (low confidence)' : 'TEMPORAL';
    case 'UNEXPLAINED':
      return r.uncachedByDesign ? 'UNEXPLAINED (uncached-by-design)' : 'UNEXPLAINED';
    default:
      return r.verdict;
  }
}

/**
 * A region rendered inline for a composite card's region list (verdict · sub-mode · the
 * culprit slot when present).
 * @param {Region} r
 * @returns {string}
 */
function regionInline(r) {
  let label = r.verdict === 'STRUCTURAL' ? `STRUCTURAL·${r.structMode ?? '?'}` : r.verdict;
  if (r.confidence === 'low') label += ' (low conf.)';
  return `${label}${r.culpritSlot ? ` @ ${r.culpritSlot}` : ''}`;
}

/**
 * The text lines for one per-transition card: the turn + headline verdict (and the
 * composite regions when >1 non-HIT region), the cause, the cost, and the reco. HIT
 * turns never reach here (the renderer filters them).
 * @param {Card} card
 * @returns {string[]}
 */
function renderCardLines(card) {
  const h = card.headline;
  /** @type {string[]} */
  const out = [];
  out.push(`── turn ${card.turn} ── ${verdictHeadline(h)}${card.composite ? '  [composite]' : ''}`);
  if (card.composite) {
    for (const r of card.regions) {
      if (r.verdict === 'HIT') continue;
      out.push(`    · ${fmtRange(r.range)} ${regionInline(r)} — ${r.cause ?? '(no cause — unexplained)'}`);
    }
  } else {
    out.push(`    cause: ${h.cause ?? '(no cause — unexplained)'}`);
  }
  out.push(`    cost:  ${fmtCost(card.cost)}`);
  if (card.reco) out.push(`    reco:  ${card.reco.text}`);
  if (card.hiddenCauses && card.hiddenCauses.length) out.push(`    hidden candidates: ${card.hiddenCauses.join('; ')}`);
  return out;
}

/**
 * The text lines for the lean session rollup: write/read/wasted totals, the count by
 * verdict (and by STRUCTURAL sub-mode), the summed counterfactual, and the deduped
 * rollup recommendations (each session pattern once — no per-event repetition).
 * @param {Rollup} r
 * @returns {string[]}
 */
function renderRollupLines(r) {
  /** @type {string[]} */
  const out = ['── session rollup ────────────'];
  out.push(`    write:        ${fmtCost(r.totals.write)}`);
  out.push(`    read:         ${fmtCost(r.totals.read)}`);
  out.push(`    wasted:       ${fmtCost(r.totals.wasted)}`);
  out.push(`    by verdict:   ${VERDICT_ORDER.map((v) => `${v} ${r.byVerdict[v] ?? 0}`).join(' · ')}`);
  const struct = STRUCT_MODE_ORDER.filter((m) => r.byStructMode[m]).map((m) => `${m} ${r.byStructMode[m]}`);
  if (struct.length) out.push(`    structural:   ${struct.join(' · ')}`);
  out.push(`    counterfactual: would have avoided re-writing ${fmtCost(r.summedCounterfactual)}`);
  if (r.rollupRecos && r.rollupRecos.length) {
    out.push('    recommendations (deduped):');
    for (const reco of r.rollupRecos) out.push(`      • ${reco.text}`);
  } else {
    out.push('    recommendations: none');
  }
  return out;
}

/**
 * Render a structured `Diagnostic` as a human-readable card/rollup. Pure: no I/O, no
 * wall clock — a formatter over the diagnostic the pure `diagnoseCache` produced.
 *
 * Per-transition cards are emitted for each NON-HIT transition (the atomic diagnostic;
 * HIT turns are summarised in the rollup's by-verdict count, not printed as cards). The
 * rollup footer carries the write/read/wasted totals in token-equivalents, the count by
 * verdict, the deduped session-pattern recommendations, and the summed counterfactual.
 * Text is returned in `lines`; `html` is a self-contained document of the same data.
 *
 * @param {Diagnostic} diag
 * @param {{ sessionId?: string }} [opts]
 * @returns {{ lines: string[], html: string }}
 */
export function renderCache(diag, opts = {}) {
  const sessionId = opts.sessionId ?? '(no id)';
  const cards = diag.transitions.filter((c) => c.headline.verdict !== 'HIT');
  const hitCount = diag.rollup.byVerdict.HIT ?? 0;

  /** @type {string[]} */
  const lines = [];
  lines.push(`ccsnoop cache — session ${sessionId}`);
  lines.push(
    `  ${diag.rollup.totalTransitions} transition(s) · ${diag.rollup.coldTransitions} cold · ${diag.frontierModel}`
  );
  if (diag.note) lines.push(`  note: ${diag.note}`);
  lines.push('');
  if (cards.length === 0) {
    lines.push('No cold transitions — nothing expired or was re-written this session.');
  } else {
    for (const c of cards) lines.push(...renderCardLines(c));
    if (hitCount > 0) lines.push(`  (${hitCount} warm HIT turn${hitCount === 1 ? '' : 's'} omitted from the cards)`);
  }
  lines.push('');
  lines.push(...renderRollupLines(diag.rollup));

  const html = renderCacheHtml(diag, { sessionId, cards, hitCount });
  return { lines, html };
}

const HTML_ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/**
 * Escape a value for HTML text/attribute context. Every interpolation into the document
 * goes through here — a session id is a directory name, i.e. attacker-shaped input.
 * @param {unknown} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/** @param {string} v */
const verdictClass = (v) => `verdict-${String(v).toLowerCase()}`;

/**
 * The self-contained HTML render of the SAME data the text renderer emits — a render
 * target, not a separate model. One file, no external assets; the diagnostic is laid out
 * as cards then a rollup footer.
 * @param {Diagnostic} diag
 * @param {{ sessionId: string, cards: Card[], hitCount: number }} ctx
 * @returns {string}
 */
function renderCacheHtml(diag, { sessionId, cards, hitCount }) {
  const r = diag.rollup;

  const cardsHtml = cards.length
    ? cards
        .map((c) => {
          const h = c.headline;
          /** @type {string[]} */
          const p = [`<article class="card ${verdictClass(h.verdict)}">`];
          p.push(
            `<h3><span class="turn">turn ${escHtml(c.turn)}</span> ` +
              `<span class="verdict">${escHtml(verdictHeadline(h))}</span>` +
              `${c.composite ? ' <span class="composite">composite</span>' : ''}</h3>`
          );
          if (c.composite) {
            p.push('<ul class="regions">');
            for (const reg of c.regions) {
              if (reg.verdict === 'HIT') continue;
              p.push(
                `  <li><span class="region ${verdictClass(reg.verdict)}">${escHtml(regionInline(reg))}</span> ` +
                  `<span class="range">${escHtml(fmtRange(reg.range))}</span> ` +
                  `<span class="cause">${escHtml(reg.cause ?? '(unexplained)')}</span></li>`
              );
            }
            p.push('</ul>');
          } else {
            p.push(`<p class="cause"><b>cause:</b> ${escHtml(h.cause ?? '(unexplained)')}</p>`);
          }
          p.push(`<p class="cost"><b>cost:</b> ${escHtml(fmtCost(c.cost))}</p>`);
          if (c.reco) p.push(`<p class="reco"><b>reco:</b> ${escHtml(c.reco.text)}</p>`);
          if (c.hiddenCauses && c.hiddenCauses.length)
            p.push(`<p class="hidden"><b>hidden candidates:</b> ${escHtml(c.hiddenCauses.join('; '))}</p>`);
          p.push('</article>');
          return p.join('\n');
        })
        .join('\n')
    : '<p class="muted">No cold transitions — nothing expired or was re-written this session.</p>';

  const byVerdict = VERDICT_ORDER.map(
    (v) => `<span class="vcount ${verdictClass(v)}">${escHtml(v)} <b>${r.byVerdict[v] ?? 0}</b></span>`
  )
    .join(' ');
  const recos =
    r.rollupRecos && r.rollupRecos.length
      ? `<ul class="recos">${r.rollupRecos.map((rc) => `<li>${escHtml(rc.text)}</li>`).join('')}</ul>`
      : '<p class="muted">none</p>';

  const title = `ccsnoop cache — ${escHtml(sessionId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CACHE_CSS}</style>
</head>
<body>
<header class="topbar">
  <h1>ccsnoop cache</h1>
  <div class="session-id">session ${escHtml(sessionId)}</div>
  <div class="meta">${r.totalTransitions} transition(s) · ${r.coldTransitions} cold · ${escHtml(diag.frontierModel)}</div>
</header>
<main>
  <section class="cards" aria-label="per-transition cards">
${cardsHtml}
${hitCount > 0 ? `    <p class="muted">(${hitCount} warm HIT turn${hitCount === 1 ? '' : 's'} omitted from the cards)</p>` : ''}
  </section>
  <section class="rollup" aria-label="session rollup">
    <h2>session rollup</h2>
    <div class="totals">
      <div class="cell"><span>write</span><b>${escHtml(fmtCost(r.totals.write))}</b></div>
      <div class="cell"><span>read</span><b>${escHtml(fmtCost(r.totals.read))}</b></div>
      <div class="cell"><span>wasted</span><b>${escHtml(fmtCost(r.totals.wasted))}</b></div>
    </div>
    <div class="byverdict">by verdict: ${byVerdict}</div>
    <div class="cf">would have avoided re-writing ${escHtml(fmtCost(r.summedCounterfactual))}</div>
    <h3>recommendations (deduped)</h3>
    ${recos}
${diag.note ? `    <p class="note">${escHtml(diag.note)}</p>` : ''}
  </section>
</main>
</body>
</html>`;
}

const CACHE_CSS = `
:root{--bg:#0f1117;--panel:#171a23;--edge:#252a37;--fg:#e6e9ef;--muted:#8b93a7;--accent:#5b9dff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.topbar{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--edge);background:var(--panel)}
.topbar h1{margin:0;font-size:16px;letter-spacing:.5px;color:var(--accent)}
.session-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px}
.meta{margin-left:auto;color:var(--muted);font-size:12px}
main{max-width:920px;margin:0 auto;padding:18px}
.card{background:var(--panel);border:1px solid var(--edge);border-left:3px solid var(--muted);border-radius:8px;padding:12px 16px;margin-bottom:12px}
.card h3{margin:0 0 8px;font-size:14px}
.card .turn{color:var(--muted);font-family:ui-monospace,monospace}
.card .verdict{color:var(--accent);font-weight:600}
.card .composite{font-size:11px;color:var(--muted);border:1px solid var(--edge);border-radius:6px;padding:0 6px;margin-left:6px}
.card p{margin:4px 0}
.card .cause b,.card .cost b,.card .reco b,.card .hidden b{color:var(--muted)}
.card .reco{color:#9ad19a}
.card .hidden{color:var(--muted);font-size:12px}
.card .regions{list-style:none;margin:4px 0;padding-left:0}
.card .regions li{margin:2px 0}
.card .regions .range{color:var(--muted);font-family:ui-monospace,monospace;font-size:12px}
.card.verdict-structural{border-left-color:#e5566b}
.card.verdict-temporal{border-left-color:#f0a336}
.card.verdict-unexplained{border-left-color:#7c5cff}
.rollup{background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:14px 16px;margin-top:18px}
.rollup h2{margin:0 0 10px;font-size:15px}
.rollup h3{margin:14px 0 6px;font-size:13px;color:var(--muted)}
.totals{display:flex;gap:12px;flex-wrap:wrap}
.totals .cell{flex:1;min-width:140px;background:#12151d;border:1px solid var(--edge);border-radius:6px;padding:8px 12px}
.totals .cell span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.totals .cell b{font-variant-numeric:tabular-nums}
.byverdict{margin:10px 0;color:var(--muted);font-size:13px}
.byverdict .vcount{display:inline-block;margin-right:10px}
.cf{margin:6px 0;color:var(--fg)}
.recos{margin:0;padding-left:18px}
.recos li{margin:4px 0}
.note,.muted{color:var(--muted);font-size:12px}
`;

/**
 * The `cache` subcommand entry point (issue #87 / cache spec §6). Discover + load ONE
 * session (the cache economy is per-conversation — no corpus mode), run the pure
 * `diagnoseCache`, and render it (text by default; the same data as HTML). Discovery
 * reuses the report resolver so `cache` finds exactly what `report`/`fine-tune` do, and
 * loading reuses the report's session reader so both see the same exchanges.
 *
 * The TTL threshold is taken in **seconds** here (the CLI's `--ttl`) and handed to
 * `diagnoseCache` in ms; an absent value falls back to the diagnostic's own 1 h default.
 * There is no `latest` option: with no corpus mode, latest IS the default.
 *
 * @param {{ cwd?: string, root?: string, sessionsDir?: string, session?: string, ttlSeconds?: number }} [opts]
 * @returns {{ sessionId: string, transitions: number, diagnostic: Diagnostic, lines: string[], html: string }}
 */
export function cache(opts = {}) {
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
    // No `--session` ⇒ the most-recent session (default-latest, mirroring report). `--latest`
    // is accepted by the CLI as the same signal — there is no corpus mode to drop out of.
    chosen = /** @type {{ id: string, dir: string, mtimeMs: number }} */ (pickLatestSession(sessions));
  }

  const session = loadExchanges(chosen.dir).map(toAnalysisInput);
  // `diagnoseCache` owns the TTL validation (non-finite/negative ⇒ its own default).
  const diagnostic = diagnoseCache(session, {
    ttl: opts.ttlSeconds === undefined ? undefined : opts.ttlSeconds * 1000,
  });
  const { lines, html } = renderCache(diagnostic, { sessionId: chosen.id });
  return { sessionId: chosen.id, transitions: diagnostic.transitions.length, diagnostic, lines, html };
}
