// FT3 (issue #73) — split the `system` bucket by source.
//
// The fine-tune `system` bucket mixes four sources (fine-tune-spec §2.3): the
// CC harness, CLAUDE.md, a SessionStart-hook persona, and the MCP deferred
// listing. `src/finetune-system.js` attributes each `system` block to one of
// them so the downstream levers (T5/T6) can charge bytes to the right place and
// flag the harness as the incompressible floor (shown but never actionable).
//
// RGR posture. The classifier heuristics are derived from the bench's frozen
// sentinels — the on-wire proof each lever carries (bench/fixture/CLAUDE.md,
// hook-persona.txt, the L4 MCP stub tool `t00`) — plus the documented omniris
// CC v2.1.220 format (bench/SPEC.md §0). They are CONFIRMED the instant the FT0
// fixture lands: the self-activating gate at the bottom asserts each fixture
// `system` block maps to the correct lever (AC #1–#2). Until then it SELF-SKIPS
// (same wall FT0 hit — no claude.ai OAuth / api.anthropic.com in the sandbox),
// and these deterministic unit tests carry the classifier's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { segmentRequest } from '../src/waste.js';
import { parseRequestBlob } from '../src/report.js';
import {
  SYSTEM_LEVERS,
  classifySystemBlock,
  attributeSystemBlocks,
  filterFloor,
} from '../src/finetune-system.js';

// Bench-written lever sentinels — the on-wire fingerprint of each lever. The FT0
// fixture is produced THROUGH the bench (issue #70), so these exact sentinels
// ride every lever's content; scripts/bench/run.mjs + test/finetune-fixture.test.js
// assert the same markers.
const CLAUDEMD = 'CCSNOOP-BENCH-SENTINEL-CLAUDEMD-4f3a9c21';
const PERSONA = 'CCSNOOP-BENCH-SENTINEL-PERSONA-8b17e6d0';
const MCP_STUB_TOOL = 't00';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

/** @param {string} text */
const text = (text) => ({ type: 'text', text });

// ── lever vocabulary (AC #1) ──────────────────────────────────────────────────

test('SYSTEM_LEVERS is exactly the four system-bucket sources', () => {
  assert.deepEqual(SYSTEM_LEVERS, ['claude-md', 'hook', 'mcp-deferred', 'harness']);
});

// ── per-block classification — sentinel fidelity (AC #1) ──────────────────────

test('classifySystemBlock maps each bench sentinel to its lever', () => {
  assert.equal(classifySystemBlock(text(`project memory\nSENTINEL: ${CLAUDEMD}`)).lever, 'claude-md');
  assert.equal(classifySystemBlock(text(`hook persona\nSENTINEL: ${PERSONA}`)).lever, 'hook');
  assert.equal(
    classifySystemBlock(text(`available deferred tools: ${MCP_STUB_TOOL}, t01, t02`)).lever,
    'mcp-deferred',
  );
});

test('classifySystemBlock falls back to harness for anything unattributable (incl. the harness)', () => {
  // CC identity/capabilities preamble — no lever sentinel.
  const harness = classifySystemBlock(text('You are Claude Code, Anthropic’s CLI.\ntools are available.'));
  assert.equal(harness.lever, 'harness');
  assert.equal(harness.floor, true, 'harness is the incompressible floor');
});

test('a bare-string system block (unattributable) is the harness floor', () => {
  const r = classifySystemBlock('be concise and helpful');
  assert.equal(r.lever, 'harness');
  assert.equal(r.floor, true);
});

test('only the harness lever is flagged as the floor (the three actionable levers are not)', () => {
  for (const block of [
    text(`SENTINEL: ${CLAUDEMD}`),
    text(`SENTINEL: ${PERSONA}`),
    text(`deferred: ${MCP_STUB_TOOL}`),
  ]) {
    assert.equal(classifySystemBlock(block).floor, false);
  }
});

// ── content wins over order (AC: "content + order") ───────────────────────────

test('content decides the lever regardless of block position', () => {
  // A CLAUDE.md block sitting at index 0 (where the harness preamble often lives)
  // is still CLAUDE.md — order never overrides a content match.
  for (const index of [0, 1, 2, 9]) {
    assert.equal(classifySystemBlock(text(`memory\nSENTINEL: ${CLAUDEMD}`), { index }).lever, 'claude-md');
  }
});

// ── per-file source attribution (spec §2.3: "per source file where it supports it") ──

test('classifySystemBlock extracts a per-file source for CLAUDE.md when a path marker is present', () => {
  const withPath = classifySystemBlock(text(`<file path="./CLAUDE.md">\nSENTINEL: ${CLAUDEMD}\n…`));
  assert.equal(withPath.lever, 'claude-md');
  assert.equal(withPath.source, './CLAUDE.md');
});

test('without a path marker the CLAUDE.md block is attributed as a whole (source = null)', () => {
  const noPath = classifySystemBlock(text(`some memory\nSENTINEL: ${CLAUDEMD}`));
  assert.equal(noPath.lever, 'claude-md');
  assert.equal(noPath.source, null);
});

test('non-CLAUDE.md levers never carry a source', () => {
  assert.equal(classifySystemBlock(text(`SENTINEL: ${PERSONA}`)).source, null);
  assert.equal(classifySystemBlock(text(`deferred: ${MCP_STUB_TOOL}`)).source, null);
  assert.equal(classifySystemBlock(text('harness boilerplate')).source, null);
});

// ── real-capture marker refinement (CC v2.1.220 — the FT0 capture's format) ────
//
// The conservative markers above are sentinel-grounded for the bench. The real
// FT0 capture (now committed) injects a SessionStart hook as
// `SessionStart:startup hook success: …` inside a <system-reminder>, and a
// CLAUDE.md file as `Contents of <path> (<scope> instructions, …)`. FT3's module
// header promised these markers are refined against the capture the instant it
// lands — these tests pin that refinement (the hooks/CLAUDE.md levers, FT5/#75,
// rely on it to find their blocks without a bench sentinel).

test('classifySystemBlock maps a real SessionStart hook envelope to the hook lever', () => {
  // The on-wire shape CC v2.1.220 uses (no bench sentinel): the SessionStart hook
  // output rides a <system-reminder> with a `SessionStart:<event> hook success` line.
  const realHook = classifySystemBlock(
    text('<system-reminder>\nSessionStart:startup hook success: # my persona\n…output…\n</system-reminder>'),
  );
  assert.equal(realHook.lever, 'hook');
  assert.equal(realHook.floor, false);
});

test('classifySystemBlock maps a SessionStart hook ERROR envelope to the hook lever too', () => {
  // A failing hook surfaces as `SessionStart:startup hook error:` — still the hook
  // lever (its output is injected every session regardless of exit status).
  assert.equal(
    classifySystemBlock(text('<system-reminder>\nSessionStart:startup hook error: boom\n</system-reminder>')).lever,
    'hook',
  );
});

test('the real hook marker does not swallow a CLAUDE.md block that merely mentions SessionStart', () => {
  // A CLAUDE.md file that talks about hooks must still map to claude-md, not hook —
  // the marker keys on the hook-envelope shape, not the bare word.
  const block = classifySystemBlock(text(`Contents of ./CLAUDE.md (project instructions):\n# Notes\nWe use a SessionStart hook.\nSENTINEL: ${CLAUDEMD}`));
  assert.equal(block.lever, 'claude-md');
  assert.equal(block.source, './CLAUDE.md');
});

test('classifySystemBlock extracts the source path from the real `Contents of <path>` marker', () => {
  // The on-wire CLAUDE.md injection (CC v2.1.220): `Contents of <abs path> (<scope>
  // instructions, checked into the codebase):`. FT5's CLAUDE.md lever needs the path
  // to attribute cost per source file and to emit `claudeMdExcludes`.
  const real = classifySystemBlock(
    text(`As you answer the user's questions, you can use the following context:\nContents of /home/me/proj/CLAUDE.md (project instructions, checked into the codebase):\n# Project memory\nSENTINEL: ${CLAUDEMD}`),
  );
  assert.equal(real.lever, 'claude-md');
  assert.equal(real.source, '/home/me/proj/CLAUDE.md');
});

test('the Contents-of marker reads the scope (project / user / local) and a path with spaces', () => {
  assert.equal(
    classifySystemBlock(text(`Contents of ~/My Project/CLAUDE.md (user instructions):\nSENTINEL: ${CLAUDEMD}`)).source,
    '~/My Project/CLAUDE.md',
  );
});

test('without either path marker the CLAUDE.md block is still source = null', () => {
  // A managed/policy CLAUDE.md block with no file path stays unattributable — FT5
  // treats that as inexcludable (cost only, no claudeMdExcludes).
  const managed = classifySystemBlock(text(`policy memory\nSENTINEL: ${CLAUDEMD}`));
  assert.equal(managed.lever, 'claude-md');
  assert.equal(managed.source, null);
});

test('a real CLAUDE.md block with ONLY the Contents-of line (no bench sentinel) still maps to claude-md', () => {
  // A real capture carries no bench sentinel — the `Contents of <path> (<scope>
  // instructions)` line is what detects a CLAUDE.md block. Without it the FT5
  // lever would miss every real CLAUDE.md source.
  const real = classifySystemBlock(
    text('As you answer the user\'s questions, you can use the following context:\nContents of /home/me/proj/CLAUDE.md (project instructions, checked into the codebase):\n# Project memory'),
  );
  assert.equal(real.lever, 'claude-md');
  assert.equal(real.source, '/home/me/proj/CLAUDE.md');
});

// ── composition over a whole request body ─────────────────────────────────────

test('attributeSystemBlocks attributes every system block in order with byte-aligned slots', () => {
  const body = {
    system: [
      text('You are Claude Code (harness preamble).'),
      text(`<file path="./CLAUDE.md">\nSENTINEL: ${CLAUDEMD}`),
      text(`SessionStart hook output:\nSENTINEL: ${PERSONA}`),
      text(`Deferred tools: ${MCP_STUB_TOOL}, t01`),
    ],
  };
  const attribs = attributeSystemBlocks(body);
  assert.deepEqual(
    attribs.map((a) => a.slot),
    ['system#0', 'system#1', 'system#2', 'system#3'],
  );
  assert.deepEqual(
    attribs.map((a) => a.lever),
    ['harness', 'claude-md', 'hook', 'mcp-deferred'],
  );
  assert.deepEqual(attribs.map((a) => a.floor), [true, false, false, false]);

  // Bytes are byte-for-byte aligned with waste.js Segment.bytes for the same slot —
  // the future T6 diagnostic sums per lever without a second byte accounting.
  const segBytes = Object.fromEntries(
    segmentRequest(body).filter((s) => s.bucket === 'system').map((s) => [s.slot, s.bytes]),
  );
  for (const a of attribs) assert.equal(a.bytes, segBytes[a.slot]);
});

test('attributeSystemBlocks handles a bare-string system as one harness floor block', () => {
  const attribs = attributeSystemBlocks({ system: 'be brief' });
  assert.equal(attribs.length, 1);
  assert.equal(attribs[0].slot, 'system');
  assert.equal(attribs[0].lever, 'harness');
  assert.equal(attribs[0].floor, true);
});

test('attributeSystemBlocks is null-safe (no body / no system / non-array)', () => {
  assert.deepEqual(attributeSystemBlocks(null), []);
  assert.deepEqual(attributeSystemBlocks({}), []);
  assert.deepEqual(attributeSystemBlocks({ system: null }), []);
});

test('a cache_control marker on a block does not change its lever (text still drives it)', () => {
  const body = { system: [text(`SENTINEL: ${CLAUDEMD}`), { type: 'text', text: 'harness', cache_control: { type: 'ephemeral' } }] };
  const attribs = attributeSystemBlocks(body);
  assert.deepEqual(attribs.map((a) => a.lever), ['claude-md', 'harness']);
});

test('a null block inside the system array is a 0-byte harness floor, byte-aligned with waste.js', () => {
  // segmentRequest emits a segment per array entry (incl. null); attribution must
  // stay in lock-step so the per-lever sum equals the per-slot Segment.bytes sum.
  const body = { system: [null, text('x')] };
  const attribs = attributeSystemBlocks(body);
  assert.deepEqual(attribs.map((a) => a.slot), ['system#0', 'system#1']);
  assert.equal(attribs[0].lever, 'harness');
  assert.equal(attribs[0].floor, true);

  const segBytes = Object.fromEntries(
    segmentRequest(body).filter((s) => s.bucket === 'system').map((s) => [s.slot, s.bytes]),
  );
  for (const a of attribs) assert.equal(a.bytes, segBytes[a.slot]);
});

// ── AC #3 — the harness floor is never emitted downstream ─────────────────────

test('filterFloor drops the harness / unattributable blocks, keeps the actionable levers', () => {
  const body = {
    system: [text('harness preamble'), text(`SENTINEL: ${CLAUDEMD}`), text(`SENTINEL: ${PERSONA}`)],
  };
  const actionable = filterFloor(attributeSystemBlocks(body));
  assert.deepEqual(
    actionable.map((a) => a.lever),
    ['claude-md', 'hook'],
  );
  assert.ok(actionable.every((a) => !a.floor), 'nothing emitted is a floor block');
});

test('filterFloor returns [] when every system block is floor', () => {
  const body = { system: [text('harness a'), text('harness b')] };
  assert.deepEqual(filterFloor(attributeSystemBlocks(body)), []);
});

// ── AC #1–#2 — self-activating fixture gate (mirrors FT0) ─────────────────────
//
// While no `session-*` fixture is committed under test/fixtures/finetune/ this
// SELF-SKIPS: the lever→system-block mapping can only be trusted against the real
// CC injection format (issue #73 calls it the riskiest piece), and the FT0 fixture
// is itself escalated (issue #70 — no OAuth / api.anthropic.com in the sandbox).
// The moment a fixture lands, the gate activates and asserts every `system` block
// maps to the correct lever.

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
const fixtureGateOpts = dirs.length === 0
  ? {
      skip:
        'no fixture committed under test/fixtures/finetune/ — FT3 (issue #73) blocked by FT0 ' +
        '(issue #70): system-block lever mapping confirms against the real CC capture the instant it lands',
    }
  : {};

test('FT3 system-bucket lever mapping — AC #1–#2 (issue #73)', fixtureGateOpts, () => {
  for (const dir of dirs) {
    const id = path.basename(dir);
    const manifest = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8');
    const lines = manifest.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

    let floorSeen = false;

    for (const line of lines) {
      const req = parseRequestBlob(fs.readFileSync(path.join(dir, line.request_blob)));
      const attribs = attributeSystemBlocks(req.json);
      for (const a of attribs) {
        // Structural completeness — every system block maps to exactly one of the four levers.
        assert.ok(
          SYSTEM_LEVERS.includes(a.lever),
          `${id}/${line.request_blob}: system block ${a.slot} mapped to unknown lever '${a.lever}'`,
        );
        // Floor consistency — only the harness lever is the floor.
        assert.equal(a.floor, a.lever === 'harness', `${id}/${line.request_blob}: ${a.slot} floor flag mismatch`);
        if (a.floor) floorSeen = true;

        // Sentinel fidelity — a block carrying a known bench sentinel MUST map to its lever.
        // Re-derive this block's text from the body (not the attribution) to test sentinel→lever.
        const blockText = textOfBlockForSlot(req.json, a.slot);
        if (/CCSNOOP-BENCH-SENTINEL-CLAUDEMD-[0-9a-f]+/.test(blockText)) {
          assert.equal(a.lever, 'claude-md', `${id}: CLAUDE.md sentinel block mapped to '${a.lever}'`);
        }
        if (/CCSNOOP-BENCH-SENTINEL-PERSONA-[0-9a-f]+/.test(blockText)) {
          assert.equal(a.lever, 'hook', `${id}: persona sentinel block mapped to '${a.lever}'`);
        }
        if (/\bt00\b/.test(blockText)) {
          assert.equal(a.lever, 'mcp-deferred', `${id}: MCP stub tool 't00' block mapped to '${a.lever}'`);
        }
      }
    }

    // The harness floor must be present and flagged (AC #3 precondition: shown but not actionable).
    assert.ok(floorSeen, `${id}: no harness/floor system block found (AC #3 expects the floor to be shown)`);
  }
});

/** Extract the text of the system block at a slot, mirroring report.js contentForSlot. */
function textOfBlockForSlot(body, slot) {
  if (!body) return '';
  // Bare-string `system` (slot 'system') — checked first, exactly like contentForSlot.
  if (slot === 'system') return typeof body.system === 'string' ? body.system : '';
  if (!Array.isArray(body.system)) return '';
  const m = slot.match(/^system#(\d+)$/);
  if (!m) return '';
  const block = body.system[Number(m[1])];
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}
