// Lever 5a (issue #118, ADR-0005) — `name-only` on the skills the model never invoked.
//
// The lever's shape is the MCP lever's, reused verbatim where it can be: a skill is
// SHIPPED when the turn-1 skills catalog lists it, INVOKED when a `Skill` tool_use names
// it, and the verdict fires only under the same T4 guard (`sessionCount >= 3`, never in
// single-session mode). What differs is the action — `skillOverrides: name-only`, which
// keeps the skill listed and `/name` working and stops shipping its description — so the
// tests below pin the three things that distinguishes it:
//
//   • the disuse predicate is MODEL invocation. A `/name` the user typed is not a
//     tool_use, so it cannot count — which is sound precisely because `name-only` leaves
//     `/name` intact (ADR-0005 decision 4).
//   • the verdict is per-skill and byte-ranked, in ONE diff (decision 6).
//   • a scope-QUALIFIED name (`plugin:skill`) is reported and never actioned: no
//     `skillOverrides` entry reaches a plugin skill (ADR-0005 fact 2 / lever 5b).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  skillCatalogEntries,
  sessionSkillProfile,
  aggregateSkillCorpus,
  skillOverrideMap,
  skillRecoverableBytes,
  nameOnlyBytes,
  EMPTY_SKILL_CORPUS,
  SKILL_OVERRIDE_ACTION,
  SKILL_OVERRIDE_ENUM,
  SKILLS_GUARD_MIN_SESSIONS,
} from '../src/finetune-skills.js';
import { MCP_GUARD_MIN_SESSIONS } from '../src/finetune-mcp.js';
import { SKILL_TOOL } from '../src/finetune-response.js';
import { buildRequestBlob } from '../src/capture.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-l5a-'));
}

const SKILLS_HDR = 'The following skills are available for use with the Skill tool:';

/** The real catalog shape: a `<system-reminder>` wrapping `- <name>: <description>` lines. */
function catalogText(entries) {
  const lines = entries.map(([name, desc]) => (desc === null ? `- ${name}` : `- ${name}: ${desc}`));
  return `<system-reminder>\n${SKILLS_HDR}\n\n${lines.join('\n')}\n</system-reminder>`;
}

/** A turn-1 request body carrying the skills catalog where Claude Code injects it. */
function bodyWithCatalog(entries, { surface = 'message' } = {}) {
  const text = catalogText(entries);
  return surface === 'system'
    ? { system: [{ type: 'text', text }], messages: [{ role: 'user', content: 'hi' }] }
    : { system: [{ type: 'text', text: 'You are Claude Code.' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
}

/** One SSE `event:`/`data:` pair. */
function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A streamed turn invoking `skills` through the `Skill` tool, arguments as deltas. */
function turnInvoking(skills) {
  let out = sse('message_start', { message: { id: 'msg_1', role: 'assistant', content: [] } });
  skills.forEach((skill, i) => {
    out += sse('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: SKILL_TOOL } });
    out += sse('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill }) } });
    out += sse('content_block_stop', { index: i });
  });
  out += sse('message_stop', {});
  return out;
}

/**
 * Write a captured session: every turn re-ships `entries` (the catalog is static), and
 * turn `i` invokes `invoked[i]` skills.
 */
function writeSession(root, id, entries, invoked = []) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const turns = Math.max(1, invoked.length);
  const lines = [];
  for (let i = 0; i < turns; i++) {
    const n = String(i + 1).padStart(4, '0');
    fs.writeFileSync(
      path.join(dir, `${n}.request.http`),
      buildRequestBlob({
        method: 'POST',
        url: '/v1/messages',
        rawHeaders: ['Content-Type', 'application/json'],
        body: Buffer.from(JSON.stringify(bodyWithCatalog(entries))),
      })
    );
    fs.writeFileSync(
      path.join(dir, `${n}.response.sse`),
      zlib.gzipSync(Buffer.from(turnInvoking(invoked[i] ?? []), 'utf8'))
    );
    lines.push(JSON.stringify({ turn: i + 1, thread_id: id, request_blob: `${n}.request.http`, response_blob: `${n}.response.sse` }));
  }
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');
  return dir;
}

/** A profile as the aggregator takes it (the shape `sessionSkillProfile` emits). */
function profile(shipped, invoked = []) {
  return { shipped: new Map(Object.entries(shipped)), invoked: new Set(invoked) };
}

// ── shipped half: the catalog, on either surface ──────────────────────────────

test('skillCatalogEntries reads the catalog Claude Code injects into the first user message', () => {
  const entries = skillCatalogEntries(bodyWithCatalog([['tdd', 'red-green-refactor'], ['dataviz', 'charts']]));
  assert.deepEqual([...entries.keys()], ['tdd', 'dataviz']);
  assert.ok(entries.get('dataviz') > 0, 'an entry costs the bytes of its listed line');
});

test('skillCatalogEntries finds the catalog on the system surface too', () => {
  // Which surface Claude Code injects on is a build detail (bench/SPEC.md §4); the lever
  // must not go blind because a build moved the reminder.
  const entries = skillCatalogEntries(bodyWithCatalog([['tdd', 'x']], { surface: 'system' }));
  assert.deepEqual([...entries.keys()], ['tdd']);
});

test('skillCatalogEntries charges a name-only entry only its name line', () => {
  // The shape a skill already overridden to `name-only` takes on the wire — the lever
  // must read its own past action back as "already cheap", not re-propose it blind.
  const entries = skillCatalogEntries(bodyWithCatalog([['dataviz', null], ['tdd', 'a description']]));
  assert.equal(entries.get('dataviz'), nameOnlyBytes('dataviz'));
  assert.ok(entries.get('tdd') > entries.get('dataviz'));
});

test('skillCatalogEntries keeps a plugin skill’s qualifier — the reach test depends on it', () => {
  // Read off the wire, a plugin skill is `- plugin:skill: <description>`. If the parser cut
  // the name at its colon, the qualifier would vanish and the skill would look reachable —
  // earning a `skillOverrides` key the resolver ignores.
  const entries = skillCatalogEntries(bodyWithCatalog([['skill-creator:skill-creator', 'make skills'], ['tdd', 'x']]));
  assert.deepEqual([...entries.keys()], ['skill-creator:skill-creator', 'tdd']);
});

test('a qualified skill read from a real catalog never reaches the emitted map', () => {
  // End to end over the parser, not over a hand-built profile: the exclusion is only as
  // good as the name the catalog parse produced.
  const body = bodyWithCatalog([['plug:helper', 'a fat description'], ['dataviz', 'charts']]);
  const profiles = [1, 2, 3].map(() => ({ shipped: skillCatalogEntries(body), invoked: new Set() }));
  assert.deepEqual(skillOverrideMap(aggregateSkillCorpus(profiles)), { dataviz: SKILL_OVERRIDE_ACTION });
});

test('skillCatalogEntries is null-safe and empty when no catalog shipped', () => {
  assert.equal(skillCatalogEntries(null).size, 0);
  assert.equal(skillCatalogEntries({ messages: [{ role: 'user', content: 'plain prose' }] }).size, 0);
});

test('skillCatalogEntries never mistakes prose about the Skill tool for a catalog', () => {
  // The user's own prompt rides the same message as the injected reminders (#117). A
  // sentence naming a skill is not a listing, and charging it would invent shipped skills.
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: '- tdd: please use the tdd skill' }] }] };
  assert.equal(skillCatalogEntries(body).size, 0);
});

// ── session profile: shipped ∪ model-invoked, from the capture ────────────────

test('sessionSkillProfile reports the shipped catalog and the skills the model invoked', () => {
  const dir = writeSession(mkTmpDir(), 'sess-a', [['tdd', 'a'], ['dataviz', 'b']], [['tdd'], []]);
  const p = sessionSkillProfile(dir, 'sess-a');
  assert.equal(p.sessionId, 'sess-a');
  assert.deepEqual([...p.shipped.keys()].sort(), ['dataviz', 'tdd']);
  assert.deepEqual([...p.invoked], ['tdd']);
});

test('sessionSkillProfile keeps the LARGEST listing of a skill across the turns', () => {
  // A catalog can shrink mid-session (Claude Code truncates its biggest entries when its
  // own listing budget overflows), and the lever's figure is what the description COSTS
  // when it ships — the max, like every other static lever in the gain model.
  const root = mkTmpDir();
  const dir = path.join(root, 'sessions', 'sess-b');
  fs.mkdirSync(dir, { recursive: true });
  const shapes = [
    [['tdd', 'a much longer description that costs real bytes']],
    [['tdd', null]],
  ];
  const lines = shapes.map((entries, i) => {
    const n = String(i + 1).padStart(4, '0');
    fs.writeFileSync(
      path.join(dir, `${n}.request.http`),
      buildRequestBlob({
        method: 'POST',
        url: '/v1/messages',
        rawHeaders: ['Content-Type', 'application/json'],
        body: Buffer.from(JSON.stringify(bodyWithCatalog(entries))),
      })
    );
    return JSON.stringify({ turn: i + 1, request_blob: `${n}.request.http` });
  });
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');

  const p = sessionSkillProfile(dir, 'sess-b');
  assert.ok(p.shipped.get('tdd') > nameOnlyBytes('tdd'), 'the full listing, not the truncated one');
});

test('sessionSkillProfile degrades on an unreadable turn instead of taking the session down', () => {
  const dir = writeSession(mkTmpDir(), 'sess-c', [['tdd', 'a']], [[]]);
  fs.appendFileSync(path.join(dir, 'manifest.jsonl'), '{"turn":2,"request_blob":"nope.request.http"}\n{half\n');
  const p = sessionSkillProfile(dir, 'sess-c');
  assert.deepEqual([...p.shipped.keys()], ['tdd']);
});

// ── the T4 guard, reused verbatim from the MCP lever ─────────────────────────

test('the guard threshold IS the MCP lever’s — same evidence shape, no new knob', () => {
  assert.equal(SKILLS_GUARD_MIN_SESSIONS, MCP_GUARD_MIN_SESSIONS);
});

test('a skill shipped across 3 sessions and never invoked gets the name-only verdict', () => {
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 }), profile({ tdd: 400 })]);
  assert.equal(corpus.sessionCount, 3);
  const tdd = corpus.skills.find((s) => s.name === 'tdd');
  assert.deepEqual(
    { shippedSessions: tdd.shippedSessions, invokedCount: tdd.invokedCount, override: tdd.override },
    { shippedSessions: 3, invokedCount: 0, override: true }
  );
  assert.deepEqual(skillOverrideMap(corpus), { tdd: SKILL_OVERRIDE_ACTION });
});

test('one model invocation anywhere in the corpus is enough to spare a skill', () => {
  // Binary on absence, like the MCP lever: invoked once ⇒ used ⇒ never "never used".
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 }, ['tdd']), profile({ tdd: 400 })]);
  const tdd = corpus.skills.find((s) => s.name === 'tdd');
  assert.equal(tdd.invokedCount, 1);
  assert.equal(tdd.override, false);
  assert.deepEqual(skillOverrideMap(corpus), {});
});

test('two sessions are not enough evidence — the verdict waits for the third', () => {
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 })]);
  assert.equal(corpus.skills[0].override, false);
  assert.deepEqual(skillOverrideMap(corpus), {});
});

test('single-session mode never emits a verdict, however many skills went unused', () => {
  const profiles = [profile({ tdd: 400 }), profile({ tdd: 400 }), profile({ tdd: 400 })];
  const corpus = aggregateSkillCorpus(profiles, { singleSession: true });
  assert.equal(corpus.singleSession, true);
  assert.equal(corpus.skills[0].override, false);
  assert.deepEqual(skillOverrideMap(corpus), {});
});

test('a skill only ever invoked by /name still qualifies — its description bought nothing', () => {
  // A slash-typed invocation produces no `tool_use`, so it never reaches `invoked`. That is
  // the point: `name-only` leaves `/name` working, so the description is the only thing cut.
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 }), profile({ tdd: 400 })]);
  assert.equal(corpus.skills.find((s) => s.name === 'tdd').override, true);
});

test('a hole in the profile list is not a session — the guard denominator stays honest', () => {
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), null, profile({ tdd: 400 })]);
  assert.equal(corpus.sessionCount, 2);
  assert.equal(corpus.skills[0].override, false);
});

// ── reach: a qualified name is reported, never actioned (ADR-0005 fact 2) ─────

test('a scope-qualified skill is listed as unreachable and never enters the diff', () => {
  // Claude Code's resolver returns "on" unconditionally for a plugin skill, so no
  // `skillOverrides` entry can reach it — emitting one would be an action that silently
  // does nothing. Plugin skills are lever 5b's (advice tier) territory.
  const corpus = aggregateSkillCorpus([
    profile({ 'skill-creator:skill-creator': 900, tdd: 400 }),
    profile({ 'skill-creator:skill-creator': 900, tdd: 400 }),
    profile({ 'skill-creator:skill-creator': 900, tdd: 400 }),
  ]);
  const plugin = corpus.skills.find((s) => s.name === 'skill-creator:skill-creator');
  assert.equal(plugin.reachable, false);
  assert.equal(plugin.override, false, 'measured and named, but not actioned');
  assert.ok(plugin.bytes > 0, 'its cost is still reported');
  assert.deepEqual(skillOverrideMap(corpus), { tdd: SKILL_OVERRIDE_ACTION }, 'only the reachable name');
});

// ── ranking + the recovered-bytes figure ─────────────────────────────────────

test('skills are ranked bytes-descending — the diff leads with what it recovers', () => {
  const corpus = aggregateSkillCorpus([profile({ small: 100, big: 900, mid: 400 })]);
  assert.deepEqual(
    corpus.skills.map((s) => s.name),
    ['big', 'mid', 'small']
  );
});

test('the recovered figure is the description only — the name line keeps shipping', () => {
  // `name-only` leaves exactly `- <name>\n` on the wire (measured, #115), so the
  // recovery is the entry minus its name line, never the whole entry.
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 }), profile({ tdd: 400 })]);
  assert.equal(skillRecoverableBytes(corpus), 400 - nameOnlyBytes('tdd'));
});

test('a skill already at name-only recovers nothing further', () => {
  const bytes = nameOnlyBytes('tdd');
  const corpus = aggregateSkillCorpus([profile({ tdd: bytes }), profile({ tdd: bytes }), profile({ tdd: bytes })]);
  assert.equal(skillRecoverableBytes(corpus), 0, 'never negative — there is nothing left to cut');
});

test('nothing to act on ⇒ no map, no bytes, and the empty corpus is inert', () => {
  assert.deepEqual(skillOverrideMap(EMPTY_SKILL_CORPUS), {});
  assert.equal(skillRecoverableBytes(EMPTY_SKILL_CORPUS), 0);
  assert.deepEqual(aggregateSkillCorpus([]).skills, []);
});

test('the emitted value is `name-only`, and never one of the harsher three', () => {
  // ADR-0005 decision 1: `off` and `user-invocable-only` remove the skill from the
  // model's reach — an unbounded action the safe tier may not take.
  assert.equal(SKILL_OVERRIDE_ACTION, 'name-only');
  assert.deepEqual(SKILL_OVERRIDE_ENUM, ['on', 'name-only', 'user-invocable-only', 'off']);
  const corpus = aggregateSkillCorpus([profile({ tdd: 400 }), profile({ tdd: 400 }), profile({ tdd: 400 })]);
  assert.deepEqual(new Set(Object.values(skillOverrideMap(corpus))), new Set(['name-only']));
});
