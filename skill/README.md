# context-tuning skill

A project-scoped Claude Code skill that tunes **this repo's** Claude Code context.
It is a thin layer over [ccsnoop](https://github.com/ledahu05/ccsnoop): ccsnoop
captures and diagnoses; this skill drives the loop — **capture → diagnose → apply
(tiered) → verify** — and guides you into it no matter what state ccsnoop is in.

It does not re-measure, and it never runs installs for you. Every consequential
action is a `ccsnoop` command.

## Requirements

- The `ccsnoop` CLI on your `PATH` (the skill checks for it — see *Bootstrap* below).
  Install ccsnoop from a clone: `git clone https://github.com/ledahu05/ccsnoop.git &&
  cd ccsnoop && npm install -g .`
- Claude Code launched in this repo.

## Install the skill into a repo

From the repo you want to tune:

```console
$ ccsnoop skill install
```

This drops the skill into `<repo>/.claude/skills/context-tuning/` (idempotent —
re-run after upgrading ccsnoop; it refuses to overwrite files you've edited unless
you pass `--force`). **Restart Claude Code** so it discovers the new skill.

> No `ccsnoop` CLI handy? Copy this directory (`SKILL.md` + `scripts/`) into
> `<repo>/.claude/skills/context-tuning/` manually. The bootstrap script is
> standalone (node builtins only).

## Use it

Ask Claude Code in the repo: *"tune my Claude Code context"*, *"apply my ccsnoop
fine-tune"*, or *"what's wasting my context?"*. The skill runs the loop.

### Bootstrap — the skill checks ccsnoop's state first

The standalone detector (`scripts/bootstrap.mjs`) reads only `ccsnoop --help`,
`ccsnoop status`, and `~/.ccsnoop/routes.json`. It reports one of four states and
tells you the single command that advances it — it never runs that command for you.

| State | Fix |
| ----- | --- |
| `absent` | Install ccsnoop (above). |
| `daemon-down` | `ccsnoop start` |
| `un-init` | `ccsnoop init`, then **restart Claude Code** |
| `ready` | You're in the loop. |

You can run it yourself:

```console
$ node .claude/skills/context-tuning/scripts/bootstrap.mjs            # human
$ node .claude/skills/context-tuning/scripts/bootstrap.mjs --json     # machine
```

### The loop

1. **Capture** — do real work in Claude Code; ccsnoop captures in the background.
2. **Diagnose** — `ccsnoop fine-tune --json > report.json`.
3. **Apply (tiered)** — `ccsnoop apply --from report.json --dry-run` to review the
   diff, then `--yes` to write the **safe** levers (uncalled tools, unused MCP
   servers) on your approval. The **advice** levers (hooks, CLAUDE.md) are printed
   paste-ready and never written. Restart Claude Code after a write.
4. **Verify** — re-capture the same kind of work, then
   `ccsnoop verify --before <id> --after <id>` to see whether the turn-1 floor
   actually moved. No verify = guesswork.

## Authority (ADR-0004) and redaction (spec §1.3)

- **Two tiers, one gate.** Only levers with *dynamic proof* of waste (a tool never
  called, an MCP server never invoked) may be auto-applied, and only on explicit
  approval of a presented diff. Hooks and CLAUDE.md have no such proof — they are
  surfaced, never silently edited.
- **Capture data is inviolable.** `.ccsnoop/sessions/` holds raw, redacted request
  bodies (API key scrubbed, full conversation content). The skill never reads,
  prints, or transmits those files — it consumes only aggregate JSON outputs. Never
  commit `.ccsnoop/`.

## See also

- `ccsnoop --help` — the surfaces this skill drives.
- `docs/tuning-report-schema.md` in the ccsnoop repo — the `fine-tune --json` contract.
- ADR-0004 — the two-tier authority.
