# `ccsnoop fine-tune` — trim what Claude Code sends

`fine-tune` reads your captured sessions and tells you, **in bytes**, which parts
of what Claude Code sends on your behalf are recoverable waste — then hands you a
**paste-ready `settings.json`** block to act on it.

It is an offline reader of captures: it does **not** need the daemon running, and it
**writes nothing**. You read its diagnostic, copy the `settings.json` block if you
agree with it, and paste it into your project yourself. Advice to copy, never
auto-applied.

> Captures first. `fine-tune` only knows what was actually sent, so it needs at least
> one captured session. If you have not captured anything yet, follow the
> [Quickstart](../README.md#4-quickstart--the-happy-path) first (`start` → `init` →
> restart Claude Code → use it).

---

## What it shows you

A byte-level diagnostic across five **levers** — the recurring blocks Claude Code
ships with every request. The `shipped` column is how many bytes the lever costs per
request; `waste` is the recoverable part (bytes re-paid after a cache break). The
`action` column is what `fine-tune` would do about it:

| Lever | What it is | Action |
| ----- | ---------- | ------ |
| **tools** | built-in tool definitions shipped but never called | `deny ✓` (emit a `permissions.deny` entry) |
| **MCP** | MCP servers shipped in the deferred "still connecting" listing | `deny ✓` / `flag-only` (under the guard below) |
| **hooks** | `SessionStart` hook output | `remove ⚠` (above the floor) or `below floor` |
| **CLAUDE.md** | project memory files shipped into the system prompt | `advice (excludable)` / `advice (managed)` |
| **catalog** | the `<system-reminder>` listings — deferred tools, agent types, the skills catalog | `cost only (no lever yet)`, or `name-only ✓ (n)` on the skills catalog |
| **harness** | the incompressible `system[]` floor | `incompressible floor (not actionable)` |

All figures are bytes (never re-tokenized). The headline line sums it up:

```
Recoverable (waste, conservative): ~<n> bytes
```

---

## What it emits — and when

Below the table, `fine-tune` prints a clean, comment-free `settings.json` block. Each
key appears **only when its lever actually acts** — no empty keys.

The block mixes both tiers, so a line **beside** it (never inside — that would break the
paste) names the keys `ccsnoop apply` will *not* write, whatever you approve. Read it: a
proven `permissions.deny` and an all-or-nothing `disableBundledSkills` are not equally
settled, and one column would make them look it.

- **`permissions.deny`** — **always present.** The bare tool names that are the
  intersection of what the session *shipped* with the built-in denylist
  (`data/builtin-denylist.json`). Denying them stops Claude Code sending their
  definitions every turn.
- **`disabledMcpjsonServers`** — **only under the T4 guard**: the server was shipped
  across **≥ 3 sessions** and **never called** (`mcp__<server>__*` never appeared in a
  response). One session is too thin to accuse a server, so this key **never** appears
  in single-session mode.
- **`skillOverrides`** — a map `{ "<skill>": "name-only" }`, **only under the same
  guard as MCP**: the corpus holds **≥ 3 sessions**, the skill was listed in the turn-1
  skills catalog, and the **model** never invoked it in any of them (no `Skill` tool_use
  named it). Like the MCP guard, the threshold is on the *corpus* — `shippedSessions` per
  skill is reported so you can see how much of it actually listed the skill. A `/name`
  *you* typed is not an invocation and does not spare a skill — which is sound, because
  `name-only` leaves `/name` working: the skill stays listed and fully invocable, only its
  description stops shipping. **`off` is never emitted.** A scope-qualified skill
  (`plugin:name`) is reported with its cost and never written: no `skillOverrides` entry
  reaches a plugin skill — see the two advice-tier sections below.
- **`disableBundledSkills`** (set to `true`) — the bundled bulk, **advice only**
  (ADR-0005 lever 5b). Offered *only* when the corpus clears the same ≥ 3-session guard
  **and not one** of the skills Claude Code ships itself was model-invoked. One invoked
  bundled skill and the option is withheld, because the gesture is all-or-nothing: from
  there it is per-name `name-only` that applies (a `skillOverrides` entry *does* reach a
  bundled skill). It is paste-only in every case, and it carries a caveat — it removes
  **`/name` on every bundled skill too**, not just their descriptions.
  Bundled is a **name** test against ccsnoop's versioned `data/bundled-skills.json` (the
  wire carries no source marker), so the section quotes the roster's provenance and names
  every skill it would drop: on a Claude Code build newer than the roster, that list is
  what lets you catch the drift. An unreadable roster degrades this one verdict — which
  then reports *"ccsnoop could not check"* — and never fails the run.
- **`hooks.SessionStart`** (set to `[]`) — **only** when a `SessionStart` hook shipped
  ≥ 4096 bytes. It carries the caveat `intent unknown — injected every session; review
  before applying`, because a hook may be load-bearing and `fine-tune` cannot tell.
- **`claudeMdExcludes`** — source paths, **only** for *excludable* (non-managed)
  CLAUDE.md sources above the floor.

### Plugin skills — measured and named, never written

One key is deliberately **absent** from every block ccsnoop emits: `enabledPlugins`.

A plugin skill carries exactly the same proof as a `name-only` verdict — shipped on every
turn 1 across the corpus, never invoked by the model — but no `skillOverrides` entry
reaches it (Claude Code's resolver returns `"on"` for a plugin skill before it reads
settings at all). The only knob is `enabledPlugins`, and it cuts the **whole plugin**,
including the skills you do use. That is an unbounded action on good evidence, so
[ADR-0004](adr/0004-skill-auto-applies-safe-levers.md) keeps it out of the safe tier —
and ccsnoop does not even offer a value to paste, because *which* plugin to keep is a
judgment about the skills still in use, not a measurement.

What you get instead is the **signalement**, per plugin and per skill:

```
Scoped skills (advice — enabledPlugins is yours to decide; ccsnoop never writes it):
  mattpocock-skills                       1.9K  12 skills, 1 invoked · 1.7K dead · enabledPlugins: mattpocock-skills
      code-review                          412  invoked 6× — cutting the plugin costs this
      naming                               501  never invoked
      …
  Disabling a plugin recovers its whole cost AND its invoked skills; the dead bytes are the
  loss-free part. Neither is in the recoverable headline: this action's price is not in bytes.
```

Both halves are shown on purpose. A verdict that named only the dead bytes would read as
"uninstall this" — and cost you `code-review`.

> A **directory-scoped** skill (`apps/web:deploy`) is listed qualified too and is grouped
> the same way, but reports **no action**: no settings key disables a directory scope.

> ### ⚠️ Applying the block invalidates the cache
>
> Changing `tools[]`, the system prompt, or the CLAUDE.md set breaks the prompt prefix,
> so the next request re-writes the cache. That is expected — the one-time re-write is
> the price of the per-request saving. `fine-tune` warns you when any emitted key has
> this effect.

---

## Corpus vs single-session

By default `fine-tune` runs over the **corpus** — every session under the resolved
roots — so the MCP "never used" guard has the 3-session evidence it needs to fire.

Pass **`--session <id>`** or **`--latest`** to look at one session only. That is
**weak-evidence mode**: the MCP lever then **never** denies (one session cannot prove a
server is unused), and neither does the skills lever. The built-in `tools` deny is always taken from the primary session
(the latest, or the one you named).

---

## Tuning the denylist for one run

The built-in denylist is fixed, but you can shape it for a single run without editing
any file (the override is **not** persisted):

- **`--deny-extra Workflow,Bash`** — add these names for this run only.
- **`--deny-allow Bash`** — drop a denylist name for this run only.

Precedence is **allow > base > extra**: an explicit allow wins, then the base denylist,
then your extras.

---

## Flags

| Flag | Meaning |
| ---- | ------- |
| `--root <path>` | capture root (default `./.ccsnoop`) |
| `--sessions-dir <p>` | dir holding session subdirs (overrides `--root`) |
| `--session <id>` | one session (weak-evidence: no MCP deny) |
| `--latest` | most-recent session (weak-evidence: no MCP deny) |
| `--all` | widen discovery across `~/.ccsnoop/routes.json` |
| `--deny-extra <a,b>` | add denylist names for this run only |
| `--deny-allow <a>` | drop a denylist name for this run only |
| `--json` | emit the versioned [`tuning-report/v1`](tuning-report-schema.md) contract instead of the text table |
| `--include-tokens` | with `--json`, backfill primary-session token totals from captured `usage` |

---

## Machine-readable output (`--json`)

For programmatic consumers — the [context-tuning skill](https://github.com/ledahu05/ccsnoop/issues/94)
and any automation — pass `--json` to get a stable, versioned JSON contract instead of
the text table. It carries the same verdicts, structured: each lever's `verdict`,
`evidence`, and `action`; the **safe vs advice** tier split (safe = `tools` / `mcp` /
`skills`, auto-writable; advice = `hooks` / `claudeMd` / `pluginSkills` /
`bundledSkills`, paste-only); and the `settings.auto` /
`settings.advice` partition of the paste-ready block. See
[`tuning-report-schema.md`](tuning-report-schema.md) for the full schema.

```console
$ ccsnoop fine-tune --json --include-tokens
```

The default text output is unchanged when `--json` is absent.

---

## Example

```console
$ ccsnoop fine-tune
ccsnoop fine-tune — session session-963204f5… (6 requests)

Lever              entry                        shipped    waste    action
──────────────────────────────────────────────────────────────────────────
tools              Workflow                       21.0K        0    deny ✓
tools              ScheduleWakeup                  3.7K        0    deny ✓
tools              ReportFindings                  2.1K        0    deny ✓
MCP                deferred listing                1001        0    flag-only
    stub                       flag (called 0/1)
hooks              SessionStart                    8.2K        0    remove ⚠ intent unknown …
CLAUDE.md          …/cwd/CLAUDE.md                 8.8K        0    advice (excludable)
harness            system                         27.7K        —    incompressible floor (not actionable)
──────────────────────────────────────────────────────────────────────────
Total                                             72.6K        0

Recoverable (waste, conservative): ~0 bytes
…
⚠ Applying this block invalidates the cache (tools[] / system content changes → prefix broken).
settings.json (paste-ready):
{
  "permissions": { "deny": ["Workflow", "ScheduleWakeup", "ReportFindings"] },
  "hooks": { "SessionStart": [] },
  "claudeMdExcludes": ["…/cwd/CLAUDE.md"]
}
```

The MCP row reads `flag-only` here because this is a single session — the T4 guard
cannot fire, so `fine-tune` flags rather than denies.

---

## Further reading

The full design — the four bloat levers, the gain model, the T4 guard — is in
[`fine-tune-spec.md`](fine-tune-spec.md). The byte accounting both commands share lives
in [`src/waste.js`](../src/waste.js).
