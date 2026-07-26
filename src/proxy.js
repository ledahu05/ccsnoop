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
import { splitToken, readRoutes, routeDir, unknownTokenError } from './routes.js';

/**
 * @typedef {object} ProxyOptions
 * @property {string} [sessionsDir]   Capture-dir root (default: ./sessions). Used
 *   only in single-repo mode (no `routesFile`).
 * @property {string} [routesFile]    Path to `routes.json`. When set, the proxy
 *   runs in path-token routing mode (spec §3.3): each request's leading URL
 *   segment is a token resolved to a per-repo capture dir, and `/<dir>/sessions`
 *   is the tee target.
 * @property {string} [upstreamHost]  Upstream host (default: api.anthropic.com).
 * @property {number} [upstreamPort]  Upstream port (default: 443).
 * @property {typeof https.request} [requestFn]  Upstream request fn — injectable
 *   for tests (default: https.request; use http.request against a fake upstream).
 * @property {string} [lifecycleId]   Fallback single-session id (default: derived
 *   at server creation).
 * @property {(line: string) => void} [log]  Structured-line sink → `daemon.log`
 *   (default: console.log). Used for the unknown-token error entry (spec §3.3).
 */

/**
 * Create the capture-proxy HTTP server. Not yet listening — call `.listen()`.
 *
 * @param {ProxyOptions} [options]
 * @returns {import('node:http').Server}
 */
export function createProxyServer(options = {}) {
  const sessionsDir = options.sessionsDir ?? path.resolve(process.cwd(), 'sessions');
  const routesFile = options.routesFile;
  const upstreamHost = options.upstreamHost ?? UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? 443;
  const requestFn = options.requestFn ?? https.request;
  const lifecycleId = options.lifecycleId ?? `proxy-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const log = options.log ?? ((line) => console.log(line));

  /** Per-directory turn counter (capture order). @type {Map<string, number>} */
  const turns = new Map();

  const server = http.createServer((creq, cres) => {
    const requestReceivedAt = new Date().toISOString();
    const rawUrl = creq.url ?? '/';

    // Path-token routing (spec §3.3): strip `/<token>`, resolve the per-repo
    // capture dir, forward the stripped path upstream. Single-repo mode
    // (no routesFile) forwards the URL untouched to the fixed `sessionsDir`.
    let targetSessionsDir = sessionsDir;
    let upstreamPath = rawUrl;
    if (routesFile) {
      const { token, rest, restPath } = splitToken(rawUrl);

      // Pre-flight `HEAD /<token>/api/hello` (prefix-preserving) must answer 200
      // for ANY token — a 4xx makes CC never send the real request (spec §3.3).
      // HEAD is never failed, even on an unknown token.
      if (creq.method === 'HEAD' && restPath === '/api/hello') {
        creq.resume();
        cres.writeHead(200);
        cres.end();
        return;
      }

      const dir = routeDir(readRoutes(routesFile), token);
      if (dir == null) {
        // HEAD is never failed (spec §3.3); only POST breaks loud.
        if (creq.method === 'HEAD') {
          creq.resume();
          cres.writeHead(200);
          cres.end();
          return;
        }
        // Unknown token — fail LOUD with an Anthropic-shaped body CC renders
        // verbatim, and one matching `daemon.log` entry (spec §3.3).
        const errBody = unknownTokenError(token);
        log(errBody);
        creq.resume();
        cres.writeHead(502, { 'content-type': 'application/json' });
        cres.end(errBody);
        return;
      }

      // Known token — a deleted-but-registered dir is a live route: `sessions`
      // is (re)created below via mkdirSync per turn, so capture just continues.
      targetSessionsDir = path.join(dir, 'sessions');
      upstreamPath = rest;
    }

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
      const dir = path.join(targetSessionsDir, dirId);
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
          buildRequestBlob({ method: creq.method ?? 'GET', url: upstreamPath, rawHeaders: creq.rawHeaders, body })
        );
      } catch {
        endWithError(cres, 500);
        return;
      }

      // Forward: restore first-party Host (spec §1.5), pass everything else
      // (including auth) through untouched on the wire.
      // Pin accept-encoding to gzip: Claude Code advertises `gzip, deflate, br,
      // zstd`, and br/zstd have no reliable magic bytes, so `decodeBlob` (report)
      // could not inflate a captured body served in them — usage would read null
      // and waste would flip to a false `cold` (issue #45). Forcing gzip leaves
      // upstream only gzip or plain, the two cases decodeBlob already handles.
      const headers = { ...creq.headers, host: UPSTREAM_HOST, 'accept-encoding': 'gzip' };
      const ureq = requestFn(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          path: upstreamPath,
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

          // Upstream drops the socket mid-response (flaky connection after
          // headers, e.g. mid-SSE-stream). Without this listener the 'error'
          // is unhandled — on some runtimes it crashes the whole proxy, and
          // otherwise the tee pipe never closes `cres`, leaving the client
          // hung (spec §1.4, issue #25). Headers are already flushed here, so
          // reset the connection rather than trying to write a 502 body, and
          // tear down the capture file (no `finish` → no bogus manifest line).
          ures.on('error', () => {
            fileStream.destroy();
            cres.destroy();
          });

          // Client hangs up mid-stream (EPIPE on our pipes): stop pulling from
          // upstream and close the capture file.
          cres.on('error', () => {
            ures.destroy();
            fileStream.destroy();
          });
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
