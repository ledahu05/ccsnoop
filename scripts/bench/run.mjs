// bench run scaffold — a dev script, deliberately absent from `files` in
// package.json (precedent: docs/research/probes/base-url-path-prefix-probe.mjs).
// No --help contract, no semver promise. See bench/SPEC.md §1–§2 and issue #59.
//
// This slice implements the run-scoped steps 1–7 and the per-arm steps 8–21.
//
//   node scripts/bench/run.mjs arm <id>        # steps 1–21 — SPENDS API TOKENS
//   node scripts/bench/run.mjs arm <id> --infra-only   # steps 1–7, zero tokens
//   node scripts/bench/run.mjs teardown <run>  # stop, init --undo, rm -rf
//
// ⚠ `arm <id>` copies `~/.claude/.credentials.json` into the arm's throwaway
// config dir (step 10) and deletes it at step 20, in a `finally`, in a
// `process.on('exit')` handler, and again at teardown. It also spends real
// tokens on two POSTs. `--infra-only` does neither.
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
import { generateReport, loadSession } from '../../src/report.js';
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
 * error (bench/SPEC.md §2 step 1, §5). Five keys for six levers of §3: L6 is
 * carried by `seed: bare`, not by a settings key. */
export const KNOWN_SETTINGS_KEYS = new Set([
  'hooks',
  'permissions',
  'claudeMdExcludes',
  'disabledMcpjsonServers',
  'disableBundledSkills',
]);

/** The step-11 pre-flight's dead port. Port 1 is unbindable without root, so
 * there is no race with a real listener — unlike a freed ephemeral port. */
export const DEAD_PORT = 1;
/** Kill the step-11 pre-flight after this long. B1's failure mode is a silent
 * hang on blocked loopback, which without a timer waits forever. */
export const PREFLIGHT_TIMEOUT_MS = 60_000;
/** Kill the step-12 live run after this long (two POSTs against Haiku). */
export const RUN_TIMEOUT_MS = 300_000;

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
        scrubCredentials(path.join(runDir, entry, '.claude'));
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

/** Register a signal trap that tears the active run down (bench/SPEC.md §2:
 * `trap … EXIT INT TERM`). The EXIT half is the per-arm credentials scrub in
 * {@link runArmCapture} — tearing the whole run down on a throw would destroy
 * every earlier arm's paid capture. */
function armTrap(runDir) {
  const handler = () => {
    teardown(runDir).finally(() => process.exit(130));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('SIGHUP', handler);
}

/**
 * `arm <id>` — the run-scoped steps 1–7, then the per-arm capture 8–21.
 * Idempotent at the run level: a healthy run is reused and steps 2–5 skipped.
 *
 * ⚠ Unless `infraOnly` is set, this SPENDS API TOKENS (step 12) and briefly
 * copies the dev's OAuth secret (step 10).
 *
 * @param {string} id
 * @param {{ root?: string, manifestPath?: string, fixtureDir?: string,
 *           infraOnly?: boolean, claudeBin?: string, credentialsPath?: string,
 *           spawnFn?: typeof spawnSync }} [opts]
 * @returns {Promise<any>}
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

  if (opts.infraOnly) return { runDir, baseUrl, reused, infraOnly: true };

  const capture = await runArmCapture({
    runDir,
    arm,
    manifest,
    baseUrl,
    fixtureDir,
    claudeBin: opts.claudeBin,
    credentialsPath: opts.credentialsPath,
    spawnFn: opts.spawnFn,
  });
  return { runDir, baseUrl, reused, ...capture };
}

/**
 * The per-arm capture, steps 8–21 (bench/SPEC.md §2). Assumes the run-scoped
 * steps 1–7 have already stood the infra up.
 *
 * ⚠ Steps 10–20 bracket a real OAuth secret on disk. It is removed three ways:
 * the `finally` below (step 20), a synchronous `process.on('exit')` handler
 * registered BEFORE the copy (covering `main`'s catch, which does not tear
 * down), and {@link teardown}'s own scrub. Deliberately NOT via `teardown` on
 * the failure path — that does `rm -rf` on the run dir, which one failing arm
 * would use to destroy every earlier arm's paid capture.
 *
 * @param {{ runDir: string, arm: any, manifest: any, baseUrl: string,
 *           fixtureDir?: string, claudeBin?: string, credentialsPath?: string,
 *           spawnFn?: typeof spawnSync }} opts
 */
export async function runArmCapture(opts) {
  const { runDir, arm, manifest, baseUrl } = opts;
  const cwd = path.join(runDir, 'cwd');
  const home = path.join(runDir, 'ccsnoop-home');
  const captureRoot = path.join(cwd, '.ccsnoop', 'sessions');
  const claudeBin = opts.claudeBin ?? 'claude';

  // Steps 8–9 — the arm's isolated config dir, seeded.
  const configDir = writeArmConfig(runDir, arm, opts.fixtureDir ?? FIXTURE_DIR);

  // Step 10 — the secret. The exit handler goes on FIRST, so a throw between
  // here and the copy's completion is still covered.
  const scrub = () => scrubCredentials(configDir);
  process.on('exit', scrub);
  copyCredentials(configDir, opts.credentialsPath ?? credentialsSource());

  try {
    // Step 11 — the `system/init` pre-flight (fatal), on the very config dir
    // the live run will use.
    const preflight = preflightSystemInit({
      configDir,
      cwd,
      model: manifest.model,
      claudeBin,
      spawnFn: opts.spawnFn,
    });

    // Snapshot AFTER the reachability guard: its GET is forwarded upstream and
    // leaves a `proxy-<stamp>` session dir, which belongs in `before`.
    const before = listSessionDirs(captureRoot);

    // Step 12 — the paying run.
    const run = runClaude({
      prompt: manifest.prompt,
      model: manifest.model,
      configDir,
      cwd,
      baseUrl,
      claudeBin,
      spawnFn: opts.spawnFn,
    });

    // Step 13 — session proof (fatal). The exit code is never the evidence.
    const sessionId = pickFreshSession(before, listSessionDirs(captureRoot));
    const sessionDir = path.join(captureRoot, sessionId);
    const lines = readCaptureManifest(sessionDir);

    // Step 14 — the run's daemon serves exactly one route.
    assertStatus(home);

    // Step 15 — `report` for E2E coverage, BEFORE extraction, HTML discarded.
    runReportOnce({
      root: path.join(cwd, '.ccsnoop'),
      sessionId,
      outPath: path.join(armDir(runDir, arm.id), '.report-throwaway.html'),
    });

    // Step 16 — extraction (fatal if absent).
    const captureDir = extractCapture(sessionDir, path.join(armDir(runDir, arm.id), 'capture'));

    // Step 17 — the model, through the single seam. No HTML, no blob re-parse.
    const model = loadSession(captureDir, sessionId);

    // Step 18 — hard observations (gzip is fatal; see #65 for the HEAD half).
    assertGzipObserved(captureDir);
    assertCaptureOrder(readCaptureManifest(captureDir));

    // Step 19 — lever integrity guards: a no-op for the witness, which IS the
    // reference. Wired for the lever arms by #61.

    // Step 21 — the artifacts.
    const record = buildArmRecord({ arm, sessionId, model, preflight });
    fs.writeFileSync(
      path.join(armDir(runDir, arm.id), 'arm.json'),
      JSON.stringify(record, null, 2) + '\n',
    );
    const portMatch = /:(\d+)\//.exec(baseUrl);
    const provenance = buildProvenance({
      claudeCodeVersion: claudeVersion(claudeBin, opts.spawnFn),
      model: manifest.model,
      port: portMatch ? Number(portMatch[1]) : null,
      timestamp: new Date().toISOString(),
      counts: fixtureCounts(opts.fixtureDir ?? FIXTURE_DIR),
      listing: listingSizes(model.exchanges?.[0]),
    });
    fs.writeFileSync(
      path.join(runDir, 'provenance.json'),
      JSON.stringify(provenance, null, 2) + '\n',
    );

    // The manifest declares 2 turns; a mismatch is loud but NOT fatal — §5's
    // exit table is the authority and carries no turn-count row.
    if (manifest.turns != null && lines.length !== manifest.turns) {
      console.warn(
        `bench: ${arm.id} captured ${lines.length} exchange(s), manifest declares ${manifest.turns}`,
      );
    }

    return {
      armDir: armDir(runDir, arm.id),
      captureDir,
      sessionId,
      turns: lines.length,
      toolCount: preflight.toolCount,
      claudeExit: run.code,
      record,
      provenance,
    };
  } finally {
    // Step 20 — the secret goes, on every path.
    scrub();
    process.off('exit', scrub);
  }
}

// ── Steps 8–10, 20: the arm's isolated config dir, and the secret ────────────

/** `<run>/<id>` — the arm's own directory (its `.claude/`, `capture/`, `arm.json`). */
export function armDir(runDir, id) {
  return path.join(runDir, id);
}

/**
 * Steps 8–9 (bench/SPEC.md §2): create `<run>/<id>/.claude/`, write the arm's
 * `settings` there verbatim, then seed it from `<fixtureDir>/seeds/<seed>/`
 * (so `agents/` for `loaded`, nothing for `bare`). This is the only consumer of
 * `seeds/` — {@link materializeFixture} deliberately excludes it from the cwd.
 * Idempotent: a re-run of the same arm starts from a clean config dir.
 *
 * @param {string} runDir
 * @param {{ id: string, settings?: object, seed?: string }} arm
 * @param {string} [fixtureDir]
 * @returns {string} the arm's `CLAUDE_CONFIG_DIR`.
 */
export function writeArmConfig(runDir, arm, fixtureDir = FIXTURE_DIR) {
  const configDir = path.join(armDir(runDir, arm.id), '.claude');
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify(arm.settings ?? {}, null, 2) + '\n',
  );
  if (arm.seed) {
    const seedDir = path.join(fixtureDir, 'seeds', arm.seed);
    for (const entry of fs.readdirSync(seedDir)) {
      if (entry === '.gitkeep') continue; // the `bare` seed's only content
      fs.cpSync(path.join(seedDir, entry), path.join(configDir, entry), { recursive: true });
    }
  }
  return configDir;
}

/** The dev's own OAuth credentials — honouring an already-custom config dir. */
export function credentialsSource() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

/**
 * Step 10 (bench/SPEC.md §2): copy the OAuth secret into the arm's config dir,
 * mode 0600. OAuth creds do not survive isolation — without this `claude` exits
 * 1 with `{"loggedIn": false}` and the failure reads as something else entirely.
 * @param {string} configDir
 * @param {string} [src]
 * @returns {string} the destination path.
 */
export function copyCredentials(configDir, src = credentialsSource()) {
  if (!fs.existsSync(src)) {
    throw new BenchError(
      `no OAuth credentials at ${src} — claude would exit 1 with {"loggedIn": false} (bench/SPEC.md §2 step 10)`,
    );
  }
  const dest = path.join(configDir, '.credentials.json');
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

/**
 * Step 20 (bench/SPEC.md §2): remove the copied secret. Synchronous and
 * idempotent — it runs from a `finally`, from a `process.on('exit')` handler
 * (where nothing async would ever complete), and again from {@link teardown}.
 *
 * `.claude.json` goes too: CC writes it into the config dir at startup and it
 * carries `oauthAccount` (the dev's email and account UUIDs). It holds no
 * token, but §6 keeps runs deliberately under `bench/runs/`, so leaving account
 * identity in a kept run is a leak the bench creates and must clean up.
 *
 * @param {string} configDir
 */
export function scrubCredentials(configDir) {
  for (const name of ['.credentials.json', '.claude.json']) {
    fs.rmSync(path.join(configDir, name), { force: true });
  }
}

/**
 * Child env for a `claude` spawn. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
 * are stripped: subscription auth is the pinned regime (bench/SPEC.md §0), and
 * an inherited key silently switches auth mode and billing.
 * @param {{ configDir: string, baseUrl: string }} opts
 */
function claudeEnv({ configDir, baseUrl }) {
  /** @type {Record<string, string|undefined>} */
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: baseUrl,
    ENABLE_TOOL_SEARCH: 'true',
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// ── Step 11: the `system/init` pre-flight (fatal) ────────────────────────────

/**
 * The first `{"type":"system","subtype":"init"}` event in a stream-json stdout,
 * or null. Pure — the parsing half of {@link preflightSystemInit}.
 * @param {string} stdout
 * @returns {any|null}
 */
export function parseSystemInit(stdout) {
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a partial line — the event we want is whole or absent
    }
    if (event?.type === 'system' && event?.subtype === 'init') return event;
  }
  return null;
}

/**
 * Step 11 (bench/SPEC.md §2): run `claude` against a DEAD port and read the
 * `system/init` event, which CC emits before any POST — zero tokens. Counting
 * the tools beats `claude doctor`, and running against the very config dir the
 * live run will use is what catches a settings file silently ignored under `-p`.
 *
 * ⚠ The exit code is deliberately ignored. Pointed at a dead port, `claude`
 * emits `system/init`, then fails the POST and exits non-zero EVERY time — a
 * guard that checked the status would fail 100% of runs. The evidence is the
 * event, not the exit code.
 *
 * @param {{ configDir: string, cwd: string, model: string, claudeBin?: string,
 *           spawnFn?: typeof spawnSync, timeoutMs?: number }} opts
 * @returns {{ toolCount: number, tools: string[], mcpServers: any[], event: any }}
 */
export function preflightSystemInit(opts) {
  const { configDir, cwd, model } = opts;
  const spawnFn = opts.spawnFn ?? spawnSync;
  const res = spawnFn(
    opts.claudeBin ?? 'claude',
    ['-p', 'preflight', '--model', model, '--output-format', 'stream-json', '--verbose'],
    {
      cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: claudeEnv({ configDir, baseUrl: `http://127.0.0.1:${DEAD_PORT}` }),
    },
  );
  const event = parseSystemInit(res.stdout ?? '');
  if (!event) {
    throw new BenchError(
      `system/init pre-flight emitted no init event for ${configDir} — settings rejected (bench/SPEC.md §5, step 11)`,
    );
  }
  const tools = Array.isArray(event.tools) ? event.tools : [];
  if (tools.length === 0) {
    throw new BenchError(`system/init pre-flight counted 0 tools for ${configDir}`);
  }
  return { toolCount: tools.length, tools, mcpServers: event.mcp_servers ?? [], event };
}

// ── Step 12: the live run (SPENDS TOKENS) ────────────────────────────────────

/**
 * Step 12 (bench/SPEC.md §2): the paying invocation, argv pinned by the spec.
 * No `--output-format`: the wire must stay byte-comparable across all 8 arms.
 * A non-zero exit is NOT fatal here — step 13 is the only session proof.
 *
 * @param {{ prompt: string, model: string, configDir: string, cwd: string,
 *           baseUrl: string, claudeBin?: string, spawnFn?: typeof spawnSync,
 *           timeoutMs?: number }} opts
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function runClaude(opts) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const res = spawnFn(
    opts.claudeBin ?? 'claude',
    ['-p', opts.prompt, '--model', opts.model, '--permission-mode', 'bypassPermissions'],
    {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: claudeEnv({ configDir: opts.configDir, baseUrl: opts.baseUrl }),
    },
  );
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// ── Steps 13–16: session proof, status, report, extraction ───────────────────

/** Directory names under a `sessions/` root, sorted. Missing root → `[]`. */
export function listSessionDirs(sessionsRoot) {
  try {
    return fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Step 13 (bench/SPEC.md §2) — THE session proof: exactly one session dir must
 * have appeared. `claude -p` exiting 0 is never evidence; a broken launch exits
 * 0 having captured nothing, the single most dangerous silent failure here.
 *
 * A set difference (not a latest-mtime pick) because `sessions/` is not empty
 * beforehand: {@link reachabilityGuard}'s GET is forwarded upstream and leaves a
 * `proxy-<stamp>` dir of its own. Anything already present lands in `before`.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string} the fresh session id.
 */
export function pickFreshSession(before, after) {
  const prev = new Set(before);
  const fresh = after.filter((name) => !prev.has(name));
  if (fresh.length === 0) {
    throw new BenchError(
      'zero exchange captured — no new session dir appeared (bench/SPEC.md §5, step 13)',
    );
  }
  if (fresh.length > 1) {
    throw new BenchError(`ambiguous capture: ${fresh.length} new session dirs (${fresh.join(', ')})`);
  }
  return fresh[0];
}

/**
 * The capture's `manifest.jsonl`, one parsed object per line. Throws
 * {@link BenchError} when absent or empty — both are "zero exchange captured".
 * @param {string} sessionDir
 * @returns {any[]}
 */
export function readCaptureManifest(sessionDir) {
  const file = path.join(sessionDir, 'manifest.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new BenchError(`no manifest.jsonl in ${sessionDir} — zero exchange captured (bench/SPEC.md §5, step 13)`);
  }
  const lines = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (lines.length === 0) {
    throw new BenchError(`empty manifest.jsonl in ${sessionDir} — zero exchange captured (bench/SPEC.md §5, step 13)`);
  }
  return lines;
}

/**
 * Step 14 (bench/SPEC.md §2): the run's own daemon serves exactly one route and
 * has been up for a measurable time. Read in process, as `portDance` already
 * calls `daemon.start`/`init` directly rather than through the CLI.
 * @param {string} home
 */
export function assertStatus(home) {
  const status = daemon.statusReport(home);
  if (!status.running) throw new BenchError(`daemon is not running for home ${home}`);
  if (status.routes !== 1) throw new BenchError(`expected exactly 1 route, got ${status.routes}`);
  if (!(Number(status.uptimeMs) > 0)) throw new BenchError(`daemon uptime is ${status.uptimeMs}ms`);
  return status;
}

/**
 * Step 15 (bench/SPEC.md §2): exercise `report` for E2E coverage and throw the
 * HTML away. Runs BEFORE extraction — `init` registers `routes[token].dir` and
 * captures live under it, so extracting first would strip `report` of its target.
 *
 * ⚠ `out` is explicit and OUTSIDE the session dir: `generateReport` otherwise
 * defaults to `<sessionDir>/report.html`, which step 16 would then carry into
 * `capture/`. Never `--all`, never `--home` (the CLI drops it).
 *
 * @param {{ root: string, sessionId: string, outPath: string }} opts
 */
export function runReportOnce({ root, sessionId, outPath }) {
  const result = generateReport({ cwd: process.cwd(), root, session: sessionId, out: outPath });
  fs.rmSync(outPath, { force: true });
  return result;
}

/**
 * Step 16 (bench/SPEC.md §2): move the fresh session dir to `<run>/<id>/capture/`.
 * This is what creates `capture/`; steps 17–19 depend on it. Fatal if absent.
 * @param {string} sessionDir
 * @param {string} destDir
 * @returns {string} `destDir`.
 */
export function extractCapture(sessionDir, destDir) {
  if (!fs.existsSync(sessionDir)) {
    throw new BenchError(`capture absent, cannot extract ${sessionDir} (bench/SPEC.md §5, step 16)`);
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.rmSync(destDir, { recursive: true, force: true });
  try {
    fs.renameSync(sessionDir, destDir);
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'EXDEV') throw err;
    fs.cpSync(sessionDir, destDir, { recursive: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  return destDir;
}

// ── Step 18: hard observations on the nominal path ───────────────────────────

/**
 * Step 18 (bench/SPEC.md §2): the response blob carries the gzip signature.
 *
 * ⚠ Reads the RAW first two bytes, never `usage`. `readUsage`'s truncated-gzip
 * fallback returns raw bytes and leaves `usage` null, so a usage-based guard
 * would lie in exactly the case this guard exists for. A truncated-gzip blob
 * with null `usage` still passes. This sensor is what caught #53.
 *
 * @param {string} captureDir
 * @returns {number} how many blobs carried `1f 8b`.
 */
export function assertGzipObserved(captureDir) {
  let seen = 0;
  for (const line of readCaptureManifest(captureDir)) {
    if (!line.response_blob) continue;
    let fd;
    try {
      fd = fs.openSync(path.join(captureDir, line.response_blob), 'r');
    } catch {
      continue;
    }
    try {
      const head = Buffer.alloc(2);
      const n = fs.readSync(fd, head, 0, 2, 0);
      if (n === 2 && head[0] === 0x1f && head[1] === 0x8b) seen++;
    } finally {
      fs.closeSync(fd);
    }
  }
  if (seen === 0) {
    throw new BenchError(
      `gzip signature 1f 8b not observed on any response blob in ${captureDir} (bench/SPEC.md §5, step 18)`,
    );
  }
  return seen;
}

/**
 * The observable half of step 18's ordering claim: every captured line is a
 * POST exchange and the turns ascend from 1.
 *
 * ⚠ The spec's "`HEAD /<token>/api/hello` precedes the POST in manifest.jsonl"
 * is NOT checkable: `src/proxy.js` answers the preflight HEAD and returns before
 * any capture, so it reaches no manifest line, no blob, no log. Tracked as a
 * product issue (#65) rather than worked around here — bench/SPEC.md §4:
 * "s'il manque une donnée au banc, c'est un ticket produit".
 *
 * @param {any[]} lines
 */
export function assertCaptureOrder(lines) {
  let prev = 0;
  for (const line of lines) {
    const turn = Number(line.turn);
    if (!Number.isFinite(turn) || turn <= prev) {
      throw new BenchError(`captured turns are not strictly ascending (saw ${line.turn} after ${prev})`);
    }
    prev = turn;
  }
  if (Number(lines[0].turn) !== 1) {
    throw new BenchError(`first captured turn is ${lines[0].turn}, expected 1`);
  }
  return true;
}

// ── Step 21: arm.json and provenance.json ────────────────────────────────────

/** The Claude Code build, parsed off `claude --version`. Fatal if unobtainable:
 * the build moves request content at Δ0 bytes, so a run without it is not
 * comparable to any other run (bench/SPEC.md §5, step 21). */
export function claudeVersion(claudeBin = 'claude', spawnFn = spawnSync) {
  const res = spawnFn(claudeBin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const m = /(\d+\.\d+\.\d+)/.exec(String(res.stdout ?? ''));
  if (!m) {
    throw new BenchError(
      `cannot read the Claude Code version from '${claudeBin} --version' — provenance incomplete (bench/SPEC.md §5, step 21)`,
    );
  }
  return m[1];
}

/** This package's version, for provenance. */
export function ccsnoopVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(SELF, '../../../package.json'), 'utf8'));
  return pkg.version;
}

/**
 * Fixture-declared counts (bench/SPEC.md §6) — read from the FIXTURE, never from
 * the arm: arm-06 seeds `bare` and would record `seedAgents: 0`, which would
 * make #62's L6 row unreadable.
 * @param {string} [fixtureDir]
 */
export function fixtureCounts(fixtureDir = FIXTURE_DIR) {
  const agents = fs
    .readdirSync(path.join(fixtureDir, 'seeds', 'loaded', 'agents'))
    .filter((f) => f.endsWith('.md'));
  const stub = fs.readFileSync(path.join(fixtureDir, 'mcp-stub.mjs'), 'utf8');
  const m = /TOOL_COUNT\s*=\s*(\d+)/.exec(stub);
  if (!m) throw new BenchError(`cannot read TOOL_COUNT from ${fixtureDir}/mcp-stub.mjs`);
  return { mcpTools: Number(m[1]), seedAgents: agents.length };
}

/** The §6 `knob` string: which key (or seed) this arm actually turns. */
export function knobOf(arm) {
  const settings = arm.settings ?? {};
  const parts = [];
  if ('hooks' in settings) {
    const sessionStart = settings.hooks?.SessionStart;
    parts.push(
      Array.isArray(sessionStart) && sessionStart.length === 0
        ? 'hooks.SessionStart: []'
        : 'hooks.SessionStart (déclaration)',
    );
  }
  if ('permissions' in settings) parts.push('permissions.deny');
  if ('claudeMdExcludes' in settings) parts.push('claudeMdExcludes');
  if ('disabledMcpjsonServers' in settings) parts.push('disabledMcpjsonServers');
  if ('disableBundledSkills' in settings) parts.push('disableBundledSkills');
  if (arm.seed === 'bare') parts.push('seed bare');
  return parts.join(' + ') || null;
}

/** One turn's BYTES (bench/SPEC.md §4 unit rule: no token field, ever, here). */
function turnBytes(exchange) {
  return {
    anatomy: exchange.anatomy,
    requestBytes: exchange.requestBytes, // always BOTH — anatomy.total < requestBytes
    segments: exchange.segments.map((s) => ({ slot: s.slot, bucket: s.bucket, bytes: s.bytes })),
  };
}

/** One turn's TOKENS, mapped to the §6 names. Null usage stays null — the caller
 * OMITS the key rather than zeroing it, which would publish a false measurement. */
function turnUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens,
    cacheRead: usage.cacheReadInputTokens,
    cacheCreation: usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * `listingSizes` (bench/SPEC.md §6) — provenance, asserted NOWHERE. Neither the
 * spec nor #60 defines how the three named byte counts are derived, and deriving
 * them would mean re-parsing `requestBlob`, which §4 forbids. So: the named keys
 * are null with a reason, and the raw turn-1 `system` slot→bytes map is recorded
 * alongside, so the one paid run is enough to pin them later without paying again.
 * @param {any} exchange  turn 1, or undefined.
 */
export function listingSizes(exchange) {
  /** @type {Record<string, number>} */
  const systemSlotBytes = {};
  for (const seg of exchange?.segments ?? []) {
    if (seg.bucket === 'system') systemSlotBytes[seg.slot] = seg.bytes;
  }
  return {
    deferredToolsBytes: null,
    skillsBytes: null,
    agentTypesBytes: null,
    reason: 'not derivable from slot identity alone; systemSlotBytes is the raw record',
    systemSlotBytes,
  };
}

/**
 * Step 21 (bench/SPEC.md §6): the per-arm record. Bytes come from
 * `segments`/`anatomy`, tokens ONLY from the captured `usage`, and no byte↔token
 * ratio is computed anywhere.
 *
 * @param {{ arm: any, sessionId: string, model: any, preflight?: any }} opts
 */
export function buildArmRecord({ arm, sessionId, model, preflight }) {
  const exchanges = model.exchanges ?? [];
  /** @type {any} */
  const record = {
    id: arm.id,
    label: arm.label,
    lever: arm.lever ?? null,
    knob: knobOf(arm),
    seed: arm.seed ?? null,
    sessionId,
    turns: exchanges.length,
  };
  if (exchanges[0]) record.turn1 = turnBytes(exchanges[0]);
  if (exchanges[1]) record.turn2 = turnBytes(exchanges[1]);

  const usage = {};
  const u1 = turnUsage(exchanges[0]?.usage);
  const u2 = turnUsage(exchanges[1]?.usage);
  if (u1) usage.turn1 = u1;
  if (u2) usage.turn2 = u2;
  if (Object.keys(usage).length) record.usage = usage; // omitted, never zeroed

  const flagship = (exchanges[0]?.segments ?? [])
    .filter((/** @type {any} */ s) => s.flagship)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.bytes - a.bytes)[0];
  record.context = {
    durationMs: exchanges[0]?.durationMs ?? null,
    waste: {
      bloatCount: exchanges[0]?.waste?.bloatCount ?? 0,
      flagship: flagship ? flagship.slot : null,
    },
  };
  if (preflight) {
    // The witness's observed tools[] is where #62's arm-01 deny targets come
    // from — chosen from data, never from a list written in advance (§10.3).
    record.preflight = { toolCount: preflight.toolCount, tools: preflight.tools };
  }
  return record;
}

/**
 * Step 21 (bench/SPEC.md §6): the run's provenance. Mandatory — a run without a
 * CC version is not comparable to any other run.
 * @param {{ claudeCodeVersion: string, model: string, port: number|null,
 *           timestamp: string, counts: object, listing: object }} opts
 */
export function buildProvenance({ claudeCodeVersion, model, port, timestamp, counts, listing }) {
  if (!claudeCodeVersion) {
    throw new BenchError('provenance incomplete: no Claude Code version (bench/SPEC.md §5, step 21)');
  }
  return {
    claudeCodeVersion,
    ccsnoopVersion: ccsnoopVersion(),
    model,
    toolSearch: true, // ENABLE_TOOL_SEARCH, pinned on all 8 arms
    port,
    timestamp,
    fixtureCounts: counts,
    listingSizes: listing, // provenance, asserted nowhere
  };
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
    if (!id) throw new BenchError('usage: run.mjs arm <id> [--infra-only] [--claude-bin <p>] [--credentials <p>] [--manifest <p>]');
    const flag = (name) => {
      const i = argv.indexOf(name);
      return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
    };
    const r = await cmdArm(id, {
      infraOnly: argv.includes('--infra-only'),
      claudeBin: flag('--claude-bin'),
      credentialsPath: flag('--credentials'),
      manifestPath: flag('--manifest'),
    });
    console.log(`bench arm ${id}: run ${r.runDir}${r.reused ? ' (reused)' : ''}`);
    console.log(`  ANTHROPIC_BASE_URL=${r.baseUrl}`);
    console.log(`  ENABLE_TOOL_SEARCH=true`);
    if (r.infraOnly) {
      console.log(`  (--infra-only: steps 8–21 skipped, no tokens spent)`);
    } else {
      console.log(`  pre-flight tools: ${r.toolCount}`);
      console.log(`  session: ${r.sessionId} (${r.turns} exchange${r.turns === 1 ? '' : 's'})`);
      console.log(`  capture: ${r.captureDir}`);
      console.log(`  arm.json: ${path.join(r.armDir, 'arm.json')}`);
      console.log(`  provenance: ${path.join(r.runDir, 'provenance.json')}`);
    }
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
