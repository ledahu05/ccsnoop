# ccsnoop fine-tune — hand-off spec

A `fine-tune` subcommand that turns captured Claude Code → Anthropic traffic into a **byte-accounted diagnostic + a paste-ready `settings.json` block**, so a user can cut the static bloat that rides every `/v1/messages` request. It analyses the **four bloat levers** — built-in tools, SessionStart hooks, CLAUDE.md, MCP — combining **static heuristics** (what's shipped) with **dynamic proof** (what was actually called).

This is a **spec for a builder** — no code ships from the planning effort behind it. It compiles the [fine-tune wayfinder map](https://github.com/ledahu05/ccsnoop/issues/29) with its closed tickets T1–T7 (#30–#35, #55). Each section links the ticket that owns the detail. Where this spec and a ticket disagree, the ticket's resolution comment is authoritative.

## Scope & non-negotiables

- **Bytes, never tokens.** A byte-length proxy only — *never re-tokenize*. Gains are expressed in **bytes** via `Segment.bytes`. (Map Notes; spec §2.4b honoured by `src/waste.js`.)
- **Four levers:** built-in tools, SessionStart hooks, CLAUDE.md, MCP. A fifth lever — `anthropic-beta` / context-management / thinking headers — is **out of scope** for this effort (deferred; would start a fresh map).
- **Reuses, doesn't rebuild:** the segmentation of `src/waste.js` and the session loader / CLI dispatch of `src/report.js` + `bin/ccsnoop.js`. The one new substrate is **parsing the responses** for `tool_use` (waste.js reads only requests).
- **Output is advice-to-copy, never auto-applied.** A human reviews and pastes the `settings.json` block.

## Proof base

`omniris_tuning.md` (repo root) — a real captured omniris session (session `309efa6b`, opus-5, CC v2.1.220): ~28K of 32K tokens/request is config, not conversation; tools=44%, with a per-lever breakdown and a reference `settings.json`. The numbers in the mockups below are illustrative from that session; the implementation emits real bytes via `Segment.bytes`.

## Architecture

```
sessions/<id>/  ──▶ loadSession (report.js)  ──▶  per-exchange segments (waste.js)
                          │                              │
                          │   NEW: decode .response.sse  │   tool:/system:/… slots
                          │   → set of tool_use names    │   + Segment.bytes + cache kind
                          ▼                              ▼
                   corpus aggregator (T4)        lever attribution (T5/T6)
                   (union shipped/called            (split system bucket by source)
                    across sessions)
                          │
                          ▼
                   fine-tune renderer ──▶ CLI text diagnostic + paste-ready settings.json
```

`fine-tune` is a pure consumer of captured sessions, like `report`. All structure is derived at run time from `sessions/<id>/`; nothing is stored beyond what capture already writes.

---

## Part 1 — CLI surface (T4)

Mirror the `report` subcommand exactly — **flags only, no positional** (T4):

```
ccsnoop fine-tune                      # corpus: all sessions under resolved roots
ccsnoop fine-tune --session <id>       # one session (weak-evidence mode)
ccsnoop fine-tune --latest             # most-recent session
ccsnoop fine-tune --root <path>        # non-default capture root
ccsnoop fine-tune --sessions-dir <path>
ccsnoop fine-tune --deny-extra <a,b>   # T7: add names for this run only
ccsnoop fine-tune --deny-allow <a>     # T7: drop a name for this run only
```

- **Default scope = corpus** (T4): analyse **all** sessions under the resolved roots (`<cwd>/.ccsnoop/` by default, same roots as `report`). Reuse `listSessions` / `pickLatestSession` / root resolution. Aggregation is computed **on the fly each run** — no cache, no persistence (the corpus-mechanism fog graduated to this decision).
- **Single-session mode** (`--session` / `--latest`) is the weak-evidence path: the MCP lever does **not** emit a deny in this mode (a single session is too thin for global config).
- Insert into `bin/ccsnoop.js` via `SUBCOMMANDS` + a `runFineTune(args)` dispatch, modelled on `runReport`.

> Detail: [#33 (T4)](https://github.com/ledahu05/ccsnoop/issues/33).

---

## Part 2 — The seam & the new substrate (T3, T2)

### 2.1 Reuse `waste.js` segmentation

`fine-tune` reuses `loadSession` (report.js) + `segmentRequest` (waste.js). Each request is segmented into `system` / `tools` / `history` / `currentTurn`; every `Segment` carries `.bytes` (canonical byte length) and, after `classifySegments`, a cache `.kind` of `new` / `reused-cached` / `reused-uncached`. Per-tool cost in bytes is already available via the `tool:<name>` slot.

> Detail: [#32 (T3)](https://github.com/ledahu05/ccsnoop/issues/32).

### 2.2 The gap: parse the responses for `tool_use`

waste.js reads **requests** (re-sent / bloat / static). The *actually-used* signal lives in the **responses**: a tool is "used" iff its name appears as a `content_block.name` of a `tool_use` in a response. So `fine-tune` must:

1. Decode each session's `.response.sse` (gzip) → collect the set of **called** tool names across the corpus.
2. Parse the **deferred MCP listing** (T2): MCP servers are shipped as **name-only** inside a `<system-reminder>`, not as full schemas in `tools[]`.
3. Compute `shipped − used` per name.

Two classes of shipped tool (T2):
- **Non-deferred** — schema present in `tools[]` (built-in tools; some MCP).
- **Deferred** — name only, inside `<system-reminder>` (the MCP listing).

> Detail: [#31 (T2)](https://github.com/ledahu05/ccsnoop/issues/31).

### 2.3 Lever attribution — split the `system` bucket by source (T5→T6)

The one segmentation extension `fine-tune` adds: the `system` bucket mixes CLAUDE.md, SessionStart-hook output, the catalogs Claude Code injects, and the CC harness. **Split it by source** using content + order (the omniris capture confirms these arrive as distinct system blocks/messages). Map each system segment to a lever:

- **CLAUDE.md** — per source file (global `~/.claude/CLAUDE.md`, project `./CLAUDE.md`, memory files) when attribution supports it, else the CLAUDE.md-derived block as a whole.
- **SessionStart hook output** — the injected message (e.g. CAVEMAN+PONYTAIL).
- **MCP deferred listing** — the *"MCP servers still connecting"* sub-list. Feeds the MCP lever (§3.4).
- **The three catalogs** — the ToolSearch **deferred-tools** listing, the Agent-tool **agent types**, the Skill-tool **skills catalog**. Byte cost only for now (no lever acts on them; [ADR-0005](adr/0005-skills-catalog-lever-name-only.md) lever 5a is the future action).
- **CC harness** (`system[2]`-style) — **incompressible floor, not actionable** (~2.7K on omniris). Shown in the diagnostic, never emitted.

**One authority, span-based.** A single block can carry several of these — the connecting-servers sub-list rides *inside* the deferred-tools listing, and a combined `<system-reminder>` can hold all three catalogs. `classifySystemSpans` (`src/finetune-system.js`) is the only place that decides which lever owns which bytes; `src/floor-catalog.js` consumes it rather than doubling the detection. The spans **tile** their block — their bytes sum to its canonical byte length — so a split never invents or loses a byte. Seven levers: `claude-md`, `hook`, `mcp-deferred`, `deferred-tools`, `skills-catalog`, `agent-types`, `harness`.

> ⚠ **`mcp-deferred` narrowed in [#116](https://github.com/ledahu05/ccsnoop/issues/116).** It used to swallow the entire deferred listing, so a repo with **no MCP server at all** was told it shipped ~30 KB of "MCP". It now means the connecting-servers sub-list and nothing else, and such a repo reports **zero** `mcp-deferred` bytes. See the [`tuning-report` v1 changelog](tuning-report-schema.md#changelog-within-v1).

> Detail (decision): [#35 (T6)](https://github.com/ledahu05/ccsnoop/issues/35) (D2+D5, escalated by [#34 T5](https://github.com/ledahu05/ccsnoop/issues/34)).

---

## Part 3 — Lever emission policy & guards (T5)

**Unifying principle:** the strength of `fine-tune`'s claim tracks the evidence available per lever. Only levers **with dynamic proof** (built-in tools = pre-validated list; MCP = sent-vs-used) may say *"unused → remove"*. Levers **without dynamic proof** (hooks, CLAUDE.md — their output is injected every session by construction) may say only *"costs N bytes"* — never "unused." Uncertainty is signalled by (a) the word chosen (*costs* vs *unused*), (b) the proof counts shown in the diagnostic, and (c) an explicit caveat on hooks.

### 3.1 Built-in tools — always emit `permissions.deny` (T1, T7)

Emit `permissions.deny` = `intersection(session tools[], predefined denylist)`. No threshold, no false-positive guard — the list is pre-validated by construction.

### 3.2 MCP — deny only under the corpus guard (T4, T5)

Emit `disabledMcpjsonServers` / `disableClaudeAiConnectors` (keys per T1) **only when**:

```
corpus.sessionCount >= 3  AND  calledCount(server) == 0
```

Binary on absence: called even once → *used* → never "never used." No percentage, no recency window (capture is opportunistic; a time threshold would dress up precision the data doesn't have). Otherwise: **flag-only** — the diagnostic shows, per shipped MCP, `sessionCount` + `calledCount`. In single-session mode: **no MCP deny**, flag-only.

### 3.3 SessionStart hooks — cost-thresholded + "intent unknown" caveat (T5)

Emit removal of `hooks.SessionStart` **only when the injected output ≥ `bloatFloorBytes`** (the existing waste.js floor — one threshold knob, consistent with how bloat is already gated). Below the floor: diagnostic-only, not emitted. The guard is a **caveat, not a confidence threshold** (no confidence signal exists): every emitted hook removal carries the diagnostic marker *"intent unknown — injected every session; review before applying"*; never called "unused."

### 3.4 CLAUDE.md — advice only (T5)

No `settings.json` line that trims content (impossible). Per source file: show byte cost + `% of system bucket`. Suggest `claudeMdExcludes` **only for excludable (non-managed) files above the floor**; managed files → cost only, no exclude suggestion. Never "unused."

> Detail: [#34 (T5)](https://github.com/ledahu05/ccsnoop/issues/34). Keys: [#30 (T1)](https://github.com/ledahu05/ccsnoop/issues/30).

### 3.5 Threshold knobs

A single reused cost floor (`bloatFloorBytes`, existing) gates hooks + CLAUDE.md. The T4 corpus guard gates MCP. **No new thresholds.**

---

## Part 4 — The denylist (T7)

**Location:** versioned data file `data/builtin-denylist.json` — **not** a hardcoded constant. Each entry is an object `{name, category, note}` so the diagnostic can show a reason; only `name` is emitted (bare names, T1).

**Inclusion criterion:** built-in tools that (a) are **not core primitives** (Read/Write/Edit/Bash/Grep/Glob/TodoWrite/… — *never* in the list), and (b) are **opt-in by contract** — their own description gates invocation behind explicit user instruction ("use this tool ONLY when explicitly instructed … by the user directly, or by project instructions"). This is verifiable at a glance from the description, depends on no byte threshold, and is distinct from a "big and rarely useful" judgment: schema heaviness is the *symptom* that surfaces a candidate (orchestration, artifact publishing, scheduling, structured UI, review output, worktree isolation), not the test. Whoever needs such a tool knows to ask for it — and knows to drop the deny line. (`TodoWrite` is excluded — a universal tracking primitive, not opt-in by contract.)

**v1 content (10 entries):**

| name | category | note |
|------|----------|------|
| Workflow | orchestration | multi-agent / ultracode |
| Artifact | publication | HTML render |
| AskUserQuestion | structured UI | structured prompts |
| ScheduleWakeup | scheduling | /loop self-pacing |
| ReportFindings | review output | code-review |
| EnterWorktree | isolation | opt-in by contract — explicit user instruction required |
| CronCreate | scheduling | cron jobs |
| CronDelete | scheduling | cron jobs |
| CronList | scheduling | cron jobs |
| RemoteTrigger | scheduling | remote trigger |

> **Note on the deferred scheduling entries.** `CronCreate`, `CronDelete`, `CronList`, and `RemoteTrigger` ship **name-only** in the deferred-tools listing (a `<system-reminder>`), not as schemas in `tools[]`. The lever-1 intersection (`shipped ∩ denylist`) reads only `tools[]`, so it **cannot structurally reach them** — they never appear in `shipped`, hence never in `permissions.deny`. They are kept as forward-markers (a future deferred-listing lever would name them) rather than removed, and noted here so the list does not imply a lever-1 gain it does not produce. See [#108](https://github.com/ledahu05/ccsnoop/issues/108).

**Override — two paths, no new config schema:**
1. **Persistent** — edit `data/builtin-denylist.json` in your checkout (it is the source of truth).
2. **One-off run** — `--deny-extra <a,b>` (add) / `--deny-allow <a>` (drop) flags.

No persisted config key in v1; if the need emerges it graduates from fog.

> Detail: [#55 (T7)](https://github.com/ledahu05/ccsnoop/issues/55).

---

## Part 5 — Output shape: diagnostic + `settings.json` block (T6)

**Diagnostic = CLI text, not HTML** (`report` stays HTML; `fine-tune` is a quick CLI read). Per-lever table with columns `shipped` / `waste` / `action`, totals, headline recoverable bytes, a one-line cache caveat, then the settings block.

**Gain method — two byte figures per lever, via `Segment.bytes`:**
- **`shipped`** — gross bytes the lever contributes across the corpus (what travels on the wire on each request it appears in).
- **`waste`** — the **reused-uncached** portion (bytes actually *re-paid* after a cache break), already classified by waste.js.

**Headline recoverable = Σ `waste`** (conservative, cache-aware). `shipped` is shown as size context. A caveat notes that cutting a lever may *also* restore cache hits for the rest — a second-order effect not modelled (don't over-promise). This honours "bytes only" without lying about caching.

**`settings.json` block:** valid, pure, paste-ready JSON; ordered by lever; emits only keys with ≥1 actionable item; MCP deny only under the T4 guard; **no JSON comments** (caveats live in the diagnostic text, not the block). A single *"applying this invalidates the cache"* warning is printed above the block (changing `tools[]` breaks the cache prefix).

**Mockup** (figures illustrative from omniris; the impl emits real bytes):

```
ccsnoop fine-tune — ./.ccsnoop/  (3 sessions, 24 requêtes)

Levier                 shipped   waste   action
─────────────────────────────────────────────────────────────
tools   Workflow         5.3K    1.1K   deny ✓
tools   Artifact         2.6K    0.5K   deny ✓
tools   AskUserQuestion  1.3K    0.3K   deny ✓
MCP     Atlassian        2.4K      0    flag (appelé 0/3)   ← sous garde T4
hooks   CAVEMAN+PONYTAIL 5.8K    5.8K   remove ⚠ intention inconnue
CLAUDE.md  projet        3.1K    3.1K   advice (excludable)
CLAUDE.md  global        2.6K    2.6K   advice (excludable)
─────────────────────────────────────────────────────────────
harness system[2]        2.7K      —    plancher incompressible (non actionnable)
─────────────────────────────────────────────────────────────
Total                   25.8K   16.4K

Récupérable (waste, conservateur) : ~16.4K octets sur le corpus
Cache : <shipped> voyage à chaque requête ; <waste> est ce qui est re-payé
        après rupture de cache. Couper un levier peut aussi restaurer des
        hits (non modélisé).

⚠ Appliquer ce bloc invalide le cache (tools[] change → prefix cassé).
settings.json (à copier) :
{
  "permissions": { "deny": ["Workflow", "Artifact", "AskUserQuestion"] },
  "disabledMcpjsonServers": [],
  "hooks": { "SessionStart": [] },
  "claudeMdExcludes": ["./CLAUDE.md"]
}
```

> Detail: [#35 (T6)](https://github.com/ledahu05/ccsnoop/issues/35).

---

## Part 6 — Acceptance (builder's checklist)

- [ ] `ccsnoop fine-tune` runs corpus-scan by default; `--session` / `--latest` / `--root` / `--sessions-dir` work; `--deny-extra` / `--deny-allow` override for the run.
- [ ] Responses are decoded: a `tool_use` name set is derived per session and aggregated across the corpus.
- [ ] The `system` bucket is split by source (CLAUDE.md per file / hook / MCP-deferred / harness); harness is shown as incompressible floor.
- [ ] Built-in tools: emits `permissions.deny` = intersection with `data/builtin-denylist.json`, always.
- [ ] MCP: emits deny iff `sessionCount>=3 AND calledCount==0`; flag-only otherwise; no deny in single-session mode.
- [ ] Hooks: emits removal only when output ≥ `bloatFloorBytes`; carries the "intent unknown" caveat.
- [ ] CLAUDE.md: advice-only, per source file, `claudeMdExcludes` only for excludable files above the floor.
- [ ] Diagnostic shows `shipped` + `waste` per lever, totals, headline Σ `waste`, cache caveat, cache-invalidation warning, and a paste-ready pure-JSON block.
- [ ] **Never re-tokenizes** — all figures are byte-lengths via `Segment.bytes`.

## Out of scope

- **5th lever — headers/betas** (`anthropic-beta`, context-management, thinking). Deferred; would start a fresh wayfinder effort if wanted.
- Live/real-time viewing, other providers/harnesses, auto-applying the settings block.
