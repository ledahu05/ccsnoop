import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  parseRequestBlob,
  readUsage,
  computeAnatomy,
  buildExchange,
  contentForSlot,
  loadSession,
  listSessions,
  pickLatestSession,
  resolveRoots,
  generateReport,
  renderReport,
} from '../src/report.js';
import { buildRequestBlob, REDACTED } from '../src/capture.js';
import { segmentRequest } from '../src/waste.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-report-'));
}

// ── parseRequestBlob ────────────────────────────────────────────────────────

test('parseRequestBlob splits request line, headers, and JSON body', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x', messages: [] }));
  const blob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages?beta=true',
    rawHeaders: ['Host', 'localhost', 'Content-Type', 'application/json'],
    body,
  });
  const parsed = parseRequestBlob(blob);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.url, '/v1/messages?beta=true');
  assert.deepEqual(parsed.json, { model: 'claude-x', messages: [] });
  assert.ok(parsed.headers.some((h) => h.name === 'Content-Type' && h.value === 'application/json'));
});

test('parseRequestBlob keeps redaction visible in the raw text and body', () => {
  const blob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Authorization', 'Bearer sk-secret', 'X-Api-Key', 'sk-ant-abc'],
    body: Buffer.from('{}'),
  });
  const parsed = parseRequestBlob(blob);
  assert.ok(parsed.text.includes(REDACTED));
  assert.ok(!parsed.text.includes('sk-secret'));
});

test('parseRequestBlob tolerates a non-JSON body', () => {
  const parsed = parseRequestBlob('HEAD / HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(parsed.method, 'HEAD');
  assert.equal(parsed.json, null);
});

// ── contentForSlot (row expand: slot → raw content from the request body) ─────

test('contentForSlot indexes system blocks, tools by name, and messages by index', () => {
  const body = {
    system: [{ type: 'text', text: 'block zero' }, { type: 'text', text: 'block one' }],
    tools: [{ name: 'Bash', description: 'run' }, { name: 'Read' }],
    messages: [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'current' },
    ],
  };
  assert.deepEqual(contentForSlot(body, 'system#0'), { type: 'text', text: 'block zero' });
  assert.deepEqual(contentForSlot(body, 'system#1'), { type: 'text', text: 'block one' });
  assert.deepEqual(contentForSlot(body, 'tool:Bash'), { name: 'Bash', description: 'run' });
  assert.deepEqual(contentForSlot(body, 'tool:Read'), { name: 'Read' });
  assert.deepEqual(contentForSlot(body, 'message#0'), { role: 'user', content: 'earlier' });
  assert.deepEqual(contentForSlot(body, 'message#2'), { role: 'user', content: 'current' });
});

test('contentForSlot resolves a bare string system prompt via the "system" slot', () => {
  assert.equal(contentForSlot({ system: 'you are helpful' }, 'system'), 'you are helpful');
});

test('contentForSlot resolves every slot segmentRequest emits, incl. anonymous tools', () => {
  // A tool without a string `name` is slotted positionally (`tool:#<i>`); the
  // resolver must fall back to that index rather than a by-name lookup. Pairing
  // the two public functions keeps the row-expand path honest end to end: no
  // slot that segmentRequest emits may render as "(raw content unavailable)".
  const body = {
    system: [{ type: 'text', text: 'block zero' }],
    tools: [{ description: 'anon first' }, { name: 'Bash' }, { schema: {} }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'now' }],
  };
  for (const seg of segmentRequest(body)) {
    assert.notEqual(contentForSlot(body, seg.slot), undefined, `slot ${seg.slot} should resolve`);
  }
  // The anonymous entries specifically resolve to their original objects.
  assert.deepEqual(contentForSlot(body, 'tool:#0'), { description: 'anon first' });
  assert.deepEqual(contentForSlot(body, 'tool:#2'), { schema: {} });
});

test('contentForSlot returns undefined for missing/unknown slots and non-object bodies', () => {
  const body = { system: [{ text: 'a' }], tools: [{ name: 'Bash' }], messages: [{ role: 'user' }] };
  assert.equal(contentForSlot(body, 'system#5'), undefined);
  assert.equal(contentForSlot(body, 'tool:Nope'), undefined);
  assert.equal(contentForSlot(body, 'message#9'), undefined);
  assert.equal(contentForSlot(body, 'bogus'), undefined);
  assert.equal(contentForSlot(null, 'system#0'), undefined);
  assert.equal(contentForSlot(body, null), undefined);
});

// ── readUsage (SSE + JSON, no re-tokenization) ────────────────────────────────

test('readUsage reads usage/stop_reason from a reassembled SSE stream', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":800,"cache_creation_input_tokens":50,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const u = readUsage(sse);
  assert.equal(u.inputTokens, 1200);
  assert.equal(u.cacheReadInputTokens, 800);
  assert.equal(u.cacheCreationInputTokens, 50);
  assert.equal(u.outputTokens, 345, 'message_delta output_tokens wins over message_start');
  assert.equal(u.stopReason, 'end_turn');
  assert.equal(u.streaming, true);
});

test('readUsage reads a non-streaming JSON body', () => {
  const body = JSON.stringify({
    type: 'message',
    stop_reason: 'max_tokens',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
  });
  const u = readUsage(body);
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadInputTokens, 5);
  assert.equal(u.stopReason, 'max_tokens');
  assert.equal(u.streaming, false);
});

test('readUsage returns null when no usage is present', () => {
  assert.equal(readUsage(''), null);
  assert.equal(readUsage('ok'), null);
  assert.equal(readUsage('event: ping\ndata: {"type":"ping"}\n\n'), null);
  // An empty usage object carries no accounting either.
  assert.equal(readUsage('data: {"type":"message_start","message":{"usage":{}}}\n\n'), null);
});

test('readUsage keeps message_start input/cache figures when the delta omits usage', () => {
  const sse =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"output_tokens":1}}}\n\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
  const u = readUsage(sse);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.cacheReadInputTokens, 40);
  assert.equal(u.stopReason, 'end_turn');
});

test('readUsage gunzips a gzip-encoded SSE blob (content-encoding: gzip)', () => {
  // Anthropic serves the SSE stream gzipped; the captured blob is raw gzip
  // bytes. readUsage must detect the `1f 8b` magic and inflate before parsing,
  // or every real exchange reads usage=null (issue #53).
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":800,"cache_creation_input_tokens":50,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345}}',
    '',
  ].join('\n');
  const gz = zlib.gzipSync(Buffer.from(sse, 'utf8'));
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  const u = readUsage(gz);
  assert.notEqual(u, null, 'gzipped blob must not read as null usage');
  assert.equal(u.inputTokens, 1200);
  assert.equal(u.cacheReadInputTokens, 800);
  assert.equal(u.cacheCreationInputTokens, 50);
  assert.equal(u.outputTokens, 345);
  assert.equal(u.stopReason, 'end_turn');
  assert.equal(u.streaming, true);
});

test('readUsage falls back to null on a truncated/corrupt gzip blob without throwing', () => {
  // An aborted stream can leave the gzip member incomplete: the `1f 8b` magic is
  // present but inflation fails. readUsage must degrade to null (no accounting)
  // rather than propagate the zlib error (issue #53).
  const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n';
  const gz = zlib.gzipSync(Buffer.from(sse, 'utf8'));
  const truncated = gz.subarray(0, gz.length - 5);
  assert.equal(truncated[0], 0x1f);
  assert.equal(truncated[1], 0x8b);
  assert.equal(readUsage(truncated), null);
});

test('readUsage keeps the cache_creation tier breakdown (5m/1h multipliers, issue #45)', () => {
  // The thread carries `cache_creation.ephemeral_{5m,1h}_input_tokens` — the only
  // data that attributes a write to the right multiplier (×1.25 vs ×2). It lives
  // on disk and must survive normalization, not be flattened away.
  const sse =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":21394,' +
    '"cache_creation_input_tokens":24250,"cache_creation":{"ephemeral_5m_input_tokens":0,' +
    '"ephemeral_1h_input_tokens":24250},"output_tokens":2}}}\n\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":103}}\n\n';
  const u = readUsage(sse);
  assert.equal(u.cacheCreationInputTokens, 24250, 'flat field stays the source of truth');
  assert.equal(u.cacheCreation5mInputTokens, 0);
  assert.equal(u.cacheCreation1hInputTokens, 24250);
});

test('readUsage defaults the cache_creation tiers to 0 when the block is absent (no crash)', () => {
  const body = JSON.stringify({
    type: 'message',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 7 },
  });
  const u = readUsage(body);
  assert.equal(u.cacheCreationInputTokens, 7);
  assert.equal(u.cacheCreation5mInputTokens, 0);
  assert.equal(u.cacheCreation1hInputTokens, 0);
});

// ── computeAnatomy (byte-length buckets, never token counts) ──────────────────

test('computeAnatomy buckets system/tools/history/current-turn by JSON byte length', () => {
  const body = {
    system: [{ type: 'text', text: 'you are helpful' }],
    tools: [{ name: 'a' }, { name: 'b' }],
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'current question' },
    ],
  };
  const a = computeAnatomy(body);
  assert.ok(a.system > 0 && a.tools > 0 && a.history > 0 && a.currentTurn > 0);
  assert.equal(a.total, a.system + a.tools + a.history + a.currentTurn);
  assert.equal(a.currentTurn, Buffer.byteLength(JSON.stringify(body.messages[2])));
  assert.equal(a.history, Buffer.byteLength(JSON.stringify(body.messages.slice(0, 2))));
});

test('computeAnatomy is null-safe and handles a single-message request', () => {
  assert.deepEqual(computeAnatomy(null), { system: 0, tools: 0, history: 0, currentTurn: 0, total: 0 });
  const single = computeAnatomy({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(single.currentTurn > 0);
  assert.equal(single.history, 0);
});

// ── buildExchange ─────────────────────────────────────────────────────────────

test('buildExchange assembles derived model with duration and anatomy', () => {
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })),
  });
  const resp = Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
  const e = buildExchange(
    {
      turn: 3,
      thread_id: 'sess-1',
      parent_session_id: null,
      request_received_at: '2026-07-24T10:00:00.000Z',
      response_completed_at: '2026-07-24T10:00:01.500Z',
      request_blob: '0003.request.http',
      response_blob: '0003.response.sse',
    },
    req,
    resp
  );
  assert.equal(e.turn, 3);
  assert.equal(e.threadId, 'sess-1');
  assert.equal(e.durationMs, 1500);
  assert.equal(e.usage.inputTokens, 5);
  assert.ok(e.anatomy.total > 0);
  assert.ok(e.requestBlob.includes('POST /v1/messages'));
});

test('buildExchange yields durationMs null for missing or unparseable timestamps', () => {
  const req = buildRequestBlob({ method: 'POST', url: '/v1/messages', rawHeaders: [], body: Buffer.from('{}') });
  const resp = Buffer.alloc(0);
  const mk = (recv, comp) =>
    buildExchange({ request_received_at: recv, response_completed_at: comp, request_blob: 'r', response_blob: 's' }, req, resp);

  // No timestamps at all.
  assert.equal(mk(undefined, undefined).durationMs, null);
  // Only one side present.
  assert.equal(mk('2026-07-24T10:00:00.000Z', undefined).durationMs, null);
  // Both present but unparseable — must be null, never NaN (would render "NaN ms").
  const bad = mk('not-a-date', 'also-bad').durationMs;
  assert.equal(bad, null);
  assert.ok(!Number.isNaN(bad));
  // A completed-before-received clock skew clamps to 0, not a negative.
  assert.equal(mk('2026-07-24T10:00:05.000Z', '2026-07-24T10:00:00.000Z').durationMs, 0);
});

test('buildExchange reads usage null when the response blob is missing', () => {
  const req = buildRequestBlob({ method: 'POST', url: '/v1/messages', rawHeaders: [], body: Buffer.from('{}') });
  const e = buildExchange({ turn: 1, request_blob: 'r', response_blob: 's' }, req, Buffer.alloc(0));
  assert.equal(e.usage, null);
});

// ── discovery ─────────────────────────────────────────────────────────────────

test('pickLatestSession returns the most recently written session', () => {
  const chosen = pickLatestSession([
    { id: 'a', mtimeMs: 100 },
    { id: 'c', mtimeMs: 300 },
    { id: 'b', mtimeMs: 200 },
  ]);
  assert.equal(chosen.id, 'c');
  assert.equal(pickLatestSession([]), null);
});

test('resolveRoots defaults to <cwd>/.ccsnoop and honours --root', () => {
  assert.deepEqual(resolveRoots({ cwd: '/repo' }), [path.resolve('/repo', '.ccsnoop')]);
  assert.deepEqual(resolveRoots({ cwd: '/repo', root: 'custom' }), [path.resolve('/repo', 'custom')]);
});

test('resolveRoots --all reads the routes registry under CCSNOOP_HOME, not ~/.ccsnoop', () => {
  const home = mkTmpDir();
  const routeDir = path.join(home, 'repo-a', '.ccsnoop');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'routes.json'), JSON.stringify({ tok: routeDir }));
  const prev = process.env.CCSNOOP_HOME;
  process.env.CCSNOOP_HOME = home;
  try {
    const roots = resolveRoots({ cwd: '/repo', all: true });
    assert.ok(roots.includes(routeDir), `expected ${routeDir} in ${roots.join(', ')}`);
  } finally {
    if (prev === undefined) delete process.env.CCSNOOP_HOME;
    else process.env.CCSNOOP_HOME = prev;
  }
});

test('listSessions finds session dirs with a manifest under <root>/sessions', () => {
  const root = mkTmpDir();
  const sdir = path.join(root, 'sessions', 'sess-x');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'manifest.jsonl'), '{"turn":1}\n');
  // A dir without a manifest is ignored.
  fs.mkdirSync(path.join(root, 'sessions', 'not-a-session'), { recursive: true });
  const found = listSessions(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'sess-x');
});

test('listSessions falls back to session dirs directly under the root', () => {
  const root = mkTmpDir();
  const sdir = path.join(root, 'sess-bare');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'manifest.jsonl'), '{"turn":1}\n');
  const found = listSessions(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'sess-bare');
});

// ── end-to-end: capture-shaped fixture → HTML ────────────────────────────────

/** Write a minimal captured session dir the way the proxy would. */
function writeFixtureSession(root, id) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages?beta=true',
    rawHeaders: [
      'Host', 'localhost:41377',
      'Authorization', 'Bearer sk-super-secret',
      'Content-Type', 'application/json',
    ],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: 'system prompt' }],
        tools: [{ name: 'Bash' }, { name: 'Read' }],
        messages: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'earlier reply' },
          { role: 'user', content: 'current turn' },
        ],
        metadata: { user_id: JSON.stringify({ session_id: id }) },
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(
    path.join(dir, '0001.response.sse'),
    'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2000,"cache_read_input_tokens":1500,"cache_creation_input_tokens":100,"output_tokens":1}}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":250}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({
      turn: 1,
      request_received_at: '2026-07-24T10:00:00.000Z',
      response_completed_at: '2026-07-24T10:00:02.000Z',
      parent_session_id: null,
      thread_id: id,
      request_blob: '0001.request.http',
      response_blob: '0001.response.sse',
    }) + '\n'
  );
  return dir;
}

test('loadSession reads the manifest and derives usage + anatomy from the blobs', () => {
  const root = mkTmpDir();
  const dir = writeFixtureSession(root, 'sess-load');
  const model = loadSession(dir, 'sess-load');
  assert.equal(model.sessionId, 'sess-load');
  assert.equal(model.exchanges.length, 1);
  const e = model.exchanges[0];
  assert.equal(e.usage.inputTokens, 2000);
  assert.equal(e.usage.cacheReadInputTokens, 1500);
  assert.equal(e.usage.outputTokens, 250);
  assert.equal(e.durationMs, 2000);
  assert.ok(e.anatomy.system > 0 && e.anatomy.tools > 0);
});

test('renderReport emits ONE self-contained HTML — no external assets, redaction visible', () => {
  const root = mkTmpDir();
  const dir = writeFixtureSession(root, 'sess-html');
  const html = renderReport(loadSession(dir, 'sess-html'));

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('sess-html'));
  // Self-contained: no external stylesheets/scripts/images.
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external <link>');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external <script src>');
  assert.ok(!/https?:\/\/[^"'\s)]+\.(css|js)/i.test(html), 'no CDN asset URLs');
  // Anatomy sections present.
  for (const label of ['System', 'Tools', 'Message history', 'Current turn']) {
    assert.ok(html.includes(label), `anatomy label ${label} present`);
  }
  // Redaction rendered in the embedded raw payload; secret never leaks.
  assert.ok(html.includes(REDACTED), 'redaction token present in raw payload');
  assert.ok(!html.includes('sk-super-secret'), 'no secret leaked into the report');
});

test('renderReport ships the row-expand accordion wiring (issue #28)', () => {
  const root = mkTmpDir();
  const dir = writeFixtureSession(root, 'sess-expand');
  const html = renderReport(loadSession(dir, 'sess-expand'));
  // Nested <details> row accordion + raw pane + the shared slot resolver, all inline.
  assert.ok(html.includes('seg-row-acc'), 'nested row accordion class present');
  assert.ok(html.includes('seg-raw'), 'raw-content pane class present');
  assert.ok(html.includes('function contentForSlot'), 'slot resolver shipped to the client');
  assert.ok(html.includes('function segRow'), 'segRow builder present');
  // The row is a <summary>, i.e. the click target for native expand.
  assert.ok(/segRow[\s\S]*el\('summary'/.test(html), 'seg row is a summary (clickable)');
});

test('expanded row content is recoverable from the embedded redacted blob (issue #28)', () => {
  const root = mkTmpDir();
  const dir = writeFixtureSession(root, 'sess-recover');
  const model = loadSession(dir, 'sess-recover');
  const e = model.exchanges[0];
  // Re-run the client path in Node: parse the embedded blob, index by slot.
  const body = parseRequestBlob(e.requestBlob).json;
  const bySlot = Object.fromEntries(e.segments.map((s) => [s.slot, contentForSlot(body, s.slot)]));
  assert.deepEqual(bySlot['system#0'], { type: 'text', text: 'system prompt' });
  assert.deepEqual(bySlot['tool:Bash'], { name: 'Bash' });
  assert.deepEqual(bySlot['message#2'], { role: 'user', content: 'current turn' });
  // The blob is the redacted one, so no header secret can surface in an expansion.
  assert.ok(e.requestBlob.includes(REDACTED));
  assert.ok(!JSON.stringify(bySlot).includes('sk-super-secret'), 'secret never surfaces in expanded content');
});

test('generateReport discovers the latest session, writes a report file, honours --session', () => {
  const root = mkTmpDir();
  writeFixtureSession(root, 'old');
  const newDir = writeFixtureSession(root, 'new');
  // Make 'new' the most recently written manifest.
  const future = new Date('2027-01-01T00:00:00Z');
  fs.utimesSync(path.join(newDir, 'manifest.jsonl'), future, future);

  const res = generateReport({ cwd: '/nonexistent', root, out: undefined });
  assert.equal(res.sessionId, 'new', 'latest session chosen by default');
  assert.ok(fs.existsSync(res.outPath));
  assert.ok(fs.readFileSync(res.outPath, 'utf8').includes('<!doctype html>'));

  const picked = generateReport({ cwd: '/nonexistent', root, session: 'old' });
  assert.equal(picked.sessionId, 'old', '--session override');

  assert.throws(() => generateReport({ cwd: '/nonexistent', root, session: 'missing' }), /not found/);
});

test('generateReport throws a helpful error when no sessions exist', () => {
  const root = mkTmpDir();
  assert.throws(() => generateReport({ cwd: '/nonexistent', root }), /no captured sessions/);
});

// ── waste signals wired into the model + report (spec §2.4–2.5, issue #22) ─────

/** Write a two-request session whose second request re-sends a cold-cache prefix. */
function writeWasteSession(root, id) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const bigSys = 'S'.repeat(6000);
  const mkReq = (messages) =>
    buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-x', system: bigSys, tools: [{ name: 'Bash' }], messages })),
    });
  const mkResp = (input, cacheRead) =>
    'data: {"type":"message_start","message":{"usage":{"input_tokens":' +
    input +
    ',"cache_read_input_tokens":' +
    cacheRead +
    ',"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n';

  fs.writeFileSync(path.join(dir, '0001.request.http'), mkReq([{ role: 'user', content: 'q1' }]));
  fs.writeFileSync(path.join(dir, '0001.response.sse'), mkResp(2000, 0));
  // Second request re-sends the identical big system on a COLD cache → waste.
  fs.writeFileSync(
    path.join(dir, '0002.request.http'),
    mkReq([{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }])
  );
  fs.writeFileSync(path.join(dir, '0002.response.sse'), mkResp(3000, 0));

  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) +
      '\n' +
      JSON.stringify({ turn: 2, thread_id: id, request_blob: '0002.request.http', response_blob: '0002.response.sse' }) +
      '\n'
  );
  return dir;
}

test('loadSession attaches per-exchange waste + a session waste summary', () => {
  const root = mkTmpDir();
  const dir = writeWasteSession(root, 'sess-waste');
  const model = loadSession(dir, 'sess-waste');

  assert.ok(model.waste, 'session waste summary present');
  assert.ok(model.wasteConfig, 'resolved config echoed back');
  // First request: all new, no waste.
  assert.equal(model.exchanges[0].waste.reusedUncachedBytes, 0);
  // Second request: cold cache re-sends the big system block → reused-uncached waste.
  const e2 = model.exchanges[1];
  assert.ok(e2.waste.reusedUncachedBytes >= 6000, 'big system counted as re-sent waste');
  assert.equal(e2.waste.cold, true);
  const sys = e2.segments.find((s) => s.slot === 'system');
  assert.equal(sys.kind, 'reused-uncached');
  assert.equal(sys.flagship, true, 'static ∩ reused-uncached = flagship');
  assert.ok(model.waste.reusedUncachedBytes >= 6000);
  // The parsed body is dropped from the embedded model.
  assert.equal(model.exchanges[0].requestJson, undefined);
});

test('loadSession reads usage through gzipped blobs so a cache-warm lineage is not cold (#53)', () => {
  const root = mkTmpDir();
  const id = 'sess-gz';
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const bigSys = 'S'.repeat(6000);
  const mkReq = (messages) =>
    buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-x', system: bigSys, tools: [{ name: 'Bash' }], messages })),
    });
  const mkResp = (input, cacheRead) =>
    zlib.gzipSync(
      Buffer.from(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":' +
          input +
          ',"cache_read_input_tokens":' +
          cacheRead +
          ',"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
        'utf8'
      )
    );
  fs.writeFileSync(path.join(dir, '0001.request.http'), mkReq([{ role: 'user', content: 'q1' }]));
  fs.writeFileSync(path.join(dir, '0001.response.sse'), mkResp(6100, 0));
  // Second request re-sends the identical big system but the cache SERVED it.
  fs.writeFileSync(
    path.join(dir, '0002.request.http'),
    mkReq([{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }])
  );
  fs.writeFileSync(path.join(dir, '0002.response.sse'), mkResp(200, 6000));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) +
      '\n' +
      JSON.stringify({ turn: 2, thread_id: id, request_blob: '0002.request.http', response_blob: '0002.response.sse' }) +
      '\n'
  );

  const model = loadSession(dir, id);
  // Usage is read from the gzipped blob, not null.
  assert.notEqual(model.exchanges[1].usage, null, 'usage read through gzip');
  assert.equal(model.exchanges[1].usage.cacheReadInputTokens, 6000);
  // Having read 6000 cache tokens, the lineage is NOT cold and the re-sent
  // system is not counted as waste.
  assert.equal(model.exchanges[1].waste.cold, false, 'cache-warm lineage must not read as cold');
  assert.equal(model.exchanges[1].waste.reusedUncachedBytes, 0, 'cache-served prefix is not waste');
});

test('renderReport surfaces waste markers, tier coloring, and the headline metric', () => {
  const root = mkTmpDir();
  const dir = writeWasteSession(root, 'sess-waste-html');
  const html = renderReport(loadSession(dir, 'sess-waste-html'));
  // Headline waste metric labelled a proxy (spec §2.5).
  assert.ok(/re-sent/.test(html));
  assert.ok(/proxy/.test(html));
  // Tier + flagship rendering hooks are present in the client.
  assert.ok(html.includes('reused-uncached'));
  assert.ok(html.includes('flagship'));
  assert.ok(html.includes('cache boundary'));
});

test('generateReport honours report-time bloat threshold overrides', () => {
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'sess-bloat');
  fs.mkdirSync(dir, { recursive: true });
  const big = 'x'.repeat(20000);
  const body = {
    model: 'claude-x',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: 'tiny' }, { type: 'tool_result', content: big }] },
    ],
  };
  fs.writeFileSync(
    path.join(dir, '0001.request.http'),
    buildRequestBlob({ method: 'POST', url: '/v1/messages', rawHeaders: ['Content-Type', 'application/json'], body: Buffer.from(JSON.stringify(body)) })
  );
  fs.writeFileSync(path.join(dir, '0001.response.sse'), 'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 'sess-bloat', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );

  // Default floor flags the outlier.
  const def = loadSession(dir, 'sess-bloat');
  assert.equal(def.waste.bloatCount, 1);
  // A floor above the outlier suppresses it.
  const raised = loadSession(dir, 'sess-bloat', { bloatFloorBytes: 100000 });
  assert.equal(raised.waste.bloatCount, 0);
});
