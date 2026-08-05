# The context-tuning skill — design note

The **publishable, project-scoped skill** that turns ccsnoop from a CLI into a
guided, reproducible loop: **capture → diagnose → apply (tiered) → verify**. This
note records the two design decisions that aren't obvious from the code: the
**guided-bootstrap state machine** and the **skill ↔ CLI contract** (what the skill
owns vs. what it delegates).

Origin: [issue #97](https://github.com/ledahu05/ccsnoop/issues/97) (skill gap 2),
part of [epic #94](https://github.com/ledahu05/ccsnoop/issues/94). Authority for
the apply/verify split lives in [ADR-0004](adr/0004-skill-auto-applies-safe-levers.md);
the diagnosis contract in [`tuning-report-schema.md`](tuning-report-schema.md).

## The skill is a thin layer that requires ccsnoop

It does not re-measure, re-derive lever verdicts, or re-implement the apply/verify
math. Every consequential action is a `ccsnoop` CLI call. The skill's value is the
**loop** and the **guided entry** into it. Concretely it consumes three surfaces:

| Surface | Role in the loop |
| ------- | ---------------- |
| `ccsnoop fine-tune --json` ([#95](tuning-report-schema.md)) | **Diagnose** — the machine-readable lever verdicts (input). |
| `ccsnoop apply --from <report>` ([#98](../src/apply.js), ADR-0004) | **Apply** — the tiered merge (delegate). |
| `ccsnoop verify --before … --after …` ([#96](../src/verify.js)) | **Verify** — the before/after floor delta (delegate). |

The two-tier authority (safe = auto-write on approval; advice = paste-only) is read
straight off the contract's `safeLevers` / `adviceLevers` and `settings.auto` /
`settings.advice` — the skill never re-derives which lever carries proof.

## Guided bootstrap — detect, then point (never execute)

Before the loop can run, ccsnoop must be in a captureable state. The skill does not
assume one. A standalone detector (`skill/scripts/bootstrap.mjs`) probes three
things and maps them to one of four states:

| State | Probe that fails | Guidance |
| ----- | ---------------- | -------- |
| `absent` | `ccsnoop --help` (not on PATH) | Point to the install instructions. |
| `daemon-down` | `ccsnoop status` (exit ≠ 0) | `ccsnoop start`. |
| `un-init` | no route in `~/.ccsnoop/routes.json` for this repo's `.ccsnoop` | `ccsnoop init`, then **restart Claude Code**. |
| `ready` | — | Enter the loop. |

Two properties are load-bearing:

1. **The detector is standalone.** It ships inside the skill and imports only node
   builtins — never ccsnoop's `src/` — so it runs in any host repo that has the
   `ccsnoop` CLI on PATH. The `absent` state cannot be a `ccsnoop` subcommand (if
   ccsnoop is absent there is nothing to invoke), so the whole state machine lives
   skill-side. It reuses ccsnoop's scriptable surfaces (`--help`, `status`) and the
   route map `init` writes, rather than importing ccsnoop internals.

2. **It points, never executes.** The skill tells the user the exact command that
   advances the state; it does not run installs, package managers, or daemons on the
   user's behalf. This is the spec guardrail: the skill is advice-shaped all the way
   down to getting ccsnoop onto the machine.

"Initialized" means a route is registered for **this repo's** capture dir
(`<git-top-level>/.ccsnoop`, or `<cwd>/.ccsnoop` off-repo) — a path-resolve equality
against `routes.json` values, mirroring `src/init.js`'s anchoring. The restart
reminder on `un-init` exists because `init` writes the CC env block, but the cached
`ANTHROPIC_BASE_URL` only clears on restart — the single most common "capture comes
up empty" cause.

## Skill ↔ CLI contract — what the skill owns

| Concern | Owner |
| ------- | ----- |
| Detecting ccsnoop's bootstrap state | **Skill** (`bootstrap.mjs`) |
| Picking the two sessions that form a tuning session | **Skill** (ccsnoop emits the delta; it does not decide the pairing) |
| Lever verdicts, tier split, byte/token accounting | **ccsnoop** (`fine-tune --json`) |
| Idempotent settings merge, foreign-key refusal, capture guard | **ccsnoop** (`apply`) |
| Floor computation, before/after delta | **ccsnoop** (`floor`, `verify`) |
| Presenting the diff, getting approval, restart reminder | **ccsnoop** (`apply`); the skill relays it |

The skill's only *write* path is `ccsnoop apply --yes`, and only after showing the
diff. The advice levers (hooks, CLAUDE.md) are relayed paste-only — the skill never
writes them, matching ADR-0004.

## Redaction (spec §1.3)

The skill consumes **only aggregate, derived JSON** (`fine-tune --json`,
`verify --json`). It never opens a capture file under `.ccsnoop/sessions/` — those
hold raw, redacted request bodies (API key scrubbed, full conversation content). The
bootstrap detector is held to the same standard: it reads `routes.json`, not
captures. `.ccsnoop/` stays gitignored.

## Install — project-scoped

`ccsnoop skill install` copies the bundled `skill/` into
`<cwd>/.claude/skills/context-tuning/` (idempotent; refuses to clobber files that
differ from the bundle without `--force`; never writes under `.ccsnoop/`). After a
restart, Claude Code discovers the skill and the loop is available in that repo.
