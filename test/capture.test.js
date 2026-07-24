import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DENY,
  REDACTED,
  UPSTREAM_HOST,
  redactHeaders,
  deriveSession,
  folderSessionId,
  sanitizeId,
  buildRequestBlob,
  turnStem,
} from '../src/capture.js';

test('redactHeaders replaces the fixed denylist case-insensitively, leaves others', () => {
  const out = redactHeaders({
    Authorization: 'Bearer sk-secret',
    'X-Api-Key': 'sk-ant-123',
    'Proxy-Authorization': 'creds',
    Cookie: 'session=abc',
    'content-type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
  });
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out['X-Api-Key'], REDACTED);
  assert.equal(out['Proxy-Authorization'], REDACTED);
  assert.equal(out.Cookie, REDACTED);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['anthropic-beta'], 'oauth-2025-04-20');
});

test('DENY matches only the four secret headers, case-insensitively', () => {
  for (const h of ['authorization', 'X-API-KEY', 'Proxy-Authorization', 'COOKIE']) {
    assert.ok(DENY.test(h), `${h} should be denied`);
  }
  for (const h of ['anthropic-beta', 'x-api-keyish', 'set-cookie', 'content-type']) {
    assert.ok(!DENY.test(h), `${h} should not be denied`);
  }
});

test('deriveSession reads session_id from the stringified metadata.user_id', () => {
  const body = JSON.stringify({
    model: 'claude-x',
    metadata: { user_id: JSON.stringify({ session_id: 'sess-1' }) },
  });
  assert.deepEqual(deriveSession(body), { sessionId: 'sess-1', parentSessionId: null });
});

test('deriveSession picks up parent_session_id for sub-agent runs', () => {
  const body = JSON.stringify({
    metadata: { user_id: JSON.stringify({ session_id: 'child', parent_session_id: 'root' }) },
  });
  assert.deepEqual(deriveSession(body), { sessionId: 'child', parentSessionId: 'root' });
});

test('deriveSession returns null when metadata is absent (proxy-lifecycle fallback)', () => {
  assert.equal(deriveSession(JSON.stringify({ model: 'x' })), null);
});

test('deriveSession parses defensively — garbage body never throws', () => {
  assert.equal(deriveSession('not json at all'), null);
  assert.equal(deriveSession(JSON.stringify({ metadata: { user_id: 'not-json' } })), null);
  assert.equal(deriveSession(JSON.stringify({ metadata: { user_id: 42 } })), null);
  assert.equal(deriveSession(Buffer.from('')), null);
});

test('folderSessionId folds sub-agents into their parent, else uses own id', () => {
  assert.equal(folderSessionId({ sessionId: 'child', parentSessionId: 'root' }), 'root');
  assert.equal(folderSessionId({ sessionId: 'solo', parentSessionId: null }), 'solo');
});

test('sanitizeId strips path-traversal characters', () => {
  assert.equal(sanitizeId('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeId('a1b2-c3d4'), 'a1b2-c3d4');
  assert.equal(sanitizeId(''), 'unknown');
});

test('turnStem zero-pads to four digits', () => {
  assert.equal(turnStem(1), '0001');
  assert.equal(turnStem(42), '0042');
});

test('buildRequestBlob restores Host, redacts secrets, keeps body byte-identical', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world', n: 1 }));
  const blob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages?beta=true',
    rawHeaders: [
      'Host', 'localhost:8118',
      'Authorization', 'Bearer sk-secret',
      'X-Api-Key', 'sk-ant-abc',
      'Content-Type', 'application/json',
    ],
    body,
  });
  const text = blob.toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const persistedBody = rest.join('\r\n\r\n');

  assert.ok(head.startsWith('POST /v1/messages?beta=true HTTP/1.1\r\n'));
  assert.ok(head.includes(`Host: ${UPSTREAM_HOST}`), 'Host restored to upstream');
  assert.ok(head.includes(`Authorization: ${REDACTED}`));
  assert.ok(head.includes(`X-Api-Key: ${REDACTED}`));
  assert.ok(head.includes('Content-Type: application/json'), 'non-secret header preserved with casing');
  assert.ok(!text.includes('sk-secret') && !text.includes('sk-ant-abc'), 'no secret leaks anywhere in the blob');
  assert.equal(persistedBody, body.toString('utf8'), 'body byte-identical');
});
