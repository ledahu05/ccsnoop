---
name: context-tuning
description: Tune this repo's Claude Code context — measure what each session ships, trim it, and prove the trim worked. Drives ccsnoop's loop (capture → diagnose → apply → verify). Triggers on "tune my context", "trim context window", "apply ccsnoop fine-tune", "lower my floor", "context tuning", "what's wasting my context".
---

# Context tuning — drive ccsnoop's tuning loop over this repo

You are a **thin orchestration layer over ccsnoop**. ccsnoop is the instrument — it
captures and diagnoses. You drive it: you do **not** re-measure, re-derive lever
verdicts, or re-implement the apply/verify math. Every consequential action is a
`ccsnoop` CLI call. Your value is the *loop* and the *guided entry* into it.

The loop, in one line:

**capture a representative session → diagnose → apply (tiered) → verify by re-capture.**

## Before anything else: the bootstrap gate

ccsnoop can be in one of four states. **Always run the bootstrap detector first** —
never assume capture is working. It is a standalone script that ships with this
skill and runs in any repo with the `ccsnoop` CLI on PATH:

```console
$ node .claude/skills/context-tuning/scripts/bootstrap.mjs --json
```

Read `state` from the JSON. **Point, never execute installs** — you do not run
`npm install`, you do not run package managers, you do not start long-lived
services on the user's behalf without their say-so. You tell the user the exact
command and wait.

| `state` | What it means | What you do |
| ------- | ------------- | ----------- |
| `absent` | ccsnoop is not on PATH | Show the install steps from the skill README. **Stop.** Do not run the install. |
| `daemon-down` | Installed, capture daemon stopped | Tell the user to run `ccsnoop start`, then re-run the gate. |
| `un-init` | Daemon up, but this repo isn't wired for capture | Tell the user to run `ccsnoop init`, then **restart Claude Code** (the cached `ANTHROPIC_BASE_URL` only clears on restart), then re-run the gate. |
| `ready` | Up + this repo's route is registered | **Enter the loop below.** |

The detector reads **only** `ccsnoop --help`, `ccsnoop status`, and
`~/.ccsnoop/routes.json` — never capture bodies. Re-run it after each fix the user
applies, until `ready`.

## The loop

### 1. Capture a representative session

A diagnosis is only as good as the session behind it. Ask the user to do **real
work** in Claude Code — the kind that bloats context: a feature, a refactor, a
debugging session with subagents. ccsnoop captures it in the background (the daemon
+ `init` did the wiring). You cannot manufacture a representative session by
talking to yourself; the user works, you wait.

Capture is **on by default** once `init` + restart are done — there is no
`ccsnoop capture` command to run. Just remind the user: work normally, then come
back.

The bootstrap detector's `--json` reports where captures land (`captureDir`, e.g.
`<repo>/.ccsnoop`) and the matched `routeToken`. Tell the user the `captureDir` (it
is also the session root you'll pick verify's `--before`/`--after` ids from later).

### 2. Diagnose — `ccsnoop fine-tune --json`

This is the skill's primary input: the machine-readable contract (the `#95`
`tuning-report/v1` schema). Emit it to a file you consume:

```console
$ ccsnoop fine-tune --json > report.json
```

Read `report.json`. **First check `schemaVersion` (pin `1`) and `$schema`** — if the
version is not `1`, stop and tell the user the report is from a contract version
this skill does not know; never guess at unknown fields. Then read the verdicts.

The contract partitions the verdicts into two tiers — **this is the one thing you
must get right** (see ADR-0004, summarized below):

- **`safeLevers`** (`tools`, `mcp`) — carry **dynamic proof** of waste (a tool never
  called; an MCP server shipped across ≥3 sessions and never invoked). The skill
  may **write** these on approval.
- **`adviceLevers`** (`hooks`, `claudeMd`) — **no dynamic proof** (injected every
  session by construction; cost known, disuse not). The skill **surfaces these
  paste-only — never writes them.**

The matching `settings.auto` / `settings.advice` blocks reconstruct the exact
paste-ready `settings.json` the human-facing `ccsnoop fine-tune` emits. Do not
re-derive which lever is which — read the tier from the contract.

Present the user a short, honest summary: what's recoverable (`totals.recoverable`,
a byte proxy), which tools/MCPs are provably unused (safe), and which hooks /
CLAUDE.md sources merely *cost* bytes (advice — "intent unknown"). Lead with real
tokens when available (`--include-tokens`); label every byte figure as a proxy.

### 3. Apply (tiered) — delegate to `ccsnoop apply`

**Do not merge settings yourself.** Hand the report to `ccsnoop apply`, which
implements the idempotent, strict read-modify-write merge under ADR-0004:

```console
$ ccsnoop apply --from report.json --dry-run    # show the safe-subset diff
```

Show the user the diff. The safe subset is `permissions.deny` (uncalled built-in
tools) and `disabledMcpjsonServers` (unused MCP servers). On **explicit user
approval only**, write it:

```console
$ ccsnoop apply --from report.json --yes
```

Then surface the **advice** levers (`settings.advice`: hooks, `claudeMdExcludes`)
as a **paste-ready block** — `ccsnoop apply` prints it. You may explain them, but
you do not write them. The user pastes what they want, by hand.

After any write: **remind the user to restart Claude Code.** Settings changes
recompile the shipped tool set next session.

### 4. Verify — `ccsnoop verify` (prove the floor moved)

Without verify, this is guesswork, not tuning. After the restart and a fresh
capture of the *same kind of work*, pair the two sessions as one **tuning session**
(you pick the two ids — ccsnoop emits the pairing, it does not decide it):

```console
$ ccsnoop verify --before <pre-tuning-session-id> --after <post-tuning-session-id> --json
```

The headline delta is **real turn-1 `usage` tokens**; the per-block delta is a
labelled byte proxy. Read `delta.verdict` (`lowered` / `raised` / `flat`) and report
it plainly. If the floor did not move, say so — then re-diagnose the *after*
capture and iterate. Verify is the unit of *"did this tuning actually work?"*

## Authority model (ADR-0004 — the one-page version)

The tiers are a property of the **evidence**, not a policy knob:

- **Safe tier** (dynamic proof → auto-writable on a presented diff + explicit
  approval): `permissions.deny`, `disabledMcpjsonServers`.
- **Advice tier** (no proof → paste-only, **never** written): `hooks.SessionStart`,
  `claudeMdExcludes`.

You never write blind: a diff is shown, and only `--yes` writes. Applying twice is
identical to applying once (idempotent merge; foreign keys refused; `.ccsnoop/`
never touched).

## Redaction discipline (spec §1.3 — non-negotiable)

`.ccsnoop/sessions/<id>/` holds **raw, redacted HTTP bodies** — API key scrubbed,
but full conversation content. It is inviolable:

- **Never `cat`, `Read`, print, paste, or transmit a capture file** (`.request.http`
  / `.response.sse` / `manifest.jsonl`). Not to the user, not to yourself, not to a
  tool.
- Consume **only** aggregate, derived outputs: `ccsnoop fine-tune --json`,
  `ccsnoop verify --json`, and the human-facing diagnostics. These carry byte/token
  sums and tool *names* — never conversation content.
- Never commit `.ccsnoop/` (it is gitignored by `init`; keep it that way).

## When you don't have enough

- **Too few sessions** for the MCP guard (`sessionCount < 3`): the MCP lever is
  `flag-only`, never `deny`. Tell the user to capture more sessions; do not invent a
  deny verdict.
- **Single-session scope** (`--session` / `--latest`): MCP deny is intentionally
  off. Use the corpus default for tuning decisions.
- **No captured usage** on a side: `verify`'s token delta is `null` and the verdict
  falls back to the byte proxy (`basis: "bytes"`). Disclose that.

## See also

- `ccsnoop --help` — the surfaces you drive (`fine-tune`, `apply`, `verify`).
- `docs/tuning-report-schema.md` (in the ccsnoop repo) — the full `#95` contract.
- ADR-0004 — the two-tier authority this skill enforces.
- The skill README — install + the standalone bootstrap script.
