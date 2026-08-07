// Fine-tune: the skills-catalog lever — `skillOverrides: name-only` on the skills the
// model never invoked (ADR-0005 lever 5a, issue #118), and its advice-tier half (lever
// 5b, issue #119): the plugin skills and the bundled bulk, measured and exposed, never
// written.
//
// The skills catalog is routinely the largest single line item of the turn-1 floor: every
// skill ships its name AND its full description on every request. Issue #109 gave it a
// name in `floor`, #116 made it a lever of the shared classifier, #117 made its bytes
// billable on the message surface it rides. This module is the lever itself.
//
//   shipped(skill) = the turn-1 skills catalog lists it (any request of the session).
//   invoked(skill) = a `Skill` tool_use in a RESPONSE names it in its `skill` argument.
//
// Three things follow from ADR-0005 and none of them is negotiable here:
//
//   • **The action is `name-only`, never `off`.** The name (~15 B) stays in the catalog,
//     the description — the dominant term — stops shipping. The skill stays fully
//     invocable: `/name` still works (measured, not assumed — see
//     docs/research/skill-overrides-name-only.md §5bis), and so does an explicit "use the
//     X skill". Only unprompted discoverability degrades. That is what bounds the false
//     positive, and boundedness is what admits the lever to the safe tier.
//
//   • **The disuse predicate is MODEL invocation.** A `/name` the user typed is not a
//     `tool_use` and cannot count — sound precisely because `name-only` leaves `/name`
//     intact, so a slash-only skill is one whose description bought nothing. Strictly more
//     permissive than sent-vs-used, and still safe. (`skillUsage` in `~/.claude.json` is
//     rejected as a source: global across projects, unknown depth, and it counts `/name`.)
//
//   • **The guard is the MCP lever's, verbatim**: `sessionCount >= 3`, never in
//     single-session mode, binary on absence. Same evidence shape ⇒ no new threshold.
//
// Reach. A `skillOverrides` entry cannot reach a PLUGIN skill — Claude Code's resolver
// returns "on" for `source === "plugin"` before reading settings at all (ADR-0005 fact 2).
// On the wire a plugin skill is listed under its qualified `plugin:skill` name, so any
// name carrying a scope qualifier is reported with its cost and left OUT of the diff: the
// entry would be an action that silently does nothing. Directory-scoped skills are listed
// qualified too and are excluded by the same rule — a conservative miss, never a phantom
// write, and plugin skills are lever 5b's (advice-tier) territory.
//
// Lever 5b (issue #119) is the same evidence with no bounded action behind it, so it
// produces FIGURES and no settings write:
//
//   • **Plugin skills** ({@link pluginSkillGroups}) — grouped by their scope qualifier,
//     per plugin and per skill, naming which ones the model did reach. The only knob is
//     `enabledPlugins`, which cuts the whole plugin including the parts in active use, so
//     the report hands the user the two halves and stops there.
//   • **The bundled bulk** ({@link bundledBulkVerdict}) — `disableBundledSkills`, offered
//     ONLY when the entire bundled population shows no model invocation. One invoked
//     bundled skill and the all-or-nothing gesture costs more than it returns, and lever
//     5a's per-name `name-only` applies instead (a `skillOverrides` entry DOES reach a
//     bundled skill — ADR-0005 fact 3). It also removes `/name` on every bundled skill,
//     not just the descriptions (ADR-0005 amendment, correction 2), which is why the
//     verdict ships a caveat rather than a byte figure alone.
//
// Neither figure enters `totals.recoverable`: the bundled bulk overlaps lever 5a's
// population by construction (same entries, harsher action), and the plugin figure prices
// an action whose real cost — losing the plugin's working skills — is not in bytes.
//
// Bundled is a NAME test. A capture carries names and descriptions, never a `source`
// marker, so the population is identified against a versioned roster
// (`data/bundled-skills.json`), exactly as the built-in tools lever is identified against
// `data/builtin-denylist.json`. A name absent from the roster is "not known to be
// bundled", never "not bundled" — hence the verdict always NAMES every skill it would
// drop, so a reader recognizes their own before acting.
//
// Bytes. Per-skill figures are the RAW entry bytes `floor --detail` ranks on (the
// `parseCatalogEntries` basis), so the lever and the floor's detail view agree line for
// line. They are a LOWER BOUND on what the block loses: the block is measured as escaped
// JSON, and a description full of quotes loses more canonical bytes than raw ones (#115
// measured 1 843 canonical against 1 807 raw). Under-promising is the right direction for
// a figure a user will check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eachRequestBody } from './report.js';
import { calledToolSet } from './finetune-response.js';
import { classifySystemSpans, blockText, walkTextBlocks, SKILLS_CATALOG } from './finetune-system.js';
import { parseCatalogEntries } from './floor-catalog.js';
import { MCP_GUARD_MIN_SESSIONS } from './finetune-mcp.js';

/**
 * The minimum corpus size before "never invoked" is trusted enough to act. Aliased from
 * the MCP lever rather than redeclared — ADR-0005 decision 5 reuses that guard verbatim,
 * and one constant makes that structural instead of a coincidence that can drift.
 */
export const SKILLS_GUARD_MIN_SESSIONS = MCP_GUARD_MIN_SESSIONS;

/**
 * The only value this lever ever emits (ADR-0005 decision 1) — the ACTION, as distinct from
 * {@link SKILL_OVERRIDE_ENUM}, which is what settings.json will *accept*. `off` and
 * `user-invocable-only` take the skill out of the model's reach: an unbounded action the safe
 * tier may not take, whatever the evidence.
 */
export const SKILL_OVERRIDE_ACTION = 'name-only';

/**
 * The four-member enum `settings.json` accepts for a `skillOverrides` value, in the
 * schema's own order (read verbatim off the Claude Code binary on both 2.1.220 and
 * 2.1.224 — docs/research/skill-overrides-name-only.md §1). `apply` validates against
 * this: the "refuse foreign keys" guarantee extends to refusing foreign VALUES, and the
 * one spelling of the enum lives with the lever that knows it.
 */
export const SKILL_OVERRIDE_ENUM = /** @type {const} */ (['on', 'name-only', 'user-invocable-only', 'off']);

/**
 * The only action a plugin skill has behind it (ADR-0005 fact 2). Named so the report can
 * say what the user's option IS; `ccsnoop apply` has no branch for it and must never grow
 * one — cutting a plugin takes down its working skills with its dead ones.
 */
export const PLUGIN_ACTION = 'enabledPlugins';

/** The bulk action of lever 5b — advice tier, all-or-nothing over the bundled population. */
export const BUNDLED_BULK_ACTION = 'disableBundledSkills';

/**
 * What the bulk costs beyond the descriptions, in the words the verdict carries. Measured,
 * not inferred: `disableBundledSkills: true` drops the bundled skills from the slash-command
 * inventory as well as the model's (docs/research/skill-overrides-name-only.md §5), which
 * consequence 5 of ADR-0005 originally understated — hence the amendment's correction 2.
 */
export const BUNDLED_BULK_CAVEAT =
  'disableBundledSkills removes the bundled skills entirely — you lose /name on each of ' +
  'them too, not just their descriptions. Per-skill name-only (lever 5a) keeps /name.';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default location of the versioned bundled-skills roster (the population `disableBundledSkills` drops). */
export const BUNDLED_SKILLS_PATH = path.join(PKG_ROOT, 'data', 'bundled-skills.json');

/**
 * @typedef {object} BundledRoster
 * @property {Set<string>} names  The bundled skill names, as the catalog lists them.
 * @property {string[]} readOn    The Claude Code versions the roster was read on (provenance —
 *                                a reader on a newer build needs it to judge staleness).
 * @property {number} size        `names.size`, so a report can quote the roster without walking it.
 * @property {string} source      The file it actually came from — the override path when one was
 *                                given, so a report can never cite a file it did not read.
 */

/**
 * Load and shape-validate the bundled-skills roster. Same discipline as
 * {@link module:finetune.loadBuiltinDenylist}: the FILE is the source of truth, and any
 * shape violation throws rather than yielding a short list — a roster that silently
 * narrowed would turn the bulk verdict off with no explanation, which reads exactly like
 * "your bundled skills cost nothing".
 *
 * Callers that must not be taken down by an advice-tier data file use
 * {@link loadBundledSkillsOrEmpty}, which converts the throw into an empty roster the bulk
 * verdict then EXPLAINS. There is no silent middle path.
 *
 * @param {string} [rosterPath]
 * @returns {BundledRoster}
 */
export function loadBundledSkills(rosterPath = BUNDLED_SKILLS_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read bundled-skills roster at ${rosterPath}: ${err?.message ?? err}`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.skills)) {
    throw new Error(`bundled-skills roster at ${rosterPath} has no 'skills' array`);
  }
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < raw.skills.length; i++) {
    const entry = raw.skills[i];
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`bundled-skills roster entry #${i} has no non-empty 'name'`);
    }
    names.add(entry.name);
  }
  const readOn = Array.isArray(raw.readOn) ? raw.readOn.filter((v) => typeof v === 'string') : [];
  return { names, readOn, size: names.size, source: rosterPath };
}

/**
 * The roster, or an EMPTY one carrying the load error. Lever 5b is advice tier: its data
 * file must not be able to take down levers 1–5a, which have their own proof and their own
 * (writable) actions. So `fine-tune` degrades here instead of aborting — and the failure is
 * not swallowed: `error` travels into the bulk verdict's `reason`, which is surfaced, so an
 * unreadable roster reads as "ccsnoop could not check" and never as "nothing is bundled".
 *
 * @param {string} [rosterPath]
 * @returns {BundledRoster & { error: string | null }}
 */
export function loadBundledSkillsOrEmpty(rosterPath = BUNDLED_SKILLS_PATH) {
  try {
    return { ...loadBundledSkills(rosterPath), error: null };
  } catch (err) {
    return { names: new Set(), readOn: [], size: 0, source: rosterPath, error: String(err?.message ?? err) };
  }
}

/**
 * @typedef {object} SkillSessionProfile
 * @property {string} sessionId
 * @property {Map<string, number>} shipped  Skill name → the bytes its catalog entry cost
 *                                          (max across the session's requests).
 * @property {Set<string>} invoked          Skill names the MODEL invoked (`Skill` tool_use).
 */

/**
 * @typedef {object} SkillVerdict
 * @property {string} name              The catalog name — the key `skillOverrides` takes.
 * @property {string} skill             The name with its scope qualifier stripped (== `name`
 *                                      when unqualified) — how a plugin's own skill is called.
 * @property {number} bytes             The entry's raw byte cost (max across the corpus).
 * @property {number} shippedSessions   Sessions whose catalog listed this skill.
 * @property {number} invokedCount      Sessions in which the MODEL invoked it (≥1 tool_use).
 * @property {boolean} reachable        False for a scope-qualified name — no `skillOverrides`
 *                                      entry reaches a plugin skill (ADR-0005 fact 2).
 * @property {string | null} scope      The name's scope qualifier (`plugin` in `plugin:skill`),
 *                                      null when unqualified. Lever 5b groups on it.
 * @property {'plugin' | 'directory' | null} scopeKind  Which kind of scope that is — only a
 *                                      `plugin` has `enabledPlugins` behind it.
 * @property {boolean} bundled          The name is on the bundled roster AND unqualified —
 *                                      i.e. in the population `disableBundledSkills` drops.
 * @property {boolean} override         True iff reachable AND `sessionCount >= 3` AND
 *                                      `invokedCount === 0` (and not single-session) → emit
 *                                      `{ "<name>": "name-only" }`.
 */

/**
 * @typedef {object} SkillCorpus
 * @property {number} sessionCount      Sessions aggregated (the guard's denominator).
 * @property {boolean} singleSession    True iff the run is single-session (verdict forced off).
 * @property {SkillVerdict[]} skills    Every skill the corpus shipped and/or invoked, ranked
 *                                      bytes-descending then by name (ADR-0005 decision 6).
 * @property {RosterInfo} [roster]      Provenance of the bundled roster this corpus was stamped
 *                                      against. Absent/size 0 = none supplied, which is why
 *                                      nothing was marked bundled.
 */

/**
 * @typedef {object} RosterInfo
 * @property {number} size          Names the roster held.
 * @property {string | null} source The file it came from, or null when none was supplied.
 * @property {string[]} readOn      Claude Code versions it was read on — the staleness story, and
 *                                  the reason the verdict names its whole population.
 * @property {string | null} error  Why the roster is empty, when it failed to load.
 */

/** The corpus of a run that captured no skills catalog — the renderer's no-op input. */
export const EMPTY_SKILL_CORPUS = /** @type {SkillCorpus} */ ({
  sessionCount: 0,
  singleSession: false,
  skills: [],
  roster: { size: 0, source: null, readOn: [], error: null },
});

/**
 * The bytes a `name-only` entry still costs on the wire: exactly `- <name>\n` (measured —
 * `dataviz` fell to 10 B, `- dataviz\n`, #115 §6). The residue the lever can never
 * recover, so every recovered-bytes figure subtracts it.
 * @param {string} name
 * @returns {number}
 */
export function nameOnlyBytes(name) {
  return Buffer.byteLength(`- ${name}\n`, 'utf8');
}

/**
 * The scope qualifier of a catalog name, and what kind of scope it is — the ONE reading of
 * the colon, so "can a `skillOverrides` entry reach this name" (`scope === null`, the 5a
 * question) and "which plugin does it belong to" (the 5b question) can never disagree.
 * A scope-qualified name is how the catalog lists a plugin skill, and the resolver ignores
 * overrides for those — see the module header on why directory-scoped names share the
 * exclusion.
 *
 * `plugin:skill` →
 * `{ scope: 'plugin', kind: 'plugin', skill: 'skill' }`; `apps/web:deploy` →
 * `{ scope: 'apps/web', kind: 'directory', skill: 'deploy' }`; an unqualified name → all
 * three null/itself.
 *
 * The plugin/directory discriminator is a path separator in the scope. It matters because
 * only a PLUGIN has an action behind it (`enabledPlugins`) — no settings key disables a
 * directory scope, so calling one a plugin would offer a knob that does not exist for it.
 * A single-segment directory scope (`web:deploy`) is indistinguishable from a plugin on
 * the wire and reads as one; the cost of that miss is a mislabelled REPORT line, never a
 * wrong write, because nothing on this side of the lever writes anything.
 *
 * The scope is everything before the FIRST colon: a nested qualifier is the plugin's, and
 * grouping by the outermost is what makes `enabledPlugins <plugin>` the right sentence.
 *
 * @param {string} name
 * @returns {{ scope: string | null, kind: 'plugin' | 'directory' | null, skill: string }}
 */
function parseScope(name) {
  const i = name.indexOf(':');
  if (i < 0) return { scope: null, kind: null, skill: name };
  const scope = name.slice(0, i);
  return { scope, kind: /[/\\]/.test(scope) ? 'directory' : 'plugin', skill: name.slice(i + 1) };
}

/**
 * The skills a parsed request body ships, and what each costs: the `skills-catalog` spans
 * of every text block, parsed into their entries. Detection is the ONE authority
 * (`classifySystemSpans`, #116) and the entry split is the ONE parser
 * (`parseCatalogEntries`, the path `floor --detail` uses), so a skill's bytes here are the
 * same bytes the floor's detail view ranks — no second catalog parser exists.
 *
 * A skill listed twice in one request keeps its LARGEST entry: the figure answers "what
 * does this description cost when it ships", and a truncated re-listing is not that.
 * Null-safe; a body with no catalog yields an empty map.
 *
 * @param {any} body  Parsed request JSON (null-safe).
 * @returns {Map<string, number>}  Skill name → entry bytes, in first-seen order.
 */
export function skillCatalogEntries(body) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const { block, surface } of walkTextBlocks(body)) {
    if (!blockText(block)) continue;
    for (const span of classifySystemSpans(block, { surface })) {
      if (span.lever !== SKILLS_CATALOG) continue;
      for (const entry of parseCatalogEntries(SKILLS_CATALOG, span.text)) {
        const seen = out.get(entry.name);
        if (seen === undefined || entry.bytes > seen) out.set(entry.name, entry.bytes);
      }
    }
  }
  return out;
}

/**
 * The skills profile of ONE captured session: the catalog it shipped (max entry bytes
 * across its requests) and the skills the MODEL invoked.
 *
 * Ships are read straight from the request blobs, through the same `eachRequestBody` walk
 * the MCP lever's shipped half uses (`loadSession` keeps only derived segments, not the
 * system text). Invocations reuse the one response decoder (`calledToolSet(...).skills`,
 * which reassembles the `Skill` call's arguments). Both degrade, never throw, on a
 * corrupt/truncated capture: a half-written turn contributes nothing rather than taking the
 * verdict down. The only hard error is a session dir with no readable `manifest.jsonl` (a
 * caller mistake).
 *
 * @param {string} dir  The `sessions/<session_id>/` directory.
 * @param {string} [id] Session id (defaults to the dir's basename).
 * @returns {SkillSessionProfile}
 */
export function sessionSkillProfile(dir, id = path.basename(dir)) {
  /** @type {Map<string, number>} */
  const shipped = new Map();
  for (const body of eachRequestBody(dir)) {
    for (const [name, bytes] of skillCatalogEntries(body)) {
      const seen = shipped.get(name);
      if (seen === undefined || bytes > seen) shipped.set(name, bytes);
    }
  }

  return { sessionId: id, shipped, invoked: calledToolSet(dir, id).skills };
}

/**
 * Aggregate per-session skill profiles into a corpus verdict with the T4 guard applied.
 * Pure — give it the profiles, get back the verdict; this is what the multi-session guard
 * tests exercise directly.
 *
 * Each profile is `{ shipped?: Map<string, number> | Iterable<[string, number]>,
 * invoked?: Iterable<string> }`. `invokedCount` counts SESSIONS that invoked the skill
 * (the profile's `invoked` is a distinct set), and the verdict is binary on absence:
 * invoked in any session ⇒ used ⇒ never overridden. A skill's `bytes` is the MAX across
 * the corpus, for the same reason it is per session — the cost when the description ships.
 *
 * `opts.bundled` is the roster of names Claude Code ships itself — either a
 * {@link BundledRoster} ({@link loadBundledSkills}) or a bare iterable of names. It only
 * STAMPS each verdict (`bundled`) for lever 5b to read; it never changes a 5a verdict,
 * because a `skillOverrides` entry reaches a bundled skill exactly like a user or project
 * one (ADR-0005 fact 3). Absent ⇒ nothing is marked bundled, and the bulk verdict says so
 * rather than reading absence of a roster as absence of bundled skills.
 *
 * @param {Array<{ shipped?: any, invoked?: Iterable<string>, sessionId?: string } | null | undefined>} profiles
 * @param {{ singleSession?: boolean,
 *   bundled?: Iterable<string> | (BundledRoster & { error?: string | null }) }} [opts]
 * @returns {SkillCorpus}
 */
export function aggregateSkillCorpus(profiles, opts = {}) {
  const singleSession = Boolean(opts.singleSession);
  // Either shape is accepted: a full roster carries its provenance into the corpus, a bare
  // name list (what the aggregator's own unit tests pass) gets an anonymous one.
  const supplied = /** @type {any} */ (opts.bundled);
  const names = supplied?.names instanceof Set ? supplied.names : new Set(supplied ?? []);
  /** @type {RosterInfo} */
  const roster = {
    size: names.size,
    source: supplied?.source ?? null,
    readOn: supplied?.readOn ?? [],
    error: supplied?.error ?? null,
  };
  // A hole in the list is not a session: `sessionCount` is the guard's denominator, so
  // counting one would let the verdict fire on less evidence than it requires.
  const list = (Array.isArray(profiles) ? profiles : []).filter(Boolean);
  const sessionCount = list.length;

  /** @type {Map<string, { bytes: number, shippedSessions: number, invokedCount: number }>} */
  const acc = new Map();
  const touch = (name) => {
    let e = acc.get(name);
    if (!e) {
      e = { bytes: 0, shippedSessions: 0, invokedCount: 0 };
      acc.set(name, e);
    }
    return e;
  };
  for (const p of list) {
    for (const [name, bytes] of p.shipped ?? []) {
      const e = touch(name);
      e.shippedSessions += 1;
      if (bytes > e.bytes) e.bytes = bytes;
    }
    // A skill invoked but never seen in a catalog still gets a row (bytes 0): it is used,
    // so it can never be overridden, and hiding it would read as "not shipped at all".
    for (const name of p.invoked ?? []) touch(name).invokedCount += 1;
  }

  const guarded = isGuarded({ sessionCount, singleSession });
  /** @type {SkillVerdict[]} */
  const skills = [...acc.entries()]
    .map(([name, e]) => {
      const { scope, kind, skill } = parseScope(name);
      // Reachable ≡ unqualified, by construction: `parseScope` is the one place the colon
      // is read, so the 5a diff and the 5b grouping cannot drift apart.
      const reachable = scope === null;
      return {
        name,
        skill,
        bytes: e.bytes,
        shippedSessions: e.shippedSessions,
        invokedCount: e.invokedCount,
        reachable,
        scope,
        scopeKind: kind,
        // A qualified name can never be bundled, whatever a stale roster says about its
        // short name: `disableBundledSkills`' own describe string exempts plugins,
        // `.claude/skills/` and `.claude/commands/`.
        bundled: scope === null && names.has(name),
        override: reachable && guarded && e.invokedCount === 0,
      };
    })
    // Bytes-descending — the diff leads with what it recovers (ADR-0005 decision 6). Name
    // breaks the tie so the emitted block is stable run to run (readdir order is not).
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return { sessionCount, singleSession, skills, roster };
}

/**
 * True when the corpus has the evidence the guard demands — the ONE reading of it, shared
 * by lever 5a's per-skill verdict and lever 5b's bulk. Same evidence shape, same threshold
 * (ADR-0005 decision 5), so this cannot drift between the two halves of lever 5.
 * @param {{ sessionCount: number, singleSession?: boolean } | null | undefined} corpus
 * @returns {boolean}
 */
function isGuarded(corpus) {
  return Boolean(corpus) && !corpus.singleSession && corpus.sessionCount >= SKILLS_GUARD_MIN_SESSIONS;
}

/**
 * @typedef {object} PluginSkillRow
 * @property {string} name          The catalog name, qualifier included (`plugin:skill`).
 * @property {string} skill         The short name inside the plugin.
 * @property {number} bytes         The entry's raw byte cost.
 * @property {number} shippedSessions
 * @property {number} invokedCount  Sessions in which the MODEL invoked it.
 * @property {boolean} invoked      `invokedCount > 0` — the half that makes cutting the plugin cost something.
 */

/**
 * @typedef {object} PluginSkillGroup
 * @property {string} plugin        The scope qualifier — what `enabledPlugins` would name.
 * @property {'plugin' | 'directory'} kind
 * @property {string | null} action `enabledPlugins` for a plugin; null for a directory scope,
 *                                  which no settings key disables.
 * @property {number} shippedSkills
 * @property {number} invokedSkills Skills of this scope the model DID reach.
 * @property {number} bytes         What the scope costs on every turn 1 (Σ entry bytes) — and
 *                                  what disabling the plugin actually recovers, ALL of it.
 * @property {number} deadBytes     Σ entry bytes over the never-invoked skills: the part of
 *                                  `bytes` that could be recovered without losing a skill the
 *                                  model uses. The gap between the two IS the price of the
 *                                  action, which is why both are reported.
 * @property {PluginSkillRow[]} skills  Ranked bytes-descending, then by name.
 */

/**
 * Lever 5b, point 1 — the plugin signalement, per plugin AND per skill (issue #119).
 *
 * A scope-qualified name is out of `skillOverrides`' reach, so lever 5a leaves it out of
 * the diff. This is where it resurfaces with its cost: which skills the scope shipped,
 * which ones the model actually reached, and how many bytes the rest are worth. The user
 * decides `enabledPlugins`; ccsnoop never writes it, because the action is whole-plugin
 * and would take the invoked skills down with the dead ones.
 *
 * Groups rank by `deadBytes` — the report leads with the biggest cost nothing is acting
 * on. Pure; a null/empty corpus yields `[]`.
 *
 * @param {SkillCorpus | null | undefined} corpus
 * @returns {PluginSkillGroup[]}
 */
export function pluginSkillGroups(corpus) {
  /** @type {Map<string, PluginSkillGroup>} */
  const groups = new Map();
  for (const s of corpus?.skills ?? []) {
    if (s.scope == null) continue;
    let g = groups.get(s.scope);
    if (!g) {
      g = {
        plugin: s.scope,
        kind: /** @type {'plugin' | 'directory'} */ (s.scopeKind),
        action: s.scopeKind === 'plugin' ? PLUGIN_ACTION : null,
        shippedSkills: 0,
        invokedSkills: 0,
        bytes: 0,
        deadBytes: 0,
        skills: [],
      };
      groups.set(s.scope, g);
    }
    const invoked = s.invokedCount > 0;
    g.shippedSkills += 1;
    if (invoked) g.invokedSkills += 1;
    g.bytes += s.bytes;
    // The WHOLE entry, name included: `enabledPlugins` removes the skill, it does not
    // trim it to `- <name>` the way `name-only` does. There is no residue to subtract.
    // This is the LOSS-FREE part of `bytes`, not the recovery — disabling recovers `bytes`
    // and takes the invoked skills with it. Both figures are reported for exactly that reason.
    if (!invoked) g.deadBytes += s.bytes;
    g.skills.push({
      name: s.name,
      skill: s.skill,
      bytes: s.bytes,
      shippedSessions: s.shippedSessions,
      invokedCount: s.invokedCount,
      invoked,
    });
  }
  for (const g of groups.values()) g.skills.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return [...groups.values()].sort((a, b) => b.deadBytes - a.deadBytes || a.plugin.localeCompare(b.plugin));
}

/**
 * @typedef {object} BundledBulkVerdict
 * @property {boolean} offered      True iff the bulk is worth showing as an option.
 * @property {'disableBundledSkills'} action
 * @property {string[]} names       Every bundled skill it would drop, ranked bytes-descending.
 *                                  Populated whether or not it is offered — the reader needs
 *                                  to see the population to judge the roster.
 * @property {number} bytes         Σ WHOLE entry bytes of those skills (the bulk removes them).
 * @property {number} invokedSkills Bundled skills the model DID reach — nonzero kills the offer.
 * @property {RosterInfo} roster    Provenance of the roster the population was read against —
 *                                  its size, its file, the builds it was read on, and why it is
 *                                  empty if it failed to load.
 * @property {number} sessionCount  The guard's denominator, echoed so a consumer reading only
 *                                  this verdict can judge the evidence behind it.
 * @property {boolean} singleSession
 * @property {string} reason        Why it is or is not offered, in one sentence.
 * @property {string} caveat        What it costs beyond the descriptions ({@link BUNDLED_BULK_CAVEAT}).
 */

/**
 * Lever 5b, point 2 — the bundled bulk (issue #119).
 *
 * `disableBundledSkills` is offered ONLY when the ENTIRE bundled population shows no model
 * invocation. One invoked bundled skill and the all-or-nothing gesture costs more than it
 * returns: from that point it is lever 5a's per-name `name-only` that applies, and a
 * `skillOverrides` entry reaches a bundled skill just as it reaches a project one
 * (ADR-0005 fact 3). The corpus guard is the same one 5a uses — the harshest action in the
 * lever may not fire on evidence the gentlest one is refused.
 *
 * Advice tier throughout: this returns a figure and a caveat, never a settings write.
 * Pure; a null/empty corpus yields an un-offered verdict rather than throwing.
 *
 * ⚠ **The offer is only as complete as the roster.** Bundled is a NAME test, so a bundled
 * skill from a newer build — absent from the roster and invoked — does not block the offer.
 * That gap cannot be closed from a capture (the wire carries no `source` marker), so it is
 * mitigated rather than hidden: the verdict NAMES its whole population and carries the
 * roster's provenance, which is what lets a reader on a newer build catch the drift before
 * acting. This is also half of why the bulk is advice tier and not safe.
 *
 * @param {SkillCorpus | null | undefined} corpus
 * @returns {BundledBulkVerdict}
 */
export function bundledBulkVerdict(corpus) {
  const bundled = (corpus?.skills ?? []).filter((s) => s.bundled);
  const invokedSkills = bundled.filter((s) => s.invokedCount > 0).length;
  const roster = corpus?.roster ?? { size: 0, source: null, readOn: [], error: null };
  const base = {
    action: /** @type {'disableBundledSkills'} */ (BUNDLED_BULK_ACTION),
    names: bundled.map((s) => s.name), // the corpus is already bytes-descending
    bytes: bundled.reduce((sum, s) => sum + s.bytes, 0),
    invokedSkills,
    roster,
    sessionCount: corpus?.sessionCount ?? 0,
    singleSession: Boolean(corpus?.singleSession),
    caveat: BUNDLED_BULK_CAVEAT,
  };

  if (bundled.length === 0) {
    // An unreadable roster is NOT "you have no bundled skills": it is "ccsnoop could not
    // check". Saying which is the whole reason the load error travels this far.
    const reason = roster.error
      ? `bundled-skills roster unreadable, so nothing could be checked — ${roster.error}`
      : roster.size === 0
        ? 'no bundled-skills roster was supplied — nothing is claimed bundled (absence of proof, not proof of absence)'
        : `no known-bundled skill shipped in this corpus (roster: ${roster.size} names)`;
    return { ...base, offered: false, reason };
  }
  if (!isGuarded(corpus)) {
    const reason = corpus?.singleSession
      ? 'single-session scope — the bulk never fires on one session'
      : `${corpus?.sessionCount ?? 0}/${SKILLS_GUARD_MIN_SESSIONS} sessions of evidence — too thin for an all-or-nothing action`;
    return { ...base, offered: false, reason };
  }
  if (invokedSkills > 0) {
    return {
      ...base,
      offered: false,
      reason: `${invokedSkills} bundled skill(s) were model-invoked — per-name name-only (lever 5a) applies instead`,
    };
  }
  return {
    ...base,
    offered: true,
    reason: `all ${bundled.length} known-bundled skills shipped across ${corpus.sessionCount} sessions and none was model-invoked`,
  };
}

/**
 * The `skillOverrides` map the lever emits — every qualifying skill in one diff, each set
 * to `name-only`. Empty when nothing qualifies (the caller then omits the key entirely
 * rather than writing an empty map).
 * @param {SkillCorpus} corpus
 * @returns {Record<string, string>}
 */
export function skillOverrideMap(corpus) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const s of corpus?.skills ?? []) {
    if (s.override) out[s.name] = SKILL_OVERRIDE_ACTION;
  }
  return out;
}

/**
 * The bytes the emitted map would stop shipping: Σ (entry bytes − its `- <name>\n`
 * residue) over the qualifying skills. Never negative — a skill already listed at
 * `name-only` has nothing left to cut, and reporting a negative recovery would be worse
 * than reporting zero. Raw entry bytes, so a lower bound on the canonical loss (see the
 * module header).
 * @param {SkillCorpus} corpus
 * @returns {number}
 */
export function skillRecoverableBytes(corpus) {
  let total = 0;
  for (const s of corpus?.skills ?? []) {
    if (s.override) total += Math.max(0, s.bytes - nameOnlyBytes(s.name));
  }
  return total;
}
