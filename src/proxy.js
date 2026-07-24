// Capture proxy core (spec §1.1–1.6).
//
// A from-scratch HTTP/1.1 reverse proxy Claude Code is pointed at via
// ANTHROPIC_BASE_URL. It forwards to api.anthropic.com and tees byte-faithful,
// redacted captures to disk — streaming SSE responses through without ever
// holding the full body.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

import {
  UPSTREAM_HOST,
  deriveSession,
  folderSessionId,
  sanitizeId,
  buildRequestBlob,
  turnStem,
} from './capture.js';

/**
 * @typedef {object} ProxyOptions
 * @property {string} [sessionsDir]   Capture-dir root (default: ./sessions).
 * @property {string} [upstreamHost]  Upstream host (default: api.anthropic.com).
 * @property {number} [upstreamPort]  Upstream port (default: 443).
 * @property {typeof https.request} [requestFn]  Upstream request fn — injectable
 *   for tests (default: https.request; use http.request against a fake upstream).
 * @property {string} [lifecycleId]   Fallback single-session id (default: derived
 *   at server creation).
 */

/**
 * Create the capture-proxy HTTP server. Not yet listening — call `.listen()`.
 *
 * @param {ProxyOptions} [options]
 * @returns {import('node:http').Server}
 */
export function createProxyServer(options = {}) {
  const sessionsDir = options.sessionsDir ?? path.resolve(process.cwd(), 'sessions');
  const upstreamHost = options.upstreamHost ?? UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? 443;
  const requestFn = options.requestFn ?? https.request;
  const lifecycleId = options.lifecycleId ?? `proxy-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  /** Per-directory turn counter (capture order). @type {Map<string, number>} */
  const turns = new Map();

  const server = http.createServer((creq, cres) => {
    const requestReceivedAt = new Date().toISOString();

    // Buffer the request body: we need it whole to derive the session boundary
    // and to write the request blob. Only the RESPONSE must stream (spec §1.4).
    /** @type {Buffer[]} */
    const bodyChunks = [];
    creq.on('data', (chunk) => bodyChunks.push(chunk));
    creq.on('error', () => endWithError(cres, 502));
    creq.on('end', () => {
      const body = Buffer.concat(bodyChunks);

      // Session boundary (spec §1.5) with proxy-lifecycle fallback.
      const session = deriveSession(body) ?? { sessionId: lifecycleId, parentSessionId: null };
      const dirId = sanitizeId(folderSessionId(session));
      const dir = path.join(sessionsDir, dirId);
      const turn = (turns.get(dirId) ?? 0) + 1;
      turns.set(dirId, turn);
      const stem = turnStem(turn);
      const requestBlob = `${stem}.request.http`;
      const responseBlob = `${stem}.response.sse`;

      // Redact + persist the request BEFORE forwarding (spec §1.3): nothing
      // unredacted ever touches disk.
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, requestBlob),
          buildRequestBlob({ method: creq.method ?? 'GET', url: creq.url ?? '/', rawHeaders: creq.rawHeaders, body })
        );
      } catch {
        endWithError(cres, 500);
        return;
      }

      // Forward: restore first-party Host (spec §1.5), pass everything else
      // (including auth) through untouched on the wire.
      const headers = { ...creq.headers, host: UPSTREAM_HOST };
      const ureq = requestFn(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: creq.url,
          method: creq.method,
          headers,
        },
        (ures) => {
          cres.writeHead(ures.statusCode ?? 502, ures.headers);

          // Tee: one readable, two writables. Neither buffers the full body —
          // SSE bytes flow to the client and to disk as they arrive (spec §1.4).
          const fileStream = fs.createWriteStream(path.join(dir, responseBlob));
          ures.pipe(cres);
          ures.pipe(fileStream);

          fileStream.on('finish', () => {
            appendManifest(dir, {
              turn,
              request_received_at: requestReceivedAt,
              response_completed_at: new Date().toISOString(),
              parent_session_id: session.parentSessionId,
              thread_id: session.sessionId,
              request_blob: requestBlob,
              response_blob: responseBlob,
            });
          });
          fileStream.on('error', () => {});
        }
      );
      ureq.on('error', () => endWithError(cres, 502));
      ureq.end(body);
    });
  });

  return server;
}

/**
 * Append one manifest line (spec §1.6). Only capture-time facts that can't be
 * recovered from the raw bytes.
 *
 * @param {string} dir
 * @param {Record<string, unknown>} line
 */
function appendManifest(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), JSON.stringify(line) + '\n');
  } catch {
    // Best-effort: a manifest write failure must not crash the proxy.
  }
}

/**
 * @param {import('node:http').ServerResponse} cres
 * @param {number} status
 */
function endWithError(cres, status) {
  if (!cres.headersSent) cres.writeHead(status, { 'content-type': 'application/json' });
  if (!cres.writableEnded) cres.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error' } }));
}

/**
 * Start the proxy listening (used by `ccsnoop start`). Foreground; resolves
 * once bound.
 *
 * @param {ProxyOptions & { port?: number, host?: string }} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function start(options = {}) {
  const port = options.port ?? 8118;
  const host = options.host ?? '127.0.0.1';
  const server = createProxyServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
