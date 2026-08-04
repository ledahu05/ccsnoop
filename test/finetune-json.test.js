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

test('safeLevers holds tools + mcp; adviceLevers holds hooks + claudeMd', () => {
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
    ['tools', 'mcp']
  );
  assert.deepEqual(
    r.adviceLevers.map((l) => l.lever),
    ['hooks', 'claudeMd']
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
