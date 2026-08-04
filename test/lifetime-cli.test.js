// Lifetime metric (issue #101) — the surface: the `lifetime` subcommand CLI wiring.
// Mirrors test/cache-cli.test.js's posture: this pins SHAPE (exits 0, produces output,
// the right fields appear), discovered + loaded via the shared report resolver, rendered
// text-by-default / `--html`. The verdict logic is `lifetime.test.js`'s job at the
// `diagnoseLifetime` seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lifetime } from '../src/lifetime.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-lifetime-'));
}

/**
 * A captured-session dir writer (mirrors cache-cli.test.js). `turns` is an array of
 * { body, recv, done, threadId }. Responses are empty — usage is irrelevant to the
 * lifetime metric (compaction is structural), and `buildExchange` reads null usage
 * from an empty blob without throwing.
 * @param {string} dir
 * @param {Array<{ body: any, recv?: string, done?: string, threadId?: string }>} turns
 */
function writeSession(dir, turns) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  turns.forEach((t, i) => {
    const n = String(i + 1).padStart(4, '0');
    const req = buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 1024, ...t.body })),
    });
    fs.writeFileSync(path.join(dir, `${n}.request.http`), req);
    fs.writeFileSync(path.join(dir, `${n}.response.sse`), '');
    manifest.push({
      turn: i + 1,
      thread_id: t.threadId ?? 'A',
      request_blob: `${n}.request.http`,
      response_blob: `${n}.response.sse`,
      request_received_at: t.recv ?? null,
      response_completed_at: t.done ?? null,
    });
  });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), manifest.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return dir;
}

// A 3-message turn that a later turn shrinks against (the compaction baseline).
const GROW3 = { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }] };
const SHRINK = { system: 'sys', messages: [{ role: 'user', content: 'COMPACTED-SUMMARY' }] };

// ── lifetime() entry point: discovery + load + diagnose + render ───────────────

test('lifetime(): --sessions-dir resolves the session and reports a compaction', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-life'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: SHRINK, recv: '2026-07-28T07:53:00Z', done: '2026-07-28T07:53:01Z' },
  ]);
  const res = lifetime({ cwd: '/nonexistent', sessionsDir: root, session: 'cli-life' });
  assert.equal(res.sessionId, 'cli-life');
  assert.equal(res.diagnostic.compactionCount, 1);
  assert.equal(res.diagnostic.firstCompaction.turn, 2);
  assert.ok(res.lines.length > 0);
  assert.ok(res.html.includes('cli-life'));
  const out = res.lines.join('\n');
  assert.match(out, /effective lifetime/);
  assert.match(out, /2 turns/);
  assert.match(out, /3 min/);
});

test('lifetime(): a session with no compaction reports honestly', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'clean'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, recv: '2026-07-28T07:51:00Z', done: '2026-07-28T07:51:01Z' },
  ]);
  const res = lifetime({ cwd: '/nonexistent', sessionsDir: root, session: 'clean' });
  assert.equal(res.diagnostic.compactionCount, 0);
  assert.equal(res.diagnostic.firstCompaction, null);
  assert.match(res.lines.join('\n'), /no compaction/i);
});

test('lifetime(): --root default discovery finds the latest session', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 's1'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
  ]);
  // Age s1 into the past so the later-written s2 is unambiguously newest by mtime.
  const past = new Date('2020-01-01T00:00:00Z').getTime() / 1000;
  fs.utimesSync(path.join(root, 'sessions', 's1', 'manifest.jsonl'), past, past);
  writeSession(path.join(root, 'sessions', 's2'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: SHRINK, recv: '2026-07-28T07:53:00Z', done: '2026-07-28T07:53:01Z' },
  ]);
  // No --session ⇒ latest (by manifest mtime), mirroring report/cache.
  const res = lifetime({ cwd: '/nonexistent', root });
  assert.equal(res.sessionId, 's2');
  assert.equal(res.diagnostic.compactionCount, 1);
});

test('ccsnoop lifetime --latest is accepted and reports the same session as the default', () => {
  // `--latest` carries no plumbing (with no corpus mode the newest session IS the
  // default), so what matters is that passing it is not rejected and does not change
  // the answer — assert against the flagless run rather than restating the output.
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'lat'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: SHRINK, recv: '2026-07-28T07:53:00Z', done: '2026-07-28T07:53:01Z' },
  ]);
  const run = (args) => spawnSync(process.execPath, [BIN, 'lifetime', '--sessions-dir', root, ...args], { encoding: 'utf8' });
  const withFlag = run(['--latest']);
  assert.equal(withFlag.status, 0, `stderr: ${withFlag.stderr}`);
  assert.equal(withFlag.stdout, run([]).stdout);
});

test('lifetime(): an unknown --session names the sessions that do exist', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'real'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
  ]);
  assert.throws(() => lifetime({ cwd: '/nonexistent', sessionsDir: root, session: 'ghost' }), /ghost.*not found.*real/s);
});

// ── CLI dispatch smoke (AC: exits 0, produces output; mirrors cache) ───────────

test('ccsnoop lifetime --sessions-dir renders text and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-smoke'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: SHRINK, recv: '2026-07-28T07:53:00Z', done: '2026-07-28T07:53:01Z' },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'lifetime', '--sessions-dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /cli-smoke/);
  assert.match(r.stdout, /lifetime/);
  assert.match(r.stdout, /effective lifetime/);
});

test('ccsnoop lifetime --html renders an HTML document and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'cli-html'), [
    { body: GROW3, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: SHRINK, recv: '2026-07-28T07:53:00Z', done: '2026-07-28T07:53:01Z' },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'lifetime', '--sessions-dir', root, '--html'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /<!doctype html>/i);
  assert.match(r.stdout, /cli-html/);
});

test('ccsnoop lifetime on a no-compaction session says so honestly and exits 0', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'none'), [
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }] }, recv: '2026-07-28T07:50:00Z', done: '2026-07-28T07:50:01Z' },
    { body: { system: 'sys', messages: [{ role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }] }, recv: '2026-07-28T07:51:00Z', done: '2026-07-28T07:51:01Z' },
  ]);
  const r = spawnSync(process.execPath, [BIN, 'lifetime', '--sessions-dir', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no compaction/i);
  assert.doesNotMatch(r.stdout, /effective lifetime = \d+ turns/);
});

test('lifetime is a registered subcommand (no "unknown subcommand")', () => {
  // A bare `lifetime` against an empty root errors on the missing session, NOT on an
  // unknown subcommand — proving `lifetime` is in the dispatch table.
  const root = mkTmpDir();
  const r = spawnSync(process.execPath, [BIN, 'lifetime', '--root', root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no captured sessions/);
  assert.doesNotMatch(r.stderr, /unknown subcommand/);
});

test('ccsnoop --help lists the lifetime command', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\blifetime\b/);
});
