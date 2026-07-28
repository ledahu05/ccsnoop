# Fine-tune fixtures (`test/fixtures/finetune/`)

A committed **real captured Claude Code session** lives here, one directory per
session: `session-<id>/` containing `manifest.jsonl` + per-turn `NNNN.request.http`
+ `NNNN.response.sse` (gzip). This is the substrate the downstream fine-tune
tickets (T1–T7, `docs/fine-tune-spec.md`) test against.

## Status — issue #70 (FT0): landed

`session-963204f5-937b-4a13-b658-f1cbffd21421/` — **6 exchanges**, lever-complete,
produced through the bench on a host with claude.ai OAuth (proxy route → the
witness's isolated `CLAUDE_CONFIG_DIR`, materialized `bench/fixture/` cwd,
`claude-haiku-4-5-20251001`, `ENABLE_TOOL_SEARCH=true`). Turn 1 carries all four
levers; turn 6 carries none of the response-side `tool_use`, which is what makes
the fixture exercise both branches.

The acceptance criteria (AC #1–#4) are encoded as a self-activating gate in
`test/finetune-fixture.test.js`: it self-skips while this dir has no `session-*`
entry, then auto-validates any committed fixture (four levers, a `tool_use`
response, scrubbed headers/paths).

### Why the first attempt shipped lever-incomplete — and why this one has ≥3 turns

The first capture passed for the persona and CLAUDE.md sentinels but carried
**zero MCP tools**, and nothing complained. Two independent defects:

1. A project-scoped `.mcp.json` server stays at `⏸ Pending approval` under `-p`.
   No arm enabled it, so the stub never connected at all. Fixed by pinning
   `enabledMcpjsonServers` on all 8 arms and by bench **step 11b**, which runs
   `claude mcp list` (zero tokens) and refuses a run whose fixture server is not
   connected. Step 11's `system/init` is blind to this: it is emitted *before* the
   MCP handshake (status always `pending`) and `ENABLE_TOOL_SEARCH` defers the
   stub's tools out of `event.tools`.
2. **Even connected, the MCP tools do not reach the wire before turn 3.** Turns 1
   and 2 carry `The following MCP servers are still connecting … not yet
   available: stub`; from turn 3 on, all 64 appear. A 2-turn capture therefore
   *cannot* carry the L4 lever — which is why this fixture was captured with a
   multi-tool-call prompt rather than `bench/manifest.json`'s canonical 2-turn
   one.

⚠ **Consequence for the bench, still open.** `bench/manifest.json` pins
`turns: 2` and the lever diff reads **request #1**, so `arm-04`'s L4 sentinel can
never be present in the witness: L4 measures the removal of nothing. Step 11b
catches an unconnected server but not this race. Resolving it means either giving
the canonical prompt enough turns (and re-baselining every byte figure in
`bench/SPEC.md` §4) or declaring L4 unmeasurable under `-p`.

The on-wire spelling of a stub tool is **`mcp__stub__t00`**, not the bare `t00`
the stub declares — §10.4's open question, closed by this paying run. The old
`/\bt00\b/` marker could never match (`_` is a word char, so the boundary never
lands), in this gate or in the bench's own lever sentinels.

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

1. `node scripts/bench/run.mjs arm arm-00` — stands up the proxy route and the
   witness config dir, and its **step 11b** proves the `.mcp.json` server connects.
   ⚠ Its own 2-turn capture is *not* usable as a fixture: MCP tools land only from
   turn 3 (see above). Drive a multi-tool-call prompt against the same run dir and
   config dir, and take that session instead.
2. Copy the session dir → `test/fixtures/finetune/session-<id>/`.
3. Verify redaction (spec §1.3 / §3.3): denylist headers are `‹REDACTED›`, no
   `/tmp/ccsnoop-bench/…` paths in `manifest.jsonl`.
4. `npm test` — the gate activates and must pass.
