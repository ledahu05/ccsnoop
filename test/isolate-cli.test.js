// Subagent isolation — the surface: the `isolate` subcommand CLI wiring + renderer
// (issue #102). Smoke-only (mirrors `test/cache-cli.test.js`): pins SHAPE — exits 0,
// produces output, the headline figures and the reco appear, and the no-subagent case
// prints the honest "none". The exact logic is `test/isolate.test.js`'s job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isolate, isolateAnalyze, renderIsolate } from '../src/isolate.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-isolate-'));
}

/** A captured-session dir writer. `turns` = [{ threadId, parentSessionId, usage, recv, done }]. */
function writeSession(dir, turns) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  turns.forEach((t, i) => {
    const n = String(i + 1).padStart(4, '0');
    const req = buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 1024, messages: [{ role: 'user', content: 'q' }] })),
    });
    fs.writeFileSync(path.join(dir, `${n}.request.http`), req);
    fs.writeFileSync(path.join(dir, `${n}.response.sse`), t.usageSse ?? '');
    manifest.push({
      turn: i + 1,
      thread_id: t.threadId,
      parent_session_id: t.parentSessionId ?? null,
      request_blob: `${n}.request.http`,
      response_blob: `${n}.response.sse`,
      request_received_at: t.recv ?? null,
      response_completed_at: t.done ?? null,
    });
  });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), manifest.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return dir;
}

function sse(u) {
  return (
    'data: {"type":"message_start","message":{"usage":' +
    JSON.stringify({ input_tokens: u.input ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheCreation ?? 0 }) +
    '}}\n\n'
  );
}

const WITH_SUB = [
  { threadId: 'main', parentSessionId: null, usageSse: sse({ input: 1000 }) },
  { threadId: 'sub-a', parentSessionId: 'main', usageSse: sse({ input: 2000 }) },
];

// ── programmatic entry (isolate()) ────────────────────────────────────────────

test('isolate(): --sessions-dir resolves the session and renders text by default', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 's1'), WITH_SUB);
  const res = isolate({ cwd: '/nonexistent', sessionsDir: root, session: 's1' });
  assert.equal(res.sessionId, 's1');
  const out = res.lines.join('\n');
  assert.match(out, /ccsnoop isolate/);
  assert.match(out, /sub-a/);
  assert.match(out, /3,000/); // subagent isolated total
  assert.match(out, /reco/i);
});

test('isolate(): no --session ⇒ the latest session (default-latest)', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 's1'), [
    { threadId: 'main', parentSessionId: null, usageSse: sse({ input: 10 }) },
  ]);
  // Age s1 into the past so s2 is unambiguously newest by mtime.
  const past = new Date('2020-01-01T00:00:00Z').getTime() / 1000;
  fs.utimesSync(path.join(root, 'sessions', 's1', 'manifest.jsonl'), past, past);
  writeSession(path.join(root, 'sessions', 's2'), WITH_SUB);
  const res = isolate({ cwd: '/nonexistent', root });
  assert.equal(res.sessionId, 's2');
});

// ── CLI dispatch smoke ────────────────────────────────────────────────────────

test('ccsnoop isolate --sessions-dir renders text and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-smoke'), WITH_SUB);
  const r = spawnSync(process.execPath, [BIN, 'isolate', '--sessions-dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /cli-smoke/);
  assert.match(r.stdout, /if-inlined counterfactual/i);
  assert.match(r.stdout, /reco/i);
});

test('ccsnoop isolate --html renders an HTML document and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-html'), WITH_SUB);
  const r = spawnSync(process.execPath, [BIN, 'isolate', '--sessions-dir', root, '--html'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /<!doctype html>/i);
  assert.match(r.stdout, /cli-html/);
});

test('ccsnoop isolate on a no-subagent session prints the honest "none" line', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'solo'), [
    { threadId: 'solo', parentSessionId: null, usageSse: sse({ input: 500 }) },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'isolate', '--sessions-dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no subagent threads/i);
  assert.doesNotMatch(r.stdout, /reco/i);
});

test('isolate is a registered subcommand (no "unknown subcommand")', () => {
  const root = mkTmpDir();
  const r = spawnSync(process.execPath, [BIN, 'isolate', '--root', root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no captured sessions/);
  assert.doesNotMatch(r.stderr, /unknown subcommand/);
});

test('ccsnoop isolate --help lists the isolate command', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bisolate\b/);
});

test('ccsnoop isolate --threshold rejects an out-of-range fraction loudly', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 't'), WITH_SUB);
  const r = spawnSync(process.execPath, [BIN, 'isolate', '--sessions-dir', root, '--threshold', '2'], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--threshold/);
});

// ── pure renderer shape (parity with the entry function) ─────────────────────

test('renderIsolate: text + html agree on the headline figures', () => {
  const usage = (input) => ({
    inputTokens: input, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 0, stopReason: null, streaming: true,
  });
  const d = isolateAnalyze([
    { threadId: 'main', parentSessionId: null, usage: usage(1000), requestBytes: 1 },
    { threadId: 'sub-a', parentSessionId: 'main', usage: usage(2000), requestBytes: 1 },
  ]);
  const { lines, html } = renderIsolate(d, { sessionId: 'sess-x' });
  const out = lines.join('\n');
  assert.match(out, /3,000/); // isolated
  assert.match(out, /reco/i);
  assert.match(html, /<!doctype html>/i);
});
