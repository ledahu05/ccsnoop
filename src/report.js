// Report generator (spec §2.1–2.3, §3.5).
//
// A pure function of a captured `sessions/<session_id>/` dir: it reassembles the
// exchanges and emits ONE self-contained static HTML file (no server, no external
// assets). Every token/cache figure is read from the captured `usage` — this
// module NEVER re-tokenizes (spec §1.4, non-negotiable #3). Waste-signal
// computation is a later slice; this one delivers the spine, growth, anatomy,
// and the raw view.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} cacheCreationInputTokens
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
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
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
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadInputTokens: n(u.cache_read_input_tokens),
    cacheCreationInputTokens: n(u.cache_creation_input_tokens),
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
  const durationMs =
    received && completed ? Math.max(0, Date.parse(completed) - Date.parse(received)) : null;
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
    anatomy,
    usage,
  };
}

/**
 * Load a captured session directory into a report model. Reads the manifest
 * (capture order) and each exchange's raw blobs.
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @returns {{ sessionId: string, exchanges: object[] }}
 */
export function loadSession(dir, id) {
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
  return { sessionId: id ?? path.basename(dir), exchanges };
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
 * Capture roots registered in `~/.ccsnoop/routes.json` (token → dir). Best-effort:
 * the registry is built by a later slice, so absence is not an error.
 * @returns {string[]}
 */
function readRoutesRoots() {
  try {
    const p = path.join(os.homedir(), '.ccsnoop', 'routes.json');
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
 * @param {{ cwd?: string, root?: string, session?: string, all?: boolean, out?: string }} [opts]
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

  const model = loadSession(chosen.dir, chosen.id);
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

  document.getElementById('session-id').textContent = model.sessionId;
  var totalIn = ex.reduce(function(s,e){ return s + (e.usage?e.usage.inputTokens:0); },0);
  var totalOut = ex.reduce(function(s,e){ return s + (e.usage?e.usage.outputTokens:0); },0);
  var totalCacheRead = ex.reduce(function(s,e){ return s + (e.usage?e.usage.cacheReadInputTokens:0); },0);
  var sum = document.getElementById('summary');
  sum.innerHTML='';
  sum.appendChild(span(ex.length+' requests'));
  sum.appendChild(span(' · in <b>'+fmt(totalIn)+'</b> tok'));
  sum.appendChild(span(' · out <b>'+fmt(totalOut)+'</b> tok'));
  sum.appendChild(span(' · cache-read <b>'+fmt(totalCacheRead)+'</b> tok'));
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
    row.appendChild(el('span','rn','#'+(e.turn!=null?e.turn:(i+1))));
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
      if(u.stopReason) usage.appendChild(chip('Stop', u.stopReason));
    } else {
      usage.appendChild(chip('Usage','none captured'));
    }
    detail.appendChild(usage);

    var total = e.anatomy.total||0;
    ANATOMY.forEach(function(a){
      var sz = e.anatomy[a.key]||0;
      var pct = total>0 ? Math.round(sz/total*100) : 0;
      var d = el('details','acc'); if(a.key==='currentTurn') d.open=true;
      var s = el('summary');
      var left = el('span'); var sw=el('span','swatch'); sw.style.background=a.color; left.appendChild(sw); left.appendChild(document.createTextNode(a.label));
      s.appendChild(left);
      s.appendChild(el('span','sz', bytes(sz)+'  ·  '+pct+'%'));
      d.appendChild(s);
      var b = el('div','body');
      var bar = el('div','bar'); var fill=el('i'); fill.style.width=pct+'%'; fill.style.background=a.color; bar.appendChild(fill); b.appendChild(bar);
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

  if(ex.length===0){ detail.appendChild(el('div','empty','No exchanges captured in this session.')); }
  else select(0);
})();
`;
