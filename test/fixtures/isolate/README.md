# Subagent isolation fixtures (issue #102)

Synthetic captured sessions for the `isolate` subagent context-isolation diagnostic
(`src/isolate.js` → `isolateAnalyze`). Unlike the cache / fine-tune fixtures (which are
real captured Claude Code traffic), these are **minimal hand-authored sessions** with
deliberate token figures so the per-thread split, the main-vs-isolated totals, and the
if-inlined counterfactual are exact, assertable integers. The on-disk shape is the same
one every analysis shares: per-turn `*.request.http` + `*.response.sse` + `manifest.jsonl`,
read by the report session reader (`loadExchanges`).

The `usage` is carried in the SSE `message_start` event exactly as capture would write it;
`isolate` sums it directly and **never re-tokenizes**. Request bodies are trivial (`{"model":…}`)
— the diagnostic does not read them; only the response `usage` and the raw request bytes
(the labelled byte fallback) matter here.

## `session-with-subagent/` — a main thread + one subagent thread (3 subagent turns)

| thread                  | parent                 | turns | input tokens (input + cacheRead + cacheCreation) |
|-------------------------|------------------------|-------|---------------------------------------------------|
| `ccsnoop-main-aaaa1111` | —                      | 2     | (1000) + (50 + 1100) = **2,150** (main)           |
| `ccsnoop-sub-bbbb2222`  | `ccsnoop-main-aaaa1111`| 3     | (2000) + (40 + 2200) + (30 + 2300) = **6,570** (isolated) |

- main total: **2,150** · subagent (isolated) total: **6,570** · if-inlined counterfactual:
  **8,720** · isolation ratio: **~75.3 %** (material ⇒ recommendation fires).
- A subagent thread is identified by `parent_session_id != null` (never by id matching).

## `session-no-subagent/` — a single main thread, no subagents

| thread                  | parent | turns | input tokens |
|-------------------------|--------|-------|--------------|
| `ccsnoop-solo-cccc3333` | —      | 2     | (500) + (20 + 600) = **1,120** |

- `hasSubagents === false`; the renderer emits the honest "no subagent threads" line and no reco.
