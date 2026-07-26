// bench: exit-code conformance against the consolidated §5 table (issue #64).
//
// bench/SPEC.md §5 is the ONE place the bench's failure contract is stated: the
// bench is a MEASUREMENT bench, not a test — `exit ≠ 0` on the integrity of the
// measurement, NEVER on the number. This file is that table's single owner. It
// walks §5 end to end by fault injection over synthetic run dirs, so every case
// runs at ZERO API cost (§9: re-playing the off-nominal paths live would pay a
// session to re-prove something free).
//
// The three rules §5 reduces to:
//   1. an integrity failure exits non-zero — all 14 causes of §5;
//   2. a verdict on a knob that took exits 0 — even a nil or negative gain;
//   3. a degraded run exits 0 — an unavailable axis is a stated limitation.
// Rules 2 and 3 are the regression-worthy ones: an exit-code-hardening instinct
// would turn an honest measurement into a red run.
//
// The distributed assertions still live in test/bench-run.test.js next to each
// slice (#59/#61/#63); this file exists so the §5 table has one owner, not a
// copy scattered across three slices' acceptance criteria as prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUsage } from '../src/report.js';
import {
  BenchError,
  FIXTURE_DIR,
  preflightManifest,
  readManifest,
  materializeFixture,
  assertByteEqual,
  assertNoAncestorConfig,
  reachabilityGuard,
  writeArmConfig,
  preflightSystemInit,
  pickFreshSession,
  readCaptureManifest,
  extractCapture,
  assertGzipObserved,
  assertKnobTook,
  assertSentinel,
  assertBundledSkillsNonEmpty,
  buildProvenance,
  buildDiff,
} from '../scripts/bench/run.mjs';

const FAKE_CLAUDE = path.resolve('test/fixtures/fake-claude.mjs');
const RUN_MJS = fileURLToPath(new URL('../scripts/bench/run.mjs', import.meta.url));

function mkTmp(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ccsnoop-exit-${tag}-`)));
}

/** A minimal well-formed one-arm manifest, valid against the real fixture. */
function baseManifest() {
  return {
    schemaVersion: 1,
    prompt: 'x',
    model: 'm',
    turns: 2,
    cwd: 'bench/fixture',
    arms: [{ id: 'arm-00', label: 'temoin', seed: 'loaded', settings: { hooks: {} }, env: {} }],
  };
}

/** Listen on an ephemeral port; resolve the bound port number. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * A synthetic arm.json in the §6 shape. `usage` omitted ⇒ cache axis degraded.
 * @param {{ id: string, lever?: any, seed?: string, tools: number, request: number, segments?: any[], usage?: any }} o
 */
function armRecord({ id, lever, seed = 'loaded', tools, request, segments = [], usage }) {
  const anatomy = { system: 1, tools, history: 0, currentTurn: 1 };
  const total = anatomy.system + anatomy.tools + anatomy.history + anatomy.currentTurn;
  const rec = {
    id,
    lever: lever ?? null,
    label: lever ?? 'temoin',
    seed,
    sessionId: `sess-${id}`,
    turns: 2,
    turn1: { anatomy: { ...anatomy, total }, requestBytes: request, segments },
    turn2: { anatomy: { system: 0, tools: 0, history: 0, currentTurn: 0, total: 0 }, requestBytes: request + 168, segments: [] },
  };
  if (usage) rec.usage = usage;
  return rec;
}

function usage2() {
  return {
    turn1: { inputTokens: 10, cacheRead: 0, cacheCreation: 29367, outputTokens: 100 },
    turn2: { inputTokens: 8, cacheRead: 29367, cacheCreation: 142, outputTokens: 50 },
  };
}

function diffManifest(arms) {
  return { schemaVersion: 1, prompt: 'x', model: 'm', turns: 2, cwd: 'bench/fixture', arms };
}

/** Assert `fn` fails the run with a {@link BenchError} — sync throw or rejection. */
async function assertFatal(fn, label) {
  await assert.rejects(
    async () => {
      await fn();
    },
    (/** @type {any} */ err) => {
      assert.ok(err instanceof BenchError, `${label}: expected BenchError, got ${err?.constructor?.name}: ${err?.message}`);
      return true;
    },
    label,
  );
}

// ── Rule 1 — every one of §5's 14 integrity causes exits non-zero ────────────
//
// One row per §5 table line, in table order. Each `inject` reproduces the fault
// over a synthetic run dir and MUST fail the run. Adding a row here is how a new
// integrity cause joins the contract; the count is asserted below to stay 14.

const INTEGRITY_CAUSES = [
  {
    step: 1,
    cause: 'manifest invalid / unknown settings key',
    inject: () => {
      // Two conditions collapsed into §5's first row: malformed JSON…
      const dir = mkTmp('c1a');
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json ');
      assert.throws(() => readManifest(path.join(dir, 'manifest.json')), BenchError);
      // …and a settings key outside the known vocabulary.
      const m = baseManifest();
      m.arms[0].settings = { hooks: {}, bogusKey: true };
      preflightManifest(m);
    },
  },
  {
    step: 1,
    cause: 'id of non-fixed / unequal width',
    inject: () => {
      const m = baseManifest();
      m.arms = [
        { id: 'arm-00', label: 'a', seed: 'loaded', settings: { hooks: {} }, env: {} },
        { id: 'arm-100', label: 'b', seed: 'loaded', settings: { hooks: {} }, env: {} },
      ];
      preflightManifest(m);
    },
  },
  {
    step: 1,
    cause: 'declared seed does not exist',
    inject: () => {
      const m = baseManifest();
      m.arms[0].seed = 'does-not-exist';
      preflightManifest(m);
    },
  },
  {
    step: 3,
    cause: 'materialized fixture ≠ committed source (byte for byte)',
    inject: () => {
      const cwd = path.join(mkTmp('c4'), 'cwd');
      materializeFixture(FIXTURE_DIR, cwd);
      fs.appendFileSync(path.join(cwd, 'FIXED.txt'), 'x'); // one drifted byte
      assertByteEqual(FIXTURE_DIR, cwd, new Set(['seeds']));
    },
  },
  {
    step: 3,
    cause: 'an ancestor of cwd carries CLAUDE.md or .claude/',
    inject: () => {
      const root = mkTmp('c5');
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      const cwd = path.join(root, 'child', 'cwd');
      fs.mkdirSync(cwd, { recursive: true });
      assertNoAncestorConfig(cwd);
    },
  },
  {
    step: 6,
    cause: 'daemon unreachable from a spawned child (the 502 of B6)',
    inject: async () => {
      const bad = http.createServer((req, res) => {
        res.writeHead(502);
        res.end();
      });
      const port = await listen(bad);
      try {
        await reachabilityGuard(`http://127.0.0.1:${port}`);
      } finally {
        bad.close();
      }
    },
  },
  {
    step: 11,
    cause: 'settings rejected at the system/init pre-flight',
    inject: () => {
      const run = mkTmp('c7');
      const configDir = writeArmConfig(run, { id: 'arm-00', settings: {}, seed: 'bare' });
      const prev = process.env.CCSNOOP_FAKE_MODE;
      process.env.CCSNOOP_FAKE_MODE = 'noinit'; // fake claude emits no init event
      try {
        preflightSystemInit({ configDir, cwd: run, model: 'm', claudeBin: FAKE_CLAUDE });
      } finally {
        if (prev === undefined) delete process.env.CCSNOOP_FAKE_MODE;
        else process.env.CCSNOOP_FAKE_MODE = prev;
      }
    },
  },
  {
    step: 13,
    cause: 'zero exchange captured (claude -p exit 0 is never proof)',
    inject: () => {
      // No new session dir appeared — the single most dangerous silent failure.
      pickFreshSession(['proxy-1'], ['proxy-1']);
    },
  },
  {
    step: 16,
    cause: 'capture absent / extraction impossible',
    inject: () => {
      const root = mkTmp('c9');
      extractCapture(path.join(root, 'sessions', 'gone'), path.join(root, 'arm-00', 'capture'));
    },
  },
  {
    step: 18,
    cause: 'gzip not observed on the response blob',
    inject: () => {
      const dir = mkTmp('c10');
      // Plaintext SSE — carries no 1f 8b signature.
      fs.writeFileSync(path.join(dir, '0001.response.sse'), 'event: message_start\n');
      fs.writeFileSync(
        path.join(dir, 'manifest.jsonl'),
        JSON.stringify({ turn: 1, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n',
      );
      assertGzipObserved(dir);
    },
  },
  {
    step: 19,
    cause: 'arm turn-1 byte-identical to the witness (knob never took)',
    inject: () => {
      // Same slot set AND bytes ⇒ the knob was silently ignored under -p.
      const slots = [{ slot: 'tool:Bash', bucket: 'tools', bytes: 100 }];
      assertKnobTook({ slots, text: '' }, { slots, text: '' }, 'permissions.deny');
    },
  },
  {
    step: 19,
    cause: 'lever sentinel present in the arm (or absent from the witness)',
    inject: () => {
      // The hooks knob "took" on the WRONG bytes: the persona sentinel survives
      // in the arm, so L2 would weigh an error string as "the hooks lever".
      const sentinel = /** @type {any} */ ({ name: 'L2 hooks', kind: 'literal', text: 'PERSONA-SENTINEL' });
      const witness = { slots: [], text: 'preamble PERSONA-SENTINEL tail' };
      const arm = { slots: [], text: 'still has PERSONA-SENTINEL here' };
      assertSentinel(sentinel, witness, arm);
    },
  },
  {
    step: 19,
    cause: 'witness bundled-skills listing empty (L5 would be an empty arm)',
    inject: () => {
      assertBundledSkillsNonEmpty([]);
    },
  },
  {
    step: 21,
    cause: 'provenance incomplete (no Claude Code version)',
    inject: () => {
      buildProvenance({ claudeCodeVersion: '', model: 'm', port: 1, timestamp: 't', counts: {}, listing: {} });
    },
  },
];

test('§5 rule 1: the table enumerates exactly 14 integrity causes', () => {
  // §5 lists 14 `exit ≠ 0` rows. If this count drifts, the table and its owner
  // have diverged — one of them is wrong.
  assert.equal(INTEGRITY_CAUSES.length, 14);
});

for (const { step, cause, inject } of INTEGRITY_CAUSES) {
  test(`§5 rule 1: step ${step} — ${cause} — exits non-zero`, async () => {
    await assertFatal(inject, `step ${step}: ${cause}`);
  });
}

// ── Rule 2 — a verdict on a knob that took exits 0, even nil / negative ───────

test('§5 rule 2: a NEGATIVE net gain on a knob that took exits 0', () => {
  // arm-01 is genuinely larger than the witness (a knob can cost bytes). §5:
  // exit ≠ 0 only on integrity — never on the number, however unflattering.
  const witness = armRecord({ id: 'arm-00', lever: null, tools: 100, request: 200, usage: usage2() });
  const worse = armRecord({ id: 'arm-01', lever: 'L1', tools: 140, request: 240, usage: usage2() });
  const manifest = diffManifest([
    { id: 'arm-00', lever: null, seed: 'loaded', settings: {} },
    { id: 'arm-01', lever: 'L1', seed: 'loaded', settings: { permissions: { deny: ['Workflow'] } } },
  ]);
  // Building the diff at all IS the exit-0 assertion: an integrity throw here
  // would fail the test (a non-zero exit). §5 permits none on the number.
  const diff = buildDiff({ run: 'r', manifest, provenance: { fixtureCounts: { mcpTools: 64, seedAgents: 8 } }, arms: [witness, worse] });
  const l1 = diff.levers.find((/** @type {any} */ l) => l.id === 'arm-01');
  assert.equal(l1.deltaBytes.requestBytes, 40, 'a positive delta (a loss) is reported, not rejected');
});

test('§5 rule 2: a NIL net gain on a knob that took (a substitution) exits 0', () => {
  // The knob took — the slot set changed — yet the reappearing slots net to 0
  // bytes. This is a valid measurement (§4 substitution line), not an integrity
  // failure: Guard 1 sees a differing slot set, so it does not fire.
  assert.doesNotThrow(() =>
    assertKnobTook(
      { slots: [{ slot: 'tool:Bash', bucket: 'tools', bytes: 100 }], text: '' },
      { slots: [{ slot: 'tool:Glob', bucket: 'tools', bytes: 100 }], text: '' },
      'permissions.deny',
    ),
  );
  const witness = armRecord({ id: 'arm-00', lever: null, tools: 100, request: 200, segments: [{ slot: 'tool:Bash', bucket: 'tools', bytes: 100 }], usage: usage2() });
  const swap = armRecord({ id: 'arm-01', lever: 'L1', tools: 100, request: 200, segments: [{ slot: 'tool:Glob', bucket: 'tools', bytes: 100 }], usage: usage2() });
  const manifest = diffManifest([
    { id: 'arm-00', lever: null, seed: 'loaded', settings: {} },
    { id: 'arm-01', lever: 'L1', seed: 'loaded', settings: { permissions: { deny: ['Bash'] } } },
  ]);
  const diff = buildDiff({ run: 'r', manifest, provenance: { fixtureCounts: { mcpTools: 64, seedAgents: 8 } }, arms: [witness, swap] });
  const l1 = diff.levers.find((/** @type {any} */ l) => l.id === 'arm-01');
  assert.equal(l1.deltaBytes.requestBytes, 0, 'a nil delta is a valid verdict, exit 0');
});

// ── Rule 3 — a degraded run exits 0 ──────────────────────────────────────────

test('§5 rule 3: a non-empty `degraded` list exits 0 (unavailable axis is a limitation)', () => {
  const witness = armRecord({ id: 'arm-00', lever: null, tools: 100, request: 200, usage: usage2() });
  // arm-01 captured no readable usage — its arm.json OMITS the key (never zeroed).
  const noUsage = armRecord({ id: 'arm-01', lever: 'L1', tools: 60, request: 160 });
  const manifest = diffManifest([
    { id: 'arm-00', lever: null, seed: 'loaded', settings: {} },
    { id: 'arm-01', lever: 'L1', seed: 'loaded', settings: { permissions: { deny: ['Workflow'] } } },
  ]);
  // Building the diff at all IS the exit-0 assertion (an integrity throw fails the test).
  const diff = buildDiff({ run: 'r', manifest, provenance: { fixtureCounts: { mcpTools: 64, seedAgents: 8 } }, arms: [witness, noUsage] });
  assert.equal(diff.degraded.length, 1);
  assert.equal(diff.degraded[0].axis, 'cache');
  const l1 = diff.levers.find((/** @type {any} */ l) => l.id === 'arm-01');
  assert.equal('steadyStateTokens' in l1, false, 'the cache verdict is omitted, not zeroed');
});

// ── The two rules that look contradictory but are not ────────────────────────

test('§5: a truncated-gzip blob passes the gzip guard AND degrades the cache axis AND exits 0', () => {
  // "gzip not observed ⇒ fatal" reads the RAW `1f 8b` magic bytes.
  // "cache unavailable ⇒ degraded, exit 0" reads whether `usage` is PARSEABLE.
  // A truncated-gzip blob satisfies the first and fails the second — so a run
  // can be gzip-verified AND cache-degraded at once, and must exit 0.
  const dir = mkTmp('twin');
  const truncated = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')]);
  fs.writeFileSync(path.join(dir, '0001.response.sse'), truncated);
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n',
  );

  // Guard on the magic bytes: passes.
  assert.equal(assertGzipObserved(dir), 1);
  // The usability of `usage`: null — a usage-based gzip guard would have lied here.
  assert.equal(readUsage(truncated), null);

  // The run therefore degrades the cache axis and still exits 0.
  const witness = armRecord({ id: 'arm-00', lever: null, tools: 100, request: 200 }); // usage omitted
  const l1 = armRecord({ id: 'arm-01', lever: 'L1', tools: 60, request: 160 });
  const manifest = diffManifest([
    { id: 'arm-00', lever: null, seed: 'loaded', settings: {} },
    { id: 'arm-01', lever: 'L1', seed: 'loaded', settings: { permissions: { deny: ['Workflow'] } } },
  ]);
  // Building the diff at all IS the exit-0 assertion (an integrity throw fails the test).
  const diff = buildDiff({ run: 'r', manifest, provenance: { fixtureCounts: { mcpTools: 64, seedAgents: 8 } }, arms: [witness, l1] });
  assert.deepEqual(diff.degraded.map((/** @type {any} */ d) => d.axis), ['cache']);
});

// ── §5 / §9: no gain threshold exists anywhere in scripts/bench/ ──────────────

test('§5/§9 non-goal: no gain threshold is coded in scripts/bench/', () => {
  // §9 names "gain thresholds / assertions on the number" as a non-goal: a gain
  // is an unpredictable net delta (Bash: 7 073 o, not 11 694 — B6), so a byte
  // threshold coded today breaks at the next CC build. Asserted by inspection so
  // nobody reintroduces one and turns rule 2 red.
  const src = fs.readFileSync(RUN_MJS, 'utf8');
  assert.doesNotMatch(src, /threshold|seuil|min[_-]?gain|gain[_-]?(floor|min|max)|GAIN_/i);
});
