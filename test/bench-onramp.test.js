// Issue #67 — beginner on-ramp for the tuning bench, linked from README.
//
// The bench's CLI surface lives in scripts/bench/run.mjs (a dev script,
// deliberately NOT a `ccsnoop` subcommand — bench/SPEC.md §1). Its subcommands
// are named in one machine-readable line: the "expected:" clause of the
// unknown-subcommand error. These checks pin three things a beginner on-ramp
// must keep true, so the doc can't drift silently:
//
//   1. the README links the on-ramp (issue #67's explicit ask);
//   2. the on-ramp exists and states purpose + cost-safety for a non-expert;
//   3. the on-ramp documents every subcommand run.mjs actually accepts.
//
// These are docs-conformance checks over files on disk — they never invoke the
// bench, which spends real API tokens (bench/SPEC.md §8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../');
const README = path.join(ROOT, 'README.md');
const ONRAMP = path.join(ROOT, 'bench/README.md');
const RUN = path.join(ROOT, 'scripts/bench/run.mjs');

/**
 * The bench's accepted subcommands, parsed from run.mjs's single
 * "(expected: a | b | c)" clause — the one place the CLI surface is stated.
 * If that line ever disappears, the test fails loudly rather than silently
 * passing on a stale command list.
 *
 * @param {string} src  Contents of scripts/bench/run.mjs.
 * @returns {string[]} the subcommand names.
 */
function benchSubcommands(src) {
  const m = src.match(/\(expected:\s*([^)]+)\)/);
  assert.ok(m, 'run.mjs no longer states its subcommands in an "(expected: …)" clause');
  return m[1].split('|').map((s) => s.trim()).filter(Boolean);
}

test('the tuning bench has a beginner on-ramp doc at bench/README.md', () => {
  assert.ok(fs.existsSync(ONRAMP), 'bench/README.md (the beginner on-ramp) does not exist');
  const doc = fs.readFileSync(ONRAMP, 'utf8');
  assert.match(doc, /^#\s+.+/m, 'on-ramp should start with an H1 title');
});

test('the on-ramp is linked from README.md', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.ok(
    readme.includes('](bench/README.md)'),
    'README.md should link to the on-ramp via [..](bench/README.md)',
  );
});

test('the on-ramp explains what the bench is and what it is for', () => {
  const doc = fs.readFileSync(ONRAMP, 'utf8').toLowerCase();
  assert.ok(doc.includes('tuning'), "on-ramp should frame the bench around 'tuning'");
  // a non-expert reader needs the core mental model named in plain words
  assert.ok(
    /witness/.test(doc) && /lever/.test(doc),
    "on-ramp should introduce 'witness' and 'lever'",
  );
});

test('the on-ramp warns that running it spends real tokens', () => {
  const doc = fs.readFileSync(ONRAMP, 'utf8');
  // beginner safety: `arm` is not free (bench/SPEC.md §8) and copies credentials.
  assert.ok(/real (api )?token/i.test(doc), 'on-ramp should warn it spends real tokens');
  assert.ok(doc.includes('$'), 'on-ramp should give a rough cost figure');
});

test('the on-ramp points to bench/SPEC.md for the deep dive', () => {
  const doc = fs.readFileSync(ONRAMP, 'utf8');
  assert.ok(doc.includes('SPEC.md'), 'on-ramp should link the locked spec');
});

test('the on-ramp documents every subcommand run.mjs accepts (no drift)', () => {
  const run = fs.readFileSync(RUN, 'utf8');
  const doc = fs.readFileSync(ONRAMP, 'utf8');
  for (const sub of benchSubcommands(run)) {
    assert.ok(
      doc.includes(sub),
      `on-ramp does not document the '${sub}' subcommand stated by run.mjs`,
    );
  }
});
