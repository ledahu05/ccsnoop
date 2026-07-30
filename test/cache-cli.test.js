// Cache T6 (#87) — the surface: the `cache` subcommand CLI wiring + the
// per-transition card / lean rollup renderer (text + HTML).
//
// Render + CLI are smoke-only per the cache spec testing decisions: this pins
// SHAPE (exits 0, produces output, the card fields and rollup fields appear),
// never re-asserts the verdict logic (that is `cache.test.js`'s job at the
// `diagnoseCache` seam). A cold KEY turn is the cheapest session that yields a
// non-HIT card with a cost + a reco, so the card renderer is exercised for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { diagnoseCache, renderCache, cache } from '../src/cache.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-cache-t6-'));
}

/** Build a usage object the way readUsage() would (mirrors test/cache.test.js). */
function usage({ input = 0, cacheRead = 0, cacheCreation = 0, c1h = 0, c5m = 0, output = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    cacheCreation5mInputTokens: c5m,
    cacheCreation1hInputTokens: c1h,
    stopReason: null,
    streaming: true,
  };
}

/** A captured-session dir writer. `turns` is an array of { body, usageSse, recv, done }. */
function writeSession(dir, turns) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  turns.forEach((t, i) => {
    const n = String(i + 1).padStart(4, '0');
    const req = buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 1024, ...t.body })),
    });
    fs.writeFileSync(path.join(dir, `${n}.request.http`), req);
    fs.writeFileSync(path.join(dir, `${n}.response.sse`), t.usageSse ?? '');
    manifest.push({
      turn: i + 1,
      thread_id: t.threadId ?? 'A',
      request_blob: `${n}.request.http`,
      response_blob: `${n}.response.sse`,
      request_received_at: t.recv ?? null,
      response_completed_at: t.done ?? null,
    });
  });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), manifest.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return dir;
}

/** A 1 h write usage SSE line (the cold turn's re-write cost, ×2). */
function writeSse(u) {
  return (
    'data: {"type":"message_start","message":{"usage":' +
    JSON.stringify({
      input_tokens: u.input ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheCreation ?? 0,
      cache_creation: { ephemeral_1h_input_tokens: u.c1h ?? 0, ephemeral_5m_input_tokens: u.c5m ?? 0 },
    }) +
    '}}\n\n'
  );
}

// ── renderCache: pure shape over a structured Diagnostic ──────────────────────

test('renderCache (text): per-transition card carries turn → verdict → cause → cost → reco', () => {
  // A tools mutation (KEY) re-writing the whole prefix: cold turn with a 1 h write cost
  // and a batch-invalidating reco — a card with every field populated.
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:50:10Z', responseCompletedAt: '2026-07-28T07:50:11Z' },
    ],
    { ttl: 60000 }
  );
  const { lines } = renderCache(diag, { sessionId: 'sess-x' });
  const out = lines.join('\n');

  // Header names the session.
  assert.match(out, /ccsnoop cache/);
  assert.match(out, /sess-x/);
  // The card (turn 2 is the cold one; turn 1 is skipped as the establishing turn).
  assert.match(out, /turn 2/);
  assert.match(out, /STRUCTURAL/); // verdict (with KEY sub-mode)
  assert.match(out, /cause:/);
  // Cost: 1,000 raw × 2 = 2,000 tok-équ. (exact, 1 h tier — not a "—" or a bound).
  assert.match(out, /cost:/);
  assert.match(out, /2,000/);
  assert.match(out, /×2/);
  // The legitimate reco (batch the invalidating changes).
  assert.match(out, /reco:/);
});

test('renderCache (text): HIT turns are omitted from the cards but counted in the rollup', () => {
  // Turn 2 is a warm append-only HIT (no cold turn). No card should be rendered; the
  // rollup still reports the HIT count.
  const base = { system: 'sys', messages: [{ role: 'user', content: 'q1' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] };
  const diag = diagnoseCache([
    { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
    { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 5, cacheRead: 1000 }), requestReceivedAt: '2026-07-28T07:50:10Z', responseCompletedAt: '2026-07-28T07:50:11Z' },
  ]);
  const { lines } = renderCache(diag, { sessionId: 'warm' });
  const out = lines.join('\n');
  assert.doesNotMatch(out, /turn \d+/, 'no per-transition card when every turn is HIT');
  assert.match(out, /HIT/); // counted in the by-verdict rollup line
});

test('renderCache (text): lean rollup shows totals, by-verdict, deduped recos, summed counterfactual', () => {
  // Two cold KEY turns on the SAME tool slot → a chronicity reco + the fine-tune bridge
  // fire at the rollup (deduped once), never per-event.
  const base = (extra) => ({ tools: [{ name: 'WebSearch', description: extra }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q' }] });
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base('a'), usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
      { threadId: 'A', turn: 2, requestBody: base('b'), usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:51:00Z', responseCompletedAt: '2026-07-28T07:51:01Z' },
      { threadId: 'A', turn: 3, requestBody: base('c'), usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:52:00Z', responseCompletedAt: '2026-07-28T07:52:01Z' },
    ],
    { ttl: 60000 }
  );
  const { lines } = renderCache(diag, { sessionId: 'recur' });
  const out = lines.join('\n');

  // Rollup section + the three exact totals.
  assert.match(out, /rollup/i);
  assert.match(out, /write:/);
  assert.match(out, /read:/);
  assert.match(out, /wasted:/);
  // By-verdict count.
  assert.match(out, /by verdict/i);
  // Summed counterfactual.
  assert.match(out, /would have avoided re-writing/);
  // The deduped rollup recos appear ONCE each (chronicity + fine-tune bridge), not per turn.
  assert.match(out, /stabilize the volatile block/);
  assert.match(out, /fine-tune deny lever/);
  // No per-event "would have avoided" repetition inside the card region leaking into a
  // second copy — the rollup recos are deduped (one stabilize line, one bridge line).
  assert.equal((out.match(/stabilize the volatile block/g) || []).length, 1);
  assert.equal((out.match(/fine-tune deny lever/g) || []).length, 1);
});

test('renderCache (html): a self-contained HTML doc renders the same data', () => {
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000, c1h: 1000 }), requestReceivedAt: '2026-07-28T07:50:10Z', responseCompletedAt: '2026-07-28T07:50:11Z' },
    ],
    { ttl: 60000 }
  );
  const { html } = renderCache(diag, { sessionId: 'sess-x' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html/i);
  assert.match(html, /sess-x/); // same session id surfaced
  assert.match(html, /STRUCTURAL/); // same verdict surfaced
  assert.match(html, /rollup/i); // same rollup surfaced
});

// ── cache() entry point: discovery + load + diagnose + render ─────────────────

test('cache(): --sessions-dir resolves the session and renders text by default', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-cache'), [
    { body: { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 10 }) },
    { body: { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 900, cacheCreation: 1000, c1h: 1000 }) },
  ]);
  const res = cache({ cwd: '/nonexistent', sessionsDir: root, session: 'cli-cache' });
  assert.equal(res.sessionId, 'cli-cache');
  assert.ok(res.lines.length > 0);
  assert.ok(res.html.includes('cli-cache'));
  assert.match(res.lines.join('\n'), /STRUCTURAL/);
});

test('cache(): --root default discovery finds the latest session', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 's1'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'a' }] }, usageSse: writeSse({ input: 10 }) },
  ]);
  // Age s1 into the past so the later-written s2 is unambiguously newest by mtime.
  const past = new Date('2020-01-01T00:00:00Z').getTime() / 1000;
  fs.utimesSync(path.join(root, 'sessions', 's1', 'manifest.jsonl'), past, past);
  writeSession(path.join(root, 'sessions', 's2'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'b' }] }, usageSse: writeSse({ input: 10 }) },
  ]);
  // No --session ⇒ latest (by manifest mtime), mirroring report.
  const res = cache({ cwd: '/nonexistent', root });
  assert.equal(res.sessionId, 's2');
});

test('cache(): --ttl <seconds> is honored as the TEMPORAL threshold', () => {
  // A gap under the default TTL (1 h) would be UNEXPLAINED; --ttl 1 (1 s) makes the same
  // gap read TEMPORAL. Both renders must succeed; the threshold flows from the flag.
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'ttl'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 10 }), recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    // Append-only (content identical prefix) but cold (cacheRead 0) with a 10 s gap.
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, usageSse: writeSse({ input: 900, cacheCreation: 1000, c1h: 1000 }), recv: '2026-07-28T07:50:11Z', done: '2026-07-28T07:50:12Z' },
  ]);
  const short = cache({ cwd: '/nonexistent', sessionsDir: root, session: 'ttl', ttlSeconds: 1 });
  assert.match(short.lines.join('\n'), /TEMPORAL/, '--ttl 1s ⇒ the 10 s gap is past the TTL');
});

// ── CLI dispatch smoke (AC: exits 0, produces output; mirrors report/fine-tune) ─

test('ccsnoop cache --sessions-dir renders text and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-smoke'), [
    { body: { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 10 }) },
    { body: { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 900, cacheCreation: 1000, c1h: 1000 }) },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'cache', '--sessions-dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /cli-smoke/);
  assert.match(r.stdout, /STRUCTURAL/);
  assert.match(r.stdout, /rollup/i);
});

test('ccsnoop cache --html renders an HTML document and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-html'), [
    { body: { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 10 }) },
    { body: { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 900, cacheCreation: 1000, c1h: 1000 }) },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'cache', '--sessions-dir', root, '--html'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /<!doctype html>/i);
  assert.match(r.stdout, /cli-html/);
});

test('cache is a registered subcommand (no "unknown subcommand")', () => {
  // A bare `cache --help`-less invocation against an empty root errors on the missing
  // session, NOT on an unknown subcommand — proving `cache` is in the dispatch table.
  const root = mkTmpDir();
  const r = spawnSync(process.execPath, [BIN, 'cache', '--root', root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no captured sessions/);
  assert.doesNotMatch(r.stderr, /unknown subcommand/);
});

test('ccsnoop cache --help lists the cache command', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bcache\b/);
});

// ── degraded / hostile inputs ─────────────────────────────────────────────────

test('renderCache: a tier-unknown write is a bound, never a false-precise number', () => {
  // `usage` reports cache_creation_input_tokens with no per-tier breakdown: the cost is
  // knowable only as the ×1.25–×2 span (cache spec: never invent the tier).
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900, cacheCreation: 1000 }), requestReceivedAt: '2026-07-28T07:50:10Z', responseCompletedAt: '2026-07-28T07:50:11Z' },
    ],
    { ttl: 60000 }
  );
  const out = renderCache(diag, { sessionId: 'unk' }).lines.join('\n');
  assert.match(out, /1,250–2,000 tok-équ\. \(bound\)/);
  assert.match(out, /×1\.25–×2 \(tier unknown\)/);
});

test('renderCache: a usage-absent turn renders "—" for the cost, not a zero', () => {
  const base = { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const cur = { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] };
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: null },
      { threadId: 'A', turn: 2, requestBody: cur, usage: null },
    ],
    { ttl: 60000 }
  );
  const out = renderCache(diag, { sessionId: 'nousage' }).lines.join('\n');
  assert.match(out, /cost: +—/);
});

test('renderCache: a composite card lists each non-HIT region with its range and cause', () => {
  // A prefix edit AND a past-TTL cold head in the same turn (see cache.test.js) — the
  // card must show both regions rather than only its headline.
  const base = { system: 'sys', messages: [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }] };
  const cur = { system: 'sys', messages: [{ role: 'user', content: 'A-EDITED' }, { role: 'user', content: 'B' }] };
  const diag = diagnoseCache(
    [
      { threadId: 'A', turn: 1, requestBody: base, usage: usage({ input: 10 }), requestReceivedAt: '2026-07-28T07:50:00Z', responseCompletedAt: '2026-07-28T07:50:01Z' },
      { threadId: 'A', turn: 2, requestBody: cur, usage: usage({ input: 900 }), requestReceivedAt: '2026-07-28T07:52:01Z', responseCompletedAt: '2026-07-28T07:52:02Z' },
    ],
    { ttl: 60000 }
  );
  assert.equal(diag.transitions[0].composite, true, 'the fixture is a composite card');
  const { lines, html } = renderCache(diag, { sessionId: 'comp' });
  const out = lines.join('\n');
  assert.match(out, /\[composite\]/);
  assert.match(out, /STRUCTURAL·PREFIX @ message#0/);
  assert.match(out, /TEMPORAL/);
  assert.match(out, /\[\d+\.\.\d+\)/, 'each region carries its segment range');
  assert.match(html, /composite/);
});

test('renderCache (html): a session id carrying markup is escaped, not injected', () => {
  const diag = diagnoseCache([]);
  const { html } = renderCache(diag, { sessionId: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('cache(): a session whose manifest is empty renders a no-transitions diagnostic', () => {
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'empty');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), '');
  const res = cache({ cwd: '/nonexistent', sessionsDir: root });
  assert.equal(res.transitions, 0);
  assert.match(res.lines.join('\n'), /No cold transitions/);
});

test('cache(): an aborted turn (no response blob) degrades instead of throwing', () => {
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'aborted');
  writeSession(dir, [
    { body: { tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: writeSse({ input: 10 }) },
    { body: { tools: [{ name: 'Bash', description: 'changed' }], system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'q1' }] }, usageSse: '' },
  ]);
  fs.rmSync(path.join(dir, '0002.response.sse'));
  const res = cache({ cwd: '/nonexistent', sessionsDir: root, session: 'aborted' });
  assert.match(res.lines.join('\n'), /cost: +—/, 'no usage ⇒ no cost, never a fabricated one');
});

test('cache(): an unknown --session names the sessions that do exist', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'real'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'a' }] }, usageSse: writeSse({ input: 10 }) },
  ]);
  assert.throws(() => cache({ cwd: '/nonexistent', sessionsDir: root, session: 'ghost' }), /ghost.*not found.*real/s);
});

test('ccsnoop cache: a non-numeric --ttl fails loudly instead of silently using the default', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'ttl-bad'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'a' }] }, usageSse: writeSse({ input: 10 }) },
  ]);
  for (const bad of ['abc', '-5', '']) {
    const r = spawnSync(process.execPath, [BIN, 'cache', '--sessions-dir', root, '--ttl', bad], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `--ttl '${bad}' should be rejected`);
    assert.match(r.stderr, /--ttl expects a non-negative number of seconds/);
  }
});
