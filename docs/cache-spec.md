# ccsnoop cache — hand-off spec

A `cache` subcommand that turns a captured Claude Code → Anthropic session into a **cache-economy diagnostic**: for every turn where a cached prefix expired or stopped being honored, it explains **why** (a temporel pause vs a structurelle mutation vs an inexpliqué cold), **what it cost** (the re-write, in tier-aware token-equivalents), and **what to do differently** (a recommendation only where a controllable lever exists).

This is a **spec for a builder** — no code ships from the planning effort behind it. It compiles the [cache wayfinder map](https://github.com/ledahu05/ccsnoop/issues/36) with its closed tickets C1–C7 (#37–#42, #44). Each section links the ticket that owns the detail. Where this spec and a ticket disagree, the ticket's resolution comment is authoritative. The to-spec mirror is [#81](https://github.com/ledahu05/ccsnoop/issues/81).

## Scope & non-negotiables

- **Never re-tokenize.** A byte-length proxy for *sizes* (`Segment.bytes`); **tokens come only from captured `usage`** (`readUsage`/`normalizeUsage`). No byte→token conversion exists or is added. (Map Notes; spec §2.4b.)
- **Tokens, never currency.** Cost is expressed in **token-equivalents** (tokens × tier multiplier). Currency is **out of scope** — a session can span model switches (a KEY invalidator), so a $ total would mix rates; price tables stale. Re-entry: a later presentation layer given a price table + per-turn model tracking.
- **Reuses, doesn't rebuild:** the segmentation/classification of `src/waste.js` and the session loader / CLI dispatch of `src/report.js` + `bin/ccsnoop.js`. The one new substrate is **a cache-diagnostic module** (`src/cache.js`) consuming an *enriched* classification.
- **Per-turn timestamps already captured** (`request_received_at`/`response_completed_at` in the manifest) → the inter-turn gap is computable with no new capture plumbing.
- **`usage` is ground truth**; `cache_control.ttl` is used only for the capability frontier, never for pricing.

## Proof base

The seven wayfinder decisions C1–C7 (map #36), grounded in a real captured CC session and the live code: the caching mechanism & pricing (sliding TTL; write 5 min ×1.25, 1 h ×2, read ×0.1) is established by [C1](https://github.com/ledahu05/ccsnoop/issues/37); the temporal proofs (per-turn gaps, the three `cache_control` breakpoints all `ttl:"1h"` never on a tool, `system[0]` in every prefix without a marker) by [C2](https://github.com/ledahu05/ccsnoop/issues/38). The hard prerequisites that once blocked costing — gzip response blobs and the dropped per-tier split — are **resolved and merged** ([#45](https://github.com/ledahu05/ccsnoop/issues/45)/[#53](https://github.com/ledahu05/ccsnoop/issues/53)): `usage` is readable and `normalizeUsage` captures `cache_creation.ephemeral_{5m,1h}`. The numbers an implementation emits are real `usage`/byte figures, not estimates.

## Architecture

```
sessions/<id>/  ──▶ loadSession (report.js) ──▶ per-turn segments (waste.js)
                         │                            │  tools → system → messages   ◀── reordered (Part 2)
                         │   usage (readUsage/         │  + cache_control breakpoints  ◀── now parsed (Part 2)
                         │    normalizeUsage):         │  + lcp / cacheBoundary
                         │    tiers 5m/1h, cache_read  │
                         ▼                            ▼
                  classifySegments, enriched  ◀── now/idleMs injected; probe turns (max_tokens:1) filtered
                         │
                         ▼
                  diagnoseCache (src/cache.js)  ──▶ 3-frontier verdict + cost (tok-équ) + reco  (pure)
                         │
                         ▼
                  cache renderer  ──▶ per-transition cards + lean rollup  (text + HTML)
```

`cache` is a pure consumer of a captured session, like `report`/`fine-tune`. All structure is derived at run time from `sessions/<id>/`; nothing is stored beyond what capture already writes. `diagnoseCache` is a pure function — no I/O, no wall-clock (`now` injected).

---

## Part 1 — CLI surface (C3)

Mirror the `report`/`fine-tune` subcommands — flags only, no positional:

```
ccsnoop cache --session <id>       # one session (the unit of a cache diagnostic)
ccsnoop cache --latest             # most-recent session
ccsnoop cache --root <path>        # non-default capture root
ccsnoop cache --sessions-dir <path>
ccsnoop cache --ttl <seconds>      # TEMPORAL threshold (default 3600)
ccsnoop cache --html               # emit the HTML render too
```

- A cache diagnostic is about **transitions within one session** (the report has rows, not edges), so the unit is a single session — no corpus mode.
- Reuse `listSessions` / `pickLatestSession` / root resolution from `src/report.js`.
- Insert into `bin/ccsnoop.js` via `SUBCOMMANDS` + a `runCache(args)` dispatch, modelled on `runReport`/`runFineTune`.

> Detail: [C3 (#39)](https://github.com/ledahu05/ccsnoop/issues/39).

---

## Part 2 — The seam & substrate enrichment (C3, C7)

The diagnostic reuses `classifySegments`/`computeWaste` (`src/waste.js`) but needs the classifier enriched, plus two prerequisite fixes that **condition all correctness**:

### 2.1 Reorder segmentation to API render order: `tools → system → messages`
Today `segmentRequest` emits `system → tools → messages`. The cache is a prefix of the *rendered* stream (tools first); without the reorder a tools-only change is mis-attributed ("system intact, break in tools") when in cache-order the prefix diverges at position 0. **This reorder is what makes the KEY (whole-prefix cold) vs PREFIX (head stays cached) distinction detectable** — a tools mutation must register at render position 0. (`Date.now()` stays forbidden; slots are unchanged — `finetune.js`/`report.js` use slots, not order.) **Migration:** the corrected LCP may change existing waste-signal results — check/update existing waste tests at impl.

### 2.2 Parse `cache_control` and index breakpoint positions in render order
`cache_control` is currently unread. Claude Code places exactly three breakpoints per request (all `ttl:"1h"`, never on a tool: two system blocks + one message block), uses three of the four permitted, and the message-breakpoint position varies — **nothing is hard-coded**. Attach breakpoint positions as per-segment metadata in render order.

### 2.3 Enrich the classifier return (additive, inside `classifySegments`)
Expose per turn: `lcp`, `hadBaseline`, the mutation site, and the **residual usage-vs-diff** (so a turn's `cache_creation` total can be split between the re-written region and genuinely-new content). Inject `now` and a bounded `idleMs`. Filter probe turns (`max_tokens === 1`). The `__no_thread__` lineage has unreliable `idleMs` → TEMPORAL verdicts/recos suppressed or marked there.

> Detail: [C3 (#39)](https://github.com/ledahu05/ccsnoop/issues/39), [C7 (#44)](https://github.com/ledahu05/ccsnoop/issues/44).

---

## Part 3 — Three frontiers & the verdict taxonomy (C7, C4)

The cache frontier is **not** a single number. Three layered signals, each with a role, related as **`cacheBoundary ≤ lastMatchingBreakpoint ≤ lcp`** (when breakpoints are present):

| frontier | source | role |
|---|---|---|
| `lcp` | content LCP (tools-first) | **structural** — the mutation point; names culprit slot `current[lcp].slot` |
| `cacheBoundary` | `usage.cache_read_input_tokens`, reconciled | **reality** — what was actually cached; cost basis + TEMPORAL region |
| `lastMatchingBreakpoint` | `cache_control`, render-ordered | **capability** — what *could* have been cached; explains the stable-but-uncached tail |

`cache_control` absent (older capture / non-CC client) → `lastMatchingBreakpoint` undefined → **fall back to the two-frontier `{cacheBoundary, lcp}` model**, with a note that the capability dimension is unavailable.

### 3.1 Four atomic verdicts, arbitrated by region partition (not a priority order)
**HIT / STRUCTURAL / TEMPORAL / UNEXPLAINED.** A mutation owns `[lcp, end)` (STRUCTURAL); the identical `[cacheBoundary, lcp)` demands its own cause — **TEMPORAL** if the inter-turn gap ≥ TTL, else **UNEXPLAINED**. STRUCTURAL has three sub-modes:
- **KEY** — a `tools`/`system` mutation, or a model/effort/MCP/tool-deny event → invalidates the *entire* prefix (tools sit at render position 0 inside the first cache entry, so a tools change makes the whole prefix cold).
- **PREFIX** — a history-only mutation; the head stays cached.
- **TRUNCATED** — compaction.

When more than one region is non-empty the verdict is **composite**; the headline is the dominant-cost region, and a structural culprit is always named. **UNEXPLAINED is first-class** (the cache key is not exhaustively published) — never invent a cause for it.

### 3.2 The breakpoint↔LCP divorce is a first-class signal
When `lcp > lastMatchingBreakpoint`, content was stable beyond the last covered point — it was **never cached** and is re-processed at full rate every turn. Cause known (no breakpoint), lever not user-controllable in CC → **diagnostic-only, weak reco**, never mis-blamed on time or a mutation. This refines the region model: `[cacheBoundary, lcp)` splits into `[cacheBoundary, lastMatchingBreakpoint)` (capable-but-not-served → TEMPORAL/eviction) and `[lastMatchingBreakpoint, lcp)` (stable-but-uncached → UNCACHED-by-design).

### 3.3 `usage` is authoritative; a contradiction is the signal
`cache_read_input_tokens` is ground truth; `cacheBoundary` is derived from it, so usage cannot contradict the reality frontier. Apparent contradictions resolve to verdicts: `cacheBoundary < lcp` with a capability gap → TEMPORAL; `cache_read > 0` with no captured antecedent (content-keyed caches) → UNEXPLAINED. Content and breakpoint predictions never override usage.

> Detail: [C7 (#44)](https://github.com/ledahu05/ccsnoop/issues/44), [C4 (#40)](https://github.com/ledahu05/ccsnoop/issues/40).

---

## Part 4 — Cost maths (C6)

- **Unit = effective token-equivalent** = tokens × tier multiplier (cache-write 5 min ×1.25, cache-write 1 h ×2, cache-read ×0.1), **always shown with its multiplier breakdown** — e.g. `1 000 tok × 2 (1 h write) = 2 000 tok-équ.` Raw tokens appear as a secondary detail.
- **Tier & multiplier from `usage`** (`cacheCreation{5m,1h}`); `cache_control.ttl` is **not** used for cost.
- **Degradation, per-exchange:**
  - `usage` absent on a turn (error/HEAD blob) → no cost line, shown `—`; verdict + cause still shown.
  - `usage` present but both tier fields 0 while the flat `cache_creation_input_tokens` > 0 → **tier unknown** → cost shown as a range `[×1.25, ×2]` labelled as a bound. Never a false-precise single number.
- **Exact vs bounded:**
  - **Session-rollup totals are exact** — `Σ` per-turn `cacheCreation5m×1.25 + cacheCreation1h×2 + cacheRead×0.1`, straight from `usage`, zero attribution.
  - **Per-transition wasted cost** is exact when the Part 2.3 residual attributes the turn's `cache_creation` to the re-written region; otherwise bounded (`≤ this turn's write cost`).

> Detail: [C6 (#42)](https://github.com/ledahu05/ccsnoop/issues/42).

---

## Part 5 — Recommendations (C5)

A reco is legitimate **iff** the lever is **(1) controllable, (2) causal on *this* transition, (3) non-trivial**. Verdicts that fail the test carry a diagnostic + cost, no reco.

| verdict | reco | counterfactual form |
|---|---|---|
| **HIT** | none | — |
| **TEMPORAL** | "resume before the TTL" + "group your turns" (rollup, keeps the sliding TTL alive) | avoidance |
| **STRUCTURAL·KEY** | "batch the invalidating changes into one turn" + fine-tune reco-bridge + chronicity → "stabilize the volatile block" | amortization |
| **STRUCTURAL·PREFIX** | "edit/add the last turn, not an old one" (name `current[lcp].slot`) | avoidance |
| **STRUCTURAL·TRUNCATED** | diagnostic only; weak reco | marginal |
| **UNEXPLAINED** | none; emit hidden-cause candidates as non-actionable context | — |

- **Counterfactual** in token-equivalents, phrased "would have avoided re-writing ~X tokens" (a lower bound, not a guarantee), three forms (avoidance / amortization / none), **confidence-aware** (low-confidence TEMPORAL → conditional).
- **Fine-tune reco-bridge** (sister map [#29](https://github.com/ledahu05/ccsnoop/issues/29)): a denied tool / MCP disconnect is both a fine-tune lever and a KEY invalidator costing one full re-write — surface its cache cost alongside its static-bloat cost (unifies the two maps' economics; depends on fine-tune lever emission T5).
- **Anti-noise guards:** reco only on a transition with waste; session-pattern recos dedup to once at the rollup; suppress for UNEXPLAINED and uncontrollable-KEY; **chronicity** ("stabilize the volatile block") fires only when the same culprit slot recurs across ≥2–3 transitions — never on a one-off edit.

> Detail: [C5 (#41)](https://github.com/ledahu05/ccsnoop/issues/41).

---

## Part 6 — Output shape: per-transition card + lean rollup (C6, C3)

**Per-transition card (primary), one per non-HIT transition:**
```
turn 4 — STRUCTURAL·KEY        cost: 18 420 tok × 2 (1 h write) = 36 840 tok-équ.
  cause: tool 'advisor' removed from tools → whole prefix invalidated
  culprit slot: tool:advisor
  reco: batch invalidating changes into one turn (this re-write happened 3× this session)
```
Fields: turn → verdict (sub-mode + composite regions) → cause → cost (multiplier; range if tier unknown; `—` if usage absent) → reco if legitimate.

**Lean session rollup (footer):**
```
session — write 41 200 tok-équ. · read 3 080 tok-équ. · wasted (re-billed) 36 840 tok-équ.
  by verdict: STRUCTURAL·KEY ×3 · TEMPORAL ×1 · UNEXPLAINED ×1
  recos: group your invalidating changes (1×) · stabilize volatile block: tool:advisor (chronic)
  avoidable waste ≈ 30 000 tok-équ. (counterfactual, lower bound)
```
Totals (write/read/wasted in tok-équ.), count by verdict, rollup-only recos deduped once, summed counterfactual. **No per-event repetition in the rollup.**

Text by default; `--html` renders the same data. Module interface (decision-rich):

```
Verdict := HIT | STRUCTURAL | TEMPORAL | UNEXPLAINED;  StructMode := KEY | PREFIX | TRUNCATED
TokEquiv := { rawTokens, multiplier, tier:'5m'|'1h'|'read'|'unknown', equiv }
Region := { range:[start,end), verdict, structMode?, cause?, cost?: TokEquiv, culpritSlot? }
Reco := { text, form:'avoidance'|'amortization'|'none', confidence:'high'|'low', weak? }
Card := { turn, regions:Region[], headline:Region, reco?:Reco }          // composite when >1 non-empty region
Rollup := { totals:{write,read,wasted}, byVerdict, rollupRecos:Reco[], summedCounterfactual:TokEquiv }
Diagnostic := { transitions:Card[], rollup:Rollup, frontierModel:'3-frontier'|'2-frontier-fallback' }
```

> Detail: [C6 (#42)](https://github.com/ledahu05/ccsnoop/issues/42), [C3 (#39)](https://github.com/ledahu05/ccsnoop/issues/39).

---

## Part 7 — Acceptance (builder's checklist)

- [ ] `ccsnoop cache --session <id>` (and `--latest`/`--root`/`--sessions-dir`/`--ttl`/`--html`) works; wired via `SUBCOMMANDS` + `runCache`.
- [ ] Segmentation is reordered to `tools → system → messages`; existing waste tests checked/updated for the corrected LCP.
- [ ] `cache_control` breakpoints are parsed and attached as per-segment metadata in render order (three breakpoints, nothing hard-coded).
- [ ] `classifySegments` exposes `lcp`, `hadBaseline`, mutation site, residual usage-vs-diff; `now`/`idleMs` injected; probe turns filtered; `__no_thread__` TEMPORAL suppressed/marked.
- [ ] `diagnoseCache` is pure (no I/O, no wall-clock) and emits the four verdicts with correct region partition; composite + headline + named culprit; UNEXPLAINED never fabricates a cause.
- [ ] Three frontiers computed with `cacheBoundary ≤ lastMatchingBreakpoint ≤ lcp`; 2-frontier fallback when `cache_control` absent; the stable-but-uncached divorce reported as diagnostic-only.
- [ ] Cost in token-equivalents with multiplier shown; tier-unknown → `[×1.25, ×2]` range; usage-absent → `—`; rollup totals exact, per-transition cost bounded when residual absent.
- [ ] Recos respect the 3-condition test; per-verdict as specified; chronicity ≥ threshold; rollup dedup; fine-tune reco-bridge wired.
- [ ] Per-transition cards + lean rollup rendered (text + `--html`); no per-event repetition in the rollup.
- [ ] **Never re-tokenizes** — sizes via `Segment.bytes`, tokens via captured `usage` only.

## Out of scope

- **Currency / $ pricing** — token-equivalents only (re-entry: price table + per-turn model tracking).
- **Reconstructing cost from `cache_control.ttl`** — `usage` is the sole cost basis.
- **Multi-lineage / sub-agents** — whether a `parent_session_id` implies concurrent prefixes that evict each other is unresolved residual fog; left for a post-implementation iteration.

## Further notes

- **Dependencies satisfied:** [#45](https://github.com/ledahu05/ccsnoop/issues/45)/[#53](https://github.com/ledahu05/ccsnoop/issues/53) (gzip blobs, per-tier split) are resolved/merged — `usage` is readable with no new capture work.
- **Sister effort:** the static-bloat axis is the [fine-tune spec](./fine-tune-spec.md) (map [#29](https://github.com/ledahu05/ccsnoop/issues/29)); the reco-bridge ties their economics together.
- **Impl order suggestion:** Part 2 prerequisites first (reorder, parse `cache_control`) → enrich classifier → `diagnoseCache` (Part 3) → cost (Part 4) → recos (Part 5) → render + CLI (Parts 6 & 1).
