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

  // System — one segment per block, or a single segment for a bare string.
  if (Array.isArray(body.system)) {
    body.system.forEach((block, i) => {
      segs.push(mkSeg('system', `system#${i}`, `System block #${i}`, block));
    });
  } else if (body.system != null) {
    segs.push(mkSeg('system', 'system', 'System prompt', body.system));
  }

  // Tools — one segment per definition, keyed by name (stable across requests).
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, i) => {
      const name = tool && typeof tool.name === 'string' ? tool.name : `#${i}`;
      segs.push(mkSeg('tools', `tool:${name}`, `Tool: ${name}`, tool));
    });
  }

  // Messages — one segment per entry; last entry is the current turn.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const bloatMarks = detectBloat(messages, config);
  messages.forEach((msg, i) => {
    const bucket = i === messages.length - 1 ? 'currentTurn' : 'history';
    const role = msg && typeof msg.role === 'string' ? msg.role : '?';
    const seg = mkSeg(bucket, `message#${i}`, `Message #${i} (${role})`, msg);
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
 * @param {Segment['bucket']} bucket
 * @param {string} slot
 * @param {string} label
 * @param {any} value
 * @returns {Segment}
 */
function mkSeg(bucket, slot, label, value) {
  return { bucket, slot, label, hash: hashSegment(value), bytes: segBytes(value) };
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
 * @typedef {object} Classification
 * @property {Segment[]} segments       The input segments, each with `.kind` filled.
 * @property {number} cacheBoundary     Count of leading reused-cached segments (overlay: cached prefix ends here).
 * @property {number} reusedUncachedBytes  Headline waste proxy for this request.
 * @property {boolean} cold             Cold-cache degenerate case (reused collapsed to waste).
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
    return { segments: current, cacheBoundary: 0, reusedUncachedBytes: 0, cold: false };
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
  return { segments: current, cacheBoundary, reusedUncachedBytes, cold };
}

/**
 * Whole-session waste computation. Segments every exchange, classifies each
 * against the prior request in its own `thread_id` lineage, runs static-block
 * detection per lineage, and rolls the signals up per request and per session.
 *
 * Mutates nothing on the input; returns the annotations to attach.
 *
 * @param {Array<{ threadId: string|null, requestBody: any, usage: import('./report.js').Usage|null }>} exchanges
 * @param {Partial<WasteConfig>} [overrides]
 * @returns {{ perExchange: ExchangeWaste[], summary: SessionWaste, config: WasteConfig }}
 */
export function computeWaste(exchanges, overrides = {}) {
  const config = resolveWasteConfig(overrides);

  // Segment + classify each exchange against the prior request in the SAME lineage.
  /** @type {Map<string, number>} */
  const lastInThread = new Map();
  /** @type {Segment[][]} */
  const allSegments = exchanges.map((e) => segmentRequest(e.requestBody, config));
  /** @type {Classification[]} */
  const classifications = exchanges.map((e, i) => {
    const key = laneKey(e.threadId, i);
    const prevIdx = lastInThread.get(key);
    const baseline = prevIdx === undefined ? null : allSegments[prevIdx];
    const cls = classifySegments(allSegments[i], baseline, e.usage, config);
    lastInThread.set(key, i);
    return cls;
  });

  // Static detection per lineage: a slot is static iff its content hash never
  // changes across the requests it appears in (spec §2.4c — default since first
  // appearance). NOT structural role.
  markStatic(exchanges, allSegments);

  // Per-request + session rollups.
  /** @type {ExchangeWaste[]} */
  const perExchange = exchanges.map((_, i) => {
    const segs = allSegments[i];
    const cls = classifications[i];
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
 * @param {string|null} threadId
 * @param {number} _index
 */
function laneKey(threadId, _index) {
  return threadId == null ? '__no_thread__' : `t:${threadId}`;
}

/**
 * Mark each segment `.static` iff, within its lineage, the slot's content hash is
 * identical every time the slot appears.
 * @param {Array<{ threadId: string|null }>} exchanges
 * @param {Segment[][]} allSegments
 */
function markStatic(exchanges, allSegments) {
  // lane → slot → { count: appearances, hashes: distinct content hashes }
  /** @type {Map<string, Map<string, { count: number, hashes: Set<string> }>>} */
  const lanes = new Map();
  exchanges.forEach((e, i) => {
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
    const slots = lanes.get(laneKey(e.threadId, i));
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
