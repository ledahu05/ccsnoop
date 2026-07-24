// Pure capture helpers — no I/O, no network. Unit-testable in isolation.
//
// These implement the load-bearing contracts from docs/spec.md §1.3, §1.5, §1.6:
//   - secret-header redaction (before anything is written)
//   - session-boundary derivation from the request body
//   - raw redacted request-blob serialization

/** Fixed case-insensitive secret-header denylist (spec §1.3). Always ships. */
export const DENY = /^(authorization|x-api-key|proxy-authorization|cookie)$/i;

/** Redaction token — plain, no length or fingerprint hint (spec §1.3). */
export const REDACTED = '‹REDACTED›';

/** Upstream Anthropic host restored on forward (spec §1.5). */
export const UPSTREAM_HOST = 'api.anthropic.com';

/**
 * Redact the secret-header denylist in a Node-style headers object.
 * Case-insensitive on the key; the whole value is replaced. Bodies untouched.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {Record<string, string | string[] | undefined>}
 */
export function redactHeaders(headers) {
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {};
  for (const key of Object.keys(headers)) {
    out[key] = DENY.test(key) ? REDACTED : headers[key];
  }
  return out;
}

/**
 * Derive the CC session identity from a Messages API request body.
 *
 * CC packs a stringified JSON object into `metadata.user_id`; we read
 * `session_id` (the thread's own id) and the optional `parent_session_id`
 * (present on sub-agent runs). Parsed defensively — the shape is undocumented
 * CC product behaviour, not an API contract (spec §1.5).
 *
 * @param {Buffer | string} body
 * @returns {{ sessionId: string, parentSessionId: string | null } | null}
 *   null when metadata is absent or unparseable — caller falls back to the
 *   single proxy-lifecycle session.
 */
export function deriveSession(body) {
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
    const raw = parsed?.metadata?.user_id;
    if (typeof raw !== 'string') return null;
    const meta = JSON.parse(raw);
    const sessionId = meta?.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const parentSessionId =
      typeof meta?.parent_session_id === 'string' && meta.parent_session_id.length > 0
        ? meta.parent_session_id
        : null;
    return { sessionId, parentSessionId };
  } catch {
    return null;
  }
}

/**
 * The on-disk directory name that groups an exchange. Sub-agent runs fold into
 * their root via `parent_session_id` (spec §1.5); the thread's own id is kept
 * separately as `thread_id` in the manifest (spec §1.6 amendment).
 *
 * @param {{ sessionId: string, parentSessionId: string | null }} session
 * @returns {string}
 */
export function folderSessionId(session) {
  return session.parentSessionId ?? session.sessionId;
}

/**
 * Make a session id safe as a single filesystem path segment — defends against
 * path traversal from an unexpected body shape. UUID session ids pass through
 * unchanged.
 *
 * @param {string} id
 * @returns {string}
 */
export function sanitizeId(id) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Serialize a raw redacted HTTP/1.1 request blob (spec §1.6): request line +
 * headers + body. `Host` is restored to the upstream and denylist headers are
 * redacted; the body is passed through byte-for-byte. `rawHeaders` preserves
 * CC's original header casing and order.
 *
 * @param {{ method: string, url: string, rawHeaders: string[], body: Buffer }} req
 * @returns {Buffer}
 */
export function buildRequestBlob({ method, url, rawHeaders, body }) {
  const lines = [`${method} ${url} HTTP/1.1`];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    let value = rawHeaders[i + 1];
    if (/^host$/i.test(key)) value = UPSTREAM_HOST;
    else if (DENY.test(key)) value = REDACTED;
    lines.push(`${key}: ${value}`);
  }
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8');
  return Buffer.concat([head, body]);
}

/**
 * Zero-padded 4-digit turn index → blob filename stem (spec §1.6).
 * @param {number} turn
 * @returns {string}
 */
export function turnStem(turn) {
  return String(turn).padStart(4, '0');
}
