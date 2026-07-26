// bench run scaffold — a dev script, deliberately absent from `files` in
// package.json (precedent: docs/research/probes/base-url-path-prefix-probe.mjs).
// No --help contract, no semver promise. See bench/SPEC.md §1–§2 and issue #59.
//
// This slice implements the run-scoped steps 1–7 (arm <id>) and teardown <run>.
// It spends ZERO API tokens: nothing here invokes `claude`. The per-arm capture
// steps 8–21 land in a later slice.
//
//   node scripts/bench/run.mjs arm <id>        # steps 1–7 only, in this slice
//   node scripts/bench/run.mjs teardown <run>  # stop, init --undo, rm -rf
//
// Logic is exported as small pure/deterministic units so it can be unit-tested
// (test/bench-run.test.js); the CLI at the bottom is a thin dispatch.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as daemon from '../../src/daemon.js';
import { init } from '../../src/init.js';
import { deriveToken, readRoutes, routeDir } from '../../src/routes.js';

/** Absolute path to this script (for spawning the reachability child). */
const SELF = fileURLToPath(import.meta.url);
/** The committed frozen fixture (bench/fixture/). */
export const FIXTURE_DIR = path.resolve(SELF, '../../../bench/fixture');
/** The versioned manifest (bench/manifest.json). */
export const MANIFEST_PATH = path.resolve(SELF, '../../../bench/manifest.json');

/** A bench-level failure with a user-facing message; the CLI exits non-zero. */
export class BenchError extends Error {}

/** Fixed-width arm id (bench/SPEC.md §1): the CLAUDE_CONFIG_DIR path leaks into
 * system#2, so unequal-width names would carry a silent byte bias. */
export const ARM_ID_RE = /^arm-\d\d$/;

/** Settings keys the manifest may carry — an unknown key is a fatal pre-flight
 * error (bench/SPEC.md §2 step 1, §5). These are the six levers of §3. */
export const KNOWN_SETTINGS_KEYS = new Set([
  'hooks',
  'permissions',
  'claudeMdExcludes',
  'disabledMcpjsonServers',
  'disableBundledSkills',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Step 1: manifest pre-flight (fatal) ──────────────────────────────────────

/**
 * Validate a parsed manifest (bench/SPEC.md §2 step 1). Throws {@link BenchError}
 * on: an unknown settings key, an `id` failing {@link ARM_ID_RE}, `id`s of
 * unequal width, or a `seed` with no matching directory under
 * `<fixtureDir>/seeds/`. Malformed JSON is a parse error the caller surfaces.
 *
 * @param {any} manifest    Parsed manifest object.
 * @param {object} [opts]
 * @param {string} [opts.fixtureDir]  Fixture root (default {@link FIXTURE_DIR}).
 * @returns {any} the validated manifest (returned for chaining).
 */
export function preflightManifest(manifest, opts = {}) {
  const fixtureDir = opts.fixtureDir ?? FIXTURE_DIR;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BenchError('manifest is not a JSON object');
  }
  const arms = manifest.arms;
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new BenchError('manifest.arms must be a non-empty array');
  }

  let width = null;
  for (const arm of arms) {
    if (!arm || typeof arm !== 'object') {
      throw new BenchError('every arm must be an object');
    }
    const id = arm.id;
    if (typeof id !== 'string' || !ARM_ID_RE.test(id)) {
      throw new BenchError(`arm id ${JSON.stringify(id)} does not match /^arm-\\d\\d$/`);
    }
    // ARM_ID_RE already pins width to 6 ("arm-" + two digits); this equal-width
    // check is belt-and-suspenders that survives any future loosening of the
    // pattern, since a width bias in CLAUDE_CONFIG_DIR is silent (§1, §5).
    if (width === null) width = id.length;
    else if (id.length !== width) {
      throw new BenchError(`arm id ${id} has width ${id.length}, expected fixed width ${width}`);
    }

    const settings = arm.settings;
    if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new BenchError(`arm ${id}: settings must be an object`);
    }
    for (const key of Object.keys(settings)) {
      if (!KNOWN_SETTINGS_KEYS.has(key)) {
        throw new BenchError(`arm ${id}: unknown settings key '${key}'`);
      }
    }

    const seed = arm.seed;
    if (typeof seed !== 'string' || !seed) {
      throw new BenchError(`arm ${id}: seed must be a non-empty string`);
    }
    const seedDir = path.join(fixtureDir, 'seeds', seed);
    if (!fs.existsSync(seedDir) || !fs.statSync(seedDir).isDirectory()) {
      throw new BenchError(`arm ${id}: seed '${seed}' has no directory at ${seedDir}`);
    }
  }
  return manifest;
}

/** Read and pre-flight the manifest at `file` (throws on malformed JSON). */
export function readManifest(file = MANIFEST_PATH, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BenchError(`cannot read manifest ${file}: ${/** @type {Error} */ (err).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BenchError(`manifest ${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  return preflightManifest(parsed, opts);
}

// ── Step 3: materialize + byte-equality + no-ancestor guard (fatal) ──────────

/**
 * Walk `dir` and return its file paths relative to `dir` (posix, sorted),
 * skipping any top-level entry named in `excludeTop`.
 * @param {string} dir
 * @param {Set<string>} [excludeTop]
 * @returns {string[]}
 */
function listFiles(dir, excludeTop = new Set()) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    const abs = rel === '' ? dir : path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && excludeTop.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

/**
 * Assert `dest` is a byte-for-byte copy of `src` (same file set, same bytes),
 * skipping top-level entries in `excludeTop` on the `src` side. Throws
 * {@link BenchError} on any missing/extra file or differing content.
 * @param {string} src
 * @param {string} dest
 * @param {Set<string>} [excludeTop]
 */
export function assertByteEqual(src, dest, excludeTop = new Set()) {
  const a = listFiles(src, excludeTop);
  const b = listFiles(dest);
  const setB = new Set(b);
  for (const rel of a) {
    if (!setB.has(rel)) throw new BenchError(`materialized fixture is missing ${rel}`);
  }
  const setA = new Set(a);
  for (const rel of b) {
    if (!setA.has(rel)) throw new BenchError(`materialized fixture has an extra file ${rel}`);
  }
  for (const rel of a) {
    const ba = fs.readFileSync(path.join(src, rel));
    const bb = fs.readFileSync(path.join(dest, rel));
    if (!ba.equals(bb)) {
      throw new BenchError(`materialized fixture differs from source at ${rel}`);
    }
  }
}

/**
 * Materialize the fixture (bench/SPEC.md §2 step 3): verbatim copy of `src`
 * (minus `seeds/`) into `destCwd`, then assert byte-for-byte equality with the
 * committed source. Fatal on any drift.
 * @param {string} src     Committed fixture dir.
 * @param {string} destCwd Destination `<run>/cwd`.
 */
export function materializeFixture(src, destCwd) {
  const exclude = new Set(['seeds']);
  fs.mkdirSync(destCwd, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (exclude.has(entry)) continue;
    fs.cpSync(path.join(src, entry), path.join(destCwd, entry), { recursive: true });
  }
  assertByteEqual(src, destCwd, exclude);
}

/**
 * Assert no *ancestor* directory of `cwdPath` carries `CLAUDE.md` or `.claude/`
 * (bench/SPEC.md §2 step 3): such an ancestor would leak project scope into the
 * capture. `cwdPath` itself is exempt — it holds the materialized CLAUDE.md.
 * @param {string} cwdPath
 */
export function assertNoAncestorConfig(cwdPath) {
  let dir = path.dirname(path.resolve(cwdPath));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, '.claude'))) {
      throw new BenchError(`ancestor ${dir} carries CLAUDE.md or .claude/ — pick a run root with none`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
}

// ── Ports & sockets ──────────────────────────────────────────────────────────

/**
 * A free TCP port on `host` (bind :0, read the assigned port, release it).
 * Inherently racy — good enough for the port dance, which binds immediately.
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Resolve true iff a TCP connection to `port` succeeds within one attempt. */
function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll until the daemon's socket accepts a connection (bench/SPEC.md §2 step 5:
 * `start` detaches, so the first attempt is ECONNREFUSED).
 * @param {number} port
 * @param {string} [host]
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitForSocket(port, host = '127.0.0.1', opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port, host)) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ── Step 5: the port dance ───────────────────────────────────────────────────

/**
 * The port dance (bench/SPEC.md §2 step 5): `start --port` (persists the port so
 * `init` bakes it into ANTHROPIC_BASE_URL) → `stop` → `init` (registers the
 * route + writes settings) → `start` on the same port → wait for the socket.
 * `init` and `start` share the same `--home`, or the daemon reads a route-less
 * routes.json and captures nothing.
 *
 * @param {{ home: string, cwd: string, port: number }} opts
 * @returns {Promise<{ token: string, captureDir: string, port: number }>}
 */
export async function portDance({ home, cwd, port }) {
  await daemon.start(home, { port }); // persists port to config.json, spawns
  await daemon.stop(home); // free the port before init/restart
  const r = init({ cwd, home });
  if (r.exitCode !== 0) throw new BenchError(`ccsnoop init failed: ${r.lines.join('; ')}`);
  const startAgain = await daemon.start(home, { port });
  if (startAgain.exitCode !== 0) {
    throw new BenchError(`ccsnoop start failed on port ${port}: ${startAgain.line}`);
  }
  const up = await waitForSocket(port);
  if (!up) throw new BenchError(`daemon socket never came up on port ${port}`);
  return { token: r.token, captureDir: r.captureDir, port };
}

// ── Step 7: read back the base URL + verify the route ────────────────────────

/**
 * Read `ANTHROPIC_BASE_URL` from a materialized `settings.local.json`
 * (bench/SPEC.md §2 step 7): the port the daemon actually took, with the
 * cwd-derived token. Throws if absent.
 * @param {string} settingsPath
 * @returns {string}
 */
export function extractBaseUrl(settingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    throw new BenchError(`cannot read ${settingsPath}: ${/** @type {Error} */ (err).message}`);
  }
  const url = parsed?.env?.ANTHROPIC_BASE_URL;
  if (typeof url !== 'string' || !url) {
    throw new BenchError(`no ANTHROPIC_BASE_URL in ${settingsPath}`);
  }
  return url;
}

/**
 * Verify a route token is registered in the run's own `routes.json`
 * (bench/SPEC.md §2 step 7). Throws if absent.
 * @param {string} home
 * @param {string} token
 */
export function assertRoutePresent(home, token) {
  const routes = readRoutes(daemon.paths(home).routes);
  if (routeDir(routes, token) == null) {
    throw new BenchError(`route ${token} absent from ${daemon.paths(home).routes}`);
  }
}

// ── Step 6: reachability guard (from a spawned child, fatal) ─────────────────

/**
 * The reachability guard (bench/SPEC.md §2 step 6): `GET <baseUrl>/api/hello`
 * must return 200, run **from a spawned child** — B1 saw loopback TCP silently
 * blocked inside a sub-agent, so the driver's own process is not trusted. A 502
 * means the daemon does not know the route. Throws {@link BenchError} on anything
 * but a child exit code of 0.
 * @param {string} baseUrl  e.g. http://localhost:41377/<token>
 * @param {{ self?: string }} [opts]
 * @returns {Promise<true>}
 */
export async function reachabilityGuard(baseUrl, opts = {}) {
  const self = opts.self ?? SELF;
  const url = baseUrl.replace(/\/$/, '') + '/api/hello';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [self, '__reach', url], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c ?? -1));
  });
  if (code !== 0) {
    throw new BenchError(
      `reachability guard failed for ${url} (child exit ${code}) — the daemon does not know the route (502) or is unreachable`,
    );
  }
  return true;
}

/** The `__reach` child body: GET `url`, exit 0 iff HTTP 200, else non-zero. */
function reachChild(url) {
  const req = http.get(url, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 3);
  });
  req.on('error', () => process.exit(4));
  req.setTimeout(4000, () => {
    req.destroy();
    process.exit(5);
  });
}

// ── Orphan sweep & teardown ──────────────────────────────────────────────────

/** The bench run root: `$TMPDIR/ccsnoop-bench/`. */
export function benchRoot() {
  return path.join(os.tmpdir(), 'ccsnoop-bench');
}

/** A timestamped run dir name (safe for a path segment). */
function runStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Stop and remove every run dir under `root` except `keep`. A `kill -9`'d driver
 * beats the teardown trap and leaves its detached daemon alive (bench/SPEC.md
 * §2): this sweep stops any such daemon by its pidfile and removes the dir.
 * @param {string} root
 * @param {string|null} [keep]  A healthy run dir to preserve (absolute path).
 * @returns {Promise<string[]>}  The run dirs swept.
 */
export async function sweepOrphans(root, keep = null) {
  const keepAbs = keep ? path.resolve(keep) : null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // root absent — nothing to sweep
  }
  const swept = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(root, entry.name);
    if (keepAbs && path.resolve(runDir) === keepAbs) continue;
    await teardown(runDir);
    swept.push(runDir);
  }
  return swept;
}

/**
 * Teardown (bench/SPEC.md §2): idempotent. Stop the daemon, `init --undo` in the
 * cwd (hygiene — an arm that leaves ANTHROPIC_BASE_URL behind poisons the next),
 * remove any leftover credentials secret, then `rm -rf` the run dir. Running it
 * twice succeeds and leaves no daemon, no ANTHROPIC_BASE_URL, no run dir.
 * @param {string} runDir
 */
export async function teardown(runDir) {
  const home = path.join(runDir, 'ccsnoop-home');
  const cwd = path.join(runDir, 'cwd');

  try {
    await daemon.stop(home);
  } catch {
    // already stopped / no home — idempotent
  }

  try {
    if (fs.existsSync(cwd)) init({ cwd, home, undo: true });
  } catch {
    // hygiene only, never fatal (exact restoration is covered by init.test.js)
  }

  // ⚠ the OAuth secret must not linger, even on a partial teardown.
  try {
    for (const entry of fs.readdirSync(runDir)) {
      if (/^arm-/.test(entry)) {
        fs.rmSync(path.join(runDir, entry, '.claude', '.credentials.json'), { force: true });
      }
    }
  } catch {
    // run dir already gone — nothing to scrub
  }

  fs.rmSync(runDir, { recursive: true, force: true });
}

// ── `arm <id>`: run-scoped steps 1–7 ─────────────────────────────────────────

/**
 * Find the newest reusable run dir under `root`: a live daemon whose route is
 * registered (bench/SPEC.md §2 — a later `arm` reuses the infra). Returns its
 * absolute path or null.
 * @param {string} root
 * @returns {string|null}
 */
export function findHealthyRun(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const runs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .sort()
    .reverse(); // newest first (timestamp names sort lexically)
  for (const runDir of runs) {
    const home = path.join(runDir, 'ccsnoop-home');
    const cwd = path.join(runDir, 'cwd');
    if (!fs.existsSync(cwd)) continue;
    if (!daemon.readState(home).running) continue;
    const token = deriveToken(path.join(cwd, '.ccsnoop'));
    const routes = readRoutes(daemon.paths(home).routes);
    if (routeDir(routes, token) != null) return runDir;
  }
  return null;
}

/** Register a SIGINT/SIGTERM trap that tears the active run down (bench/SPEC.md §2). */
function armTrap(runDir) {
  const handler = () => {
    teardown(runDir).finally(() => process.exit(130));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/**
 * `arm <id>` — run-scoped steps 1–7 (this slice only; the per-arm capture steps
 * 8–21 land later). Idempotent: a healthy run is reused and steps 2–5 skipped.
 * @param {string} id
 * @param {{ root?: string, manifestPath?: string, fixtureDir?: string }} [opts]
 * @returns {Promise<{ runDir: string, baseUrl: string, reused: boolean }>}
 */
export async function cmdArm(id, opts = {}) {
  const root = opts.root ?? benchRoot();
  const fixtureDir = opts.fixtureDir ?? FIXTURE_DIR;

  // Step 1 — pre-flight (fatal). Always runs, even on reuse.
  const manifest = readManifest(opts.manifestPath ?? MANIFEST_PATH, { fixtureDir });
  const arm = manifest.arms.find((a) => a.id === id);
  if (!arm) throw new BenchError(`no arm '${id}' in the manifest`);

  // Reuse a healthy run if one exists; sweep everything else (orphan sweep).
  const healthy = findHealthyRun(root);
  await sweepOrphans(root, healthy);

  let runDir = healthy;
  let reused = true;
  if (!runDir) {
    reused = false;
    // Step 2 — create the run dir + its ccsnoop-home.
    fs.mkdirSync(root, { recursive: true });
    runDir = path.join(root, runStamp());
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'ccsnoop-home'), { recursive: true });
    armTrap(runDir);

    const cwd = path.join(runDir, 'cwd');
    const home = path.join(runDir, 'ccsnoop-home');

    // Step 3 — materialize + byte-equality + no-ancestor guard (fatal).
    materializeFixture(fixtureDir, cwd);
    assertNoAncestorConfig(cwd);

    // Step 4 — git init in the cwd (best effort, not fatal): the cwd becomes its
    // own git top-level so init exercises its gitignore branch for E2E coverage.
    gitInit(cwd);

    // Step 5 — the port dance.
    const port = await findFreePort();
    await portDance({ home, cwd, port });
  } else {
    armTrap(runDir);
  }

  const home = path.join(runDir, 'ccsnoop-home');
  const cwd = path.join(runDir, 'cwd');
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');

  // Step 7 — read back the base URL + verify the route is registered.
  const baseUrl = extractBaseUrl(settingsPath);
  const token = deriveToken(path.join(cwd, '.ccsnoop'));
  assertRoutePresent(home, token);

  // Step 6 — reachability guard from a spawned child (fatal).
  await reachabilityGuard(baseUrl);

  return { runDir, baseUrl, reused };
}

/** `git init` in `cwd` (no commit, no remote). Best effort — never throws. */
function gitInit(cwd) {
  try {
    spawnSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
  } catch {
    // best effort (bench/SPEC.md §2 step 4)
  }
}

// ── CLI dispatch (thin) ──────────────────────────────────────────────────────

async function main(argv) {
  const sub = argv[0];

  if (sub === '__reach') {
    reachChild(argv[1]);
    return;
  }

  if (sub === 'arm') {
    const id = argv[1];
    if (!id) throw new BenchError('usage: run.mjs arm <id>');
    const r = await cmdArm(id);
    console.log(`bench arm ${id}: run ${r.runDir}${r.reused ? ' (reused)' : ''}`);
    console.log(`  ANTHROPIC_BASE_URL=${r.baseUrl}`);
    console.log(`  ENABLE_TOOL_SEARCH=true`);
    console.log(`  teardown: node scripts/bench/run.mjs teardown ${r.runDir}`);
    return;
  }

  if (sub === 'teardown') {
    const runDir = argv[1];
    if (!runDir) throw new BenchError('usage: run.mjs teardown <run>');
    await teardown(path.resolve(runDir));
    console.log(`bench teardown: ${runDir} removed`);
    return;
  }

  throw new BenchError(`unknown subcommand '${sub ?? ''}' (expected: arm | teardown)`);
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`bench: ${err?.message ?? err}`);
    process.exit(1);
  });
}
