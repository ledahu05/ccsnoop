// FT5 (issue #75) — the two no-dynamic-proof levers: SessionStart hooks + CLAUDE.md.
//
// Unifying principle (fine-tune-spec Part 3): only levers WITH dynamic proof
// (built-in tools; MCP) may say "unused → remove". Hooks + CLAUDE.md ship every
// session by construction, so they may say only "costs N bytes" — NEVER "unused".
//
//   • Hooks — emit removal of `hooks.SessionStart` ONLY when the injected output
//     ≥ `bloatFloorBytes`; below the floor → diagnostic-only. Every emitted removal
//     carries the "intent unknown" caveat.
//   • CLAUDE.md — advice-only; per source file show byte cost + % of system;
//     `claudeMdExcludes` only for excludable (non-managed) files above the floor.
//
// RGR posture. The floor / excludable / "never unused" logic is exercised with
// SYNTHETIC inputs (buildLeverVerdicts is pure), and a self-activating gate pins
// the scan against the committed FT0 fixture (its hook-persona + CLAUDE.md blocks
// ride `messages[0]`, the `-p` shape — §4 of bench/SPEC.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOOK_INTENT_CAVEAT,
  scanRequestLeverBlocks,
  sessionLeverProfile,
  buildLeverVerdicts,
} from '../src/finetune-levers.js';
import { DEFAULT_WASTE_CONFIG } from '../src/waste.js';
import { buildRequestBlob } from '../src/capture.js';
import { fineTune, renderFineTune } from '../src/finetune.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));
const FLOOR = DEFAULT_WASTE_CONFIG.bloatFloorBytes;

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ft5-'));
}

// ── the caveat (AC #3: never "unused") ────────────────────────────────────────

test('the hook caveat carries the intent-unknown marker, never the word "unused"', () => {
  assert.match(HOOK_INTENT_CAVEAT, /intent unknown/i);
  assert.ok(/injected every session/i.test(HOOK_INTENT_CAVEAT));
  assert.doesNotMatch(HOOK_INTENT_CAVEAT, /unused/i, 'a no-dynamic-proof lever never says "unused"');
});

// ── buildLeverVerdicts: the floor + excludable policy (the AC), pure synthetic ─

test('hook: output ≥ floor → deny (emit removal); below floor → diagnostic-only', () => {
  const above = buildLeverVerdicts({ sessionId: 's', hookBytes: FLOOR + 1, claudeMd: [], systemBytes: 10_000 });
  assert.equal(above.hook.aboveFloor, true);
  assert.equal(above.hook.deny, true);

  const below = buildLeverVerdicts({ sessionId: 's', hookBytes: 100, claudeMd: [], systemBytes: 10_000 });
  assert.equal(below.hook.aboveFloor, false);
  assert.equal(below.hook.deny, false, 'below the floor → shown, not emitted');
});

test('hook: exactly at the floor emits (≥, not >)', () => {
  const at = buildLeverVerdicts({ sessionId: 's', hookBytes: FLOOR, claudeMd: [], systemBytes: 10_000 });
  assert.equal(at.hook.aboveFloor, true);
  assert.equal(at.hook.deny, true);
});

test('CLAUDE.md: an excludable (non-managed) source ≥ floor → suggest claudeMdExcludes', () => {
  const v = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 10_000,
    claudeMd: [{ source: './CLAUDE.md', bytes: FLOOR + 1 }],
  });
  assert.equal(v.claudeMd[0].excludable, true);
  assert.equal(v.claudeMd[0].deny, true);
});

test('CLAUDE.md: managed (no source path) → cost only, never claudeMdExcludes', () => {
  const v = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 10_000,
    claudeMd: [{ source: null, bytes: 9000 }], // large, but inexcludable
  });
  assert.equal(v.claudeMd[0].excludable, false, 'managed → inexcludable');
  assert.equal(v.claudeMd[0].deny, false, 'managed → no claudeMdExcludes, cost only');
});

test('CLAUDE.md: excludable but BELOW the floor → cost only (no claudeMdExcludes)', () => {
  const v = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 10_000,
    claudeMd: [{ source: './CLAUDE.md', bytes: 100 }],
  });
  assert.equal(v.claudeMd[0].excludable, true);
  assert.equal(v.claudeMd[0].deny, false, 'below floor → advice, not an exclude');
});

test('% of system is bytes / systemBytes, rounded; 0 (not NaN) when the context is empty', () => {
  const v = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 10_000,
    claudeMd: [{ source: './CLAUDE.md', bytes: 2500 }],
  });
  assert.equal(v.claudeMd[0].pct, 25);

  const empty = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 0,
    claudeMd: [{ source: './CLAUDE.md', bytes: 2500 }],
  });
  assert.equal(empty.claudeMd[0].pct, 0, 'no division by zero on an empty system context');
});

test('CLAUDE.md sources are sorted — named first, managed (null) last', () => {
  const v = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 0,
    systemBytes: 100_000,
    claudeMd: [
      { source: null, bytes: 5000 },
      { source: './CLAUDE.md', bytes: 5000 },
      { source: '~/.claude/CLAUDE.md', bytes: 5000 },
    ],
  });
  assert.deepEqual(
    v.claudeMd.map((c) => c.source),
    ['./CLAUDE.md', '~/.claude/CLAUDE.md', null],
  );
});

test('a session with neither lever yields empty verdicts (never emits)', () => {
  const v = buildLeverVerdicts({ sessionId: 's', hookBytes: 0, claudeMd: [], systemBytes: 100 });
  assert.equal(v.hook.deny, false);
  assert.deepEqual(v.claudeMd, []);
});

test('the floor is overridable and defaults to the waste.js bloatFloorBytes', () => {
  // Default floor = DEFAULT_WASTE_CONFIG.bloatFloorBytes (the one reused knob, spec §3.5).
  const atDefault = buildLeverVerdicts({ sessionId: 's', hookBytes: FLOOR, claudeMd: [], systemBytes: 10_000 });
  assert.equal(atDefault.hook.deny, true);
  // A run-specific override raises the bar.
  const raised = buildLeverVerdicts(
    { sessionId: 's', hookBytes: FLOOR, claudeMd: [], systemBytes: 10_000 },
    { floorBytes: FLOOR + 1 },
  );
  assert.equal(raised.hook.deny, false);
});

test('a lever that shipped NOTHING never emits, even at a floor of 0', () => {
  // Regression: `bytes >= floor` alone is satisfied by 0 >= 0, so a floor override
  // of 0 made a session with no hook output and a 0-byte source emit a removal for
  // a hook that was never seen — while the diagnostic said "no SessionStart hook
  // output seen". Nothing observed → nothing to emit, at every floor.
  const v = buildLeverVerdicts(
    { sessionId: 's', hookBytes: 0, systemBytes: 0, claudeMd: [{ source: './A.md', bytes: 0 }] },
    { floorBytes: 0 },
  );
  assert.equal(v.hook.deny, false, 'no hook output → no hooks.SessionStart removal');
  assert.equal(v.hook.aboveFloor, false);
  assert.equal(v.claudeMd[0].deny, false, 'a 0-byte source is never worth excluding');
});

test('a zero-floor run does not put a never-seen lever into the settings block', () => {
  const v = buildLeverVerdicts(
    { sessionId: 's', hookBytes: 0, systemBytes: 0, claudeMd: [{ source: './A.md', bytes: 0 }] },
    { floorBytes: 0 },
  );
  const { lines, settingsJson } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: { sessionCount: 0, servers: [], singleSession: true },
    levers: v,
  });
  const block = JSON.parse(settingsJson);
  assert.equal(block.hooks, undefined, 'no hook seen → no hooks key');
  assert.equal(block.claudeMdExcludes, undefined, 'no CLAUDE.md bytes → no excludes key');
  // The diagnostic and the block agree: both say nothing shipped.
  assert.ok(lines.some((l) => /^Hooks: \(no SessionStart hook output seen\)/.test(l)));
});

// ── scanRequestLeverBlocks: find the blocks wherever CC injects them ───────────

test('scanRequestLeverBlocks finds the hook + CLAUDE.md blocks in a USER message (the -p shape)', () => {
  const body = {
    system: [{ type: 'text', text: 'harness preamble' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nSessionStart:startup hook success: persona output here\n</system-reminder>' },
          {
            type: 'text',
            text: '<system-reminder>\nContents of ./CLAUDE.md (project instructions, checked into the codebase):\nproject memory\n</system-reminder>',
          },
          { type: 'text', text: 'do the thing' },
        ],
      },
    ],
  };
  const scan = scanRequestLeverBlocks(body);
  assert.ok(scan.hookBytes > 0, 'hook block found in a user message');
  assert.equal(scan.claudeMd.length, 1);
  assert.equal(scan.claudeMd[0].source, './CLAUDE.md');
  assert.ok(scan.claudeMd[0].bytes > 0);
  // systemBytes is the total of EVERY surface scanned (preamble + hook + claude + prompt).
  assert.ok(scan.systemBytes > scan.hookBytes + scan.claudeMd[0].bytes);
});

test('scanRequestLeverBlocks also finds levers injected into system[] (the omniris shape)', () => {
  const body = {
    system: [
      { type: 'text', text: 'preamble' },
      { type: 'text', text: '<system-reminder>\nSessionStart:startup hook success: x\n</system-reminder>' },
    ],
    messages: [],
  };
  assert.ok(scanRequestLeverBlocks(body).hookBytes > 0, 'hook in system[] is read');
});

test('scanRequestLeverBlocks is null-safe and reports nothing for a body with no levers', () => {
  assert.deepEqual(scanRequestLeverBlocks(null), { hookBytes: 0, claudeMd: [], systemBytes: 0 });
  const scan = scanRequestLeverBlocks({
    system: [{ type: 'text', text: 'preamble' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(scan.hookBytes, 0);
  assert.deepEqual(scan.claudeMd, []);
  assert.ok(scan.systemBytes > 0);
});

test('the "% of system" denominator excludes plain conversation history (only the static context counts)', () => {
  // system[] + a CLAUDE.md reminder are static system context; a huge assistant
  // reply and the bare first prompt are conversation, which grows turn over turn
  // and must NOT dilute the "% of system" a CLAUDE.md source is measured against.
  const body = {
    system: [{ type: 'text', text: 'system preamble ' + 'x'.repeat(2000) }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nContents of ./CLAUDE.md (project instructions):\nmemory\n</system-reminder>' },
          { type: 'text', text: 'do the thing' },
        ],
      },
      { role: 'assistant', content: 'a long conversation reply '.repeat(5000) },
    ],
  };
  const scan = scanRequestLeverBlocks(body);
  assert.ok(scan.systemBytes < 100_000, 'the huge conversation history is excluded from the system denominator');
  assert.equal(scan.claudeMd.length, 1);
  assert.ok(scan.systemBytes > scan.claudeMd[0].bytes, 'system[] + reminder still outweigh the one source');
});

test('scanRequestLeverBlocks attributes a global + project CLAUDE.md as two sources', () => {
  const body = {
    system: [],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Contents of ~/.claude/CLAUDE.md (user instructions):\nglobal\n' },
          { type: 'text', text: 'Contents of ./CLAUDE.md (project instructions):\nproj\n' },
        ],
      },
    ],
  };
  const sources = scanRequestLeverBlocks(body).claudeMd.map((c) => c.source).sort();
  assert.deepEqual(sources, ['./CLAUDE.md', '~/.claude/CLAUDE.md']);
});

// ── sessionLeverProfile: a session dir → lever sizes ──────────────────────────

/** A streamed assistant turn calling `names` (gzip, as captured). */
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

/** Write a captured session shipping a SessionStart hook output and CLAUDE.md sources. */
function writeLeverSession(root, id, { hookBody = '', claudeMd = [] }) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  /** @type {any[]} */
  const content = [];
  if (hookBody) {
    content.push({ type: 'text', text: `<system-reminder>\nSessionStart:startup hook success:\n${hookBody}\n</system-reminder>` });
  }
  for (const { path: p, body: b } of claudeMd) {
    content.push({
      type: 'text',
      text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\nContents of ${p} (project instructions, checked into the codebase):\n${b}\n</system-reminder>`,
    });
  }
  content.push({ type: 'text', text: 'do the thing' });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'system prompt' }], tools: [], messages: [{ role: 'user', content }] })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), turnCalling([]));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

test('sessionLeverProfile reads a session and reports hook + CLAUDE.md sizes', () => {
  const root = mkTmpDir();
  writeLeverSession(root, 's1', {
    hookBody: 'A'.repeat(5000),
    claudeMd: [{ path: './CLAUDE.md', body: 'B'.repeat(5000) }],
  });
  const profile = sessionLeverProfile(path.join(root, 'sessions', 's1'), 's1');
  assert.equal(profile.sessionId, 's1');
  assert.ok(profile.hookBytes >= 5000);
  assert.equal(profile.claudeMd.length, 1);
  assert.equal(profile.claudeMd[0].source, './CLAUDE.md');
  assert.ok(profile.claudeMd[0].bytes >= 5000);
  assert.ok(profile.systemBytes > profile.hookBytes, 'systemBytes is the whole scanned context');
});

test('sessionLeverProfile throws on a session dir with no manifest (a caller mistake)', () => {
  const dir = path.join(mkTmpDir(), 'nothing-here');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => sessionLeverProfile(dir), /could not read manifest\.jsonl/);
});

test('sessionLeverProfile degrades on a corrupt capture — a broken turn costs only itself', () => {
  // A half-written manifest line and a non-JSON body each contribute nothing; the
  // readable turn still reports its levers (mirrors FT2/FT4's posture).
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'torn');
  fs.mkdirSync(dir, { recursive: true });
  const good = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'x',
        system: [{ type: 'text', text: 'p' }],
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nSessionStart:startup hook success:\n' + 'Z'.repeat(5000) + '\n</system-reminder>' }] }],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), good);
  fs.writeFileSync(path.join(dir, '0003.request.http'), buildRequestBlob({ method: 'POST', url: '/v1/messages', rawHeaders: ['Content-Type', 'application/json'], body: Buffer.from('not json') }));
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    [
      JSON.stringify({ turn: 1, request_blob: '0001.request.http', response_blob: '0001.response.sse' }),
      '{"turn": 2, "request_blob": "000', // manifest cut mid-append
      JSON.stringify({ turn: 3, request_blob: '0003.request.http' }), // body is not JSON
      '',
    ].join('\n')
  );
  const profile = sessionLeverProfile(dir);
  assert.ok(profile.hookBytes >= 5000, 'the readable turn still reports its hook output');
});

// ── fineTune() end-to-end: the settings block + diagnostic ────────────────────

test('fineTune emits hooks.SessionStart + the intent-unknown caveat when the hook output ≥ floor', () => {
  const root = mkTmpDir();
  writeLeverSession(root, 'hook-sess', { hookBody: 'C'.repeat(6000) }); // ≥ floor, no CLAUDE.md
  const res = fineTune({ cwd: '/nonexistent', root, session: 'hook-sess' });
  const block = JSON.parse(res.settingsJson);
  assert.deepEqual(block.hooks, { SessionStart: [] }, 'a ≥floor hook emits the removal key');
  // The diagnostic carries the caveat on the hook line, and never says "unused".
  assert.ok(res.lines.some((l) => /hook/i.test(l) && /intent unknown/i.test(l)), 'caveat rides the hook line');
  assert.ok(!res.lines.some((l) => /unused/i.test(l)), 'no lever says "unused"');
});

test('fineTune emits claudeMdExcludes for an excludable CLAUDE.md source ≥ floor', () => {
  const root = mkTmpDir();
  writeLeverSession(root, 'md-sess', { claudeMd: [{ path: './CLAUDE.md', body: 'D'.repeat(6000) }] });
  const res = fineTune({ cwd: '/nonexistent', root, session: 'md-sess' });
  const block = JSON.parse(res.settingsJson);
  assert.deepEqual(block.claudeMdExcludes, ['./CLAUDE.md']);
  assert.equal(block.hooks, undefined, 'no hook → no hooks key');
});

test('fineTune below-floor hook is diagnostic-only (no hooks key, never unused)', () => {
  const root = mkTmpDir();
  writeLeverSession(root, 'tiny', { hookBody: 'tiny' }); // well below the 4096 floor
  const res = fineTune({ cwd: '/nonexistent', root, session: 'tiny' });
  const block = JSON.parse(res.settingsJson);
  assert.equal(block.hooks, undefined, 'below-floor hook is not emitted');
  // The diagnostic still shows the cost — but never claims "unused".
  assert.ok(res.lines.some((l) => /hook/i.test(l)));
  assert.ok(!res.lines.some((l) => /unused/i.test(l)));
});

// ── AC #1 — self-activating fixture gate over the committed FT0 capture ───────
//
// While no `session-*` fixture is committed this SKIPS. Today the FT0 fixture IS
// committed: its `messages[0]` carries a hook-persona block (the PERSONA sentinel,
// ≥ floor) and a project CLAUDE.md block (`Contents of …/CLAUDE.md`). So the hook
// lever must deny, and an excludable CLAUDE.md source above the floor must suggest
// claudeMdExcludes.

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
        'no fixture committed under test/fixtures/finetune/ — FT5 (issue #75) confirms the hook + CLAUDE.md ' +
        'levers against the real FT0 capture the instant it lands',
    }
  : {};

test('FT5 fixture: the hook-persona block is ≥ floor → hooks.SessionStart removal + caveat — AC #1', gateOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const v = buildLeverVerdicts(sessionLeverProfile(dir));
    assert.ok(v.hook.bytes > 0, `${id}: fixture must ship a SessionStart hook block`);
    assert.ok(v.hook.bytes >= FLOOR, `${id}: hook output ${v.hook.bytes} below the ${FLOOR}-byte floor`);
    assert.equal(v.hook.deny, true, `${id}: ≥floor hook must emit the removal`);

    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    assert.deepEqual(JSON.parse(res.settingsJson).hooks, { SessionStart: [] }, `${id}: block carries hooks.SessionStart`);
    assert.ok(
      res.lines.some((l) => /hook/i.test(l) && /intent unknown/i.test(l)),
      `${id}: the intent-unknown caveat rides the hook line`,
    );
    assert.ok(!res.lines.some((l) => /unused/i.test(l)), `${id}: the hook lever never says "unused"`);
  }
});

test('FT5 fixture: an excludable CLAUDE.md source ≥ floor suggests claudeMdExcludes — AC #2', gateOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const v = buildLeverVerdicts(sessionLeverProfile(dir));
    const excludableAbove = v.claudeMd.filter((c) => c.excludable && c.deny);
    assert.ok(excludableAbove.length >= 1, `${id}: no excludable CLAUDE.md source above the floor`);
    for (const c of excludableAbove) {
      assert.match(String(c.source), /CLAUDE\.md$/, `${id}: claudeMdExcludes targets a CLAUDE.md path`);
    }

    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    const excludes = JSON.parse(res.settingsJson).claudeMdExcludes ?? [];
    assert.ok(excludes.length >= 1, `${id}: block carries claudeMdExcludes`);
    assert.ok(excludes.every((p) => /CLAUDE\.md$/.test(p)), `${id}: every exclude is a CLAUDE.md path`);
    // No CLAUDE.md source is ever labelled "unused".
    assert.ok(!res.lines.some((l) => /unused/i.test(l)), `${id}: CLAUDE.md lever never says "unused"`);
  }
});
