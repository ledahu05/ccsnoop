# `tuning-report/v1` — the machine-readable JSON contract

`ccsnoop fine-tune --json` emits a **stable, versioned JSON contract** instead of the
human-facing text table. It is the surface the [context-tuning skill](https://github.com/ledahu05/ccsnoop/issues/94)
(gap 2) consumes to drive ccsnoop programmatically — to read lever verdicts, decide
which to apply, and present a diff for approval.

```console
$ ccsnoop fine-tune --json            # the contract, byte-only (default)
$ ccsnoop fine-tune --json --include-tokens   # …plus primary-session token totals
```

The default text diagnostic + paste-ready `settings.json` block is **unchanged** when
`--json` is absent. The contract is the same data, structured for a machine.

> Origin: [issue #95](https://github.com/ledahu05/ccsnoop/issues/95) (skill gap 1),
> part of [epic #94](https://github.com/ledahu05/ccsnoop/issues/94). The four gaps a
> shipped emitter must close (from the validation prototype) are addressed below:
> **GAP A** (safe/advice split), **GAP B** (per-MCP-server bytes), **GAP C**
> (optional tokens), **GAP D** (scope honesty).

---

## Versioning & stability

Every report carries both:

- **`$schema`** — `https://ccsnoop.dev/schemas/tuning-report/v1.json`. The pinned URI
  of this contract version.
- **`schemaVersion`** — `1`. The integer a consumer pins. A skill reads
  `schemaVersion` first and refuses (or warns) on a version it does not know; it never
  guesses at unknown fields.

The contract is **additive**: a future `v2` may add fields, never silently remove or
rename a `v1` field. Breaking changes bump `schemaVersion` and the `$schema` URI. Pin
on `schemaVersion`, not on field absence.

### Changelog within `v1`

Additive changes keep `schemaVersion: 1`. A change that leaves a field *present but
meaning something narrower* is listed here, because pinning the version will not protect
a consumer from it.

| change | effect on a consumer |
| ------ | -------------------- |
| **[#116](https://github.com/ledahu05/ccsnoop/issues/116)** — `catalog` added; `safeLevers[mcp].shipped` **narrowed** to the connecting-servers sub-list. | ⚠ **Behavioural, not just additive.** `safeLevers[mcp].shipped` used to carry the *whole* deferred listing — the built-in tool names, and on some captures the agent-types and skills catalogs riding the same block. It now carries only the "MCP servers still connecting" sub-list, so **a session with no MCP server reports `0`** where it previously reported tens of kilobytes. That is the intended correction: no MCP setting could ever have recovered those bytes. A consumer that read `gain.mcp` / `safeLevers[mcp].shipped` to describe the catalog must read [`catalog`](#catalog) instead. **`totals.shipped` also GROWS**: the agent-types and skills catalogs ride `messages[0].content`, where the old model dropped them as conversation — they contributed zero. Naming them is what makes them countable (+7.8 KB on the reference capture). `totals.recoverable` is unaffected. |
| **[#117](https://github.com/ledahu05/ccsnoop/issues/117)** — the message surface is charged by **lever**, not by position; the header-less MCP fallback now needs the `<system-reminder>` envelope there. | Additive in the normal case, **narrowing in one**: a turn-1 *user message* that merely names an `mcp__<server>__<tool>` used to be swept into `safeLevers[mcp].shipped` by the coarse fallback, because the marker is a bare tool name with no header to key on. On the `messages[*]` surface that fallback is now trusted only inside the `<system-reminder>` envelope Claude Code wraps its injections in, so prose about an MCP tool contributes `0` instead of the whole message. A real listing — headers recognized, or an unrecognized one still wrapped — is unaffected, and the `system[]` surface is unchanged (nothing there is conversation). `totals.recoverable` can only shrink, never grow, from this. |

### Reuse by `floor --json`

The **envelope** is generic so [`ccsnoop floor`](../src/floor.js) (`#93`) can emit the
same envelope with a different `kind` once it lands:

```
$schema · schemaVersion · kind · unit · session · note · totals
```

`fine-tune` sets `kind: "tuning-report"`; `floor` would set e.g. `kind: "floor-report"`
reusing `$schema` / `schemaVersion` / `session` / `unit`. A consumer switches on `kind`.

### `tuning-session` — the before/after floor delta (`ccsnoop verify --json`)

[`ccsnoop verify`](../src/verify.js) (`#96`, part of `#94`) reuses the same envelope with
`kind: "tuning-session"` and `unit: "tokens"`. Given two captured sessions (a **before**
and an **after** — one tuning session), it computes the turn-1 floor ([`floor`](../src/floor.js),
`#99`) on each and diffs them, proving whether the tuning lowered the floor. ccsnoop
**emits** the pairing; it does not decide which two sessions pair (the skill in `#97` does).

```
{
  "$schema":       "https://ccsnoop.dev/schemas/tuning-report/v1.json",
  "schemaVersion": 1,
  "kind":          "tuning-session",
  "unit":          "tokens",
  "session":       { "before": <id>, "after": <id> },     // the durable pairing
  "window":        <tokens>,                               // scored identically on both sides
  "note":          "<real-tokens vs byte-proxy explanation>",
  "before":        { id, headline, attribution },          // each side IS a floor context
  "after":         { id, headline, attribution },
  "delta": {
    "tokens": { before, after, absolute, relative, source },  // real captured usage; null when a side has none
    "bytes":  { before, after, absolute, relative, source, blocks[] },  // byte proxy + per-block breakdown
    "verdict": "lowered" | "raised" | "flat",
    "basis":  "tokens" | "bytes"                              // bytes only when a side lacks usage
  }
}
```

- **`delta.tokens.absolute`** = `after − before` (negative ⇒ floor lowered); **`relative`**
  = `round(Δ / before * 100)`, `null` on a zero before baseline.
- **`delta.bytes.blocks[]`** matches contributors across the two floors
  (`{ kind, label, detail, beforeBytes, afterBytes, delta, direction }`), ranked by absolute
  change; `direction` is `grew` / `shrank` / `flat`.
- The token headline is real captured `usage` (never re-tokenized); every per-block figure
  is a labelled byte proxy. When one side has no captured usage, `delta.tokens.absolute` is
  `null` and the `verdict` falls back to the byte proxy (`basis: "bytes"`).

---

## The safe / advice split (GAP A — the contract's reason to exist)

The headline requirement. Today `fine-tune` builds one monolithic `settings.json` and
the **safe (auto-write) vs advice (paste-only)** distinction ([spec Part 3][spec] — a
lever's claim tracks its evidence: only levers with **dynamic proof** may say
"unused → remove") is implicit in the code path, never serialized. The skill cannot infer the tier from a
single block. So the contract produces the split **inside `fine-tune`**, in two mirrored
places:

| Tier | Levers | Why | settings key |
| ---- | ------ | --- | ------------ |
| **safe** (auto-writable) | `tools`, `mcp` | Carry **dynamic proof** — a pre-validated denylist; sent-vs-used across a corpus. May be auto-applied on approval. | `settings.auto` |
| **advice** (paste-only) | `hooks`, `claudeMd` | **No dynamic proof** — injected every session by construction. The skill surfaces them; it never writes them. | `settings.advice` |

- **`safeLevers`** — `[tools, mcp]`. Each entry has `tier: "safe"`.
- **`adviceLevers`** — `[hooks, claudeMd]`. Each entry has `tier: "advice"`.
- **`settings.auto`** — the keys the skill may **write** to `settings.json` on explicit
  approval of a presented diff (`permissions.deny`, `disabledMcpjsonServers`).
- **`settings.advice`** — the keys the skill must only surface **paste-ready**
  (`hooks.SessionStart`, `claudeMdExcludes`); never written.

**Invariant:** `settings.auto ∪ settings.advice` reconstructs the exact paste-ready
block the text renderer emits. The contract serializes a distinction the code already
makes — it does not invent a second block. (Asserted by the test suite.)

[spec]: fine-tune-spec.md

---

## Top-level shape

```
{
  "$schema":        "https://ccsnoop.dev/schemas/tuning-report/v1.json",
  "schemaVersion":  1,
  "kind":           "tuning-report",
  "unit":           "bytes",
  "session":        { id, requests, scope },
  "note":           "<byte-proxy + scope explanation>",
  "totals":         { shipped, recoverable },
  "floor":          { shipped, waste, action, note },
  "catalog":        { shipped, waste, action, note, populations[] },
  "safeLevers":     [ <tools>, <mcp> ],
  "adviceLevers":   [ <hooks>, <claudeMd> ],
  "settings":       { auto, advice },
  "tokens":         { input, output, cacheRead, cacheCreation, source }   // only with --include-tokens
}
```

### `session`

| field | meaning |
| ----- | ------- |
| `id` | the primary session id (latest, or the `--session` id). |
| `requests` | exchange count of the primary session. |
| `scope` | `"corpus"` (default) or `"single"`. Records whether MCP verdicts had corpus evidence; in `"single"` scope the MCP lever **never** denies. |

### `totals`

| field | meaning |
| ----- | ------- |
| `shipped` | Σ the lever-level `shipped` figures + `catalog` + the floor — gross per-request byte size, size context only. Note the scope: the MCP lever contributes its **connecting-servers sub-list** only, so per-server `mcp__*` tool-def bytes (`safeLevers[mcp].items[].shipped`) are *not* included here. Sum those separately if you want them. |
| `recoverable` | Σ `waste` over the **actionable** levers only (denied tools, MCP under guard, above-floor hooks, excludable-above-floor CLAUDE.md). The conservative, cache-aware headline. The floor and non-actionable waste are **never** counted. |

### `floor`

The incompressible harness `system[]` preamble — shown for context, never recoverable.
`waste` is `null` (a dash in the text table): the bytes are real but there is no "what
you'd stop re-paying" figure because the floor is never cut.

### `catalog`

The `<system-reminder>` catalogs Claude Code injects into the first user message: the
ToolSearch **deferred-tools** listing, the Agent-tool **agent types**, and the Skill-tool
**skills catalog**. Byte cost only — this section carries no `tier`, no `verdict` and no
settings key, because no lever acts on these populations yet
([ADR-0005](adr/0005-skills-catalog-lever-name-only.md) lever 5a is a later slice). None of
these bytes is in `totals.recoverable`.

| field | meaning |
| ----- | ------- |
| `shipped` / `waste` | Σ over the populations. |
| `action` | always `"none"` at this version. |
| `note` | says in words that this is cost, not a claim — and where these bytes used to be reported. |
| `populations` | one entry per population, `{ population, shipped, waste }`, **always all three**, in the order a block presents them: `deferred-tools`, `agent-types`, `skills-catalog`. A population absent from the capture is `0`, so "absent" is distinguishable from "unreported". |

---

## Lever entries

Every lever entry (in `safeLevers` / `adviceLevers`) carries the common fields:

| field | meaning |
| ----- | ------- |
| `lever` | `tools` / `mcp` / `hooks` / `claudeMd`. |
| `tier` | `safe` or `advice` (see the split above). |
| `verdict` | What `fine-tune` concludes: `deny` / `flag-only` / `remove` / `exclude` / `below-floor` / `none`. |
| `action` | The `settings.json` key this lever writes (`permissions.deny`, `disabledMcpjsonServers`, `hooks.SessionStart`, `claudeMdExcludes`). |
| `evidence` | Why the verdict holds — the proof (or its absence) behind the claim. |

Lever-specific fields follow.

### `tools` (safe)

`permissions.deny` = shipped ∩ built-in denylist (`data/builtin-denylist.json`). Always
emitted (spec §3.1); pre-validated by construction, so no threshold and no
false-positive guard.

- `names` — the denied tool names (denylist order; deterministic).
- `allowed` — names the run's `--deny-allow` override dropped: shipped tools the base
  denylist *would* have denied. Always present (`[]` when no override was used).
  **Read this before concluding "nothing intersects the denylist"** — a `verdict` of
  `none` with a non-empty `allowed` means the levers matched and were waived for the
  run, not that the session is clean.
- `items` — **every shipped built-in tool**, each `{ name, shipped, waste, deny }`.
  A name the gain model charged no bytes for still gets a `0/0` row, so
  `names ⊆ items` always holds.
  The gain model carries per-name bytes for *all* shipped tools, not just the denied
  ones — so a consumer sees the full picture plus which names are recoverable (`deny: true`).
  `mcp__*` tool defs are excluded (they belong to the MCP lever). Order: denied first
  (denylist order), then the rest alphabetically.

### `mcp` (safe)

`disabledMcpjsonServers` emits **only under the corpus guard**
(`sessionCount >= 3 AND calledCount == 0`); otherwise `flag-only`. Never denies in
single-session scope.

- `guard` — `{ sessionCount, minSessions, singleSession }`. The guard inputs, surfaced
  so a consumer can see *why* it did or did not fire.
- `names` — servers the guard clears for deny.
- `items` — per server `{ name, shipped, waste, shippedSessions, calledCount, deny }`.
- `scope` — **read this.** Deny verdicts are corpus-scoped; per-server `shipped`/`waste`
  are summed from `mcp__<server>__*` tool-def segments in the **primary session** (GAP B).
  Deferred servers ship **name-only**, so their per-server schema bytes are `0` —
  **unmeasured, not free** (GAP D). A naïve consumer must not read `0` as "costs nothing".
- lever-level `shipped`/`waste` — the **connecting-servers sub-list** of the deferred
  listing (one figure, distinct from the per-server tool-def sums). ⚠ **This narrowed in
  [#116](https://github.com/ledahu05/ccsnoop/issues/116)**: it used to be the *whole*
  deferred listing, built-in tool / agent / skill names included. A session with no MCP
  server now reports `0` here instead of tens of kilobytes. If you were reading this figure
  to talk about the catalog, read [`catalog`](#catalog) instead.

### `hooks` (advice)

`hooks.SessionStart` removal only when the injected output ≥ the floor (`floorBytes`).
**No dynamic proof** — injected every session — so it may say only "costs N bytes",
never "unused".

- `caveat` — `intent unknown — injected every session; review before applying`. Every
  emitted removal carries it; a guard expressed in words, not a confidence score.
- `floorBytes`, `aboveFloor`, `deny` — the floor decision.
- `shipped`/`waste` — the SessionStart hook output bytes.

### `claudeMd` (advice)

Per-source byte cost; `claudeMdExcludes` suggested **only** for excludable (non-managed)
sources above the floor. Never "unused".

- `floorBytes` — the floor gating the exclude suggestion.
- `names` — excludable sources the lever suggests excluding.
- `items` — per source `{ source, shipped, waste, excludable, deny, pctOfSystem }`.
  `source` is `null` for a managed/policy block (inexcludable → `deny: false`).

---

## `settings`

```
"settings": {
  "auto":   { "permissions": { "deny": [...] }, "disabledMcpjsonServers": [...] },  // safe — may write
  "advice": { "hooks": { "SessionStart": [] }, "claudeMdExcludes": [...] }          // advice — paste only
}
```

Key-presence rules (identical to the text renderer's block):

- `permissions.deny` — **always present** in `auto` (even when `[]`).
- `disabledMcpjsonServers` — only in `auto` when the guard denies ≥ 1 server.
- `hooks.SessionStart` — only in `advice` when the hook is above-floor.
- `claudeMdExcludes` — only in `advice` when ≥ 1 excludable source is above-floor.

The skill merges `settings.auto` into the project's `settings.json` on approval
(idempotent, strict read-modify-write — never overwrite, never touch `.ccsnoop/`
captures). `settings.advice` is rendered paste-ready for the human.

---

## `tokens` (GAP C — optional, opt-in)

Absent by default — the diagnostic is **byte-only by spec**. With `--include-tokens`,
a primary-session token total is backfilled from the **captured `usage`** already
attached to each exchange. **Never re-tokenized.**

```
"tokens": {
  "input":         <Σ input_tokens>,
  "output":        <Σ output_tokens>,
  "cacheRead":     <Σ cache_read_input_tokens>,
  "cacheCreation": <Σ cache_creation_input_tokens>,
  "source":        "primary-session captured usage (never re-tokenized)"
}
```

Tokens are a session-model figure, not a fine-tune figure — they are the *impact* the
byte levers act on, not the levers themselves. An exchange with no `usage` (aborted /
error) contributes nothing.

---

## Worked example (committed fixture, abridged)

```json
{
  "$schema": "https://ccsnoop.dev/schemas/tuning-report/v1.json",
  "schemaVersion": 1,
  "kind": "tuning-report",
  "unit": "bytes",
  "session": { "id": "session-963204f5…", "requests": 6, "scope": "corpus" },
  "totals": { "shipped": 104328, "recoverable": 0 },
  "floor":  { "shipped": 28394, "waste": null, "action": "none",
              "note": "Incompressible harness system[] preamble — shown for context, never recoverable." },
  "safeLevers": [
    {
      "lever": "tools", "tier": "safe", "verdict": "deny", "action": "permissions.deny",
      "evidence": "shipped ∩ built-in denylist (data/builtin-denylist.json) — pre-validated by construction; …",
      "shipped": 57509, "waste": 0,
      "names": ["Workflow", "ScheduleWakeup", "ReportFindings"], "allowed": [],
      "items": [
        { "name": "Workflow", "shipped": 21525, "waste": 0, "deny": true },
        { "name": "Bash", "shipped": 11694, "waste": 0, "deny": false }
      ]
    },
    {
      "lever": "mcp", "tier": "safe", "verdict": "flag-only", "action": "disabledMcpjsonServers",
      "evidence": "corpus guard: sessionCount >= 3 AND calledCount == 0. …",
      "guard": { "sessionCount": 1, "minSessions": 3, "singleSession": false },
      "scope": "Deny verdicts are corpus-scoped; per-server shipped/waste are summed from mcp__<server>__* …",
      "shipped": 1001, "waste": 0, "names": [],
      "items": [{ "name": "stub", "shipped": 0, "waste": 0, "shippedSessions": 1, "calledCount": 0, "deny": false }]
    }
  ],
  "adviceLevers": [
    {
      "lever": "hooks", "tier": "advice", "verdict": "remove", "action": "hooks.SessionStart",
      "evidence": "No dynamic proof — injected every session by construction; cost only, never \"unused\".",
      "caveat": "intent unknown — injected every session; review before applying",
      "floorBytes": 4096, "aboveFloor": true, "shipped": 8425, "waste": 0, "deny": true
    },
    {
      "lever": "claudeMd", "tier": "advice", "verdict": "exclude", "action": "claudeMdExcludes",
      "evidence": "No dynamic proof — … claudeMdExcludes is suggested only for excludable (non-managed) sources above the floor.",
      "floorBytes": 4096, "shipped": 8999, "waste": 0,
      "names": ["…/cwd/CLAUDE.md"],
      "items": [{ "source": "…/cwd/CLAUDE.md", "shipped": 8999, "waste": 0, "excludable": true, "deny": true, "pctOfSystem": 16 }]
    }
  ],
  "settings": {
    "auto":   { "permissions": { "deny": ["Workflow", "ScheduleWakeup", "ReportFindings"] } },
    "advice": { "hooks": { "SessionStart": [] }, "claudeMdExcludes": ["…/cwd/CLAUDE.md"] }
  }
}
```

---

## See also

- [`fine-tune.md`](fine-tune.md) — the human-facing diagnostic this contract mirrors.
- [`fine-tune-spec.md`](fine-tune-spec.md) — the full design (levers, gain model, guards).
- [`src/finetune-json.js`](../src/finetune-json.js) — `buildJsonReport`, the pure builder.
