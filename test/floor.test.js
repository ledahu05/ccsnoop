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

test('computeFloor falls back to the default window on an unusable override — never a NaN %', () => {
  const { model } = synthModel();
  // A caller passing garbage (0, negative, NaN, a numeric STRING) must not produce a
  // NaN/Infinity percentage; the conservative 200k default stands and is reported.
  for (const windowTokens of [0, -5, NaN, Infinity, /** @type {any} */ ('6000'), null]) {
    const f = computeFloor(model, { windowTokens });
    assert.equal(f.windowTokens, DEFAULT_WINDOW_TOKENS, `window for ${String(windowTokens)}`);
    assert.equal(f.headline.pctOfWindow, 2);
  }
});

test('computeFloor reports a real zero-token headline, not "no usage"', () => {
  // usage captured but every component 0 — distinct from usage absent (tokens null).
  const f = computeFloor({
    sessionId: 's',
    exchanges: [{ usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }],
  });
  assert.equal(f.headline.tokens, 0, 'zero real tokens is a measurement, not a gap');
  assert.equal(f.headline.pctOfWindow, 0);
  assert.match(renderFloor(f).lines.join('\n'), /floor: 0 tokens/);
});

test('computeFloor attributes each CLAUDE.md source separately; a source-less one reads as managed', () => {
  const withPath = 'Contents of ./a/CLAUDE.md (project instructions)' + 'A'.repeat(50);
  const managed = 'CCSNOOP-BENCH-SENTINEL-CLAUDEMD-abc123 policy text' + 'B'.repeat(10);
  const requestBlob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        system: [{ type: 'text', text: withPath }, { type: 'text', text: managed }],
        messages: [],
      })
    ),
  });
  const f = computeFloor({ sessionId: 's', exchanges: [{ turn: 1, requestBlob, segments: [] }] });
  const md = f.attribution.filter((a) => a.kind === 'claude-md');
  assert.deepEqual(
    md.map((a) => a.detail).sort(),
    ['./a/CLAUDE.md', null],
    'one block per source; no path → null detail'
  );
  assert.equal(md.find((a) => a.detail === null).bytes, txtBytes(managed));
  assert.match(renderFloor(f).lines.join('\n'), /CLAUDE\.md \(managed\)/);
});

// ── computeFloor: interactive preflight at exchanges[0] (issue #107) ───────────
//
// Claude Code emits a small preflight probe before the first real conversation turn
// on every interactive session. It carries NO tools[] and NO system[] (sometimes a
// non-JSON HEAD), so `exchanges[0]` is that probe, not the opening — and anchoring
// turn 1 on index 0 zeroed the whole floor (issue #107). Turn 1 is now the first
// exchange that ships the static floor.

/** A preflight exchange: no tools[], no system[], tiny body, no usage — the probe
 *  Claude Code emits before the real turn-1 opening on every interactive session. */
function preflightExchange() {
  return {
    turn: 1,
    usage: null,
    requestBlob: buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'probe' }] })),
    }),
    segments: [{ slot: 'message#0', bytes: 5, kind: 'reused-cached' }],
  };
}

/** An interactive session: the preflight at exchanges[0], the real opening at [1]. */
function interactiveModel() {
  const real = synthModel();
  const opening = real.model.exchanges[0]; // the known floor (tools + system + usage)
  return {
    model: { sessionId: 'interactive', exchanges: [preflightExchange(), { ...opening, turn: 2 }] },
    expected: real.expected,
  };
}

test('computeFloor skips the interactive preflight and attributes the real opening (issue #107)', () => {
  const { model, expected } = interactiveModel();
  const f = computeFloor(model);
  assert.equal(f.turns, 2, 'sees both exchanges');
  assert.equal(f.turn1Index, 1, 'turn-1 is the opening at exchanges[1], NOT the preflight at [0]');
  // The real floor is attributed — not the zero the preflight would yield.
  assert.ok(f.totalBytes > 0, 'floor is non-zero (the preflight no longer zeroes it)');
  const read = f.attribution.find((a) => a.kind === 'tool' && a.label === 'Read');
  assert.equal(read.bytes, expected.Read, 'the opening tool size');
  // Headline tokens come from the opening's usage, not the preflight (which had none).
  assert.equal(f.headline.tokens, 3000);
});

test('computeFloor does not mistake an empty system string for a floor (carriesFloor edge)', () => {
  // A preflight that ships `system: ""` (or empty tools) is NOT the floor — turn 1 must
  // still skip it for the real opening. An overly loose predicate would anchor here.
  const preflightEmpty = {
    turn: 1,
    usage: null,
    requestBlob: buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-test', system: '', tools: [], messages: [{ role: 'user', content: 'probe' }] })),
    }),
    segments: [],
  };
  const real = synthModel();
  const opening = real.model.exchanges[0];
  const f = computeFloor({ sessionId: 'edge', exchanges: [preflightEmpty, { ...opening, turn: 2 }] });
  assert.equal(f.turn1Index, 1, 'the empty-system preflight is skipped for the real opening');
  assert.ok(f.totalBytes > 0);
});

test('computeFloor renders a real floor for an interactive session, not "nothing attributed" (issue #107)', () => {
  const { model } = interactiveModel();
  const out = renderFloor(computeFloor(model)).lines.join('\n');
  assert.doesNotMatch(out, /nothing attributed/i, 'no longer claims an empty floor');
  assert.match(out, /3[ ,]?000 tokens/, 'the opening headline reports');
});

test('computeFloor falls back to the first substantial exchange when none carries a recognizable floor', () => {
  // A degraded capture: neither exchange ships tools[]/system[], but the second clears
  // the byte floor. Floor picks it over the tiny first (and still reports its usage).
  const tiny = {
    turn: 1,
    usage: null,
    requestBlob: buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'x' }] })),
    }),
    segments: [],
  };
  const big = {
    turn: 2,
    usage: { inputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
    requestBlob: buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'y'.repeat(5000) }] })),
    }),
    segments: [],
  };
  const f = computeFloor({ sessionId: 'degraded', exchanges: [tiny, big] });
  assert.equal(f.turn1Index, 1, 'the substantial exchange, not the tiny one');
  assert.equal(f.headline.tokens, 500, 'usage read from the picked exchange');
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

test('renderFloor: nothing attributed says so instead of claiming 100% of zero bytes', () => {
  // Reachable for real: a turn-1 request whose body never parsed (an aborted capture)
  // still has usage tokens, but no static block can be attributed.
  const f = computeFloor({ sessionId: 's', exchanges: [{ turn: 1, usage: { inputTokens: 9 }, requestBlob: 'junk' }] });
  const out = renderFloor(f).lines.join('\n');
  assert.match(out, /nothing attributed/i, 'the empty floor is named');
  assert.doesNotMatch(out, /100%/, 'no bogus 100%-of-nothing total row');
  assert.match(out, /floor: 9 tokens/, 'the real token headline still reports');
});

test('renderFloor: the table header, rules and rows all share one column layout', () => {
  const { model } = synthModel();
  const { lines } = renderFloor(computeFloor(model));
  // The table starts at the header row and runs to the end; every line in it is one
  // formatted row, so a misaligned header or total shows up as a differing width.
  const start = lines.findIndex((l) => /^\s+block\s+bytes/.test(l));
  assert.ok(start > -1, 'header row found');
  const widths = new Set(lines.slice(start).map((l) => [...l].length));
  assert.equal(widths.size, 1, `table rows differ in width: ${[...widths].join(', ')}`);
});

test('renderFloor omits the model line when the capture carried no model name', () => {
  const f = computeFloor({ sessionId: 's', exchanges: [] });
  assert.equal(f.model, null);
  assert.ok(!renderFloor(f).lines.some((l) => l.startsWith('model:')));
});

// ── floor() end-to-end + CLI dispatch (self-activating fixture gate) ───────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-floor-'));
}

/**
 * A one-turn session dir with a known tools[] + a usage-bearing response.
 * `messageContent` is the turn-1 user message — a bare string by default, or an array of
 * content blocks when a test needs the catalog `<system-reminder>`s that ride it (#109).
 * @param {string} dir
 * @param {string} id
 * @param {{ name: string }[]} tools
 * @param {Record<string, number>} usage
 * @param {string | { type: string, text: string }[]} [messageContent]
 */
function writeSession(dir, id, tools, usage, messageContent = 'hi') {
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
        messages: [{ role: 'user', content: messageContent }],
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

test('floor() throws naming the available sessions when --session does not match', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'real'), 'real', [{ name: 'Bash' }], { input_tokens: 1 });
  assert.throws(
    () => floor({ cwd: '/nonexistent', root, session: 'typo' }),
    /session 'typo' not found \(have: real\)/
  );
});

test('floor() defaults to the most-recent session when none is named', () => {
  const root = mkTmpDir();
  writeSession(path.join(root, 'sessions', 'older'), 'older', [{ name: 'Bash' }], { input_tokens: 10 });
  const newer = writeSession(path.join(root, 'sessions', 'newer'), 'newer', [{ name: 'Bash' }], { input_tokens: 20 });
  // mtime resolution is coarse; make the intended winner unambiguously newer.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(newer, future, future);
  assert.equal(floor({ cwd: '/nonexistent', root }).sessionId, 'newer');
});

test('ccsnoop floor rejects an unusable --window rather than silently scoring 200k', () => {
  const sessionsDir = mkTmpDir();
  writeSession(path.join(sessionsDir, 'w'), 'w', [{ name: 'Bash' }], { input_tokens: 100 });
  for (const bad of ['abc', '0', '-1', '']) {
    const r = spawnSync(process.execPath, [BIN, 'floor', '--sessions-dir', sessionsDir, '--window', bad], {
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, `--window '${bad}' should fail`);
    assert.match(r.stderr, /--window expects a positive number of tokens/);
  }
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

// ── catalog blocks: deferred tools / agent types / skills (issue #109) ─────────
//
// The turn-1 prompt carries three catalogs. Before #109 `floor` showed at most ONE
// opaque `MCP — deferred tool listing` row: only the deferred-tools listing matched the
// shared classifier, while the agent-types and skills catalogs — which ride
// `messages[0].content` and classify to `harness` — were dropped entirely, because
// `chargeExchange` charges harness only on the `system` surface. So these tests pin two
// distinct properties: the catalogs are NAMED (ventilation), and the two that were
// invisible now COUNT (the correctness half of the issue).

/** The real Claude Code header lines that introduce each catalog. */
const DEFERRED_TXT =
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded.\n\nWebFetch\nWebSearch\nMonitor\n\nThe following MCP servers are still connecting:\n\nstub\n';
const AGENTS_TXT =
  'Available agent types for the Agent tool:\n- Explore: Read-only search agent for broad fan-out searches.\n- Plan: Software architect agent for designing implementation plans.\n';
const SKILLS_TXT =
  'The following skills are available for use with the Skill tool:\n\n- dataviz: Use this skill whenever you are about to create ANY chart.\n- claude-api: Reference for the Claude API.\nTRIGGER — read BEFORE opening the target file.\nSKIP only when another provider is being worked on.\n';

/**
 * A one-exchange model whose turn-1 `messages[0].content` carries the three catalogs.
 * `shape: 'separate'` gives each its own block (the committed fixture's shape);
 * `shape: 'combined'` rides all three in ONE block (the only shape that can produce the
 * single ~30 KB row issue #109 reports from a real session — 19 tool names are not 30 KB).
 */
function catalogModel(shape, { surface = 'message', skillsText = SKILLS_TXT, deferredText = DEFERRED_TXT } = {}) {
  const wrap = (t) => `<system-reminder>\n${t}</system-reminder>`;
  const blocks =
    shape === 'combined'
      ? [{ type: 'text', text: wrap(`${deferredText}\n${AGENTS_TXT}\n${skillsText}`) }]
      : [deferredText, AGENTS_TXT, skillsText].map((t) => ({ type: 'text', text: wrap(t) }));
  const body = {
    model: 'claude-test',
    system: [{ type: 'text', text: 'harness preamble' + 'H'.repeat(400) }, ...(surface === 'system' ? blocks : [])],
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: surface === 'system' ? 'hello' : [{ type: 'text', text: 'hello' }, ...blocks] }],
  };
  const requestBlob = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify(body)),
  });
  return {
    sessionId: 'catalog',
    exchanges: [
      {
        turn: 1,
        usage: { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        requestBlob,
        segments: [{ slot: 'tool:Read', bytes: 500, kind: 'reused-cached' }],
      },
    ],
  };
}

test('computeFloor names the three catalogs instead of one opaque MCP row', () => {
  const f = computeFloor(catalogModel('separate'));
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  assert.ok(byKind.has('deferred-tools'), 'deferred-tools listing named');
  assert.ok(byKind.has('agent-types'), 'agent-types catalog named');
  assert.ok(byKind.has('skills-catalog'), 'skills catalog named');
  assert.ok(!byKind.has('mcp-deferred'), 'the opaque MCP row is replaced, not duplicated');
  // Each block's bytes are the canonical byte length of its own <system-reminder> block —
  // the same basis every other floor row uses, so the table stays comparable.
  assert.equal(byKind.get('agent-types').bytes, txtBytes(`<system-reminder>\n${AGENTS_TXT}</system-reminder>`));
});

test('computeFloor: the previously-invisible catalogs now count toward the floor total', () => {
  const f = computeFloor(catalogModel('separate'));
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  // Before #109 these two rode the message surface, classified `harness`, and were
  // dropped as conversation — they contributed exactly zero to the floor.
  const gained = byKind.get('agent-types').bytes + byKind.get('skills-catalog').bytes;
  assert.ok(gained > 0, 'agent-types + skills carry real bytes');
  assert.equal(f.totalBytes, f.attribution.reduce((s, a) => s + a.bytes, 0), 'total absorbs them');
});

test('computeFloor carves a COMBINED catalog block into three that tile it exactly', () => {
  const f = computeFloor(catalogModel('combined'));
  const cat = f.attribution.filter((a) => ['deferred-tools', 'agent-types', 'skills-catalog'].includes(a.kind));
  assert.equal(cat.length, 3, 'one row per population, from a single source block');
  // The spans must tile the source block: splitting a row may not invent bytes the gain
  // model never charged, so Σ spans === the whole block's canonical byte length.
  const whole = txtBytes(`<system-reminder>\n${DEFERRED_TXT}\n${AGENTS_TXT}\n${SKILLS_TXT}</system-reminder>`);
  assert.equal(cat.reduce((s, a) => s + a.bytes, 0), whole, 'spans tile the block exactly');
});

test('computeFloor does not double-count a catalog, on either surface', () => {
  // A catalog block used to classify `harness`, so on the `system` surface the gain model
  // folded it into the preamble figure and `floor` had to DEDUCT it again. Since #116 it
  // classifies to its own lever on both surfaces, so there is nothing to deduct — but the
  // property that mattered is unchanged and still pinned here: the same catalogs cost the
  // same bytes whichever surface carries them, and the harness row is the preamble ALONE.
  const onSystem = computeFloor(catalogModel('separate', { surface: 'system' }));
  const onMessage = computeFloor(catalogModel('separate', { surface: 'message' }));
  const catBytes = (f) =>
    f.attribution.filter((a) => ['agent-types', 'skills-catalog'].includes(a.kind)).reduce((s, a) => s + a.bytes, 0);
  assert.equal(catBytes(onSystem), catBytes(onMessage), 'same catalogs, same bytes on either surface');

  const harness = onSystem.attribution.find((a) => a.kind === 'harness');
  assert.ok(harness, 'the system[] preamble still has its own row');
  // The preamble is a known ~400 B of padding. Pinning its EXACT bytes is what makes this
  // a real guard: a harness figure that still carried the catalogs would be far larger,
  // and the old `<` comparison would not have caught every way of getting that wrong.
  assert.equal(harness.bytes, txtBytes('harness preamble' + 'H'.repeat(400)), 'harness is the preamble alone');
  assert.equal(onSystem.totalBytes, onMessage.totalBytes, 'and the floor totals agree across surfaces');
});

// ── #116: the classifier inverted under floor, and the bytes did not move ─────
//
// The catalog detection moved DOWN into the shared classifier, and `mcp-deferred` shrank
// to the connecting-servers sub-list. That is a refactor of provenance, not of
// measurement: `floor` must render the same bytes per block as it did after #113. The
// listing keeps its connecting servers as `group: 'servers'` entries under one row, and
// carries `chargedTo: 'mcp'` so the opaque MCP row is still dropped, not shown alongside.

test('computeFloor still renders the deferred listing as ONE row, sub-list included (#116)', () => {
  const f = computeFloor(catalogModel('separate'));
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  assert.equal(byKind.get('deferred-tools').bytes, txtBytes(`<system-reminder>\n${DEFERRED_TXT}</system-reminder>`));
  assert.ok(!byKind.has('mcp-deferred'), 'the MCP sub-list does not become a second row');
  // The servers are visible where they always were — inside the listing's entries.
  assert.deepEqual(byKind.get('deferred-tools').entries.filter((e) => e.group === 'servers').map((e) => e.name), ['stub']);
});

test('computeFloor: a deferred listing with no connecting servers shows no MCP row at all', () => {
  // The whole point of the narrowing: a repo with no MCP server used to be charged the
  // entire listing under a label naming a server it had never configured.
  const noMcp = DEFERRED_TXT.slice(0, DEFERRED_TXT.indexOf('\nThe following MCP servers'));
  const model = catalogModel('separate', { deferredText: `${noMcp}\n` });
  const f = computeFloor(model);
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  assert.ok(byKind.has('deferred-tools'), 'the listing is still named and costed');
  assert.ok(!byKind.has('mcp-deferred'), 'and nothing is attributed to MCP');
});

test('computeFloor keeps the opaque MCP row when the listing headers are unrecognized', () => {
  // A build of Claude Code that words the headers differently still trips the shared
  // classifier. One coarse row beats silently dropping ~30 KB from the floor.
  const { model, expected } = synthModel();
  const f = computeFloor(model);
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));
  assert.equal(byKind.get('mcp-deferred').bytes, expected.mcp, 'the fallback row survives');
  assert.ok(!byKind.has('deferred-tools'), 'no catalog is invented from an unmatched block');
});

test('computeFloor: catalog entries are parsed, ranked, and sum to under the block', () => {
  const f = computeFloor(catalogModel('separate'));
  const byKind = new Map(f.attribution.map((a) => [a.kind, a]));

  // Deferred tools: the bare-token names, plus the connecting MCP servers as their own group.
  const deferred = byKind.get('deferred-tools');
  assert.deepEqual(
    deferred.entries.filter((e) => e.group === 'tools').map((e) => e.name).sort(),
    ['Monitor', 'WebFetch', 'WebSearch']
  );
  assert.deepEqual(deferred.entries.filter((e) => e.group === 'servers').map((e) => e.name), ['stub']);

  // Skills: a description spanning several physical lines is ONE entry, not three.
  const skills = byKind.get('skills-catalog');
  assert.deepEqual(skills.entries.map((e) => e.name).sort(), ['claude-api', 'dataviz']);
  const api = skills.entries.find((e) => e.name === 'claude-api');
  assert.ok(api.bytes > Buffer.byteLength('- claude-api: Reference for the Claude API.\n'), 'continuation lines folded in');

  for (const kind of /** @type {import('../src/floor.js').FloorBlock['kind'][]} */ ([
    'deferred-tools',
    'agent-types',
    'skills-catalog',
  ])) {
    const b = byKind.get(kind);
    assert.deepEqual(b.entries.map((e) => e.bytes), [...b.entries.map((e) => e.bytes)].sort((x, y) => y - x), `${kind} ranked`);
    const sum = b.entries.reduce((s, e) => s + e.bytes, 0);
    assert.ok(sum > 0 && sum < b.bytes, `${kind} entries sum under the block (headers are the remainder)`);
  }
});

// ── name-only entries (issue #115) ────────────────────────────────────────────
//
// A skill listed WITHOUT its description renders as a bare `- <name>` line — no colon.
// Two independent paths produce it, so this shape is not exotic:
//   • `skillOverrides: { "<name>": "name-only" }` in settings.json — the key Claude Code's
//     own `/skills` UI writes, and the action lever 5a will emit (ADR-0005);
//   • Claude Code's own catalog budget: on overflow it degrades the biggest entries to
//     `- <name>`, biggest-first (`budgetTruncatedSkills`) — no user setting involved.
// Both were confirmed on the bench-pinned build; see docs/research/skill-overrides-name-only.md.

/** The `- name` (no colon) shape, alongside a normal `- name: description` entry. */
const SKILLS_NAME_ONLY_TXT =
  'The following skills are available for use with the Skill tool:\n\n- dataviz\n- claude-api: Reference for the Claude API.\nTRIGGER — read BEFORE opening the target file.\n';

test('computeFloor: a name-only skill is its own entry, not bytes folded into its neighbour (issue #115)', () => {
  const model = catalogModel('separate', { skillsText: SKILLS_NAME_ONLY_TXT });
  const skills = computeFloor(model).attribution.find((a) => a.kind === 'skills-catalog');
  assert.deepEqual(skills.entries.map((e) => e.name).sort(), ['claude-api', 'dataviz'], 'the name-only skill is named');
  const viz = skills.entries.find((e) => e.name === 'dataviz');
  // This is the whole point of `name-only`: the entry costs its name and nothing else.
  assert.equal(viz.bytes, Buffer.byteLength('- dataviz\n', 'utf8'), 'a name-only entry costs exactly its name line');
  // The failure mode being pinned: a no-colon line read as a CONTINUATION would charge
  // dataviz's bytes to whatever entry precedes it, inflating a skill that is in active use.
  // So claude-api must weigh its OWN two lines exactly — not a byte more.
  const api = skills.entries.find((e) => e.name === 'claude-api');
  const apiOwnLines =
    '- claude-api: Reference for the Claude API.\nTRIGGER — read BEFORE opening the target file.\n';
  assert.equal(api.bytes, Buffer.byteLength(apiOwnLines, 'utf8'), 'no cross-charge to the neighbour');
});

test('computeFloor: a bulleted description is never mistaken for a name-only entry (issue #115)', () => {
  // The discriminator is "a single bare token after the dash". A description whose
  // continuation line happens to start with `- ` is prose — it must still fold in.
  const txt =
    'The following skills are available for use with the Skill tool:\n\n- tdd: Test-driven development.\n- when the user wants red-green-refactor\n';
  const model = catalogModel('separate', { skillsText: txt });
  const skills = computeFloor(model).attribution.find((a) => a.kind === 'skills-catalog');
  assert.deepEqual(skills.entries.map((e) => e.name), ['tdd'], 'the prose line folded into tdd, it is not an entry');
});

test('computeFloor: an empty description is still a named entry, colon not swallowed (issue #115)', () => {
  // `- tdd:` — a skill whose description is empty renders as a bullet with a TRAILING colon.
  // The name-only pattern must not claim it, or the name carries the colon (`tdd:`) and stops
  // matching the same skill across two captures — which is exactly what a before/after diff
  // of an override joins on.
  const txt = 'The following skills are available for use with the Skill tool:\n\n- tdd:\n- dataviz\n';
  const model = catalogModel('separate', { skillsText: txt });
  const skills = computeFloor(model).attribution.find((a) => a.kind === 'skills-catalog');
  assert.deepEqual(skills.entries.map((e) => e.name).sort(), ['dataviz', 'tdd'], 'names carry no trailing colon');
});

test('renderFloor: --detail adds a per-entry section below the total, leaving the table intact', () => {
  const ctx = computeFloor(catalogModel('separate'));
  const plain = renderFloor(ctx).lines.join('\n');
  const detailed = renderFloor(ctx, { detail: true }).lines.join('\n');

  assert.ok(detailed.startsWith(plain), 'detail is strictly appended — the ranked table is unchanged');
  assert.doesNotMatch(plain, /per-entry/i, 'no entry noise without the flag');
  assert.match(detailed, /Per-entry breakdown/i);
  assert.match(detailed, /WebSearch/, 'a deferred tool name is listed');
  assert.match(detailed, /stub \(mcp server\)/, 'a connecting server is marked as such');
  assert.match(detailed, /dataviz/, 'a skill name is listed');
  assert.match(detailed, /headers, separators, envelope/, 'the unattributed remainder is named, not hidden');
});

test('renderFloor: --detail on a floor with no catalog says so rather than printing an empty section', () => {
  const out = renderFloor(computeFloor(synthModel().model), { detail: true }).lines.join('\n');
  assert.match(out, /no catalog blocks/i);
});

test('ccsnoop floor --detail prints the per-entry breakdown (exit 0)', () => {
  const sessionsDir = mkTmpDir();
  const wrap = (t) => ({ type: 'text', text: `<system-reminder>\n${t}</system-reminder>` });
  writeSession(path.join(sessionsDir, 'cat'), 'cat', [{ name: 'Read' }], { input_tokens: 100, output_tokens: 1 }, [
    { type: 'text', text: 'hi' },
    wrap(DEFERRED_TXT),
    wrap(SKILLS_TXT),
  ]);
  const base = [BIN, 'floor', '--sessions-dir', sessionsDir];
  const plain = spawnSync(process.execPath, base, { encoding: 'utf8' });
  const detailed = spawnSync(process.execPath, [...base, '--detail'], { encoding: 'utf8' });
  assert.equal(detailed.status, 0, `stderr: ${detailed.stderr}`);
  assert.match(plain.stdout, /deferred tools — ToolSearch listing/, 'the catalog row is named without the flag');
  assert.doesNotMatch(plain.stdout, /WebSearch/, 'entries stay behind the flag');
  assert.match(detailed.stdout, /Per-entry breakdown/i);
  assert.match(detailed.stdout, /WebSearch/);
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
  // #109 — the deferred listing is ventilated into three named catalogs, and the two that
  // the gain model dropped as conversation are now costed on the real capture too.
  assert.ok(kinds.has('deferred-tools'), 'deferred tool listing attributed');
  assert.ok(kinds.has('agent-types'), 'agent-types catalog attributed');
  assert.ok(kinds.has('skills-catalog'), 'skills catalog attributed');
  assert.ok(!kinds.has('mcp-deferred'), 'no opaque MCP row left on a recognized capture');
  for (const a of res.attribution.filter((x) => x.entries)) {
    assert.ok(a.entries.length > 0, `${a.label} broke down into entries`);
  }

  // Ranked by byte cost; total is the sum.
  const bytes = res.attribution.map((a) => a.bytes);
  assert.deepEqual(bytes, [...bytes].sort((a, b) => b - a));
  assert.equal(res.totalBytes, bytes.reduce((s, b) => s + b, 0));
  assert.ok(res.totalBytes > 0);
});
