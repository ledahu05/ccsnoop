# ADR-0002: Sandcastle model profiles (switchable all-Opus / split regimes)

- **Status**: Accepted
- **Date**: 2026-07-28
- **Context**: `.sandcastle/` orchestration (not the ccsnoop capture product)
- **Amends**: [ADR-0001](0001-sandcastle-cross-provider-split.md) — generalises it,
  does not replace it

## Context

ADR-0001 hardcoded the cross-provider split into `.sandcastle/main.ts`: two
constants (`IMPL_MODEL`, `REVIEW_MODEL`) and two env factories (`zaiEnv()`,
`anthropicEnv()`). We now want to run all four agents on Opus for
high-stakes tickets, while keeping the split available for volume and cost.

The decisive criterion, stated up front by the requester, was **how easy it is to
switch between the two**. Every trade-off below was settled against it.

Two readings were rejected. All-Opus as a mere **operational escape hatch** (z.ai
unavailable) would not justify any switching-ease requirement — you would just edit
two constants. All-Opus as the **new nominal** would force us to justify dropping
the diversity invariant, which nothing asks for. So: **two regimes of equal
standing**, chosen run by run, `split` staying the default. That framing is also
the only one that makes the *choice* — not just the switch — a first-class act: the
profile becomes a parameter of the run, not a state of the file.

## Decision

1. **D1 — two regimes of equal standing, `split` is the default.** All-Opus for
   sensitive tickets, split for volume and cost.

2. **D2 — the switch is an environment variable**, `SANDCASTLE_PROFILE=opus npx tsx
   .sandcastle/main.ts`, with two npm scripts (`sandcastle`, `sandcastle:opus`) as a
   discoverable façade, and an immediate `throw` on an unknown value.

   **Rejected: editing a constant in `main.ts`.** The Planner and Merger run in
   *head mode* — in the host repo itself. An uncommitted modified `main.ts` sits in
   their working tree for the whole run, and the Merger commits. Switching by
   editing therefore manufactures a standing risk of committing the switch state —
   and worse, a misplaced `git stash`/reset flips the regime back with nobody
   noticing. Two supporting arguments: `main.ts` already reads
   `process.env.SANDCASTLE_DRYRUN`, so `SANDCASTLE_PROFILE` extends an existing
   idiom and composes with it (`SANDCASTLE_PROFILE=opus SANDCASTLE_DRYRUN=1 …`
   checks the wiring before burning tokens); and the profile shows up in shell
   history, so "which regime was that run?" becomes answerable.

   **Rejected: a CLI argument** (needs a parser where there is none, does not
   compose homogeneously with `SANDCASTLE_DRYRUN`). **Rejected: a separate config
   file** (one more file, format, read path and gitignore question for zero gain).

3. **D3 — a provider is the triplet {model id, base URL, token}**, not just a model
   name. That triplet is exactly what gets baked into a `docker({env})`.

4. **D4 — assignment is per role (4 keys), not per camp (2 keys).**
   `{ planner, implementer, reviewer, merger }`, each naming a provider. Three
   reasons: it makes both profiles **purely declarative** — a profile is a
   four-line table, switching is reading another table, and **no
   `if (profile === …)` survives in the loop body**, which is precisely the decisive
   criterion (switching ease is measured by how many places *interrogate* the
   regime, and this form reduces it to zero); it **names a fact currently mute** —
   `IMPL_MODEL` pretends there is an "implementation side" when in reality three
   roles happen to share a provider, so per-role makes the sharing visible as a
   *repeated value* rather than an *identity*; and intermediate configurations
   ("Planner on Opus, Implementer on GLM") cost nothing but a third table.

5. **D5 — the two sequential worktrees (ADR-0001 A2) are kept in both profiles,
   unconditionally.** See Consequences for the accepted cost.

6. **D6 — a single Opus model constant**, `OPUS_MODEL = "claude-opus-5"`, referenced
   by the provider descriptor, changeable in one word. Catalogue context at decision
   time: `claude-opus-5` is the current Opus, at the **same price** as 4.8 ($5/$25
   per MTok), 1M context, drop-in upgrade; `claude-opus-4-8` remains active (previous
   generation, not retired). Ids are exact as written, **without a date suffix**.
   There is a single `anthropic` provider entry, so profile `split` moves its
   reviewer from `claude-opus-4-8` to `claude-opus-5` as well.

7. **D7 — token validation at startup, restricted to the active profile's
   providers.** Walk the distinct providers the profile references, require each
   one's token, ignore the others. The error names both the profile and the key.

8. **D8 — ADR-0001 is amended, not rewritten.** It stays `Accepted`, with a
   one-line pointer on its invariant bullet. **Rejected: editing ADR-0001 in
   place** — an ADR is the record of a *dated* decision, and editing it erases the
   original reasoning, which here is valuable (the `resolveEnv` trap, the rejection
   of the blank-override alternative, the worktree-fallback verification in the
   minified dist) and remains entirely valid. **Rejected: an ADR-0002 that
   supersedes ADR-0001** — A2/S1 is not replaced, it is *generalised*.

   > **Invariant (conditional)** — in profile `split`, the reviewer must use a
   > different model than the implementer. In profile `opus`, that guarantee is
   > deliberately given up: review retains only context diversity (fresh context,
   > distinct prompt, isolated worktree). That is the assumed price of the profile;
   > profile `split` remains the nominal regime.

9. **D9 — no test seam, therefore no module extraction.** The only justification
   offered for extracting a `model-profile.ts` was testability. Everything stays
   inline in `main.ts`, and `SANDCASTLE_DRYRUN` serves as the verification.

## Vocabulary

| Term | Definition |
|---|---|
| **Model profile** (`profile`) | The table assigning a provider to each role. |
| **Provider** | The triplet {model id, base URL, token} — what gets baked into a `docker({env})`. |
| **Role** | planner / implementer / reviewer / merger. |

Not "mode": `CONTEXT.md` already reserves that word for *capture scope*, and reusing
it for a second concept in the same repo is exactly the collision a glossary exists
to prevent. These terms deliberately **do not go into `CONTEXT.md`** — that glossary
is the language of the ccsnoop product, and ADR-0001 declares itself out of that
scope. They live in this ADR and in the code.

## Consequences

- **+** Switching regime is one env var and touches no tracked file, so it cannot be
  committed by accident by a head-mode agent.
- **+** Both profiles traverse the **same** code path: no branch is exercised in one
  regime only, so a bug cannot hide in the regime you are not running.
- **+** Intermediate profiles (any role on any provider) are a table entry, not code.
- **+** A missing or expired token now fails on line one instead of after a full
  implementation cycle. Previously `need()` ran only when a sandbox started, so a
  bad `CLAUDE_CODE_OAUTH_TOKEN` surfaced at the Reviewer — at iteration N, per
  issue — and since review is best-effort (`catch` that logs and continues), the
  failure was **swallowed**: the run carried on, merged, and nobody saw that review
  never happened. Late *and* silent.
- **+** Profile `opus` no longer depends on a z.ai secret it never sends. Requiring a
  valid key for a provider a run never touches is gratuitous coupling — and exactly
  the kind of friction that stops people from switching.
- **−** In profile `opus`, both envs are identical, so the second worktree spin-up
  plus `npm ci` per issue buys nothing provider-side. Pure wall-clock cost, kept
  anyway: collapsing it would reintroduce an `if (sameProvider(…))` in the loop body
  (undoing D4), and the collapse is **not semantically neutral** — a fresh worktree
  checks out the branch *as committed*, whereas reusing the implementer's sandbox
  would hand the Reviewer its untracked files and dirty state. Since
  `review-prompt.md` works on `git diff main..HEAD`, review would stop being about
  "what landed on the branch" and become "what the implementer left lying around" —
  a silent drift visible only in all-Opus. ADR-0001 already lists this double
  `npm ci` as an accepted negative.
- **−** In profile `opus` the reviewer shares the implementer's blind spots by
  construction, and **no compensating mechanism** is added (no differentiated
  `effort`, no more adversarial review prompt). The degradation is named honestly
  and accepted.
- **−** `.sandcastle/` is outside `tsconfig.json`'s `include` (`["bin", "src",
  "test"]`), so this code is not covered by `npm run typecheck`. Known limit, left
  as is.

## References

- `.sandcastle/main.ts` — `PROVIDERS` / `PROFILES` tables, profile resolution,
  `validateTokens`, `envFor` / `modelFor`
- [ADR-0001](0001-sandcastle-cross-provider-split.md) — invariants A2 (two
  sequential worktrees) and S1 (one auth token per sandbox), both preserved
- `sandcastle-model-profiles.md` (repo root) — the full grilling record behind these
  nine decisions, including the rejected readings and the "reproduce elsewhere" recipe
