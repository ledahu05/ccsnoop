# ADR-0005: Lever 5 trims the skills catalog to `name-only`, and splits on who can be overridden

- **Status**: Accepted
- **Date**: 2026-08-07
- **Context**: ccsnoop fine-tune — the skills catalog is the first line item of the turn-1 floor
- **Ticket**: [#105](https://github.com/ledahu05/ccsnoop/issues/105); builds on [#109](https://github.com/ledahu05/ccsnoop/issues/109) (floor ventilation), governed by [ADR-0004](./0004-skill-auto-applies-safe-levers.md)
- **Confirmed**: [#115](https://github.com/ledahu05/ccsnoop/issues/115) —
  [`docs/research/skill-overrides-name-only.md`](../research/skill-overrides-name-only.md). The
  three binary reads below hold on the bench-pinned `2.1.220` as well as on `2.1.224`, and the
  action was measured on the wire: a `name-only` entry falls to exactly its name line
  (`dataviz` 1 157 → 10 B), with no residue. Two amendments from that measurement: the symbol
  names quoted here (`p4e`, `ho`, `O4_`) are `2.1.224`'s, not `2.1.220`'s (same code, different
  minifier output); and `disableBundledSkills` drops bundled skills from the **slash-command**
  list too, not only from the model's — so lever 5b must present it as losing `/name` as well.

## Context

On a real repo with **no MCP server at all**, `floor` attributed 29 628 bytes — 29 % of a
41 979-token turn-1 floor — to a block labelled `mcp-deferred`. The label was a
catch-all: the block is the whole deferred listing, and its bulk is the **skills
catalog**, every skill shipping its name *and its full description* on turn 1. The MCP
lever measured those bytes and could name nothing in them, sending the user hunting for
a server that does not exist.

Issue #109 fixed the *display* (`src/floor-catalog.js` ventilates the block into
`deferred-tools` / `agent-types` / `skills-catalog`). This ADR settles the *lever*: is
there a fifth fine-tune lever over the skills catalog, what does it write, and which
ADR-0004 tier does it land in?

Three facts read off the Claude Code binary (v2.1.220 build family) decide it.

1. **`skillOverrides` is a real `settings.json` key**, sibling to
   `disabledMcpjsonServers` in the same schema block:

   ```
   skillOverrides: record(enum(["on","name-only","user-invocable-only","off"])).optional()
     .describe('Per-skill listing overrides keyed by skill name.
                "name-only" lists the skill without its description;
                "user-invocable-only" hides it from the model but keeps /name; "off" …')
   ```

2. **Plugin skills are exempt from it.** The resolver returns `"on"` unconditionally for
   `source === "plugin"`, so no `skillOverrides` entry can reach a plugin skill. The only
   knob that does is `enabledPlugins` — whole-plugin, coarse.

3. **Bundled (harness) skills are *not* incompressible.** `disableBundledSkills` is a
   settings key (and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`), and per-name
   `skillOverrides` entries reach bundled skills too.

Fact 1 is the one that breaks ADR-0004's binary premise. That ADR sorted levers by
whether a false positive is *bounded* (the thing provably wasn't used → removing it is
safe) or *unbounded* (the thing is load-bearing for reasons bytes can't see). It assumed
the action is always removal. `name-only` is a third action: **keep the skill fully
invocable, stop paying for its description**.

## Decision

**Lever 5 exists, its action is `name-only`, and it splits in two on overridability.**

1. **The action is `name-only`, never `off`.** A verdict says *"this skill shipped its
   description across N sessions and the model never invoked it → set it to
   `name-only`."* The name (~15 bytes) stays in the catalog; the description — the
   dominant term — stops shipping. `off` and `user-invocable-only` are never emitted.

   This is what makes the false positive bounded. The classic objection to disabling a
   skill — *the one you didn't use for five sessions is exactly the one you want on the
   sixth* — is fatal to `off` and merely inconvenient under `name-only`: the skill is
   still there, `/name` still works, and an explicit "use the X skill" still works. Only
   unprompted discoverability degrades. Claude Code itself already performs exactly this
   degradation when its own listing budget overflows (`cappedSkills` /
   `budgetTruncatedSkills`, biggest entries first) — the lever makes an implicit harness
   decision explicit and evidence-driven.

2. **Lever 5a — `skillOverrides` population: safe tier.** User, project and bundled
   skills. Dynamic proof of the same shape as the MCP lever (shipped across the corpus,
   never invoked), a bounded action, one reversible settings key. `ccsnoop apply` may
   write it on approval of a presented diff.

3. **Lever 5b — plugin skills: advice tier.** The only available action is disabling the
   whole plugin via `enabledPlugins`, which takes down parts of the plugin that may be in
   active use. The action is unbounded even where the evidence is good, so ADR-0004
   forbids auto-apply: measured and surfaced, never written.

4. **The disuse predicate is "never invoked *by the model*".** A `Skill` tool-use in the
   corpus is use; a user typing `/name` is **not**. `name-only` leaves `/name` untouched,
   so a user-invoked-only skill is precisely a skill whose description bought nothing.
   This is strictly more permissive than sent-vs-used and still sound. Skills carrying
   `disable-model-invocation: true` never enter the catalog and are out of scope by
   construction.

5. **The guard is the existing one: ≥ 3 sessions, `singleSession: false`.** Reused
   verbatim from the MCP lever. Same evidence shape, so no new threshold knob.

6. **The verdict emits every qualifying skill, ranked bytes-descending, in one diff.**
   Breadth is not a hazard here — it is the recovery. The action is bounded per entry and
   the whole thing reverts by deleting one key.

7. **No description-length threshold.** `name-only` already *is* the "this description is
   too expensive" remedy, and it carries proof. Flagging a long description on a skill
   the model *does* invoke would be advice with no proof, which ADR-0004 bars from the
   safe tier and which adds noise to the advice tier. Per-skill bytes appear as a ranked
   cost line in `floor --detail`; `fine-tune` stays silent about skills in use.

8. **Duplicates are reported, never actioned, and only on exact unqualified-name
   collision.** `tdd` ↔ `tdd` is a fact; `diagnose` ↔ `diagnosing-bugs` is a judgment no
   byte-counter can make, and asserting it would be exactly the unproven advice ADR-0004
   exists to prevent. Measure before claiming: Claude Code already drops shadowed skills
   (`dropShadowedBundledSkills`, `dropShadowedFallbackSkills`), so a collision may cost
   nothing at all.

## Consequences

- **`safeMergeSettings` gains an object branch.** Every safe key today
  (`permissions.deny`, `disabledMcpjsonServers`) is an array unioned into place.
  `skillOverrides` is a `Record<string, enum>`. The idempotent read-modify-write merge in
  `src/apply.js` has no path for a map, and adding one must preserve the existing
  refuse-foreign-keys guarantee (values are constrained to the four-member enum).

- **The classifier layering inverts.** `src/floor-catalog.js` currently *consumes*
  `classifySystemBlock`. The catalog header detection moves *down* into
  `src/finetune-system.js` so there is one authority for "which lever is this block", and
  `floor-catalog.js` consumes it. `SYSTEM_LEVERS` grows from four to seven: `claude-md`,
  `hook`, `mcp-deferred`, `deferred-tools`, `skills-catalog`, `agent-types`, `harness`.

- **`mcp-deferred` narrows to its true meaning** — the connecting-servers sub-list —
  which retires the catch-all label at the *model* level, not just in `floor`'s display.
  A repo with no MCP server will now report zero `mcp-deferred` bytes, as it should.

- **`chargeExchange` must charge the message surface.** Catalog blocks arrive in
  `messages[0].content`; the gain model charges `harness` only on the `system` surface,
  so today they are dropped as conversation and contribute zero. Widening this is what
  makes the skills bytes visible to `fine-tune` at all.

- **Point 7 of the issue is answered in the negative.** Bundled skills belong in
  `recoverable`, not the incompressible floor. `disableBundledSkills` is offered as an
  advice-tier bulk action when the entire bundled population shows no model invocation.

- **ADR-0004's two-tier model survives, with its axis restated.** The tier is set by
  whether a false positive is *bounded*, and dynamic proof is how boundedness is usually
  established — but the *action's* reach matters too. Lever 5b has proof and is still
  advice; lever 5a is safe partly because `name-only` is a gentler action than removal.
