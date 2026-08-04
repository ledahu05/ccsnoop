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

