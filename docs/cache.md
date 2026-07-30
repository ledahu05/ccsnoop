# `ccsnoop cache` — diagnose your prompt-cache economy

Claude Code reuses long conversations, and the **prompt cache** is what keeps that
affordable: as long as the conversation's stable prefix stays cached, each turn reads
the history cheaply instead of re-processing it. But caches go cold — and when one
does, you usually have no idea *why*, *what it cost*, or *what to do differently*.

`ccsnoop cache` answers those three questions, **per turn where a cached prefix
expired or stopped being honored**:

- **Why** it went cold — a four-verdict taxonomy.
- **What it cost** — the re-write, in effective **token-equivalents**.
- **What to do differently** — a recommendation, but only where a controllable cause
  exists.

It is an offline reader of **one** captured conversation. It does not need the daemon
running, it writes no files, and it **never re-tokenizes** — sizes come from byte
lengths, token figures come straight from the captured `usage`.

> Captures first. `cache` reads one session, so you need at least one capture. If you
> have not captured anything yet, follow the
> [Quickstart](../README.md#4-quickstart--the-happy-path) first.

---

## The four verdicts

Each cold transition is sorted into exactly one verdict by partitioning it across
three layered "frontiers" (what was *really* cached, the content longest-common-prefix
where mutations land, and the last matching `cache_control` breakpoint):

| Verdict | Meaning |
| ------- | ------- |
| **HIT** | The cache served the entire prior prefix — nothing expired. Not printed as a card; counted only in the rollup. |
| **STRUCTURAL** | The baseline content was re-written because of a mutation. Sub-modes: **KEY** (a key changed mid-prefix), **PREFIX** (the mutation is at/near the last turn), **TRUNCATED** (compaction dropped the tail). |
| **TEMPORAL** | An identical-but-cold prefix, where the captured inter-turn gap is known, reliable, and ≥ the TTL. Confidence is `low` when the gap straddles the TTL. |
| **UNEXPLAINED** | The cache key is not exhaustively published, so the cause is **never fabricated** (`cause: null`). It surfaces non-actionable hidden-cause candidates instead. A special *breakpoint↔LCP divorce* sub-case has a known cause (no `cache_control` breakpoint covered stable content) but an uncontrollable lever. |

The honest signal matters: when content was stable but no breakpoint covered it, that
"stable-but-uncached" divorce is reported as its own thing — not mis-blamed on time or
a mutation.

---

## The output — cards, then a rollup

**Per-transition cards** (one per non-HIT turn):

```
── turn <n> ── <VERDICT>[·<StructMode>]   [(low confidence)]   [composite]
    cause:  <text, or "(no cause — unexplained)">
    cost:   ~<n> tok-équ.  (<per-tier breakdown>)
    reco:   <recommendation, or none>
    hidden candidates: <…>        (only on hidden-cause UNEXPLAINED)
```

Warm HIT turns are **omitted** from the cards (a line tells you how many) — they are
good news, summarized in the rollup.

**Lean session rollup** (a footer):

- `write` / `read` / `wasted` totals, in token-equivalents;
- `by verdict:` counts — HIT · STRUCTURAL · TEMPORAL · UNEXPLAINED (and structural
  sub-modes when any);
- a `counterfactual:` line — what the recommendations would have avoided re-writing;
- **deduped `recommendations`** — each session pattern once, with a count.

A recommendation is emitted **only** where a controllable, causal lever exists
(*resume inside the TTL window*, *batch the invalidating changes into one turn*,
*edit the last turn, not an old one*…). Where the cause is outside your control
(compaction, hidden eviction, un-published cache-key components), it says so honestly
instead of inventing advice.

---

## Cost, in token-equivalents

The re-write is costed in **effective token-equivalents** — raw tokens × a tier
multiplier — drawn **only** from the captured `usage`:

| Tier | Multiplier |
| ---- | ---------- |
| cache write, 5 min | ×1.25 |
| cache write, 1 h | ×2 |
| cache read | ×0.1 |

When a tier can't be read from the capture, that mass is priced as an honest
**bound** (e.g. `[×1.25, ×2]`), never a false-precise point. The multiplier and tier
are always shown alongside the number.

---

## Flags

| Flag | Meaning |
| ---- | ------- |
| `--ttl <seconds>` | TEMPORAL threshold (default `3600` = 1 h). Must be a non-negative number. |
| `--html` | render the same data as a self-contained HTML document (to stdout) |
| `--session <id>` | session to diagnose (default: latest) |
| `--latest` | most-recent session (same as the default — accepted for symmetry) |
| `--root <path>` | capture root (default `./.ccsnoop`) |
| `--sessions-dir <p>` | dir holding session subdirs (overrides `--root`) |

There is **no `--all`** — a cache economy is per-conversation, so `cache` always works
on one session.

---

## Example

```console
$ ccsnoop cache
ccsnoop cache — session session-963204f5…
  6 transition(s) · 1 cold · 3-frontier

── turn 1 ── UNEXPLAINED
    cause: cache_read with no captured antecedent — a content-keyed cache or a partial capture served content we never saw written
    cost:  —
  (5 warm HIT turns omitted from the cards)

── session rollup ────────────
    write:        ~30,874 tok-équ.  (15,437 ×2 (1 h write))
    read:         ~18,492.5 tok-équ.  (184,925 ×0.1 (read))
    wasted:       ~0 tok-équ.
    by verdict:   HIT 5 · STRUCTURAL 0 · TEMPORAL 0 · UNEXPLAINED 1
    counterfactual: would have avoided re-writing ~0 tok-équ.
    recommendations: none
```

This conversation stayed warm: five turns were served from cache, and the one cold turn
was UNEXPLAINED (a cache read with no captured antecedent) — so there is nothing
actionable and `recommendations: none`. A conversation that mutates mid-prefix would
instead show STRUCTURAL cards with concrete recommendations in the rollup.

---

## Further reading

The full design — the three frontiers, the region-partition arbitration, the verdict
taxonomy, and the recommendation bridges — is in [`cache-spec.md`](cache-spec.md).
