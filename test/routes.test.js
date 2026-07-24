import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProxyServer } from '../src/proxy.js';
import { deriveToken, splitToken, routeDir, readRoutes, unknownTokenError } from '../src/routes.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function closeAll(...servers) {
  return Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}
function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-routes-'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Drive a request; captures status, body, and (for HEAD) headers. */
function driveRequest(proxyPort, { method = 'POST', path: urlPath, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, method, path: urlPath, headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── pure helpers ───────────────────────────────────────────────────────────

test('deriveToken is sha256(abs dir)[:8], idempotent and path-normalized', () => {
  const dir = mkTmpDir();
  const t = deriveToken(dir);
  assert.match(t, /^[0-9a-f]{8}$/);
  assert.equal(t, deriveToken(dir), 'idempotent');
  assert.equal(t, deriveToken(dir + '/'), 'trailing slash normalized');
  assert.equal(t, deriveToken(path.join(dir, 'sub', '..')), 'relative segments normalized');
  assert.notEqual(t, deriveToken(mkTmpDir()));
});

test('splitToken strips the leading token, preserving the query', () => {
  assert.deepEqual(splitToken('/abc12345/v1/messages?beta=true'), {
    token: 'abc12345',
    rest: '/v1/messages?beta=true',
    restPath: '/v1/messages',
  });
  assert.deepEqual(splitToken('/abc12345/api/hello'), { token: 'abc12345', rest: '/api/hello', restPath: '/api/hello' });
  assert.deepEqual(splitToken('/abc12345'), { token: 'abc12345', rest: '/', restPath: '/' });
});

test('routeDir handles string and {dir} shapes; readRoutes tolerates absence', () => {
  assert.equal(routeDir({ t: '/a/b' }, 't'), '/a/b');
  assert.equal(routeDir({ t: { dir: '/a/b' } }, 't'), '/a/b');
  assert.equal(routeDir({ t: '/a/b' }, 'missing'), null);
  assert.deepEqual(readRoutes('/no/such/routes.json'), {});
});

// ── routed proxy ─────────────────────────────────────────────────────────────

test('two tokens tee to their respective capture dirs; upstream path is stripped', async () => {
  const home = mkTmpDir();
  const dirA = path.join(mkTmpDir(), 'repoA', '.ccsnoop');
  const dirB = path.join(mkTmpDir(), 'repoB', '.ccsnoop');
  const tokenA = deriveToken(dirA);
  const tokenB = deriveToken(dirB);
  const routesFile = path.join(home, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ [tokenA]: dirA, [tokenB]: dirB }));

  const seenPaths = [];
  const upstream = http.createServer((req, res) => {
    seenPaths.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_stop\ndata: {}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ routesFile, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    const resA = await driveRequest(proxyPort, {
      path: `/${tokenA}/v1/messages?beta=true`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 'sA' }) } }),
    });
    const resB = await driveRequest(proxyPort, {
      path: `/${tokenB}/v1/messages`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 'sB' }) } }),
    });
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    const mA = await readManifest(path.join(dirA, 'sessions'), 'sA');
    const mB = await readManifest(path.join(dirB, 'sessions'), 'sB');
    assert.equal(mA[0].thread_id, 'sA');
    assert.equal(mB[0].thread_id, 'sB');

    // Upstream saw the stripped path and the restored first-party Host.
    assert.deepEqual(seenPaths.map((s) => s.url).sort(), ['/v1/messages', '/v1/messages?beta=true']);
    assert.ok(seenPaths.every((s) => s.host === 'api.anthropic.com'));

    // Request blob records the stripped upstream path, not the token-prefixed one.
    const blob = fs.readFileSync(path.join(dirA, 'sessions', 'sA', '0001.request.http'), 'utf8');
    assert.ok(blob.startsWith('POST /v1/messages?beta=true HTTP/1.1'));
    assert.ok(!blob.includes(tokenA));
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('HEAD /<token>/api/hello returns 200 for known and unknown tokens', async () => {
  const home = mkTmpDir();
  const routesFile = path.join(home, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({}));
  const upstream = http.createServer((req, res) => res.end('should-not-reach'));
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ routesFile, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    const r1 = await driveRequest(proxyPort, { method: 'HEAD', path: '/deadbeef/api/hello' });
    assert.equal(r1.status, 200, 'unknown token HEAD still 200 (a 4xx makes CC never send)');
    const r2 = await driveRequest(proxyPort, { method: 'HEAD', path: '/whatever/api/hello' });
    assert.equal(r2.status, 200);
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('HEAD /<token>/api/hello for a KNOWN token is answered locally, never forwarded', async () => {
  // The pre-flight must resolve to 200 without hitting the upstream, so that a
  // known repo's hello check never depends on api.anthropic.com's answer to a
  // HEAD /api/hello (spec §3.3).
  const home = mkTmpDir();
  const dir = path.join(mkTmpDir(), 'repo', '.ccsnoop');
  const token = deriveToken(dir);
  const routesFile = path.join(home, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ [token]: dir }));

  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.end('should-not-reach');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ routesFile, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    const r = await driveRequest(proxyPort, { method: 'HEAD', path: `/${token}/api/hello` });
    assert.equal(r.status, 200);
    assert.equal(upstreamHits, 0, 'known-token preflight is served locally, not proxied upstream');
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('POST with an unknown token → 502 + Anthropic-shaped body, logged, never forwarded', async () => {
  const home = mkTmpDir();
  const routesFile = path.join(home, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({}));

  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.end('ok');
  });
  const upstreamPort = await listen(upstream);
  const logged = [];
  const proxy = createProxyServer({
    routesFile,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    requestFn: http.request,
    log: (line) => logged.push(line),
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await driveRequest(proxyPort, {
      path: '/nope1234/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(res.status, 502);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'api_error');
    assert.match(parsed.error.message, /unknown route token nope1234/);
    assert.equal(res.body, unknownTokenError('nope1234'), 'body is the canonical error, verbatim');
    assert.equal(upstreamHits, 0, 'never forwarded upstream');
    assert.equal(logged.length, 1);
    assert.equal(logged[0], unknownTokenError('nope1234'), 'logged the same JSON to daemon.log');
  } finally {
    await closeAll(proxy, upstream);
  }
});

test('known token whose capture dir was deleted is recreated — capture continues, no 502', async () => {
  const home = mkTmpDir();
  const dir = path.join(mkTmpDir(), 'repo', '.ccsnoop');
  const token = deriveToken(dir);
  const routesFile = path.join(home, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ [token]: dir }));

  const upstream = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('event: message_stop\ndata: {}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ routesFile, upstreamHost: '127.0.0.1', upstreamPort, requestFn: http.request });
  const proxyPort = await listen(proxy);

  try {
    // The capture root does not exist yet (deleted / never created).
    assert.ok(!fs.existsSync(dir));
    const res = await driveRequest(proxyPort, {
      path: `/${token}/v1/messages`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: 'sess-recreate' }) } }),
    });
    assert.equal(res.status, 200, 'a deleted-but-registered dir is a live route, not an unknown token');
    const m = await readManifest(path.join(dir, 'sessions'), 'sess-recreate');
    assert.equal(m[0].thread_id, 'sess-recreate');
  } finally {
    await closeAll(proxy, upstream);
  }
});
