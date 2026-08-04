// Activation — `ccsnoop init` (spec §3.2, non-negotiable 5).
//
// `init` routes the current repo at the machine daemon, reversibly. It anchors
// to the git top-level, writes Claude Code's `env` block into
// `.claude/settings.local.json` (strict-JSON read-modify-write — CC rejects
// non-strict JSON), registers the repo's token→dir route in `~/.ccsnoop/
// routes.json` with a per-token manifest, and gitignores the capture dir. Every
// mutation is recorded in the manifest so `--undo` reverts *exactly* what init
// added and never touches captured `.ccsnoop/` data.
//
// Filesystem + `git` only — no network. The daemon consumes the route (§3.3).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { deriveToken } from './routes.js';
import * as daemon from './daemon.js';

/**
 * A ccsnoop-managed `ANTHROPIC_BASE_URL`: `http(s)://<localhost>:<port>/<token>`,
 * the exact shape init bakes in (§3.2/§3.3). Anything else is a *foreign* value
 * that init must not silently overwrite (refused without `--force`) and undo
 * must not remove.
 */
const CCSNOOP_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[0-9a-f]{8}$/;

/** The gitignore pattern for a settings.local.json init created itself. */
const SETTINGS_IGNORE = '.claude/settings.local.json';
/** The gitignore pattern for the capture dir (non-negotiable 5). */
const CAPTURE_IGNORE = '.ccsnoop/';

/**
 * An init-level failure with a user-facing message (no stack noise). The CLI
 * prints `.message` to stderr and exits non-zero.
 */
export class InitError extends Error {}

/**
 * The git top-level for `cwd`, or `null` if `cwd` is not inside a work tree.
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitTopLevel(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim() || null;
}

/**
 * Strict-JSON read: parse `file` or return `fallback` when it is absent. A file
 * that exists but is *not* strict JSON throws — init never clobbers a settings
 * file it cannot understand (§3.2). Exported so other modules reuse the same
 * discipline; `ErrorCtor` defaults to {@link InitError} but `apply` passes its
 * own {@link module:apply.ApplyError} so a refusal surfaces under the right name.
 * @param {string} file
 * @param {any} fallback
 * @param {new (message?: string) => Error} [ErrorCtor]
 */
export function readJsonStrict(file, fallback, ErrorCtor = InitError) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ErrorCtor(`${file} is not valid JSON — refusing to overwrite it (${/** @type {Error} */ (err).message})`);
  }
}

/**
 * Pretty-print `obj` to `file` (trailing newline), creating parent dirs. Exported
 * so {@link module:apply.safeMergeSettings} writes with init's exact formatting
 * (the strict read-modify-write pattern is one shared helper, not two copies).
 * @param {string} file
 * @param {any} obj
 */
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Read `routes.json` as an object map (missing/malformed → `{}`). Unlike the
 * daemon's tolerant reader, a malformed routes file here throws so init/undo do
 * not silently drop other repos' routes.
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readRoutesStrict(file) {
  const parsed = readJsonStrict(file, {});
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed;
}

/**
 * Ensure each pattern in `patterns` appears as its own line in `.gitignore`,
 * appending the missing ones. Creates the file if absent.
 * @param {string} file
 * @param {string[]} patterns
 * @returns {Record<string, boolean>} pattern → true iff init appended it.
 */
function ensureGitignore(file, patterns) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const present = new Set(text.split('\n').map((l) => l.trim()));
  /** @type {Record<string, boolean>} */
  const added = {};
  const toAppend = [];
  for (const p of patterns) {
    if (present.has(p)) {
      added[p] = false;
    } else {
      added[p] = true;
      toAppend.push(p);
    }
  }
  if (toAppend.length) {
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, text + sep + toAppend.join('\n') + '\n');
  }
  return added;
}

/**
 * Remove the given patterns (exact trimmed-line match) from `.gitignore`.
 * @param {string} file
 * @param {string[]} patterns
 */
function removeGitignore(file, patterns) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const drop = new Set(patterns);
  const kept = text.split('\n').filter((l) => !drop.has(l.trim()));
  const out = kept.join('\n');
  fs.writeFileSync(file, out);
}

/**
 * Resolve the anchor-relative paths init operates on. When `cwd` is inside a git
 * work tree the anchor is the git top-level; otherwise it falls back to `cwd`
 * itself — Claude Code anchors its `settings.local.json` to the directory it was
 * launched in, so that directory is the correct anchor even when it is not a git
 * repo. `isGit` records which case we are in (the gitignore step is skipped when
 * false — there is no repo to ignore for).
 * @param {string} cwd
 * @param {string} home
 */
function resolvePaths(cwd, home) {
  const top = gitTopLevel(cwd);
  const repo = top ?? path.resolve(cwd); // non-git: anchor to CC's project dir
  const isGit = top != null;
  const captureDir = path.join(repo, '.ccsnoop');
  return {
    repo,
    isGit,
    captureDir,
    token: deriveToken(captureDir),
    settings: path.join(repo, '.claude', 'settings.local.json'),
    gitignore: path.join(repo, '.gitignore'),
    routes: daemon.paths(home).routes,
  };
}

/**
 * `ccsnoop init` (spec §3.2). Anchors to the git top-level — or, when `cwd` is
 * not in a git work tree, to `cwd` itself (Claude Code's project dir) — writes
 * the CC `env` block, registers the route + manifest, and gitignores the capture
 * dir (skipped for a non-git anchor, which has no repo to ignore for). `undo:
 * true` reverts exactly what a prior init added. Idempotent: a re-run rewrites
 * only ccsnoop-shaped values and preserves the original manifest's provenance
 * flags so undo still restores the true pre-init state.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]    Working directory (default `process.cwd()`).
 * @param {string} [opts.home]   ccsnoop home (default `~/.ccsnoop`).
 * @param {boolean} [opts.force] Overwrite a foreign `ANTHROPIC_BASE_URL`.
 * @param {boolean} [opts.undo]  Revert a prior init instead of applying one.
 * @returns {{ exitCode: number, lines: string[], token: string, captureDir: string }}
 */
export function init(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? daemon.defaultHome();
  const P = resolvePaths(cwd, home);
  return opts.undo ? undoInit(P) : applyInit(P, home, !!opts.force);
}

/**
 * @param {ReturnType<typeof resolvePaths>} P
 * @param {string} home
 * @param {boolean} force
 */
function applyInit(P, home, force) {
  const port = daemon.configuredPort(home);
  const baseUrl = `http://localhost:${port}/${P.token}`;

  const routes = readRoutesStrict(P.routes);
  const prior = routes[P.token] && typeof routes[P.token] === 'object' ? routes[P.token] : null;

  // ── settings.local.json — strict-JSON read-modify-write ─────────────────────
  const existed = fs.existsSync(P.settings);
  const settings = existed ? readJsonStrict(P.settings, {}) : {};
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new InitError(`${P.settings} is not a JSON object — refusing to overwrite it`);
  }
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  const existingUrl = env.ANTHROPIC_BASE_URL;
  if (typeof existingUrl === 'string' && existingUrl !== '' && !CCSNOOP_URL_RE.test(existingUrl) && !force) {
    throw new InitError(
      `refusing to overwrite a foreign ANTHROPIC_BASE_URL (${existingUrl}) — re-run with --force to replace it`,
    );
  }

  // Provenance: preserve a prior manifest's record so undo reverts to the TRUE
  // pre-init state even across idempotent re-runs; otherwise snapshot what this
  // first init is about to overwrite. `env_prev[key] === null` means the key was
  // absent (undo deletes it); a string means restore that exact value.
  const createdLocalSettings = prior ? !!prior.created_local_settings : !existed;
  const envPrev =
    prior && prior.env_prev && typeof prior.env_prev === 'object'
      ? prior.env_prev
      : {
          ANTHROPIC_BASE_URL: 'ANTHROPIC_BASE_URL' in env ? env.ANTHROPIC_BASE_URL : null,
          ENABLE_TOOL_SEARCH: 'ENABLE_TOOL_SEARCH' in env ? env.ENABLE_TOOL_SEARCH : null,
        };

  env.ANTHROPIC_BASE_URL = baseUrl; // §3.3 path-token routing
  env.ENABLE_TOOL_SEARCH = 'true'; // §1.1 capture fidelity (resolves the flagged seam)
  settings.env = env;
  writeJson(P.settings, settings);

  // ── gitignore the capture dir (+ settings iff we created it) ────────────────
  // A non-git anchor has no repo to ignore for — skip the step entirely, leaving
  // both manifest flags false so undo does no gitignore surgery either.
  let added = {};
  if (P.isGit) {
    const patterns = [CAPTURE_IGNORE];
    if (createdLocalSettings) patterns.push(SETTINGS_IGNORE);
    added = ensureGitignore(P.gitignore, patterns);
  }
  const addedGitignoreCcsnoop = prior ? !!prior.added_gitignore_ccsnoop : !!added[CAPTURE_IGNORE];
  const addedGitignoreSettings = prior
    ? !!prior.added_gitignore_settings
    : !!added[SETTINGS_IGNORE];

  // ── register the route + per-token manifest ─────────────────────────────────
  routes[P.token] = {
    dir: P.captureDir,
    repo: P.repo,
    created_local_settings: createdLocalSettings,
    added_gitignore_ccsnoop: addedGitignoreCcsnoop,
    added_gitignore_settings: addedGitignoreSettings,
    env_prev: envPrev,
  };
  writeJson(P.routes, routes);

  const lines = [
    `ccsnoop init: capturing ${P.repo}`,
    `  route ${P.token} → ${P.captureDir}/sessions/`,
    `  ANTHROPIC_BASE_URL=${baseUrl}, ENABLE_TOOL_SEARCH=true → ${P.settings}`,
    `  restart Claude Code for the new env to take effect`,
  ];
  if (!P.isGit) {
    lines.push(`  anchored to ${P.repo} (not a git repo — settings written, nothing gitignored)`);
  }

  return {
    exitCode: 0,
    token: P.token,
    captureDir: P.captureDir,
    lines,
  };
}

/**
 * Restore one env key to its pre-init value from the manifest snapshot: a
 * recorded `null` (absent before) deletes the key; a string puts that value
 * back.
 * @param {Record<string, any>} env
 * @param {string} key
 * @param {Record<string, any>} prev
 */
function restoreEnvKey(env, key, prev) {
  const before = prev[key];
  if (before === null || before === undefined) delete env[key];
  else env[key] = before;
}

/**
 * `ccsnoop init --undo` — driven entirely by the per-token manifest, so it
 * reverts exactly what init added and never deletes captured `.ccsnoop/` data.
 * @param {ReturnType<typeof resolvePaths>} P
 */
function undoInit(P) {
  const routes = readRoutesStrict(P.routes);
  const m = routes[P.token];
  if (!m || typeof m !== 'object') {
    return {
      exitCode: 0,
      token: P.token,
      captureDir: P.captureDir,
      lines: [`ccsnoop init --undo: no ccsnoop route registered for ${P.repo} — nothing to undo`],
    };
  }

  // ── settings.local.json ─────────────────────────────────────────────────────
  if (m.created_local_settings) {
    fs.rmSync(P.settings, { force: true });
    // Remove a now-empty .claude dir init may have created; leave it if the user
    // keeps other settings there.
    try {
      fs.rmdirSync(path.dirname(P.settings));
    } catch {
      // non-empty or already gone — leave it.
    }
  } else if (fs.existsSync(P.settings)) {
    const settings = readJsonStrict(P.settings, {});
    const env =
      settings && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : null;
    if (env) {
      const prev = m.env_prev && typeof m.env_prev === 'object' ? m.env_prev : {};
      // Restore each managed key to its exact pre-init value: absent-before →
      // delete; had-a-value → put it back. Only touch a base URL that is still
      // ccsnoop-shaped — a manual change made after init is the user's, not ours.
      const url = env.ANTHROPIC_BASE_URL;
      if (typeof url === 'string' && CCSNOOP_URL_RE.test(url)) {
        restoreEnvKey(env, 'ANTHROPIC_BASE_URL', prev);
      }
      restoreEnvKey(env, 'ENABLE_TOOL_SEARCH', prev);
      if (Object.keys(env).length === 0) delete settings.env;
      else settings.env = env;
      writeJson(P.settings, settings);
    }
  }

  // ── gitignore ───────────────────────────────────────────────────────────────
  const toRemove = [];
  if (m.added_gitignore_ccsnoop) toRemove.push(CAPTURE_IGNORE);
  if (m.added_gitignore_settings) toRemove.push(SETTINGS_IGNORE);
  if (toRemove.length) removeGitignore(P.gitignore, toRemove);

  // ── route registry ───────────────────────────────────────────────────────────
  delete routes[P.token];
  writeJson(P.routes, routes);

  return {
    exitCode: 0,
    token: P.token,
    captureDir: P.captureDir,
    lines: [
      `ccsnoop init --undo: reverted ${P.repo}`,
      `  removed route ${P.token}; captured data under ${P.captureDir} left intact`,
      `  restart Claude Code to stop routing through ccsnoop`,
    ],
  };
}

/**
 * Reconstruct the minimal {@link resolvePaths} shape {@link undoInit} needs, from
 * a route's recorded manifest rather than by re-deriving it from `cwd` (no `git`
 * spawn). `repo`/`dir` are the two anchors init stored; `isGit` is unused on the
 * undo path.
 * @param {string} token
 * @param {{ repo?: string, dir?: string }} m
 * @param {string} routesFile
 * @returns {{ repo: string, isGit: boolean, captureDir: string, token: string, settings: string, gitignore: string, routes: string }}
 */
function pathsFromManifest(token, m, routesFile) {
  const repo = typeof m.repo === 'string' && m.repo ? m.repo : (typeof m.dir === 'string' ? path.dirname(m.dir) : '');
  const captureDir = typeof m.dir === 'string' && m.dir ? m.dir : path.join(repo, '.ccsnoop');
  return {
    repo,
    isGit: false, // unused by undoInit
    captureDir,
    token,
    settings: path.join(repo, '.claude', 'settings.local.json'),
    gitignore: path.join(repo, '.gitignore'),
    routes: routesFile,
  };
}

/**
 * `ccsnoop stop --clean` — un-route every registered repo in one shot (issue
 * #90, gap 1). The default `stop` leaves `routes.json` intact (spec §3.4: routes
 * survive a restart); `--clean` opts into reverting every repo the daemon served,
 * so a session relaunched afterwards isn't left pointing at the now-dead port.
 *
 * Reuses {@link undoInit} per route, so each repo is reverted with its own
 * recorded provenance (`env_prev`, gitignore flags) and captured `.ccsnoop/`
 * data is never touched. It cannot reach sessions already running — their env is
 * cached in-process until restart — so pair it with the `stop` stranded-session
 * warning. Malformed `routes.json` throws (same strict read as a single undo),
 * refusing to drop other repos' routes.
 *
 * @param {string} home
 * @returns {{ exitCode: number, lines: string[], undone: string[] }}
 *   `undone` is the list of route tokens reverted (empty if none registered).
 */
export function undoAllRoutes(home) {
  const routesFile = daemon.paths(home).routes;
  const routes = readRoutesStrict(routesFile);
  const tokens = Object.keys(routes).filter(
    (t) => routes[t] && typeof routes[t] === 'object',
  );
  if (tokens.length === 0) {
    return {
      exitCode: 0,
      undone: [],
      lines: ['ccsnoop stop --clean: no routes registered — nothing to un-route'],
    };
  }
  /** @type {string[]} */
  const undone = [];
  const lines = [`ccsnoop stop --clean: un-routing ${tokens.length} repo${tokens.length === 1 ? '' : 's'}`];
  for (const token of tokens) {
    // undoInit re-reads routes.json and deletes this one token, so each call is
    // independent and the loop converges on an empty registry.
    undoInit(pathsFromManifest(token, routes[token], routesFile));
    undone.push(token);
    const repo = typeof routes[token].repo === 'string' ? routes[token].repo : routes[token].dir ?? '';
    lines.push(`  un-routed ${token} → ${repo || '(unknown repo)'}`);
  }
  lines.push('  restart Claude Code in each repo to clear the cached ANTHROPIC_BASE_URL');
  return { exitCode: 0, undone, lines };
}
