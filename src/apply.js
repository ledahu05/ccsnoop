// Tiered-apply glue (issue #98, epic #94) — turns `fine-tune --json`'s lever
// verdicts into action under **ADR-0004's two-tier authority**:
//
//   • safe   (tools, mcp, skills) — carry DYNAMIC PROOF (a pre-validated
//     denylist; sent-vs-used across a corpus; shipped-but-never-model-invoked skills).
//     Auto-writable on approval.
//   • advice (hooks, claudeMd)   — NO dynamic proof (injected every session by
//     construction). Paste-only — surfaced for the human, NEVER written.
//
// `apply` consumes the contract's `settings.auto` (safe) / `settings.advice`
// (advice) split directly — it does not re-derive tiers (the contract already
// serialized the distinction, issue #95). It presents a DIFF of the proposed
// safe-subset `settings.json` changes; on explicit approval, writes them via an
// idempotent read-modify-write merge extracted from `init`'s strict pattern;
// emits the advice levers as a paste-only block; and emits a restart reminder
// after any write.
//
// Non-negotiables (ADR-0004 + spec §3): merge, never overwrite; refuse
// foreign/unknown keys (the advice tier must never slip into a write); never
// touch `.ccsnoop/` capture data; output for the advice tier is paste-only.
//
// Since issue #118 the safe subset holds one MAP-valued key, `skillOverrides` (ADR-0005
// lever 5a), so "merge, never overwrite" gained a second shape and one new invariant:
// refusing foreign keys extends to refusing foreign VALUES (the four-member enum), and an
// entry the user already set is never rewritten — `off` is stricter than `name-only`, and
// the merge only ever adds.

import path from 'node:path';

import { readJsonStrict, writeJson } from './init.js';
import { assertNotUnderCcsnoop } from './guard.js';
import { SKILL_OVERRIDE_ENUM } from './finetune-skills.js';

/** The settings keys apply is allowed to write (the ADR-0004 safe subset). */
const SAFE_TOP_KEYS = ['permissions', 'disabledMcpjsonServers', 'skillOverrides'];
/** `permissions` may carry only `deny` — never `allow`/`ask`/`defaultMode`/…. */
const SAFE_PERM_KEYS = ['deny'];

/** Printed after a write — settings changes recompile the shipped tool set. */
const RESTART_REMINDER = 'restart Claude Code — settings changes recompile the shipped tool set next session';

/**
 * An apply-level failure with a user-facing message (no stack noise). The CLI
 * prints `.message` to stderr and exits non-zero — same shape as
 * {@link module:init.InitError}.
 */
export class ApplyError extends Error {}

/**
 * The settings file apply targets: `<cwd>/.claude/settings.json` — the
 * committed PROJECT settings (fine-tune's paste-ready block is for these), not
 * `init`'s `settings.local.json` (which holds the env-routing env block).
 * @param {string} [cwd]
 * @returns {string}
 */
export function defaultSettingsFile(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'settings.json');
}

/**
 * Refuse a path inside a `.ccsnoop/` capture tree — capture data is inviolable
 * (ADR-0004; mirrors `init`'s "never touch captured data"). Guards a manual
 * `--settings` override from pointing into the capture root. Shared with
 * `ccsnoop skill install` via {@link module:guard.assertNotUnderCcsnoop}, which
 * both writers call with their own Error subclass and noun.
 * @param {string} file
 */
function assertSettingsNotUnderCcsnoop(file) {
  assertNotUnderCcsnoop(file, ApplyError, 'settings');
}

/**
 * Validate and dedupe an incoming list of names. A shape we could not write
 * verbatim into settings.json (a bare string, a nested object, a number) is
 * REFUSED rather than silently skipped — a malformed report must never read as
 * "nothing to do". Duplicates are collapsed here, so a report that repeats a
 * name cannot append it twice.
 * @param {any} list
 * @param {string} label  The settings path, for the error message.
 * @returns {string[]}
 */
function safeNames(list, label) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some((n) => typeof n !== 'string')) {
    throw new ApplyError(`${label} must be an array of strings`);
  }
  return [...new Set(list)];
}

/**
 * Union `incoming` into the array at `container[key]`, existing-first, mutating
 * `container` (always a clone by the time we get here). Returns the names
 * actually added, or `null` when the union is already complete.
 *
 * An existing value that is present but not an array is REFUSED: replacing a
 * value we cannot merge would be an overwrite, and "merge, never overwrite"
 * holds one level down too.
 * @param {Record<string, any>} container
 * @param {string} key
 * @param {string[]} incoming
 * @param {string} label  The settings path, for the error message.
 * @returns {string[] | null}
 */
function unionInto(container, key, incoming, label) {
  const existing = container[key] ?? [];
  if (!Array.isArray(existing)) {
    throw new ApplyError(`existing ${label} is not an array — refusing to overwrite it`);
  }
  const present = new Set(existing);
  const newOnes = incoming.filter((n) => !present.has(n));
  if (newOnes.length === 0) return null;
  container[key] = [...existing, ...newOnes];
  return newOnes;
}

/**
 * Validate an incoming `skillOverrides` map: an object whose every value belongs to the
 * four-member enum `settings.json` accepts. A foreign VALUE is refused exactly as a
 * foreign KEY is — writing `"name_only"` would leave behind a settings file Claude Code
 * cannot parse, which is worse than not writing at all. Absent → `{}` (nothing to add).
 *
 * The lever only ever emits `name-only` (ADR-0005 decision 1), but this is a settings
 * writer, not the lever: the constraint it enforces is the schema's, not the lever's.
 *
 * @param {any} map
 * @param {string} label  The settings path, for the error message.
 * @returns {Record<string, string>}
 */
function safeOverrides(map, label) {
  if (map == null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new ApplyError(`${label} must be an object mapping skill names to one of ${SKILL_OVERRIDE_ENUM.join(', ')}`);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== 'string' || !(/** @type {readonly string[]} */ (SKILL_OVERRIDE_ENUM).includes(value))) {
      throw new ApplyError(`${label}['${name}'] must be one of ${SKILL_OVERRIDE_ENUM.join(', ')}`);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Add the entries of `incoming` that are ABSENT from the map at `container[key]`, mutating
 * `container` (always a clone by the time we get here). Returns the entries actually
 * added, or `null` when there is nothing to add.
 *
 * An entry the user already set is left as it is — that is what "merge, never overwrite"
 * means for a map, and it is load-bearing here: `off` is stricter than `name-only`, so
 * rewriting it would silently re-expose a skill the user hid. The lever adds; it never
 * walks a setting back down.
 *
 * An existing value that is present but not a plain object is REFUSED, for the same
 * reason the array branch refuses a non-array.
 *
 * @param {Record<string, any>} container
 * @param {string} key
 * @param {Record<string, string>} incoming
 * @param {string} label  The settings path, for the error message.
 * @returns {Record<string, string> | null}
 */
function mergeMapInto(container, key, incoming, label) {
  const existing = container[key] ?? {};
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ApplyError(`existing ${label} is not an object — refusing to overwrite it`);
  }
  /** @type {Record<string, string>} */
  const added = {};
  for (const [name, value] of Object.entries(incoming)) {
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a skill named
    // `constructor` or `toString` would read as already-set and be silently skipped.
    if (Object.hasOwn(existing, name)) continue; // the user's own entry wins, whatever it says
    added[name] = value;
  }
  if (Object.keys(added).length === 0) return null;
  container[key] = { ...existing, ...added };
  return added;
}

/**
 * The pure merge of the safe subset into `existing` settings (ADR-0004 safe
 * tier). Returns the merged object, the per-key additions, and whether anything
 * changed — without I/O and without mutating either input.
 *
 * "Merge, never overwrite" takes two shapes, one per value kind:
 *   • `permissions.deny` / `disabledMcpjsonServers` are ARRAYS, UNIONED with the existing
 *     lists (deduped, existing-first order);
 *   • `skillOverrides` is a MAP (issue #118) — absent entries are added, entries the user
 *     already set are left untouched.
 * Every other key in `existing` (foreign or ccsnoop) is preserved untouched. Unknown keys
 * in the incoming subset are REFUSED — the advice tier (`hooks`, `claudeMdExcludes`) can
 * never reach the writer through this function — and so is an unknown `skillOverrides`
 * VALUE. So is any malformed value, incoming or existing, that we would have to clobber.
 *
 * @param {Record<string, any>} existing   The current settings.json object.
 * @param {Record<string, any>} safeSubset The contract's `settings.auto` block.
 * @returns {{ merged: Record<string, any>, added: { permissionsDeny?: string[], disabledMcpjsonServers?: string[], skillOverrides?: Record<string, string> }, changed: boolean }}
 */
export function computeMergeSettings(existing, safeSubset) {
  if (!safeSubset || typeof safeSubset !== 'object' || Array.isArray(safeSubset)) {
    throw new ApplyError('safe subset must be a settings object');
  }
  // Refuse foreign top-level keys — only the whitelisted safe subset is writable.
  for (const k of Object.keys(safeSubset)) {
    if (!SAFE_TOP_KEYS.includes(k)) {
      throw new ApplyError(
        `refusing unknown settings key '${k}' — only the safe subset (${SAFE_TOP_KEYS.join(', ')}) is writable`,
      );
    }
  }
  if (safeSubset.permissions != null) {
    if (typeof safeSubset.permissions !== 'object' || Array.isArray(safeSubset.permissions)) {
      throw new ApplyError('safeSubset.permissions must be an object');
    }
    for (const k of Object.keys(safeSubset.permissions)) {
      if (!SAFE_PERM_KEYS.includes(k)) {
        throw new ApplyError(`refusing unknown permissions key '${k}' — only permissions.deny is writable`);
      }
    }
  }

  // Deep-clone the caller's object (JSON round-trip is enough — settings are
  // JSON-serializable) so we never mutate the input nor alias its arrays.
  const merged = JSON.parse(JSON.stringify(existing));
  /** @type {{ permissionsDeny?: string[], disabledMcpjsonServers?: string[], skillOverrides?: Record<string, string> }} */
  const added = {};

  // Validate every incoming value up front, so a malformed report is refused
  // whether or not the other levers happen to have something to add.
  const denyIn = safeNames(safeSubset.permissions?.deny, 'permissions.deny');
  const mcpIn = safeNames(safeSubset.disabledMcpjsonServers, 'disabledMcpjsonServers');
  const skillsIn = safeOverrides(safeSubset.skillOverrides, 'skillOverrides');

  if (denyIn.length > 0) {
    if (merged.permissions != null && (typeof merged.permissions !== 'object' || Array.isArray(merged.permissions))) {
      throw new ApplyError('existing permissions is not an object — refusing to overwrite it');
    }
    merged.permissions ??= {};
    const newOnes = unionInto(merged.permissions, 'deny', denyIn, 'permissions.deny');
    if (newOnes) added.permissionsDeny = newOnes;
  }

  if (mcpIn.length > 0) {
    const newOnes = unionInto(merged, 'disabledMcpjsonServers', mcpIn, 'disabledMcpjsonServers');
    if (newOnes) added.disabledMcpjsonServers = newOnes;
  }

  if (Object.keys(skillsIn).length > 0) {
    const newOnes = mergeMapInto(merged, 'skillOverrides', skillsIn, 'skillOverrides');
    if (newOnes) added.skillOverrides = newOnes;
  }

  return { merged, added, changed: Object.keys(added).length > 0 };
}

/**
 * Read `file` as a settings object, or `{}` when absent — init's strict
 * discipline ({@link module:init.readJsonStrict}) plus the object check the
 * merge needs: a file holding an array or a scalar is refused, never clobbered.
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readSettingsObject(file) {
  const existing = readJsonStrict(file, {}, ApplyError);
  if (existing == null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ApplyError(`${file} is not a JSON object — refusing to overwrite it`);
  }
  return existing;
}

/**
 * Idempotent read-modify-write of the safe subset into `file` (the strict
 * pattern extracted from `init` — {@link module:init.readJsonStrict} /
 * {@link module:init.writeJson}). Reads strict JSON (refuses to clobber a file
 * it cannot understand), merges via {@link computeMergeSettings}, and writes
 * only if something changed. Existing foreign keys are preserved untouched;
 * unknown keys in `safeSubset` are refused; never writes under `.ccsnoop/`.
 *
 * @param {string} file        Absolute path to settings.json.
 * @param {Record<string, any>} safeSubset  The contract's `settings.auto` block.
 * @returns {{ file: string, merged: Record<string, any>, added: object, changed: boolean }}
 */
export function safeMergeSettings(file, safeSubset) {
  assertSettingsNotUnderCcsnoop(file);
  const { merged, added, changed } = computeMergeSettings(readSettingsObject(file), safeSubset);
  if (changed) writeJson(file, merged);
  return { file, merged, added, changed };
}

/**
 * Build structured + textual diff lines from a merge's `added` map. Each entry
 * is one safe key with the names being appended to settings.json. A map-valued key
 * renders as `name=value`, because for `skillOverrides` the value is the whole point of
 * the diff the user is approving — a bare skill name would not say what happens to it.
 * @param {{ permissionsDeny?: string[], disabledMcpjsonServers?: string[], skillOverrides?: Record<string, string> }} added
 * @returns {{ key: string, added: string[] }[]}
 */
function diffEntries(added) {
  const entries = [];
  if (added.permissionsDeny?.length) entries.push({ key: 'permissions.deny', added: added.permissionsDeny });
  if (added.disabledMcpjsonServers?.length) entries.push({ key: 'disabledMcpjsonServers', added: added.disabledMcpjsonServers });
  const skills = Object.entries(added.skillOverrides ?? {});
  if (skills.length > 0) {
    entries.push({ key: 'skillOverrides', added: skills.map(([name, value]) => `${name}=${value}`) });
  }
  return entries;
}

/**
 * Render the advice tier (`settings.advice`) as a paste-only block. Advice is
 * ALWAYS surfaced (even on --dry-run) — it is the human's to paste, never ours
 * to write. An empty advice object reports "(none)".
 * @param {Record<string, any>} advice
 * @returns {string[]}
 */
function renderAdvice(advice) {
  const lines = ['', 'Advice (paste-only — never auto-written):'];
  if (!advice || Object.keys(advice).length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('```json');
    // Pretty-printed so the block is paste-ready straight into settings.json.
    lines.push(JSON.stringify(advice, null, 2));
    lines.push('```');
  }
  return lines;
}

/**
 * The tiered-apply glue (ADR-0004). Consumes a `fine-tune --json` contract and:
 *   1. presents a DIFF of the proposed safe-subset `settings.json` changes;
 *   2. on `approved` (and not `dryRun`), writes the safe subset via
 *      {@link safeMergeSettings} (idempotent);
 *   3. emits the advice levers as a paste-only block (never written);
 *   4. emits a restart reminder iff a write occurred.
 *
 * `dryRun` renders the diff + advice without writing. The default (no `approved`,
 * no `dryRun`) is a preview — nothing writes without explicit approval.
 *
 * @param {object} opts
 * @param {Record<string, any>} opts.report   The tuning-report contract.
 * @param {boolean} [opts.approved]           Write the safe subset (else preview).
 * @param {boolean} [opts.dryRun]             Print the diff without writing.
 * @param {string} [opts.cwd]                 Repo root (default `process.cwd()`).
 * @param {string} [opts.settingsFile]        Override the settings.json path.
 * @returns {{ wrote: boolean, changed: boolean,
 *   diff: { key: string, added: string[] }[], advice: Record<string, any>,
 *   settingsFile: string, lines: string[] }}
 */
export function apply({ report, approved = false, dryRun = false, cwd, settingsFile }) {
  if (!report || typeof report !== 'object') {
    throw new ApplyError('apply requires a tuning-report contract (the `fine-tune --json` report)');
  }
  const file = settingsFile ?? defaultSettingsFile(cwd);
  assertSettingsNotUnderCcsnoop(file);

  const safeSubset = report.settings?.auto ?? {};
  const advice = report.settings?.advice ?? {};

  // Compute the diff up front (read-only) — validates the safe subset (foreign-
  // key refusal) and lets us present changes before writing.
  const { added, changed } = computeMergeSettings(readSettingsObject(file), safeSubset);
  const diff = diffEntries(added);

  const lines = [`ccsnoop apply — proposed safe-subset changes to ${file}:`];
  if (diff.length === 0) {
    lines.push('  (none — the safe subset is already applied or empty)');
  } else {
    for (const d of diff) lines.push(`  + ${d.key}: add ${d.added.join(', ')}`);
  }
  lines.push(...renderAdvice(advice));

  // Write only on explicit approval, never on --dry-run. Delegate to the tested
  // merge primitive (it re-reads + re-validates; idempotent if unchanged).
  let wrote = false;
  if (approved && !dryRun) {
    wrote = safeMergeSettings(file, safeSubset).changed;
  }

  if (wrote) {
    lines.push(RESTART_REMINDER);
  } else if (dryRun) {
    lines.push('(dry run — nothing written)');
  } else if (approved && !changed) {
    lines.push('already applied — nothing written');
  } else if (!approved && changed) {
    lines.push('re-run with --yes to apply these changes');
  }

  return { wrote, changed, diff, advice, settingsFile: file, lines };
}
