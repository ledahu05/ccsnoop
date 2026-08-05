// Issue #97 — skill gap 2: `ccsnoop skill install`. Part of epic #94.
//
// The skill is project-scoped — it installs into the host repo's
// `.claude/skills/context-tuning/`. `installSkill` copies the bundled `skill/`
// artifact there. Two guarantees, mirroring the apply glue's (#98) discipline:
//
//   • idempotent — installing twice is identical to installing once. A target file
//     that already matches the source byte-for-byte is skipped, not rewritten.
//   • refuses to clobber a foreign file — a target file that DIFFERS from the
//     source is left untouched unless `--force` is passed. The skill never silently
//     overwrites the user's edits; extra files it did not ship are left alone too.
//
// The capture guard from ADR-0004 / spec §1.3 also applies: the writer never writes
// under `.ccsnoop/` (capture data is inviolable). The default target can't reach
// it, but the guard is defense in depth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planInstall, installSkill, defaultSkillTarget, bundledSkillDir, SkillError } from '../src/skill.js';

const REAL_BUNDLE = bundledSkillDir(); // the shipped skill/ artifact

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-skill-')));
}

// ─── planInstall: the pure install planner (idempotency + foreign refusal) ────

/** @returns {Map<string, Buffer>} */
function mapOf(entries) {
  return new Map(entries);
}
const B = (s) => Buffer.from(s, 'utf8');

test('planInstall: a new file (no target) is a write', () => {
  const plan = planInstall({
    sources: mapOf([['SKILL.md', B('a')]]),
    targets: mapOf([]),
    force: false,
  });
  assert.deepEqual(plan.writes.map((w) => w.rel), ['SKILL.md']);
  assert.deepEqual(plan.skips, []);
  assert.deepEqual(plan.refuses, []);
});

test('planInstall: a byte-identical target is a skip (idempotent)', () => {
  const plan = planInstall({
    sources: mapOf([['SKILL.md', B('a')]]),
    targets: mapOf([['SKILL.md', B('a')]]),
    force: false,
  });
  assert.deepEqual(plan.skips.map((s) => s.rel), ['SKILL.md']);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.refuses, []);
});

test('planInstall: a differing target is a REFUSE without --force', () => {
  const plan = planInstall({
    sources: mapOf([['SKILL.md', B('ours')]]),
    targets: mapOf([['SKILL.md', B('theirs')]]),
    force: false,
  });
  assert.deepEqual(plan.refuses.map((r) => r.rel), ['SKILL.md']);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.skips, []);
});

test('planInstall: a differing target is a write WITH --force', () => {
  const plan = planInstall({
    sources: mapOf([['SKILL.md', B('ours')]]),
    targets: mapOf([['SKILL.md', B('theirs')]]),
    force: true,
  });
  assert.deepEqual(plan.writes.map((w) => w.rel), ['SKILL.md']);
  assert.deepEqual(plan.refuses, []);
});

test('planInstall: mixed set — identical skipped, new written, differing refused', () => {
  const plan = planInstall({
    sources: mapOf([
      ['SKILL.md', B('same')],
      ['README.md', B('new')],
      ['scripts/bootstrap.mjs', B('ours')],
    ]),
    targets: mapOf([
      ['SKILL.md', B('same')],
      ['scripts/bootstrap.mjs', B('theirs')],
    ]),
    force: false,
  });
  assert.deepEqual(plan.skips.map((s) => s.rel), ['SKILL.md']);
  assert.deepEqual(plan.writes.map((w) => w.rel), ['README.md']);
  assert.deepEqual(plan.refuses.map((r) => r.rel), ['scripts/bootstrap.mjs']);
});

test('planInstall: with --force, the mixed set refuses become writes; identical still skipped', () => {
  const plan = planInstall({
    sources: mapOf([
      ['SKILL.md', B('same')],
      ['README.md', B('new')],
      ['scripts/bootstrap.mjs', B('ours')],
    ]),
    targets: mapOf([
      ['SKILL.md', B('same')],
      ['scripts/bootstrap.mjs', B('theirs')],
    ]),
    force: true,
  });
  assert.deepEqual(plan.skips.map((s) => s.rel), ['SKILL.md']);
  assert.deepEqual([...plan.writes.map((w) => w.rel)].sort(), ['README.md', 'scripts/bootstrap.mjs']);
  assert.deepEqual(plan.refuses, []);
});

// ─── bundledSkillDir ─────────────────────────────────────────────────────────
// (defaultSkillTarget is a one-line path.join — its behavior is covered by the
// installSkill integration tests below, so a mirror unit test would add no
// confidence. bundledSkillDir we assert for the real artifact, not its exact path.)

test('bundledSkillDir: the shipped skill/ exists with SKILL.md', () => {
  assert.ok(fs.existsSync(path.join(REAL_BUNDLE, 'SKILL.md')), 'shipped SKILL.md must exist');
});

// ─── installSkill: integration against the real bundle in a tmp repo ─────────

test('installSkill: into an empty repo → writes every shipped file', () => {
  const cwd = mkTmp();
  const result = installSkill({ cwd });
  const target = defaultSkillTarget(cwd);
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, 'scripts', 'bootstrap.mjs')));
  assert.ok(result.writes.length > 0);
  assert.deepEqual(result.skips, []);
});

test('installSkill: re-run is idempotent — everything skipped, nothing written', () => {
  const cwd = mkTmp();
  installSkill({ cwd });
  const again = installSkill({ cwd });
  assert.deepEqual(again.writes, []);
  assert.ok(again.skips.length > 0);
});

// (The installed bootstrap.mjs is the standalone module test/bootstrap.test.js
// imports and exercises directly — its standalone contract is behaviorally covered
// there, so a source-grep assertion here would only test HOW, not WHAT.)

test('installSkill: a foreign (differing) target file is refused, not overwritten', () => {
  const cwd = mkTmp();
  // First install, then corrupt one shipped file with a user edit.
  installSkill({ cwd });
  const target = path.join(defaultSkillTarget(cwd), 'README.md');
  const userEdit = Buffer.from('# my team notes — do not clobber\n');
  fs.writeFileSync(target, userEdit);

  // Refuses AND leaves the user’s bytes intact.
  assert.throws(() => installSkill({ cwd }), (err) => {
    assert.ok(err instanceof SkillError);
    assert.match(err.message, /README\.md/);
    assert.match(err.message, /--force/);
    return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), userEdit.toString('utf8'));
});

test('installSkill: --force overwrites a differing file; identical files still skipped', () => {
  const cwd = mkTmp();
  installSkill({ cwd });
  const target = path.join(defaultSkillTarget(cwd), 'README.md');
  fs.writeFileSync(target, 'user edit');

  const result = installSkill({ cwd, force: true });
  assert.ok(result.writes.some((w) => w.rel === 'README.md'));
  // Files that already matched were skipped, not rewritten.
  assert.ok(result.skips.some((s) => s.rel === 'SKILL.md'));
});

test('installSkill: extra files the user added in the target are left untouched', () => {
  const cwd = mkTmp();
  installSkill({ cwd });
  const extra = path.join(defaultSkillTarget(cwd), 'team-notes.md');
  fs.writeFileSync(extra, 'keep me');
  installSkill({ cwd }); // idempotent re-run
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep me');
});

test('installSkill: never writes under .ccsnoop/ (capture guard)', () => {
  const cwd = mkTmp();
  const ccsnoopedTarget = path.join(cwd, '.ccsnoop', 'context-tuning');
  assert.throws(
    () => installSkill({ cwd, target: ccsnoopedTarget }),
    (err) => err instanceof SkillError && /\.ccsnoop/.test(err.message),
  );
});

test('installSkill: result.lines names the target and is human-readable', () => {
  const cwd = mkTmp();
  const result = installSkill({ cwd });
  const text = result.lines.join('\n');
  assert.match(text, /\.claude[\\/]skills[\\/]context-tuning/);
});
