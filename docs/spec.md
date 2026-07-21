# ccsnoop — hand-off spec

Snoop raw **Claude Code → Anthropic** traffic: **capture** the exchanges byte-faithfully, then render them as a **static HTML report** that makes context-window growth, the model/harness boundary, and token waste legible.

This is a **spec for a builder** — no code ships from the planning effort behind it. It is the compiled result of the [ccsnoop wayfinder map](https://github.com/ledahu05/ccsnoop/issues/1) and its closed decision tickets (#2–#7); each section links the ticket that owns the detail. Where this spec and a ticket disagree, the ticket's resolution comment is authoritative.

## Scope

- **One harness, one provider:** Claude Code → `api.anthropic.com`. Nothing else.
- **Two components:** a **capture proxy** (runs live during a CC session) and a **report generator** (offline, pure function of what was captured).
- **Out of scope:** live/real-time viewing (TUI or web UI — a fast-follow effort); other providers or harnesses; building the tool itself under the map that produced this spec.

## Architecture

```
Claude Code ──http──▶ capture proxy ──https/h1──▶ api.anthropic.com
              (ANTHROPIC_BASE_URL)    │
                                      ▼
                          sessions/<session_id>/   ◀── ground truth: redacted raw bytes
                                      │
                                      ▼
                            report generator ──▶ static self-contained report.html
```

The proxy is **dumb**: tee raw bytes, stream SSE through without buffering, redact secret headers before the write. All structure — fields, token accounting, request anatomy, waste signals — is a **derived view computed by the report generator** at report time, never a second stored copy. Byte-faithfulness is why ccsnoop exists.

---

## Part 1 — Capture

### 1.1 Mechanism — env-var reverse proxy  ([#2](https://github.com/ledahu05/ccsnoop/issues/2))

Point Claude Code at a local reverse proxy with `ANTHROPIC_BASE_URL=http://localhost:<port>`; the proxy forwards to `api.anthropic.com`. CC sends its complete request (all headers + full JSON body + SSE stream) to that URL, with auth passing through. The proxy is a legitimate endpoint CC is explicitly pointed at — **no transparent interception, no MITM.**

- **Fallback (higher fidelity, only if needed):** MITM via `HTTPS_PROXY` + a CA trusted through `NODE_EXTRA_CA_CERTS`. Not needed — see §1.2.
- **Cross-check, not a substitute:** `OTEL_LOG_RAW_API_BODIES=1` natively dumps full request/response JSON, but it is bodies-only (no headers, no wire framing, 60 KB inline truncation, no live SSE). Useful to validate the capture, not to replace it.
- Full research: [`docs/research/interception-surface.md`](https://github.com/ledahu05/ccsnoop/issues/2) (on branch `research/interception-surface`).

#### CC behaviour on a non-first-party host — mandatory config

Claude Code alters behaviour when `ANTHROPIC_BASE_URL` is not first-party:

- **MCP tool search is disabled by default** → set **`ENABLE_TOOL_SEARCH=true`** so the API payload is faithful to a normal session. **This is a required part of the capture setup**, not optional.
- **Remote Control is disabled** (CC v2.1.196+) — accepted, irrelevant to capture.
- Host header is rewritten to localhost; the proxy restores `Host: api.anthropic.com` on forward (see §1.5).

### 1.2 Build-shape — from-scratch reverse-proxy byte-tee  ([#5](https://github.com/ledahu05/ccsnoop/issues/5))

The spec mandates a **from-scratch reverse-proxy byte-tee**, **not** a mitmproxy wrapper. mitmproxy's reason to exist (cert generation, `HTTPS_PROXY` MITM, transparent h2 intercept) solves a problem the reverse-proxy mechanism deliberately doesn't have.

- **Transport = plain `http://localhost`, no TLS/CA.** A loopback gains nothing from TLS; terminating plain HTTP removes cert generation and `NODE_EXTRA_CA_CERTS` wiring entirely.
- **Protocol = HTTP/1.1, both legs.** Wire framing (h2 frames vs h1 text) sits *below* the ground-truth line of §1.3 (redacted raw HTTP-message bytes: headers + JSON body + SSE stream), so h1 is byte-faithful *for what we capture*.
- **Runtime = Node as the *reference* target** (a hard constraint on no one — a builder may pick Go/Python). Node core `http` (listener) + `https` (upstream) + a `PassThrough` tee streams SSE through with **zero runtime dependencies**. Node core `https` is HTTP/1.1-only, which is exactly the protocol decision above.
- **Given up vs mitmproxy:** pre-tested h2 + TLS. Neither is needed by a localhost-h1 reverse proxy. Accepted.

#### Validated assumptions ([#7](https://github.com/ledahu05/ccsnoop/issues/7) — confirmed empirically, live CC → real Anthropic)

Both transport/protocol assumptions were confirmed against a live `claude-cli/2.1.216` run through the reference proxy shape:

| Assumption | Result | Evidence |
|---|---|---|
| Plain `http://localhost` works as `ANTHROPIC_BASE_URL` | ✅ **yes** | CC connected with no TLS/CA and sent its full `POST /v1/messages?beta=true` (157 KB) with no scheme complaint |
| HTTP/1.1 upstream to `api.anthropic.com` works | ✅ **yes** | Anthropic answered `HTTP/1.1 200 text/event-stream`; SSE streamed through the tee (~412 ms of bytes flowing before end — no buffering) |

No h2 required; the fallback (HTTPS + trusted CA / h2 transport) is **not** invoked. Observed behaviour delta: CC issues one harmless `HEAD /` connectivity preflight before the real POST. Auth mode was OAuth subscription (`anthropic-beta: oauth-2025-04-20,…`), and header-denylist redaction (§1.3) was verified live.

### 1.3 Redaction contract — NON-NEGOTIABLE  ([#3](https://github.com/ledahu05/ccsnoop/issues/3))

Raw requests carry the credential in a header. **Nothing unredacted ever touches disk, even transiently.**

- **What:** a fixed **case-insensitive header denylist** — `authorization`, `x-api-key`, `proxy-authorization`, `cookie`. The whole value is replaced. A config hook may *extend* the denylist, but the fixed list always ships.
- **Bodies are NOT scrubbed** — the Anthropic Messages API carries no credential in the body, and blanket body-scrubbing would corrupt the captured payload (fidelity loss).
- **Token:** plain `‹REDACTED›` — no length or fingerprint hint.
- **When:** in the proxy, **on the request path, before the tee write.** Headers arrive before body streaming starts, so this is a substitution on the buffered header block with zero impact on the SSE stream-through constraint. Redaction is a precondition of the write.

### 1.4 SSE strategy — raw stream only, reassemble at report time  ([#3](https://github.com/ledahu05/ccsnoop/issues/3))

Store the SSE event stream (`message_start` … `message_stop`) byte-faithful. The proxy stays dumb (tee + stream-through). The report generator reassembles the message and reads accounting **from the captured payload — never re-tokenized locally**:

- Output tokens + stop reason ← `message_delta` (`usage.output_tokens`, `delta.stop_reason`), confirmed by terminal `message_stop`.
- Input / cache tokens ← `message_start` `message.usage`.
- Non-streaming responses ← `usage` straight from the JSON body.

**Streaming-through is the one load-bearing engineering constraint:** the proxy MUST pipe the response through without buffering the full body, or live streaming breaks.

### 1.5 Session boundary — `session_id` from the body  ([#3](https://github.com/ledahu05/ccsnoop/issues/3))

Group requests by JSON-parsing the Messages API body `metadata.user_id` (CC packs a stringified object there) and reading **`session_id`**. Fold sub-agent runs into the root via **`parent_session_id`**.

- **Parse defensively** — the structure inside `metadata.user_id` is undocumented CC product behaviour (confirmed in CC v2.1.216), not an API contract; it may shift across releases.
- **Fallback:** proxy-lifecycle = one session, used only when `metadata` is absent (non-CC clients, or the structure changing). Idle-gap heuristics rejected.

### 1.6 Storage format — per-session dir: raw blobs + a manifest  ([#3](https://github.com/ledahu05/ccsnoop/issues/3))

```
sessions/<session_id>/
  manifest.jsonl              # one line per exchange, capture-order
  0001.request.http           # raw redacted request bytes (headers + body)
  0001.response.sse           # raw response bytes (SSE or JSON), verbatim
  0002.request.http
  0002.response.sse
  ...
```

- Raw blobs, **file-per-exchange** — pristine bytes, zero escaping.
- **`manifest.jsonl`** holds only the capture-time facts that can't be recovered from the bytes. Per exchange:
  - turn index (capture order)
  - `request_received_at`, `response_completed_at` (→ duration)
  - `parent_session_id`
  - **`thread_id` — the exchange's own originating `session_id`** (see amendment below)
  - blob pointers
- **Rejected:** sqlite (a dependency + schema surface for data read once, sequentially — the filesystem already indexes by session dir); jsonl-only (can't embed multi-line raw SSE without escaping, breaking fidelity).
- Keeps the proxy append-only and streaming-friendly; the report generator is a pure function of `sessions/`.

> **Amendment folded in from [#6](https://github.com/ledahu05/ccsnoop/issues/6) (cache-lineage baseline).** The waste re-sent-diff baseline is the immediately-prior request *in the same cache lineage* (§2.3), not the flat capture-order folded session — a subagent call (different prefix) ordered right before a main-agent request would produce garbage classifications. So the manifest **must** record each exchange's **thread identity** (`thread_id` = the exchange's own `session_id` before folding), a distinct dimension from the `session_id` that names the directory and from `parent_session_id`. This amends the original #3 manifest, which listed neither.

---

## Part 2 — Report

### 2.1 View form  ([map](https://github.com/ledahu05/ccsnoop/issues/1))

A single **static, self-contained HTML report** — no server, one file. The report generator is a pure function of `sessions/<session_id>/`.

### 2.2 Layout & drill  ([#4](https://github.com/ledahu05/ccsnoop/issues/4) — settled against a [prototype](https://claude.ai/code/artifact/b4b568b6-a6af-4355-887b-2a0b79f265c8))

- **Spine = master/detail two-pane.** Left = request list (each row: request #, input size, bloat flag, per-request waste marker). Right = the selected request's detail. A **growth chart** (input tokens per request, stacked by anatomy) + a **session waste summary** sit above the list.
- **Drill = accordion**, three levels:
  1. request list →
  2. the selected request's anatomy as collapsible sections **System / Tools / Message history / Current turn**, each sized (tokens + % of request) and labelled with its waste state (`re-sent`, `bloated`) →
  3. **raw request payload at the bottom of the detail pane.**
- **API-key redaction is rendered in every raw payload** (honours §1.3).

### 2.3 Legibility metrics (locked set)  ([map](https://github.com/ledahu05/ccsnoop/issues/1))

Context-window growth per turn · request anatomy (System / Tools / message history / current turn) · waste signals · Anthropic prompt-cache read/write. All derived at report time from the captured `usage` and bytes; **nothing re-tokenizes.**

### 2.4 Waste-signal computation  ([#6](https://github.com/ledahu05/ccsnoop/issues/6))

**Shared substrate — segmentation.** All three signals compute over one unit: the **logical segment** at the granularity the request body exposes — the `system` block(s), **each individual `tool` definition**, and **each individual `messages[]` entry**. Segments are **canonicalized from the parsed JSON** (stable key order, normalized whitespace) and hashed — *not* raw-byte-diffed (trivial re-serialization defeats byte diffing and can't attribute waste to a request part). Results roll up to the four anatomy buckets **for display only**.

**(a) Re-sent diff — three states, `usage`-arbitrated.**
- **Baseline = the immediately-prior request in the same *cache lineage*** (the main thread, or the specific subagent thread — keyed on the manifest `thread_id` of §1.6), **not** the flat capture-order folded session.
- Each segment → one of:
  1. **New** — absent from the prior request. Expected cost.
  2. **Reused-cached** — identical prefix continuation served from cache → cheap. Descriptive, never punitive.
  3. **Reused-uncached** — identical to the prior request but *not* served from cache. **The sole waste state** ("cacheable-but-re-sent").
- **`usage` is ground truth for *whether/how much* caching happened; the breakpoint-diff only attributes *where/why*.** Prompt-cache entries have a ~5-min TTL, so a byte-identical prefix can hit a **cold** cache and be reprocessed at full price. Rule: if the diff predicts N reused-cached tokens but `usage.cache_read_input_tokens` is materially below N, the shortfall is **reused-uncached waste**. Cold-cache degenerate case (`cache_read_input_tokens ≈ 0`): no reused-cached tier for that request — everything reused collapses to waste. The reused-cached tier is **`usage`-gated, not diff-asserted.**
- Rendered as a **cache-boundary overlay**: mark where the cached prefix ends (from CC's own `cache_control` breakpoints, reconciled against `usage`); flag reused-uncached segments beyond it.

**(b) Bloated tool result.**
- **Measure = byte-length proxy** (never a per-block token count — `usage` is request-aggregate only, and re-tokenizing is forbidden).
- **Flag when BOTH:** (i) above an **absolute byte floor** (kills small-request noise), AND (ii) a **sibling-relative outlier** among tool_results in the same request (e.g. > k× the median). Single/uniformly-large results → the floor alone governs.
- **Configurable (floor + multiplier), with locked sane defaults.** Thresholds re-apply at report time without re-capturing.

**(c) Static-block detection.**
- **Static = canonical content-hash unchanged across the turns in which the segment's slot appears** (default: unchanged since first appearance). **NOT** structural role — CC can mutate the system prompt or tool set mid-session, and a role-based label would hide the biggest cache-buster.
- Structural role (anatomy bucket) is used **only for display grouping**.
- **Flagship waste case = static ∩ reused-uncached:** a large unchanging block that *should* have been a cache hit and wasn't. Called out specifically, above a generic reused-uncached segment.

### 2.5 Mapping onto the view

- **Master list:** per-request waste marker (reused-uncached bytes + bloat-flag count) — waste scannable per turn without opening the accordion.
- **Above the list:** session-level waste roll-up beside the growth chart.
- **Detail pane:** three-tier segment coloring (new = accent / reused-cached = muted-informational / reused-uncached = waste highlight), the cache-boundary overlay, bloat badges on outlier tool_results, static-block highlights in the raw payload.
- **Headline waste metric = reused-uncached bytes, explicitly labelled as a proxy** (per-segment token attribution isn't available without re-tokenizing). **Bloat flags counted separately** — a distinct signal, not folded into the re-sent tally.

### 2.6 Config surface (report-time)

- Bloat: absolute floor + sibling multiplier (defaults shipped, overridable).
- Fixed: baseline = immediately-prior request in the same cache lineage; static = unchanged since first appearance; segmentation granularity = message / tool-def.

---

## Non-negotiables (any implementation must hold these)

1. **Secret-header redaction before the write** (§1.3) — nothing unredacted touches disk.
2. **Stream SSE through without buffering** (§1.4) — the proxy never holds the full body.
3. **Redacted raw bytes are the only stored ground truth** (§1.3, §1.6) — all fields/tokens/anatomy/waste are derived at report time; never re-tokenize (read `usage`).
4. **`ENABLE_TOOL_SEARCH=true` at capture** (§1.1) — else the captured payload is not faithful to a normal session.

## Appendix — reference capture proxy (illustrative, Node)

Concrete form of the "~50 lines, zero deps, native SSE tee" claim in §1.2 — the exact shape validated in [#7](https://github.com/ledahu05/ccsnoop/issues/7). Illustrative reference, **not** a mandated implementation; it does the tee + host-rewrite + redaction-in-log but omits the §1.6 on-disk storage.

```js
const http = require('http');
const https = require('https');
const UPSTREAM = 'api.anthropic.com';
const DENY = /^(authorization|x-api-key|proxy-authorization|cookie)$/i;

http.createServer((creq, cres) => {
  const headers = { ...creq.headers, host: UPSTREAM };   // restore first-party Host
  // redact secret headers before anything is persisted (§1.3)
  const forDisk = { ...headers };
  for (const k of Object.keys(forDisk)) if (DENY.test(k)) forDisk[k] = '‹REDACTED›';
  // ...persist redacted request bytes here (§1.6)...

  const ureq = https.request(                             // Node https = HTTP/1.1 (§1.2)
    { hostname: UPSTREAM, port: 443, path: creq.url, method: creq.method, headers },
    (ures) => {
      cres.writeHead(ures.statusCode, ures.headers);
      ures.pipe(cres);                                    // stream-through tee, no buffering (§1.4)
      // ...tee ures to disk here (§1.6)...
    }
  );
  creq.pipe(ureq);
}).listen(8118, '127.0.0.1');
```

## Provenance

Compiled from the [ccsnoop wayfinder map](https://github.com/ledahu05/ccsnoop/issues/1):

| Ticket | Decision |
|---|---|
| [#2](https://github.com/ledahu05/ccsnoop/issues/2) | Interception surface = env-var reverse proxy |
| [#3](https://github.com/ledahu05/ccsnoop/issues/3) | Capture spec — redacted raw bytes, SSE, redaction, session boundary, storage |
| [#4](https://github.com/ledahu05/ccsnoop/issues/4) | Report layout — master/detail spine, accordion drill |
| [#5](https://github.com/ledahu05/ccsnoop/issues/5) | Build-shape — from-scratch reverse-proxy byte-tee, plain http, h1, Node reference |
| [#6](https://github.com/ledahu05/ccsnoop/issues/6) | Waste-signal computation — segmentation, usage-gated re-sent diff, bloat, static blocks |
| [#7](https://github.com/ledahu05/ccsnoop/issues/7) | Confirmation — plain-http base URL + h1 upstream both work |
