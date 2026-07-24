import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProxyServer } from '../src/proxy.js';
import { REDACTED } from '../src/capture.js';

/** Listen on an ephemeral port and resolve the bound port. */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeAll(...servers) {
  return Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

/**
 * Drive one request through the proxy and collect the client-side response.
 * @returns {Promise<{ status: number, body: string }>}
 */
function driveRequest(proxyPort, { method = 'POST', path: urlPath = '/v1/messages', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, method, path: urlPath, headers },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-test-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the manifest lines of a session dir. The manifest line is appended once
 * the response blob finishes flushing (just after the client sees end-of-body),
 * so poll briefly for the expected line count.
 */
async function readManifest(sessionsDir, sessionId, expectedLines = 1) {
  const p = path.join(sessionsDir, sessionId, 'manifest.jsonl');
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= expectedLines) return lines.map((l) => JSON.parse(l));
    }
    await sleep(10);
  }
  throw new Error(`manifest for ${sessionId} never reached ${expectedLines} line(s)`);
}

test('tees an SSE exchange to disk: redacted request blob + verbatim response + manifest', async () => {
  const sessionsDir = mkTmpDir();

  // Fake upstream that streams an SSE response in multiple chunks.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({
    sessionsDir,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    requestFn: http.request,
  });
  const proxyPort = await listen(proxy);

  try {
    const requestBody = JSON.stringify({
      model: 'claude-x',
      metadata: { user_id: JSON.stringify({ session_id: 'sess-abc' }) },
    });
    const res = await driveRequest(proxyPort, {
      path: '/v1/messages?beta=true',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-super-secret',
        'x-api-key': 'sk-ant-leak',
      },
      body: requestBody,
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.includes('message_start') && res.body.includes('message_stop'), 'SSE streamed to client');

    // Manifest line carries thread_id + parent_session_id + blob pointers.
    const manifest = await readManifest(sessionsDir, 'sess-abc');
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].thread_id, 'sess-abc');
    assert.equal(manifest[0].parent_session_id, null);
    assert.equal(manifest[0].turn, 1);
    assert.equal(manifest[0].request_blob, '0001.request.http');
    assert.equal(manifest[0].response_blob, '0001.response.sse');
    assert.ok(manifest[0].request_received_at && manifest[0].response_completed_at);

    const dir = path.join(sessionsDir, 'sess-abc');
    const reqBlob = fs.readFileSync(path.join(dir, '0001.request.http'), 'utf8');
    const respBlob = fs.readFileSync(path.join(dir, '0001.response.sse'), 'utf8');

    // Redaction: secrets gone, body byte-identical.
    assert.ok(!reqBlob.includes('sk-super-secret'), 'authorization redacted');
    assert.ok(!reqBlob.includes('sk-ant-leak'), 'x-api-key redacted');
    assert.ok(reqBlob.includes(`authorization: ${REDACTED}`) || reqBlob.includes(`Authorization: ${REDACTED}`));
    assert.ok(reqBlob.endsWith(requestBody), 'request body byte-identical to what the client sent');

    // Response persisted verbatim.
    assert.ok(respBlob.includes('message_start') && respBlob.includes('message_stop'));
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('sub-agent exchange folds into the parent dir, keeps its own thread_id', async () => {
  const sessionsDir = mkTmpDir();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ sessionsDir, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    await driveRequest(proxyPort, {
      body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 'root' }) } }),
    });
    await driveRequest(proxyPort, {
      body: JSON.stringify({
        metadata: { user_id: JSON.stringify({ session_id: 'child', parent_session_id: 'root' }) },
      }),
    });

    const manifest = await readManifest(sessionsDir, 'root', 2);
    assert.equal(manifest.length, 2, 'both exchanges land in the root dir');
    const threads = manifest.map((m) => m.thread_id).sort();
    assert.deepEqual(threads, ['child', 'root']);
    const child = manifest.find((m) => m.thread_id === 'child');
    assert.equal(child.parent_session_id, 'root');
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('missing metadata falls back to a single proxy-lifecycle session (no crash)', async () => {
  const sessionsDir = mkTmpDir();
  const upstream = http.createServer((req, res) => res.end('ok'));
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    sessionsDir,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    requestFn: http.request,
    lifecycleId: 'lifecycle-1',
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await driveRequest(proxyPort, { body: JSON.stringify({ model: 'x', no: 'metadata' }) });
    assert.equal(res.status, 200);

    const manifest = await readManifest(sessionsDir, 'lifecycle-1');
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].thread_id, 'lifecycle-1');
    assert.equal(manifest[0].parent_session_id, null);
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('does not buffer the full response body (bytes flow through before upstream ends)', async () => {
  const sessionsDir = mkTmpDir();

  let releaseSecondChunk;
  const gate = new Promise((r) => (releaseSecondChunk = r));

  const upstream = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: first\ndata: {}\n\n');
    // Hold the stream open — the client must receive the first chunk before the
    // upstream body is complete. A buffering proxy would deadlock this test.
    await gate;
    res.write('event: second\ndata: {}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ sessionsDir, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    const firstChunk = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages' },
        (res) => {
          res.once('data', (c) => {
            resolve(c.toString());
            releaseSecondChunk(); // let the upstream finish now that we've proven streaming
            res.resume();
          });
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 's' }) } }));
    });

    assert.ok(firstChunk.includes('first'), 'first SSE chunk arrived before the upstream body completed');
  } finally {
    await closeAll(proxy, upstream);
  }
});
