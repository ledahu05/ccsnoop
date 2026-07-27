# Fine-tune fixtures (`test/fixtures/finetune/`)

A committed **real captured Claude Code session** lives here, one directory per
session: `session-<id>/` containing `manifest.jsonl` + per-turn `NNNN.request.http`
+ `NNNN.response.sse` (gzip). This is the substrate the downstream fine-tune
tickets (T1–T7, `docs/fine-tune-spec.md`) test against.

## Status — issue #70 (FT0)

**No fixture is committed yet.** This directory is intentionally empty of
`session-*` dirs while FT0 is blocked.

The intended source is a lever-complete witness capture produced **through the
bench** (`scripts/bench/run.mjs`, `bench/SPEC.md` §0) — claude.ai OAuth →
`api.anthropic.com`, model `claude-haiku-4-5-20251001`. In agent sandboxes that
lack `~/.claude/.credentials.json` (claude.ai subscription auth inactive) and
have no direct `api.anthropic.com` access, the bench's `copyCredentials` step
(bench `step 10`) is fatal and **no genuine capture can be produced**. AC #5
forbids synthesizing a fake one, so FT0 escalates rather than ships a stand-in.

The acceptance criteria (AC #1–#4) are encoded as a self-activating gate in
`test/finetune-fixture.test.js`: it self-skips while this dir has no `session-*`
entry, then auto-validates any committed fixture (four levers, a `tool_use`
response, scrubbed headers/paths).

## Downstream contract — system-bucket attribution (issue #73 / FT3)

`src/finetune-system.js` splits the `system` bucket by source, attributing each
`system` block to one of four levers — `claude-md` / `hook` / `mcp-deferred` /
`harness` — with the harness (and anything unattributable) flagged as the
**incompressible floor** (shown, never emitted downstream; fine-tune-spec §2.3).

A second self-activating gate in `test/finetune-system.test.js` enforces AC #1–#2
on a committed fixture: every `system` block maps to exactly one lever, floor
flags are consistent, and a block carrying a bench sentinel maps to its lever.
Like FT0's gate it **self-skips while no `session-*` fixture is committed**.

The classification heuristics are **content-driven and sentinel-grounded** — each
bench fixture carries a unique sentinel (`CLAUDEMD-…`, `PERSONA-…`, the L4 MCP
stub tool `t00`) that is the on-wire proof of its lever. The assumed CC build is
**v2.1.220 linux-x64 sdk-cli, `claude-haiku-4-5-20251001`, `ENABLE_TOOL_SEARCH=true`**
(bench/SPEC.md §0). The conservative textual markers (`<file path=…>`,
`<session-start-hook`, "deferred tool(s)") are best-effort aids for real-CC blocks
with no sentinel; they are confirmed/refined against this real capture the instant
it lands.

> **Fidelity caveat.** Under `-p` the bench observed L2–L6 lever content landing in
> `message#0` (currentTurn at turn 1), not in `system[]` (bench/SPEC.md §4). Whether
> the interactive `system[]`-block shape (omniris) or the `-p` `message#0` shape
> appears here is exactly the fidelity question FT3 isolates — the gate reports the
> observed mapping rather than over-asserting indices, so a surprise here refines
> `src/finetune-system.js` rather than silently passing.

## To land a fixture (on a host with claude.ai OAuth)

1. `node scripts/bench/run.mjs arm arm-00` — the witness (all four levers present).
2. Copy `<run>/arm-00/capture/` → `test/fixtures/finetune/session-<id>/`.
3. Verify redaction (spec §1.3 / §3.3): denylist headers are `‹REDACTED›`, no
   `/tmp/ccsnoop-bench/…` paths in `manifest.jsonl`.
4. `npm test` — the gate activates and must pass.
