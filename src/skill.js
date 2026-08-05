// Issue #97 — skill gap 2: `ccsnoop skill install`. Part of epic #94 (the
// publishable context-tuning skill).
//
// The skill is project-scoped: it installs into the host repo's
// `.claude/skills/context-tuning/`. This module copies the bundled `skill/`
// artifact (SKILL.md + the standalone bootstrap script + README) there, so a team
// gets the orchestration loop — capture → diagnose → apply → verify — wired into
// that repo's own Claude Code.
//
// Two guarantees, mirroring the apply glue's (#98, ADR-0004) writer discipline:
//
//   • idempotent — installing twice is identical to installing once. A target file
//     that already matches the bundled source byte-for-byte is SKIPPED, not
//     rewritten. So `ccsnoop skill install` is safe to re-run after an upgrade.
//   • refuses to clobber foreign edits — a target file that DIFFERS from the
//     bundled source is left untouched unless `--force` is passed. Extra files the
//     team added in the target dir are left alone too. The skill never silently
//     overwrites the user's work.
//
// And the capture guard (ADR-0004 / spec §1.3): the writer never writes under
// `.ccsnoop/` — capture data is inviolable. The default target can't reach it, but
// the guard is defense in depth (shared with `apply` via `src/guard.js`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotUnderCcsnoop } from './guard.js';

export class SkillError extends Error {}

/** The directory name the skill installs as under `.claude/skills/`. */
export const SKILL_NAME = 'context-tuning';

/**
 * The bundled skill artifact dir — `skill/` at the package root, a sibling of
 * `src/`. Resolved from this module's URL so it works under a global install
 * (`npm install -g .`) where `skill/` ships in the package (see `package.json`
 * `files`), not just in a clone.
 * @param {string} [importMetaUrl]
 * @returns {string}
 */
export function bundledSkillDir(importMetaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..', 'skill');
}

/**
 * Where the skill installs: `<cwd>/.claude/skills/context-tuning`. The path CC
 * discovers project skills under.
 * @param {string} [cwd]
 * @returns {string}
 */
export function defaultSkillTarget(cwd = process.cwd()) {
  return path.join(cwd, '.claude', 'skills', SKILL_NAME);
}

/**
 * The pure install planner. Given the bundled sources and the on-disk targets (each
 * a `Buffer`, or absent from the map ⇒ the file does not exist), decide per file:
 * write (new / overwrite under --force), skip (byte-identical), or refuse (differs,
 * no --force). No I/O — this is the unit of idempotency + foreign-refusal logic.
 *
 * Both maps are keyed by the bundle-relative path with POSIX separators, so the
 * planner is cross-platform and `planInstall` does not know about `path.join`.
 *
 * @param {{ sources: Map<string, Buffer>, targets: Map<string, Buffer>, force: boolean }} input
 * @returns {{ writes: Array<{ rel: string, reason: string }>, skips: Array<{ rel: string, reason: string }>, refuses: Array<{ rel: string, reason: string }> }}
 */
export function planInstall({ sources, targets, force }) {
  /** @type {Array<{ rel: string, reason: string }>} */
  const writes = [];
  /** @type {Array<{ rel: string, reason: string }>} */
  const skips = [];
  /** @type {Array<{ rel: string, reason: string }>} */
  const refuses = [];

  for (const [rel, src] of sources) {
    if (!targets.has(rel)) {
      writes.push({ rel, reason: 'new' });
      continue;
    }
    const existing = targets.get(rel);
    if (Buffer.isBuffer(existing) && Buffer.isBuffer(src) && existing.equals(src)) {
      skips.push({ rel, reason: 'identical' });
    } else if (force) {
      writes.push({ rel, reason: 'overwrite' });
    } else {
      refuses.push({ rel, reason: 'foreign' });
    }
  }
  return { writes, skips, refuses };
}

/**
 * Refuse a target inside a `.ccsnoop/` capture tree — capture data is inviolable.
 * The default target can never be under `.ccsnoop/`, but the guard holds for a
 * programmatic `target` override. Shares the check with `ccsnoop apply` via
 * {@link module:guard.assertNotUnderCcsnoop}.
 * @param {string} target
 */
function assertSkillTargetNotUnderCcsnoop(target) {
  assertNotUnderCcsnoop(target, SkillError, 'the skill');
}

/**
 * Walk a dir, returning a Map of POSIX-relative path → file contents (`Buffer`).
 * Non-regular files (e.g. leftover sockets) are ignored; hidden entries are kept
 * (the skill ships none, but a `.gitkeep` would be legitimate). The rel path uses
 * `/` on every platform so {@link planInstall} and {@link installSkill} agree.
 * @param {string} root
 * @returns {Map<string, Buffer>}
 */
function readTree(root) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * Install the bundled skill into `<cwd>/.claude/skills/context-tuning/`.
 *
 * Idempotent: files that already match the bundle are skipped. Foreign files
 * (differing bytes) are refused without `force`; with `force` they are overwritten.
 * Files the user added that the bundle does not ship are never touched.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]     Working directory (default `process.cwd()`).
 * @param {boolean} [opts.force]  Overwrite files that differ from the bundle.
 * @param {string} [opts.bundleDir] Override the bundled `skill/` source (testing).
 * @param {string} [opts.target]  Override the install target (testing).
 * @returns {{ target: string, writes: Array<{ rel: string, reason: string }>, skips: Array<{ rel: string, reason: string }>, lines: string[] }}
 */
export function installSkill(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const force = !!opts.force;
  const bundleDir = opts.bundleDir ?? bundledSkillDir();
  const target = opts.target ?? defaultSkillTarget(cwd);

  assertSkillTargetNotUnderCcsnoop(target);

  if (!fs.existsSync(bundleDir)) {
    throw new SkillError(`bundled skill artifact not found at ${bundleDir}`);
  }

  const sources = readTree(bundleDir);

  // Read every target that exists, keyed by the same POSIX-rel path.
  /** @type {Map<string, Buffer>} */
  const targets = new Map();
  for (const rel of sources.keys()) {
    const tp = path.join(target, ...rel.split('/'));
    try {
      targets.set(rel, fs.readFileSync(tp));
    } catch {
      /* absent — leave unset */
    }
  }

  const plan = planInstall({ sources, targets, force });

  // Atomic refusal: surface EVERY foreign file before writing any, so a partial
  // install never lands.
  if (plan.refuses.length > 0 && !force) {
    const list = plan.refuses.map((r) => `  ${r.rel}`).join('\n');
    throw new SkillError(
      `refusing to overwrite file(s) that differ from the bundled skill:\n${list}\n` +
        `re-run with --force to overwrite them.`,
    );
  }

  fs.mkdirSync(target, { recursive: true });
  for (const w of plan.writes) {
    const tp = path.join(target, ...w.rel.split('/'));
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, sources.get(w.rel));
  }

  return { target, writes: plan.writes, skips: plan.skips, lines: renderLines(target, plan) };
}

/**
 * @param {string} target
 * @param {{ writes: Array<{ rel: string }>, skips: Array<{ rel: string }> }} plan
 * @returns {string[]}
 */
function renderLines(target, plan) {
  const lines = [`ccsnoop skill install: ${target}`];
  if (plan.writes.length > 0) {
    lines.push(`  installed ${plan.writes.length} file${plan.writes.length === 1 ? '' : 's'}:`);
    for (const w of plan.writes) lines.push(`    + ${w.rel}`);
  }
  if (plan.skips.length > 0) {
    lines.push(`  ${plan.skips.length} file${plan.skips.length === 1 ? '' : 's'} already up to date (skipped)`);
  }
  if (plan.writes.length === 0 && plan.skips.length === 0) {
    lines.push('  nothing to do');
  }
  lines.push('  restart Claude Code to pick up the new skill');
  return lines;
}
