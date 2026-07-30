// Waste-signal computation (spec §2.4–2.6, issue #22).
//
// Three signals — (a) re-sent diff, (b) bloated tool_result, (c) static block —
// all computed over ONE segmentation of the parsed request JSON, then rolled up
// to the four anatomy buckets for display only.
//
// Non-negotiables honoured here:
//   • NEVER re-tokenize — every size is a byte-length proxy (spec §2.4b). The
//     captured `usage` is request-aggregate and is the ground truth for whether
//     caching actually happened; the byte diff only attributes where/why.
//   • Segments are canonicalized from the PARSED JSON (stable key order) then
//     hashed — not raw-byte-diffed, so trivial re-serialization can't fake waste.
//   • Baseline for the re-sent diff is the immediately-prior request in the same
//     cache lineage (manifest `thread_id`, spec §1.6), not flat capture order.

import crypto from 'node:crypto';

/**
 * Report-time waste config (spec §2.6). Sane defaults, overridable; re-applied
 * at report time without re-capturing.
 * @typedef {object} WasteConfig
 * @property {number} bloatFloorBytes         Absolute byte floor — kills small-request noise.
 * @property {number} bloatSiblingMultiplier  A tool_result is an outlier when > k× the sibling median.
 * @property {number} coldCacheTokens         cache_read at/below this ⇒ cold cache (reused collapses to waste).
 */

/** @type {WasteConfig} */
export const DEFAULT_WASTE_CONFIG = {
  bloatFloorBytes: 4096,
  bloatSiblingMultiplier: 3,
  coldCacheTokens: 0,
};

/**
 * Merge caller overrides onto the locked defaults, ignoring non-finite values.
 * @param {Partial<WasteConfig>} [overrides]
 * @returns {WasteConfig}
 */
export function resolveWasteConfig(overrides = {}) {
  const cfg = { ...DEFAULT_WASTE_CONFIG };
  for (const k of /** @type {(keyof WasteConfig)[]} */ (Object.keys(DEFAULT_WASTE_CONFIG))) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[k] = v;
  }
  return cfg;
}

/**
 * Canonicalize a parsed JSON value to a stable string: object keys sorted
 * recursively so key-order / whitespace differences in the raw bytes don't
 * register as content changes. Serialization whitespace is already gone once
 * parsed; string CONTENT is left intact (it is real payload, not formatting).
 *
 * @param {any} value
 * @returns {string}
 */
export function canonicalize(value) {
  return JSON.stringify(sortKeys(value));
}

/** @param {any} v */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Content hash of a parsed value's canonical form. Short hex — collisions are
 * irrelevant for equality of small request segments.
 * @param {any} value
 * @returns {string}
 */
export function hashSegment(value) {
  return crypto.createHash('sha1').update(canonicalize(value)).digest('hex').slice(0, 16);
}

/** Byte length of a value's canonical JSON (the only legal size measure). */
function segBytes(value) {
  return value === undefined || value === null ? 0 : Buffer.byteLength(canonicalize(value), 'utf8');
}

/**
 * @typedef {object} Segment
 * @property {'system'|'tools'|'history'|'currentTurn'} bucket  Anatomy bucket (display grouping only).
 * @property {string} slot     Stable slot identity across requests (for static detection).
 * @property {string} label    Human label for the detail pane.
 * @property {string} hash     Canonical content hash.
 * @property {number} bytes    Canonical byte length (proxy).
 * @property {'new'|'reused-cached'|'reused-uncached'} [kind]  Filled by {@link classifySegments}.
 * @property {boolean} [static]    Filled by session-level static detection.
 * @property {boolean} [flagship]  static ∩ reused-uncached (the flagship waste case).
 * @property {boolean} [bloated]   Segment carries an outlier tool_result.
 * @property {number} [bloatBytes] Byte length of the bloated tool_result.
 * @property {{ type: string, ttl?: string }} [cacheControl]
 *     Parsed `cache_control` breakpoint attached to this segment's element
 *     (cache spec §2.2 / issue #82). Absent when the element carries none.
 */

/**
 * Break a parsed request body into logical segments at the granularity the body
 * exposes (spec §2.4 shared substrate): each `system` block, EACH `tool` def,
 * EACH `messages[]` entry. Tool_result bloat flags are applied here (per-request,
 * sibling-relative).
 *
 * @param {any} body  Parsed request JSON (null-safe).
 * @param {WasteConfig} [config]
 * @returns {Segment[]}
 */
export function segmentRequest(body, config = DEFAULT_WASTE_CONFIG) {
  /** @type {Segment[]} */
  const segs = [];
  if (!body || typeof body !== 'object') return segs;

  // API RENDER ORDER: tools → system → messages (cache spec §2.1 / issue #82). The
  // prompt cache is a prefix of the *rendered* stream, and the API renders tools
  // first — so segments are emitted in that order. A tools-only change then diverges
  // the cache prefix at position 0 (a KEY invalidation) instead of being mis-attributed
  // to "system intact, break in tools". Slots/buckets are unchanged; only order moves.
  // (`finetune.js`/`report.js` aggregate by slot/bucket, not by array position.)

  // Tools — one segment per definition, keyed by name (stable across requests).
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, i) => {
      const name = tool && typeof tool.name === 'string' ? tool.name : `#${i}`;
      segs.push(mkSeg('tools', `tool:${name}`, `Tool: ${name}`, tool, cacheControlOf(tool)));
    });
  }

  // System — one segment per block, or a single segment for a bare string.
  if (Array.isArray(body.system)) {
    body.system.forEach((block, i) => {
      segs.push(mkSeg('system', `system#${i}`, `System block #${i}`, block, cacheControlOf(block)));
    });
  } else if (body.system != null) {
    // A bare string carries no breakpoint; `cacheControlOf` says so without a special case.
    segs.push(mkSeg('system', 'system', 'System prompt', body.system, cacheControlOf(body.system)));
  }

  // Messages — one segment per entry; last entry is the current turn.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const bloatMarks = detectBloat(messages, config);
  messages.forEach((msg, i) => {
    const bucket = i === messages.length - 1 ? 'currentTurn' : 'history';
    const role = msg && typeof msg.role === 'string' ? msg.role : '?';
    const seg = mkSeg(bucket, `message#${i}`, `Message #${i} (${role})`, msg, messageCacheControl(msg));
    const mark = bloatMarks.get(i);
    if (mark) {
      seg.bloated = true;
      seg.bloatBytes = mark;
    }
    segs.push(seg);
  });

  return segs;
}

/**
 * The `cache_control` breakpoint carried by ONE cacheable element (a tool def, a
 * system block, a message content block), or `undefined`. Only a plain object
 * counts: a scalar or array under that key is not a breakpoint the API would
 * honour, and attaching it would make {@link breakpointPositions} report a
 * phantom breakpoint.
 * @param {any} element
 * @returns {{ type: string, ttl?: string } | undefined}
 */
function cacheControlOf(element) {
  if (!element || typeof element !== 'object') return undefined;
  const cc = element.cache_control;
  return cc && typeof cc === 'object' && !Array.isArray(cc) ? cc : undefined;
}

/**
 * Pull a `cache_control` breakpoint off a message, if any (cache spec §2.2). CC
 * places a breakpoint on one CONTENT BLOCK of a message (never on the message
 * object itself, which the API would ignore); a message whose content is a bare
 * string carries none. A message is atomic at our segmentation granularity, so the
 * breakpoint's render position is the segment's own index. Every content block is
 * scanned; the last block carrying a breakpoint wins (it closes the cacheable
 * region within the message).
 * @param {any} msg
 * @returns {{ type: string, ttl?: string } | undefined}
 */
function messageCacheControl(msg) {
  if (!msg || typeof msg !== 'object') return undefined;
  const content = msg.content;
  if (!Array.isArray(content)) return cacheControlOf(content);
  /** @type {{ type: string, ttl?: string } | undefined} */
  let cc;
  for (const block of content) cc = cacheControlOf(block) ?? cc;
  return cc;
}

/**
 * Indices of the segments carrying a `cache_control` breakpoint, in render order
 * (tools → system → messages). Claude Code places exactly three per request (two
 * system blocks + one message block, all `ttl:"1h"`, never on a tool) and uses
 * three of the four the API permits — but NOTHING here is hard-coded: any segment
 * with a breakpoint counts, and an empty array is returned when `cache_control` is
 * absent (older capture / non-CC client). The cache spec's capability frontier
 * (`lastMatchingBreakpoint`, issue #84) is built from this list.
 * @param {Segment[]} segments
 * @returns {number[]}
 */
export function breakpointPositions(segments) {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].cacheControl) out.push(i);
  }
  return out;
}

/**
 * @param {Segment['bucket']} bucket
 * @param {string} slot
 * @param {string} label
 * @param {any} value
 * @param {{ type: string, ttl?: string } | undefined} cacheControl  Required (may be
 *     `undefined`) so no call site can silently forget to look for a breakpoint.
 * @returns {Segment}
 */
function mkSeg(bucket, slot, label, value, cacheControl) {
  const seg = { bucket, slot, label, hash: hashSegment(value), bytes: segBytes(value) };
  if (cacheControl) seg.cacheControl = cacheControl;
  return seg;
}

/**
 * Detect bloated tool_results within a single request (spec §2.4b). A tool_result
 * is flagged only when BOTH above the absolute floor AND a sibling-relative
 * outlier (> k× the median of the request's tool_results). A lone tool_result
 * has no siblings, so the floor alone governs it.
 *
 * @param {any[]} messages
 * @param {WasteConfig} config
 * @returns {Map<number, number>}  messageIndex → the bloated tool_result's byte length.
 */
export function detectBloat(messages, config) {
  /** @type {Array<{ msgIndex: number, bytes: number }>} */
  const results = [];
  messages.forEach((msg, i) => {
    if (!msg || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (block && block.type === 'tool_result') {
        results.push({ msgIndex: i, bytes: segBytes(block) });
      }
    }
  });
  /** @type {Map<number, number>} */
  const marks = new Map();
  if (results.length === 0) return marks;

  const sizes = results.map((r) => r.bytes);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.bytes < config.bloatFloorBytes) continue;
    // Outlier is relative to the SIBLINGS (the other tool_results), not itself —
    // so one large result among small ones is caught even when there are only two.
    // A lone tool_result has no siblings, so the floor alone governs it.
    const siblings = sizes.filter((_, j) => j !== i);
    const outlier = siblings.length === 0 || r.bytes > config.bloatSiblingMultiplier * medianOf(siblings);
    if (!outlier) continue;
    // Keep the largest tool_result per message (a message can hold several).
    marks.set(r.msgIndex, Math.max(marks.get(r.msgIndex) ?? 0, r.bytes));
  }
  return marks;
}

/** @param {number[]} xs */
function medianOf(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @typedef {object} UsageDiffResidual
 * @property {number} rewrittenBytes  The re-written region — reused-uncached mass
 *     (was cached, now re-sent past the break); the re-billed portion of the write.
 * @property {number} newBytes        Genuinely-new content this turn — the part of
 *     the write that is NOT waste (would have been written anyway).
 * @property {number} total           `rewrittenBytes + newBytes` — the write mass
 *     the diff attributes to this turn (the cache-creation basis, by byte proxy).
 */

/**
 * @typedef {object} Classification
 * @property {Segment[]} segments       The input segments, each with `.kind` filled.
 * @property {number} cacheBoundary     Count of leading reused-cached segments (overlay: cached prefix ends here).
 * @property {number} reusedUncachedBytes  Headline waste proxy for this request.
 * @property {boolean} cold             Cold-cache degenerate case (reused collapsed to waste).
 * @property {number} lcp               Content longest-common-prefix with the baseline
 *     — the STRUCTURAL frontier (the mutation point), pre usage-arbitration. The cache
 *     diagnostic's `current[lcp].slot` is the structural culprit candidate (cache spec §3).
 * @property {boolean} hadBaseline      A prior same-lineage request existed to diff against.
 * @property {string | null} mutationSite  Slot of the first divergent segment
 *     (`current[lcp].slot`); `null` when there is no baseline or the prefix never diverges.
 * @property {UsageDiffResidual | null} residual  Diff-derived byte attribution of the
 *     write mass (re-written region vs genuinely-new content), so a turn's
 *     `cache_creation` total can be split (cache spec §4). `null` without a baseline.
 */

/**
 * Classify each current segment New / Reused-cached / Reused-uncached against the
 * baseline (the prior request in the same lineage), `usage`-arbitrated (spec §2.4a).
 *
 * The prompt cache is prefix-based, so the reused-CACHED candidates are the longest
 * common prefix of segment hashes with the baseline. A segment whose content is
 * identical to a baseline segment but which falls AFTER the first divergence was
 * re-sent past a broken cache boundary → reused-uncached waste. `usage` then gates
 * the candidates: cold cache (cache_read ≈ 0) collapses every reused segment to
 * waste, and a materially-short cache_read downgrades the tail of the prefix.
 *
 * @param {Segment[]} current
 * @param {Segment[] | null} baseline
 * @param {import('./report.js').Usage | null} usage
 * @param {WasteConfig} [config]
 * @returns {Classification}
 */
export function classifySegments(current, baseline, usage, config = DEFAULT_WASTE_CONFIG) {
  // First request in a lineage — everything is legitimately new.
  if (!baseline || baseline.length === 0) {
    for (const s of current) s.kind = 'new';
    return {
      segments: current,
      cacheBoundary: 0,
      reusedUncachedBytes: 0,
      cold: false,
      lcp: 0,
      hadBaseline: false,
      mutationSite: null,
      residual: null, // no prior turn ⇒ no re-write to attribute
    };
  }

  // Longest common prefix by hash = the cacheable reused prefix.
  let lcp = 0;
  while (lcp < current.length && lcp < baseline.length && current[lcp].hash === baseline[lcp].hash) lcp++;
  const baselineHashes = new Set(baseline.map((s) => s.hash));

  for (let i = 0; i < current.length; i++) {
    const seg = current[i];
    if (i < lcp) seg.kind = 'reused-cached';
    else if (baselineHashes.has(seg.hash)) seg.kind = 'reused-uncached';
    else seg.kind = 'new';
  }

  // ── usage arbitration ──────────────────────────────────────────────────────
  const cacheRead = usage ? usage.cacheReadInputTokens : 0;
  const cold = !usage || cacheRead <= config.coldCacheTokens;
  let cacheBoundary = lcp;

  if (cold) {
    // No reused-cached tier for this request — every reused segment is waste.
    for (let i = 0; i < lcp; i++) current[i].kind = 'reused-uncached';
    cacheBoundary = 0;
  } else {
    // Reconcile magnitude: usage is ground truth for HOW MUCH was cached. If the
    // diff predicts a bigger cached prefix than cache_read confirms, downgrade the
    // tail of the prefix (beyond the confirmed cached byte budget) to waste.
    const promptTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    const cachedFraction = promptTokens > 0 ? cacheRead / promptTokens : 1;
    const totalBytes = current.reduce((sum, s) => sum + s.bytes, 0);
    const cachedBudget = cachedFraction * totalBytes;
    let acc = 0;
    let boundary = 0;
    for (let i = 0; i < lcp; i++) {
      acc += current[i].bytes;
      // A small tolerance absorbs the byte↔token unit mismatch (proxy, spec §2.5).
      if (acc <= cachedBudget * 1.15) {
        boundary = i + 1;
      } else {
        current[i].kind = 'reused-uncached';
      }
    }
    cacheBoundary = boundary;
  }

  const reusedUncachedBytes = current
    .filter((s) => s.kind === 'reused-uncached')
    .reduce((sum, s) => sum + s.bytes, 0);

  // ── enriched exposures for the cache diagnostic (cache spec §2.3, issue #83) ──
  // lcp is the CONTENT frontier (pre-arbitration); cacheBoundary above is the
  // REALITY frontier (usage-reconciled). The mutation site is the first divergent
  // segment — the structural culprit candidate (null when the prefix never diverges).
  const mutationSite = lcp < current.length ? current[lcp].slot : null;
  // Residual: split the turn's write mass into the re-written region vs genuinely-new
  // content, so T4 can attribute `cache_creation` (re-billed waste vs normal write).
  const newBytes = current.filter((s) => s.kind === 'new').reduce((sum, s) => sum + s.bytes, 0);
  const residual = { rewrittenBytes: reusedUncachedBytes, newBytes, total: reusedUncachedBytes + newBytes };

  return {
    segments: current,
    cacheBoundary,
    reusedUncachedBytes,
    cold,
    lcp,
    hadBaseline: true,
    mutationSite,
    residual,
  };
}

/**
 * Whole-session waste computation. Segments every exchange, classifies each
 * against the prior request in its own `thread_id` lineage, runs static-block
 * detection per lineage, and rolls the signals up per request and per session.
 *
 * Cache-diagnostic enrichment (cache spec §2.3, issue #83): probe turns
 * (`max_tokens === 1`) are filtered from the analysis (never a baseline, excluded
 * from static detection), and each turn carries injected temporal signals
 * (`now`/`idleMs`) derived from the captured per-turn timestamps — `Date.now()` is
 * never called. All enrichments are additive and optional on the input.
 *
 * Mutates nothing on the input; returns the annotations to attach.
 *
 * @param {Array<{ threadId?: string|null, requestBody: any, usage: import('./report.js').Usage|null,
 *   requestReceivedAt?: string|null, responseCompletedAt?: string|null, maxTokens?: unknown }>} exchanges
 *     `maxTokens` is read straight off the captured request JSON, so it is `unknown`:
 *     only a strict `=== 1` counts as a probe (`"1"`/`true` are malformed, not probes).
 * @param {Partial<WasteConfig>} [overrides]
 * @returns {{ perExchange: ExchangeWaste[], summary: SessionWaste, config: WasteConfig }}
 */
export function computeWaste(exchanges, overrides = {}) {
  const config = resolveWasteConfig(overrides);

  // Probe turns (max_tokens === 1) are filtered from analysis BEFORE anything else
  // (cache spec §2.3 / issue #83): a one-shot probe is not a conversation turn, so it
  // must not be the next turn's baseline, supply an idle-gap origin, count toward a
  // slot's recurrence, or be DIFFED ITSELF — a probe's own body barely resembles the
  // conversation, so diffing it would invent a large phantom re-write and leak it into
  // the session's headline waste. The exchange still gets a perExchange entry (1:1 with
  // the input, segments classified against no baseline) so report rendering is unaffected.
  const probe = exchanges.map((e) => e.maxTokens === 1);

  // Segment + classify each exchange against the prior request in the SAME lineage.
  /** @type {Segment[][]} */
  const allSegments = exchanges.map((e) => segmentRequest(e.requestBody, config));
  // Lane state holds the prior NON-PROBE exchange in each lineage: its segment index
  // (the baseline) and its completion time (the idle-gap origin).
  /** @type {Map<string, { segIdx: number, completedMs: number | null }>} */
  const lastInThread = new Map();
  /** @type {{ cls: Classification, now: number | null, idleMs: number | null }[]} */
  const classifications = exchanges.map((e, i) => {
    const key = laneKey(e.threadId, i);
    const prior = probe[i] ? undefined : lastInThread.get(key);
    const baseline = prior ? allSegments[prior.segIdx] : null;
    const cls = classifySegments(allSegments[i], baseline, e.usage, config);
    // `now`/`idleMs` are INJECTED from the captured timestamps (Date.parse, not
    // Date.now). The gap is bounded: non-negative, finite, and null when either end
    // is missing. Probe turns carry no temporal signal (`prior` is withheld above).
    const now = probe[i] ? null : parseMs(e.requestReceivedAt);
    const idleMs =
      now != null && prior && prior.completedMs != null ? Math.max(0, now - prior.completedMs) : null;
    if (!probe[i]) lastInThread.set(key, { segIdx: i, completedMs: parseMs(e.responseCompletedAt) });
    return { cls, now, idleMs };
  });

  // Static detection per lineage: a slot is static iff its content hash never
  // changes across the requests it appears in (spec §2.4c — default since first
  // appearance). NOT structural role. Probe turns are excluded here too.
  markStatic(exchanges, allSegments, probe);

  // Per-request + session rollups.
  /** @type {ExchangeWaste[]} */
  const perExchange = exchanges.map((e, i) => {
    const segs = allSegments[i];
    const { cls, now, idleMs } = classifications[i];
    let bloatCount = 0;
    let flagshipBytes = 0;
    let flagshipCount = 0;
    /** @type {Record<string, number>} */
    const reusedUncachedByBucket = { system: 0, tools: 0, history: 0, currentTurn: 0 };
    for (const s of segs) {
      s.flagship = Boolean(s.static && s.kind === 'reused-uncached');
      if (s.bloated) bloatCount++;
      if (s.kind === 'reused-uncached') reusedUncachedByBucket[s.bucket] += s.bytes;
      if (s.flagship) {
        flagshipCount++;
        flagshipBytes += s.bytes;
      }
    }
    return {
      segments: segs,
      cacheBoundary: cls.cacheBoundary,
      cold: cls.cold,
      reusedUncachedBytes: cls.reusedUncachedBytes,
      reusedUncachedByBucket,
      bloatCount,
      flagshipCount,
      flagshipBytes,
      // Enriched exposures for the cache diagnostic (T3 #84). Additive.
      lcp: cls.lcp,
      hadBaseline: cls.hadBaseline,
      mutationSite: cls.mutationSite,
      residual: cls.residual,
      now,
      idleMs,
      idleMsReliable: e.threadId != null, // the __no_thread__ lane has an unreliable gap
      probe: probe[i],
    };
  });

  const summary = {
    reusedUncachedBytes: perExchange.reduce((s, e) => s + e.reusedUncachedBytes, 0),
    bloatCount: perExchange.reduce((s, e) => s + e.bloatCount, 0),
    flagshipCount: perExchange.reduce((s, e) => s + e.flagshipCount, 0),
    flagshipBytes: perExchange.reduce((s, e) => s + e.flagshipBytes, 0),
  };

  return { perExchange, summary, config };
}

/**
 * @typedef {object} ExchangeWaste
 * @property {Segment[]} segments
 * @property {number} cacheBoundary
 * @property {boolean} cold
 * @property {number} reusedUncachedBytes
 * @property {Record<string, number>} reusedUncachedByBucket
 * @property {number} bloatCount
 * @property {number} flagshipCount
 * @property {number} flagshipBytes
 * @property {number} lcp                 Content longest-common-prefix (structural frontier).
 * @property {boolean} hadBaseline        A prior same-lineage request existed.
 * @property {string | null} mutationSite First divergent slot (structural culprit candidate).
 * @property {UsageDiffResidual | null} residual  Write-mass attribution (re-written vs new).
 * @property {number | null} now          This turn's reference instant, injected from the
 *     captured `request_received_at` (epoch ms); `null` for probe turns.
 * @property {number | null} idleMs       Bounded inter-turn gap (≥0, finite) from the prior
 *     same-lineage turn's `response_completed_at`; `null` when uncomputable or a probe.
 * @property {boolean} idleMsReliable     `false` for the `__no_thread__` lane (capture-order
 *     fallback) whose gap does not represent a real same-conversation idle.
 * @property {boolean} probe              `max_tokens === 1` — filtered from cache analysis.
 */

/**
 * @typedef {object} SessionWaste
 * @property {number} reusedUncachedBytes  Headline metric (byte proxy).
 * @property {number} bloatCount           Counted separately from the re-sent tally.
 * @property {number} flagshipCount
 * @property {number} flagshipBytes
 */

/**
 * Cache-lineage lane key: the manifest `thread_id`. Exchanges with no thread_id
 * share one capture-order lane so a partial capture still diffs sanely.
 * @param {string | null | undefined} threadId
 * @param {number} _index
 */
function laneKey(threadId, _index) {
  return threadId == null ? '__no_thread__' : `t:${threadId}`;
}

/**
 * Parse a captured ISO-8601 timestamp to epoch ms, or `null` when absent/invalid.
 * This is `Date.parse` (a captured string), NOT `Date.now()` — the wall clock stays
 * out of the waste/diagnostic logic (cache spec §2.3, issue #83): `now` is injected
 * from the per-turn capture, never read live.
 * @param {unknown} iso
 * @returns {number | null}
 */
function parseMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mark each segment `.static` iff, within its lineage, the slot's content hash is
 * identical every time the slot appears. Probe turns (`probe[i]`) are excluded from
 * BOTH passes — a one-shot probe is not a real turn, so it must neither count toward a
 * slot's recurrence nor inherit the lineage's verdict (its own content may well differ).
 * @param {Array<{ threadId?: string|null }>} exchanges
 * @param {Segment[][]} allSegments
 * @param {boolean[]} probe  Per-exchange probe flags, parallel to `exchanges`.
 */
function markStatic(exchanges, allSegments, probe) {
  // lane → slot → { count: appearances, hashes: distinct content hashes }
  /** @type {Map<string, Map<string, { count: number, hashes: Set<string> }>>} */
  const lanes = new Map();
  exchanges.forEach((e, i) => {
    if (probe[i]) return; // a probe is filtered from static analysis
    const key = laneKey(e.threadId, i);
    let slots = lanes.get(key);
    if (!slots) lanes.set(key, (slots = new Map()));
    for (const seg of allSegments[i]) {
      let entry = slots.get(seg.slot);
      if (!entry) slots.set(seg.slot, (entry = { count: 0, hashes: new Set() }));
      entry.count++;
      entry.hashes.add(seg.hash);
    }
  });
  exchanges.forEach((e, i) => {
    const slots = probe[i] ? undefined : lanes.get(laneKey(e.threadId, i));
    for (const seg of allSegments[i]) {
      const entry = slots?.get(seg.slot);
      // Static = a RECURRING slot (≥2 appearances) whose content never changed.
      // A slot seen only once can't be "unchanged across turns"; calling it static
      // would mislabel a brand-new, one-off block (e.g. the final current turn) as
      // recurring. Flagship is unaffected — reused-uncached always recurs.
      seg.static = entry != null && entry.count >= 2 && entry.hashes.size === 1;
    }
  });
}
