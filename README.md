# ccsnoop

**ccsnoop records the raw requests Claude Code sends to Anthropic and the raw
responses it gets back, then turns one session into a single HTML page you can
open in a browser.**

It is a debugging and learning tool. If you have ever wondered *"what is Claude
Code actually sending on my behalf?"* or *"why did this session eat so much of my
context window?"*, ccsnoop shows you — byte for byte.

---

## Contents

1. [What it is](#1-what-it-is)
2. [How it works](#2-how-it-works)
3. [Install](#3-install)
4. [Quickstart](#4-quickstart--the-happy-path)
5. [Diagnostics](#5-diagnostics)
6. [Turning it off / undoing](#6-turning-it-off--undoing) ← **read this before you start**
7. [Command reference](#7-command-reference)
8. [Concepts](#8-concepts)
9. [Troubleshooting](#9-troubleshooting)
10. [Privacy & safety](#10-privacy--safety)
11. [The context-tuning skill](#11-the-context-tuning-skill)

---

## 1. What it is

Every time you use Claude Code, it makes network requests to Anthropic's API. Those
requests contain a lot more than your typed message — the system prompt, the list
of tools, the contents of files it read, the whole conversation so far. ccsnoop
sits in the middle, writes each request and response to disk exactly as they went
over the wire, and later renders them as one self-contained HTML report.

**Why you'd care — concrete things the report shows you:**

- **See exactly what Claude Code sends on your behalf** — the system prompt, the
  tool definitions, and the file contents it pastes into the conversation.
- **Understand what eats your context window** — the report charts how the request
  grows turn by turn, broken down into System / Tools / Message history / Current
  turn.
- **Spot waste** — content that gets re-sent every turn when it could have been
  cached, oversized tool results, and static blocks that never change. (These
  signals come from [`src/waste.js`](src/waste.js).)

The report shows you the waste; two more commands help you **act on it**:

- **`ccsnoop fine-tune`** — points at the recoverable bytes (unused tools, idle MCP
  servers, heavy hooks, excludable CLAUDE.md files) and hands you a paste-ready
  `settings.json`. See [`docs/fine-tune.md`](docs/fine-tune.md).
- **`ccsnoop cache`** — for each turn where the prompt cache went cold, explains
  *why* it expired, *what it cost*, and *what to do differently*. See
  [`docs/cache.md`](docs/cache.md).
- **`ccsnoop lifetime`** — surfaces compaction as a first-class signal: *how many
  turns / minutes* the context window lasted before it was first compacted, and *how
  many bytes* each compaction dropped.
- **`ccsnoop isolate`** — quantifies **subagent context isolation**: how much context
  ran in subagent threads (isolated from — and discarded by — the main window) vs the
  main thread, with an *if-inlined* counterfactual. Recommends routing context-heavy
  exploration to subagents when the isolation paid off.

**What it is *not*:**

- **Not a Claude Code plugin.** ccsnoop is a separate command-line program. It does
  not hook into Claude Code's internals; it just gets pointed at a local address.
- **Not a hosted service.** There is no account, no cloud, no upload.
- **No data leaves your machine.** The proxy listens on `localhost` (your own
  computer, not the network) and writes plain files to disk. Nothing is sent
  anywhere except the normal Anthropic request Claude Code was already making.

> **Reverse proxy** (used a few times below): a small local program that Claude
> Code talks to instead of talking to Anthropic directly. It records the traffic,
> then forwards it on to Anthropic unchanged. You point Claude Code at it with one
> setting; there is no interception or certificate trickery.

---

## 2. How it works

```
  Claude Code ──http──▶  ccsnoop daemon  ──https──▶  api.anthropic.com
                         (on localhost)   │
                                          ▼
                            <your repo>/.ccsnoop/sessions/<id>/
                              (raw request + response bytes)

  then, offline:  ccsnoop report · fine-tune · cache · isolate  ──read the files──▶  HTML · settings.json · cards
```

Four lines of what happens:

1. `ccsnoop start` launches a small background program (the **daemon**) that listens
   on your own machine at `http://localhost:41377`.
2. `ccsnoop init` tells Claude Code — for one repo — to send its API traffic to that
   local address instead of straight to Anthropic.
3. As you use Claude Code, the daemon tees a copy of every request and response to
   disk, then forwards the real request to `api.anthropic.com` and streams the reply
   back untouched. Claude Code works exactly as normal.
4. `ccsnoop report` reads those saved files and renders a single HTML page. `fine-tune`
   and `cache` read the same files to prescribe savings and diagnose the cache. All
   three run offline — the daemon does not need to be running.

> For the full architecture — the proxy, redaction, path-token routing, the on-disk
> capture layout — see [`docs/spec.md`](docs/spec.md).

If your report is empty, it is almost always because step 1 or step 2 was skipped,
or because Claude Code was not restarted after `init` (see
[Troubleshooting](#9-troubleshooting)).

---

## 3. Install

**Prerequisite: Node.js 22 or newer.** Check your version:

```console
$ node --version
v22.23.1
```

If that prints something lower than `v22` (or "command not found"), install a
current Node from [nodejs.org](https://nodejs.org/) or via a version manager like
[nvm](https://github.com/nvm-sh/nvm), then check again.

**Install ccsnoop.**

> **TODO (tracking [#9](https://github.com/ledahu05/ccsnoop/issues/9)):** ccsnoop is
> not yet published to npm, so there is no `npm install -g ccsnoop` / `npx ccsnoop`
> yet. Until then, install from a clone as below. This section will be updated once
> the published package name is decided.

```console
$ git clone https://github.com/ledahu05/ccsnoop.git
$ cd ccsnoop
$ npm install -g .
```

`npm install -g .` puts a `ccsnoop` command on your `PATH`, so you can run
`ccsnoop` from any directory. If you would rather not install globally, you can run
it straight from the clone instead — everywhere this README says `ccsnoop <command>`,
use `node /path/to/ccsnoop/bin/ccsnoop.js <command>`.

**Verify the install.** `ccsnoop --help` should print the command list:

```console
$ ccsnoop --help
ccsnoop — snoop raw Claude Code ↔ Anthropic traffic

Usage: ccsnoop <command> [options]

Commands:
  init     Activate capture for the current repo (writes .claude/settings.local.json
           env, gitignores .ccsnoop/, registers the route). Restart Claude Code after.
             --force              overwrite a foreign ANTHROPIC_BASE_URL
             --undo               revert exactly what a prior init added
  start    Start the capture-proxy daemon (detached; returns immediately)
             --port <n>           listen port (persisted to ~/.ccsnoop/config.json)
             --sessions-dir <p>   capture root (default ~/.ccsnoop/sessions)
  stop     Stop the daemon (drain, then terminate). Warns about live Claude Code
           sessions still routed through it — restart those, or they'll retry on
           ConnectionRefused.
             --clean              also un-route every registered repo (init --undo for all)
  status   Report daemon status (running → exit 0, stopped → exit 1)
  report   Render a captured session to a self-contained static HTML file
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to render (default: latest)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --out <path>         output file (default <session-dir>/report.html)
             --bloat-floor <n>    bloat: absolute byte floor (default 4096)
             --bloat-multiplier <n>  bloat: sibling-outlier multiplier (default 3)
  fine-tune  Print a byte diagnostic + paste-ready settings.json (all sessions by default)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       one session (weak-evidence: no MCP deny)
             --latest             most-recent session (weak-evidence: no MCP deny)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --deny-extra <a,b>   add denylist names for this run only
             --deny-allow <a>     drop a denylist name for this run only
             --json               emit the versioned tuning-report contract (issue #95)
             --include-tokens     with --json, backfill primary-session token totals
  apply   Apply a fine-tune report's SAFE subset to .claude/settings.json (issue #98,
          ADR-0004). Presents a diff; writes only on --yes; advice levers are paste-only.
             --from <path|->     consume a captured report (file, or - for stdin)
             --root <path>       without --from, diagnose this capture root (default ./.ccsnoop)
             --sessions-dir <p>  without --from, dir holding session subdirs (overrides --root)
             --session <id>      without --from, the session to diagnose (default: latest)
             --yes               approve the safe-subset write (else diff-only)
             --dry-run           print the diff without writing
             --settings <path>   override the target settings.json (default ./.claude/settings.json)
  cache   Cache-economy diagnostic for one captured session (per-transition cards + rollup)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to diagnose (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --ttl <seconds>      TEMPORAL threshold (default 3600 = 1 h)
             --html               render the same data as a self-contained HTML document
  floor   Turn-1 baseline metric + ranked per-block attribution (the default context window)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to score (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --window <tokens>    context window for the headline % (default 200000)
  lifetime  Effective context-lifetime metric for one captured session (compaction count,
           turns/wall-time to the first compaction, per-event bytes-dropped)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to diagnose (default: latest)
             --latest             most-recent session (same as the default; no corpus mode)
             --html               render the same data as a self-contained HTML document
  isolate Subagent context-isolation for one captured session (isolated vs main + counterfactual)
             --root <path>        capture root (default ./.ccsnoop)
             --sessions-dir <p>   dir holding session subdirs (overrides --root)
             --session <id>       session to analyze (default: latest)
             --threshold <f>      isolation ratio that fires the reco, in [0,1] (default 0.25)
             --html               render the same data as a self-contained HTML document
  verify  Before/after floor delta for two captured sessions (a tuning session): did the
          tuning lower the turn-1 floor, and by how much? Computes floor (#99) on each
          side and diffs. A pure offline reader of sessions/; the daemon is not required.
             --before <id>       the baseline session (required)
             --after <id>        the tuned session (required)
             --root <path>       capture root (default ./.ccsnoop)
             --sessions-dir <p>  dir holding session subdirs (overrides --root)
             --window <tokens>   context window for the headline % (default 200000)
             --json              emit the versioned tuning-session contract (kind: tuning-session)
  skill   The publishable context-tuning skill (#97, epic #94). Installs into this repo's
          .claude/skills/ so it drives ccsnoop's capture → diagnose → apply → verify loop.
             install             copy the bundled skill into .claude/skills/context-tuning/
             --force             overwrite files that differ from the bundle (default: refuse)
```

---

## 4. Quickstart — the happy path

Five steps: start the recorder, point one repo at it, use Claude Code, make the
report, read it.

### Step 1 — start the daemon

```console
$ ccsnoop start
ccsnoop start: pid 304, port 41377
```

*What just happened:* a background recorder is now listening on
`http://localhost:41377`. It keeps running after the command returns — that is why
you get your prompt back immediately. Its settings live in `~/.ccsnoop/config.json`
(this is where the port `41377` is remembered). Check on it any time with
`ccsnoop status`:

```console
$ ccsnoop status
running — pid 304, port 41377, 0 routes, up 12s
```

### Step 2 — activate capture for your repo

Go to the project you want to snoop and run `init`:

```console
$ cd ~/code/my-project
$ ccsnoop init
ccsnoop init: capturing /home/you/code/my-project
  route eb1caa31 → /home/you/code/my-project/.ccsnoop/sessions/
  ANTHROPIC_BASE_URL=http://localhost:41377/eb1caa31, ENABLE_TOOL_SEARCH=true → /home/you/code/my-project/.claude/settings.local.json
  restart Claude Code for the new env to take effect
```

*What `init` changed on disk*, in plain words:

- **Added two settings** to `.claude/settings.local.json` in this repo (Claude
  Code reads this file automatically):
  - `ANTHROPIC_BASE_URL` — points Claude Code at the local daemon instead of
    Anthropic directly. This is what enables the recording.
  - `ENABLE_TOOL_SEARCH=true` — makes Claude Code behave exactly as it normally
    would, so the captured traffic is faithful. (Claude Code changes some behaviour
    when it is not talking to Anthropic directly; this flag turns that off.)
- **Added `.ccsnoop/` to this repo's `.gitignore`**, so the captured traffic never
  gets committed by accident. (If `init` created `.claude/settings.local.json`
  itself, it gitignores that too.)
- **Registered a route** in `~/.ccsnoop/routes.json`, which is how the one shared
  daemon knows which repo a request belongs to and where to save it.

> ### ⚠️ Restart Claude Code now
>
> Claude Code only reads `.claude/settings.local.json` at startup. **Quit Claude
> Code completely and start it again**, or the new setting is ignored and nothing
> is captured. This is the number-one reason people see an empty report.

### Step 3 — use Claude Code normally

Open Claude Code in that repo and use it as you always do — ask a question, let it
read files, run a few turns. Every request and response is being copied to
`<your repo>/.ccsnoop/sessions/`. You do not have to do anything special.

### Step 4 — render the report

Back in the repo, run:

```console
$ ccsnoop report
ccsnoop report: wrote /home/you/code/my-project/.ccsnoop/sessions/<id>/report.html
  session: <id> (7 requests)
  open it in a browser — self-contained, works offline
```

*What just happened:* ccsnoop read the saved traffic for your most recent session
and wrote a single HTML file. It is completely self-contained (no internet needed to
view it). Open it in your browser:

```console
$ xdg-open .ccsnoop/sessions/<id>/report.html   # Linux
$ open .ccsnoop/sessions/<id>/report.html        # macOS
```

(Replace `<id>` with the session id printed above, or just double-click the file.)

### Step 5 — read the report

The report is a two-pane page: the list of requests on the left, the selected
request's detail on the right, with a growth chart and a waste summary on top. A few
signals, in beginner terms:

- **Context growth** — how big each request got, turn by turn, split into **System**
  (the base instructions), **Tools** (the tool definitions), **Message history**
  (everything said so far), and **Current turn** (the newest message). This is what
  "using up your context window" actually looks like.
- **Re-sent** — content that was sent again this turn identical to a previous turn.
  Some re-sending is normal and cheap (Anthropic caches it); the report flags the
  part that was *not* served from cache, because that is real repeated cost.
- **Bloated** — a single tool result that is much larger than its siblings (e.g. one
  huge file dump). Worth noticing when you are trying to trim a session.

> **Next — act on what the report shows you:** [`fine-tune`](docs/fine-tune.md)
> prescribes byte savings; [`cache`](docs/cache.md) diagnoses the prompt cache. See
> [Diagnostics](#5-diagnostics) below.

---

## 5. Diagnostics

Beyond the HTML report, a family of offline readers work off the same captured files
`report` reads — none needs the daemon running. `fine-tune`, `cache`, `floor`, `lifetime`,
and `isolate` each diagnose a different angle of what a session shipped; `apply` and
`verify` then act on the diagnosis — the last two steps of the
[context-tuning loop (§11)](#11-the-context-tuning-skill).

### `ccsnoop fine-tune` — trim what Claude Code sends

A byte-level waste diagnostic across five levers (unused built-in tools, idle MCP
servers, heavy `SessionStart` hooks, excludable CLAUDE.md files, the incompressible
system floor), plus a **paste-ready `settings.json`** to act on it. It writes nothing —
you copy the block yourself.

```console
$ ccsnoop fine-tune
…
Recoverable (waste, conservative): ~<n> bytes
settings.json (paste-ready):
{ "permissions": { "deny": ["Workflow", "ScheduleWakeup", "ReportFindings"] }, … }
```

Full guide — the levers, the T4 MCP guard, corpus vs single-session, denylist
overrides: [`docs/fine-tune.md`](docs/fine-tune.md).

### `ccsnoop cache` — diagnose the prompt cache

For each turn where a cached prefix went cold, it explains **why** (a four-verdict
taxonomy: HIT / STRUCTURAL / TEMPORAL / UNEXPLAINED), **what it cost** (in
token-equivalents), and **what to do differently**. Per-transition cards plus a lean
session rollup.

```console
$ ccsnoop cache
── session rollup ────────────
    write:   ~30,874 tok-équ.  (15,437 ×2 (1 h write))
    read:    ~18,492 tok-équ.  (184,925 ×0.1 (read))
    by verdict:  HIT 5 · STRUCTURAL 0 · TEMPORAL 0 · UNEXPLAINED 1
```

Full guide — the three frontiers, the verdict taxonomy, the recommendation bridges:
[`docs/cache.md`](docs/cache.md).

---

### `ccsnoop isolate` — quantify subagent context isolation

A subagent's context never enters the main window — it is built up, used, and discarded
in the subagent's own thread. `isolate` measures that payoff: it groups the session's
exchanges by `thread_id`, tags the subagent threads (`parent_session_id` set), and sums
per-thread input tokens (the prompt footprint = input + cache-read + cache-creation) straight
from the captured `usage` — never re-tokenizing. It then frames the **main** total against
an **if-inlined counterfactual** (main + subagent), and recommends routing context-heavy
exploration to subagents when the isolated context is a material fraction of that
counterfactual.

```console
$ ccsnoop isolate
per-thread input tokens (prompt: input + cache-read + cache-creation):
  main      ccsnoop-main-aaaa1111  · 2 exch · 2,150 tok
  subagent  ccsnoop-sub-bbbb2222 ← ccsnoop-main-aaaa1111  · 3 exch · 6,570 tok

main (actual):             2,150 tok
subagent (isolated):       6,570 tok
if-inlined counterfactual: 8,720 tok   (main + subagent)
isolation ratio:           75.3%
reco: Subagents isolated 75.3% of the inlinable context … Route context-heavy exploration to subagents …
```

A session with no subagents reports that honestly and emits no reco. Bytes appear only as a
labelled fallback column, never as the headline currency.

### `ccsnoop floor` — the default context window

The "default context window" *is* the turn-1 floor: everything Claude Code ships before
you've done any real work — the system prompt, every tool definition, every CLAUDE.md
source, every MCP tool, the `SessionStart` hook output. `floor` isolates that first
exchange and attributes it block by block, ranked by byte cost, so you can see which
static blocks own the baseline you can never drop below. The headline is **real turn-1
input tokens** read from the captured `usage` (never re-tokenized), framed as a % of a
context window (`--window`, default `200000`); the per-block table is a byte proxy.

```console
$ ccsnoop floor
ccsnoop floor — session <id> (turn 1 of 7)
model: <model>

Headline
  floor: <n> tokens  (<p>% of a 200,000-token window; pass --window to override)
  proxy: <n> bytes — the turn-1 prompt's static blocks, by byte length (never re-tokenized)

Per-block attribution — ranked by byte cost (proxy)
  block            bytes  % floor
  ────────────────────────────────────────────────
  system            …       …
  tools             …       …
  …
```

`floor` is the measurement behind `verify`, and the "incompressible system floor" lever
`fine-tune` reports is the same number, computed the same way.

### `ccsnoop lifetime` — how long the window lasted

`lifetime` surfaces **compaction as a first-class signal**: how many turns (and how much
wall-time) the context window survived before it was first compacted, how many compactions
the session incurred in total, and how many bytes each one dropped. It reframes "my context
blew up" into a number you can track from session to session. Add `--html` for a
self-contained document.

```console
$ ccsnoop lifetime
session <id> · <n> turns · <h>m
first compaction at turn <n> (<m>m) — dropped <n> bytes
compactions: <n>   total dropped: <n> bytes
```

### `ccsnoop verify` — did the tuning move the floor?

The close-the-loop step. `verify` takes two captures — a **before** and an **after** that
together form one *tuning session* — computes the turn-1 `floor` on each, and diffs them.
The headline delta is **real turn-1 tokens** from each side's captured `usage`; the
per-block delta is a byte proxy matched block-by-block. The verdict is one word —
**lowered / raised / flat** — so "did this tuning actually shrink the floor?" gets an
answer, not a guess. A pure offline reader; the daemon is not required.

```console
$ ccsnoop verify --before <id-before> --after <id-after>
ccsnoop verify — before/after floor delta
before: <id-before>    after: <id-after>
window: 200,000 tokens — scored identically on both sides

Headline — real turn-1 tokens from captured usage
  before: <n> tokens  (<p>% of window)
  after:  <n> tokens  (<p>% of window)
  delta:  −<n> tokens  (lowered)
```

`apply` and `verify` are the last two steps of the context-tuning loop — see
[§11](#11-the-context-tuning-skill) for the end-to-end flow, or install the skill that
drives it with `ccsnoop skill install`.

---

## 6. Turning it off / undoing

**Know the exit door before you walk in.** Everything ccsnoop does is reversible and
stays on your machine.

**Un-route a repo** — reverse exactly what `ccsnoop init` did to *this* repo:

```console
$ ccsnoop init --undo
ccsnoop init --undo: reverted /home/you/code/my-project
  removed route eb1caa31; captured data under /home/you/code/my-project/.ccsnoop left intact
  restart Claude Code to stop routing through ccsnoop
```

This puts `.claude/settings.local.json` and `.gitignore` back the way they were —
it only removes the lines `init` added, and if `init` created a file from scratch it
deletes it again. It **does not** delete your captured data. Restart Claude Code
afterwards so it stops routing through ccsnoop.

**Stop the daemon:**

```console
$ ccsnoop stop
stopped (pid 304)
```

> **`stop` only kills the daemon — it is *not* `init --undo`.** The
> `ANTHROPIC_BASE_URL` line stays in every init'd `settings.local.json`, and any
> Claude Code session launched while a repo was init'd has that URL **cached
> in-process for its whole lifetime**. So once the daemon is gone, those sessions
> retry on `ConnectionRefused`. `stop` warns when it detects such sessions and
> lists the PIDs/repos to restart. To also un-route every repo in one go (so a
> *relaunched* session isn't left pointing at the dead port), use
> `ccsnoop stop --clean` — but **already-running sessions must still be restarted**;
> neither `stop` nor `--clean` can reach env they cached at launch.

**Delete captured data.** Captures live in each repo under `.ccsnoop/`. To throw a
repo's captures away, delete that folder:

```console
$ rm -rf .ccsnoop
```

(Because `init` gitignores `.ccsnoop/`, it was never in version control anyway.)

---

## 7. Command reference

Run `ccsnoop <command> [options]`. `--help` prints this same list.

| Command  | What it does | Options |
| -------- | ------------ | ------- |
| `init`   | Activate capture for the current repo (writes the `.claude/settings.local.json` env, gitignores `.ccsnoop/`, registers the route). Restart Claude Code after. | `--force` overwrite a foreign `ANTHROPIC_BASE_URL`<br>`--undo` revert exactly what a prior init added |
| `start`  | Start the capture-proxy daemon (detached; returns immediately). | `--port <n>` listen port (persisted to `~/.ccsnoop/config.json`)<br>`--sessions-dir <p>` capture root (default `~/.ccsnoop/sessions`) |
| `stop`   | Stop the daemon (drain, then terminate). Warns about live sessions still routed through it. | `--clean` also un-route every registered repo (`init --undo` for all) |
| `status` | Report daemon status (running → exit `0`, stopped → exit `1`). | — |
| `report` | Render a captured session to a self-contained static HTML file. | `--root <path>` capture root (default `./.ccsnoop`)<br>`--sessions-dir <p>` dir holding session subdirs (overrides `--root`)<br>`--session <id>` session to render (default: latest)<br>`--all` widen discovery across `~/.ccsnoop/routes.json`<br>`--out <path>` output file (default `<session-dir>/report.html`)<br>`--bloat-floor <n>` bloat: absolute byte floor (default `4096`)<br>`--bloat-multiplier <n>` bloat: sibling-outlier multiplier (default `3`) |
| `fine-tune` | Print a byte waste diagnostic + a paste-ready `settings.json` (all sessions by default). | `--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` one session (weak-evidence: no MCP deny)<br>`--latest` most-recent session (weak-evidence)<br>`--all` widen discovery<br>`--deny-extra <a,b>` add denylist names for this run<br>`--deny-allow <a>` drop a denylist name for this run<br>`--json` emit the versioned `tuning-report/v1` contract ([schema](docs/tuning-report-schema.md))<br>`--include-tokens` with `--json`, backfill primary-session token totals |
| `apply` | Apply a fine-tune report's SAFE subset to `.claude/settings.json` (#98, ADR-0004). Presents a diff; writes only on `--yes`; advice levers are paste-only. | `--from <path\|->` consume a captured report (file, or `-` for stdin)<br>`--root <path>` without `--from`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` without `--from` (default: latest)<br>`--yes` approve the safe-subset write (else diff-only)<br>`--dry-run` print the diff without writing<br>`--settings <path>` override the target (default `./.claude/settings.json`) |
| `cache`  | Cache-economy diagnostic for one captured session (per-transition cards + rollup). | `--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` session to diagnose (default: latest)<br>`--latest` same as the default (no corpus mode)<br>`--ttl <seconds>` TEMPORAL threshold (default `3600`)<br>`--html` render as a self-contained HTML document |
| `floor` | Turn-1 baseline metric + ranked per-block attribution (the default context window). | `--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` session to score (default: latest)<br>`--latest` same as the default (no corpus mode)<br>`--window <tokens>` context window for the headline % (default `200000`) |
| `lifetime` | Effective context-lifetime metric for one captured session (compaction count, turns/wall-time to the first compaction, per-event bytes-dropped). | `--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` session to diagnose (default: latest)<br>`--latest` same as the default (no corpus mode)<br>`--html` render as a self-contained HTML document |
| `isolate` | Subagent context-isolation for one captured session (isolated vs main + an if-inlined counterfactual). | `--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--session <id>` session to analyze (default: latest)<br>`--threshold <f>` isolation ratio that fires the reco, in `[0,1]` (default `0.25`)<br>`--html` render as a self-contained HTML document |
| `verify` | Before/after turn-1 floor delta for two captured sessions (a tuning session): did the tuning lower the floor, and by how much? Pure offline. | `--before <id>` baseline session (required)<br>`--after <id>` tuned session (required)<br>`--root <path>`<br>`--sessions-dir <p>` (overrides `--root`)<br>`--window <tokens>` context window for the headline % (default `200000`)<br>`--json` emit the versioned `tuning-session` contract |
| `skill` | The publishable context-tuning skill (#97, epic #94). Installs into this repo's `.claude/skills/` to drive the capture → diagnose → apply → verify loop. | `install` copy the bundled skill into `.claude/skills/context-tuning/`<br>`--force` overwrite files that differ from the bundle (default: refuse) |

---

## 8. Concepts

A short glossary, saved for the end so the quickstart isn't gated behind it. Each
term in one sentence:

- **Capture scope** — *what* you are recording. ccsnoop records per **project**
  (per repo): you turn it on for one repo at a time with `ccsnoop init`.
- **Capture root** — *where* a repo's recordings land: the `.ccsnoop/` directory at
  the top of that repo, with sessions nested under `.ccsnoop/sessions/`.
- **Route token** — the short 8-character id (like `eb1caa31`) that identifies a
  repo to the shared daemon; it is derived from the capture root's path, so the same
  repo always gets the same token.
- **Routes registry** — `~/.ccsnoop/routes.json`, the file that maps each route
  token to its capture root, so the one machine-wide daemon can serve many repos and
  file each request in the right place.
- **Session** — one Claude Code run, stored as `sessions/<session_id>/` under the
  capture root; `ccsnoop report` renders one session into one HTML page.

> **Deeper reading:** the canonical glossary lives in [`CONTEXT.md`](CONTEXT.md); the
> full architecture (proxy, routing, capture layout) in [`docs/spec.md`](docs/spec.md).

---

## 9. Troubleshooting

**Nothing was captured / the report is empty.** Almost always one of:

- **The daemon isn't running.** Check with `ccsnoop status`; if it says `stopped`,
  run `ccsnoop start`.
- **Claude Code wasn't restarted after `init`.** Claude Code reads its settings only
  at startup — quit it completely and reopen it.
- **`init` wasn't run in this repo.** Capture is per-repo. `cd` into the repo and run
  `ccsnoop init` there; confirm a `.ccsnoop/` folder appears once you use Claude Code.

**`ConnectionRefused` looping in a session after `ccsnoop stop`.** Claude Code
reads `ANTHROPIC_BASE_URL` once, at launch, and caches it for the session's whole
lifetime (and so do every subagent/hook/git process it spawns). `stop` kills the
daemon but cannot touch that in-process env, so any session launched while a repo
was init'd keeps pointing at the now-dead port and retries forever:

```
* Unable to connect to API (ConnectionRefused) · Retrying in 10s  attempt 5/10
```

`stop` detects this and prints the offending PIDs/repos. Fix it by **restarting
those sessions**. To also clear the stale URL for *future* launches, un-route the
repo with `ccsnoop init --undo` (or `ccsnoop stop --clean` for every repo at
once) — but that only helps sessions you relaunch afterwards, not the ones
already running.

**Port already in use.** If another program is on port `41377`, `start` refuses
rather than guessing another port:

```console
$ ccsnoop start
ccsnoop: port 41377 busy; run 'ccsnoop status' or start with --port <n>
```

If that other program is a ccsnoop daemon already running, you're set — `ccsnoop
status` will confirm it. Otherwise start on a different port with
`ccsnoop start --port 41400` (the new port is remembered, and future `init` runs use
it). If you had already run `init` on the old port, re-run `ccsnoop init --force` so
the repo's `ANTHROPIC_BASE_URL` picks up the new port.

**`init` refuses because a base URL is already set.** If your
`.claude/settings.local.json` already has an `ANTHROPIC_BASE_URL` that ccsnoop
didn't set, it won't silently overwrite it:

```console
$ ccsnoop init
ccsnoop: refusing to overwrite a foreign ANTHROPIC_BASE_URL (https://example.com) — re-run with --force to replace it
```

Re-run with `ccsnoop init --force` to replace it (ccsnoop's `--undo` will still
restore the original value afterwards).

**`report` (or `fine-tune` / `cache`) says no session was found.** By default these
only look in the current repo's `.ccsnoop/`:

```console
$ ccsnoop report
ccsnoop: no captured sessions found under ./.ccsnoop — run 'ccsnoop start' first, or pass --root <path>
```

If you're running it from a different directory, either `cd` into the repo, pass
`--root <path>` pointing at the repo's `.ccsnoop`, or use `ccsnoop report --all` to
search every repo registered in the routes registry.

---

## 10. Privacy & safety

**Captures are your prompts and your files, in the clear.** A capture is a
byte-faithful copy of what Claude Code sent — that includes your messages, the
system prompt, and the full contents of any files it read. Secret request headers
(like your API key) are redacted before anything is written, but the request
*bodies* are not.

- **Where it lands:** each repo's `.ccsnoop/` directory, on your own disk. Nothing
  is uploaded anywhere.
- **It's gitignored:** `ccsnoop init` adds `.ccsnoop/` to the repo's `.gitignore`,
  so captures aren't committed by accident. (Don't remove that line.)
- **Don't share a raw capture or report.** A `report.html` can embed real file
  contents and prompts. Treat a capture or report like a copy of your source and
  conversation — because that is what it is. To dispose of one, delete the repo's
  `.ccsnoop/` folder.

---

## 11. The context-tuning skill

ccsnoop captures and diagnoses. The **context-tuning skill** is the thin,
project-scoped layer that drives the loop — **capture → diagnose → apply (tiered) →
verify** — and guides you into it no matter what state ccsnoop is in. It does not
re-measure, and it never runs installs for you: every consequential action is a
`ccsnoop` command.

Install it into the repo you want to tune, then restart Claude Code:

```console
$ ccsnoop skill install
```

This drops the skill into `.claude/skills/context-tuning/` (idempotent — re-run after
upgrading ccsnoop; `--force` overwrites files you've edited). Then ask Claude Code in
that repo: *"tune my Claude Code context"* or *"apply my ccsnoop fine-tune."*

The skill checks ccsnoop's state first (installed? daemon up? this repo wired for
capture?) and tells you the single command that advances it — through to the loop:

1. **Capture** — do real work in Claude Code; ccsnoop captures in the background.
2. **Diagnose** — `ccsnoop fine-tune --json`.
3. **Apply** — `ccsnoop apply --from <report> --dry-run` to review the safe-subset
   diff, then `--yes` to write it on approval. Hooks and CLAUDE.md are surfaced
   paste-only (ADR-0004: only levers with *dynamic proof* of waste are auto-applied).
4. **Verify** — re-capture, then `ccsnoop verify --before <id> --after <id>` to see
   whether the turn-1 floor actually moved.

Full design — the bootstrap state machine and the skill ↔ CLI contract:
[`docs/context-tuning-skill.md`](docs/context-tuning-skill.md).

---

## For maintainers — the tuning bench

Beyond snooping a single session, this repo ships a **tuning bench**: a
developer-only harness that runs the same short task through ccsnoop with each
Claude Code "lever" turned off one at a time, and measures — in bytes and cache
tokens — how much each one trims from what Claude Code sends. It answers *"do
these tuning levers actually shrink the request, and by how much?"* with
numbers, not guesses.

It is a maintainer tool, **not** a `ccsnoop` subcommand: it spends real API
tokens and copies your Claude Code credentials into throwaway config dirs. If
you want to understand how it works or run it yourself, start with the
**[beginner on-ramp → bench/README.md](bench/README.md)**; the locked contract
(the 21-step sequence, the `diff.json` schema, the exit-code table) lives in
[bench/SPEC.md](bench/SPEC.md).
