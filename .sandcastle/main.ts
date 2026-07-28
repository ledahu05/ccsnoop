import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// --- Model profiles. ----------------------------------------------------------
// A *provider* is the triplet {model id, base URL, token}; that triplet is what
// gets baked into a docker({env}). A *profile* assigns one provider to each of the
// four roles. Picked per run via SANDCASTLE_PROFILE, `split` by default.
//
//   split — planner/implementer/merger on GLM via z.ai, reviewer on Opus via
//           Anthropic. Nominal regime: the reviewer runs a different model than
//           the implementer, so it catches blind spots the author model shares.
//   opus  — all four roles on Opus. The model-diversity guarantee is deliberately
//           given up; review keeps only context diversity (fresh context, distinct
//           prompt, isolated worktree). Assumed price of the profile.
//
// See docs/adr/0002-sandcastle-model-profiles.md (amends ADR-0001).
const OPUS_MODEL = "claude-opus-5";
const GLM_MODEL = "glm-5.2[1m]";
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

// baseUrl null → omit ANTHROPIC_BASE_URL entirely; that absence is what makes
// claude-code hit api.anthropic.com.
const PROVIDERS = {
  zai: {
    model: GLM_MODEL,
    tokenKey: "ANTHROPIC_AUTH_TOKEN",
    baseUrl: ZAI_BASE_URL,
  },
  anthropic: {
    model: OPUS_MODEL,
    tokenKey: "CLAUDE_CODE_OAUTH_TOKEN",
    baseUrl: null,
  },
} as const;

const PROFILES = {
  split: {
    planner: "zai",
    implementer: "zai",
    reviewer: "anthropic",
    merger: "zai",
  },
  opus: {
    planner: "anthropic",
    implementer: "anthropic",
    reviewer: "anthropic",
    merger: "anthropic",
  },
} as const;

type Role = "planner" | "implementer" | "reviewer" | "merger";
type ProviderName = keyof typeof PROVIDERS;
type Provider = (typeof PROVIDERS)[ProviderName];

// Every profile must name a provider for every role — a profile missing a role, or
// naming a provider that does not exist, is a type error rather than a run-time one.
const _profilesAreTotal: Record<string, Record<Role, ProviderName>> = PROFILES;

// --- Profile resolution. ------------------------------------------------------
// Resolved BEFORE the secrets file is read, so a typo in SANDCASTLE_PROFILE reports
// itself as a typo rather than as whatever the secrets file happens to be missing.
// Unknown name throws: never fall back to `split` silently, or the typo would run
// the wrong regime while looking like it worked.
const PROFILE_NAME = process.env.SANDCASTLE_PROFILE ?? "split";
if (!(PROFILE_NAME in PROFILES)) {
  throw new Error(
    `Unknown SANDCASTLE_PROFILE=${JSON.stringify(PROFILE_NAME)}. ` +
      `Valid profiles: ${Object.keys(PROFILES).join(", ")}.`
  );
}
const PROFILE = PROFILES[PROFILE_NAME as keyof typeof PROFILES];

const ROLES = Object.keys(PROFILE) as Role[];
const providerFor = (role: Role): Provider => PROVIDERS[PROFILE[role]];

// Distinct providers this profile actually uses. Only their tokens are required:
// making `opus` depend on a valid z.ai key it never sends would be the kind of
// gratuitous coupling that stops people from switching profile at all.
const requiredProviders = [...new Set(Object.values(PROFILE))];

// --- S1: auth-token isolation. ------------------------------------------------
// sandcastle's resolveEnv merges ALL of .sandcastle/.env into every sandbox, and
// docker({env}) can only ADD keys, not remove them. Two auth tokens in .env would
// both leak into every sandbox → claude-code sends whichever it prefers, against
// the wrong base URL → 401. So .env keeps only GH_TOKEN (every agent uses `gh`),
// and the two auth tokens live here in .env.secrets (gitignored, not read by
// resolveEnv). We bake exactly one token per sandbox. See ADR-0001.
const SECRETS_PATH = path.join(import.meta.dirname, ".env.secrets");

function loadSecrets(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(SECRETS_PATH, "utf8");
  } catch {
    throw new Error(
      `Missing ${SECRETS_PATH}. Create it from .env.secrets.example. Which keys are\n` +
        "required depends on the active profile — only the providers it references:\n" +
        "  ANTHROPIC_AUTH_TOKEN=<z.ai key>              (profile `split`)\n" +
        "  CLAUDE_CODE_OAUTH_TOKEN=<anthropic OAuth token>  (profiles `split`, `opus`)\n" +
        "Auth tokens must NOT live in .sandcastle/.env (leaks to every sandbox → 401)."
    );
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const secrets = loadSecrets();

const need = (key: string): string => {
  const v = secrets[key];
  if (!v) {
    throw new Error(
      `Profile \`${PROFILE_NAME}\` requires ${key}, missing in ${SECRETS_PATH}.`
    );
  }
  return v;
};

// Fail at startup, not at the first createSandbox. The reviewer runs per issue at
// iteration N, *after* a full implementation cycle, and its failure is swallowed by
// a best-effort catch — so a missing token used to surface late AND silently: the
// run merged and nobody saw that review never happened.
const validateTokens = () => {
  for (const name of requiredProviders) need(PROVIDERS[name].tokenKey);
};

// Per-sandbox provider env. Baked on docker({env}); layered ON TOP of resolvedEnv.
// Exactly ONE auth token per sandbox — that is invariant S1 of ADR-0001. Omitting
// ANTHROPIC_BASE_URL entirely is what makes claude-code hit api.anthropic.com; the
// token value is a parameter so the dry-run can print this very object with the
// secret masked, instead of re-deriving the shape and leaving S1 unexercised.
const buildEnv = (provider: Provider, token: string): Record<string, string> => ({
  ...(provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
  [provider.tokenKey]: token,
  ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.model,
});

const envFor = (role: Role): Record<string, string> => {
  const provider = providerFor(role);
  return buildEnv(provider, need(provider.tokenKey));
};

const modelFor = (role: Role): string => providerFor(role).model;

const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

// --- Dry-run: validate wiring without launching any agent. --------------------
// Runs BEFORE validateTokens() so a missing token is *reported* as <MISSING>
// rather than thrown — an unknown profile name, resolved above, still throws.
if (process.env.SANDCASTLE_DRYRUN) {
  console.log(`[dryrun] sandcastle profile: ${PROFILE_NAME}`);
  // depth: null — the per-role `env` is the point of this output; the default
  // depth of 2 would collapse it to [Object].
  console.dir({
    roles: Object.fromEntries(
      ROLES.map((role) => {
        const provider = providerFor(role);
        return [
          role,
          {
            provider: PROFILE[role],
            model: provider.model,
            // The env actually baked into this role's sandbox, secret masked.
            env: buildEnv(
              provider,
              secrets[provider.tokenKey] ? "<set>" : "<MISSING>"
            ),
          },
        ];
      })
    ),
    requiredTokens: Object.fromEntries(
      requiredProviders.map((name) => {
        const { tokenKey } = PROVIDERS[name];
        return [tokenKey, secrets[tokenKey] ? "<set>" : "<MISSING>"];
      })
    ),
    MAX_ITERATIONS,
    MAX_PARALLEL,
  }, { depth: null });
  process.exit(0);
}

validateTokens();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan — orchestrator agent analyzes issues and picks parallelizable work.
  const plan = await sandcastle.run({
    sandbox: docker({ env: envFor("planner") }),
    name: "Planner",
    agent: sandcastle.claudeCode(modelFor("planner")),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Orchestrator did not produce a <plan> tag.\n\n" + plan.stdout
    );
  }

  const { issues } = JSON.parse(planMatch[1]) as {
    issues: { number: number; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    console.log("No issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`
  );
  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title} → ${issue.branch}`);
  }

  // Phase 2: Implement + Review — per issue: impl worktree (z.ai) then review
  // worktree (anthropic), max 4 issues in parallel. Two sequential worktrees on
  // the same branch with different provider env: close() drops the impl worktree
  // path but keeps the branch ref + commits, so the review createSandbox({branch})
  // checks out the existing branch and sees the impl work.
  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = () =>
    running < MAX_PARALLEL
      ? (running++, Promise.resolve())
      : new Promise<void>((resolve) => queue.push(resolve));
  const release = () => {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  };

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      await acquire();
      try {
        // --- Implement (implementer worktree) ---
        const implSandbox = await sandcastle.createSandbox({
          sandbox: docker({ env: envFor("implementer") }),
          branch: issue.branch,
          hooks: {
            host: {
              onSandboxReady: [{ command: "npm ci" }],
            },
          },
        });
        let result;
        try {
          result = await implSandbox.run({
            name: "Implementer #" + issue.number,
            agent: sandcastle.claudeCode(modelFor("implementer")),
            promptFile: "./.sandcastle/implement-prompt.md",
            promptArgs: {
              ISSUE_NUMBER: String(issue.number),
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });
        } finally {
          await implSandbox.close();
        }

        if (result.commits.length === 0) return result;

        // --- Review (second worktree, same branch) ---
        // Best-effort refinement: a reviewer failure must NOT reject the issue —
        // the implementer's commits already landed on the branch.
        //
        // Spun up UNCONDITIONALLY — do not collapse it in profile `opus` just
        // because both envs are identical there. See ADR-0002 (D5) for why.
        const reviewSandbox = await sandcastle.createSandbox({
          sandbox: docker({ env: envFor("reviewer") }),
          branch: issue.branch,
          hooks: {
            host: {
              onSandboxReady: [{ command: "npm ci" }],
            },
          },
        });
        try {
          await reviewSandbox.run({
            name: "Reviewer #" + issue.number,
            agent: sandcastle.claudeCode(modelFor("reviewer")),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              ISSUE_NUMBER: String(issue.number),
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });
        } catch (e) {
          console.error(
            `  ⚠ #${issue.number} review failed; keeping implementation: ${e}`
          );
        } finally {
          await reviewSandbox.close();
        }

        return result;
      } finally {
        release();
      }
    })
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ #${issues[i].number} (${issues[i].branch}) failed: ${outcome.reason}`
      );
    }
  }

  // A branch is mergeable if it has commits not yet on main — whether from this
  // run or a prior iteration whose merge never landed.
  const hasUnmergedWork = (branch: string): boolean => {
    try {
      return (
        execFileSync("git", ["rev-list", "--count", `main..${branch}`], {
          encoding: "utf8",
        }).trim() !== "0"
      );
    } catch {
      return false; // branch missing → implementer never produced it
    }
  };

  const completedIssues = issues.filter((issue) =>
    hasUnmergedWork(issue.branch)
  );

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // Phase 3: Merge — one agent merges all branches together.
  await sandcastle.run({
    sandbox: docker({ env: envFor("merger") }),
    name: "Merger",
    maxIterations: 10,
    agent: sandcastle.claudeCode(modelFor("merger")),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- #${i.number}: ${i.title}`)
        .join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
