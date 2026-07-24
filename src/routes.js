// Path-token routing (spec §3.3) — one daemon serves many repos.
//
// The daemon cannot read CC's `env`, so the target capture dir is carried in the
// URL: `init` bakes `/<token>` into `ANTHROPIC_BASE_URL`, so requests arrive as
// `/<token>/v1/messages…`. The daemon strips `/<token>`, resolves it against
// `~/.ccsnoop/routes.json` (`token → dir`), and proxies the rest upstream.
//
// Pure helpers only — no network, filesystem reads confined to `readRoutes`.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * The routing token for a capture dir: `sha256(abs dir)[:8]` (spec §3.3).
 * Idempotent for a given directory — `init` and the daemon derive the same
 * token from the same absolute path.
 *
 * @param {string} dir  Capture dir (resolved to absolute before hashing).
 * @returns {string}    8 lowercase hex chars.
 */
export function deriveToken(dir) {
  const abs = path.resolve(dir);
  return crypto.createHash('sha256').update(abs).digest('hex').slice(0, 8);
}

/**
 * Split a request URL into its leading path token and the stripped remainder.
 * `/<token>/v1/messages?beta=true` → `{ token: '<token>', rest: '/v1/messages?beta=true' }`.
 * A tokenless or root URL yields an empty token and the path unchanged.
 *
 * @param {string} url  Always begins with `/` (Node request URL).
 * @returns {{ token: string, rest: string, restPath: string }}
 *   `restPath` is `rest` without its query string (for exact-path matching).
 */
export function splitToken(url) {
  const q = url.indexOf('?');
  const pathOnly = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : '';
  const segs = pathOnly.split('/'); // ['', '<token>', ...rest]
  const token = segs[1] ?? '';
  const restPath = '/' + segs.slice(2).join('/');
  return { token, rest: restPath + query, restPath };
}

/**
 * Read `routes.json` (`token → dir`). Missing or malformed → empty map. Values
 * may be a plain dir string or an object with a `.dir` field (forward-compat
 * with `init`'s per-token manifest, spec §3.2).
 *
 * @param {string} file  Path to routes.json.
 * @returns {Record<string, unknown>}
 */
export function readRoutes(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve a token to its capture dir, or `null` if the token is not registered.
 * Handles both the string and `{ dir }` value shapes.
 *
 * @param {Record<string, unknown>} routes
 * @param {string} token
 * @returns {string | null}
 */
export function routeDir(routes, token) {
  const v = routes[token];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (/** @type {any} */ (v).dir) === 'string') {
    return /** @type {any} */ (v).dir;
  }
  return null;
}

/**
 * The Anthropic-shaped error body for an unknown route token (spec §3.3). CC
 * renders `error.message` verbatim; the same JSON is logged to `daemon.log`.
 *
 * @param {string} token
 * @returns {string}  JSON string (no trailing newline).
 */
export function unknownTokenError(token) {
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: `ccsnoop: unknown route token ${token} — run \`ccsnoop init\` in this repo, then restart Claude Code`,
    },
  });
}
