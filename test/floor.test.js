// ccsnoop floor — turn-1 baseline metric + per-block attribution (issue #99, epic #93).
//
// `floor` is the skill's verify KPI (#96) and the direct answer to "what does this
// repo cost before I type anything?". The headline is the REAL turn-1 input tokens
// (read from captured `usage`, never re-tokenized — aligns #89); the per-block
// breakdown is a byte-length proxy (per-block token attribution would require
// re-tokenizing, which is forbidden), ranked to show where to cut.
//
// Reuse (issue #99 / #93): the per-lever byte figures already exist — `gain.tool`
// (all shipped tools), `gain.claudeMd` / `gain.hook` / `gain.mcp`, and
// `gain.harness` (the incompressible floor) from `src/finetune-gain.js`. `floor`
// only adds turn-1 isolation + the token headline + the ranking exposure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { floor, computeFloor, renderFloor, DEFAULT_WINDOW_TOKENS } from '../src/floor.js';
import { buildRequestBlob } from '../src/capture.js';
import { canonicalize } from '../src/waste.js';
import { loadSession } from '../src/report.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

/** Canonical byte length of a `{type:'text',text}` block — the byte proxy floor uses. */
function txtBytes(s) {
  return Buffer.byteLength(canonicalize({ type: 'text', text: s }), 'utf8');
}

/** Bytes of a `{type:'text',text}` block whose text is a marker plus `n` pad chars. */
function padded(marker, n, pad = 'x') {
  return txtBytes(`${marker}${pad.repeat(n)}`);
}

/**
 * Build an in-memory 2-exchange model whose turn-1 floor is fully known: a harness
 * block, a CLAUDE.md block, a hook block, an MCP block, and two tools. Turn 2 ships
 * a DIFFERENT tool size, so a turn-1-isolating `computeFloor` reads the turn-1 size
 * and not the later one. `segments` carry the tool byte figures (the gain model reads
 * tool bytes from segments, system-lever bytes from the parsed body).
 */
function synthModel() {
  const harnessTxt = 'system prompt identity' + 'H'.repeat(200); // harness (no lever marker)
  const claudeMdTxt = 'Contents of ./CLAUDE.md (project instructions)' + 'C'.repeat(300);
  const hookTxt = 'SessionStart:startup hook success: persona output' + 'K'.repeat(120);
  const mcpTxt = 'deferred tools: mcp__stub__t00 listing' + 'M'.repeat(60);

  const body0 = {
    model: 'claude-test',
    system: [
      { type: 'text', text: harnessTxt },
      { type: 'text', text: claudeMdTxt },
      { type: 'text', text: hookTxt },
      { type: 'text', text: mcpTxt },
    ],
    tools: [{ name: 'Read' }, { name: 'Write' }],
    messages: [{ role: 'user', content: 'hello' }],
  };
  const requestBlob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify(body0)),
  });

  const turn1 = {
    turn: 1,
    usage: { inputTokens: 1000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0, outputTokens: 0 },
    requestBlob,
    segments: [
      { slot: 'system#0', bytes: 1, kind: 'reused-cached' },
      { slot: 'system#1', bytes: 1, kind: 'reused-cached' },
      { slot: 'system#2', bytes: 1, kind: 'reused-cached' },
      { slot: 'system#3', bytes: 1, kind: 'reused-cached' },
      { slot: 'tool:Read', bytes: 4000, kind: 'reused-cached' },
      { slot: 'tool:Write', bytes: 1500, kind: 'reused-cached' },
    ],
  };
  // Turn 2 ships Read at a very different size — a non-isolating floor would pick it up.
  const turn2 = {
    turn: 2,
    usage: { inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 99999, outputTokens: 0 },
    requestBlob,
    segments: [{ slot: 'tool:Read', bytes: 99999, kind: 'reused-cached' }],
  };
  return {
    model: { sessionId: 'synth', exchanges: [turn1, turn2] },
    expected: {
      harness: txtBytes(harnessTxt),
      claudeMd: txtBytes(claudeMdTxt),
      hook: txtBytes(hookTxt),
      mcp: txtBytes(mcpTxt),
      Read: 4000,
      Write: 1500,
    },
  };
}

// ── computeFloor: turn-1 isolation + real-token headline ───────────────────────

test('DEFAULT_WINDOW_TOKENS is the standard 200k Claude context window', () => {
  assert.equal(DEFAULT_WINDOW_TOKENS, 200000);
});

test('computeFloor isolates turn 1 — reads the first exchange, not later turns', () => {
  const { model, expected } = synthModel();
  const f = computeFloor(model);
  assert.equal(f.turns, 2, 'sees both exchanges');
  assert.equal(f.turn1Index, 0, 'turn-1 is exchanges[0]');
  // Read is 4000 on turn 1 and 99999 on turn 2 — isolation keeps the turn-1 figure.
  const read = f.attribution.find((a) => a.kind === 'tool' && a.label === 'Read');
  assert.equal(read.bytes, expected.Read, 'turn-1 tool size, not the later turn');
});

test('computeFloor headline tokens come from real turn-1 usage (input + cacheCreation + cacheRead)', () => {
  const { model } = synthModel();
  const f = computeFloor(model);
  // turn-1 usage = 1000 + 2000 + 0 — the whole turn-1 prompt, regardless of cache state.
  assert.equal(f.headline.tokens, 3000);
  assert.equal(f.headline.inputTokens, 1000);
  assert.equal(f.headline.cacheCreationInputTokens, 2000);
  assert.equal(f.headline.cacheReadInputTokens, 0);
});

test('computeFloor headline is null tokens when no usage was captured (bytes still a labelled proxy)', () => {
  const model = { sessionId: 's', exchanges: [{ turn: 1, usage: null, requestBlob: synthModel().model.exchanges[0].requestBlob, segments: synthModel().model.exchanges[0].segments }] };
  const f = computeFloor(model);
  assert.equal(f.headline.tokens, null, 'no real tokens without usage');
  assert.equal(f.headline.pctOfWindow, null);
  assert.ok(typeof f.headline.bytes === 'number', 'byte proxy still computed');
});

test('computeFloor: % of the window = round(tokens / windowTokens * 100)', () => {
  const { model } = synthModel();
  // 3000 / 200000 = 1.5% → rounds to 2.
  assert.equal(computeFloor(model).headline.pctOfWindow, 2);
  // A 6 000-token window makes 3000 tokens exactly 50%.
  assert.equal(computeFloor(model, { windowTokens: 6000 }).headline.pctOfWindow, 50);
  assert.equal(computeFloor(model, { windowTokens: 6000 }).windowTokens, 6000);
  // No tokens → no window percentage.
  const noUsage = computeFloor({ sessionId: 's', exchanges: [{ turn: 1, usage: null, requestBlob: '', segments: [] }] });
  assert.equal(noUsage.headline.pctOfWindow, null);
});

// ── computeFloor: per-block attribution ranking + byte proxy ───────────────────

test('computeFloor attributes every lever kind from the turn-1 floor', () => {
  const { model, expected } = synthModel();
  const f = computeFloor(model);
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  assert.equal(byKind.get('harness').bytes, expected.harness);
  assert.equal(byKind.get('claude-md').bytes, expected.claudeMd);
  assert.equal(byKind.get('hook').bytes, expected.hook);
  assert.equal(byKind.get('mcp-deferred').bytes, expected.mcp);
  const tools = f.attribution.filter((a) => a.kind === 'tool');
  const got = tools
    .map((a) => ({ label: a.label, bytes: a.bytes }))
    .sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(got, [
    { label: 'Read', bytes: 4000 },
    { label: 'Write', bytes: 1500 },
  ]);
});

test('computeFloor ranks attribution by byte cost, descending', () => {
  const { model } = synthModel();
  const f = computeFloor(model);
  const bytes = f.attribution.map((a) => a.bytes);
  assert.deepEqual(bytes, [...bytes].sort((a, b) => b - a), 'strictly sorted high → low');
});

test('computeFloor: totalBytes = Σ attribution bytes; each pctOfFloor = round(bytes/total*100)', () => {
  const { model } = synthModel();
  const f = computeFloor(model);
  assert.equal(f.totalBytes, f.attribution.reduce((s, a) => s + a.bytes, 0));
  for (const a of f.attribution) {
    assert.equal(a.pctOfFloor, Math.round((a.bytes / f.totalBytes) * 100));
  }
});

test('computeFloor exposes the captured model name and the window it scored against', () => {
  const { model } = synthModel();
  const f = computeFloor(model);
  assert.equal(f.model, 'claude-test');
  assert.equal(f.windowTokens, DEFAULT_WINDOW_TOKENS);
});

test('computeFloor is null-safe on an empty model', () => {
  const f = computeFloor({ sessionId: 'empty', exchanges: [] });
  assert.equal(f.turns, 0);
  assert.equal(f.totalBytes, 0);
  assert.equal(f.headline.tokens, null);
  assert.deepEqual(f.attribution, []);
});

// ── renderFloor: text output ───────────────────────────────────────────────────

test('renderFloor leads with the real token headline and labels the byte proxy', () => {
  const { model } = synthModel();
  const { lines } = renderFloor(computeFloor(model));
  const out = lines.join('\n');
  assert.match(out, /floor/i);
  assert.match(out, /3[ ,]?000 tokens/, 'headline is the real turn-1 token figure');
  assert.match(out, /2%\s+of\s+a\s+200[ ,]?000.*window/i, '% of the window beside the headline');
  assert.match(out, /proxy/i, 'bytes explicitly labelled as a proxy');
  assert.match(out, /never re-tokeniz/i, 'the no-re-tokenize guardrail is stated');
});

test('renderFloor prints a ranked per-block breakdown with a total', () => {
  const { model } = synthModel();
  const { lines } = renderFloor(computeFloor(model));
  const out = lines.join('\n');
  assert.match(out, /block/i);
  assert.match(out, /bytes/i);
  assert.match(out, /total/i);
  // Every lever kind appears as a labelled row.
  assert.match(out, /harness/i);
  assert.match(out, /CLAUDE\.md/i);
  assert.match(out, /hook/i);
  assert.match(out, /MCP/i);
  // The top tool by byte cost (Read, 4000) appears above the smaller one (Write, 1500).
  const readIdx = out.indexOf('Read');
  const writeIdx = out.indexOf('Write');
  assert.ok(readIdx > -1 && writeIdx > -1 && readIdx < writeIdx, 'higher-cost tool ranked first');
});

test('renderFloor: with no usage, headline is byte-proxy only and still renders', () => {
  const f = computeFloor({ sessionId: 's', exchanges: [{ turn: 1, usage: null, requestBlob: '', segments: [] }] });
  const { lines } = renderFloor(f);
  const out = lines.join('\n');
  assert.match(out, /proxy/i);
  assert.doesNotMatch(out, /%\s+of\s+a\s+\d.*window/, 'no window % when there are no real tokens');
});

// ── floor() end-to-end + CLI dispatch (self-activating fixture gate) ───────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-floor-'));
}

/** A one-turn session dir with a known tools[] + a usage-bearing response. */
function writeSession(dir, id, tools, usage) {
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: 'system prompt' }],
        tools,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(
    path.join(dir, '0001.response.sse'),
    `data: {"type":"message_start","message":{"usage":${JSON.stringify(usage)}}}\n\n`
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

test('floor() resolves a session dir and reports turn-1 tokens + tools', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 's'), 's', [{ name: 'Bash' }, { name: 'Read' }], {
    input_tokens: 1200,
    cache_creation_input_tokens: 800,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  const res = floor({ cwd: '/nonexistent', root, session: 's' });
  assert.equal(res.sessionId, 's');
  assert.equal(res.turns, 1);
  assert.equal(res.headline.tokens, 2000);
  const tools = res.attribution.filter((a) => a.kind === 'tool').map((a) => a.label);
  assert.ok(tools.includes('Bash') && tools.includes('Read'));
});

test('floor() throws on no captured sessions (mirrors report / fine-tune / cache)', () => {
  const root = mkTmpDir();
  assert.throws(() => floor({ cwd: '/nonexistent', root }), /no captured sessions found/);
});

test('ccsnoop floor --sessions-dir prints the headline + ranked breakdown (exit 0)', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'cli'), 'cli', [{ name: 'Bash' }, { name: 'Read' }], {
    input_tokens: 5000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  const r = spawnSync(process.execPath, [BIN, 'floor', '--sessions-dir', sessionsDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /floor/i);
  assert.match(r.stdout, /5[ ,]?000 tokens/);
  assert.match(r.stdout, /%\s+of\s+a\s+200[ ,]?000.*window/i);
  assert.match(r.stdout, /harness/i);
});

test('ccsnoop floor --window overrides the context window for the % figure', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'win'), 'win', [{ name: 'Bash' }], {
    input_tokens: 2500,
    cache_creation_input_tokens: 2500,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  });
  const r = spawnSync(process.execPath, [BIN, 'floor', '--sessions-dir', sessionsDir, '--window', '10000'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // 5000 tokens / 10000 window = 50%.
  assert.match(r.stdout, /50%.*window/);
});

// Self-activating gate: only runs when the frozen real fixture is committed.
const fixtureOpts = fs.existsSync(FIXTURES_DIR) &&
  fs.readdirSync(FIXTURES_DIR, { withFileTypes: true }).some((e) => e.isDirectory() && /^session-/.test(e.name))
  ? {}
  : { skip: 'no fixture committed under test/fixtures/finetune/' };

test('floor() on the real fixture: real turn-1 tokens + ranked floor (issue #99 AC)', fixtureOpts, () => {
  const dir = path.join(FIXTURES_DIR, 'session-963204f5-937b-4a13-b658-f1cbffd21421');
  const loaded = loadSession(dir, 'fixture');
  const res = floor({ cwd: '/nonexistent', root: FIXTURES_DIR });

  // Turn-1 isolation over a 6-exchange session.
  assert.equal(res.turns, 6);
  assert.equal(res.turn1Index, 0);
  // Headline tokens = real captured usage, derived independently from the loaded model.
  const u = loaded.exchanges[0].usage;
  const expectedTokens = u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
  assert.equal(res.headline.tokens, expectedTokens);
  assert.equal(res.headline.pctOfWindow, Math.round((expectedTokens / DEFAULT_WINDOW_TOKENS) * 100));

  // Every contributor kind is attributed.
  const kinds = new Set(res.attribution.map((a) => a.kind));
  assert.ok(kinds.has('harness'), 'incompressible system[] floor attributed');
  assert.ok(kinds.has('tool'), 'tool defs attributed');
  assert.ok(kinds.has('claude-md'), 'CLAUDE.md sources attributed');
  assert.ok(kinds.has('hook'), 'SessionStart hook output attributed');

  // Ranked by byte cost; total is the sum.
  const bytes = res.attribution.map((a) => a.bytes);
  assert.deepEqual(bytes, [...bytes].sort((a, b) => b - a));
  assert.equal(res.totalBytes, bytes.reduce((s, b) => s + b, 0));
  assert.ok(res.totalBytes > 0);
});
