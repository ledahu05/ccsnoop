// Issue #95 — skill gap 1: the machine-readable JSON emit contract
// (`ccsnoop fine-tune --json`). Part of epic #94 (the publishable context-tuning skill).
//
// Every ccsnoop surface today is human-facing (text tables, HTML, a JSON block
// embedded in prose). This is the stable, versioned, parseable contract the skill
// (gap 2) consumes to drive ccsnoop programmatically. The headline requirement
// (GAP A in the prototype comment) is the **safe (auto-write) vs advice (paste-only)
// split** produced INSIDE fine-tune — both as lever tiers (`safeLevers` /
// `adviceLevers`) and as the emitted settings (`settings.auto` / `settings.advice`).
//
// Tests assert: the versioned envelope, the tier split, the settings split
// (reconstructing the legacy paste-ready block), per-lever verdict/evidence/action,
// per-MCP-server byte attribution (GAP B), the optional token opt-in (GAP C), and a
// CLI smoke test (exits 0, parses, required fields present). Default text output is
// asserted UNCHANGED when `--json` is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fineTune, denyIntersection, loadBuiltinDenylist } from '../src/finetune.js';
import {
  buildJsonReport,
  SCHEMA_URL,
  SCHEMA_VERSION,
  summarizeLevers,
} from '../src/finetune-json.js';
import { EMPTY_GAIN } from '../src/finetune-gain.js';
import { EMPTY_LEVER_VERDICTS, HOOK_INTENT_CAVEAT } from '../src/finetune-levers.js';
import { buildRequestBlob } from '../src/capture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'ccsnoop.js');
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/finetune', import.meta.url));

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsnoop-ftjson-'));
}

const DEFAULT_USAGE = {
  input_tokens: 1234,
  output_tokens: 56,
  cache_read_input_tokens: 700,
  cache_creation_input_tokens: 200,
};

/**
 * Write one minimal captured exchange (request blob + SSE response + manifest) into
 * `dir`, shipping `tools` and reporting `usage`. The single place the fixture shape
 * lives, so `--root` and `--sessions-dir` layouts share it.
 */
function writeSessionDir(dir, id, tools, usage = DEFAULT_USAGE) {
  fs.mkdirSync(dir, { recursive: true });
  const req = buildRequestBlob({
    method: 'POST',
    url: '/v1/messages',
    rawHeaders: ['Content-Type', 'application/json'],
    body: Buffer.from(
      JSON.stringify({
        model: 'claude-x',
        system: [{ type: 'text', text: 'system prompt' }],
        tools,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
  });
  fs.writeFileSync(path.join(dir, '0001.request.http'), req);
  fs.writeFileSync(
    path.join(dir, '0001.response.sse'),
    `data: {"type":"message_start","message":{"usage":${JSON.stringify(usage)}}}\n\n`
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.jsonl'),
    JSON.stringify({ turn: 1, thread_id: id, request_blob: '0001.request.http', response_blob: '0001.response.sse' }) + '\n'
  );
  return dir;
}

/** A capture root (`<root>/sessions/<id>/`) holding one session — the `--root` layout. */
function writeSession(root, id, tools, usage) {
  return writeSessionDir(path.join(root, 'sessions', id), id, tools, usage);
}

/** A fresh sessions dir holding `<id>/` directly — the `--sessions-dir` layout. */
function writeSessionsDir(id, tools, usage) {
  const sessionsDir = mkTmpDir();
  writeSessionDir(path.join(sessionsDir, id), id, tools, usage);
  return sessionsDir;
}

/** A gain model with a couple of tool entries charged (built-in + an MCP tool def). */
function gainWith(tools) {
  const gain = {
    tool: new Map(EMPTY_GAIN.tool),
    claudeMd: new Map(EMPTY_GAIN.claudeMd),
    hook: { ...EMPTY_GAIN.hook },
    mcp: { ...EMPTY_GAIN.mcp },
    catalog: new Map(EMPTY_GAIN.catalog),
    harness: { ...EMPTY_GAIN.harness },
  };
  for (const [name, shipped, waste] of tools) gain.tool.set(name, { shipped, waste });
  return gain;
}

// ── versioned envelope (AC: documented, versioned, stable schema) ─────────────

test('SCHEMA_URL / SCHEMA_VERSION are pinned, stable constants', () => {
  assert.equal(typeof SCHEMA_URL, 'string');
  assert.match(SCHEMA_URL, /tuning-report\/v1/);
  assert.equal(SCHEMA_VERSION, 1);
});

test('buildJsonReport emits the versioned tuning-report envelope', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Bash'],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  assert.equal(r.$schema, SCHEMA_URL);
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.equal(r.kind, 'tuning-report');
  assert.equal(r.unit, 'bytes');
  assert.deepEqual(r.session, { id: 's1', requests: 1, scope: 'single' });
  assert.equal(typeof r.note, 'string');
  assert.ok(r.note.length > 0);
});

// ── the safe / advice tier split (GAP A — the contract's reason to exist) ─────

test('safeLevers holds tools + mcp + skills; adviceLevers holds hooks + claudeMd + the two 5b halves', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [{ name: 'Atlassian', shippedSessions: 3, calledCount: 0, deny: true }],
    },
    levers: {
      systemBytes: 100,
      hook: { bytes: 8000, aboveFloor: true, deny: true },
      claudeMd: [{ source: './CLAUDE.md', bytes: 8000, pct: 50, excludable: true, deny: true }],
    },
    gain: gainWith([
      ['Workflow', 5300, 1100],
      ['mcp__Atlassian__foo', 900, 400],
    ]),
  });
  assert.deepEqual(
    r.safeLevers.map((l) => l.lever),
    ['tools', 'mcp', 'skills']
  );
  assert.deepEqual(
    r.adviceLevers.map((l) => l.lever),
    ['hooks', 'claudeMd', 'pluginSkills', 'bundledSkills']
  );
  for (const l of r.safeLevers) assert.equal(l.tier, 'safe');
  for (const l of r.adviceLevers) assert.equal(l.tier, 'advice');
});

test('each lever carries verdict + action + evidence (AC #2)', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [{ name: 'Atlassian', shippedSessions: 3, calledCount: 0, deny: true }],
    },
    levers: {
      systemBytes: 100,
      hook: { bytes: 8000, aboveFloor: true, deny: true },
      claudeMd: [{ source: './CLAUDE.md', bytes: 8000, pct: 50, excludable: true, deny: true }],
    },
    gain: gainWith([['Workflow', 5300, 1100]]),
  });
  for (const l of [...r.safeLevers, ...r.adviceLevers]) {
    assert.ok(typeof l.verdict === 'string' && l.verdict.length > 0, `${l.lever} verdict`);
    assert.ok(typeof l.action === 'string' && l.action.length > 0, `${l.lever} action`);
    assert.ok(typeof l.evidence === 'string' && l.evidence.length > 0, `${l.lever} evidence`);
  }
});

// ── the settings.auto / settings.advice split (GAP A) ─────────────────────────

test('settings.auto carries the safe keys; settings.advice carries the advice keys', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [{ name: 'Atlassian', shippedSessions: 3, calledCount: 0, deny: true }],
    },
    levers: {
      systemBytes: 100,
      hook: { bytes: 8000, aboveFloor: true, deny: true },
      claudeMd: [{ source: './CLAUDE.md', bytes: 8000, pct: 50, excludable: true, deny: true }],
    },
    gain: gainWith([['Workflow', 5300, 1100]]),
  });
  // Auto = what the skill may write on approval: built-in deny + MCP deny.
  assert.deepEqual(r.settings.auto.permissions, { deny: ['Workflow'] });
  assert.deepEqual(r.settings.auto.disabledMcpjsonServers, ['Atlassian']);
  // Advice = paste-only, never auto-written: hooks + claudeMdExcludes.
  assert.deepEqual(r.settings.advice.hooks, { SessionStart: [] });
  assert.deepEqual(r.settings.advice.claudeMdExcludes, ['./CLAUDE.md']);
  // The two are disjoint — no key appears in both.
  const shared = Object.keys(r.settings.auto).filter((k) => k in r.settings.advice);
  assert.deepEqual(shared, []);
});

test('permissions.deny is always present in settings.auto (spec §3.1 — unconditional)', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Bash'],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  assert.ok('permissions' in r.settings.auto);
  assert.deepEqual(r.settings.auto.permissions, { deny: [] });
  // No MCP deny → key omitted (never an empty disabledMcpjsonServers).
  assert.ok(!('disabledMcpjsonServers' in r.settings.auto));
  // Nothing acting on the advice side → empty object (no empty keys).
  assert.deepEqual(r.settings.advice, {});
});

test('settings.auto ∪ settings.advice reconstructs the legacy paste-ready block', () => {
  // The JSON split must be the SAME settings.json the text renderer emits, just
  // partitioned by tier — the contract serializes a distinction the code already
  // makes, it does not invent a new block.
  const res = fineTune({
    cwd: '/nonexistent',
    root: FIXTURES_DIR,
  });
  const legacy = JSON.parse(res.settingsJson);
  const merged = { ...res.json.settings.auto, ...res.json.settings.advice };
  assert.deepEqual(merged, legacy);
});

// ── per-lever byte attribution + tools items ──────────────────────────────────

test('tools items list every shipped built-in tool with a deny flag', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Bash', 'Workflow', 'Read'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: gainWith([
      ['Bash', 1000, 0],
      ['Workflow', 5300, 1100],
      ['Read', 800, 0],
      ['mcp__stub__x', 50, 0], // an MCP tool def — NOT a built-in tool
    ]),
  });
  const tools = r.safeLevers.find((l) => l.lever === 'tools');
  const names = tools.items.map((i) => i.name);
  // Every shipped built-in tool appears; MCP tool defs are excluded from this lever.
  assert.ok(!names.includes('mcp__stub__x'));
  for (const n of ['Bash', 'Workflow', 'Read']) assert.ok(names.includes(n));
  // The deny flag marks the recoverable intersection.
  const wf = tools.items.find((i) => i.name === 'Workflow');
  assert.equal(wf.deny, true);
  assert.deepEqual({ shipped: wf.shipped, waste: wf.waste }, { shipped: 5300, waste: 1100 });
  const bash = tools.items.find((i) => i.name === 'Bash');
  assert.equal(bash.deny, false);
});

test('every denied name has an items row even when the gain model charged it nothing', () => {
  // `names ⊆ items` must hold for any caller: a denied name with no byte row would
  // leave a consumer naming a tool it cannot cost.
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Bash', 'Workflow'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN, // no per-tool bytes at all
  });
  const tools = r.safeLevers.find((l) => l.lever === 'tools');
  assert.deepEqual(
    tools.items.map((i) => i.name),
    ['Workflow', 'Bash']
  );
  assert.deepEqual(tools.items[0], { name: 'Workflow', shipped: 0, waste: 0, deny: true });
  for (const n of tools.names) assert.ok(tools.items.some((i) => i.name === n));
});

test('a shipped mcp__ name that parses to no server stays a built-in tool item', () => {
  // `mcp__lonely` has the prefix but no `__<tool>` suffix, so it names no server: it
  // is nobody's MCP tool def. Classifying on the prefix alone would drop it from the
  // tools lever AND from every per-server aggregate — bytes shipped but never listed.
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Bash', 'mcp__lonely'],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: gainWith([
      ['Bash', 1000, 0],
      ['mcp__lonely', 4000, 100],
    ]),
  });
  const tools = r.safeLevers.find((l) => l.lever === 'tools');
  const lonely = tools.items.find((i) => i.name === 'mcp__lonely');
  assert.deepEqual(lonely, { name: 'mcp__lonely', shipped: 4000, waste: 100, deny: false });
  // Its bytes are counted exactly once — in the tools lever, not a phantom server.
  assert.equal(tools.shipped, 5000);
  assert.deepEqual(r.safeLevers.find((l) => l.lever === 'mcp').items, []);
});

test('tools.allowed records the names --deny-allow dropped for this run', () => {
  // Without it a consumer cannot tell "nothing intersects the denylist" from
  // "it matched and was allowed away" — the text renderer spells that out.
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Workflow'],
    deny: [],
    denyAllowed: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: gainWith([['Workflow', 5300, 1100]]),
  });
  const tools = r.safeLevers.find((l) => l.lever === 'tools');
  assert.deepEqual(tools.allowed, ['Workflow']);
  // Allowed away ⇒ not denied: no verdict, no key, no recoverable bytes.
  assert.equal(tools.verdict, 'none');
  assert.deepEqual(tools.names, []);
  assert.deepEqual(r.settings.auto.permissions, { deny: [] });
  assert.equal(r.totals.recoverable, 0);
});

test('tools.allowed is empty (never absent) when no override was applied', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: ['Workflow'],
    deny: ['Workflow'],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: gainWith([['Workflow', 5300, 1100]]),
  });
  assert.deepEqual(r.safeLevers.find((l) => l.lever === 'tools').allowed, []);
});

test('the report never aliases the caller arrays it was built from', () => {
  const deny = ['Workflow'];
  const claudeMd = [{ source: './CLAUDE.md', bytes: 8000, pct: 50, excludable: true, deny: true }];
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: ['Workflow'],
    deny,
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [{ name: 'alpha', shippedSessions: 3, calledCount: 0, deny: true }],
    },
    levers: { systemBytes: 100, hook: { bytes: 8000, aboveFloor: true, deny: true }, claudeMd },
    gain: gainWith([['Workflow', 5300, 1100]]),
  });
  const snapshot = JSON.parse(JSON.stringify(r));
  deny.push('MUTATED');
  claudeMd.push({ source: './other.md', bytes: 9000, pct: 9, excludable: true, deny: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), snapshot);
});

// ── per-MCP-server byte attribution (GAP B — sum mcp__<server>__* segments) ───

test('per-MCP-server bytes are summed from mcp__<server>__* tool segments', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: [],
    deny: [],
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [
        { name: 'alpha', shippedSessions: 3, calledCount: 0, deny: true },
        { name: 'beta', shippedSessions: 3, calledCount: 2, deny: false },
      ],
    },
    levers: EMPTY_LEVER_VERDICTS,
    // alpha ships two tool defs (1200 shipped, 300 waste); beta ships one (0 — deferred).
    gain: gainWith([
      ['mcp__alpha__one', 700, 200],
      ['mcp__alpha__two', 500, 100],
      ['mcp__beta__only', 0, 0],
    ]),
  });
  const mcp = r.safeLevers.find((l) => l.lever === 'mcp');
  const alpha = mcp.items.find((i) => i.name === 'alpha');
  const beta = mcp.items.find((i) => i.name === 'beta');
  assert.deepEqual({ shipped: alpha.shipped, waste: alpha.waste }, { shipped: 1200, waste: 300 });
  // beta carried a tool segment of 0 — honestly 0, with a scope note explaining it.
  assert.equal(beta.shipped, 0);
  assert.ok(typeof mcp.scope === 'string' && mcp.scope.length > 0, 'scope caveat present');
  assert.equal(mcp.guard.minSessions, 3);
});

test('mcp verdict is flag-only when shipped but the guard does not fire', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: {
      sessionCount: 1,
      singleSession: true,
      servers: [{ name: 'alpha', shippedSessions: 1, calledCount: 0, deny: false }],
    },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  const mcp = r.safeLevers.find((l) => l.lever === 'mcp');
  assert.equal(mcp.verdict, 'flag-only');
  assert.deepEqual(mcp.names, []);
  // No MCP deny key in the auto settings.
  assert.ok(!('disabledMcpjsonServers' in r.settings.auto));
});

// ── advice levers: hooks caveat + claudeMd ────────────────────────────────────

test('hooks lever carries the intent-unknown caveat and never says "unused"', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 3, singleSession: false, servers: [] },
    levers: {
      systemBytes: 10000,
      hook: { bytes: 8000, aboveFloor: true, deny: true },
      claudeMd: [],
    },
    gain: { ...EMPTY_GAIN, hook: { shipped: 8000, waste: 8000 } },
  });
  const hooks = r.adviceLevers.find((l) => l.lever === 'hooks');
  assert.equal(hooks.verdict, 'remove');
  assert.equal(hooks.caveat, HOOK_INTENT_CAVEAT);
  // The lever's VERDICT never labels the hook "unused" (spec Part 3: no dynamic
  // proof ⇒ "costs N bytes" only). The evidence string spelling out 'never "unused"'
  // is the principle stated in words — that is wanted, not a violation.
  assert.notEqual(hooks.verdict, 'unused');
  assert.match(hooks.evidence, /no dynamic proof/i);
  assert.equal(hooks.deny, true);
});

// ── floor (harness) is shown for context, never recoverable ──────────────────

test('floor is the incompressible harness baseline (waste null, not recoverable)', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: { ...EMPTY_GAIN, harness: { shipped: 2700, waste: 0 } },
  });
  assert.equal(r.floor.shipped, 2700);
  assert.equal(r.floor.waste, null);
  assert.equal(r.floor.action, 'none');
  // The recoverable headline never counts the floor.
  assert.equal(r.totals.recoverable, 0);
});

// ── catalog populations (issue #116) — a widening of the v1 contract ─────────
//
// Three new `lever` values exist in the shared model (`deferred-tools`, `agent-types`,
// `skills-catalog`), and `gain.mcp` narrowed to the connecting-servers sub-list. That is
// a contract change, not an internal detail: a consumer that read `safeLevers[mcp].shipped`
// to talk about "the catalog" sees that figure DROP, and must read `catalog` instead.

/**
 * A gain model carrying the three catalog populations.
 * @returns {import('../src/finetune-gain.js').GainModel}
 */
function catalogGain(mcpShipped = 0) {
  return {
    ...EMPTY_GAIN,
    mcp: { shipped: mcpShipped, waste: 0 },
    catalog: new Map([
      ['deferred-tools', { shipped: 530, waste: 0 }],
      ['agent-types', { shipped: 2656, waste: 0 }],
      ['skills-catalog', { shipped: 5119, waste: 0 }],
    ]),
  };
}

/** The report of a session shipping the three catalogs and `mcpShipped` bytes of MCP. */
function catalogReport(mcpShipped = 0) {
  return buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: catalogGain(mcpShipped),
  });
}

test('a repo with no MCP server reports mcp shipped: 0, with the catalog bytes under `catalog`', () => {
  // Issue #116's exit criterion, on the emitted contract.
  const r = catalogReport(0);
  assert.equal(r.safeLevers.find((l) => l.lever === 'mcp').shipped, 0);
  const skills = r.catalog.populations.find((p) => p.population === 'skills-catalog');
  assert.equal(skills.shipped, 5119, 'the skills catalog is named and byte-costed');
});

test('catalog lists every population even at zero, so absent ≠ unreported', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  assert.deepEqual(
    r.catalog.populations.map((p) => p.population),
    ['deferred-tools', 'agent-types', 'skills-catalog'],
  );
  assert.equal(r.catalog.shipped, 0);
});

test('catalog is byte cost only — it acts on nothing and adds nothing to recoverable', () => {
  const r = catalogReport(0);
  assert.equal(r.catalog.action, 'none');
  assert.equal(r.totals.recoverable, 0, 'naming a population is not claiming a gain');
  assert.equal(r.catalog.shipped, 530 + 2656 + 5119);
  assert.match(r.catalog.note, /#116/, 'the note tells a consumer where these bytes used to be');
  assert.ok(!('tier' in r.catalog), 'not a lever entry: no tier, no verdict, no settings key');
  assert.ok(!('verdict' in r.catalog));
});

test('totals.shipped absorbs the catalog — the bytes are counted once, under their own name', () => {
  const r = catalogReport(471);
  assert.equal(r.totals.shipped, r.catalog.shipped + 471, 'catalog + the narrowed MCP lever');
});

// ── the skills lever (issue #118, ADR-0005 lever 5a) ─────────────────────────
//
// The skills catalog gained an ACTION: `skillOverrides: name-only` on every skill the
// corpus shipped and the model never invoked. Two contract properties matter most —
// the verdict is per-skill and byte-ranked, and its bytes are the SAME bytes
// `catalog.populations[skills-catalog]` reports, never a second helping in `totals.shipped`.

/** A skills corpus in the shape `aggregateSkillCorpus` emits. */
function skillCorpus(skills, { sessionCount = 3, singleSession = false, rosterSize = 0 } = {}) {
  return {
    sessionCount,
    singleSession,
    roster: { size: rosterSize, source: rosterSize ? 'data/bundled-skills.json' : null, readOn: ['2.1.224'], error: null },
    skills: skills.map((s) => ({
      reachable: true,
      shippedSessions: sessionCount,
      invokedCount: 0,
      override: true,
      scope: null,
      scopeKind: null,
      bundled: false,
      skill: s.name.includes(':') ? s.name.slice(s.name.indexOf(':') + 1) : s.name,
      ...s,
    })),
  };
}

/** A report of a session shipping the catalogs, with `skills` as the lever's corpus. */
function skillsReport(skills, opts) {
  return buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 3, singleSession: false, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: { ...catalogGain(0), catalog: new Map([['skills-catalog', { shipped: 5119, waste: 5119 }]]) },
    skills: skillCorpus(skills, opts),
  });
}

test('the skills lever is a SAFE lever, keyed on skillOverrides', () => {
  const r = skillsReport([{ name: 'dataviz', bytes: 1157 }]);
  assert.deepEqual(
    r.safeLevers.map((l) => l.lever),
    ['tools', 'mcp', 'skills'],
  );
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  assert.equal(skills.tier, 'safe');
  assert.equal(skills.action, 'skillOverrides');
  assert.equal(skills.verdict, 'name-only');
  assert.ok(skills.evidence.length > 0);
  assert.deepEqual(skills.guard, { sessionCount: 3, minSessions: 3, singleSession: false });
});

test('settings.auto carries the skillOverrides map — every qualifying skill, one diff', () => {
  const r = skillsReport([
    { name: 'dataviz', bytes: 1157 },
    { name: 'claude-api', bytes: 1093 },
  ]);
  assert.deepEqual(r.settings.auto.skillOverrides, { dataviz: 'name-only', 'claude-api': 'name-only' });
  assert.deepEqual(r.safeLevers.find((l) => l.lever === 'skills').names, ['dataviz', 'claude-api']);
});

test('the emitted value is only ever `name-only` — never off, never user-invocable-only', () => {
  const r = skillsReport([{ name: 'dataviz', bytes: 1157 }]);
  assert.deepEqual([...new Set(Object.values(r.settings.auto.skillOverrides))], ['name-only']);
});

test('skills items are byte-ranked and carry the evidence per skill', () => {
  const r = skillsReport([
    { name: 'dataviz', bytes: 1157 },
    { name: 'init', bytes: 68, invokedCount: 2, override: false },
  ]);
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  assert.deepEqual(
    skills.items.map((i) => [i.name, i.bytes, i.invokedCount, i.override]),
    [
      ['dataviz', 1157, 0, true],
      ['init', 68, 2, false],
    ],
  );
  assert.deepEqual(skills.names, ['dataviz'], 'an invoked skill is listed but never actioned');
});

test('a skill no skillOverrides entry can reach is reported, never written', () => {
  // A plugin skill resolves to "on" unconditionally (ADR-0005 fact 2) — lever 5b's
  // territory. Reporting its cost is honest; emitting a key for it would be a no-op write.
  const r = skillsReport([{ name: 'plug:heavy', bytes: 900, reachable: false, override: false }]);
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  assert.equal(skills.items[0].reachable, false);
  assert.deepEqual(skills.names, []);
  assert.ok(!('skillOverrides' in r.settings.auto), 'no empty map written either');
});

test('nothing qualifies ⇒ verdict flag-only, no settings key', () => {
  const r = skillsReport([{ name: 'tdd', bytes: 400, invokedCount: 1, override: false }]);
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  assert.equal(skills.verdict, 'flag-only');
  assert.ok(!('skillOverrides' in r.settings.auto));
});

test('no skills catalog at all ⇒ verdict none, and the lever is still listed', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
  });
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  assert.equal(skills.verdict, 'none', 'a caller that omits the corpus gets an inert lever, not a crash');
  assert.deepEqual(skills.items, []);
});

test('recoverable counts the description, not the whole entry, and never exceeds the block waste', () => {
  // `name-only` leaves `- <name>\n` on the wire, so the entry's name line is not recovered
  // — and no lever may claim more re-payment than the block it lives in actually re-pays.
  const r = skillsReport([{ name: 'dataviz', bytes: 1157 }]);
  const residue = Buffer.byteLength('- dataviz\n', 'utf8');
  assert.equal(r.totals.recoverable, 1157 - residue);

  const cached = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'corpus',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 3, singleSession: false, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    // The catalog block was never re-paid (waste 0) → nothing to stop re-paying.
    gain: { ...EMPTY_GAIN, catalog: new Map([['skills-catalog', { shipped: 5119, waste: 0 }]]) },
    skills: skillCorpus([{ name: 'dataviz', bytes: 1157 }]),
  });
  assert.equal(cached.totals.recoverable, 0);
});

test('the skills lever reports the SAME bytes as the catalog population, not a second helping', () => {
  const r = skillsReport([{ name: 'dataviz', bytes: 1157 }]);
  const skills = r.safeLevers.find((l) => l.lever === 'skills');
  const population = r.catalog.populations.find((p) => p.population === 'skills-catalog');
  assert.equal(skills.shipped, population.shipped, 'one measurement, reported twice under two names');
  assert.equal(r.totals.shipped, r.catalog.shipped, 'and counted ONCE in the total');
  assert.match(skills.scope, /catalog/, 'the scope note says so in words');
  assert.equal(skills.population, 'skills-catalog', 'the join is a field, not only prose');
});

// ── optional token opt-in (GAP C — from captured usage, never re-tokenized) ───

test('tokens are absent unless includeTokens is set', () => {
  const r = buildJsonReport({
    sessionId: 's1',
    requests: 1,
    scope: 'single',
    shipped: [],
    deny: [],
    mcp: { sessionCount: 1, singleSession: true, servers: [] },
    levers: EMPTY_LEVER_VERDICTS,
    gain: EMPTY_GAIN,
    exchanges: [{ usage: { inputTokens: 10, outputTokens: 1 } }],
  });
  assert.ok(!('tokens' in r));
});

test('includeTokens sums usage across the primary-session exchanges', () => {
  const r = buildJsonReport(
    {
      sessionId: 's1',
      requests: 2,
      scope: 'single',
      shipped: [],
      deny: [],
      mcp: { sessionCount: 1, singleSession: true, servers: [] },
      levers: EMPTY_LEVER_VERDICTS,
      gain: EMPTY_GAIN,
      exchanges: [
        { usage: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 700, cacheCreationInputTokens: 200 } },
        { usage: { inputTokens: 250, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        { usage: null }, // an aborted exchange — contributes nothing, never throws
      ],
    },
    { includeTokens: true }
  );
  assert.ok('tokens' in r);
  assert.deepEqual(r.tokens, {
    input: 1250,
    output: 80,
    cacheRead: 700,
    cacheCreation: 200,
    source: 'primary-session captured usage (never re-tokenized)',
  });
});

// ── summarizeLevers: the shared deny/waste decisions (one source of truth) ────

test('summarizeLevers exposes the acting levers + conservative recoverable', () => {
  const s = summarizeLevers({
    deny: ['Workflow'],
    mcp: {
      sessionCount: 3,
      singleSession: false,
      servers: [{ name: 'alpha', shippedSessions: 3, calledCount: 0, deny: true }],
    },
    levers: {
      systemBytes: 100,
      hook: { bytes: 8000, aboveFloor: true, deny: true },
      claudeMd: [{ source: './CLAUDE.md', bytes: 8000, pct: 50, excludable: true, deny: true }],
    },
    gain: gainWith([
      ['Workflow', 5300, 1100],
      ['mcp__alpha__x', 0, 0],
    ]),
  });
  assert.deepEqual(s.mcpDeny, ['alpha']);
  assert.deepEqual(s.claudeMdExclude, ['./CLAUDE.md']);
  assert.equal(s.hookDeny, true);
  // Recoverable = Σ waste over the ACTIONABLE levers (denied tools + MCP-under-guard +
  // above-floor hooks + excludable-above-floor CLAUDE.md). gain.mcp.waste is 0 here.
  assert.equal(s.recoverable, 1100);
});

// ── fineTune() always returns the contract on .json ──────────────────────────

test('fineTune() returns the contract on .json', () => {
  const root = mkTmpDir();
  writeSession(root, 's', [{ name: 'Bash' }, { name: 'Workflow' }]);
  const res = fineTune({ cwd: '/nonexistent', root, session: 's' });
  assert.equal(res.json.schemaVersion, SCHEMA_VERSION);
  assert.equal(res.json.kind, 'tuning-report');
  const tools = res.json.safeLevers.find((l) => l.lever === 'tools');
  assert.deepEqual(res.json.settings.auto.permissions, { deny: ['Workflow'] });
  assert.ok(tools.items.some((i) => i.name === 'Workflow' && i.deny));
});

test('fineTune({includeTokens:true}) backfills token totals from usage', () => {
  const root = mkTmpDir();
  writeSession(root, 's', [{ name: 'Bash' }]);
  const res = fineTune({ cwd: '/nonexistent', root, session: 's', includeTokens: true });
  assert.equal(res.json.tokens.input, 1234);
  assert.equal(res.json.tokens.output, 56);
  assert.equal(res.json.tokens.cacheRead, 700);
  assert.equal(res.json.tokens.cacheCreation, 200);
});

// ── CLI smoke (AC #5: exits 0, parses, required fields present) ───────────────

test('ccsnoop fine-tune --json exits 0 and emits parseable JSON to stdout', () => {
  const sessionsDir = writeSessionsDir('cli-json', [{ name: 'Bash' }, { name: 'Workflow' }]);
  const r = spawnSync(process.execPath, [BIN, 'fine-tune', '--sessions-dir', sessionsDir, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  for (const key of ['$schema', 'schemaVersion', 'kind', 'unit', 'session', 'totals', 'safeLevers', 'adviceLevers', 'settings']) {
    assert.ok(key in parsed, `required field ${key} present`);
  }
  assert.deepEqual(parsed.settings.auto.permissions, { deny: ['Workflow'] });
});

test('--json --include-tokens surfaces the tokens block on stdout', () => {
  const sessionsDir = writeSessionsDir('cli-tok', [{ name: 'Workflow' }], { input_tokens: 42, output_tokens: 2 });
  const r = spawnSync(
    process.execPath,
    [BIN, 'fine-tune', '--sessions-dir', sessionsDir, '--json', '--include-tokens'],
    { encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.tokens.input, 42);
});

test('default (no --json) output is still the human text table, unchanged', () => {
  const sessionsDir = writeSessionsDir('cli-text', [{ name: 'Workflow' }]);
  const r = spawnSync(process.execPath, [BIN, 'fine-tune', '--sessions-dir', sessionsDir], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The text diagnostic — NOT a JSON object on line 1.
  assert.match(r.stdout, /Lever\s+entry\s+shipped\s+waste\s+action/);
  assert.match(r.stdout, /settings\.json \(paste-ready\):/);
  assert.throws(() => JSON.parse(r.stdout));
});

// ── fixture end-to-end (self-skips until the FT0 capture is committed) ────────

const fixtureOpts = fs.existsSync(FIXTURES_DIR) &&
  fs.readdirSync(FIXTURES_DIR, { withFileTypes: true }).some((e) => e.isDirectory() && /^session-/.test(e.name))
  ? {}
  : { skip: 'no fixture committed under test/fixtures/finetune/' };

test('fixture: fine-tune --json contract is well-formed + settings reconstruct the block', fixtureOpts, () => {
  const res = fineTune({ cwd: '/nonexistent', root: FIXTURES_DIR });
  const j = res.json;
  // Built-in tools deny always matches the intersection.
  assert.deepEqual(res.deny, denyIntersection(res.shipped, loadBuiltinDenylist()));
  assert.deepEqual(j.settings.auto.permissions, { deny: res.deny });
  // The split reconstructs the legacy block exactly.
  const merged = { ...j.settings.auto, ...j.settings.advice };
  assert.deepEqual(merged, JSON.parse(res.settingsJson));
  // Every lever has the contract's common fields.
  for (const l of [...j.safeLevers, ...j.adviceLevers]) {
    assert.ok(l.tier && l.verdict && l.action && l.evidence);
  }
});

// ── lever 5b (issue #119) — plugin skills + bundled bulk, in the ADVICE tier ──
//
// Same proof as 5a, unbounded actions, so the contract must place them where nothing can
// write them and must not fold their bytes into the headline: the bundled bulk overlaps
// 5a's population by construction, and the plugin figure prices an action whose real cost
// is not in bytes.

test('the plugin signalement is an advice lever, per plugin and per skill', () => {
  const r = skillsReport([
    { name: 'mattpocock-skills:code-review', bytes: 900, scope: 'mattpocock-skills', scopeKind: 'plugin', reachable: false, invokedCount: 6, override: false },
    { name: 'mattpocock-skills:naming', bytes: 501, scope: 'mattpocock-skills', scopeKind: 'plugin', reachable: false, override: false },
  ]);
  const plugins = r.adviceLevers.find((l) => l.lever === 'pluginSkills');
  assert.equal(plugins.tier, 'advice');
  assert.equal(plugins.action, 'enabledPlugins');
  assert.equal(plugins.verdict, 'flag-only');
  const [g] = plugins.items;
  assert.equal(g.plugin, 'mattpocock-skills');
  assert.equal(g.invokedSkills, 1);
  assert.equal(g.deadBytes, 501, 'only the skills the model never reached');
  assert.deepEqual(g.skills.map((s) => s.skill), ['code-review', 'naming']);
});

test('the plugin lever never produces a settings key — enabledPlugins stays the user’s call', () => {
  const r = skillsReport([
    { name: 'dead-plugin:a', bytes: 900, scope: 'dead-plugin', scopeKind: 'plugin', reachable: false, override: false },
  ]);
  assert.ok(!('enabledPlugins' in r.settings.advice), 'not even paste-ready — the value is a judgment ccsnoop cannot make');
  assert.ok(!('enabledPlugins' in r.settings.auto));
  assert.equal(r.totals.recoverable, 0, 'an unbounded action’s bytes never enter the headline');
});

test('the bundled bulk lands in settings.advice when the whole population is dead', () => {
  const r = skillsReport(
    [
      { name: 'dataviz', bytes: 1157, bundled: true },
      { name: 'simplify', bytes: 191, bundled: true },
    ],
    { rosterSize: 16 },
  );
  const bundled = r.adviceLevers.find((l) => l.lever === 'bundledSkills');
  assert.equal(bundled.tier, 'advice');
  assert.equal(bundled.action, 'disableBundledSkills');
  assert.equal(bundled.verdict, 'bulk');
  assert.equal(bundled.shipped, 1157 + 191);
  assert.deepEqual(bundled.names, ['dataviz', 'simplify']);
  assert.match(bundled.caveat, /\/name/);
  assert.equal(r.settings.advice.disableBundledSkills, true);
  assert.ok(!('disableBundledSkills' in r.settings.auto), 'the safe subset must have no path to it');
});

test('the bundled bulk bytes are reported but never counted into recoverable', () => {
  // They are the SAME entries lever 5a already claims (a harsher action on one
  // population), so adding them would double-count the catalog against itself.
  const r = skillsReport([{ name: 'dataviz', bytes: 1157, bundled: true }], { rosterSize: 16 });
  const residue = Buffer.byteLength('- dataviz\n', 'utf8');
  assert.equal(r.totals.recoverable, 1157 - residue, 'still exactly lever 5a’s figure');
});

test('one invoked bundled skill and the bulk is reported, not offered, and writes nothing', () => {
  const r = skillsReport(
    [
      { name: 'dataviz', bytes: 1157, bundled: true },
      { name: 'simplify', bytes: 191, bundled: true, invokedCount: 2, override: false },
    ],
    { rosterSize: 16 },
  );
  const bundled = r.adviceLevers.find((l) => l.lever === 'bundledSkills');
  assert.equal(bundled.verdict, 'none');
  assert.equal(bundled.invokedSkills, 1);
  assert.ok(bundled.reason.length > 0, 'the reader is told why the option is off');
  assert.ok(!('disableBundledSkills' in r.settings.advice));
  // …and 5a still acts on the dead one, by name.
  assert.deepEqual(r.settings.auto.skillOverrides, { dataviz: 'name-only' });
});

test('both 5b levers are always listed, even inert — absence of a row is not absence of a population', () => {
  const r = skillsReport([{ name: 'tdd', bytes: 400 }]);
  assert.deepEqual(
    r.adviceLevers.map((l) => l.lever),
    ['hooks', 'claudeMd', 'pluginSkills', 'bundledSkills'],
  );
  for (const lever of ['pluginSkills', 'bundledSkills']) {
    assert.equal(r.adviceLevers.find((l) => l.lever === lever).verdict, 'none');
  }
});

test('the skills lever items carry the 5b join — scope and bundled, per skill', () => {
  // One population, three readings: 5a's reach, 5b's plugin grouping, 5b's bundled bulk.
  // Carrying the join as fields keeps a consumer from re-parsing names to find it.
  const r = skillsReport([
    { name: 'plug:a', bytes: 900, scope: 'plug', scopeKind: 'plugin', reachable: false, override: false },
    { name: 'dataviz', bytes: 500, bundled: true },
  ]);
  const items = r.safeLevers.find((l) => l.lever === 'skills').items;
  assert.deepEqual(
    items.map((i) => [i.name, i.scope, i.scopeKind, i.bundled]),
    [
      ['plug:a', 'plug', 'plugin', false],
      ['dataviz', null, null, true],
    ],
  );
});

test('the plugin lever’s `names` is empty — it writes nothing, and says so in the field consumers read', () => {
  // Every other lever's `names` is "the names this lever writes". A consumer walking
  // `names` across the levers to build a settings block must find nothing here, whatever
  // else it does with the report. The actionable plugins get a key of their own.
  const r = skillsReport([
    { name: 'plug:a', bytes: 900, scope: 'plug', scopeKind: 'plugin', reachable: false, override: false },
    { name: 'apps/web:deploy', bytes: 300, scope: 'apps/web', scopeKind: 'directory', reachable: false, override: false },
  ]);
  const plugins = r.adviceLevers.find((l) => l.lever === 'pluginSkills');
  assert.deepEqual(plugins.names, []);
  assert.deepEqual(plugins.plugins, ['plug'], 'the directory scope has no action, so it is not listed');
});

test('the bundled lever carries the roster’s provenance, not just its size', () => {
  // Bundled is a NAME test, so the population is only as complete as the roster. `readOn`
  // is what a reader on a newer Claude Code build needs to catch the drift before acting.
  const r = skillsReport([{ name: 'dataviz', bytes: 1157, bundled: true }], { rosterSize: 16 });
  const { roster } = r.adviceLevers.find((l) => l.lever === 'bundledSkills');
  assert.equal(roster.size, 16);
  assert.deepEqual(roster.readOn, ['2.1.224']);
  assert.equal(roster.error, null);
});
