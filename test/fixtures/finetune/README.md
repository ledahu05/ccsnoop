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

## To land a fixture (on a host with claude.ai OAuth)

1. `node scripts/bench/run.mjs arm arm-00` — the witness (all four levers present).
2. Copy `<run>/arm-00/capture/` → `test/fixtures/finetune/session-<id>/`.
3. Verify redaction (spec §1.3 / §3.3): denylist headers are `‹REDACTED›`, no
   `/tmp/ccsnoop-bench/…` paths in `manifest.jsonl`.
4. `npm test` — the gate activates and must pass.
