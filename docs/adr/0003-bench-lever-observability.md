# ADR-0003: Bench lever observability — a lever must be proven on the wire, not in the settings

- **Status**: Accepted
- **Date**: 2026-07-28
- **Context**: `bench/` + `scripts/bench/run.mjs` (the lever bench), and the FT0
  fixture the fine-tune tickets test against
- **Amends**: nothing — extends `bench/SPEC.md` §2 (step table) and §5 (exit table)

## Context

The bench measures six levers by diffing a lever arm's request #1 against the
witness's. Its integrity guards (step 19) check that the knob *took*: the arm's
bytes differ from the witness's, and the lever's sentinel is present in the witness
and absent in the arm.

FT0 (#70) committed a witness capture that passed every guard the bench ran, and
carried **zero MCP tools**. The L4 lever was measuring the removal of nothing, and
had been for as long as the bench existed. Three defects had to line up:

1. A project-scoped `.mcp.json` server stays at `⏸ Pending approval` under
   `claude -p`. No arm enabled it, so the stub never connected.
2. Step 11's `system/init` pre-flight — the one guard that inspects the config dir
   before spending — **cannot see this**. It is emitted *before* the MCP handshake
   (so the server reads `pending` whether or not it will ever connect), and under
   `ENABLE_TOOL_SEARCH` the stub's tools are deferred, so they never appear in
   `event.tools` either. Both of its sensors are structurally blind here.
3. Step 19 would have caught it — but it is a **no-op for the witness** (`lever ==
   null` returns early), and the witness is exactly what a fixture is copied from.
   Only running `arm-04` would have surfaced it, and nobody had.

The lesson generalises past MCP: **a lever declared in `settings.json` is not a
lever observed on the wire**, and the bench had no guard on that gap for the one arm
that every other arm is measured against.

## Decision

1. **D1 — the regime is pinned on all 8 arms, not just where a lever needs it.**
   `enabledMcpjsonServers: ["stub"]` joins `ENABLE_TOOL_SEARCH=true` as regime, not
   lever. §1 already required `env` to be identical across arms; settings that
   merely make a lever *observable* are the same kind of thing. `KNOWN_SETTINGS_KEYS`
   gains the key, so the manifest's fail-closed pre-flight still rejects typos.

   **Rejected: enabling it only on the L4 arm.** L4 is expressed by *disabling* the
   server, so the arm that must have it enabled is every *other* arm — above all the
   witness. Enabling it narrowly is what produced the bug.

2. **D2 — a new fatal step 11b, `claude mcp list`, on the config dir the live run
   will use.** Zero tokens: the command performs the handshake and reports the
   outcome, without a POST. Every fixture-declared server must be `✔ Connected`,
   except the ones the arm deliberately disables — for those, *connected* means the
   lever did not take. Verified empirically: `disabledMcpjsonServers` wins over
   `enabledMcpjsonServers`, dropping the server from the listing entirely.

   **Rejected: extending step 11.** Its evidence is one `system/init` event that
   provably predates the answer. A second probe with a different instrument is the
   honest shape, so `probeClaude` now carries the shared dead-port idiom and each
   step keeps its own sensor.

3. **D3 — the guard runs for the witness too.** Unlike step 19, 11b has no
   `lever == null` early return. The witness is the reference; a broken reference
   silently corrupts all six measurements *and* every fixture copied from it.

4. **D4 — the sentinel is the on-wire spelling, read from the fixture.** The wire
   carries `mcp__<server>__<tool>`, never the bare `t00` the stub declares — §10.4's
   open question, closed by a paying run. `/\bt00\b/` could never have matched it
   (`_` is a word character, so the boundary never lands), in the bench's own
   sentinels or in the FT0 gate. The server name is read from
   `bench/fixture/.mcp.json` rather than written into the guard.

5. **D5 — the remaining gap is a ticket, not a workaround (#78).** Even connected,
   MCP tools do not reach the wire before **turn 3**: turns 1–2 carry `The following
   MCP servers are still connecting`. The manifest pins `turns: 2` and the lever diff
   reads request #1, so `arm-04` is currently unrunnable. Closing it means either
   lengthening the canonical prompt and **re-baselining** every byte figure in §3/§4,
   or declaring L4 unmeasurable under `-p` — a §0 regime decision. Per §4 ("s'il
   manque une donnée au banc, c'est un ticket produit — pas un contournement"), no
   workaround is applied; §3 carries a ⚠ caveat pointing at #78.

6. **D6 — the FT0 fixture is 6 turns because of D5.** A 2-turn capture *cannot*
   carry the L4 lever, so the committed fixture was driven by a multi-tool-call
   prompt rather than the manifest's canonical one. It is a genuine bench-routed
   capture (proxy route, witness config dir, materialized fixture, real OAuth,
   `claude-haiku-4-5-20251001`), and it is not the canonical witness. The divergence
   is recorded in `test/fixtures/finetune/README.md`, next to the recipe.

## Consequences

- **+** The failure that shipped a lever-incomplete fixture is now fatal at zero
  cost, before step 12 spends anything.
- **+** The fine-tune gates (`test/finetune-fixture.test.js`,
  `finetune-system.test.js`, `finetune.test.js`) went from *self-skipping* to
  *actively constraining*. That is what made the AFK run on #72 meaningful rather
  than vacuously green.
- **−** Step 11b costs a second `claude` spawn per arm (~30 s wall-clock, no tokens).
  Accepted: it is bounded, and it is the only sensor that can see this class of bug.
- **−** `claude mcp list` output is a human-facing CLI string, matched with
  `/Connected/i`. A glyph or wording change upstream would need `parseMcpHealth`
  updated. Accepted over parsing nothing at all; the parse is one exported pure
  function with its own tests.
- **−** The bench's own arms remain **unmeasurable for L4** until #78 is decided.
  This ADR makes that visible instead of silently green — which is the point — but it
  does not fix it.
- **−** Landing the fixture required the pre-existing FT0 integration gate to be
  fixed too (`root: test/fixtures` → `root: test/fixtures/finetune`): it passed the
  session dirs' *grandparent*, so that gate could never have passed whatever fixture
  landed. Unrelated defect, unavoidable in the same change.

## References

- `scripts/bench/run.mjs` — `probeClaude`, `fixtureMcpServerNames`, `parseMcpHealth`,
  `assertMcpjsonServersTook`, `mcpHealthList`, and `leverSentinels`' L4 branch
- `bench/SPEC.md` — §2 step 11b, §3 L4 row + ⚠ caveat, §5 exit table
- `test/fixtures/finetune/README.md` — what the committed fixture is, and how to land
  another one
- [#78](https://github.com/ledahu05/ccsnoop/issues/78) — L4 unmeasurable on request #1
- [#70](https://github.com/ledahu05/ccsnoop/issues/70) (FT0), [#72](https://github.com/ledahu05/ccsnoop/issues/72) (FT2, the first AFK ticket to test against the fixture)
