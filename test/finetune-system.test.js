// FT3 (issue #73) — split the `system` bucket by source.
//
// The fine-tune `system` bucket mixes seven sources (fine-tune-spec §2.3): the
// CC harness, CLAUDE.md, a SessionStart-hook persona, the MCP connecting-servers
// sub-list, and the three catalogs Claude Code injects (deferred tools, agent
// types, skills). `src/finetune-system.js` attributes each block to one of them —
// carving a block that carries several into spans that tile it — so the downstream
// levers (T5/T6) can charge bytes to the right place and flag the harness as the
// incompressible floor (shown but never actionable).
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
  CATALOG_LEVERS,
  classifySystemBlock,
  classifySystemSpans,
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

test('SYSTEM_LEVERS is exactly the seven system-bucket sources', () => {
  // #116 / ADR-0005: the three catalog populations `floor` already named (#109/#113) are
  // levers of the shared model too, so `fine-tune` sees what `floor` sees.
  assert.deepEqual(SYSTEM_LEVERS, [
    'claude-md',
    'hook',
    'mcp-deferred',
    'deferred-tools',
    'skills-catalog',
    'agent-types',
    'harness',
  ]);
});

test('CATALOG_LEVERS is the carvable subset, in the order a block presents them', () => {
  assert.deepEqual(CATALOG_LEVERS, ['deferred-tools', 'agent-types', 'skills-catalog']);
  for (const l of CATALOG_LEVERS) assert.ok(SYSTEM_LEVERS.includes(l), `${l} is a system lever`);
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

// ── the catalog levers, and `mcp-deferred` narrowed (issue #116, ADR-0005) ────
//
// Before #116 there were TWO detections of the same blocks: this module's, which swept
// every block saying "deferred tool" into `mcp-deferred`, and `floor-catalog.js`'s, which
// already told the three catalog populations apart but deliberately stayed a pure
// consumer. The layering inverts here: header detection lives in ONE authority, and
// `mcp-deferred` shrinks to what it actually names — the connecting-servers sub-list.
// The practical consequence: a repo with no MCP server reports zero `mcp-deferred` bytes.

/**
 * The real Claude Code header lines — the opening of each catalog as the committed FT0
 * capture spells it, truncated to what the classifier anchors on. The full-sentence
 * spelling is asserted against the capture itself by the fixture gate at the bottom, so
 * these constants stay readable without the fixture's exact tail becoming load-bearing.
 */
const DEFERRED_HDR =
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError.';
const AGENTS_HDR = 'Available agent types for the Agent tool:';
const SKILLS_HDR = 'The following skills are available for use with the Skill tool:';
const CONNECTING_HDR =
  'The following MCP servers are still connecting — their tools (typically named mcp__<server>__*) are not yet available but will appear shortly:';

/** A `<system-reminder>`-wrapped block, the envelope CC ships these catalogs in. */
const reminder = (body) => text(`<system-reminder>\n${body}</system-reminder>`);

/** The deferred-tools listing of a repo with NO MCP server: no connecting sub-list at all. */
const NO_MCP_DEFERRED = `${DEFERRED_HDR}\nWebFetch\nWebSearch\nMonitor\n`;

test('each catalog header maps the block to its own lever, not to the mcp-deferred catch-all', () => {
  assert.equal(classifySystemBlock(reminder(NO_MCP_DEFERRED)).lever, 'deferred-tools');
  assert.equal(classifySystemBlock(reminder(`${AGENTS_HDR}\n- Explore: Read-only search agent.\n`)).lever, 'agent-types');
  assert.equal(classifySystemBlock(reminder(`${SKILLS_HDR}\n\n- tdd: Red-green-refactor.\n`)).lever, 'skills-catalog');
});

test('none of the catalog levers is the incompressible floor', () => {
  for (const body of [NO_MCP_DEFERRED, `${AGENTS_HDR}\n- Explore: x\n`, `${SKILLS_HDR}\n- tdd: y\n`]) {
    assert.equal(classifySystemBlock(reminder(body)).floor, false);
    assert.equal(classifySystemBlock(reminder(body)).source, null, 'only CLAUDE.md carries a source');
  }
});

test('a repo with no MCP server produces NO mcp-deferred span — the catch-all label is dead', () => {
  // The exit criterion of issue #116, at the classifier: the deferred-tools listing of a
  // repo without a single MCP server used to be charged 100 % to `mcp-deferred`, sending
  // the reader hunting a server that was never configured.
  const spans = classifySystemSpans(reminder(NO_MCP_DEFERRED));
  assert.deepEqual(spans.map((s) => s.lever), ['deferred-tools']);
});

test('mcp-deferred is the connecting-servers sub-list, and it is carved OUT of the listing', () => {
  // The sub-list rides INSIDE the deferred-tools block on the wire (the committed FT0
  // capture). One authority, two spans: the tool names are the catalog, the servers are MCP.
  const spans = classifySystemSpans(reminder(`${NO_MCP_DEFERRED}\n${CONNECTING_HDR}\nstub\n`));
  assert.deepEqual(spans.map((s) => s.lever), ['deferred-tools', 'mcp-deferred']);
  assert.match(spans[1].text, /^The following MCP servers are still connecting/);
  assert.ok(!/WebFetch/.test(spans[1].text), 'the tool names stay with the catalog');
});

test('a block that is ONLY the connecting-servers listing is one mcp-deferred span', () => {
  const spans = classifySystemSpans(reminder(`${CONNECTING_HDR}\nstub\n`));
  assert.deepEqual(spans.map((s) => s.lever), ['mcp-deferred']);
  assert.equal(spans[0].floor, false);
});

test('an on-wire mcp__<server>__<tool> deferred name still reads as mcp-deferred', () => {
  // A build wording its headers differently must not silently drop ~30 KB: the real
  // on-wire MCP tool spelling (`mcp__stub__t00`, fixtures README) is the fallback marker.
  assert.equal(classifySystemBlock(text('deferred tools: mcp__stub__t00 listing')).lever, 'mcp-deferred');
});

test('a block naming no lever at all is the harness floor, even if it says "deferred tools"', () => {
  // The old catch-all `/deferred\s+(?:tool|mcp)/` swept prose into the MCP lever. Prose
  // that merely uses the words — with no catalog header, no connecting sub-list and no
  // `mcp__` name — is unattributable, hence floor.
  const v = classifySystemBlock(text('Some deferred tools may be unavailable in this environment.'));
  assert.equal(v.lever, 'harness');
  assert.equal(v.floor, true);
});

// ── span carving: the two capture shapes floor-catalog.js already handles ──────

test('classifySystemSpans carves a COMBINED block into one span per population', () => {
  const spans = classifySystemSpans(
    reminder(`${NO_MCP_DEFERRED}\n${AGENTS_HDR}\n- Explore: x\n\n${SKILLS_HDR}\n- tdd: y\n`),
  );
  assert.deepEqual(spans.map((s) => s.lever), ['deferred-tools', 'agent-types', 'skills-catalog']);
});

test('the spans of a block TILE it exactly — carving never invents or loses bytes', () => {
  // The invariant `floor-catalog.js` held and this module inherits: Σ span bytes is the
  // block's own canonical byte length, so splitting a row can never charge bytes the
  // gain model did not. Checked on both capture shapes and on a plain (uncarved) block.
  const blocks = [
    reminder(`${NO_MCP_DEFERRED}\n${AGENTS_HDR}\n- Explore: x\n\n${SKILLS_HDR}\n- tdd: y\n`),
    reminder(`${NO_MCP_DEFERRED}\n${CONNECTING_HDR}\nstub\n`),
    reminder(NO_MCP_DEFERRED),
    text('You are Claude Code, Anthropic’s CLI.'),
  ];
  for (const block of blocks) {
    const spans = classifySystemSpans(block);
    const [seg] = segmentRequest({ system: [block] }).filter((s) => s.bucket === 'system');
    assert.equal(
      spans.reduce((s, x) => s + x.bytes, 0),
      seg.bytes,
      `spans tile the block: ${JSON.stringify(spans.map((s) => s.lever))}`,
    );
    assert.equal(spans.map((s) => s.text).join(''), blockTextOf(block), 'and the texts tile it too');
  }
});

test('a cache_control marker rides the first span, so tiling still holds', () => {
  // A real capture puts `cache_control` on its big system blocks. It is not text, so no
  // span's own escaped length can account for it: the HEAD span absorbs it, which keeps
  // Σ spans equal to the whole-block figure this module reports for the same block.
  const block = { type: 'text', text: `<system-reminder>\n${NO_MCP_DEFERRED}\n${SKILLS_HDR}\n- tdd: y\n</system-reminder>`, cache_control: { type: 'ephemeral' } };
  const spans = classifySystemSpans(block);
  assert.ok(spans.length > 1, 'the block really is carved');
  const [whole] = attributeSystemBlocks({ system: [block] });
  assert.equal(spans.reduce((s, x) => s + x.bytes, 0), whole.bytes);
});

test('classifySystemBlock reports the FIRST span — the block\'s dominant population', () => {
  const combined = reminder(`${NO_MCP_DEFERRED}\n${AGENTS_HDR}\n- Explore: x\n`);
  assert.equal(classifySystemBlock(combined).lever, classifySystemSpans(combined)[0].lever);
});

test('CLAUDE.md and hook markers still win over a catalog header they merely quote', () => {
  // A memory file documenting the catalogs must not become one. The two levers that
  // carry a real source/action are tested BEFORE the catalog headers.
  const md = classifySystemBlock(
    text(`Contents of ./CLAUDE.md (project instructions):\n${SKILLS_HDR}\n- tdd: we use it\nSENTINEL: ${CLAUDEMD}`),
  );
  assert.equal(md.lever, 'claude-md');
  assert.equal(md.source, './CLAUDE.md');
  assert.equal(
    classifySystemBlock(text(`<system-reminder>\nSessionStart:startup hook success: ${AGENTS_HDR}\n</system-reminder>`)).lever,
    'hook',
  );
});

/** The text payload of a block, mirroring the module's own `blockText`. */
function blockTextOf(block) {
  return typeof block === 'string' ? block : (block && block.text) || '';
}

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

test('the Contents-of path never spans a newline — prose is not spliced into the path', () => {
  // Regression: the path group used to match across lines, so a memory file whose
  // body happened to mention "(project instructions)" on a LATER line produced a
  // multi-line path — which the FT5 CLAUDE.md lever pastes verbatim into
  // `claudeMdExcludes`, yielding a settings.json with a bogus exclude. A real
  // injection keeps path + scope on one line; anything else is unattributable.
  const spliced = classifySystemBlock(
    text(`Contents of ./notes.md\nSee the docs (project instructions) for details.\nSENTINEL: ${CLAUDEMD}`),
  );
  assert.equal(spliced.lever, 'claude-md');
  assert.equal(spliced.source, null, 'no single-line marker → managed, cost only');
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
        // Structural completeness — every system block maps to exactly one of the levers.
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

test('FT3 — the catalog levers on the REAL capture (issue #116)', fixtureGateOpts, () => {
  // The catalogs ride `messages[0].content`, not `system[]`, so the gate above never sees
  // them. This one walks the message surface and pins what #116 changed on real bytes:
  // the deferred listing carves into the built-in names and the connecting-servers
  // sub-list, and the two catalogs that used to be invisible name themselves.
  for (const dir of dirs) {
    const id = path.basename(dir);
    const lines = fs
      .readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const req = parseRequestBlob(fs.readFileSync(path.join(dir, lines[0].request_blob)));
    const blocks = (req.json?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]));
    const spans = blocks.flatMap((b) => classifySystemSpans(b));
    const byLever = new Map();
    for (const s of spans) byLever.set(s.lever, (byLever.get(s.lever) ?? 0) + s.bytes);

    for (const lever of CATALOG_LEVERS) {
      assert.ok((byLever.get(lever) ?? 0) > 0, `${id}: no bytes attributed to ${lever} on the real capture`);
    }
    // This fixture DOES have a connecting MCP server (`stub`, turns 1–2), so the narrowed
    // lever is non-empty here — and strictly smaller than the listing it was carved from.
    assert.ok((byLever.get('mcp-deferred') ?? 0) > 0, `${id}: the stub server's sub-list should charge the MCP lever`);
    assert.ok(
      byLever.get('mcp-deferred') < byLever.get('deferred-tools') + byLever.get('mcp-deferred'),
      `${id}: mcp-deferred is a PART of the listing, not the whole of it`,
    );
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
