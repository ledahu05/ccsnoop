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
