// FT4 (issue #74) — MCP lever: parse the deferred listing, aggregate the corpus,
// apply the T4 guard.
//
// The MCP server is the only lever that still consumes the sent-vs-used signal
// (fine-tune-spec §3.2): a server is shipped as **name only** inside a
// `<system-reminder>` ("MCP servers are still connecting"), and it is "used" iff
// one of its tools is called — on the wire an MCP call is `mcp__<server>__<tool>`
// (confirmed by the FT0 fixture). `ccsnoop fine-tune` aggregates shipped/called
// across the WHOLE corpus and may emit `disabledMcpjsonServers` ONLY when
// `sessionCount >= 3 AND calledCount == 0`; otherwise it is flag-only (counts
// shown), and in single-session mode it NEVER denies. Binary on absence — called
// once → used. No percentages, no recency window.
//
// RGR posture. The guard logic is exercised with SYNTHETIC multi-session inputs
// (the AC: uncalled→deny across ≥3; called once→flag; <3 sessions→flag), and a
// self-activating gate pins the parser against the committed FT0 fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseDeferredMcpServers, mcpServerOf, sessionMcpProfile, aggregateMcpCorpus } from '../src/finetune-mcp.js';
import { buildRequestBlob } from '../src/capture.js';
import { fineTune } from '../src/finetune.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ft4-'));
}

// ── parseDeferredMcpServers: name-only listing inside a <system-reminder> ──────

/** The real CC deferred-listing shape, lifted from the FT0 fixture (only the MCP
 *  server section matters; the deferred-TOOLS list above it is a decoy that must
 *  NOT be parsed as servers). */
function deferredListing(servers, { withTools = true } = {}) {
  const tools = withTools
    ? 'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]".\nCronCreate\nCronDelete\nCronList\nWebFetch\nWebSearch\n'
    : '';
  return (
    '<system-reminder>\n' +
    tools +
    '\nThe following MCP servers are still connecting — their tools (typically named mcp__<server>__*) are not yet available but will appear shortly:\n' +
    servers.join('\n') +
    '\n\nIf the user\'s request might be served by one of these servers (even if they didn\'t name it explicitly), call ToolSearch with a relevant keyword.\n' +
    '</system-reminder>'
  );
}

test('parseDeferredMcpServers reads the MCP servers listed under the connecting header', () => {
  assert.deepEqual(parseDeferredMcpServers(deferredListing(['stub'])), ['stub']);
  assert.deepEqual(parseDeferredMcpServers(deferredListing(['github', 'linear', 'stripe'])), [
    'github',
    'linear',
    'stripe',
  ]);
});

test('parseDeferredMcpServers ignores the deferred-TOOLS list above it (built-in tools are not servers)', () => {
  // CronCreate / WebSearch are deferred built-in tools — they must NOT leak into
  // the shipped-MCP set, even though they sit one paragraph above the server list.
  const servers = parseDeferredMcpServers(deferredListing(['stub']));
  assert.ok(!servers.includes('CronCreate'));
  assert.ok(!servers.includes('WebSearch'));
  assert.deepEqual(servers, ['stub']);
});

test('parseDeferredMcpServers dedups servers repeated across blocks/listings', () => {
  // A session re-sends the listing every request; the union must still be a set.
  const text = deferredListing(['stub', 'github']) + '\n' + deferredListing(['stub', 'linear']);
  assert.deepEqual(parseDeferredMcpServers(text).sort(), ['github', 'linear', 'stub']);
});

test('parseDeferredMcpServers returns [] when there is no MCP-servers header', () => {
  assert.deepEqual(parseDeferredMcpServers('The following deferred tools are now available: CronCreate'), []);
  assert.deepEqual(parseDeferredMcpServers(''), []);
  assert.deepEqual(parseDeferredMcpServers(/** @type {any} */ (null)), []);
});

test('parseDeferredMcpServers stops the list at the first blank line / closing tag', () => {
  // The trailing prose ("If the user's request…") follows a blank line — it must
  // not be parsed as a server even though it is non-empty.
  const servers = parseDeferredMcpServers(deferredListing(['stub']));
  assert.deepEqual(servers, ['stub']);
  assert.ok(!servers.some((s) => s.includes('user')));
});

test('parseDeferredMcpServers returns [] when the header lists no servers', () => {
  // Header present, empty list — a server with nothing connecting yet.
  assert.deepEqual(parseDeferredMcpServers(deferredListing([])), []);
});

test('parseDeferredMcpServers never reads the header line tail as a server name', () => {
  // The names start on the line AFTER the header. A reworded header whose tail is
  // a single token (":" alone, "…shortly:") must not become a phantom server —
  // that name would land verbatim in a settings.json the user pastes.
  assert.deepEqual(parseDeferredMcpServers('The following MCP servers are still connecting:\nstub\n'), ['stub']);
  assert.deepEqual(parseDeferredMcpServers('MCP servers are still connecting shortly:\n\nprose\n'), []);
});

test('parseDeferredMcpServers stops at a reminder boundary tag, not just the exact closing tag', () => {
  // Two reminders back to back with no blank line between them: the second one's
  // opening tag and its prose must not read as servers.
  assert.deepEqual(parseDeferredMcpServers('MCP servers are still connecting:\nstub\n<system-reminder>\nfoo\n'), [
    'stub',
  ]);
});

// ── mcpServerOf: wire name → server ────────────────────────────────────────────

test('mcpServerOf maps an mcp__<server>__<tool> call name to its server', () => {
  assert.equal(mcpServerOf('mcp__stub__t00'), 'stub');
  assert.equal(mcpServerOf('mcp__github__create_issue'), 'github');
  // A server name with hyphens / dots is still one token between the mcp__ / __ pair.
  assert.equal(mcpServerOf('mcp__my-server__tool'), 'my-server');
});

test('mcpServerOf splits at the FIRST delimiter — a tool name may itself contain __', () => {
  // `mcp__<server>__<tool>`: the server is the first segment. Reading up to the
  // LAST `__` would strand the server (`stub__do`), so the shipped name `stub`
  // would never match a call — and a used server would be denied.
  assert.equal(mcpServerOf('mcp__stub__do__thing'), 'stub');
  assert.equal(mcpServerOf('mcp__github__list__all'), 'github');
});

test('mcpServerOf returns null for a non-MCP (built-in) tool name', () => {
  // A built-in call must never be attributed to an MCP server, else a built-in
  // tool named like a server could mark that server as used.
  assert.equal(mcpServerOf('Read'), null);
  assert.equal(mcpServerOf('Bash'), null);
  assert.equal(mcpServerOf('TodoWrite'), null);
});

// ── sessionMcpProfile: a session dir → shipped + called MCP servers ────────────

/** A streamed assistant turn calling the given tool names (gzip, as captured). */
function turnCalling(names) {
  const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  let out = sse('message_start', { message: { id: 'msg_1', role: 'assistant', content: [] } });
  names.forEach((name, i) => {
    out += sse('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name, input: {} } });
    out += sse('content_block_stop', { index: i });
  });
  out += sse('message_delta', { delta: { stop_reason: names.length ? 'tool_use' : 'end_turn' } });
  out += sse('message_stop', {});
  return out;
}

/** Write a captured session dir shipping `servers` (deferred listing) and calling
 *  `calledTools` (response tool_use names) on turn 1. */
function writeMcpSession(root, id, servers, calledTools = []) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: deferredListing(servers) }],
        tools: [],
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), zlib.gzipSync(Buffer.from(turnCalling(calledTools), 'utf8')));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

test('sessionMcpProfile ships the deferred-listing servers and records what was called', () => {
  const root = mkTmpDir();
  writeMcpSession(root, 'sess-a', ['stub', 'github'], ['mcp__stub__t05', 'Read']);
  const profile = sessionMcpProfile(path.join(root, 'sessions', 'sess-a'), 'sess-a');

  assert.equal(profile.sessionId, 'sess-a');
  assert.deepEqual([...profile.shipped].sort(), ['github', 'stub']);
  // Called: only `stub` was called (via mcp__stub__t05); `Read` is built-in, `github` untouched.
  assert.deepEqual([...profile.called].sort(), ['stub']);
});

test('sessionMcpProfile ships nothing when no deferred listing is present', () => {
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'sess-b');
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'plain prompt' }], tools: [], messages: [] })),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), zlib.gzipSync(Buffer.from(turnCalling(['Read']), 'utf8')));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 'sess-b', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );

  const profile = sessionMcpProfile(dir, 'sess-b');
  assert.equal(profile.shipped.size, 0);
  assert.equal(profile.called.size, 0);
});

test('sessionMcpProfile finds the listing where real CC injects it — a USER message content block', () => {
  // CC places the deferred MCP listing in a <system-reminder> inside the FIRST
  // user message's content (confirmed by the FT0 fixture), NOT in body.system.
  // The shipped scan must read message content, or a real capture yields [].
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'sess-msg');
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: 'system prompt — no listing here' }],
        tools: [],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do the thing' }, { type: 'text', text: deferredListing(['stub']) }] },
        ],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), zlib.gzipSync(Buffer.from(turnCalling(['mcp__stub__t01']), 'utf8')));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 'sess-msg', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );

  const profile = sessionMcpProfile(dir, 'sess-msg');
  assert.deepEqual([...profile.shipped], ['stub'], 'listing in a user message is parsed');
  assert.deepEqual([...profile.called], ['stub']);
});

test('sessionMcpProfile degrades on a corrupt capture — a broken turn costs only itself', () => {
  // A capture cut mid-write must not take the verdict down: a half-written manifest
  // line, a request blob that never landed, and a non-JSON body each contribute
  // nothing while the turns around them still report. Losing the whole session
  // instead would read as "shipped nothing" — i.e. hide a server from the lever.
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'sess-torn');
  fs.mkdirSync(dir, { recursive: true });
  const blob = (body) =>
    buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(body),
    });
  fs.writeFileSync(
    path.join(dir, '0001.request.http'),
    blob(JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: deferredListing(['stub']) }], messages: [] }))
  );
  fs.writeFileSync(path.join(dir, '0003.request.http'), blob('not json at all'));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    [
      JSON.stringify({ turn: 1, request_blob: '0001.request.http', response_blob: '0001.response.sse' }),
      '{"turn": 2, "request_blob": "000', // manifest cut mid-append
      JSON.stringify({ turn: 3, request_blob: '0003.request.http' }), // body is not JSON
      JSON.stringify({ turn: 4, request_blob: '0004.request.http' }), // blob never landed
      '',
    ].join('\n')
  );

  const profile = sessionMcpProfile(dir);
  assert.deepEqual([...profile.shipped], ['stub'], 'the readable turn still reports its server');
  assert.equal(profile.called.size, 0);
});

test('sessionMcpProfile throws on a session dir with no manifest (a caller mistake)', () => {
  const dir = path.join(mkTmpDir(), 'nothing-here');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => sessionMcpProfile(dir), /could not read manifest\.jsonl/);
});

// ── aggregateMcpCorpus + the T4 guard (the AC) ────────────────────────────────
//
// Pure synthetic inputs — each profile is { shipped: string[], called: string[] }.
// A profile's `called` is the DISTINCT servers it called that session (a Set, the
// shape sessionMcpProfile emits), so `calledCount` = the number of SESSIONS that
// called the server (the spec mockup's "appelé 0/3" form). deny = sessionCount>=3
// AND calledCount===0 AND not single-session.

test('guard: shipped-but-never-called across ≥3 sessions → deny', () => {
  const corpus = aggregateMcpCorpus([
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: [] },
  ]);
  assert.equal(corpus.sessionCount, 3);
  const stub = corpus.servers.find((s) => s.name === 'stub');
  assert.equal(stub.shippedSessions, 3);
  assert.equal(stub.calledCount, 0);
  assert.equal(stub.deny, true);
});

test('guard: called even once → used → flag-only (no deny)', () => {
  const corpus = aggregateMcpCorpus([
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: ['stub'] }, // called once, in one session
    { shipped: ['stub'], called: [] },
  ]);
  const stub = corpus.servers.find((s) => s.name === 'stub');
  assert.equal(stub.calledCount, 1);
  assert.equal(stub.deny, false, 'binary on absence — called once → used');
});

test('guard: <3 sessions → flag even if never called', () => {
  const corpus = aggregateMcpCorpus([
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: [] },
  ]);
  assert.equal(corpus.sessionCount, 2);
  assert.equal(corpus.servers.find((s) => s.name === 'stub').deny, false);
});

test('single-session mode never denies, even if shipped-but-never-called across ≥3', () => {
  const corpus = aggregateMcpCorpus(
    [
      { shipped: ['stub'], called: [] },
      { shipped: ['stub'], called: [] },
      { shipped: ['stub'], called: [] },
    ],
    { singleSession: true }
  );
  assert.equal(corpus.singleSession, true);
  assert.equal(corpus.servers.find((s) => s.name === 'stub').deny, false);
});

test('calledCount counts the SESSIONS that called the server (the mockup "0/3" form)', () => {
  // sessionMcpProfile reports the DISTINCT servers a session called (a Set), so a
  // server called in 2 of 3 sessions has calledCount=2 — a session-occurrence
  // count, the form the spec mockup renders as "appelé 0/3".
  const corpus = aggregateMcpCorpus([
    { shipped: ['stub'], called: ['stub'] }, // called this session
    { shipped: ['stub'], called: ['stub'] }, // called this session
    { shipped: ['stub'], called: [] },
  ]);
  const stub = corpus.servers.find((s) => s.name === 'stub');
  assert.equal(stub.calledCount, 2, 'called in 2 of 3 sessions');
  assert.equal(stub.deny, false, 'called → used → flag-only');
});

test('aggregateMcpCorpus unions shipped sets and counts shippedSessions per server', () => {
  // `stub` ships in all three; `github` ships in only one. Both never called → both
  // deny (sessionCount is the corpus count, not the per-server shipped count).
  const corpus = aggregateMcpCorpus([
    { shipped: ['stub', 'github'], called: [] },
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: [] },
  ]);
  assert.equal(corpus.sessionCount, 3);
  const byName = new Map(corpus.servers.map((s) => [s.name, s]));
  assert.equal(byName.get('stub').shippedSessions, 3);
  assert.equal(byName.get('github').shippedSessions, 1);
  assert.equal(byName.get('stub').deny, true);
  assert.equal(byName.get('github').deny, true);
});

test('aggregateMcpCorpus is deterministic — servers in sorted order', () => {
  const corpus = aggregateMcpCorpus([
    { shipped: ['zebra', 'alpha'], called: [] },
    { shipped: ['alpha'], called: [] },
    { shipped: ['mango', 'zebra'], called: [] },
  ]);
  assert.deepEqual(
    corpus.servers.map((s) => s.name),
    ['alpha', 'mango', 'zebra']
  );
});

test('aggregateMcpCorpus is null-safe on empty / missing profiles', () => {
  assert.deepEqual(aggregateMcpCorpus([]), { sessionCount: 0, singleSession: false, servers: [] });
  assert.equal(aggregateMcpCorpus([{ shipped: [], called: [] }]).servers.length, 0);
});

test('a missing profile is not counted as a session — the guard needs 3 REAL sessions', () => {
  // sessionCount is the guard's denominator. Counting a hole in the list would let
  // the deny fire on two sessions of evidence.
  const corpus = aggregateMcpCorpus([null, { shipped: ['stub'], called: [] }, { shipped: ['stub'], called: [] }]);
  assert.equal(corpus.sessionCount, 2);
  assert.equal(corpus.servers.find((s) => s.name === 'stub').deny, false);
});

test('a server called but never seen in a listing is flag-only, never denied', () => {
  // The deferred listing only appears while a server is *connecting* — a session
  // whose servers were already connected calls tools with no listing at all. Such
  // a server is used by definition, so it must never reach the deny block.
  const corpus = aggregateMcpCorpus([
    { shipped: [], called: ['github'] },
    { shipped: ['stub'], called: [] },
    { shipped: ['stub'], called: [] },
  ]);
  const github = corpus.servers.find((s) => s.name === 'github');
  assert.equal(github.shippedSessions, 0);
  assert.equal(github.calledCount, 1);
  assert.equal(github.deny, false);
});

// ── fineTune() end-to-end: corpus vs single-session ───────────────────────────

test('fineTune corpus mode (≥3 sessions): an uncalled MCP server lands in disabledMcpjsonServers', () => {
  const root = mkTmpDir();
  writeMcpSession(root, 's1', ['stub'], ['Read']);
  writeMcpSession(root, 's2', ['stub'], ['Read']);
  writeMcpSession(root, 's3', ['stub'], ['Read']);

  const res = fineTune({ cwd: '/nonexistent', root });
  assert.equal(res.mcp.sessionCount, 3);
  const stub = res.mcp.servers.find((s) => s.name === 'stub');
  assert.equal(stub.deny, true);

  // The settings block is valid JSON and carries the MCP deny key.
  const block = JSON.parse(res.settingsJson);
  assert.deepEqual(block.disabledMcpjsonServers, ['stub']);
});

test('fineTune single-session mode (--session) NEVER emits an MCP deny', () => {
  const root = mkTmpDir();
  writeMcpSession(root, 'only', ['stub'], ['Read']); // shipped, never called
  const res = fineTune({ cwd: '/nonexistent', root, session: 'only' });
  assert.equal(res.mcp.singleSession, true);
  assert.equal(res.mcp.servers.find((s) => s.name === 'stub').deny, false);
  const block = JSON.parse(res.settingsJson);
  assert.equal(block.disabledMcpjsonServers, undefined, 'no MCP deny key in single-session mode');
});

test('fineTune corpus with <3 sessions is flag-only (no MCP deny key)', () => {
  const root = mkTmpDir();
  writeMcpSession(root, 's1', ['stub'], ['Read']);
  writeMcpSession(root, 's2', ['stub'], ['Read']);
  const res = fineTune({ cwd: '/nonexistent', root });
  assert.equal(res.mcp.sessionCount, 2);
  assert.equal(res.mcp.servers.find((s) => s.name === 'stub').deny, false);
  assert.equal(JSON.parse(res.settingsJson).disabledMcpjsonServers, undefined);
});

test('fineTune corpus: a called MCP server is flag-only, absent from the deny key', () => {
  const root = mkTmpDir();
  writeMcpSession(root, 's1', ['stub', 'github'], ['mcp__stub__t00', 'Read']); // stub used, github not
  writeMcpSession(root, 's2', ['stub', 'github'], ['Read']);
  writeMcpSession(root, 's3', ['stub', 'github'], ['Read']);
  const res = fineTune({ cwd: '/nonexistent', root });
  const byName = new Map(res.mcp.servers.map((s) => [s.name, s]));
  assert.equal(byName.get('stub').deny, false, 'called → used');
  assert.equal(byName.get('github').deny, true, 'never called across ≥3 → deny');
  assert.deepEqual(JSON.parse(res.settingsJson).disabledMcpjsonServers, ['github']);
});

test('fineTune corpus: a server whose called tool name contains __ still reads as used', () => {
  // `mcp__stub__do__thing` is one call on server `stub`. Mis-splitting the wire
  // name would leave stub with calledCount 0 across 3 sessions → a deny for a
  // server the user actually uses.
  const root = mkTmpDir();
  writeMcpSession(root, 's1', ['stub'], ['mcp__stub__do__thing']);
  writeMcpSession(root, 's2', ['stub'], ['Read']);
  writeMcpSession(root, 's3', ['stub'], ['Read']);
  const res = fineTune({ cwd: '/nonexistent', root });
  const stub = res.mcp.servers.find((s) => s.name === 'stub');
  assert.equal(stub.calledCount, 1, 'the call is attributed to `stub`');
  assert.equal(stub.deny, false, 'called → used → never denied');
  assert.equal(JSON.parse(res.settingsJson).disabledMcpjsonServers, undefined);
});

test('fineTune counts a session once even when discovery finds it twice', () => {
  // `listSessions` scans `<root>/sessions/` AND `<root>/` itself, and `--all` can
  // add a route root that is already the cwd root — the same session id can surface
  // twice. Counting it twice would hand the T4 guard evidence it does not have.
  const root = mkTmpDir();
  writeMcpSession(root, 's1', ['stub'], ['Read']);
  writeMcpSession(root, 's2', ['stub'], ['Read']);
  // The same two sessions again, under the alternate (un-nested) layout.
  for (const id of ['s1', 's2']) {
    fs.cpSync(path.join(root, 'sessions', id), path.join(root, id), { recursive: true });
  }

  const res = fineTune({ cwd: '/nonexistent', root });
  assert.equal(res.mcp.sessionCount, 2, 'two distinct session ids, not four');
  assert.equal(res.mcp.servers.find((s) => s.name === 'stub').deny, false, 'two sessions is below the guard');
});

test('fineTune omits the MCP key entirely when no server is denied (preserves the FT1 block shape)', () => {
  // No MCP shipped at all → block stays exactly the FT1 shape (permissions only).
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'x1');
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'p' }], tools: [{ name: 'Bash' }], messages: [] })),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), zlib.gzipSync(Buffer.from(turnCalling(['Bash']), 'utf8')));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 'x1', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  const res = fineTune({ cwd: '/nonexistent', root });
  assert.deepEqual(JSON.parse(res.settingsJson), { permissions: { deny: [] } });
});

// ── AC #1 — self-activating fixture gate over the committed FT0 capture ───────
//
// While no `session-*` fixture is committed this SKIPS. Today the FT0 fixture IS
// committed: its system content carries the deferred MCP listing with the bench
// `stub` server (bench/fixture/.mcp.json), and none of stub's tools are ever
// called (only Read is). So the parser must yield ['stub'] and, as a single
// session, it is flag-only (no deny).

/** Session fixture dirs under FIXTURES_DIR (`session-*`), sorted. Missing root → []. */
function sessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => path.join(FIXTURES_DIR, e.name))
    .sort();
}

const dirs = sessionDirs();
const gateOpts = dirs.length === 0
  ? {
      skip:
        'no fixture committed under test/fixtures/finetune/ — FT4 (issue #74) confirms the deferred-MCP ' +
        'parser against the real FT0 capture the instant it lands',
    }
  : {};

test('FT4 deferred-MCP listing parsed from the FT0 fixture — AC #1 (issue #74)', gateOpts, () => {
  for (const dir of dirs) {
    const profile = sessionMcpProfile(dir);
    // The bench ships exactly one MCP server (`stub`) via the deferred listing.
    assert.deepEqual(
      [...profile.shipped].sort(),
      ['stub'],
      `${profile.sessionId}: deferred MCP listing must parse to ['stub']`
    );
    // And stub's tools are never called in the fixture (only Read is) — the
    // canonical "shipped but unused" case, flag-only because it is one session.
    assert.ok(!profile.called.has('stub'), `${profile.sessionId}: stub must not read as called`);
  }
});

test('FT4 fineTune on the FT0 fixture is single-session → flag-only (no MCP deny) — AC #1', gateOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    assert.equal(res.mcp.singleSession, true);
    assert.equal(res.mcp.servers.find((s) => s.name === 'stub')?.deny, false);
    assert.equal(JSON.parse(res.settingsJson).disabledMcpjsonServers, undefined);
  }
});
