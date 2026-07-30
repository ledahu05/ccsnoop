# Cache-diagnostic real fixture

A committed REAL captured Claude Code session, the "real session" integration proof for
the cache diagnostic's pure seam `diagnoseCache` (cache spec §3 / issue #84, AC #7). It
mirrors the existing fine-tune fixture (`test/fixtures/finetune/`) — same on-disk shape
(per-turn `*.request.http` + `*.response.sse` + `manifest.jsonl`) — but is asserted at the
cache seam only.

This is the same real capture as the fine-tune fixture (session
`963204f5-…`), copied here so the cache feature is self-contained. It is a textbook warm
Claude Code session for the diagnostic:

- 12 built-in tools, and exactly the Claude Code breakpoint layout per turn — two system
  blocks + one message block, all `ttl:"1h"`, never on a tool (so the **3-frontier** model
  applies and the breakpoint↔LCP divorce is detectable).
- Real `usage` with per-turn `cache_read` + a `1h`-tier `cache_creation` — the legal cost
  basis (never re-tokenized).
- Append-only growth; every continuation is fully served from cache → **HIT**. Turn 1 reads
  from cache despite having no captured predecessor → **UNEXPLAINED** (content-keyed cache).

The cold/edge verdicts (STRUCTURAL KEY/PREFIX/TRUNCATED, TEMPORAL, the divorce, the
2-frontier fallback) are covered by the synthetic unit cases in `test/cache.test.js`; this
fixture proves the seam runs end-to-end on real captured traffic.
