# ADR-0001: Sandcastle cross-provider model split (GLM impl, Claude review)

- **Status**: Accepted
- **Date**: 2026-07-26
- **Context**: `.sandcastle/` orchestration (not the ccsnoop capture product)
- **Ticket**: [#68](https://github.com/ledahu05/ccsnoop/issues/68)

## Context

The Sandcastle loop in `.sandcastle/main.ts` runs four agents — Planner,
Implementer, Reviewer, Merger — all hardcoded to `claude-opus-4-8`. We want the
review performed by a **different model** than the one that wrote the code, so
the reviewer does not share the implementer's blind spots (ensembling for
diversity, not because Claude is "better at review"). Concretely:

| Role (impl side)    | Model          | Provider |
|---------------------|----------------|----------|
| Planner / Implementer / Merger | `glm-5.2[1m]` | z.ai     |
| Reviewer            | `claude-opus-4-8` | Anthropic |

This is a **cross-provider** split: the two models are served by different
endpoints with different auth. z.ai exposes only GLM models on an
Anthropic-compatible endpoint; it does not proxy Claude models (the "Claude
Opus" mentions on z.ai marketing are comparisons, not a catalog entry).

## Decision

1. **A2 — two sequential worktrees per issue, one per provider.** For each
   issue: `createSandbox({branch}, env=zai)` runs the Implementer, then
   `close()`, then `createSandbox({branch}, env=anthropic)` runs the Reviewer
   on the **same branch**. The Planner and Merger stay in head mode (top-level
   `run()`) on the z.ai env.

2. **S1 — auth tokens live in `.sandcastle/.env.secrets`, not `.env`.**
   `main.ts` reads `.env.secrets` itself and bakes exactly one token into each
   sandbox's `docker({env})`. `.sandcastle/.env` keeps only `GH_TOKEN`.

## Why these two (the surprising part)

### Why tokens cannot live in `.env`

`@ai-hero/sandcastle`'s `resolveEnv` merges **every** key from
`.sandcastle/.env` into **every** sandbox (`mergeProviderEnv` returns
`{...resolvedEnv, ...sandboxProviderEnv, ...agentProviderEnv}`), and
`docker({env})` can only **add** keys on top — it cannot remove one. So if
both `ANTHROPIC_AUTH_TOKEN` (z.ai) and `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic)
sat in `.env`, both would reach every sandbox. claude-code would then send
whichever token it prefers against whatever base URL is set — one of the two
providers always gets the wrong token → **401**.

Orientation's `~/sandcastle-kit/engine/provider.mts` never hit this because it
runs **one provider per process** (a global `MODE`), so only one token is ever
present. ccsnoop runs both providers in one process, so the avoidance strategy
does not transfer.

`resolveEnv` only pulls keys that are physically in `.env` (its `process.env`
fallback is scoped to those keys), so moving the tokens **out** of `.env` is
sufficient — they stop leaking. `.env.secrets` is read only by `main.ts`.

**Rejected alternative (S2 — blank-override):** keep both tokens in `.env` and
blank the unwanted one per sandbox (`ANTHROPIC_AUTH_TOKEN=""`). This relies on
claude-code treating an empty string as unset, which is version-dependent and
can break silently on upgrade. Not worth the invisible ceiling.

### Why two worktrees instead of head-mode review

The Reviewer must run **on the issue branch** — it commits `RALPH: Review`
refinements and runs `npm test` / `npm run typecheck` against the branch's
code (`review-prompt.md` uses `git diff main..HEAD`). A head-mode reviewer
would operate on the host's checked-out branch: it would need to `git switch`
the host repo per issue, which races with parallel implementers and breaks on
a dirty host tree.

Two sequential worktrees avoid this entirely: the Reviewer gets its own
isolated worktree checked out on the existing branch, with the Anthropic env
baked in. No host mutation, `review-prompt.md` unchanged.

This is mechanically sound because of how `createSandbox({branch})` works in
this sandcastle version: it first tries `git worktree add <path> <branch>`
(checkout existing), and falls back to `git worktree add -b <branch> <path>
HEAD` (create) only on "invalid reference". So the Implementer's call creates
the branch, `close()` removes the worktree path but keeps the branch ref and
commits, and the Reviewer's call checks out the now-existing branch.

**Rejected alternative (close+reopen doubt):** during design we briefly
suspected this create-vs-existing behavior was unverifiable in the minified
dist and pivoted to a head-mode review phase (A3). Reading the dist confirmed
the fallback exists; A3 would have required editing `review-prompt.md` and
mutating host branch state, so A2 is cleaner.

## Consequences

- **+** Reviewer is isolated (own worktree, own provider env); no host-branch
  mutation; `review-prompt.md` unchanged.
- **−** Two sandbox spin-ups and two `npm ci` runs per issue (impl + review).
  Acceptable: review is best-effort and `MAX_PARALLEL=4` still applies across
  issues.
- **−** Auth setup is split across two files (`.env` for `GH_TOKEN`,
  `.env.secrets` for the two tokens). This is the price of cross-provider in
  one process and is documented in `.env.example` / `.env.secrets.example`.
- **Invariant**: the reviewer must be a different model than the implementer.
  If the implementer ever moves to Claude, the reviewer must move off it.

## References

- `~/sandcastle-kit/engine/provider.mts` — single-provider preset pattern
  (source of inspiration; does not cover cross-provider)
- `node_modules/@ai-hero/sandcastle/dist/index.js` — `resolveEnv` (~L627),
  `mergeProviderEnv` (~L642)
- `node_modules/@ai-hero/sandcastle/dist/chunk-VOG34SRF.js` — worktree
  create-vs-existing fallback (~L25294), `git bundle create --all` (~L26185)
- orientation PR #57 — the 401 worktree-env fix (head mode merges env; worktree
  mode does not)
