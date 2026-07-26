// Report generator (spec §2.1–2.3, §3.5).
//
// A pure function of a captured `sessions/<session_id>/` dir: it reassembles the
// exchanges and emits ONE self-contained static HTML file (no server, no external
// assets). Every token/cache figure is read from the captured `usage` — this
// module NEVER re-tokenizes (spec §1.4, non-negotiable #3). Waste-signal
// computation is a later slice; this one delivers the spine, growth, anatomy,
// and the raw view.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { computeWaste } from './waste.js';
import { defaultHome } from './daemon.js';

/**
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheCreation5mInputTokens  Writes billed at the ×1.25 (5m TTL) tier.
 * @property {number} cacheCreation1hInputTokens  Writes billed at the ×2 (1h TTL) tier.
 * @property {string | null} stopReason
 * @property {boolean} streaming
 */

/**
 * @typedef {object} Anatomy
 * @property {number} system       Bytes of the `system` block(s).
 * @property {number} tools        Bytes of the `tools` array.
 * @property {number} history      Bytes of every `messages[]` entry but the last.
 * @property {number} currentTurn  Bytes of the final `messages[]` entry.
 * @property {number} total        Sum of the four buckets.
 */

/**
 * Parse a raw redacted `.request.http` blob into its request line, headers, and
 * body. Headers arrive already redacted from capture (spec §1.3); this only
 * splits — it never mutates the bytes.
 *
 * @param {Buffer | string} buf
 * @returns {{ method: string, url: string, head: string, text: string,
 *   headers: Array<{ name: string, value: string }>, body: string, json: any }}
 */
export function parseRequestBlob(buf) {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : '';
  const [requestLine = '', ...headerLines] = head.split('\r\n');
  const m = requestLine.match(/^(\S+)\s+(\S+)\s+HTTP/);
  const headers = headerLines
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return i < 0
        ? { name: line, value: '' }
        : { name: line.slice(0, i), value: line.slice(i + 1).trimStart() };
    });
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Non-JSON body (e.g. a HEAD preflight) — anatomy just reads as empty.
  }
  return { method: m ? m[1] : '', url: m ? m[2] : '', head, text, headers, body, json };
}

/**
 * Read token accounting from a captured response blob (SSE stream or a plain
 * JSON body). Reassembles the SSE at report time and reads `usage` from the
 * payload — never re-tokenizes (spec §1.4).
 *
 * @param {Buffer | string} buf
 * @returns {Usage | null} null when no `usage` is present (e.g. a HEAD/error blob).
 */
export function readUsage(buf) {
  const text = decodeBlob(buf);
  if (text.trim().length === 0) return null;

  // SSE path: collect every `data:` JSON line and fold usage across events.
  const events = parseSseEvents(text);
  if (events.length > 0) {
    /** @type {Record<string, number>} */
    let usage = {};
    /** @type {string | null} */
    let stopReason = null;
    for (const e of events) {
      if (e && e.type === 'message_start' && e.message && e.message.usage) {
        usage = { ...usage, ...e.message.usage };
        if (typeof e.message.stop_reason === 'string') stopReason = e.message.stop_reason;
      } else if (e && e.type === 'message_delta') {
        if (e.usage) usage = { ...usage, ...e.usage };
        if (e.delta && typeof e.delta.stop_reason === 'string') stopReason = e.delta.stop_reason;
      }
    }
    if (Object.keys(usage).length > 0) return normalizeUsage(usage, stopReason, true);
  }

  // Non-streaming path: a single JSON body carries `usage` + `stop_reason`.
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.usage) {
      return normalizeUsage(parsed.usage, typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null, false);
    }
  } catch {
    // Not JSON either — no accounting available.
  }
  return null;
}

/**
 * Decode a captured response blob into UTF-8 text. Anthropic serves the SSE
 * stream with `content-encoding: gzip`, so the blob on disk is raw gzip bytes;
 * read as-is they carry no `message_start`, and `usage` reads null on every real
 * exchange (issue #53). Detect the gzip magic (`1f 8b`) and inflate before
 * treating the bytes as text; a plain-text blob (or a string) passes through.
 *
 * @param {Buffer | string} buf
 * @returns {string}
 */
function decodeBlob(buf) {
  if (typeof buf === 'string') return buf;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf).toString('utf8');
    } catch {
      // Truncated/corrupt gzip — fall back to the raw bytes (reads as null).
    }
  }
  return buf.toString('utf8');
}

/**
 * Split an SSE text stream into its parsed `data:` JSON payloads. Anthropic
 * emits one JSON object per `data:` line; malformed lines are skipped.
 * @param {string} text
 * @returns {any[]}
 */
function parseSseEvents(text) {
  /** @type {any[]} */
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Partial/unterminated event — ignore.
    }
  }
  return out;
}

/**
 * @param {Record<string, any>} u
 * @param {string | null} stopReason
 * @param {boolean} streaming
 * @returns {Usage}
 */
function normalizeUsage(u, stopReason, streaming) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // The flat `cache_creation_input_tokens` stays the source of truth for the total;
  // the per-tier split (5m ×1.25 / 1h ×2, issue #45) comes in addition and is
  // absent on older/error payloads — default both to 0, never derive the total.
  const tiers = u.cache_creation || {};
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadInputTokens: n(u.cache_read_input_tokens),
    cacheCreationInputTokens: n(u.cache_creation_input_tokens),
    cacheCreation5mInputTokens: n(tiers.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens: n(tiers.ephemeral_1h_input_tokens),
    stopReason,
    streaming,
  };
}

/**
 * Size the request's four anatomy buckets (spec §2.2) by byte length of the
 * canonical JSON — System / Tools / Message history / Current turn. Byte length
 * is the only legal measure here: `usage` is request-aggregate and re-tokenizing
 * is forbidden (spec §2.4b).
 *
 * @param {any} body  Parsed request JSON (null-safe).
 * @returns {Anatomy}
 */
export function computeAnatomy(body) {
  const bytes = (v) => (v === undefined || v === null ? 0 : Buffer.byteLength(JSON.stringify(v), 'utf8'));
  if (!body || typeof body !== 'object') {
    return { system: 0, tools: 0, history: 0, currentTurn: 0, total: 0 };
  }
  const system = bytes(body.system);
  const tools = bytes(body.tools);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let history = 0;
  let currentTurn = 0;
  if (messages.length > 0) {
    currentTurn = bytes(messages[messages.length - 1]);
    history = messages.length > 1 ? bytes(messages.slice(0, -1)) : 0;
  }
  return { system, tools, history, currentTurn, total: system + tools + history + currentTurn };
}

/**
 * Resolve a segment `slot` back to its raw value inside a parsed request body.
 * The inverse of the slot naming in {@link module:waste~segmentRequest}:
 * `system` → `body.system`, `system#<i>` → `body.system[i]`, `tool:<name>` →
 * the `body.tools` entry with that name, `message#<i>` → `body.messages[i]`.
 *
 * Kept self-contained (no module-scope references) so its source can be shipped
 * verbatim into the client renderer, which re-parses the embedded `requestBlob`
 * to expand a row without any new payload (issue #28). Returns `undefined` when
 * the slot has no match — the caller renders that as "unavailable".
 *
 * @param {any} body   Parsed request JSON (null-safe).
 * @param {string} slot
 * @returns {any}
 */
export function contentForSlot(body, slot) {
  if (!body || typeof body !== 'object' || typeof slot !== 'string') return undefined;
  if (slot === 'system') return body.system;
  const sysM = slot.match(/^system#(\d+)$/);
  if (sysM) return Array.isArray(body.system) ? body.system[Number(sysM[1])] : undefined;
  if (slot.indexOf('tool:') === 0) {
    const name = slot.slice(5);
    if (!Array.isArray(body.tools)) return undefined;
    const byName = body.tools.find((t) => t && t.name === name);
    if (byName !== undefined) return byName;
    // Anonymous tools are slotted as `tool:#<i>` — fall back to positional index.
    const anon = name.match(/^#(\d+)$/);
    return anon ? body.tools[Number(anon[1])] : undefined;
  }
  const msgM = slot.match(/^message#(\d+)$/);
  if (msgM) return Array.isArray(body.messages) ? body.messages[Number(msgM[1])] : undefined;
  return undefined;
}

/**
 * Elapsed milliseconds between two ISO timestamps, or null when either is
 * absent or unparseable (a `NaN` would otherwise render as "NaN ms").
 *
 * @param {string | null} received
 * @param {string | null} completed
 * @returns {number | null}
 */
function computeDurationMs(received, completed) {
  if (!received || !completed) return null;
  const ms = Date.parse(completed) - Date.parse(received);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/**
 * Build the derived model for one exchange from its manifest line and raw blobs.
 * Pure — all I/O happens in {@link loadSession}.
 *
 * @param {Record<string, any>} line       One manifest.jsonl entry.
 * @param {Buffer} requestBuf               Raw redacted request bytes.
 * @param {Buffer} responseBuf              Raw response bytes (SSE or JSON).
 * @returns {object}
 */
export function buildExchange(line, requestBuf, responseBuf) {
  const req = parseRequestBlob(requestBuf);
  const anatomy = computeAnatomy(req.json);
  const usage = readUsage(responseBuf);
  const received = line.request_received_at ?? null;
  const completed = line.response_completed_at ?? null;
  const durationMs = computeDurationMs(received, completed);
  return {
    turn: typeof line.turn === 'number' ? line.turn : null,
    threadId: line.thread_id ?? null,
    parentSessionId: line.parent_session_id ?? null,
    requestReceivedAt: received,
    responseCompletedAt: completed,
    durationMs,
    method: req.method,
    url: req.url,
    requestBlob: req.text,
    requestBytes: requestBuf.length,
    // Parsed body is kept only for waste computation in loadSession, then dropped
    // before the model is embedded (the redacted raw blob already carries it).
    requestJson: req.json,
    anatomy,
    usage,
  };
}

/**
 * Load a captured session directory into a report model. Reads the manifest
 * (capture order) and each exchange's raw blobs.
 *
 * Waste signals (spec §2.4) are computed here over the whole session: each
 * exchange is annotated with its segment classification, and a session-level
 * waste summary is returned alongside.
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @param {Partial<import('./waste.js').WasteConfig>} [wasteConfig] Report-time overrides (spec §2.6).
 * @returns {{ sessionId: string, exchanges: object[], waste: object, wasteConfig: object }}
 */
export function loadSession(dir, id, wasteConfig) {
  const manifestPath = path.join(dir, 'manifest.jsonl');
  const lines = fs
    .readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const exchanges = lines.map((line) => {
    const requestBuf = fs.readFileSync(path.join(dir, line.request_blob));
    let responseBuf = Buffer.alloc(0);
    try {
      responseBuf = fs.readFileSync(path.join(dir, line.response_blob));
    } catch {
      // Response blob may be missing on an aborted exchange — accounting reads null.
    }
    return buildExchange(line, requestBuf, responseBuf);
  });

  const { perExchange, summary, config } = computeWaste(
    exchanges.map((e) => ({ threadId: e.threadId, requestBody: e.requestJson, usage: e.usage })),
    wasteConfig ?? {}
  );
  exchanges.forEach((e, i) => {
    const w = perExchange[i];
    e.segments = w.segments;
    e.waste = {
      cacheBoundary: w.cacheBoundary,
      cold: w.cold,
      reusedUncachedBytes: w.reusedUncachedBytes,
      reusedUncachedByBucket: w.reusedUncachedByBucket,
      bloatCount: w.bloatCount,
      flagshipCount: w.flagshipCount,
      flagshipBytes: w.flagshipBytes,
    };
    delete e.requestJson; // computation-only; not embedded in the report
  });

  return { sessionId: id ?? path.basename(dir), exchanges, waste: summary, wasteConfig: config };
}

/**
 * List capture sessions under a root. A session is a subdir holding a
 * `manifest.jsonl`. Looks in `<root>/sessions/` (the §3.3 nesting) and falls
 * back to `<root>` itself so a bare `sessions/` capture dir also works.
 *
 * @param {string} root
 * @returns {Array<{ id: string, dir: string, mtimeMs: number }>}
 */
export function listSessions(root) {
  const bases = [path.join(root, 'sessions'), root];
  /** @type {Array<{ id: string, dir: string, mtimeMs: number }>} */
  const found = [];
  const seen = new Set();
  for (const base of bases) {
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const manifest = path.join(dir, 'manifest.jsonl');
      if (seen.has(dir) || !fs.existsSync(manifest)) continue;
      seen.add(dir);
      found.push({ id: entry.name, dir, mtimeMs: fs.statSync(manifest).mtimeMs });
    }
  }
  return found;
}

/**
 * Pick the most-recently-written session (spec §3.5: latest by default).
 * @template {{ mtimeMs: number }} T
 * @param {T[]} sessions
 * @returns {T | null}
 */
export function pickLatestSession(sessions) {
  if (!sessions || sessions.length === 0) return null;
  return sessions.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/**
 * Roots to search for sessions (spec §3.5). Default = `<cwd>/.ccsnoop/`;
 * `--root` overrides; `--all` widens across every root in `~/.ccsnoop/routes.json`.
 *
 * @param {{ cwd: string, root?: string, all?: boolean }} opts
 * @returns {string[]}
 */
export function resolveRoots({ cwd, root, all }) {
  if (root) return [path.resolve(cwd, root)];
  const roots = [path.resolve(cwd, '.ccsnoop')];
  if (all) {
    for (const r of readRoutesRoots()) if (!roots.includes(r)) roots.push(r);
  }
  return roots;
}

/**
 * Capture roots registered in the machine home's `routes.json` (token → dir).
 * Honours `$CCSNOOP_HOME` (via {@link defaultHome}) so an isolated registry can be
 * exercised without polluting the dev's real `~/.ccsnoop`. Best-effort: the registry
 * is built by a later slice, so absence is not an error.
 * @returns {string[]}
 */
function readRoutesRoots() {
  try {
    const p = path.join(defaultHome(), 'routes.json');
    const routes = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.values(routes)
      .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.dir : null))
      .filter((v) => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * Discover, load, render and write a report (spec §3.5 discovery + §2 content).
 *
 * @param {{ cwd?: string, root?: string, session?: string, all?: boolean, out?: string, waste?: object }} [opts]
 * @returns {{ outPath: string, sessionId: string, exchanges: number, root: string }}
 */
export function generateReport(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = resolveRoots({ cwd, root: opts.root, all: opts.all });
  const sessions = roots.flatMap((r) => listSessions(r));
  if (sessions.length === 0) {
    throw new Error(
      `no captured sessions found under ${roots.join(', ')} — run 'ccsnoop start' first, or pass --root <path>`
    );
  }

  let chosen;
  if (opts.session) {
    chosen = sessions.find((s) => s.id === opts.session);
    if (!chosen) {
      throw new Error(`session '${opts.session}' not found (have: ${sessions.map((s) => s.id).join(', ')})`);
    }
  } else {
    chosen = pickLatestSession(sessions);
  }

  const model = loadSession(chosen.dir, chosen.id, opts.waste);
  const html = renderReport(model);
  const outPath = opts.out ? path.resolve(cwd, opts.out) : path.join(chosen.dir, 'report.html');
  fs.writeFileSync(outPath, html);
  return { outPath, sessionId: chosen.id, exchanges: model.exchanges.length, root: path.dirname(chosen.dir) };
}

/**
 * Render the self-contained static HTML report (spec §2.1–2.3). One file, no
 * external assets: the model is embedded as JSON and the master/detail UI is
 * built by inline JS. Redaction rendered in every raw payload comes for free —
 * the captured blob is already redacted (§1.3) and shown via textContent.
 *
 * @param {{ sessionId: string, exchanges: object[] }} model
 * @returns {string}
 */
export function renderReport(model) {
  // Escape `<` so an embedded `</script>` in captured content can't break out of
  // the data island. It is read back via textContent + JSON.parse, so nothing else
  // needs escaping.
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const title = escapeHtml(`ccsnoop report — ${model.sessionId}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header class="topbar">
  <h1>ccsnoop</h1>
  <div class="session-id" id="session-id"></div>
  <div class="summary" id="summary"></div>
</header>
<section class="growth" id="growth" aria-label="Context-window growth per request"></section>
<main class="panes">
  <nav class="master" id="master" aria-label="Request list"></nav>
  <article class="detail" id="detail" aria-label="Selected request detail"></article>
</main>
<script id="ccsnoop-data" type="application/json">${data}</script>
<script>${REPORT_JS}</script>
</body>
</html>`;
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const REPORT_CSS = `
:root{--bg:#0f1117;--panel:#171a23;--edge:#252a37;--fg:#e6e9ef;--muted:#8b93a7;--accent:#5b9dff;--sys:#7c5cff;--tools:#22b8a6;--hist:#f0a336;--turn:#e5566b}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.topbar{display:flex;align-items:baseline;gap:16px;padding:12px 18px;border-bottom:1px solid var(--edge);background:var(--panel)}
.topbar h1{margin:0;font-size:16px;letter-spacing:.5px;color:var(--accent)}
.session-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);font-size:12px}
.summary{margin-left:auto;color:var(--muted);font-size:12px}
.summary b{color:var(--fg)}
.growth{display:flex;align-items:flex-end;gap:4px;padding:14px 18px;min-height:120px;border-bottom:1px solid var(--edge);overflow-x:auto}
.gbar{display:flex;flex-direction:column-reverse;width:26px;min-width:26px;cursor:pointer;border-radius:3px 3px 0 0;overflow:hidden;background:#0a0c11}
.gbar .seg{width:100%}
.gbar.sel{outline:2px solid var(--accent)}
.gbar .lbl{writing-mode:horizontal-tb;text-align:center;font-size:10px;color:var(--muted);padding-top:2px}
.panes{display:flex;height:calc(100vh - 120px - 49px);min-height:340px}
.master{width:320px;min-width:260px;border-right:1px solid var(--edge);overflow-y:auto;background:var(--panel)}
.row{display:flex;justify-content:space-between;gap:8px;padding:9px 14px;border-bottom:1px solid var(--edge);cursor:pointer}
.row:hover{background:#1e2230}
.row.sel{background:#22283a;border-left:3px solid var(--accent);padding-left:11px}
.row .rn{color:var(--muted);font-variant-numeric:tabular-nums}
.row .rin{font-variant-numeric:tabular-nums}
.detail{flex:1;overflow-y:auto;padding:16px 20px}
.detail h2{font-size:14px;margin:0 0 4px}
.meta{color:var(--muted);font-size:12px;margin-bottom:14px;font-family:ui-monospace,monospace}
.usage{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.chip{background:#12151d;border:1px solid var(--edge);border-radius:6px;padding:6px 10px;font-size:12px}
.chip b{font-variant-numeric:tabular-nums}
.acc{border:1px solid var(--edge);border-radius:6px;margin-bottom:8px;overflow:hidden}
.acc>summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;gap:10px;padding:9px 12px;background:#12151d}
.acc>summary::-webkit-details-marker{display:none}
.acc .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;vertical-align:middle}
.acc .sz{color:var(--muted);font-variant-numeric:tabular-nums}
.acc .body{padding:10px 12px;border-top:1px solid var(--edge)}
.bar{height:6px;border-radius:3px;background:#0a0c11;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%}
.raw h3{font-size:13px;margin:18px 0 6px}
pre.raw-blob{background:#0a0c11;border:1px solid var(--edge);border-radius:6px;padding:12px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#cfd6e6}
.empty{color:var(--muted);padding:40px;text-align:center}
/* Waste signals (spec §2.4–2.5): 3-tier segment coloring, badges, cache overlay. */
:root{--k-new:#5b9dff;--k-cached:#4a5163;--k-waste:#e5566b}
.wmark{font-variant-numeric:tabular-nums;font-size:11px;color:var(--muted)}
.wmark .waste{color:var(--k-waste)}
.wmark .bloat{color:var(--hist)}
.summary .waste{color:var(--k-waste)}
.seglist{margin:6px 0 0}
.seg-row-acc{margin-bottom:3px}
.seg-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-left:3px solid var(--k-cached);background:#12151d;border-radius:0 4px 4px 0;font-size:12px;list-style:none;cursor:pointer}
.seg-row::-webkit-details-marker{display:none}
.seg-row:hover{background:#1a1e2a}
.seg-row.reused-uncached:hover{background:#2c181e}
.seg-row.new{border-left-color:var(--k-new)}
.seg-row.reused-cached{border-left-color:var(--k-cached);opacity:.7}
.seg-row.reused-uncached{border-left-color:var(--k-waste);background:#241419}
.seg-raw{margin:0 0 0 3px;border-left:3px solid var(--edge);background:#0a0c11;padding:8px 10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#cfd6e6}
.seg-row .lab{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seg-row .sb{color:var(--muted);font-variant-numeric:tabular-nums}
.badge{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid var(--edge);white-space:nowrap}
.badge.k-new{color:var(--k-new)}
.badge.k-reused-cached{color:var(--muted)}
.badge.k-reused-uncached{color:var(--k-waste);border-color:var(--k-waste)}
.badge.static{color:var(--sys);border-color:var(--sys)}
.badge.bloat{color:var(--hist);border-color:var(--hist)}
.badge.flagship{color:#fff;background:var(--k-waste);border-color:var(--k-waste)}
.cache-div{display:flex;align-items:center;gap:8px;margin:8px 0;color:var(--tools);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.cache-div::before,.cache-div::after{content:"";flex:1;height:1px;background:var(--tools);opacity:.5}
.acc .wstate{font-size:11px}
.acc .wstate .re{color:var(--k-waste)}
.acc .wstate .bl{color:var(--hist)}
`;

// Client renderer. Kept dependency-free and small; builds DOM (no innerHTML for
// captured content) so redacted raw payloads render safely as text.
const REPORT_JS = `
(function(){
  var model = JSON.parse(document.getElementById('ccsnoop-data').textContent);
  var ex = model.exchanges || [];
  var ANATOMY = [
    {key:'system',label:'System',color:'var(--sys)'},
    {key:'tools',label:'Tools',color:'var(--tools)'},
    {key:'history',label:'Message history',color:'var(--hist)'},
    {key:'currentTurn',label:'Current turn',color:'var(--turn)'}
  ];
  function fmt(n){ return (n==null?0:n).toLocaleString(); }
  function bytes(n){ if(n==null) return '0 B'; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB'; }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }

  // Slot → raw content, shared verbatim with the server (report.js contentForSlot).
  var contentForSlot = ${contentForSlot.toString()};
  // Extract the JSON body out of an already-redacted raw request blob. Rows expand
  // by re-parsing this — no new payload is embedded (issue #28).
  function bodyOf(blob){ if(!blob) return null; var i=blob.indexOf('\\r\\n\\r\\n'); var b=i>=0?blob.slice(i+4):blob; try{ return JSON.parse(b); }catch(_){ return null; } }

  document.getElementById('session-id').textContent = model.sessionId;
  var totalIn = ex.reduce(function(s,e){ return s + (e.usage?e.usage.inputTokens:0); },0);
  var totalOut = ex.reduce(function(s,e){ return s + (e.usage?e.usage.outputTokens:0); },0);
  var totalCacheRead = ex.reduce(function(s,e){ return s + (e.usage?e.usage.cacheReadInputTokens:0); },0);
  var w = model.waste || {reusedUncachedBytes:0,bloatCount:0,flagshipCount:0,flagshipBytes:0};
  var sum = document.getElementById('summary');
  sum.innerHTML='';
  sum.appendChild(span(ex.length+' requests'));
  sum.appendChild(span(' · in <b>'+fmt(totalIn)+'</b> tok'));
  sum.appendChild(span(' · out <b>'+fmt(totalOut)+'</b> tok'));
  sum.appendChild(span(' · cache-read <b>'+fmt(totalCacheRead)+'</b> tok'));
  // Headline waste = reused-uncached bytes (a proxy); bloat flags counted separately.
  sum.appendChild(span(' · <span class="waste">re-sent <b>'+bytes(w.reusedUncachedBytes)+'</b></span> <span title="byte proxy — no per-segment token count">(proxy)</span>'));
  sum.appendChild(span(' · <b>'+fmt(w.bloatCount)+'</b> bloat'));
  if(w.flagshipCount>0) sum.appendChild(span(' · <span class="waste"><b>'+fmt(w.flagshipCount)+'</b> flagship</span>'));
  function span(html){ var s=document.createElement('span'); s.innerHTML=html; return s; }

  // Growth chart: bar height = input tokens (usage); stacked by anatomy byte share.
  var growth = document.getElementById('growth');
  var maxIn = Math.max(1, ex.reduce(function(m,e){ return Math.max(m, e.usage?e.usage.inputTokens:0); },0));
  ex.forEach(function(e,i){
    var inTok = e.usage?e.usage.inputTokens:0;
    var h = Math.round(6 + (inTok/maxIn)*84);
    var bar = el('div','gbar'); bar.style.height=(h+16)+'px'; bar.dataset.i=i;
    bar.title = 'req #'+(e.turn!=null?e.turn:(i+1))+' — '+fmt(inTok)+' input tok';
    var total = e.anatomy.total||0;
    ANATOMY.forEach(function(a){
      var frac = total>0 ? (e.anatomy[a.key]/total) : 0;
      if(frac<=0) return;
      var seg = el('div','seg'); seg.style.height=Math.max(0,Math.round(frac*h))+'px'; seg.style.background=a.color;
      bar.appendChild(seg);
    });
    bar.appendChild(el('div','lbl', String(e.turn!=null?e.turn:(i+1))));
    bar.addEventListener('click', function(){ select(i); });
    growth.appendChild(bar);
  });

  // Master list.
  var master = document.getElementById('master');
  ex.forEach(function(e,i){
    var row = el('div','row'); row.dataset.i=i;
    var left = el('div'); left.style.display='flex'; left.style.flexDirection='column'; left.style.gap='2px';
    left.appendChild(el('span','rn','#'+(e.turn!=null?e.turn:(i+1))));
    // Per-request waste marker: reused-uncached bytes + bloat-flag count (spec §2.5).
    var ew = e.waste || {reusedUncachedBytes:0,bloatCount:0};
    var mark = el('span','wmark');
    if(ew.reusedUncachedBytes>0){ var rs=el('span','waste','↺ '+bytes(ew.reusedUncachedBytes)); mark.appendChild(rs); }
    if(ew.bloatCount>0){ if(mark.childNodes.length) mark.appendChild(document.createTextNode(' ')); mark.appendChild(el('span','bloat','⚑'+ew.bloatCount)); }
    if(!mark.childNodes.length) mark.textContent='—';
    left.appendChild(mark);
    row.appendChild(left);
    row.appendChild(el('span','rin', bytes(e.anatomy.total)));
    row.addEventListener('click', function(){ select(i); });
    master.appendChild(row);
  });

  var detail = document.getElementById('detail');
  function select(i){
    Array.prototype.forEach.call(document.querySelectorAll('.row'), function(r){ r.classList.toggle('sel', +r.dataset.i===i); });
    Array.prototype.forEach.call(document.querySelectorAll('.gbar'), function(b){ b.classList.toggle('sel', +b.dataset.i===i); });
    renderDetail(ex[i], i);
  }

  function renderDetail(e,i){
    detail.innerHTML='';
    detail.appendChild(el('h2','', 'Request #'+(e.turn!=null?e.turn:(i+1))));
    var meta = el('div','meta', (e.method||'')+' '+(e.url||'') + (e.threadId?('  ·  thread '+e.threadId):'') + (e.durationMs!=null?('  ·  '+e.durationMs+' ms'):''));
    detail.appendChild(meta);

    var u = e.usage;
    var usage = el('div','usage');
    if(u){
      usage.appendChild(chip('Input', fmt(u.inputTokens)+' tok'));
      usage.appendChild(chip('Output', fmt(u.outputTokens)+' tok'));
      usage.appendChild(chip('Cache read', fmt(u.cacheReadInputTokens)+' tok'));
      usage.appendChild(chip('Cache write', fmt(u.cacheCreationInputTokens)+' tok'));
      // Per-tier write split (issue #45): only shown when non-zero — no '0 tok' chip on every exchange.
      if(u.cacheCreation5mInputTokens) usage.appendChild(chip('Cache write 5m', fmt(u.cacheCreation5mInputTokens)+' tok'));
      if(u.cacheCreation1hInputTokens) usage.appendChild(chip('Cache write 1h', fmt(u.cacheCreation1hInputTokens)+' tok'));
      if(u.stopReason) usage.appendChild(chip('Stop', u.stopReason));
    } else {
      usage.appendChild(chip('Usage','none captured'));
    }
    var ew = e.waste || {};
    usage.appendChild(chip('Re-sent (proxy)', bytes(ew.reusedUncachedBytes||0)));
    if(ew.cold) usage.appendChild(chip('Cache','cold — reused re-billed'));
    detail.appendChild(usage);

    // Segments carry their global order; group by bucket but keep the global index
    // so the cache-boundary overlay can be dropped at the right seam.
    var segs = e.segments || [];
    // Row expansion reads raw content back from the embedded (redacted) blob.
    var reqBody = bodyOf(e.requestBlob);
    var byBucket = {system:[],tools:[],history:[],currentTurn:[]};
    segs.forEach(function(sg,gi){ if(byBucket[sg.bucket]) byBucket[sg.bucket].push({s:sg,gi:gi}); });
    var boundary = ew.cacheBoundary||0;

    var total = e.anatomy.total||0;
    ANATOMY.forEach(function(a){
      var sz = e.anatomy[a.key]||0;
      var pct = total>0 ? Math.round(sz/total*100) : 0;
      var rows = byBucket[a.key]||[];
      var reBytes = (ew.reusedUncachedByBucket && ew.reusedUncachedByBucket[a.key])||0;
      var blCount = rows.filter(function(r){ return r.s.bloated; }).length;
      var d = el('details','acc'); if(a.key==='currentTurn') d.open=true;
      var s = el('summary');
      var left = el('span'); var sw=el('span','swatch'); sw.style.background=a.color; left.appendChild(sw); left.appendChild(document.createTextNode(a.label));
      // Waste-state label on the section (spec §2.2 level 2).
      var ws = el('span','wstate');
      if(reBytes>0){ ws.appendChild(el('span','re',' · re-sent '+bytes(reBytes))); }
      if(blCount>0){ ws.appendChild(el('span','bl',' · bloated ×'+blCount)); }
      left.appendChild(ws);
      s.appendChild(left);
      s.appendChild(el('span','sz', bytes(sz)+'  ·  '+pct+'%'));
      d.appendChild(s);
      var b = el('div','body');
      var bar = el('div','bar'); var fill=el('i'); fill.style.width=pct+'%'; fill.style.background=a.color; bar.appendChild(fill); b.appendChild(bar);
      // 3-tier colored segment list + cache-boundary overlay + badges (spec §2.5).
      if(rows.length){
        var list = el('div','seglist');
        rows.forEach(function(r){
          if(r.gi===boundary && boundary>0 && boundary<segs.length){
            list.appendChild(el('div','cache-div','cache boundary — cached prefix ends'));
          }
          list.appendChild(segRow(r.s, reqBody));
        });
        b.appendChild(list);
      }
      d.appendChild(b);
      detail.appendChild(d);
    });

    var raw = el('div','raw');
    raw.appendChild(el('h3','', 'Raw request payload (API key redacted)'));
    var pre = el('pre','raw-blob'); pre.textContent = e.requestBlob || '';
    raw.appendChild(pre);
    detail.appendChild(raw);
  }
  function chip(k,v){ var c=el('div','chip'); c.innerHTML='<span>'+k+'</span> <b></b>'; c.querySelector('b').textContent=v; return c; }

  // One segment row: a native <details> whose <summary> is the colored line
  // (label, size, kind + waste badges) and whose body reveals the raw content of
  // that slot, pulled from the redacted request blob (issue #28). Same accordion
  // idiom as the section-level .acc — no modal, no new interactivity.
  var KIND_LABEL = {'new':'new','reused-cached':'cached','reused-uncached':'re-sent'};
  function segRow(sg, body){
    var kind = sg.kind||'new';
    var d = el('details','seg-row-acc '+kind);
    var row = el('summary','seg-row '+kind);
    row.appendChild(el('span','lab', sg.label||sg.slot||''));
    row.appendChild(el('span','sb', bytes(sg.bytes||0)));
    row.appendChild(el('span','badge k-'+kind, KIND_LABEL[kind]||kind));
    if(sg.flagship) row.appendChild(el('span','badge flagship','flagship'));
    else if(sg.static) row.appendChild(el('span','badge static','static'));
    if(sg.bloated) row.appendChild(el('span','badge bloat','bloat '+bytes(sg.bloatBytes||0)));
    d.appendChild(row);
    var content = contentForSlot(body, sg.slot);
    var pre = el('pre','seg-raw');
    pre.textContent = content===undefined
      ? '(raw content unavailable)'
      : (typeof content==='string' ? content : JSON.stringify(content, null, 2));
    d.appendChild(pre);
    return d;
  }

  if(ex.length===0){ detail.appendChild(el('div','empty','No exchanges captured in this session.')); }
  else select(0);
})();
`;
