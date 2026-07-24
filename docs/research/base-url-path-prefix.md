# Claude Code preserves the `ANTHROPIC_BASE_URL` path prefix — smoke-test findings

Task ticket: [issue #14](https://github.com/ledahu05/ccsnoop/issues/14) — *"Confirm SDK preserves `ANTHROPIC_BASE_URL` path prefix (path-token routing)"* — part of map [#9](https://github.com/ledahu05/ccsnoop/issues/9).

Question: does Claude Code **preserve a path prefix** in `ANTHROPIC_BASE_URL`, so a request to `http://localhost:<port>/<token>` arrives at the daemon as `/<token>/v1/messages` (token intact)? Path-token routing (decided in [#11](https://github.com/ledahu05/ccsnoop/issues/11)) hangs entirely on this.

Status: **CONFIRMED empirically** against a live Claude Code request. Reproducible across two runs.

Method: in the spirit of the [interception-surface probe (#7/#2)](./interception-surface.md) — a minimal localhost HTTP server logs the incoming request line and headers; `ANTHROPIC_BASE_URL` is set to a URL **with a path prefix**; one real `claude -p` request is driven at it. Harness: [`probes/base-url-path-prefix-probe.mjs`](./probes/base-url-path-prefix-probe.mjs).

- **CC version observed:** `claude-cli/2.1.218 (external, sdk-cli)` (`claude --version` → `2.1.218`).
- **Runtime:** the CLI is a **Bun** build (health-check `User-Agent: Bun/1.4.0`).
- **Base URL set:** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/probe-token` (plain HTTP, with `/probe-token` prefix).

---

## RECOMMENDATION

**Path-token routing is viable — proceed with #11's design.** CC concatenates the API path onto the base URL's path prefix; the token survives intact. The daemon can read the token from the leading path segment, strip it, and tee to the mapped dir.

**Belt-and-braces:** the custom-header channel (`ANTHROPIC_CUSTOM_HEADERS`) **also works** and is a valid fallback discriminator with *no* path-preservation dependency (see §3). Path-token remains the primary mechanism (self-describing URL, survives redirects/tooling that ignore custom headers); the header is insurance, not a replacement.

---

## 1. Path prefix — CONFIRMED (prefix intact)

The real Messages API POST arrived as:

```
POST /probe-token/v1/messages?beta=true HTTP/1.1
Host: 127.0.0.1:<port>
User-Agent: claude-cli/2.1.218 (external, sdk-cli)
```

- The `/probe-token` prefix is **preserved**, with `/v1/messages` appended after it — exactly the `/​<token>/v1/messages…` shape #11 assumes. **Confirmed, not refuted.**
- The query string (`?beta=true`) is CC's own and rides along after the path; the daemon must match the token on the **leading path segment**, not the whole URL.
- Identical result across two independent runs (ports differ; paths identical).

Implication for the daemon: parse the first path segment (`/probe-token`) as the route token, strip it, and forward `/v1/messages?beta=true` upstream to `https://api.anthropic.com`. Registry lookup `token → dir` per #11.

## 2. Plain HTTP accepted — resolves interception-surface caveat #3

The [interception-surface research](./interception-surface.md) flagged that plain `http://localhost` base URLs were undocumented and must be verified empirically. **Verified: CC connected over plain HTTP** (`http://127.0.0.1:<port>/…`) with no TLS and no `NODE_EXTRA_CA_CERTS` — the request went through. No self-signed-cert dance is required for the localhost daemon.

## 3. Custom header forwarded — CONFIRMED (the "cheap insurance" from the ticket comment)

Setting `ANTHROPIC_CUSTOM_HEADERS='x-ccsnoop-token: route-abc123'` in the child's `env`, the header **arrived on the upstream POST**:

```
x-ccsnoop-token: route-abc123
```

So CC's `env`-driven custom-header channel reaches the proxy. This is a routing discriminator that does **not** depend on path preservation — a ready fallback ahead of port-per-scope had the prefix been stripped. It wasn't needed (prefix survives), but it's available.

## 4. Bonus: a pre-flight health check (also prefix-preserving)

Before the API POST, CC issued a **health check** against the base URL:

```
HEAD /probe-token/api/hello HTTP/1.1
User-Agent: Bun/1.4.0
```

Notes for the daemon builder:
- The health check **also carries the path prefix** (`/probe-token/api/hello`), so the daemon's token-stripping must handle `/<token>/api/hello` as well as `/<token>/v1/messages`.
- It is issued by the Bun runtime layer (`User-Agent: Bun/1.4.0`), **before** and **separate from** the SDK request, and — unlike the API POST — it did **not** carry the custom header. Don't key routing off the health check's headers; key off the path segment.
- The daemon should answer `HEAD /<token>/api/hello` locally (or forward it) rather than 400, so CC's connectivity pre-flight succeeds in production. (Our probe returned 400 to everything, which is why the run exits with `API Error: 400 probe` — expected; we only needed the request line.)

---

## Raw observations

Probe server received (both runs identical modulo port):

```json
[
  {
    "method": "HEAD",
    "url": "/probe-token/api/hello",
    "host": "127.0.0.1:<port>",
    "customHeader": null,
    "userAgent": "Bun/1.4.0"
  },
  {
    "method": "POST",
    "url": "/probe-token/v1/messages?beta=true",
    "host": "127.0.0.1:<port>",
    "customHeader": "route-abc123",
    "userAgent": "claude-cli/2.1.218 (external, sdk-cli)"
  }
]
```

`claude` exited `1` with `API Error: 400 probe` — expected, since the probe server 400s every request; the request line is all we needed.

## Reproduce

```
node docs/research/probes/base-url-path-prefix-probe.mjs
```

Requires the `claude` CLI on PATH. The harness picks an ephemeral port, sets `ANTHROPIC_BASE_URL` (with prefix), a dummy `ANTHROPIC_API_KEY`, and `ANTHROPIC_CUSTOM_HEADERS`, then drives one `claude -p` request and prints the received request lines.
