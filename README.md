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
5. [Turning it off / undoing](#5-turning-it-off--undoing) ← **read this before you start**
6. [Command reference](#6-command-reference)
7. [Concepts](#7-concepts)
8. [Troubleshooting](#8-troubleshooting)
9. [Privacy & safety](#9-privacy--safety)

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

  then, offline:  ccsnoop report  ──reads the files──▶  report.html
```

Four lines of what happens:

1. `ccsnoop start` launches a small background program (the **daemon**) that listens
   on your own machine at `http://localhost:41377`.
2. `ccsnoop init` tells Claude Code — for one repo — to send its API traffic to that
   local address instead of straight to Anthropic.
3. As you use Claude Code, the daemon tees a copy of every request and response to
   disk, then forwards the real request to `api.anthropic.com` and streams the reply
   back untouched. Claude Code works exactly as normal.
4. `ccsnoop report` reads those saved files and renders a single HTML page. It does
   this offline, from the files — the daemon does not need to be running to make a
   report.

If your report is empty, it is almost always because step 1 or step 2 was skipped,
or because Claude Code was not restarted after `init` (see
[Troubleshooting](#8-troubleshooting)).

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
  stop     Stop the daemon (drain, then terminate)
  status   Report daemon status (running → exit 0, stopped → exit 1)
  report   Render a captured session to a self-contained static HTML file
             --root <path>        capture root (default ./.ccsnoop)
             --session <id>       session to render (default: latest)
             --all                widen discovery across ~/.ccsnoop/routes.json
             --out <path>         output file (default <session-dir>/report.html)
             --bloat-floor <n>    bloat: absolute byte floor (default 4096)
             --bloat-multiplier <n>  bloat: sibling-outlier multiplier (default 3)
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

---

## 5. Turning it off / undoing

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

**Delete captured data.** Captures live in each repo under `.ccsnoop/`. To throw a
repo's captures away, delete that folder:

```console
$ rm -rf .ccsnoop
```

(Because `init` gitignores `.ccsnoop/`, it was never in version control anyway.)

---

## 6. Command reference

Run `ccsnoop <command> [options]`. `--help` prints this same list.

| Command  | What it does | Options |
| -------- | ------------ | ------- |
| `init`   | Activate capture for the current repo (writes the `.claude/settings.local.json` env, gitignores `.ccsnoop/`, registers the route). Restart Claude Code after. | `--force` overwrite a foreign `ANTHROPIC_BASE_URL`<br>`--undo` revert exactly what a prior init added |
| `start`  | Start the capture-proxy daemon (detached; returns immediately). | `--port <n>` listen port (persisted to `~/.ccsnoop/config.json`)<br>`--sessions-dir <p>` capture root (default `~/.ccsnoop/sessions`) |
| `stop`   | Stop the daemon (drain, then terminate). | — |
| `status` | Report daemon status (running → exit `0`, stopped → exit `1`). | — |
| `report` | Render a captured session to a self-contained static HTML file. | `--root <path>` capture root (default `./.ccsnoop`)<br>`--session <id>` session to render (default: latest)<br>`--all` widen discovery across `~/.ccsnoop/routes.json`<br>`--out <path>` output file (default `<session-dir>/report.html`)<br>`--bloat-floor <n>` bloat: absolute byte floor (default `4096`)<br>`--bloat-multiplier <n>` bloat: sibling-outlier multiplier (default `3`) |

---

## 7. Concepts

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

---

## 8. Troubleshooting

**Nothing was captured / the report is empty.** Almost always one of:

- **The daemon isn't running.** Check with `ccsnoop status`; if it says `stopped`,
  run `ccsnoop start`.
- **Claude Code wasn't restarted after `init`.** Claude Code reads its settings only
  at startup — quit it completely and reopen it.
- **`init` wasn't run in this repo.** Capture is per-repo. `cd` into the repo and run
  `ccsnoop init` there; confirm a `.ccsnoop/` folder appears once you use Claude Code.

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

**`report` says no session was found.** By default `report` only looks in the
current repo's `.ccsnoop/`:

```console
$ ccsnoop report
ccsnoop: no captured sessions found under ./.ccsnoop — run 'ccsnoop start' first, or pass --root <path>
```

If you're running it from a different directory, either `cd` into the repo, pass
`--root <path>` pointing at the repo's `.ccsnoop`, or use `ccsnoop report --all` to
search every repo registered in the routes registry.

---

## 9. Privacy & safety

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
