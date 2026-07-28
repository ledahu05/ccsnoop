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

1. **D1 — the regime is pinned on every arm, not just where a lever needs it.**
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

## Amendment — D5 settled: L4 is declared unmeasurable (#78, 2026-07-28)

D5 left the turn-3 race open as a ticket rather than a workaround. The ticket is now
decided, and the decision is **option 2: L4 leaves the arm set.** `arm-04` is deleted
from `bench/manifest.json`, `disabledMcpjsonServers` is dropped from `arm-07`,
`leverSentinels` declares no L4 sentinel, and the lever joins `bench/SPEC.md` §9 as a
named non-objective — right beside its own "claude.ai connectors" half, which had
already been abandoned there for a different reason. The bench is 7 arms, 14 real
requests, ≈ $0,35 a run.

**Why option 1 was rejected.** Lengthening the canonical prompt so the invocation lives
past turn 3 is a §0 regime change, and §3/§4's byte figures are all measured on the
current prompt (B2). Taking it would mean re-baselining every one of them inside a
fresh paying campaign — a real cost, paid to weigh a lever whose *product* side is
delivered elsewhere.

**The corollary, stated plainly: #74 (FT4) ships an MCP lever the bench can no longer
weigh.** `ccsnoop fine-tune` will recommend `disabledMcpjsonServers` on the strength of
`Segment.bytes` over real captures and its own `sessionCount >= 3 AND calledCount == 0`
guard — never on the strength of an arm delta. That is a weaker footing than the other
five levers enjoy, and it should be read as such. The B2 benchmark of 22 919 o stays in
§3 as an **upstream** measurement shared by L2/L3/L4; it was never a bench measurement.

**What deliberately did not change.** `bench/fixture/.mcp.json`, the 64-tool stub, and
`enabledMcpjsonServers` on every remaining arm all stay: D1 made them *regime*, and the
committed FT0 fixture needs MCP on the wire for #74's AC #1 to be satisfiable at all.
Step 11b stays **fatal** — it is still the only sensor that distinguishes a connected
stub from a `⏸ Pending approval` one. Its "deliberately disabled ⇒ must not be
connected" branch is now unexercised by the manifest; it keeps its unit test, because an
untested branch is exactly how the original L4 hole survived.

## References

- `scripts/bench/run.mjs` — `probeClaude`, `fixtureMcpServerNames`, `parseMcpHealth`,
  `assertMcpjsonServersTook`, `mcpHealthList`, and `leverSentinels`' L4 branch
- `bench/SPEC.md` — §2 step 11b, §3 L4 row + ⚠ caveat, §5 exit table
- `test/fixtures/finetune/README.md` — what the committed fixture is, and how to land
  another one
- [#78](https://github.com/ledahu05/ccsnoop/issues/78) — L4 unmeasurable on request #1
- [#70](https://github.com/ledahu05/ccsnoop/issues/70) (FT0), [#72](https://github.com/ledahu05/ccsnoop/issues/72) (FT2, the first AFK ticket to test against the fixture)
