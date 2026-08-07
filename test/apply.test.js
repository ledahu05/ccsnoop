// Issue #98 — skill gap 3: tiered apply glue (safe-subset write + advice-only
// paste). Part of epic #94 (the publishable context-tuning skill).
//
// `ccsnoop apply` turns `fine-tune --json`'s lever verdicts into action under
// ADR-0004's two-tier authority:
//   • safe  (tools, mcp)       — dynamic proof → auto-writable on approval.
//   • advice (hooks, claudeMd) — no dynamic proof → paste-only, never written.
//
// Tests assert (AC by AC):
//   • computeMergeSettings: union (never overwrite), foreign-key refusal,
//     idempotency, foreign keys in the existing file preserved untouched.
//   • safeMergeSettings: idempotent (apply twice = apply once), non-object /
//     non-strict JSON refused, unknown keys refused, never writes under
//     .ccsnoop/, never modifies capture files.
//   • apply: presents a diff before writing; writes only the safe subset on
//     approval; advice levers appear in paste output and never in the written
//     file; restart reminder emitted iff a write occurred; --dry-run writes
//     nothing.
//   • CLI: `apply --from <report> --dry-run` prints the diff and writes
//     nothing; `--yes` writes the safe subset and prints the reminder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  apply,
  safeMergeSettings,
  computeMergeSettings,
  defaultSettingsFile,
  ApplyError,
} from '../src/apply.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-apply-')));
}

/** Read+parse a settings file, or null if absent. */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Build a minimal tuning-report contract with the given safe (auto) + advice
 * tiers. Mirrors `buildJsonReport`'s `settings` shape exactly, so `apply`
 * consumes it the same way it consumes a real `fine-tune --json` report.
 */
function report({ deny = [], mcp = [], skillOverrides = null, hooks = false, claudeMdExcludes = [] } = {}) {
  const auto = { permissions: { deny: [...deny] } };
  if (mcp.length > 0) auto.disabledMcpjsonServers = [...mcp];
  if (skillOverrides && Object.keys(skillOverrides).length > 0) auto.skillOverrides = { ...skillOverrides };
  const advice = {};
  if (hooks) advice.hooks = { SessionStart: [] };
  if (claudeMdExcludes.length > 0) advice.claudeMdExcludes = [...claudeMdExcludes];
  return { $schema: 'x', schemaVersion: 1, kind: 'tuning-report', settings: { auto, advice } };
}

// ── defaultSettingsFile ──────────────────────────────────────────────────────

test('defaultSettingsFile targets <cwd>/.claude/settings.json (the committed project settings)', () => {
  assert.equal(
    defaultSettingsFile('/repo'),
    path.join('/repo', '.claude', 'settings.json'),
  );
});

// ── computeMergeSettings: the pure merge (AC #3 — merge, never overwrite) ─────

test('permissions.deny is unioned with the existing list (never overwritten)', () => {
  const existing = { permissions: { allow: ['Bash'], deny: ['Read'] } };
  const { merged, added, changed } = computeMergeSettings(existing, {
    permissions: { deny: ['Workflow', 'Read'] },
  });
  assert.deepEqual(merged.permissions.deny, ['Read', 'Workflow'], 'existing Read kept, new Workflow appended');
  assert.deepEqual(merged.permissions.allow, ['Bash'], 'unrelated permissions key preserved');
  assert.deepEqual(added.permissionsDeny, ['Workflow']);
  assert.equal(changed, true);
});

test('disabledMcpjsonServers is unioned, existing foreign top-level keys preserved', () => {
  const existing = { model: 'opus', env: { FOO: 'bar' }, disabledMcpjsonServers: ['Old'] };
  const { merged, added, changed } = computeMergeSettings(existing, {
    permissions: { deny: [] },
    disabledMcpjsonServers: ['Atlassian', 'Old'],
  });
  assert.deepEqual(merged.disabledMcpjsonServers, ['Old', 'Atlassian']);
  assert.equal(merged.model, 'opus');
  assert.equal(merged.env.FOO, 'bar');
  assert.deepEqual(added.disabledMcpjsonServers, ['Atlassian']);
  assert.equal(changed, true);
});

test('an empty deny list on a file with no permissions adds nothing', () => {
  const existing = {};
  const { merged, added, changed } = computeMergeSettings(existing, {
    permissions: { deny: [] },
  });
  assert.deepEqual(merged, {}, 'no spurious empty permissions.deny created');
  assert.deepEqual(added, {});
  assert.equal(changed, false);
});

test('merge is idempotent — applying the same subset to its own output is a no-op', () => {
  const subset = { permissions: { deny: ['Workflow'] }, disabledMcpjsonServers: ['Atlassian'] };
  const first = computeMergeSettings({}, subset);
  assert.equal(first.changed, true);
  const second = computeMergeSettings(first.merged, subset);
  assert.equal(second.changed, false, 'nothing new to add the second time');
  assert.deepEqual(second.merged, first.merged);
});

test('an unknown top-level key in the subset is refused (the advice tier never slips in)', () => {
  assert.throws(
    () => computeMergeSettings({}, { hooks: { SessionStart: [] } }),
    /unknown settings key 'hooks'/,
  );
  assert.throws(
    () => computeMergeSettings({}, { claudeMdExcludes: ['./CLAUDE.md'] }),
    /unknown settings key 'claudeMdExcludes'/,
  );
});

test('an unknown permissions sub-key is refused (only permissions.deny is writable)', () => {
  assert.throws(
    () => computeMergeSettings({}, { permissions: { allow: ['Bash'] } }),
    /unknown permissions key 'allow'/,
  );
});

test('a name repeated in the incoming list is added once, not twice', () => {
  const { merged, added } = computeMergeSettings({}, {
    permissions: { deny: ['Workflow', 'Workflow'] },
    disabledMcpjsonServers: ['Atlassian', 'Atlassian'],
  });
  assert.deepEqual(merged.permissions.deny, ['Workflow'], 'union dedupes within the incoming list too');
  assert.deepEqual(merged.disabledMcpjsonServers, ['Atlassian']);
  assert.deepEqual(added.permissionsDeny, ['Workflow']);
});

test('a non-array deny in the subset is refused, not silently ignored', () => {
  assert.throws(
    () => computeMergeSettings({}, { permissions: { deny: 'Workflow' } }),
    /permissions\.deny must be an array of strings/,
  );
  assert.throws(
    () => computeMergeSettings({}, { disabledMcpjsonServers: 'Atlassian' }),
    /disabledMcpjsonServers must be an array of strings/,
  );
});

test('a non-string name in the subset is refused rather than written into settings.json', () => {
  assert.throws(
    () => computeMergeSettings({}, { permissions: { deny: [{ tool: 'Workflow' }] } }),
    /permissions\.deny must be an array of strings/,
  );
  assert.throws(
    () => computeMergeSettings({}, { disabledMcpjsonServers: ['ok', 42] }),
    /disabledMcpjsonServers must be an array of strings/,
  );
});

test('an existing permissions block of the wrong shape is refused, never overwritten', () => {
  // "merge, never overwrite" applies one level down too: replacing a value we
  // cannot understand would silently destroy the user's settings.
  assert.throws(
    () => computeMergeSettings({ permissions: ['Bash'] }, { permissions: { deny: ['Workflow'] } }),
    /existing permissions is not an object/,
  );
  assert.throws(
    () => computeMergeSettings({ permissions: { deny: 'Read' } }, { permissions: { deny: ['Workflow'] } }),
    /existing permissions\.deny is not an array/,
  );
  assert.throws(
    () => computeMergeSettings({ disabledMcpjsonServers: 'Old' }, { disabledMcpjsonServers: ['New'] }),
    /existing disabledMcpjsonServers is not an array/,
  );
});

test('an existing block of the wrong shape is left alone when nothing targets it', () => {
  // Only the keys apply actually writes are shape-checked — a malformed key it
  // never touches must not block an unrelated merge.
  const { merged } = computeMergeSettings(
    { permissions: ['Bash'] },
    { disabledMcpjsonServers: ['Atlassian'] },
  );
  assert.deepEqual(merged.permissions, ['Bash'], 'untargeted malformed key preserved verbatim');
  assert.deepEqual(merged.disabledMcpjsonServers, ['Atlassian']);
});

test('computeMergeSettings never mutates the existing object it was given', () => {
  const existing = { permissions: { deny: ['Read'] } };
  const snapshot = JSON.parse(JSON.stringify(existing));
  computeMergeSettings(existing, { permissions: { deny: ['Workflow'] } });
  assert.deepEqual(existing, snapshot, 'caller object left untouched');
});

// ── the object branch: `skillOverrides` (issue #118, ADR-0005 lever 5a) ───────
//
// Every safe key before this one is an ARRAY unioned into place. `skillOverrides` is a
// `Record<string, enum>`, so the merge needs a path it never had — and the invariants that
// path must hold are new, not inherited:
//
//   • the merge stays idempotent in read-modify-write;
//   • "refuse foreign KEYS" extends to "refuse foreign VALUES" — a value outside the
//     four-member enum is rejected, because a settings.json Claude Code cannot parse is
//     worse than no write at all;
//   • an entry the USER already set is never overwritten. The lever adds; it never walks a
//     stricter setting back down to `name-only`.

test('skillOverrides entries are added to the existing map (never a wholesale overwrite)', () => {
  const existing = { skillOverrides: { tdd: 'off' }, model: 'opus' };
  const { merged, added, changed } = computeMergeSettings(existing, {
    skillOverrides: { dataviz: 'name-only', simplify: 'name-only' },
  });
  assert.deepEqual(merged.skillOverrides, { tdd: 'off', dataviz: 'name-only', simplify: 'name-only' });
  assert.equal(merged.model, 'opus', 'unrelated key preserved');
  assert.deepEqual(added.skillOverrides, { dataviz: 'name-only', simplify: 'name-only' });
  assert.equal(changed, true);
});

test("a skill the user already set is left alone — the merge never relaxes a stricter value", () => {
  // `off` is stricter than `name-only`: the user hid the skill entirely. Downgrading it to
  // `name-only` would silently re-expose a skill they took out, which is the one thing a
  // "merge, never overwrite" writer must not do.
  const { merged, added, changed } = computeMergeSettings(
    { skillOverrides: { tdd: 'off', dataviz: 'name-only' } },
    { skillOverrides: { tdd: 'name-only', dataviz: 'name-only' } },
  );
  assert.deepEqual(merged.skillOverrides, { tdd: 'off', dataviz: 'name-only' }, 'both entries untouched');
  assert.equal(changed, false, 'nothing to add');
  assert.equal(added.skillOverrides, undefined);
});

test('a skill named after an Object prototype member is still written', () => {
  // The "already set by the user" test must ask about the object's OWN keys: `'toString' in
  // {}` is true, so a prototype-chain test would silently drop such a skill from the write.
  const { merged, added } = computeMergeSettings({}, { skillOverrides: { toString: 'name-only' } });
  assert.deepEqual(merged.skillOverrides, { toString: 'name-only' });
  assert.deepEqual(added.skillOverrides, { toString: 'name-only' });
});

test('the skillOverrides merge is idempotent — applying it to its own output is a no-op', () => {
  const subset = { skillOverrides: { dataviz: 'name-only' } };
  const first = computeMergeSettings({}, subset);
  assert.equal(first.changed, true);
  const second = computeMergeSettings(first.merged, subset);
  assert.equal(second.changed, false);
  assert.deepEqual(second.merged, first.merged);
});

test('an empty skillOverrides map adds nothing and creates no empty key', () => {
  const { merged, added, changed } = computeMergeSettings({}, { permissions: { deny: [] }, skillOverrides: {} });
  assert.deepEqual(merged, {});
  assert.deepEqual(added, {});
  assert.equal(changed, false);
});

test('a value outside the four-member enum is REFUSED (foreign values, not just keys)', () => {
  assert.throws(
    () => computeMergeSettings({}, { skillOverrides: { dataviz: 'name_only' } }),
    /skillOverrides\['dataviz'\] must be one of on, name-only, user-invocable-only, off/,
  );
  assert.throws(
    () => computeMergeSettings({}, { skillOverrides: { dataviz: true } }),
    /skillOverrides\['dataviz'\] must be one of/,
  );
  assert.throws(
    () => computeMergeSettings({}, { skillOverrides: { dataviz: { mode: 'name-only' } } }),
    /skillOverrides\['dataviz'\] must be one of/,
  );
});

test('the four enum members are all writable — the guard constrains values, not intent', () => {
  // ccsnoop's LEVER only ever emits `name-only` (ADR-0005 decision 1), but the merge is a
  // settings writer: a hand-written report asking for a legal value must not be refused on
  // a policy the schema does not have.
  const { merged } = computeMergeSettings({}, {
    skillOverrides: { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off' },
  });
  assert.deepEqual(merged.skillOverrides, { a: 'on', b: 'name-only', c: 'user-invocable-only', d: 'off' });
});

test('a non-object skillOverrides in the subset is refused, not silently ignored', () => {
  assert.throws(
    () => computeMergeSettings({}, { skillOverrides: ['dataviz'] }),
    /skillOverrides must be an object/,
  );
  assert.throws(
    () => computeMergeSettings({}, { skillOverrides: 'dataviz' }),
    /skillOverrides must be an object/,
  );
});

test('an existing skillOverrides of the wrong shape is refused, never overwritten', () => {
  assert.throws(
    () => computeMergeSettings({ skillOverrides: ['tdd'] }, { skillOverrides: { dataviz: 'name-only' } }),
    /existing skillOverrides is not an object/,
  );
});

test('safeMergeSettings writes the skillOverrides map and re-applies as a no-op', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const subset = { permissions: { deny: [] }, skillOverrides: { dataviz: 'name-only', tdd: 'name-only' } };

  assert.equal(safeMergeSettings(file, subset).changed, true);
  assert.deepEqual(readJson(file).skillOverrides, { dataviz: 'name-only', tdd: 'name-only' });
  const first = fs.readFileSync(file, 'utf8');

  assert.equal(safeMergeSettings(file, subset).changed, false, 'second merge reports no change');
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'file byte-identical after re-apply');
});

test('apply presents each skillOverrides entry in the diff and writes it on approval', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const rep = report({ skillOverrides: { dataviz: 'name-only' } });

  const preview = apply({ report: rep, settingsFile: file });
  const entry = preview.diff.find((d) => d.key === 'skillOverrides');
  assert.deepEqual(entry.added, ['dataviz=name-only'], 'the diff names the skill AND the value');
  assert.ok(preview.lines.some((l) => l.includes('dataviz=name-only')));
  assert.equal(fs.existsSync(file), false, 'preview writes nothing');

  const res = apply({ report: rep, settingsFile: file, approved: true });
  assert.equal(res.wrote, true);
  assert.deepEqual(readJson(file).skillOverrides, { dataviz: 'name-only' });
});

// ── safeMergeSettings: idempotent read-modify-write (AC #3) ───────────────────

test('safeMergeSettings writes the unioned safe subset to settings.json', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = safeMergeSettings(file, { permissions: { deny: ['Workflow'] } });
  assert.equal(res.changed, true);
  assert.deepEqual(readJson(file).permissions, { deny: ['Workflow'] });
});

test('safeMergeSettings is idempotent — a second merge writes nothing new', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const subset = { permissions: { deny: ['Workflow'] }, disabledMcpjsonServers: ['Atlassian'] };

  safeMergeSettings(file, subset);
  const first = fs.readFileSync(file, 'utf8');

  const res = safeMergeSettings(file, subset);
  assert.equal(res.changed, false, 'second merge reports no change');
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'file byte-identical after re-apply');
});

test('existing foreign keys are preserved and untouched by the merge', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
  safeMergeSettings(file, { permissions: { deny: ['Workflow'] } });
  const s = readJson(file);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash'], deny: ['Workflow'] });
});

test('a settings file that is not a JSON object is refused, not clobbered', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '[]'); // array — would drop keys on re-serialize
  assert.throws(() => safeMergeSettings(file, { permissions: { deny: ['Workflow'] } }), ApplyError);
  assert.equal(fs.readFileSync(file, 'utf8'), '[]', 'left untouched');
});

test('a settings file that is not valid JSON is refused, not clobbered', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ not: json ]');
  assert.throws(() => safeMergeSettings(file, { permissions: { deny: ['Workflow'] } }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not: json ]');
});

test('safeMergeSettings refuses to write under .ccsnoop/ (capture data is inviolable)', () => {
  const dir = mkTmp();
  const file = path.join(dir, '.ccsnoop', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.throws(
    () => safeMergeSettings(file, { permissions: { deny: ['Workflow'] } }),
    /\.ccsnoop/,
  );
  assert.ok(!fs.existsSync(file), 'nothing written into the capture tree');
});

// ── apply: diff-before-write + tiered output (AC #1, #2, #4, #5) ──────────────

test('apply with no approval presents the diff and writes nothing', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({ report: report({ deny: ['Workflow'], mcp: ['Atlassian'] }), settingsFile: file });
  assert.equal(res.wrote, false);
  assert.ok(!fs.existsSync(file), 'no file written without approval');
  const out = res.lines.join('\n');
  assert.match(out, /permissions\.deny/);
  assert.match(out, /disabledMcpjsonServers/);
  assert.match(out, /Workflow/);
  assert.match(out, /Atlassian/);
});

test('apply --dry-run presents the diff and writes nothing even though it is a preview', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({
    report: report({ deny: ['Workflow'] }),
    settingsFile: file,
    dryRun: true,
    approved: true,
  });
  assert.equal(res.wrote, false);
  assert.ok(!fs.existsSync(file));
  assert.match(res.lines.join('\n'), /dry run/i);
});

test('on approval, apply writes ONLY the safe subset (deny + disabledMcpjsonServers)', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({
    report: report({
      deny: ['Workflow'],
      mcp: ['Atlassian'],
      hooks: true,
      claudeMdExcludes: ['./CLAUDE.md'],
    }),
    settingsFile: file,
    approved: true,
  });
  assert.equal(res.wrote, true);
  const s = readJson(file);
  assert.deepEqual(s.permissions, { deny: ['Workflow'] });
  assert.deepEqual(s.disabledMcpjsonServers, ['Atlassian']);
  // Advice tier NEVER written.
  assert.ok(!('hooks' in s), 'hooks must not be written');
  assert.ok(!('claudeMdExcludes' in s), 'claudeMdExcludes must not be written');
});

test('advice levers appear in the paste output and never in the written file', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({
    report: report({ deny: ['Workflow'], hooks: true, claudeMdExcludes: ['./CLAUDE.md'] }),
    settingsFile: file,
    approved: true,
  });
  const out = res.lines.join('\n');
  assert.match(out, /paste-only/i);
  assert.match(out, /hooks/);
  assert.match(out, /claudeMdExcludes/);
  assert.match(out, /\.\/CLAUDE\.md/);
  const s = readJson(file);
  assert.ok(!('hooks' in s) && !('claudeMdExcludes' in s));
});

test('restart reminder is emitted iff a write actually occurred', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');

  const wrote = apply({ report: report({ deny: ['Workflow'] }), settingsFile: file, approved: true });
  assert.equal(wrote.wrote, true);
  assert.match(wrote.lines.join('\n'), /restart/i);

  // Idempotent re-apply — nothing changes, so no write, no reminder.
  const noop = apply({ report: report({ deny: ['Workflow'] }), settingsFile: file, approved: true });
  assert.equal(noop.wrote, false);
  assert.doesNotMatch(noop.lines.join('\n'), /restart/i);
});

test('an empty safe subset writes nothing and emits no reminder', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({ report: report({ deny: [] }), settingsFile: file, approved: true });
  assert.equal(res.wrote, false);
  assert.ok(!fs.existsSync(file));
  assert.doesNotMatch(res.lines.join('\n'), /restart/i);
});

test('advice is surfaced in the preview too — it is the human\'s to paste, approval or not', () => {
  const dir = mkTmp();
  const res = apply({
    report: report({ hooks: true, claudeMdExcludes: ['./CLAUDE.md'] }),
    settingsFile: path.join(dir, 'settings.json'),
  });
  const out = res.lines.join('\n');
  assert.match(out, /paste-only/i);
  assert.match(out, /claudeMdExcludes/);
});

test('a report with no settings block yields an empty diff and empty advice', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const res = apply({ report: { kind: 'tuning-report' }, settingsFile: file, approved: true });
  assert.equal(res.wrote, false);
  assert.deepEqual(res.diff, []);
  assert.match(res.lines.join('\n'), /\(none\)/);
  assert.ok(!fs.existsSync(file));
});

test('a settings.auto that is an array is refused, not treated as a subset', () => {
  const dir = mkTmp();
  assert.throws(
    () => apply({
      report: { settings: { auto: ['permissions'] } },
      settingsFile: path.join(dir, 'settings.json'),
      approved: true,
    }),
    /safe subset must be a settings object/,
  );
});

test('apply preserves pre-existing settings keys when it writes the safe subset', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
  apply({ report: report({ deny: ['Workflow'] }), settingsFile: file, approved: true });
  const s = readJson(file);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash'], deny: ['Workflow'] });
});

test('apply refuses a foreign key in settings.auto rather than silently writing it', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const bad = { settings: { auto: { hooks: { SessionStart: [] } }, advice: {} } };
  assert.throws(() => apply({ report: bad, settingsFile: file, approved: true }), ApplyError);
  assert.ok(!fs.existsSync(file), 'nothing written on refusal');
});

test('apply never touches .ccsnoop/ capture files', () => {
  const dir = mkTmp();
  // A capture file sitting next to the target settings — must survive.
  const capture = path.join(dir, '.ccsnoop', 'sessions', 's1', '0001.request.http');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  fs.writeFileSync(capture, 'POST /v1/messages HTTP/1.1\n');
  const file = path.join(dir, 'settings.json');

  apply({ report: report({ deny: ['Workflow'] }), settingsFile: file, approved: true });

  assert.equal(fs.readFileSync(capture, 'utf8'), 'POST /v1/messages HTTP/1.1\n', 'capture intact');
});

// ── CLI smoke (AC #1, #5) ─────────────────────────────────────────────────────

test('ccsnoop apply --from <report> --dry-run prints the diff and writes nothing', () => {
  const dir = mkTmp();
  const reportFile = path.join(dir, 'report.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(reportFile, JSON.stringify(report({ deny: ['Workflow'], mcp: ['Atlassian'] })));

  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', reportFile, '--settings', settingsFile, '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /permissions\.deny/);
  assert.match(r.stdout, /Atlassian/);
  assert.match(r.stdout, /dry run/i);
  assert.ok(!fs.existsSync(settingsFile), 'nothing written in dry-run');
});

test('ccsnoop apply --from <report> --yes writes the safe subset and prints the reminder', () => {
  const dir = mkTmp();
  const reportFile = path.join(dir, 'report.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(
    reportFile,
    JSON.stringify(report({ deny: ['Workflow'], mcp: ['Atlassian'], hooks: true })),
  );

  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', reportFile, '--settings', settingsFile, '--yes'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /restart/i);
  const s = readJson(settingsFile);
  assert.deepEqual(s.permissions, { deny: ['Workflow'] });
  assert.deepEqual(s.disabledMcpjsonServers, ['Atlassian']);
  assert.ok(!('hooks' in s), 'advice never written via the CLI either');
});

test('ccsnoop apply --from - reads the report from stdin', () => {
  const dir = mkTmp();
  const settingsFile = path.join(dir, 'settings.json');
  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', '-', '--settings', settingsFile, '--yes'],
    { encoding: 'utf8', input: JSON.stringify(report({ deny: ['Workflow'] })) },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(readJson(settingsFile).permissions, { deny: ['Workflow'] });
});

test('ccsnoop apply --from a missing file fails with a message naming the source', () => {
  const dir = mkTmp();
  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', path.join(dir, 'nope.json'), '--settings', path.join(dir, 'settings.json')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read a tuning report from .*nope\.json/);
  assert.doesNotMatch(r.stderr, /at .*apply\.js/, 'a user-facing refusal, not a stack dump');
});

test('ccsnoop apply --from a file of invalid JSON fails cleanly', () => {
  const dir = mkTmp();
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(reportFile, '{ truncated');
  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', reportFile, '--settings', path.join(dir, 'settings.json')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read a tuning report/);
});

test('ccsnoop apply refuses a --settings path inside the capture tree', () => {
  const dir = mkTmp();
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report({ deny: ['Workflow'] })));
  const target = path.join(dir, '.ccsnoop', 'settings.json');
  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--from', reportFile, '--settings', target, '--yes'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write settings under \.ccsnoop/);
  assert.ok(!fs.existsSync(target));
});

test('ccsnoop apply with no --from runs fine-tune on the capture and applies it', () => {
  // Build a one-session capture root that ships a denyable built-in tool.
  const root = mkTmp();
  const sessDir = path.join(root, 'sessions', 's');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, '0001.request.http'),
    buildRequestBlob({
      method: 'POST',
      url: '/v1/messages',
      rawHeaders: ['Content-Type', 'application/json'],
      body: Buffer.from(
        JSON.stringify({
          model: 'claude-x',
          system: [{ type: 'text', text: 'sys' }],
          tools: [{ name: 'Bash' }, { name: 'Workflow' }],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    }),
  );
  fs.writeFileSync(
    path.join(sessDir, '0001.response.sse'),
    `data: {"type":"message_start","message":{"usage":${JSON.stringify({ input_tokens: 10, output_tokens: 1 })}}}\n\n`,
  );
  fs.writeFileSync(
    path.join(sessDir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: 's', request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n',
  );

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const r = spawnSync(
    process.execPath,
    [BIN, 'apply', '--root', root, '--session', 's', '--settings', settingsFile, '--yes'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // Workflow is in the shipped denylist intersection → written to permissions.deny.
  assert.deepEqual(readJson(settingsFile).permissions, { deny: ['Workflow'] });
});

// ── lever 5b (issue #119) — the advice tier must have NO path to a write ─────
//
// 5b's two actions are `enabledPlugins` (cuts a whole plugin, working skills included)
// and `disableBundledSkills` (all-or-nothing, and it costs `/name` on every bundled
// skill). Both carry the same proof lever 5a does; both are unbounded, so ADR-0004 keeps
// them paste-only. These tests freeze that: not a diff line, not a written key, not even
// an accidental route through the merge.

test('5b: disableBundledSkills in the advice tier is surfaced and never written', () => {
  const dir = mkTmp();
  const file = path.join(dir, '.claude', 'settings.json');
  const report = {
    settings: {
      auto: { permissions: { deny: [] }, skillOverrides: { dataviz: 'name-only' } },
      advice: { disableBundledSkills: true },
    },
  };
  const res = apply({ report, approved: true, settingsFile: file });
  assert.equal(res.wrote, true, 'the safe half still applies');

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.skillOverrides, { dataviz: 'name-only' });
  assert.ok(!('disableBundledSkills' in written), 'the advice key never reaches settings.json');
  assert.ok(res.lines.join('\n').includes('disableBundledSkills'), 'but it IS surfaced, paste-ready');
  assert.ok(!res.diff.some((d) => /disableBundledSkills|enabledPlugins/.test(d.key)));
});

test('5b: the merge refuses disableBundledSkills / enabledPlugins in the SAFE subset', () => {
  // Belt and braces: even a report that mislabels a 5b key as safe (a bug upstream, or a
  // hand-edited file) must be refused rather than written. Refusing foreign keys is what
  // keeps the tier boundary a property of `apply`, not just of the emitter.
  for (const key of ['disableBundledSkills', 'enabledPlugins']) {
    assert.throws(
      () => computeMergeSettings({}, { [key]: true }),
      (err) => err instanceof ApplyError && /refusing unknown settings key/.test(err.message),
      `${key} must not be writable`,
    );
  }
});

test('5b: a plugin signalement produces no settings key at all — nothing to write, nothing to paste', () => {
  // The plugin half emits no value even in `advice`: which plugin to disable is a judgment
  // about the skills still in use, which ccsnoop has no basis to make.
  const res = apply({
    report: { settings: { auto: { permissions: { deny: [] } }, advice: {} } },
    approved: true,
    settingsFile: path.join(mkTmp(), '.claude', 'settings.json'),
  });
  assert.ok(!res.lines.join('\n').includes('enabledPlugins'));
  assert.equal(res.wrote, false);
});
