// Probe for issue #48 (map #46): are two `claude -p` runs of the same prompt
// comparable, and are all four omniris_tuning.md levers visible in request #1?
//
// Uses the repo's OWN parser — `loadSession` / `readUsage` / `computeAnatomy`
// from src/report.js, `segmentRequest` from src/waste.js. No second parser.
//
// NON-NEGOTIABLE: never re-tokenize. Every size printed here is BYTES
// (`Segment.bytes` / `Anatomy.*`). Tokens come ONLY from captured `usage`.
//
// Usage:  node docs/research/probes/bench-run-comparability-probe.mjs <sessionDir>...

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadSession, readUsage } from '../../../src/report.js';
import { segmentRequest, computeWaste } from '../../../src/waste.js';

// Captured response blobs are stored as the raw wire bytes, which are GZIPPED
// (CC sends `Accept-Encoding: gzip`). `readUsage()` therefore sees binary and
// returns null. This probe gunzips first so the `usage` accounting is readable —
// still never re-tokenizing: the numbers come from the captured `usage` object.
function usageOf(dir, blob) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, blob));
  } catch {
    return null;
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf);
    } catch {
      /* truncated stream — fall through */
    }
  }
  return readUsage(buf);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node bench-run-comparability-probe.mjs <sessionDir>...');
  process.exit(2);
}

// ── lever fingerprints ───────────────────────────────────────────────────────
// Each lever is located by a distinctive substring in the canonical JSON of a
// segment. Reported as: which slot carries it + that segment's bytes.
const LEVERS = {
  'L1 tools[] schemas': (slot, text) => slot.startsWith('tool:'),
  'L2 SessionStart hook msg': (slot, text) => /SessionStart:\w+ hook/.test(text),
  'L3 CLAUDE.md': (slot, text) => /# claudeMd/.test(text),
  'L4 deferred-MCP listing': (slot, text) => /deferred tools are now available via ToolSearch/.test(text),
};

// Finer than a slot: CC packs several independent injections as separate text
// blocks inside ONE message. Bucket totals hide them; the bench needs them named.
const BLOCK_KINDS = [
  ['L2 SessionStart hook', /^<system-reminder>\nSessionStart:/],
  ['L3 claudeMd', /^<system-reminder>\n(?:.*\n)?As you answer the user's questions[\s\S]*# claudeMd/],
  ['L4 deferred tools/MCP', /^<system-reminder>\nThe following deferred tools/],
  ['agent-types listing', /^<system-reminder>\nAvailable agent types/],
  ['skills listing', /^<system-reminder>\nThe following skills are available/],
  ['other <system-reminder>', /^<system-reminder>/],
];

/** Per-text-block breakdown of every message in a request. */
function blockBreakdown(body) {
  /** @type {Array<{msg:number,role:string,block:number,kind:string,bytes:number,head:string}>} */
  const rows = [];
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  msgs.forEach((m, i) => {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    blocks.forEach((b, j) => {
      const text = typeof b?.text === 'string' ? b.text : '';
      const kind = BLOCK_KINDS.find(([, re]) => re.test(text))?.[0] ?? `${b?.type ?? '?'} (payload)`;
      rows.push({
        msg: i,
        role: m.role,
        block: j,
        kind,
        bytes: Buffer.byteLength(JSON.stringify(b), 'utf8'),
        head: text.replace(/\n/g, ' ').slice(0, 48),
      });
    });
  });
  return rows;
}

/** Canonical text of a segment, re-derived the same way waste.js sizes it. */
function slotTexts(body) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (Array.isArray(body?.system)) body.system.forEach((b, i) => out.set(`system#${i}`, JSON.stringify(b)));
  else if (body?.system != null) out.set('system', JSON.stringify(body.system));
  if (Array.isArray(body?.tools))
    body.tools.forEach((t, i) => out.set(`tool:${t?.name ?? `#${i}`}`, JSON.stringify(t)));
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  msgs.forEach((m, i) => out.set(`message#${i}`, JSON.stringify(m)));
  return out;
}

function rawBody(dir, blob) {
  const text = fs.readFileSync(path.join(dir, blob), 'utf8');
  const sep = text.indexOf('\r\n\r\n');
  try {
    return JSON.parse(sep >= 0 ? text.slice(sep + 4) : text);
  } catch {
    return null;
  }
}

/** @type {Array<{id:string,dir:string,model:any,first:any,firstSegs:any[],firstSlots:Map<string,string>}>} */
const loaded = [];

for (const dir of dirs) {
  const abs = path.resolve(dir);
  const model = loadSession(abs);
  const lines = fs
    .readFileSync(path.join(abs, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`\n${'='.repeat(78)}\nSESSION ${model.sessionId}\n  dir: ${abs}`);

  // Re-run computeWaste with GUNZIPPED usage — what the cache axis says once the
  // encoding is handled. `loadSession`'s own usage is null on gzipped blobs.
  const gzUsage = lines.map((l) => usageOf(abs, l.response_blob));
  const gzWaste = computeWaste(
    model.exchanges.map((e, i) => ({
      threadId: e.threadId,
      requestBody: rawBody(abs, lines[i].request_blob),
      usage: gzUsage[i],
    }))
  );
  console.log(
    `  usage readable by readUsage() as captured: ${model.exchanges.filter((e) => e.usage).length}/${model.exchanges.length}` +
      `  |  after gunzip: ${gzUsage.filter(Boolean).length}/${gzUsage.length}`
  );

  // ── per-exchange table: anatomy bytes + captured usage tokens + waste ──────
  console.log(
    '  turn  method url                bytes:sys/tools/hist/cur = total  | usage in/cacheR/cacheW/out | waste (gunzipped usage)'
  );
  model.exchanges.forEach((e, i) => {
    const a = e.anatomy;
    const u = gzUsage[i];
    e.waste = gzWaste.perExchange[i];
    const ut = u ? `${u.inputTokens}/${u.cacheReadInputTokens}/${u.cacheCreationInputTokens}/${u.outputTokens}` : '—';
    console.log(
      `  ${String(e.turn).padEnd(5)} ${e.method.padEnd(6)} ${String(e.url).slice(0, 18).padEnd(18)} ` +
        `${a.system}/${a.tools}/${a.history}/${a.currentTurn} = ${a.total}  | ${ut} | ` +
        `cold=${e.waste.cold} reusedUncached=${e.waste.reusedUncachedBytes}B ` +
        `flagship=${e.waste.flagshipCount}(${e.waste.flagshipBytes}B) boundary=${e.waste.cacheBoundary}`
    );
  });

  // ── "request #1" = first exchange whose body carries a non-empty tools[] ───
  let firstIdx = -1;
  const bodies = lines.map((l) => rawBody(abs, l.request_blob));
  bodies.forEach((b, i) => {
    if (firstIdx < 0 && Array.isArray(b?.tools) && b.tools.length > 0) firstIdx = i;
  });
  if (firstIdx < 0) {
    console.log('  (no exchange carries tools[] — nothing to fingerprint)');
    continue;
  }
  const body = bodies[firstIdx];
  const segs = segmentRequest(body);
  const texts = slotTexts(body);
  console.log(
    `\n  request #1 (first POST carrying tools[]) = manifest line ${firstIdx + 1} (${lines[firstIdx].request_blob}), model=${body.model}`
  );

  // ── Q1: the four levers, by slot + Segment.bytes ───────────────────────────
  for (const [lever, match] of Object.entries(LEVERS)) {
    const hits = segs.filter((s) => match(s.slot, texts.get(s.slot) ?? ''));
    const bytes = hits.reduce((n, s) => n + s.bytes, 0);
    const where =
      hits.length === 0
        ? 'ABSENT'
        : hits.length <= 4
          ? hits.map((s) => s.slot).join(', ')
          : `${hits.length} slots (${hits[0].slot} … ${hits[hits.length - 1].slot})`;
    console.log(`    ${lever.padEnd(26)} ${String(bytes).padStart(7)} B  ${where}`);
  }

  // ── block-level breakdown of request #1 (levers are packed inside messages) ─
  console.log('    per-block breakdown of request #1 messages:');
  for (const r of blockBreakdown(body))
    console.log(
      `      msg#${r.msg}(${r.role})/block${r.block} ${String(r.bytes).padStart(6)} B  ${r.kind.padEnd(24)} ${r.head}`
    );

  // ── bytes-per-token ratio, derived from THIS capture (never a tokenizer) ───
  for (const e of model.exchanges) {
    const u = gzUsage[model.exchanges.indexOf(e)];
    if (!u || e.anatomy.total === 0) continue;
    const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    if (prompt > 0)
      console.log(
        `    ratio turn ${e.turn}: ${e.anatomy.total} B / ${prompt} prompt tok = ${(e.anatomy.total / prompt).toFixed(2)} B/tok (capture-specific)`
      );
  }

  console.log(`    tools[] order: ${segs.filter((s) => s.bucket === 'tools').map((s) => s.slot.slice(5)).join(',')}`);
  // Segments for EVERY POST carrying tools[], so the pair diff can cover turn 2+.
  const allSegs = bodies.map((b) => (Array.isArray(b?.tools) && b.tools.length ? segmentRequest(b) : null));
  loaded.push({ id: model.sessionId, dir: abs, model, first: body, firstSegs: segs, allSegs });
}

// ── Q3/Q4: pairwise slot-level diff of request #1 between runs ───────────────
for (let i = 0; i + 1 < loaded.length; i++) {
  const A0 = loaded[i];
  const B0 = loaded[i + 1];
  console.log(`\n${'='.repeat(78)}\nPAIR DIFF  ${A0.id}  vs  ${B0.id}`);
  // Compare the k-th tools[]-bearing POST of run A against that of run B.
  const seqA = A0.allSegs.filter(Boolean);
  const seqB = B0.allSegs.filter(Boolean);
  for (let k = 0; k < Math.min(seqA.length, seqB.length); k++) {
    console.log(`\n--- POST #${k + 1} (tools[]-bearing) ---`);
    diffPair({ ...A0, firstSegs: seqA[k] }, { ...B0, firstSegs: seqB[k] });
  }
}

function diffPair(A, B) {
  const byteOf = (segs) => new Map(segs.map((s) => [s.slot, s.bytes]));
  const hashOf = (segs) => new Map(segs.map((s) => [s.slot, s.hash]));
  const [ba, bb] = [byteOf(A.firstSegs), byteOf(B.firstSegs)];
  const [ha, hb] = [hashOf(A.firstSegs), hashOf(B.firstSegs)];
  const slots = [...new Set([...ba.keys(), ...bb.keys()])];

  const bucketOf = new Map([...A.firstSegs, ...B.firstSegs].map((s) => [s.slot, s.bucket]));
  /** @type {Record<string,{same:number,diff:number,deltaAbs:number}>} */
  const per = {};
  const changed = [];
  for (const slot of slots) {
    const bucket = bucketOf.get(slot);
    per[bucket] ??= { same: 0, diff: 0, deltaAbs: 0 };
    const same = ha.get(slot) === hb.get(slot);
    if (same) per[bucket].same++;
    else {
      per[bucket].diff++;
      const d = (bb.get(slot) ?? 0) - (ba.get(slot) ?? 0);
      per[bucket].deltaAbs += Math.abs(d);
      changed.push({ slot, bucket, a: ba.get(slot) ?? 0, b: bb.get(slot) ?? 0, d });
    }
  }

  console.log('  bucket        slots identical / differing   sum|Δbytes|   bucket total A → B');
  for (const bucket of ['system', 'tools', 'history', 'currentTurn']) {
    const p = per[bucket] ?? { same: 0, diff: 0, deltaAbs: 0 };
    const ta = A.firstSegs.filter((s) => s.bucket === bucket).reduce((n, s) => n + s.bytes, 0);
    const tb = B.firstSegs.filter((s) => s.bucket === bucket).reduce((n, s) => n + s.bytes, 0);
    console.log(
      `  ${bucket.padEnd(13)} ${String(p.same).padStart(3)} / ${String(p.diff).padStart(3)}` +
        `                 ${String(p.deltaAbs).padStart(7)}   ${ta} → ${tb} (Δ${tb - ta})`
    );
  }
  console.log('  differing slots:');
  for (const c of changed.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)))
    console.log(`    ${c.bucket}/${c.slot.padEnd(28)} ${c.a} → ${c.b}  (Δ${c.d})`);

  const orderA = A.firstSegs.filter((s) => s.bucket === 'tools').map((s) => s.slot);
  const orderB = B.firstSegs.filter((s) => s.bucket === 'tools').map((s) => s.slot);
  const sameOrder = orderA.length === orderB.length && orderA.every((s, k) => s === orderB[k]);
  console.log(`  tools[] ORDER identical: ${sameOrder}` + (sameOrder ? '' : `\n    A: ${orderA}\n    B: ${orderB}`));

  // LCP over the hash sequence — what classifySegments would see cross-run.
  let lcp = 0;
  while (lcp < A.firstSegs.length && lcp < B.firstSegs.length && A.firstSegs[lcp].hash === B.firstSegs[lcp].hash) lcp++;
  const lcpBytes = A.firstSegs.slice(0, lcp).reduce((n, s) => n + s.bytes, 0);
  const totalA = A.firstSegs.reduce((n, s) => n + s.bytes, 0);
  console.log(
    `  cross-run hash LCP: ${lcp}/${A.firstSegs.length} segments = ${lcpBytes}B of ${totalA}B (${((100 * lcpBytes) / totalA).toFixed(1)}%)`
  );
}
