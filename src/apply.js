// Tiered-apply glue (issue #98, epic #94) — turns `fine-tune --json`'s lever
// verdicts into action under **ADR-0004's two-tier authority**:
//
//   • safe   (tools, mcp)        — carry DYNAMIC PROOF (a pre-validated
//     denylist; sent-vs-used across a corpus). Auto-writable on approval.
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

import path from 'node:path';

import { readJsonStrict, writeJson } from './init.js';

/** The settings keys apply is allowed to write (the ADR-0004 safe subset). */
const SAFE_TOP_KEYS = ['permissions', 'disabledMcpjsonServers'];
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
 * `--settings` override from pointing into the capture root.
 * @param {string} file
 */
function assertNotUnderCcsnoop(file) {
  if (path.resolve(file).split(path.sep).includes('.ccsnoop')) {
    throw new ApplyError(`refusing to write settings under .ccsnoop/ (capture data) — ${file}`);
  }
}

/**
 * The pure merge of the safe subset into `existing` settings (ADR-0004 safe
 * tier). Returns the merged object, the per-key additions, and whether anything
 * changed — without I/O and without mutating either input.
 *
 * "Merge, never overwrite": `permissions.deny` and `disabledMcpjsonServers` are
 * UNIONED with the existing arrays (deduped, existing-first order); every other
 * key in `existing` (foreign or ccsnoop) is preserved untouched. Unknown keys
 * in the incoming subset are REFUSED — the advice tier (`hooks`,
 * `claudeMdExcludes`) can never reach the writer through this function.
 *
 * @param {Record<string, any>} existing   The current settings.json object.
 * @param {Record<string, any>} safeSubset The contract's `settings.auto` block.
 * @returns {{ merged: Record<string, any>, added: { permissionsDeny?: string[], disabledMcpjsonServers?: string[] }, changed: boolean }}
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
  /** @type {{ permissionsDeny?: string[], disabledMcpjsonServers?: string[] }} */
  const added = {};

  const denyIn = safeSubset.permissions?.deny;
  if (Array.isArray(denyIn) && denyIn.length > 0) {
    const perm =
      merged.permissions && typeof merged.permissions === 'object' && !Array.isArray(merged.permissions)
        ? merged.permissions
        : (merged.permissions = {});
    const existingDeny = Array.isArray(perm.deny) ? perm.deny : [];
    const present = new Set(existingDeny);
    const newOnes = denyIn.filter((n) => !present.has(n));
    if (newOnes.length > 0) {
      added.permissionsDeny = newOnes;
      perm.deny = [...existingDeny, ...newOnes];
    }
  }

  const mcpIn = safeSubset.disabledMcpjsonServers;
  if (Array.isArray(mcpIn) && mcpIn.length > 0) {
    const existingMcp = Array.isArray(merged.disabledMcpjsonServers) ? merged.disabledMcpjsonServers : [];
    const present = new Set(existingMcp);
    const newOnes = mcpIn.filter((n) => !present.has(n));
    if (newOnes.length > 0) {
      added.disabledMcpjsonServers = newOnes;
      merged.disabledMcpjsonServers = [...existingMcp, ...newOnes];
    }
  }

  return { merged, added, changed: Object.keys(added).length > 0 };
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
  assertNotUnderCcsnoop(file);
  const existing = readJsonStrict(file, {}, ApplyError);
  if (existing == null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ApplyError(`${file} is not a JSON object — refusing to overwrite it`);
  }
  const { merged, added, changed } = computeMergeSettings(existing, safeSubset);
  if (changed) writeJson(file, merged);
  return { file, merged, added, changed };
}

/**
 * Build structured + textual diff lines from a merge's `added` map. Each entry
 * is one safe key with the names being appended to settings.json.
 * @param {{ permissionsDeny?: string[], disabledMcpjsonServers?: string[] }} added
 * @returns {{ key: string, added: string[] }[]}
 */
function diffEntries(added) {
  const entries = [];
  if (added.permissionsDeny?.length) entries.push({ key: 'permissions.deny', added: added.permissionsDeny });
  if (added.disabledMcpjsonServers?.length) entries.push({ key: 'disabledMcpjsonServers', added: added.disabledMcpjsonServers });
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
    // 2-space indent under the fence — readable when pasted alongside the diff.
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
 * @returns {{ exitCode: number, wrote: boolean, changed: boolean,
 *   diff: { key: string, added: string[] }[], advice: Record<string, any>,
 *   settingsFile: string, lines: string[] }}
 */
export function apply({ report, approved = false, dryRun = false, cwd, settingsFile }) {
  if (!report || typeof report !== 'object') {
    throw new ApplyError('apply requires a tuning-report contract (the `fine-tune --json` report)');
  }
  const file = settingsFile ?? defaultSettingsFile(cwd);
  assertNotUnderCcsnoop(file);

  const safeSubset = report.settings?.auto ?? {};
  const advice = report.settings?.advice ?? {};

  // Compute the diff up front (read-only) — validates the safe subset (foreign-
  // key refusal) and lets us present changes before writing.
  const existing = readJsonStrict(file, {}, ApplyError);
  if (existing == null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ApplyError(`${file} is not a JSON object — refusing to overwrite it`);
  }
  const { added, changed } = computeMergeSettings(existing, safeSubset);
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

  return { exitCode: 0, wrote, changed, diff, advice, settingsFile: file, lines };
}
