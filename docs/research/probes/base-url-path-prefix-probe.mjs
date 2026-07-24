#!/usr/bin/env node
// Smoke-test probe for ccsnoop issue #14:
// Does Claude Code preserve a PATH PREFIX in ANTHROPIC_BASE_URL?
//
// Stands up a localhost HTTP server that logs the first request line + headers,
// points Claude Code at http://localhost:<port>/probe-token via ANTHROPIC_BASE_URL,
// drives ONE real `claude -p` request, and prints exactly what arrived.
//
// Also probes the comment's "cheap insurance": does CC forward a custom header
// (ANTHROPIC_CUSTOM_HEADERS) to the upstream? That would be a routing
// discriminator with no path-preservation dependency.
//
// Usage: node base-url-path-prefix-probe.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';

const PROBE_TOKEN = 'probe-token';
const CUSTOM_HEADER_NAME = 'x-ccsnoop-token';
const CUSTOM_HEADER_VALUE = 'route-abc123';

const received = [];

const server = http.createServer((req, res) => {
  received.push({
    method: req.method,
    url: req.url,                // <-- the path line as it ARRIVED
    httpVersion: req.httpVersion,
    host: req.headers['host'],
    customHeader: req.headers[CUSTOM_HEADER_NAME] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  // Return a minimal error so CC stops immediately; we only need the request line.
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe' } }));
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/${PROBE_TOKEN}`;
  console.log(`[probe] server on 127.0.0.1:${port}`);
  console.log(`[probe] ANTHROPIC_BASE_URL=${baseUrl}`);

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'sk-ant-probe-dummy-key',
    ANTHROPIC_CUSTOM_HEADERS: `${CUSTOM_HEADER_NAME}: ${CUSTOM_HEADER_VALUE}`,
  };
  // Drop any inherited entrypoint marker so the child launches as a fresh CLI invocation.
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn('claude', ['-p', 'say hi', '--model', 'claude-haiku-4-5-20251001'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);

  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
  child.on('close', (code) => {
    clearTimeout(timer);
    setTimeout(() => {
      console.log('\n=== claude exit code:', code, '===');
      if (out.trim()) console.log('--- claude stdout ---\n' + out.trim());
      if (err.trim()) console.log('--- claude stderr ---\n' + err.trim());
      console.log('\n=== REQUESTS RECEIVED BY PROBE SERVER (' + received.length + ') ===');
      console.log(JSON.stringify(received, null, 2));
      server.close();
      process.exit(0);
    }, 250);
  });
});
