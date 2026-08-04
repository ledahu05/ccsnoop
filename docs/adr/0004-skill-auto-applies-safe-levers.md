# ADR-0004: The skill auto-applies safe levers only, on approval of a diff

- **Status**: Accepted
- **Date**: 2026-08-04
- **Context**: ccsnoop capture product — the publishable context-tuning skill (epic #94)
- **Ticket**: [#98](https://github.com/ledahu05/ccsnoop/issues/98) (apply glue), [#94](https://github.com/ledahu05/ccsnoop/issues/94) (epic)

## Context

`ccsnoop fine-tune` is, by spec (§3, non-negotiable 1), **advice-to-copy, never
auto-applied** — a human reviews the paste-ready `settings.json` block and pastes
what they want. The skill (gap 2, #97) is meant to close the loop without losing
that human-in-the-loop guarantee. The question this ADR settles: **which of the
four levers may the skill write for the user, and under what gate?**

The four levers split cleanly on whether they carry **dynamic proof** of waste:

| Lever | Proof | Source |
|-------|-------|--------|
| Built-in tools (`permissions.deny`) | **Dynamic** — a name intersects a *pre-validated* denylist AND was never called in the corpus. | `data/builtin-denylist.json` ∩ shipped ∩ uncalled |
| MCP (`disabledMcpjsonServers`) | **Dynamic** — shipped across ≥ 3 sessions and never called (the T4 guard). | sent-vs-used across the corpus |
| SessionStart hooks (`hooks.SessionStart`) | **None** — injected every session by construction; cost only, never "unused". | static — intent unknown |
| CLAUDE.md (`claudeMdExcludes`) | **None** — injected every session by construction; cost only. | static — intent unknown |

A false positive on a *dynamic-proof* lever is bounded (the tool/MCP provably
wasn't used), so auto-applying it on approval is safe. A false positive on a
*no-proof* lever is unbounded — the hook or file may be load-bearing for reasons
the bytes can't see — so auto-applying it would be reckless.

## Decision

**Two tiers, one gate.**

1. **Safe tier — auto-writable on approval of a presented diff.** The built-in
   tools and MCP levers (`permissions.deny`, `disabledMcpjsonServers`). The skill
   may write these to the project's `.claude/settings.json` once the user approves
   the diff. Dynamic proof is the authority.

2. **Advice tier — paste-only, never written.** The hooks and CLAUDE.md levers
   (`hooks.SessionStart`, `claudeMdExcludes`). The skill surfaces these as a
   paste-ready block; it never writes them. No dynamic proof means no auto-apply,
   full stop.

3. **The gate is a presented diff + explicit approval, every time.** The skill
   never writes blind: it shows the exact delta to `settings.json` and writes
   only on explicit approval (`ccsnoop apply --yes`). `--dry-run` shows the diff
   and writes nothing.

4. **The write is an idempotent, strict read-modify-write merge — never
   overwrite.** `safeMergeSettings` (in `src/apply.js`, extracted from `init`'s
   proven pattern) unions the safe arrays into the existing settings and leaves
   every other key untouched. It refuses unknown/foreign keys (the advice tier
   can never reach the writer) and never writes under `.ccsnoop/` (capture data
   is inviolable). Applying twice is identical to applying once.

5. **A restart reminder follows any write.** Settings changes recompile the
   shipped tool set next session; the skill says so after writing.

The contract serializes this distinction (issue #95): `safeLevers` / `adviceLevers`
mirror the tiers, and `settings.auto` / `settings.advice` partition the paste-ready
block. `ccsnoop apply` (issue #98) consumes that split directly — it does not
re-derive which levers carry proof.

## Consequences

- The human-in-the-loop guarantee holds for the consequential levers (hooks,
  CLAUDE.md): they are surfaced, never silently edited.
- The low-risk, high-frequency wins (deny an uncalled tool, disable an unused MCP
  server) become one approval away instead of a manual paste — the skill delivers
  applied value, not just advice.
- The tiers are a property of the *evidence*, not a policy knob: a lever moves
  tiers only if it gains or loses dynamic proof, which is a spec change, not a
  setting.
- This ADR is the authority both the apply glue (#98) and the skill (#97)
  reference; the implementation lives in `src/apply.js` and the split is
  documented in `CONTEXT.md`.
