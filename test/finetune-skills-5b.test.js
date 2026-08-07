// Lever 5b (issue #119, ADR-0005 decision 3) — plugin skills and the bundled bulk:
// measured and exposed, NEVER written.
//
// 5b carries exactly the same proof as 5a — shipped across the corpus, never invoked by
// the model — and is still advice tier, because the only actions available are unbounded:
//
//   • a plugin skill is reachable only through `enabledPlugins`, which cuts the WHOLE
//     plugin, including the parts in active use;
//   • the bundled population is reachable in bulk through `disableBundledSkills`, which is
//     all-or-nothing AND costs `/name` on every bundled skill (ADR-0005 amendment,
//     correction 2) — not just the descriptions.
//
// That is the point ADR-0004's axis was restated on: the tier is set by whether a false
// positive is BOUNDED, and the reach of the ACTION enters that as much as the evidence.
//
// So these tests pin two things above all: the FIGURES are produced (a user cannot decide
// what they cannot see), and no path exists from them to a write.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSkillCorpus,
  loadBundledSkills,
  loadBundledSkillsOrEmpty,
  pluginSkillGroups,
  bundledBulkVerdict,
  skillOverrideMap,
  PLUGIN_ACTION,
  BUNDLED_BULK_ACTION,
  BUNDLED_SKILLS_PATH,
  EMPTY_SKILL_CORPUS,
  SKILLS_GUARD_MIN_SESSIONS,
} from '../src/finetune-skills.js';

/** A profile as the aggregator takes it (the shape `sessionSkillProfile` emits). */
function profile(shipped, invoked = []) {
  return { shipped: new Map(Object.entries(shipped)), invoked: new Set(invoked) };
}

/** `n` identical sessions — the corpus shape the guard is written against. */
function corpusOf(shipped, invoked = [], n = SKILLS_GUARD_MIN_SESSIONS, opts = {}) {
  return aggregateSkillCorpus(
    Array.from({ length: n }, () => profile(shipped, invoked)),
    opts
  );
}

// ── the bundled roster: a NAME list, because the wire carries no source marker ─

test('the shipped bundled roster loads, is non-empty, and records what it was read on', () => {
  const roster = loadBundledSkills();
  assert.ok(roster.names.size > 0, 'an empty roster would silently disable the bulk verdict');
  assert.ok(roster.names.has('dataviz'), 'the heaviest bundled entry #105 measured');
  assert.ok(roster.readOn.length > 0, 'provenance is what lets a reader judge staleness');
  assert.equal(roster.size, roster.names.size);
});

test('a malformed roster fails loudly rather than narrowing the population in silence', () => {
  // Same discipline as the built-in denylist: a corrupt override must never read as
  // "nothing is bundled", which would turn the bulk verdict off with no explanation.
  assert.throws(() => loadBundledSkills('/no/such/bundled-skills.json'), /could not read/);
});

test('BUNDLED_SKILLS_PATH points at the file the loader actually reads', () => {
  assert.deepEqual(loadBundledSkills(BUNDLED_SKILLS_PATH), loadBundledSkills());
});

// ── scope: what a qualified name is, and what kind of scope it names ──────────

test('an unqualified name has no scope, and is a candidate for the bundled roster', () => {
  const corpus = corpusOf({ dataviz: 1157, 'my-own': 400 }, [], 3, { bundled: ['dataviz'] });
  const dataviz = corpus.skills.find((s) => s.name === 'dataviz');
  assert.equal(dataviz.scope, null);
  assert.equal(dataviz.bundled, true);
  assert.equal(corpus.skills.find((s) => s.name === 'my-own').bundled, false);
});

test('a plugin-qualified name reports its plugin; a path-qualified one reports a directory', () => {
  // Both are listed qualified and both are out of `skillOverrides`' reach, but only a
  // PLUGIN has an action behind it (`enabledPlugins`). Calling a directory-scoped skill a
  // plugin would offer a knob that does not exist for it.
  const corpus = corpusOf({ 'mattpocock-skills:code-review': 900, 'apps/web:deploy': 300 });
  const plugin = corpus.skills.find((s) => s.name === 'mattpocock-skills:code-review');
  const dir = corpus.skills.find((s) => s.name === 'apps/web:deploy');
  assert.equal(plugin.scope, 'mattpocock-skills');
  assert.equal(plugin.scopeKind, 'plugin');
  assert.equal(dir.scope, 'apps/web');
  assert.equal(dir.scopeKind, 'directory');
  assert.equal(plugin.reachable, false);
  assert.equal(dir.reachable, false, 'both stay out of the 5a diff');
});

// ── point 1: the plugin signalement, per plugin AND per skill ────────────────

test('a plugin is reported per plugin and per skill, with the invoked ones named', () => {
  // The issue's measured case: 10 of 12 skills never invoked, one (`code-review`) invoked
  // six times. An "uninstall the plugin" verdict would cost `code-review`, so the report
  // has to show BOTH halves and let the user decide.
  const corpus = corpusOf(
    {
      'mattpocock-skills:code-review': 900,
      'mattpocock-skills:tdd': 500,
      'mattpocock-skills:naming': 501,
      tdd: 400,
    },
    ['mattpocock-skills:code-review']
  );
  const groups = pluginSkillGroups(corpus);
  assert.equal(groups.length, 1, 'unqualified skills are not plugin skills');

  const g = groups[0];
  assert.equal(g.plugin, 'mattpocock-skills');
  assert.equal(g.kind, 'plugin');
  assert.equal(g.action, PLUGIN_ACTION);
  assert.equal(g.shippedSkills, 3);
  assert.equal(g.invokedSkills, 1);
  // Disabling recovers `bytes` — ALL of it — and takes `code-review` with it. `deadBytes`
  // is the loss-free part, and the gap between the two is exactly the price of the action.
  // Reporting only the second would read as "uninstall this, it costs you nothing".
  assert.equal(g.bytes, 900 + 500 + 501, 'what the plugin costs on every turn 1, and what disabling recovers');
  assert.equal(g.deadBytes, 500 + 501, 'the part recoverable without losing a skill the model uses');
  assert.deepEqual(
    g.skills.map((s) => [s.skill, s.invoked]),
    [
      ['code-review', true],
      ['naming', false],
      ['tdd', false],
    ],
    'per skill: the short name, and whether the MODEL reached it'
  );
});

test('a plugin whose every skill is dead still only earns a report — never a settings key', () => {
  const corpus = corpusOf({ 'dead-plugin:a': 300, 'dead-plugin:b': 200 });
  const [g] = pluginSkillGroups(corpus);
  assert.equal(g.invokedSkills, 0);
  assert.equal(g.deadBytes, 500);
  // The whole point of the tier: even total disuse buys no auto-write, because
  // `enabledPlugins` is still whole-plugin.
  assert.deepEqual(skillOverrideMap(corpus), {}, 'no skillOverrides entry reaches a plugin skill');
});

test('a directory-scoped group is reported without an action — no knob disables a directory', () => {
  const corpus = corpusOf({ 'apps/web:deploy': 300 });
  const [g] = pluginSkillGroups(corpus);
  assert.equal(g.kind, 'directory');
  assert.equal(g.action, null, 'offering enabledPlugins here would name a plugin that does not exist');
});

test('plugins rank by dead bytes — the report leads with the biggest unactioned cost', () => {
  const corpus = corpusOf({ 'small:a': 100, 'big:a': 900, 'mid:a': 400 });
  assert.deepEqual(
    pluginSkillGroups(corpus).map((g) => g.plugin),
    ['big', 'mid', 'small']
  );
});

test('no plugin skill ⇒ no groups, and the empty corpus is inert', () => {
  assert.deepEqual(pluginSkillGroups(corpusOf({ tdd: 400 })), []);
  assert.deepEqual(pluginSkillGroups(EMPTY_SKILL_CORPUS), []);
  assert.deepEqual(pluginSkillGroups(null), []);
});

// ── point 2: the bundled bulk, offered only when the WHOLE population is dead ─

test('the bulk is offered when no bundled skill was model-invoked, naming every one it drops', () => {
  const corpus = corpusOf({ dataviz: 1157, simplify: 191, tdd: 400 }, ['tdd'], 3, {
    bundled: ['dataviz', 'simplify'],
  });
  const bulk = bundledBulkVerdict(corpus);
  assert.equal(bulk.offered, true);
  assert.equal(bulk.action, BUNDLED_BULK_ACTION);
  assert.deepEqual(bulk.names, ['dataviz', 'simplify'], 'ranked bytes-descending');
  assert.equal(bulk.bytes, 1157 + 191, 'the WHOLE entries — the bulk removes them, name included');
  assert.equal(bulk.invokedSkills, 0);
  assert.match(bulk.caveat, /\/name/, 'it costs the slash command too, not just the description');
});

test('one invoked bundled skill kills the bulk — the all-or-nothing gesture costs more than it returns', () => {
  // ADR-0005 / issue #119 point 2: from that moment it is `name-only` BY NAME (lever 5a)
  // that applies, and `skillOverrides` entries reach bundled skills too.
  const corpus = corpusOf({ dataviz: 1157, simplify: 191 }, ['simplify'], 3, {
    bundled: ['dataviz', 'simplify'],
  });
  const bulk = bundledBulkVerdict(corpus);
  assert.equal(bulk.offered, false);
  assert.equal(bulk.invokedSkills, 1);
  assert.match(bulk.reason, /invoked/);
  // …and 5a still acts on the dead one, by name, with its bounded action.
  assert.deepEqual(skillOverrideMap(corpus), { dataviz: 'name-only' });
});

test('the bulk obeys the corpus guard verbatim — thin evidence never earns the harshest action', () => {
  const thin = corpusOf({ dataviz: 1157 }, [], SKILLS_GUARD_MIN_SESSIONS - 1, { bundled: ['dataviz'] });
  assert.equal(bundledBulkVerdict(thin).offered, false);
  assert.match(bundledBulkVerdict(thin).reason, /sessions/);

  const single = corpusOf({ dataviz: 1157 }, [], 5, { bundled: ['dataviz'], singleSession: true });
  assert.equal(bundledBulkVerdict(single).offered, false);
});

test('a corpus shipping no known-bundled skill offers nothing, and says which it is', () => {
  const corpus = corpusOf({ tdd: 400 }, [], 3, { bundled: ['dataviz'] });
  const bulk = bundledBulkVerdict(corpus);
  assert.equal(bulk.offered, false);
  assert.deepEqual(bulk.names, []);
  assert.equal(bulk.bytes, 0);
  assert.match(bulk.reason, /no .*bundled/i);
});

test('with no roster supplied nothing is claimed bundled — absence of proof, not proof of absence', () => {
  const corpus = corpusOf({ dataviz: 1157 });
  assert.equal(corpus.skills[0].bundled, false);
  assert.equal(bundledBulkVerdict(corpus).offered, false);
  assert.equal(bundledBulkVerdict(EMPTY_SKILL_CORPUS).offered, false);
  assert.equal(bundledBulkVerdict(null).offered, false);
});

test('a plugin skill is never counted into the bundled population', () => {
  // `disableBundledSkills`' own describe string: "Plugins, .claude/skills/ and
  // .claude/commands/ are unaffected." A qualified name can never be bundled, whatever a
  // stale roster says about its short name.
  const corpus = corpusOf({ 'dataviz:dataviz': 900 }, [], 3, { bundled: ['dataviz', 'dataviz:dataviz'] });
  assert.equal(corpus.skills[0].bundled, false);
  assert.equal(bundledBulkVerdict(corpus).offered, false);
});

// ── the roster must not be load-bearing for the levers that write ─────────────

test('an unreadable roster degrades to empty and CARRIES the reason — never a silent narrowing', () => {
  // Lever 5b is advice tier. Its data file has no business taking down levers 1–5a, which
  // have their own proof and their own writable actions. But an empty roster must never
  // read as "you have no bundled skills": the load error travels into the verdict.
  const roster = loadBundledSkillsOrEmpty('/no/such/bundled-skills.json');
  assert.equal(roster.size, 0);
  assert.match(roster.error, /could not read/);

  const corpus = corpusOf({ dataviz: 1157 }, [], 3, { bundled: roster });
  const bulk = bundledBulkVerdict(corpus);
  assert.equal(bulk.offered, false);
  assert.match(bulk.reason, /unreadable/, 'the reader is told ccsnoop could not check');
  assert.match(bulk.reason, /could not read/);
});

test('a healthy roster carries its provenance into the verdict', () => {
  // `readOn` is the staleness story: on a build newer than the roster the population may be
  // incomplete, and quoting where the list came from is the mitigation.
  const bulk = bundledBulkVerdict(corpusOf({ dataviz: 1157 }, [], 3, { bundled: loadBundledSkillsOrEmpty() }));
  assert.equal(bulk.offered, true);
  assert.ok(bulk.roster.readOn.length > 0);
  assert.match(bulk.roster.source, /bundled-skills\.json$/);
  assert.equal(bulk.roster.error, null);
});

test('the roster override path is reported, never the default one it did not read', () => {
  const roster = loadBundledSkills(BUNDLED_SKILLS_PATH);
  assert.equal(roster.source, BUNDLED_SKILLS_PATH, 'a report must not cite a file it did not read');
});
