# The tuning bench — a beginner's on-ramp

**The tuning bench measures whether the things you can turn off in Claude Code
actually shrink what it sends to Anthropic — and by how much.**

It is a developer/maintainer tool, not a `ccsnoop` command. If you only just
installed ccsnoop to snoop one session, you do not need this. Read it if you
want to understand *how much* of your context window each tuning lever is
costing you, or if you want to run the comparison yourself.

This page is the friendly introduction. For the locked, every-detail contract —
which exit code means what, the exact `diff.json` schema, the 21-step sequence —
see **[SPEC.md](SPEC.md)**. The map that produced it is
[issue #46](https://github.com/ledahu05/ccsnoop/issues/46).

---

## Contents

1. [What it is](#1-what-it-is)
2. [The idea in one picture](#2-the-idea-in-one-picture)
3. [Should you run it? (cost & prerequisites)](#3-should-you-run-it-cost--prerequisites)
4. [Quickstart — the happy path](#4-quickstart--the-happy-path)
5. [The eight arms and the six levers](#5-the-eight-arms-and-the-six-levers)
6. [Reading the output](#6-reading-the-output)
7. [What it does *not* do](#7-what-it-does-not-do)
8. [Going deeper](#8-going-deeper)

---

## 1. What it is

Every time Claude Code talks to Anthropic, the request carries far more than
your message: the system prompt, the full list of tools, the contents of files
it read, and so on. Most of that is "injection" — stuff Claude Code adds on your
behalf. Some of it you can turn off (deny a tool, drop a hook, exclude a
`CLAUDE.md`, disable an MCP server, switch off bundled skills, trim your own
agent types). Those switches are the **levers**.

But does flipping a lever *actually* make the request smaller? And by how much?
Hand-guessing is unreliable: denying one tool can make Claude Code substitute
another, so the net change is not the size of the tool you removed. The tuning
bench answers the question **with numbers**: it runs the same task with each
lever off, one at a time, captures the real traffic through ccsnoop, and
compares it byte-for-byte and token-for-token against the un-tuned baseline.

In plain words, the bench:

- spins up isolated, throwaway environments (it never touches your real Claude
  Code config),
- runs the **same** short task once per configuration, through the ccsnoop
  proxy, capturing the real requests,
- measures how big each request is (split into System / Tools / Message history
  / Current turn) and how the cache behaves, and
- prints a comparison table so you can read, per lever: *"turning this off saved
  this many bytes (and this many cache tokens)."*

It is a **measurement** bench, not a test suite. It will happily report that a
lever saved nothing — that is a valid result, not a failure.

## 2. The idea in one picture

```
                      one fixed task ("read FIXED.txt, reply with its first word")
                                      │
   ┌──────────────┬───────────────────┼───────────────────┬──────────────┐
   ▼              ▼                   ▼                   ▼              ▼
 arm-00        arm-01              arm-02              … arm-06        arm-07
 witness       tools off           hooks off              agents off    everything off
 (baseline)                                                                     (all levers)
   │              │                   │                   │              │
   └──────────────┴───────────┬───────┴───────────────────┴──────────────┘
                              ▼
                  ccsnoop captures each run, then `diff`
                  compares every arm back to the witness.
```

Two words you will see everywhere:

- **Witness** — the un-tuned baseline (`arm-00`). Every other arm is compared
  *to this one*. All arms carry the same minimum setup, so the only thing that
  differs is the single lever being tested.
- **Lever** — one of the six things you can turn off (tools, hooks, `CLAUDE.md`,
  MCP servers, bundled skills, your own agent types). Each lever gets one arm.

## 3. Should you run it? (cost & prerequisites)

**The bench spends real API tokens and copies your Claude Code credentials into
throwaway directories.** It is not free, and it is not a casual command.

- **Cost.** Each arm is one short task (about two requests). At the pinned model
  (`claude-haiku-4-5-20251001`) that is roughly **≈ $0.05 per arm**, so a full
  run of all eight arms is **≈ $0.40**. `diff` and `teardown` cost nothing — they
  only read or delete files on disk. (Derived in [SPEC.md §8](SPEC.md).)
- **Credentials.** To run a real session the bench copies
  `~/.claude/.credentials.json` (read-only `0600`) into each arm's throwaway
  config dir and deletes it again when the arm finishes. It never writes to your
  real `~/.claude/` or your real `~/.ccsnoop/` routes.
- **Prerequisites.**
  - **Node.js 22+** (same as ccsnoop).
  - **ccsnoop installed** (`npm install -g .` from a clone, or run the CLI from
    `bin/ccsnoop.js`).
  - The **`claude` CLI**, logged into a **claude.ai account** (a subscription —
    not an `ANTHROPIC_API_KEY`, which disables some of the very things the bench
    measures).
  - **No need to install the bench itself** — it is a plain script at
    `scripts/bench/run.mjs`, checked into this repo. (It is deliberately *not*
    shipped to npm.)

> **Cheapest possible start:** the next section opens with `--infra-only`, which
> runs the setup with **zero tokens spent**. Use it to confirm your environment
> works before you pay for a real arm.

## 4. Quickstart — the happy path

Four moves: confirm the setup for free, capture a baseline, capture a lever,
compare, then clean up.

### Step 0 — smoke-test the setup (free)

`arm --infra-only` runs only the shared setup (start the proxy, materialize the
fixture, wire the route) and stops short of spending any tokens:

```console
$ node scripts/bench/run.mjs arm arm-00 --infra-only
bench arm arm-00: run /tmp/ccsnoop-bench/2026-07-26T10-00-00Z
  ANTHROPIC_BASE_URL=http://127.0.0.1:41377/…
  ENABLE_TOOL_SEARCH=true
  (--infra-only: steps 8–21 skipped, no tokens spent)
  teardown: node scripts/bench/run.mjs teardown /tmp/ccsnoop-bench/2026-07-26T10-00-00Z
```

*What just happened:* the bench started an isolated ccsnoop daemon, copied the
frozen fixture out to a throwaway directory, and verified the proxy is reachable
from a spawned child — all the plumbing a real run needs, without the bill. If
this fails, fix it here, while it is still free.

### Step 1 — capture the witness (the baseline)

Drop `--infra-only` to run the real task. Start with `arm-00`, the witness:

```console
$ node scripts/bench/run.mjs arm arm-00
bench arm arm-00: run /tmp/ccsnoop-bench/2026-07-26T10-00-00Z
  …
  session: <session-id> (2 exchanges)
  capture: …/arm-00/capture
  arm.json: …/arm-00/arm.json
```

*What just happened:* the bench ran the fixed task once, un-tuned, and stored the
captured session plus a parsed model of it under `…/arm-00/`. Note the **run
directory** printed on the first line — the comparison needs it.

### Step 2 — capture a lever arm

Run any other arm in the **same** run directory (just pass a different id; the
bench reuses the setup already in place):

```console
$ node scripts/bench/run.mjs arm arm-01
bench arm arm-01: run /tmp/ccsnoop-bench/2026-07-26T10-00-00Z (reused)
  …
```

*What just happened:* the bench ran the *same* task again, this time with the L1
lever on (one tool denied), reusing the same proxy and fixture so the only
difference is the lever.

### Step 3 — compare (free)

`diff` re-reads the whole run directory from disk and writes a `diff.json` plus a
human-readable table. It costs nothing:

```console
$ node scripts/bench/run.mjs diff /tmp/ccsnoop-bench/2026-07-26T10-00-00Z
…a table, one row per lever, delta vs the witness…
…plus a “degraded” banner at the top if the cache axis was unavailable…

diff.json: /tmp/ccsnoop-bench/2026-07-26T10-00-00Z/diff.json
```

*What just happened:* the bench computed, for each lever arm present, how its
captured request differs from the witness — in bytes per bucket and in cache
tokens. You can read the table in the terminal or open `diff.json` for the exact
numbers (see [Reading the output](#6-reading-the-output)).

### Step 4 — clean up

```console
$ node scripts/bench/run.mjs teardown /tmp/ccsnoop-bench/2026-07-26T10-00-00Z
bench teardown: /tmp/ccsnoop-bench/2026-07-26T10-00-00Z removed
```

*What just happened:* the bench stopped the isolated daemon, undid the route it
added, scrubbed the copied credentials, and deleted the throwaway run directory.

> **Keeping a run.** By default a run lives under your temp directory and is
> thrown away at teardown. To *keep* one, copy or move it into `bench/runs/`
> before teardown (that path is gitignored, so captures are never committed by
> accident). The full layout is in [SPEC.md §6](SPEC.md).

## 5. The eight arms and the six levers

The arms are declared in **[manifest.json](manifest.json)** — one entry each.
Every arm is the witness plus *one* change (except the last, which is all of
them at once).

| Arm     | What it turns off                 | The lever | How |
| ------- | --------------------------------- | --------- | --- |
| `arm-00`| — (the witness / baseline)        | —         | nothing; this is what the others compare to |
| `arm-01`| one built-in tool                 | **L1 tools**    | `permissions.deny` a tool the witness actually sends |
| `arm-02`| the session-start hook            | **L2 hooks**    | empty out `hooks.SessionStart` |
| `arm-03`| the project `CLAUDE.md`           | **L3 CLAUDE.md**| `claudeMdExcludes: ["CLAUDE.md"]` |
| `arm-05`| Claude Code's bundled skills      | **L5 skills**   | `disableBundledSkills` |
| `arm-06`| your own agent types              | **L6 agents**   | a "bare" config dir with no added agents |
| `arm-07`| all five at once                  | **all**         | every lever + the bare seed |

Three things that often surprise beginners (all explained in [SPEC.md
§3](SPEC.md)):

- **There is no MCP arm, on purpose.** The fixture *does* declare a 64-tool MCP
  stub, and the bench checks it connects — but `claude -p` sends its first
  request before the MCP handshake finishes, so those tool names only reach the
  wire on turn 3, and the lever diff reads request #1. Measuring L4 would mean
  lengthening the canonical prompt and re-measuring every byte figure in the
  spec, so it was dropped instead
  ([#78](https://github.com/ledahu05/ccsnoop/issues/78), SPEC.md §9). The MCP
  lever still exists in the *product* (`ccsnoop fine-tune`), just not here.
- **Agents are measured by *count*, not bytes.** Your agent types go across as a
  short deferred *list of names*, so their cost scales with *how many* there
  are, not their description size. The table prints the declared count (8
  agents) next to the delta so you don't misread "small" as "unimportant".
- **The witness is *minimal but not empty*.** It carries the hook declaration,
  because without it the hooks lever could not be measured. Each arm is the
  witness *minus one thing*.
- **Lever savings are a *net* delta.** Denying one tool can make Claude Code send
  a different one in its place, so the number you see is never simply "the size
  of the thing I removed".

## 6. Reading the output

Two views, **one source**: `diff` writes a canonical `diff.json`, then derives
the terminal table from that same object (it never recomputes). Read the table
for a quick look; read `diff.json` for exact numbers.

- **Per-lever row** — for each lever, the net byte change versus the witness,
  split by bucket (System / Tools / Message history / Current turn). Negative is
  smaller, i.e. a saving. A `substitutions` line lists any slot that *appeared*
  in this arm but not the witness (the "it sent something else instead" effect).
- **Cache tokens** — read on turn 2 (the steady state). Turn 1's `cacheCreation`
  is the one-off "transition cost" of writing the prefix; it is shown on its own
  line and is **never** subtracted from the saving.
- **Interaction line** — because lever savings are net deltas, they don't add up
  cleanly: the sum of the six single levers versus the "all" arm is reported as
  an explicit "interaction" line, not silently absorbed.
- **Degraded banner** — if the cache axis could not be measured for a run, the
  table carries a banner at the top and the token fields are omitted (never
  shown as zero). The byte axis is always present.
- **Provenance** — `provenance.json` records the Claude Code build, the ccsnoop
  version, the port, and the timestamp. A run without its Claude Code version is
  not comparable to another, because a new build can shift content without
  changing the byte count.

> **Exit codes.** The bench is a measurement tool: it exits non-zero only when
  the *measurement itself* is broken (a malformed manifest, the proxy
  unreachable, a lever that silently didn't take, no gzip where gzip was
  expected). It exits **0** even if a lever saved nothing or saved a negative
  amount — that is an honest result. The full table of exit causes is
  [SPEC.md §5](SPEC.md).

## 7. What it does *not* do

Naming the limits up front, so an absence is not mistaken for a bug (full list
in [SPEC.md §9](SPEC.md)):

- **It is not a CI regression suite.** It needs real credentials and spends real
  tokens, so it lives outside the published package.
- **It does not assert thresholds.** "Lever X must save ≥ N bytes" would break on
  the next Claude Code build; the bench reports numbers, it does not gate on
  them.
- **It does not decide what counts as "waste" or price a cache write.** Those are
  separate concerns ([#29](https://github.com/ledahu05/ccsnoop/issues/29),
  [#36](https://github.com/ledahu05/ccsnoop/issues/36)); the bench measures and
  compares, it does not redefine them.
- **It does not test the off-nominal paths live.** Those are already covered by
  the unit tests; re-running them through the bench would pay a session to
  re-prove something free.
- **It does not run arms in parallel** (yet) — a credential-refresh question is
  still open, so arms run sequentially.

## 8. Going deeper

- **[SPEC.md](SPEC.md)** — the locked contract: the 21-step arm sequence, the
  full `diff.json` schema, the consolidated exit-code table, the budget, and the
  named non-goals. Read this before changing the bench.
- **[manifest.json](manifest.json)** — the eight arms, declared as data (this is
  how you would add or retarget an arm).
- **`scripts/bench/run.mjs`** — the bench itself. A dev script; the three
  subcommands are `arm`, `diff`, and `teardown`.
- **The map:** [issue #46](https://github.com/ledahu05/ccsnoop/issues/46)
  (the eight resolutions B1–B8 that produced this spec) and
  [issue #67](https://github.com/ledahu05/ccsnoop/issues/67) (this on-ramp).
