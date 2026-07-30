// Cache diagnostic — the REAL-session integration proof (cache spec §3 / issue #84, AC #7).
//
// A committed real captured Claude Code session under `test/fixtures/cache/session-<id>/`
// is run end-to-end through the pure `diagnoseCache` seam — mirroring the fine-tune
// fixture gate (`test/finetune-fixture.test.js`) but asserting at the cache seam only:
// the verdicts and the frontier model the diagnostic emits on real traffic. The cold/edge
// verdicts are covered by the synthetic cases in `test/cache.test.js`; this proves the
// seam holds on a real capture (real gzipped SSE `usage`, the real CC breakpoint layout).
//
// RGR posture: the gate SELF-SKIPS if no fixture is committed, so `npm test` stays green
// in a sandbox without one. The fixture IS committed today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExchange } from '../src/report.js';
import { diagnoseCache } from '../src/cache.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/cache', import.meta.url));

/** Session fixture dirs under FIXTURES_DIR (`session-*`), sorted. Missing root → []. */
function sessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => path.join(FIXTURES_DIR, e.name))
    .sort();
}

/** Load a fixture dir into the exchange shape `diagnoseCache` consumes (keeping requestJson). */
function loadSession(dir) {
  const lines = fs
    .readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const exchanges = lines.map((line) => {
    const requestBuf = fs.readFileSync(path.join(dir, line.request_blob));
    let responseBuf = Buffer.alloc(0);
    try {
      responseBuf = fs.readFileSync(path.join(dir, line.response_blob));
    } catch {
      // an aborted exchange reads null usage
    }
    return buildExchange(line, requestBuf, responseBuf);
  });
  return exchanges.map((e) => ({
    turn: e.turn,
    threadId: e.threadId,
    requestBody: e.requestJson,
    usage: e.usage,
    requestReceivedAt: e.requestReceivedAt,
    responseCompletedAt: e.responseCompletedAt,
    maxTokens: e.requestJson?.max_tokens,
  }));
}

const dirs = sessionDirs();
const testOpts = dirs.length === 0
  ? { skip: 'no fixture committed under test/fixtures/cache/ — issue #84 real-session proof pending a real capture' }
  : {};

test('cache fixture: diagnoseCache runs on a real captured session (issue #84, AC #7)', testOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const session = loadSession(dir);

    // Integrity (mirrors the fine-tune gate): every manifest line names present blobs.
    const manifest = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8');
    for (const line of manifest.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))) {
      assert.ok(line.request_blob && line.response_blob, `${id}: manifest line missing a blob name`);
      assert.ok(fs.existsSync(path.join(dir, line.request_blob)), `${id}: ${line.request_blob} missing`);
      assert.ok(fs.existsSync(path.join(dir, line.response_blob)), `${id}: ${line.response_blob} missing`);
    }

    // The diagnostic is pure and deterministic over the real capture.
    const d = diagnoseCache(session);

    // Claude Code places cache_control breakpoints (two system + one message, all 1h) on
    // every request here ⇒ the 3-frontier model applies (capability frontier available).
    assert.equal(d.frontierModel, '3-frontier', `${id}: real CC breakpoints ⇒ 3-frontier`);

    // One card per diagnosable turn. The first captured turn has no baseline yet still
    // read from cache (content-keyed cache / partial capture) ⇒ UNEXPLAINED. Every
    // continuation is fully served from cache ⇒ HIT (huge cache_read, tiny cache_write).
    const turns = new Map(d.transitions.map((c) => [c.turn, c]));
    assert.ok(d.transitions.length > 0, `${id}: the diagnostic emits transitions`);
    const firstCard = turns.get(1);
    if (firstCard) assert.equal(firstCard.headline.verdict, 'UNEXPLAINED', `${id}: turn 1 reads cache with no antecedent`);

    // The warm continuations: real usage confirms a served prefix (cache_read > 0).
    const warmTurns = [...turns.values()].filter((c) => c.turn !== 1);
    for (const c of warmTurns) {
      assert.equal(c.headline.verdict, 'HIT', `${id}: turn ${c.turn} is warm (append-only, cache held)`);
    }
    assert.ok(warmTurns.length > 0, `${id}: at least one warm continuation`);

    // Never re-tokenizes: every cost proxy is a byte extent (a non-negative number); token
    // figures come only from the captured `usage`, never estimated here.
    for (const c of d.transitions) {
      for (const r of c.regions) {
        assert.equal(typeof r.bytes, 'number', `${id}: turn ${c.turn} region bytes is a number`);
        assert.ok(r.bytes >= 0, `${id}: turn ${c.turn} region bytes is non-negative`);
      }
    }
  }
});
