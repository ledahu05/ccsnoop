import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// --- Model split (diversity invariant: reviewer ≠ implementer model). ---------
// impl side (planner / implementer / merger) on GLM via z.ai ; reviewer on Claude
// opus via Anthropic. Different model on review than on impl → catches blind spots
// the author model shares. See docs/adr/0001-sandcastle-cross-provider-split.md.
const IMPL_MODEL = "glm-5.2[1m]";
const REVIEW_MODEL = "claude-opus-4-8";
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

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
      `Missing ${SECRETS_PATH}. Create it from .env.secrets.example with:\n` +
        "  ANTHROPIC_AUTH_TOKEN=<z.ai key>\n" +
        "  CLAUDE_CODE_OAUTH_TOKEN=<anthropic OAuth token>\n" +
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
  if (!v) throw new Error(`${key} missing in ${SECRETS_PATH}`);
  return v;
};

// Per-sandbox provider env. Baked on docker({env}); layered ON TOP of resolvedEnv.
const zaiEnv = () => ({
  ANTHROPIC_BASE_URL: ZAI_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: need("ANTHROPIC_AUTH_TOKEN"),
  ANTHROPIC_DEFAULT_OPUS_MODEL: IMPL_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: IMPL_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: IMPL_MODEL,
});
const anthropicEnv = () => ({
  // No ANTHROPIC_BASE_URL → claude-code hits api.anthropic.com (Anthropic native).
  CLAUDE_CODE_OAUTH_TOKEN: need("CLAUDE_CODE_OAUTH_TOKEN"),
  ANTHROPIC_DEFAULT_OPUS_MODEL: REVIEW_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: REVIEW_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: REVIEW_MODEL,
});

const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

// --- Dry-run: validate wiring without launching any agent. --------------------
if (process.env.SANDCASTLE_DRYRUN) {
  console.log("[dryrun] sandcastle model-split config:");
  console.log({
    models: {
      planner: IMPL_MODEL,
      implementer: IMPL_MODEL,
      reviewer: REVIEW_MODEL,
      merger: IMPL_MODEL,
    },
    sandboxEnv: {
      zai: {
        ANTHROPIC_BASE_URL: ZAI_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: secrets.ANTHROPIC_AUTH_TOKEN ? "<set>" : "<MISSING>",
        models: IMPL_MODEL,
      },
      anthropic: {
        ANTHROPIC_BASE_URL: "<default api.anthropic.com>",
        CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN
          ? "<set>"
          : "<MISSING>",
        models: REVIEW_MODEL,
      },
    },
    MAX_ITERATIONS,
    MAX_PARALLEL,
  });
  process.exit(0);
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan — orchestrator agent analyzes issues and picks parallelizable work.
  const plan = await sandcastle.run({
    sandbox: docker({ env: zaiEnv() }),
    name: "Planner",
    agent: sandcastle.claudeCode(IMPL_MODEL),
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
        // --- Implement (z.ai worktree) ---
        const implSandbox = await sandcastle.createSandbox({
          sandbox: docker({ env: zaiEnv() }),
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
            agent: sandcastle.claudeCode(IMPL_MODEL),
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

        // --- Review (anthropic worktree, same branch) ---
        // Best-effort refinement: a reviewer failure must NOT reject the issue —
        // the implementer's commits already landed on the branch.
        const reviewSandbox = await sandcastle.createSandbox({
          sandbox: docker({ env: anthropicEnv() }),
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
            agent: sandcastle.claudeCode(REVIEW_MODEL),
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
    sandbox: docker({ env: zaiEnv() }),
    name: "Merger",
    maxIterations: 10,
    agent: sandcastle.claudeCode(IMPL_MODEL),
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
