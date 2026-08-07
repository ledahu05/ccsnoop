// Fine-tune: the skills-catalog lever — `skillOverrides: name-only` on the skills the
// model never invoked (ADR-0005 lever 5a, issue #118).
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
// Bytes. Per-skill figures are the RAW entry bytes `floor --detail` ranks on (the
// `parseCatalogEntries` basis), so the lever and the floor's detail view agree line for
// line. They are a LOWER BOUND on what the block loses: the block is measured as escaped
// JSON, and a description full of quotes loses more canonical bytes than raw ones (#115
// measured 1 843 canonical against 1 807 raw). Under-promising is the right direction for
// a figure a user will check.

import path from 'node:path';

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
 * @typedef {object} SkillSessionProfile
 * @property {string} sessionId
 * @property {Map<string, number>} shipped  Skill name → the bytes its catalog entry cost
 *                                          (max across the session's requests).
 * @property {Set<string>} invoked          Skill names the MODEL invoked (`Skill` tool_use).
 */

/**
 * @typedef {object} SkillVerdict
 * @property {string} name              The catalog name — the key `skillOverrides` takes.
 * @property {number} bytes             The entry's raw byte cost (max across the corpus).
 * @property {number} shippedSessions   Sessions whose catalog listed this skill.
 * @property {number} invokedCount      Sessions in which the MODEL invoked it (≥1 tool_use).
 * @property {boolean} reachable        False for a scope-qualified name — no `skillOverrides`
 *                                      entry reaches a plugin skill (ADR-0005 fact 2).
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
 */

/** The corpus of a run that captured no skills catalog — the renderer's no-op input. */
export const EMPTY_SKILL_CORPUS = /** @type {SkillCorpus} */ ({ sessionCount: 0, singleSession: false, skills: [] });

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
 * Is this a name a `skillOverrides` entry can reach? A scope-qualified name
 * (`plugin:skill`) is how the catalog lists a plugin skill, and the resolver ignores
 * overrides for those — see the module header on why directory-scoped names share the
 * exclusion.
 * @param {string} name
 * @returns {boolean}
 */
function isReachable(name) {
  return !name.includes(':');
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
 * @param {Array<{ shipped?: any, invoked?: Iterable<string>, sessionId?: string } | null | undefined>} profiles
 * @param {{ singleSession?: boolean }} [opts]
 * @returns {SkillCorpus}
 */
export function aggregateSkillCorpus(profiles, opts = {}) {
  const singleSession = Boolean(opts.singleSession);
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

  const guarded = !singleSession && sessionCount >= SKILLS_GUARD_MIN_SESSIONS;
  /** @type {SkillVerdict[]} */
  const skills = [...acc.entries()]
    .map(([name, e]) => {
      const reachable = isReachable(name);
      return {
        name,
        bytes: e.bytes,
        shippedSessions: e.shippedSessions,
        invokedCount: e.invokedCount,
        reachable,
        override: reachable && guarded && e.invokedCount === 0,
      };
    })
    // Bytes-descending — the diff leads with what it recovers (ADR-0005 decision 6). Name
    // breaks the tie so the emitted block is stable run to run (readdir order is not).
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return { sessionCount, singleSession, skills };
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
