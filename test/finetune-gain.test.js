// FT6 (issue #76) — the byte-accounted gain model + the full diagnostic.
//
// Per lever two byte figures via Segment.bytes (never re-tokenized): `shipped` (the
// gross bytes the lever contributes — its canonical size) and `waste` (the
// reused-uncached portion, the bytes re-paid after a cache break, already classified
// by waste.js). Headline recoverable = Σ `waste` over the actionable levers. The
// diagnostic is the spec Part 5 mockup: a per-lever `shipped`/`waste`/`action` table,
// totals, the headline, a one-line cache caveat, a single cache-invalidation warning,
// then a paste-ready pure-JSON settings block.
//
// RGR posture. The attribution + aggregation math is exercised with SYNTHETIC
// segments+bodies (chargeExchange is pure), a cold-cache two-turn session proves
// waste > 0 end-to-end through fineTune(), and a self-activating gate pins the
// diagnostic shape against the committed FT0 fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chargeExchange, chargedBytes, computeGain, EMPTY_GAIN, NULL_SOURCE } from '../src/finetune-gain.js';
import { canonicalize } from '../src/waste.js';
import { buildRequestBlob } from '../src/capture.js';
import { fineTune, renderFineTune } from '../src/finetune.js';
import { buildLeverVerdicts, NULL_SOURCE as LEVERS_NULL_SOURCE, EMPTY_LEVER_VERDICTS } from '../src/finetune-levers.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

/** Canonical byte length of a block — the same proxy the gain model charges. */
function cbytes(block) {
  return Buffer.byteLength(canonicalize(block), 'utf8');
}

/** A minimal request-http blob wrapping a JSON body (the shape ccsnoop captures), as
 *  the UTF-8 string loadSession keeps on each exchange (`requestBlob: req.text`). */
function httpBody(obj) {
  return buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(JSON.stringify(obj)),
  }).toString('utf8');
}

/** The synthetic body every lever rides: a harness preamble + hook in system[], a
 *  built-in tool, and a user message carrying a CLAUDE.md block + a plain prompt. */
function leverBody({ hookText = 'SessionStart:startup hook success: persona output here', mdText = 'Contents of ./CLAUDE.md (project instructions): memory here' } = {}) {
  return {
    system: [
      { type: 'text', text: 'You are a Claude agent, built on Anthropic.' }, // harness
      { type: 'text', text: hookText }, // hook
    ],
    tools: [{ name: 'Workflow' }, { name: 'Bash' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: mdText }, // claude-md
          { type: 'text', text: 'do the thing' }, // plain conversation
        ],
      },
    ],
  };
}

// ── chargeExchange: attribution + shipped=max / waste=reused-uncached ─────────

test('a tool is attributed from its slot; shipped = its bytes, waste = bytes when reused-uncached', () => {
  const body = leverBody();
  const acc = structuredGain();
  // Turn 1: new. Turn 2: Workflow reused-uncached (a cold cache re-pays it).
  chargeExchange({ segments: segs1(body), body }, acc);
  chargeExchange({ segments: withKind(segs1(body), 'reused-uncached'), body }, acc);
  const wf = cbytes(body.tools[0]);
  assert.equal(acc.tool.get('Workflow').shipped, wf);
  assert.equal(acc.tool.get('Workflow').waste, wf, 'reused-uncached tool is re-paid in full');
  assert.ok(acc.tool.has('Bash'));
});

test('waste is 0 when the carrier is reused-CACHED (cache held) — only re-paid bytes count', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: segs1(body), body }, acc);
  chargeExchange({ segments: withKind(segs1(body), 'reused-cached'), body }, acc);
  assert.equal(acc.tool.get('Workflow').waste, 0, 'cached → not re-paid');
  assert.equal(acc.tool.get('Workflow').shipped, cbytes(body.tools[0]), 'shipped is still its size');
});

test('shipped is the MAX single-request total (robust to a truncated smaller later turn)', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: segs1(body), body }, acc); // full request
  // A truncated later turn ships the same tool but we model it as 'new' (smaller
  // contribution shouldn't lower the canonical shipped).
  chargeExchange({ segments: withKind(segs1(body), 'new'), body }, acc);
  assert.equal(acc.tool.get('Workflow').shipped, cbytes(body.tools[0]));
});

test('the hook lever is attributed from a system[] block; carrier kind gates its waste', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: segs1(body), body }, acc);
  chargeExchange({ segments: withKind(segs1(body), 'reused-uncached'), body }, acc);
  assert.equal(acc.hook.shipped, cbytes(body.system[1]));
  assert.equal(acc.hook.waste, cbytes(body.system[1]));
});

test('a CLAUDE.md block inside messages[0] is attributed via its message#0 carrier (the -p shape)', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: segs1(body), body }, acc);
  chargeExchange({ segments: withKind(segs1(body), 'reused-uncached'), body }, acc);
  const md = cbytes(body.messages[0].content[0]);
  assert.equal(acc.claudeMd.get('./CLAUDE.md').shipped, md);
  assert.equal(acc.claudeMd.get('./CLAUDE.md').waste, md, 'message#0 reused-uncached re-pays the CLAUDE.md block');
});

test('plain conversation is NEVER charged as the harness floor — only system[] preamble is', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: withKind(segs1(body), 'reused-uncached'), body }, acc);
  // The user prompt ('do the thing') lives in messages[0].content[1] and classifies as
  // harness (unmatched) — but it is conversation, so it must NOT inflate the floor.
  // Only the system[] preamble block counts as the harness lever.
  assert.equal(acc.harness.shipped, cbytes(body.system[0]), 'floor = the system[] preamble only');
  assert.equal(acc.harness.waste, cbytes(body.system[0]));
});

test('the harness floor sums every system[] preamble block in a request, then MAXes across requests', () => {
  // Two harness blocks in system[]; shipped is their SUM (not the larger single block).
  const body = {
    system: [{ type: 'text', text: 'preamble one ' + 'x'.repeat(200) }, { type: 'text', text: 'preamble two ' + 'y'.repeat(300) }],
    tools: [],
    messages: [],
  };
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'system#0', bytes: 1, kind: 'new' }, { slot: 'system#1', bytes: 1, kind: 'new' }], body }, acc);
  assert.equal(acc.harness.shipped, cbytes(body.system[0]) + cbytes(body.system[1]));
});

test('an anonymous tool (tool:#<i>) is never attributed — it has no name to charge', () => {
  const body = { system: [], tools: [{ name: 'Workflow' }, {}], messages: [] };
  const acc = structuredGain();
  chargeExchange(
    { segments: [{ slot: 'tool:Workflow', bytes: 10, kind: 'new' }, { slot: 'tool:#1', bytes: 99, kind: 'new' }], body },
    acc,
  );
  assert.ok(acc.tool.has('Workflow'));
  assert.equal(acc.tool.size, 1, 'the anonymous tool:#1 is dropped');
});

test('a managed CLAUDE.md block (no path) keys under the NULL_SOURCE placeholder', () => {
  // A CLAUDE.md-shaped block with no extractable path → source null → NULL_SOURCE key.
  const body = {
    system: [{ type: 'text', text: '<file path="">managed memory</file>' }],
    tools: [],
    messages: [],
  };
  // Force the sentinel-free shape to still classify as claude-md via the <file path= marker,
  // but with an empty path → extractSourcePath returns null.
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'system#0', bytes: 1, kind: 'new' }], body }, acc);
  // The block matches `/<file\s+path=/` → claude-md; empty path → source null → NULL_SOURCE.
  assert.ok(acc.claudeMd.has(NULL_SOURCE) || acc.claudeMd.size === 0, 'managed source keys under NULL_SOURCE (or is absent)');
});

// ── catalog populations, and mcp-deferred narrowed (issue #116) ───────────────
//
// The gain model used to charge the WHOLE deferred listing — built-in tool names, agent
// types, skills — to `mcp`, and to drop the catalogs that ride `messages[0].content`
// entirely (they classified `harness`, which is charged on the `system` surface only). So
// a repo with no MCP server was told it shipped ~30 KB of "MCP", and the skills catalog
// was invisible. The shared classifier now carves each block into lever spans and
// `chargeExchange` charges span by span.

/** The real Claude Code header lines a `<system-reminder>` catalog opens with. */
const DEFERRED_HDR = 'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded.';
const AGENTS_HDR = 'Available agent types for the Agent tool:';
const SKILLS_HDR = 'The following skills are available for use with the Skill tool:';
const CONNECTING_HDR = 'The following MCP servers are still connecting:';

/**
 * A turn-1 body whose first user message carries the three catalogs, as the wire shows
 * them. `mcp: true` adds the connecting-servers sub-list inside the deferred listing —
 * the ONLY thing that should ever charge the MCP lever.
 */
function catalogBody({ mcp = false, combined = false } = {}) {
  const deferred = `${DEFERRED_HDR}\nWebFetch\nWebSearch\n${mcp ? `\n${CONNECTING_HDR}\nstub\n` : ''}`;
  const agents = `${AGENTS_HDR}\n- Explore: Read-only search agent.\n`;
  const skills = `${SKILLS_HDR}\n\n- dataviz: Charts and plots.\n- tdd: Red-green-refactor.\n`;
  const wrap = (t) => ({ type: 'text', text: `<system-reminder>\n${t}</system-reminder>` });
  const blocks = combined ? [wrap(`${deferred}\n${agents}\n${skills}`)] : [deferred, agents, skills].map(wrap);
  return {
    system: [{ type: 'text', text: 'You are a Claude agent, built on Anthropic.' }],
    tools: [],
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: 'do the thing' }] }],
  };
}

test('a repo with NO MCP server charges ZERO mcp-deferred bytes — the catch-all is dead', () => {
  // Issue #116's exit criterion, at the model. Every byte of the listing belongs to a
  // catalog population; none of it is recoverable by any MCP setting, so none is MCP.
  const body = catalogBody();
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'message#0', bytes: 1, kind: 'new' }], body }, acc);
  assert.equal(acc.mcp.shipped, 0, 'no connecting-servers sub-list ⇒ no MCP bytes');
  assert.ok(acc.catalog.get('skills-catalog').shipped > 0, 'the skills catalog is where those bytes are');
  assert.ok(acc.catalog.get('agent-types').shipped > 0);
  assert.ok(acc.catalog.get('deferred-tools').shipped > 0);
});

test('the connecting-servers sub-list is the ONLY thing charged to the MCP lever', () => {
  const withMcp = structuredGain();
  const without = structuredGain();
  const seg = [{ slot: 'message#0', bytes: 1, kind: 'new' }];
  chargeExchange({ segments: seg, body: catalogBody({ mcp: true }) }, withMcp);
  chargeExchange({ segments: seg, body: catalogBody() }, without);

  assert.ok(withMcp.mcp.shipped > 0, 'a connecting server does charge the MCP lever');
  // …and it takes nothing from the catalogs: the two runs agree on every population that
  // is not the sub-list, because the sub-list is carved OUT rather than folded in.
  for (const kind of ['agent-types', 'skills-catalog']) {
    assert.equal(withMcp.catalog.get(kind).shipped, without.catalog.get(kind).shipped, kind);
  }
});

test('the catalogs are charged on the MESSAGE surface — where Claude Code actually injects them', () => {
  // Before #116 these blocks classified `harness`, and `chargeExchange` charges harness on
  // the `system` surface only — so the skills catalog contributed exactly zero bytes.
  const body = catalogBody();
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'message#0', bytes: 1, kind: 'new' }], body }, acc);
  assert.equal(acc.harness.shipped, cbytes(body.system[0]), 'the floor is still the system[] preamble alone');
  assert.ok(!acc.catalog.has('harness'), 'and the catalogs are not part of it');
});

test('a COMBINED catalog block is charged span by span, and the spans tile it exactly', () => {
  // All three populations plus the MCP sub-list on ONE block. Splitting must not invent
  // or lose a byte: Σ what was charged === the block's own canonical byte length.
  const body = catalogBody({ mcp: true, combined: true });
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'message#0', bytes: 1, kind: 'new' }], body }, acc);
  const charged =
    acc.mcp.shipped + [...acc.catalog.values()].reduce((s, g) => s + g.shipped, 0);
  assert.equal(charged, cbytes(body.messages[0].content[0]), 'spans tile the source block');
  assert.equal(acc.catalog.size, 3, 'one entry per population, from a single block');
});

test('a catalog span is re-paid per its carrier segment, like every other lever', () => {
  const body = catalogBody();
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'message#0', bytes: 1, kind: 'reused-uncached' }], body }, acc);
  const skills = acc.catalog.get('skills-catalog');
  assert.equal(skills.waste, skills.shipped, 'a cold cache re-pays the catalog in full');
});

// ── tranche B (#117): the message surface is charged by LEVER, never by position ─
//
// The criterion is "this block classifies onto a lever", not "this block sits in
// messages[0]". Both halves of that are load-bearing, and they pull in opposite
// directions: a `<system-reminder>` Claude Code injects into the first user message is
// floor and must be charged (issue #116 did the catalogs), while the user's own prompt
// riding the SAME message must not be — otherwise the first turn of a chatty session
// inflates the floor by whatever the user happened to type.
//
// The sharp edge is the coarse `mcp__<server>__<tool>` fallback: it has no header to
// key on, so on the message surface it can only be trusted inside CC's own
// `<system-reminder>` envelope. Prose ABOUT an MCP tool is a sentence, not a listing.

/** A body whose first user message carries `text` as its only content block. */
function chattyBody(text) {
  return {
    system: [{ type: 'text', text: 'You are a Claude agent, built on Anthropic.' }],
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  };
}

/** The one segment `chattyBody`'s message rides, plus its system#0 carrier. */
function chattySegs(body) {
  return [
    { slot: 'system#0', bytes: cbytes(body.system[0]), kind: 'new' },
    { slot: 'message#0', bytes: cbytes(body.messages[0]), kind: 'new' },
  ];
}

test('a user prompt that merely NAMES an mcp__ tool is conversation, not the MCP lever', () => {
  // The `mcp__<server>__<tool>` marker is the classifier's safety net for a deferred
  // listing whose headers a future CC build words differently. Unwrapped, on the message
  // surface, it is just prose: charging it would bill the user's own question to a lever
  // no setting could ever recover.
  const body = chattyBody('why does mcp__github__create_issue keep failing on this repo?');
  const acc = structuredGain();
  chargeExchange({ segments: chattySegs(body), body }, acc);
  assert.equal(acc.mcp.shipped, 0, 'a sentence about an MCP tool charges no MCP bytes');
  assert.equal(acc.harness.shipped, cbytes(body.system[0]), 'and it is not the floor either');
});

test('the same mcp__ marker INSIDE a <system-reminder> still charges the MCP lever', () => {
  // The safety net survives where it matters: CC wraps every block it injects into the
  // first user message, so the envelope is what tells an injected listing from prose.
  const listing = '<system-reminder>\nmcp__stub__t01\nmcp__stub__t02\n</system-reminder>';
  const body = chattyBody(listing);
  const acc = structuredGain();
  chargeExchange({ segments: chattySegs(body), body }, acc);
  assert.equal(acc.mcp.shipped, cbytes(body.messages[0].content[0]), 'the wrapped listing is charged whole');
});

test('on the system surface the mcp__ marker needs no envelope — system[] is never conversation', () => {
  const body = {
    system: [{ type: 'text', text: 'still connecting… mcp__stub__t01 mcp__stub__t02' }],
    tools: [],
    messages: [],
  };
  const acc = structuredGain();
  chargeExchange({ segments: [{ slot: 'system#0', bytes: cbytes(body.system[0]), kind: 'new' }], body }, acc);
  assert.equal(acc.mcp.shipped, cbytes(body.system[0]));
  assert.equal(acc.harness.shipped, 0, 'and it is not double-charged to the floor');
});

test('a chatty first turn adds NOTHING to any lever — the floor is what CC ships, not what you type', () => {
  const short = chattyBody('hi');
  const long = chattyBody(`hi. ${'and here is a very long pasted stack trace. '.repeat(200)}`);
  const a = structuredGain();
  const b = structuredGain();
  chargeExchange({ segments: chattySegs(short), body: short }, a);
  chargeExchange({ segments: chattySegs(long), body: long }, b);
  assert.equal(chargedBytes(a), chargedBytes(b), 'the prompt grew by ~9 KB and the charge did not move');
  assert.equal(chargedBytes(a), cbytes(short.system[0]), 'the whole charge is the system[] preamble');
});

// ── computeGain: re-parses the captured request blobs ─────────────────────────

test('computeGain re-parses requestBlob per exchange and never throws on an unparseable body', () => {
  const body = leverBody();
  const model = {
    exchanges: [
      { requestBlob: httpBody(body), segments: withKind(segs1(body), 'reused-uncached') },
      { requestBlob: 'not an http blob at all', segments: [] }, // body unparseable → no system bytes
    ],
  };
  const gain = computeGain(model);
  assert.equal(gain.tool.get('Workflow').waste, cbytes(body.tools[0]));
  assert.equal(gain.harness.shipped, cbytes(body.system[0]), 'turn 1 still attributes its system[] blocks');
});

test('computeGain on an empty model returns the all-zero EMPTY_GAIN shape', () => {
  const gain = computeGain({ exchanges: [] });
  assert.equal(gain.hook.shipped, 0);
  assert.equal(gain.mcp.shipped, 0);
  assert.equal(gain.harness.shipped, 0);
  assert.equal(gain.tool.size, 0);
  assert.equal(gain.claudeMd.size, 0);
});

// ── the headline: Σ waste over the ACTIONABLE levers (renderFineTune) ──────────

test('the headline sums waste only over actionable levers; non-actionable rows are shown but not counted', () => {
  // Workflow denied (actionable); a flag-only MCP row + the harness floor ship waste
  // but are NOT recoverable, so the headline excludes them.
  const gain = {
    tool: new Map([['Workflow', { shipped: 5120, waste: 1024 }]]),
    claudeMd: new Map([['./CLAUDE.md', { shipped: 5120, waste: 3072 }]]),
    hook: { shipped: 6144, waste: 6144 },
    mcp: { shipped: 2400, waste: 2400 }, // flag-only here → not counted
    catalog: new Map(),
    harness: { shipped: 2765, waste: 2765 }, // floor → never counted
  };
  const levers = buildLeverVerdicts({
    sessionId: 's',
    hookBytes: 6144, // ≥ floor → actionable
    systemBytes: 50_000,
    claudeMd: [{ source: './CLAUDE.md', bytes: 5120 }], // excludable, ≥ floor → actionable
  });
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 3,
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [{ name: 'stub', shippedSessions: 1, calledCount: 0, deny: false }] },
    levers,
    gain,
  });
  // Recoverable = Workflow(1024) + hook(6144) + claudeMd(3072) = 10240 = 10.0K;
  // the flag-only MCP (2400) and the harness floor (2765) are shown but excluded.
  assert.ok(lines.some((l) => /Recoverable.*10\.0K bytes/.test(l)), lines.filter((l) => /Recoverable/.test(l)).join('\n'));
  // The MCP row is shown (flag-only) and the harness floor is shown with a dash.
  assert.ok(lines.some((l) => /MCP.*flag-only/.test(l)));
  assert.ok(lines.some((l) => /harness.*—/.test(l)));
});

test('every figure is a byte-length — gain equals Buffer.byteLength(canonicalize(block))', () => {
  const body = leverBody();
  const acc = structuredGain();
  chargeExchange({ segments: withKind(segs1(body), 'reused-uncached'), body }, acc);
  // The non-negotiable: never re-tokenized. Every shipped/waste is the canonical byte
  // length of the block, the identical proxy Segment.bytes uses.
  assert.equal(acc.tool.get('Workflow').shipped, cbytes(body.tools[0]));
  assert.equal(acc.hook.shipped, cbytes(body.system[1]));
  assert.equal(acc.claudeMd.get('./CLAUDE.md').shipped, cbytes(body.messages[0].content[0]));
  assert.equal(acc.harness.shipped, cbytes(body.system[0]));
});

// ── end-to-end: a cold-cache two-turn session proves waste > 0 through fineTune ─

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ft6-'));
}

/** A streamed response with NO cache_read → cold cache → reused collapses to waste. */
function coldResponse() {
  return 'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n';
}

/** Write a two-turn session whose static content (tools/hook/CLAUDE.md) is identical
 *  across turns, so turn 2 reuses it; with a cold cache that reuse is all waste. */
function writeColdSession(root, id) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const content = [
    { type: 'text', text: 'SessionStart:startup hook success:\n' + 'H'.repeat(6000) },
    { type: 'text', text: 'Contents of ./CLAUDE.md (project instructions):\n' + 'M'.repeat(6000) },
    { type: 'text', text: 'do the thing' },
  ];
  const base = { model: 'claude-x', system: [{ type: 'text', text: 'system prompt' }], tools: [{ name: 'Workflow' }, { name: 'Bash' }] };
  // Turn 1: just the user message. Turn 2: same + an assistant reply + a new user msg
  // (messages grow, but message#0 — the hook + CLAUDE.md carrier — is byte-identical).
  const turn1 = { ...base, messages: [{ role: 'user', content }] };
  const turn2 = { ...base, messages: [{ role: 'user', content }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  for (const [i, body] of [[1, turn1], [2, turn2]]) {
    fs.writeFileSync(path.join(dir, `000${i}.request.http`), httpBody(body));
    fs.writeFileSync(path.join(dir, `000${i}.response.sse`), coldResponse());
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    [
      JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }),
      JSON.stringify({ turn: 2, thread_id: id, request_blob: '0002.request.http', response_blob: '0002.response.sse' }),
    ].join('\n') + '\n',
  );
  return dir;
}

test('fineTune on a cold-cache session: a denied tool + hook + CLAUDE.md all show waste > 0', () => {
  const root = mkTmpDir();
  writeColdSession(root, 'cold');
  const res = fineTune({ cwd: '/nonexistent', root, session: 'cold' });
  // The denied tool is recoverable and was re-paid on turn 2 → waste > 0.
  const wf = res.gain.tool.get('Workflow');
  assert.ok(wf.shipped > 0, 'Workflow ships bytes');
  assert.ok(wf.waste > 0, 'Workflow was re-paid after the cold cache break');
  assert.ok(res.gain.hook.waste > 0, 'the hook output was re-paid');
  assert.ok(res.gain.claudeMd.get('./CLAUDE.md').waste > 0, 'the CLAUDE.md block was re-paid');
  // waste never exceeds shipped (re-paid bytes ⊆ shipped bytes).
  assert.ok(wf.waste <= wf.shipped);
  assert.ok(res.gain.hook.waste <= res.gain.hook.shipped);
});

test('fineTune headline = Σ actionable waste > 0 on the cold-cache session', () => {
  const root = mkTmpDir();
  writeColdSession(root, 'cold2');
  const res = fineTune({ cwd: '/nonexistent', root, session: 'cold2' });
  // Workflow (denied) + hook (above floor) + CLAUDE.md (excludable above floor) are all
  // actionable and all re-paid → the recoverable headline is positive.
  assert.ok(res.lines.some((l) => /Recoverable.*[1-9]/.test(l)), 'headline is non-zero');
  // The settings block still carries the deny + hooks + claudeMdExcludes (unchanged by FT6).
  const block = JSON.parse(res.settingsJson);
  assert.deepEqual(block.permissions.deny, ['Workflow']);
  assert.deepEqual(block.hooks, { SessionStart: [] });
  assert.deepEqual(block.claudeMdExcludes, ['./CLAUDE.md']);
});

// ── diagnostic shape against the committed FT0 fixture ────────────────────────

/** Session fixture dirs under FIXTURES_DIR (`session-*`), sorted. Missing root → []. */
function sessionDirs() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^session-/.test(e.name))
    .map((e) => e.name)
    .sort();
}

const fixtureDirs = sessionDirs();
const fixtureOpts = fixtureDirs.length === 0
  ? { skip: 'no fixture committed under test/fixtures/finetune/ — FT6 (issue #76) shape-gates the diagnostic the moment one lands' }
  : {};

test('FT6 fixture: the diagnostic carries the shipped/waste/action table + totals + headline — AC #2', fixtureOpts, () => {
  for (const id of fixtureDirs) {
    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    const joined = res.lines.join('\n');
    // The table header names the three columns (spec Part 5 mockup).
    assert.ok(/shipped.*waste.*action/.test(joined), `${id}: table header has shipped/waste/action`);
    // A per-lever row exists (built-in tools deny is always present on this fixture).
    assert.ok(/tools.*deny ✓/.test(joined), `${id}: a tools row carries the deny action`);
    // Totals + the recoverable headline + the cache caveat.
    assert.ok(/Total/.test(joined), `${id}: a totals row`);
    assert.ok(/Recoverable \(waste, conservative\)/.test(joined), `${id}: the recoverable headline`);
    assert.ok(/Cutting a lever may also restore cache hits \(not modeled\)/.test(joined), `${id}: the cache caveat`);
  }
});

test('FT6 fixture: the settings block is pure JSON with the cache warning above it — AC #3', fixtureOpts, () => {
  for (const id of fixtureDirs) {
    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    // Valid, comment-free JSON.
    assert.doesNotThrow(() => JSON.parse(res.settingsJson), `${id}: block parses`);
    assert.ok(!/\/\//.test(res.settingsJson) && !/\/\*/.test(res.settingsJson), `${id}: no JSON comments`);
    // The single cache-invalidation warning prints above the block (this fixture denies tools).
    const warnIdx = res.lines.findIndex((l) => /invalidates the cache/.test(l));
    const blockIdx = res.lines.findIndex((l) => /settings\.json/.test(l));
    assert.ok(warnIdx >= 0 && blockIdx >= 0 && warnIdx < blockIdx, `${id}: warning above the block`);
    // permissions.deny is exactly the bare-name intersection (FT1, unchanged by FT6).
    assert.deepEqual(JSON.parse(res.settingsJson).permissions.deny, res.deny);
  }
});

test('FT6 fixture: every figure is a byte-length — waste ≤ shipped, harness shows the floor dash — AC #1/#4', fixtureOpts, () => {
  for (const id of fixtureDirs) {
    const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR, session: id });
    const g = res.gain;
    // waste never exceeds shipped for any lever (re-paid ⊆ shipped).
    for (const v of g.tool.values()) assert.ok(v.waste <= v.shipped, `${id}: tool waste ≤ shipped`);
    for (const v of g.claudeMd.values()) assert.ok(v.waste <= v.shipped, `${id}: claudeMd waste ≤ shipped`);
    assert.ok(g.hook.waste <= g.hook.shipped, `${id}: hook waste ≤ shipped`);
    assert.ok(g.mcp.waste <= g.mcp.shipped, `${id}: mcp waste ≤ shipped`);
    // The harness floor is shown with a dash for waste (incompressible, not modelled).
    assert.ok(res.lines.some((l) => /harness.*—/.test(l)), `${id}: harness waste rendered as a dash`);
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** A fresh GainModel accumulator (mirrors computeGain's initial shape). */
function structuredGain() {
  return {
    tool: new Map(),
    claudeMd: new Map(),
    hook: { shipped: 0, waste: 0 },
    mcp: { shipped: 0, waste: 0 },
    catalog: new Map(),
    harness: { shipped: 0, waste: 0 },
  };
}

/** The segments leverBody's body produces (system#0, system#1, tool:Workflow, tool:Bash,
 *  message#0), sized from the body so segment.bytes is consistent with blockBytes. */
function segs1(body) {
  return [
    { slot: 'system#0', bytes: cbytes(body.system[0]), kind: 'new' },
    { slot: 'system#1', bytes: cbytes(body.system[1]), kind: 'new' },
    { slot: 'tool:Workflow', bytes: cbytes(body.tools[0]), kind: 'new' },
    { slot: 'tool:Bash', bytes: cbytes(body.tools[1]), kind: 'new' },
    { slot: 'message#0', bytes: cbytes(body.messages[0]), kind: 'new' },
  ];
}

/** Return a copy of `segs` with every segment's `.kind` set to `kind`. */
function withKind(segs, kind) {
  return segs.map((s) => ({ ...s, kind }));
}

test('the gain model has exactly six buckets — a seventh must be added to every total', () => {
  // `chargedBytes` (and every consumer that sums the model: `floor`'s attribution,
  // `buildJsonReport`'s totals.shipped) enumerates the buckets by hand. Pinning the shape
  // here is what turns "someone added a lever and forgot the total" from a silent
  // under-count into a failing test.
  assert.deepEqual(Object.keys(EMPTY_GAIN).sort(), ['catalog', 'claudeMd', 'harness', 'hook', 'mcp', 'tool']);
});

// EMPTY_GAIN sanity: it shares the all-zero shape.
test('EMPTY_GAIN is the all-zero no-op gain', () => {
  assert.equal(EMPTY_GAIN.hook.shipped, 0);
  assert.equal(EMPTY_GAIN.tool.size, 0);
});

// ── review regressions ────────────────────────────────────────────────────────

test('a session that ships tools with NO denylist intersection says so — never "no lever content"', () => {
  // The table only rows the DENIED tools, so a session shipping only primitives has no
  // tools row. The diagnostic must still report the scan: claiming the session shipped
  // no lever content would be false, and it is the one line telling the reader the
  // denylist was actually checked.
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 2,
    shipped: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
  });
  const joined = lines.join('\n');
  assert.ok(/6 shipped, none intersect the built-in denylist/.test(joined), joined);
  assert.ok(!/no lever content/.test(joined), 'must not claim the session shipped no lever content');
});

test('the tools scan note is absent once a tool IS denied — the row carries the story instead', () => {
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: ['Workflow', 'Bash'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    gain: { ...EMPTY_GAIN, tool: new Map([['Workflow', { shipped: 5120, waste: 1024 }]]) },
  });
  const joined = lines.join('\n');
  assert.ok(!/none intersect the built-in denylist/.test(joined));
  assert.ok(/tools\s+Workflow\s+5\.0K\s+1\.0K\s+deny ✓/.test(joined), joined);
});

test('the table header aligns with the byte columns under it', () => {
  // The header used to be a hand-typed string that had drifted out of alignment with
  // the padded rows; both now come from one formatter, so the labels sit over the cells.
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    gain: { ...EMPTY_GAIN, tool: new Map([['Workflow', { shipped: 5120, waste: 1024 }]]) },
  });
  const header = lines.find((l) => /shipped\s+waste\s+action/.test(l));
  const row = lines.find((l) => /^tools\s/.test(l));
  assert.ok(header && row, 'header + a data row are present');
  // Right-aligned cells: each label's right edge is its column's right edge.
  assert.equal(
    header.indexOf('shipped') + 'shipped'.length,
    row.indexOf('5.0K') + '5.0K'.length,
    'shipped column',
  );
  assert.equal(header.indexOf('waste') + 'waste'.length, row.indexOf('1.0K') + '1.0K'.length, 'waste column');
  assert.equal(header.indexOf('action'), row.indexOf('deny ✓'), 'action column');
});

test('the gain model and the lever verdicts share ONE managed-source placeholder', () => {
  // The renderer looks a verdict whose `source` is null up in gain.claudeMd under this
  // key. Two independently declared placeholders would silently miss and fall back to
  // a 0-byte waste, so the constant must be the same byte in both modules.
  assert.equal(NULL_SOURCE, LEVERS_NULL_SOURCE);
});

test('a managed CLAUDE.md source renders its gain bytes, not a zero fallback', () => {
  // Behavioural proof of the shared placeholder: source null keys under NULL_SOURCE.
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: {
      systemBytes: 50_000,
      hook: { bytes: 0, aboveFloor: false, deny: false },
      claudeMd: [{ source: null, bytes: 4096, pct: 8, excludable: false, deny: false }],
    },
    gain: { ...EMPTY_GAIN, claudeMd: new Map([[NULL_SOURCE, { shipped: 4096, waste: 2048 }]]) },
  });
  assert.ok(
    lines.some((l) => /CLAUDE\.md\s+\(managed\)\s+4\.0K\s+2\.0K\s+advice \(managed\)/.test(l)),
    lines.join('\n'),
  );
});

test('no source file carries a raw NUL byte — git would treat the module as binary', () => {
  // NULL_SOURCE must be written as a unicode escape, never a literal control byte: one
  // raw NUL makes the whole file binary to git (no diff, no blame, unreviewable).
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  for (const name of fs.readdirSync(srcDir).filter((n) => n.endsWith('.js'))) {
    const buf = fs.readFileSync(path.join(srcDir, name));
    assert.ok(!buf.includes(0), `src/${name} contains a raw NUL byte`);
  }
});

// ── issue #100: byte-cost ranking of ALL tools / per-server MCP / CLAUDE.md ────
//
// The action table above rows only the *recoverable* levers (denied tools, the MCP
// listing, hooks, CLAUDE.md, harness). The ranking exposes EVERY shipped tool / MCP
// server (aggregated per-server from mcp__<server>__*) / CLAUDE.md source, sorted by
// shipped bytes — so a maintainer can weigh a cut even when a tool is only sometimes
// used and is therefore not in the deny intersection. It reuses the gain model's
// already-computed bytes (no new accounting, never re-tokenized) and is always-on.

test('byte-cost ranking lists every shipped tool (not only denied), per-server MCP, and CLAUDE.md — sorted by shipped', () => {
  // Three built-in tools (only Workflow is denied), two MCP tool defs on one server
  // (summed per server), and one CLAUDE.md source. The ranking must surface ALL of
  // them — Bash and Read are not denied, proving the view is not the deny intersection.
  const gain = {
    tool: new Map([
      ['Bash', { shipped: 5000, waste: 1000 }],
      ['Workflow', { shipped: 4000, waste: 0 }],
      ['Read', { shipped: 800, waste: 0 }],
      ['mcp__stub__one', { shipped: 1200, waste: 0 }],
      ['mcp__stub__two', { shipped: 800, waste: 0 }],
    ]),
    claudeMd: new Map([['./CLAUDE.md', { shipped: 1500, waste: 0 }]]),
    hook: { shipped: 0, waste: 0 },
    mcp: { shipped: 0, waste: 0 },
    catalog: new Map(),
    harness: { shipped: 0, waste: 0 },
  };
  const levers = {
    systemBytes: 12000,
    hook: { bytes: 0, aboveFloor: false, deny: false },
    claudeMd: [{ source: './CLAUDE.md', bytes: 1500, pct: 12, excludable: true, deny: false }],
  };
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: ['Bash', 'Workflow', 'Read', 'mcp__stub__one', 'mcp__stub__two'],
    deny: ['Workflow'], // the only shipped tool on the built-in denylist
    mcp: { sessionCount: 1, singleSession: true, servers: [{ name: 'stub', shippedSessions: 1, calledCount: 0, deny: false }] },
    levers,
    gain,
  });
  const joined = lines.join('\n');

  // The ranking section is present.
  assert.ok(/Byte-cost ranking/.test(joined), joined);

  // ALL shipped built-in tools appear — Bash and Read are NOT denied, so their presence
  // proves the ranking is not limited to the deny intersection.
  const bashI = lines.findIndex((l) => /^  tool Bash\b/.test(l));
  const wfI = lines.findIndex((l) => /^  tool Workflow\b/.test(l));
  const stubI = lines.findIndex((l) => /^  MCP stub\b/.test(l));
  const mdI = lines.findIndex((l) => /^  CLAUDE\.md \.\/CLAUDE\.md/.test(l));
  const readI = lines.findIndex((l) => /^  tool Read\b/.test(l));
  assert.ok([bashI, wfI, stubI, mdI, readI].every((i) => i >= 0), 'all five ranked entries present');
  // Ranked by shipped bytes desc: Bash(5000) > Workflow(4000) > stub(2000) > CLAUDE.md(1500) > Read(800).
  assert.ok(bashI < wfI && wfI < stubI && stubI < mdI && mdI < readI, 'entries in shipped-desc order');

  // Per-server MCP bytes SUMMED: stub = 1200 + 800 = 2000 = 2.0K, with the tool count.
  assert.ok(/^  MCP stub\s+2\.0K\s+0\s+2 tools$/m.test(joined), 'per-server MCP bytes sum correctly (2000) with tool count');
  // CLAUDE.md source carries its % of the system context.
  assert.ok(/^  CLAUDE\.md \.\/CLAUDE\.md\s+1\.5K\s+0\s+12% of system$/m.test(joined), 'CLAUDE.md ranked with % of system');
  // The denied tool is marked; a non-denied tool is not.
  assert.ok(/^  tool Workflow\s+3\.9K\s+0\s+deny$/m.test(joined), 'denied tool is marked in the ranking');
  assert.ok(/^  tool Bash\s+4\.9K\s+1000$/m.test(joined), 'a non-denied tool carries no deny mark');
});

/** The ranked rows of a rendered diagnostic — every line between the rule and the blank. */
function rankingRows(lines) {
  const rule = lines.findIndex((l) => /^  ─+$/.test(l));
  if (rule < 0) return [];
  const rows = [];
  for (let i = rule + 1; i < lines.length && lines[i] !== ''; i++) rows.push(lines[i]);
  return rows;
}

/**
 * A one-CLAUDE.md-source ctx for {@link renderFineTune}, parameterised by tool map +
 * source. `shipped` defaults to the tool map's names (the by-construction case).
 * @param {{ tool: Map<string, { shipped: number, waste: number }>, source?: string,
 *   shipped?: string[], deny?: string[], servers?: any[] }} opts
 */
function rankCtx({ tool, source = './CLAUDE.md', shipped, deny = [], servers = [] }) {
  return {
    sessionId: 's',
    requests: 1,
    shipped: shipped ?? [...tool.keys()],
    deny,
    mcp: { sessionCount: 1, singleSession: true, servers },
    levers: {
      systemBytes: 12000,
      hook: { bytes: 0, aboveFloor: false, deny: false },
      claudeMd: [{ source, bytes: 1500, pct: 12, excludable: true, deny: false }],
    },
    gain: {
      tool,
      claudeMd: new Map([[source, { shipped: 1500, waste: 0 }]]),
      hook: { shipped: 0, waste: 0 },
      mcp: { shipped: 0, waste: 0 },
      catalog: new Map(),
      harness: { shipped: 0, waste: 0 },
    },
  };
}

test('byte-cost ranking keeps its columns aligned when an entry label overflows', () => {
  // A real CLAUDE.md source is an absolute path — longer than the entry column. An
  // over-long label must not shove the byte columns right, or the ranking stops being
  // scannable exactly on the rows a maintainer most wants to compare.
  const source = '/home/agent/workspace/deeply/nested/project/CLAUDE.md';
  const { lines } = renderFineTune(rankCtx({ tool: new Map([['Bash', { shipped: 5000, waste: 1000 }]]), source }));
  const rows = rankingRows(lines);
  assert.equal(rows.length, 2, `one tool row + one CLAUDE.md row:\n${lines.join('\n')}`);
  // Each row: 2-space indent, a fixed-width entry field, then the right-aligned bytes.
  // An overflowing label pushes the figures right and fails this.
  for (const row of rows) {
    assert.match(row, /^ {2}.{36} {1,7}[\d.KM]+ {2}/, `row keeps the byte columns aligned: ${JSON.stringify(row)}`);
  }
  // The elided label still ends in the basename — the part that identifies the source.
  const mdRow = rows.find((r) => /^ {2}CLAUDE\.md/.test(r)) ?? '';
  assert.match(mdRow, /CLAUDE\.md\s/, `elided source keeps its basename: ${JSON.stringify(mdRow)}`);
});

test('byte-cost ranking ranks a shipped tool the gain model never charged (0 bytes, still listed)', () => {
  // The tools lever's JSON items deliberately union `shipped` with the gain model's
  // names so a shipped name can never vanish from the view that claims to list it
  // (issue #95). The ranking claims to list EVERY shipped tool — same contract.
  const { lines } = renderFineTune(
    rankCtx({ tool: new Map([['Bash', { shipped: 5000, waste: 0 }]]), shipped: ['Bash', 'Uncharged'] })
  );
  assert.ok(
    lines.some((l) => /^ {2}tool Uncharged\s+0\s+0$/.test(l)),
    `a shipped-but-uncharged tool is ranked at 0 bytes:\n${lines.join('\n')}`
  );
});

test('byte-cost ranking never drops a tool whose name only looks like an MCP name', () => {
  // `mcp__lonely` has the mcp__ prefix but no `__<tool>` suffix, so it names no server.
  // It is still a shipped tool costing bytes — it must be ranked, not silently dropped
  // between the built-in branch and the per-server aggregate.
  const { lines } = renderFineTune(
    rankCtx({ tool: new Map([['mcp__lonely', { shipped: 4000, waste: 100 }]]) })
  );
  assert.ok(
    lines.some((l) => /^ {2}tool mcp__lonely\s+3\.9K\s+100$/.test(l)),
    `an unparseable mcp__ name is ranked as a tool:\n${lines.join('\n')}`
  );
});

test('byte-cost ranking is omitted when nothing was captured to rank (no empty table)', () => {
  // An EMPTY gain + empty levers (e.g. a session whose body never parsed) must not
  // print a bare header with no rows. The whole section is absent.
  const { lines } = renderFineTune({
    sessionId: 's',
    requests: 1,
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  assert.ok(!lines.some((l) => /Byte-cost ranking/.test(l)), 'no ranking section for an empty session');
});

test('fineTune end-to-end: a session shipping an mcp__<server>__* tool ranks it per-server', () => {
  // A synthetic session (the "known tool set incl. ≥1 mcp__<server>__*" case) proving
  // the wiring: the gain model carries the MCP tool def, and the ranking aggregates it
  // per server — alongside every shipped built-in tool, denied ones marked.
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'rank');
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    model: 'claude-x',
    system: [{ type: 'text', text: 'system prompt' }],
    tools: [
      { name: 'Bash' },
      { name: 'Workflow' }, // on the built-in denylist → denied
      { name: 'mcp__stub__t00' }, // an MCP tool def — aggregated per server in the ranking
    ],
    messages: [{ role: 'user', content: 'hi' }],
  };
  fs.writeFileSync(path.join(dir, '0001.request.http'), httpBody(body));
  fs.writeFileSync(path.join(dir, '0001.response.sse'), coldResponse());
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 'rank', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  const res = fineTune({ cwd: '/nonexistent', root, session: 'rank' });
  const joined = res.lines.join('\n');
  // The gain model carried the MCP tool def under its mcp__ name.
  assert.ok(res.gain.tool.has('mcp__stub__t00'), 'gain.tool carries the MCP tool def');
  // The ranking aggregates it per server and lists the built-in tools too.
  assert.ok(/Byte-cost ranking/.test(joined), 'ranking section present');
  assert.ok(/^  MCP stub\b/m.test(joined), 'per-server MCP row present');
  assert.ok(/^  tool Bash\b/m.test(joined), 'built-in tool Bash ranked (not only denied)');
  assert.ok(/^  tool Workflow\b.*deny$/m.test(joined), 'denied tool marked');
});
