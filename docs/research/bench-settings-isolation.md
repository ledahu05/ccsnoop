# Bench settings isolation — how a tuning-bench run gets tuned settings + valid creds without touching `~/.claude/`

Research resolution for [#47](https://github.com/ledahu05/ccsnoop/issues/47) (part of the
tuning-bench map [#46](https://github.com/ledahu05/ccsnoop/issues/46)).

**Environment of record.** Claude Code `2.1.220 (Claude Code)` (`claude --version`), commit
`4073f59596e2`, `linux-x64`, npm-global install, account `authMethod: claude.ai` /
`subscriptionType: team` / `apiProvider: firstParty`. ccsnoop at `e4bc235` plus the local
(unpushed) `#27`/`#28` commits.

**How to read this.** Every claim is tagged:

- **[DOC]** — quoted from the official Claude Code documentation, fetched during this
  investigation (not recalled).
- **[HELP]** — quoted from `claude --help` / `claude auth --help` on this machine at v2.1.220.
- **[LIVE]** — observed by running something. The probe is
  `docs/research/probes/bench-isolation-probe.mjs`.
- **[CODE]** — read out of this repo's source.
- **[INFERENCE]** — reasoning on top of the above, explicitly not observed.

Nothing in this investigation wrote to `~/.claude/settings.json`, `~/.claude.json`, or the
global `CLAUDE.md`. The only real-`~/.claude` access was reading `.credentials.json` to copy
it byte-for-byte into a scratch dir (never parsed, never printed).

---

## Headline (read this if you read nothing else)

1. **OAuth credentials do NOT survive an isolated config dir on Linux — the credential file
   must be copied in (see #2).** Both `HOME=<scratch>` and `CLAUDE_CONFIG_DIR=<scratch>`
   produce `{"loggedIn": false, "authMethod": "none"}` and exit 1. **[LIVE]**
2. **But the fix is one `cp`, not a redesign.** Copying `~/.claude/.credentials.json` into the
   scratch config dir restores `{"loggedIn": true, "authMethod": "claude.ai",
   "subscriptionType": "team"}`. **[LIVE]** So the bench keeps real subscription auth; it does
   *not* have to switch to `ANTHROPIC_API_KEY`. The effort is not reshaped — but the copy step
   is load-bearing and must be in the spec, not discovered at implementation time.
3. **The injection channel is `CLAUDE_CONFIG_DIR` + a settings file written *inside* it** —
   not `--settings`, which **merges** rather than replaces, so the dev's real user settings
   (hooks, `permissions`, MCP) keep leaking into every arm. Documented fallback if duplicating
   a credential file is unacceptable: `--setting-sources project,local`, which isolates the
   settings scope *and* keeps creds working **[LIVE]** — with two footguns (§1).
4. **Never route the proxy through settings.** `ccsnoop init` writes `ANTHROPIC_BASE_URL` into
   `.claude/settings.local.json` (the `local` scope). Any arm that constrains
   `--setting-sources` drops that scope and the run silently stops going through ccsnoop —
   measuring an unproxied session and reporting it as a result.
5. **`omniris_tuning.md` contains one recipe that does not exist**:
   `--setting-sources managed,system`. At v2.1.220 the flag accepts only `user`, `project`,
   `local`. Fix the tuning doc.

---

## 1. Injection channel for a whole settings set per run

### What the CLI actually offers

| Lever | What it does | Verdict for the bench |
|---|---|---|
| `--settings <file-or-json>` | **[DOC]** *"Path to a settings JSON file or an inline JSON string. Values you set here override the same keys in your `settings.json` files for this session. **Keys you omit keep their file-based values.** The file must be a regular file no larger than 2 MiB."* | **Merge, not replace.** Cannot express "an arm with *only* these settings". Usable as a *delta* on top of an already-isolated config dir. |
| `--setting-sources <sources>` | **[HELP]** *"Comma-separated list of setting sources to load (user, project, local)."* **[DOC]** identical wording. | Subtractive only, and it cannot drop `managed`. Also the trap in §4 below: dropping `local` unroutes ccsnoop. |
| `CLAUDE_CONFIG_DIR` | **[DOC]** (`.claude` directory reference) *"If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead."* **[DOC]** (debug-your-config, *Test against a clean configuration*) *"Point `CLAUDE_CONFIG_DIR` at an empty directory to bypass everything under `~/.claude`, and launch from a directory that has no `.claude` folder, `.mcp.json`, or `CLAUDE.md` so project configuration is also skipped."* | **This is the channel.** It relocates the *entire* user scope — settings, hooks, skills, agents, plugins, memory, MCP — so an arm's `settings.json` is authoritative rather than a patch. |
| `HOME` rewritten | Same effect on the user scope (because `~/.claude` follows `HOME`) **[LIVE]**, plus it moves `git`, `ssh`, `gh` and every other tool's config. | **Reject.** Strictly more collateral damage than `CLAUDE_CONFIG_DIR` for exactly the same isolation. |
| `--bare` | **[DOC]** *"Bare mode skips OAuth and keychain reads. Anthropic authentication must come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` in the JSON passed to `--settings`."* **[HELP]** *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)."* | **Reject for a subscription bench.** It forcibly discards the creds the bench relies on, and its context floor is nothing like a real dev session. Useful only as a lower-bound measurement. |
| `--safe-mode` | **[DOC]** *"Managed settings policy still applies, including policy-configured hooks, status line, and file-suggestion commands; managed plugins, managed skills, managed CLAUDE.md, and policy-configured MCP servers do not."* | Not an arm. A **measuring instrument** for the un-disable-able floor (§4). |
| `--disallowedTools <names>` | **[DOC]** *"A bare tool name removes the matching tools from Claude's context: `"Edit"` removes Edit, `"*"` removes every tool, and `"mcp__*"` removes every MCP tool."* | A flag-only equivalent of `permissions.deny` for tool stripping. Handy because it needs no settings file at all. |
| `--strict-mcp-config` | **[DOC]** *"Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations"* | Belt-and-braces for lever 4 (MCP) — kills `.mcp.json` and user-scope servers without a settings key. |

### Which are ignored in `-p` mode

**[HELP]**, `-p, --print`:

> *"Settings files that fail validation are silently ignored in this mode (no error dialog is shown)."*

This is the single most dangerous fact for the bench. A generated arm settings file with a
typo does not fail the run — it produces a session that ran **untuned**, and the bench then
publishes that as "after tuning" with a straight face.

**Mitigation, mandatory:** every arm's settings file must be validated before the run.
`JSON.parse` is not enough (a valid-JSON file with a schema error is also rejected wholesale —
**[DOC]**: *"An array value is a schema error: Claude Code shows a settings error notice and
**rejects the whole user, project, or local settings file**"*). Use
`claude doctor` from the arm's config dir, which **[HELP]** *"Reads settings files in the
current directory without a trust prompt"* and **[DOC]** *"reports what it finds, including
invalid settings files"* — and fail the arm loudly if it complains.

Everything else relevant survives `-p`: `--settings`, `--setting-sources`,
`CLAUDE_CONFIG_DIR`, `--disallowedTools`, `--strict-mcp-config` all take effect, and
`SessionStart` hooks still run (observed as `hook_started`/`hook_response` events in
`--output-format stream-json`) **[LIVE]**.

### Retained channel

```
CLAUDE_CONFIG_DIR=<arm-dir>/.claude        # whole user scope = this arm, nothing of the dev's
  <arm-dir>/.claude/settings.json          # the arm's levers, authoritative
  <arm-dir>/.claude/.credentials.json      # install -m600 from ~/.claude/ (see §2)
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<token>   # PROCESS ENV, never in a settings file
ENABLE_TOOL_SEARCH=true                              # PROCESS ENV — see below, not optional
```

**Both** env vars, not just the base URL. **[CODE]** `ccsnoop init` writes the pair together,
and **[DOC]** *"When set to a non-first-party host, MCP tool search is disabled by default. Set
`ENABLE_TOOL_SEARCH=true` if your proxy forwards `tool_reference` blocks."* If one arm has it
and another does not, the arms differ in whether `tool_reference` blocks are forwarded and
`tools[]` bytes stop being comparable — which is the bench's primary measurement.

`--settings` is kept in reserve for a per-*run* delta inside an arm (e.g. flipping one lever
while holding the rest), which is exactly what its merge semantics are good for.

**Fallback channel, if copying a credential file is judged unacceptable:**
`--setting-sources project,local`. **[LIVE]** (cells F and L) it strips the user scope as
thoroughly as a scratch config dir — user settings, plugins, agents, skills and MCP servers all
go — while leaving `~/.claude/.credentials.json` in place, so auth still resolves (cell L
reached the request loop with no API key; cell K, the scratch config dir, did not) and no secret
is duplicated. Two caveats that
make it the fallback and not the default:

- It **must** include `local`, because that is the scope `ccsnoop init` writes routing into. A
  driver that ever emits `--setting-sources project` silently unroutes the arm (§3). The
  process-env rule defuses this only as long as nobody regresses it.
- It does **not** isolate `~/.claude.json` (**[DOC]**: MCP servers for user/local scopes,
  per-project trust state, caches) and it leaves the dev's real config dir writable by the run.
  `CLAUDE_CONFIG_DIR` isolates both.

---

## 2. Auth under an isolated config dir — the blunt answer

**Do OAuth creds survive config-dir isolation? No. Not under `HOME`, not under
`CLAUDE_CONFIG_DIR`.** (They *do* survive `--setting-sources` — see §1's fallback channel and
cells K/L in §4. Credentials are not a settings source; they are a file inside the config dir.)

The doc says so, for this exact scenario **[DOC]** (debug-your-config, *Test against a clean
configuration*):

> *"On Linux and Windows, you'll be prompted to log in again because credentials are stored
> under the configuration directory"*
> *"On macOS, credentials are in the Keychain and carry over to the clean session"*

And the live sweep agrees exactly. `claude auth status` prints JSON and makes **no inference
call**, so this whole matrix cost zero tokens (`node docs/research/probes/bench-isolation-probe.mjs auth`):

| Cell | Environment | `claude auth status` | exit |
|---|---|---|---|
| A | control — real `HOME`, real `~/.claude` | `{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "orgName": "Softnext", "subscriptionType": "team"}` | 0 |
| B | `HOME=<scratch>` (empty) | `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}` | **1** |
| C | real `HOME` + `CLAUDE_CONFIG_DIR=<scratch>/.claude` | `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}` | **1** |
| D | `HOME=<scratch>` + `.credentials.json` copied in | `{"loggedIn": true, "authMethod": "claude.ai", ..., "subscriptionType": "team"}` | 0 |
| D2 | `CLAUDE_CONFIG_DIR=<scratch>/.claude` + `.credentials.json` copied in | `{"loggedIn": true, "authMethod": "claude.ai", ..., "subscriptionType": "team"}` | 0 |

**The credential artifact.** `~/.claude/.credentials.json`, mode `0600` **[LIVE]**. Top-level
keys `claudeAiOauth`, `designOauth`, `mcpOAuth`; `claudeAiOauth` holds `accessToken`,
`refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`,
`rateLimitTier` **[LIVE]**. The docs never name this file — they only say credentials live
"under the configuration directory" — so treat the *filename* as version-specific and
re-verify it when CC updates. On macOS it is the Keychain instead and the copy trick does not
apply **[DOC]**.

Note in cells D/D2 the account *profile* fields come back `null` (`email`, `orgId`,
`orgName`) while `loggedIn` is `true` and `subscriptionType` is `team`. **[INFERENCE]** the
profile is cached in `~/.claude.json` (**[DOC]**: *"This file contains your OAuth session, MCP
server configurations for user and local scopes, per-project state (allowed tools, trust
settings), and various caches."*) while the bearer token is in `.credentials.json`. Auth works
without the profile, so the bench does **not** need to copy `~/.claude.json` — and should not,
because that file carries MCP servers, trust state and caches, i.e. exactly the leakage the
isolation exists to prevent.

### Recipe (three options, ranked)

1. **Copy the credential file (recommended).**
   `install -m600 ~/.claude/.credentials.json "$ARM/.claude/.credentials.json"`
   Keeps subscription billing, keeps `anthropic-beta: oauth-2025-04-20` on the wire (the shape
   #7 captured), keeps the payload identical to a real dev session — which is the whole point
   of a *tuning* bench. Copy **before** the run; delete the arm dir after.
   **Caveats:** (a) the token expires — check `claudeAiOauth.expiresAt` before a run and
   re-copy if the dev's CC has refreshed it since; (b) an isolated config dir will refresh the
   token *into the arm dir*, so the dev's real file does not get updated and the arm dir now
   holds a live secret — the arm dir must be `chmod 700`, outside the repo, and deleted on
   teardown; (c) **[INFERENCE]** whether two processes refreshing the same refresh token
   concurrently invalidates one another is untested — do not run arms in parallel with copied
   creds.
2. **`ANTHROPIC_API_KEY`.** Simplest and stateless, and **[DOC]** *"In non-interactive mode
   (`-p`), the key is always used when present."* Costs: per-token API billing instead of the
   subscription, a different auth header shape than #7 captured, and it *changes the payload* —
   **[LIVE]** with a key set, CC emits `⚠ claude.ai connectors are disabled because
   ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai
   login`, which silently removes lever 4's MCP-connector bytes from **both** arms and makes
   that lever unmeasurable. Acceptable as a fallback, not as the default.
3. **`claude setup-token`** — **[HELP]** *"Set up a long-lived authentication token (requires
   Claude subscription)"*. Cleanest in principle for an unattended bench (a token minted *for*
   the bench, no file copying, no shared refresh token). **Not exercised here** — it is
   plausibly interactive and would write to real config. Flagged as the follow-up to try if
   the copy trick proves fragile.

---

## 3. Scratch repo recipe

`git init` in a tmpdir is sufficient. **[CODE]** `resolvePaths` (`src/init.js`) calls
`gitTopLevel` → `git rev-parse --show-toplevel`, which succeeds immediately after
`git init` — no commit, no remote, no config needed. **[LIVE]** the probe's scratch project is
exactly `mkdir -p && git init -q` and `ccsnoop init` semantics hold there.

Since **#27** a non-git cwd no longer errors — `const repo = top ?? path.resolve(cwd)`, and
the gitignore step is skipped (`if (P.isGit)`) **[CODE]**. So `git init` is not strictly
*required* any more. Do it anyway: with a git top-level, `init` also exercises the
gitignore branch, and the map's stated goal is that the bench doubles as end-to-end coverage
of `init`/`--undo`. A bench on a non-git scratch dir would leave that branch untested.

```bash
ARM=$(mktemp -d); mkdir -p "$ARM/.claude"; chmod 700 "$ARM"
mkdir -p "$ARM/repo" && git -C "$ARM/repo" init -q
# seed a deterministic, minimal working tree — see "comparability" caveat below
```

Two things the bench must control that `git init` alone does not:

- **The scratch repo must have no `CLAUDE.md` / `.mcp.json` / `.claude/`** except what the
  bench puts there — **[DOC]** *"launch from a directory that has no `.claude` folder,
  `.mcp.json`, or `CLAUDE.md` so project configuration is also skipped."* Since `ccsnoop init`
  *creates* `.claude/settings.local.json`, that file is the one intentional exception.
- **The working tree is part of the payload.** CC's system prompt carries cwd, env info and
  git status, so an empty repo and a repo with 400 files are not comparable arms. Either pin
  the exact same tree for every arm, or use
  `--exclude-dynamic-system-prompt-sections` (**[HELP]** *"Move per-machine sections (cwd, env
  info, memory paths, git status) from the system prompt into the first user message. Improves
  cross-user prompt-cache reuse"*). This belongs to the comparability ticket, not here, but
  the scratch-repo recipe is where it gets decided.

### The trap: `settings.local.json` vs `--setting-sources`

**[CODE]** `applyInit` writes

```js
env.ANTHROPIC_BASE_URL = baseUrl;   // §3.3 path-token routing
env.ENABLE_TOOL_SEARCH = 'true';    // §1.1 capture fidelity
settings.env = env;
writeJson(P.settings, settings);    // <repo>/.claude/settings.local.json
```

i.e. the proxy route lives in the **`local`** settings scope. `--setting-sources user,project`
drops `local` **[DOC]**, therefore drops `ANTHROPIC_BASE_URL` *and* `ENABLE_TOOL_SEARCH`,
therefore the session talks straight to `api.anthropic.com` and captures nothing — with no
error anywhere. The bench would compare two unproxied sessions and report a number.

> **Design constraint.** Routing (`ANTHROPIC_BASE_URL`, `ENABLE_TOOL_SEARCH`) goes in the
> **process env** of the spawned `claude`. Tuning levers go in the arm's config dir. Never
> route via a settings file, and never let an arm's `--setting-sources` be the thing that
> decides whether capture happens.

`ccsnoop init` on the scratch repo is still worth running — the map wants the bench to exercise
`init`/`--undo` — but the bench must treat it as *coverage*, and set the env vars itself for
*routing*.

---

## 4. What leaks anyway

Measured, not enumerated from docs: the probe reads the `system/init` stream event, which
**[DOC]** *"reports session metadata including the model, tools, MCP servers, and loaded
plugins"* and is emitted **before** the first API request — so this whole sweep also costs zero
tokens (`node docs/research/probes/bench-isolation-probe.mjs init`).

All cells: `-p hi --model claude-haiku-4-5-20251001 --output-format stream-json --verbose`,
cwd = the scratch git repo, `ANTHROPIC_BASE_URL=http://127.0.0.1:1/ccsnoop-probe` (dead port),
`ANTHROPIC_API_KEY=sk-ant-probe-dummy`, every `CLAUDE_*` marker of the parent session stripped.
"hooks" = `SessionStart` hooks that actually fired.

| cell | environment | tools | MCP | plugins | agents | slash cmds | hooks fired |
|---|---|---|---|---|---|---|---|
| **A** | control, real `~/.claude` | 27 | `["plan"]` | 4 | 7 | **102** | CAVEMAN + PONYTAIL |
| **B** | `HOME=<scratch>` | 27 | `[]` | 0 | 5 | 41 | — |
| **C** | `CLAUDE_CONFIG_DIR=<scratch>/.claude` | 27 | `[]` | 0 | 5 | 41 | — |
| **F** | `--setting-sources project,local` | 27 | `[]` | 0 | 5 | 41 | — |
| **G** | `--safe-mode` | 27 | `[]` | 4 (see note) | 4 | 41 | — |
| **E** | real `~/.claude` + `--settings tuned.json` | **24** | `["plan"]` | 4 | 7 | **102** | — |
| **H** | real `~/.claude` + `--settings <malformed>` | 27 | `["plan"]` | 4 | 7 | **102** | CAVEMAN + PONYTAIL |
| **I** | `CLAUDE_CONFIG_DIR=<scratch>` + `--settings tuned.json` | **24** | `[]` | 0 | 5 | 41 | — |

What this settles:

- **`CLAUDE_CONFIG_DIR` is exactly as isolating as rewriting `HOME`** (B ≡ C, field for field)
  and costs none of `HOME`'s collateral. That decides §1.
- **`--settings` merges — proven both ways in one cell.** In E the injected file *did* apply
  (`permissions.deny` took `tools` 27 → 24: `Workflow`, `ReportFindings`, `ScheduleWakeup`
  gone; `disableAllHooks: true` silenced CAVEMAN/PONYTAIL) **and** the dev's user scope was
  still fully present (`mcp: ["plan"]`, 4 plugins, 7 agents, 102 slash commands). So
  `--settings` alone cannot produce a clean arm — matching **[DOC]** *"Keys you omit keep their
  file-based values."*
- **`permissions.deny` with bare tool names really does strip tool schemas** — `omniris_tuning.md`
  lever 1 confirmed live, not just by doc quote (E and I: 27 → 24).
- **The `-p` silent-ignore hazard is real and total.** H (deliberately truncated JSON in
  `--settings`) produced a session **indistinguishable from the control**: hooks fired, 27
  tools, 102 commands, nothing on stderr, same exit path. An arm with a malformed settings file
  runs *untuned* and reports as if tuned. This is the bench's most likely way to publish a
  false result.
- **`--setting-sources project,local` drops far more than settings keys** (F): the user scope's
  plugins, agents, skills and MCP servers go with it. That makes it a genuine second isolation
  channel, not just a key filter — see the caveat in §1/§3.

#### Second batch — no `ANTHROPIC_API_KEY`, to test creds against `--setting-sources`

Same setup minus the dummy key, so **reaching the request loop at all proves credentials
resolved**. The discriminator is `exit_code` + whether `api_retry` events appear — *not* the
retry count on its own:

| cell | environment | `api_retry` events | exit | tools | plugins | slash | verdict |
|---|---|---|---|---|---|---|---|
| **J** | control, no key | 9 × `unknown` (dead-port connect) | 143 (probe timeout) | 29 | 4 | 105 | reached the POST loop → **creds resolved** |
| **K** | `CLAUDE_CONFIG_DIR=<scratch>`, no key | **none** | **1** | 25 | 0 | 41 | never reached the POST loop → **creds gone** |
| **L** | `--setting-sources project,local`, no key | 9 × `unknown` | 143 | 29 | 0 | 44 | reached the POST loop → **creds survived** |

K vs L is the clean pair: identical isolation of the user *settings* scope, opposite auth
outcome. So `--setting-sources` is genuinely a "isolate the settings, keep the credentials"
channel **[LIVE]**, and `CLAUDE_CONFIG_DIR` genuinely is not.

Two incidental warnings for the comparability ticket, both **[LIVE]**:

- **The control itself drifts.** A and J are the same control; A reported 27 tools / 102 slash
  commands, J reported 29 / 105. The only difference is the dummy `ANTHROPIC_API_KEY`, which
  **[LIVE]** triggers `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
  auth source is set…`. So **setting an API key changes the payload**, by ~2 tools and 3
  commands here. Third confirmation that option 2 in §2 is not neutral.
- Never compare tool/command *counts* taken from different runs as if they were stable. Compare
  captured bytes from the same ccsnoop session model, which is what the bench is for.

### Floor — what leaks no matter what

Present in **every** cell, including `--safe-mode` and a fully scratch config dir:

1. **The 27 built-in tool definitions.** Nothing but an explicit deny/`--tools`/
   `--disallowedTools` removes them; `--safe-mode` explicitly leaves them (**[DOC]**
   *"Authentication, model selection, built-in tools, and permissions work normally"*).
   In `omniris_tuning.md`'s capture this was the single biggest block (14 272 tok, 44%).
2. **41 slash commands** — built-in commands plus bundled skills. `--disable-slash-commands`
   (**[HELP]** *"Disable all skills"*) is the only lever, untested here.
3. **4–5 built-in agents** (`claude`, `Explore`, `general-purpose`, `Plan`, and
   `statusline-setup` outside safe-mode). Not removable by file.
4. **Managed / policy settings.** **[DOC]** *"Managed settings still apply if your organization
   deploys them, since they live at a system path outside `~/.claude`"* and **[DOC]**
   *"Managed settings policy still applies, including policy-configured hooks, status line, and
   file-suggestion commands."* This box **has** one: `claude doctor` reports **[LIVE]**
   *"Remote Control is disabled by your organization's policy … Org policy does not allow
   Remote Control (allow_remote_control)"*. So the bench's "baseline" arm inherits whatever the
   Softnext policy sets, in both arms, unremovably — which is fine for a *differential* bench
   and fatal for any absolute claim.
5. **The harness system prompt** (`system[2]`, ~2 644 tok per `omniris_tuning.md`) — the
   incompressible floor already established there.

One anomaly to flag rather than explain away: in **G (`--safe-mode`) the `plugins` array still
lists all four plugins** even though the plugin *skills* are gone (102 → 41 slash commands) and
**[DOC]** says safe mode disables plugins. **[INFERENCE]** the `system/init.plugins` field
reports *discovered/installed* plugins rather than *active* ones. The bench must therefore
**not** use `system/init.plugins` as its evidence that plugins were disabled — use the slash
command count, or better, the captured `tools[]`/`system[]` bytes from ccsnoop itself.

---

## 5. What a killed run leaves behind, and how to clean it

Inventory of every mutation a bench run can make, and who reverses it:

| Artefact | Written by | Survives a `kill -9`? | Cleanup |
|---|---|---|---|
| `<ccsnoop-home>/daemon.pid` + the daemon process | `ccsnoop start` | **Yes** — daemon is detached and reparented to init **[CODE]** | `ccsnoop stop --home <ccsnoop-home>`; **[CODE]** `stop` = SIGTERM (drain) → SIGKILL fallback → remove pidfile |
| `<ccsnoop-home>/routes.json` entry | `ccsnoop init` | **Yes** | `ccsnoop init --undo` from the scratch repo, *or* just delete the whole scratch ccsnoop home |
| `<ccsnoop-home>/config.json` (port) | `ccsnoop start --port` **[CODE]** `resolvePort` persists the override | Yes | inside the scratch home — deleted with it |
| `<scratch-repo>/.claude/settings.local.json` | `ccsnoop init` | Yes | `init --undo` (manifest-driven, restores the exact pre-init state) — or irrelevant, the repo is a tmpdir |
| `<scratch-repo>/.gitignore` lines | `ccsnoop init` | Yes | ditto |
| arm config dir incl. **a copy of the OAuth token** | the bench | **Yes** | `rm -rf` — and this one is a *secret*, so it is the one cleanup step that must not be best-effort |
| `<scratch>/.ccsnoop/sessions/**` captures | the proxy | Yes | keep or delete per the artefacts policy (#46 open item) |

**The isolation that makes cleanup trivial: `CCSNOOP_HOME`.** **[CODE]**
`defaultHome() { return process.env.CCSNOOP_HOME || path.join(os.homedir(), '.ccsnoop'); }`,
and `bin/ccsnoop.js` also accepts `--home` on `init`/`start`/`stop`/`status`. Give the bench
its own home and it never touches the dev's `~/.ccsnoop/routes.json` at all — no route to
un-register, no daemon to disambiguate, and a different port so it cannot collide with a dev
daemon on 41377.

Two sharp edges:

- **`init` and `start` must be given the *same* home**, or the daemon reads a `routes.json`
  that has no route and captures nothing **[CODE]** (`runServe` uses
  `daemon.paths(home).routes`).
- **`ccsnoop report --all` ignores `CCSNOOP_HOME`.** **[CODE]** `src/report.js:375`:
  `const p = path.join(os.homedir(), '.ccsnoop', 'routes.json');` — hardcoded to the real home.
  So an isolated bench must use `ccsnoop report --root <scratch-repo>/.ccsnoop`, never
  `--all`, or it will discover the dev's sessions. (Arguably a bug worth its own ticket: the
  rest of the CLI honours `CCSNOOP_HOME`/`--home` and `report` does not.)

**Teardown order** (idempotent, safe to run twice, safe to run after a crash):

```bash
ccsnoop stop --home "$ARM/ccsnoop"        || true   # exits 0 when already stopped
( cd "$ARM/repo" && ccsnoop init --undo ) || true   # no-op when no route registered
rm -rf "$ARM"                                       # includes the copied credential file
```

Register that as a `trap ... EXIT INT TERM` in the driver. A `kill -9` of the driver defeats
the trap, so the driver should also, on startup, sweep for orphaned arm dirs (`$TMPDIR/ccsnoop-arm-*`)
and stop a daemon whose pidfile it finds there.

---

## Corrections to `omniris_tuning.md`

1. **`--setting-sources managed,system` does not exist.** The tuning doc's lever 3 says
   *"`--setting-sources managed,system` droppe les scopes user/project"*. **[HELP]** and
   **[DOC]** both say the flag takes only `user`, `project`, `local`. There is no way to name
   `managed` or `system` — managed settings apply unconditionally and cannot be selected or
   deselected. The way to drop the user scope is `--setting-sources project,local`, or better,
   `CLAUDE_CONFIG_DIR`.
2. **Lever 1's mechanism is confirmed by primary source.** **[DOC]** (permissions): *"A bare
   tool name like `Bash` removes the tool from Claude's context entirely, so Claude never sees
   it. ... A scoped rule like `Bash(rm *)` leaves the tool available and blocks matching calls
   when Claude attempts them."* Same for the CLI flag **[DOC]**: `--disallowedTools "Edit"`
   *"removes Edit"*. Exception: `EndConversation` cannot be removed while any other tool
   remains.
3. **Lever 2 has a cleaner switch than `hooks.SessionStart: []`.** **[DOC]**
   `disableAllHooks` — *"Disable all hooks and any custom status line"* — one boolean instead
   of enumerating hook events, and it does not depend on knowing which events the dev uses.
4. **Lever 4 has a flag-only form.** `--strict-mcp-config` with no `--mcp-config`, per the
   `--tools` doc: *"pass `--strict-mcp-config` without `--mcp-config` so no MCP servers
   load"*. Useful for an arm that must not depend on `disabledMcpjsonServers` bookkeeping.

---

## Environment limitation encountered (matters for whoever runs the bench)

The live probing here ran inside a sandboxed Claude Code subagent, where **loopback TCP is
blocked** — a same-process `http.get('http://127.0.0.1:<own-port>/')` hangs, and any spawned
`claude -p` therefore never reaches a local proxy. Egress to `api.anthropic.com` works from
the shell (`curl` → `401`), but a spawned `claude -p` in this sandbox also produced only
`Execution error` and then hung, across eight distinct configurations (with/without API key,
with/without `--bare`, with all `CLAUDE_*` env markers stripped, sandbox on and off).

Consequence: **the bench driver cannot itself be a Claude Code subagent.** It must run from a
plain shell (or an unsandboxed process) that can bind and connect to loopback and spawn
`claude`. Worth writing into the bench spec — an "AFK bench" that an agent kicks off from
inside a CC session would silently hang forever.

The two sweeps in the probe were designed around that: they need no listener and no inference
call (`claude auth status`, and `system/init` before a dead-port POST attempt), which is also
why they cost zero API tokens.

---

## Open questions handed back to the map

- **Token refresh under a copied credential file** — untested. If a run's arm dir refreshes
  the OAuth token, does the dev's real `~/.claude/.credentials.json` become stale/invalid?
  Cheap to test (`claude auth status` before/after a run under an arm dir with a near-expiry
  token) and it decides whether the copy trick is safe to repeat.
- **`claude setup-token`** as the proper unattended-auth answer — deliberately not run here
  because it may write to real config.
- **Working-tree determinism / `--exclude-dynamic-system-prompt-sections`** — belongs to the
  comparability ticket, but the scratch-repo recipe cannot be finalised without it.
