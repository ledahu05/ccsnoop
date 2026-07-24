import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRequestBlob,
  readUsage,
  computeAnatomy,
  buildExchange,
  loadSession,
  listSessions,
  pickLatestSession,
  resolveRoots,
  generateReport,
  renderReport,
} from '../src/report.js';
import { buildRequestBlob, REDACTED } from '../src/capture.js';

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
