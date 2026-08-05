# ccsnoop

A tool that intercepts raw Claude Code → Anthropic requests/responses via a localhost reverse-proxy daemon and renders them as a static HTML report. This glossary is the shared language for its install & lifecycle surface.

## Language

**Capture scope**:
Whether ccsnoop is activated for a single repo (project) or the whole machine (user). Project scope wins when both are set. Decides which capture root a repo's traffic routes to.
_Avoid_: mode, level

**Capture root**:
The `.ccsnoop/` directory a scope's captures land in — `<repo>/.ccsnoop/` for project scope, `~/.ccsnoop/` for user scope. Holds `sessions/<session_id>/` inside it.
_Avoid_: capture dir, output dir, store

**Route token**:
The short, idempotent id (`sha256(<abs capture root>)[:8]`) carried in the `ANTHROPIC_BASE_URL` path that the daemon resolves to a capture root. Not a secret — localhost-only.
_Avoid_: route id, key, slug

**Routes registry**:
The machine-level file `~/.ccsnoop/routes.json` mapping route token → capture root. Written (upsert) by `ccsnoop init`, read by the daemon per request.
_Avoid_: config, routing table

## Discipline & instruments

**Context tuning**:
The discipline of measuring then trimming what Claude Code ships in every request — `settings.json`, CLAUDE.md, MCP servers, hooks, the tool set — so less of the context window is spent on payload that does no work. The goal of the publishable skill.
_Avoid_: fine-tuning, optimization, calibration

**Diagnostic surface**:
An offline reader of captures that turns the raw bytes into one cut of context-tuning evidence (e.g. `report`, `fine-tune`, `cache`, and the proposed `floor`, `cost`, `audit`). An *instrument* of context tuning, never the whole answer.
_Avoid_: command, feature, tool

**Model fine-tuning (ML)**:
Training a model's weights. The explicit antagonist — *not* what ccsnoop does. Listed only to disambiguate "fine-tune", which ccsnoop overloads.
_Avoid_: (none — kept as the canonical name for the thing we do not mean)

**Context-tuning skill**:
The project-installable orchestration that drives the context-tuning loop — capture → diagnose → apply → verify — over ccsnoop. A thin layer on top of ccsnoop: it does not re-measure, it drives the instrument. Project-scoped: `ccsnoop skill install` drops it into a repo's `.claude/skills/context-tuning/`; it consumes `fine-tune --json` (#95) and delegates apply (#98) and verify (#96) to the CLI.
_Avoid_: the plugin, the wrapper, the extension

**Bootstrap state**:
The four-state gate the skill detects before entering the loop — `absent` (ccsnoop not on PATH → point to install), `daemon-down` (`status` down → `start`), `un-init` (no route for this repo → `init` + restart), `ready` (enter the loop). The detector is standalone (node builtins only) and points, never executes installs. Lives in `skill/scripts/bootstrap.mjs`.
_Avoid_: doctor, health-check, readiness

**Safe lever**:
A context-tuning lever with *dynamic proof* of disuse (a built-in tool never called, an MCP server never invoked). Reversible, so the skill may auto-apply it on explicit approval of a presented diff.
_Avoid_: proven lever, auto lever

**Advice lever**:
A lever *without* dynamic proof (SessionStart hook output, CLAUDE.md content) — its output is injected every session by construction, so cost is known but disuse is not. Advice-only: the skill prepares a paste-ready block, never writes it.
_Avoid_: manual lever

**Tuning session**:
A before/after pair of captures linked across the restart that applies a tuning — the unit of *"did this tuning actually lower the floor?"* Without it, there is no verify step, only guesswork.
_Avoid_: tuning run, A/B pair

## Fine-tune authority (ADR-0004)

**Safe tier** (auto-writable):
A fine-tune lever that carries **dynamic proof** of waste — the built-in tools lever (`permissions.deny`: shipped ∩ the pre-validated denylist ∩ uncalled) and the MCP lever (`disabledMcpjsonServers`: shipped across ≥ 3 sessions and never called, under the T4 guard). `ccsnoop apply` may write these to `.claude/settings.json` on approval of a presented diff. Serialized as `safeLevers` / `settings.auto` in the `--json` contract (#95).
_Avoid_: confirmed tier, applied tier

**Advice tier** (paste-only):
A fine-tune lever with **no dynamic proof** — the SessionStart hooks lever (`hooks.SessionStart`) and the CLAUDE.md lever (`claudeMdExcludes`), both injected every session by construction so their bytes can never prove disuse. `ccsnoop apply` surfaces these as a paste-ready block and **never writes them**. Serialized as `adviceLevers` / `settings.advice` in the contract.
_Avoid_: unconfirmed tier, manual tier

**Apply**:
The tiered-apply glue (`ccsnoop apply` / `src/apply.js`, #98) that turns a `fine-tune --json` report into action under ADR-0004: presents a diff of the safe-subset `settings.json` changes, writes ONLY the safe subset on explicit approval (`--yes`) via an idempotent read-modify-write merge (merge, never overwrite; refuse foreign keys; never touch `.ccsnoop/`), emits the advice levers as paste-only output, and emits a restart reminder after any write. Consumes the contract's tier split directly — does not re-derive tiers.
_Avoid_: auto-tuner, settings patcher
