import { executionFields, executionOptions } from "./executionOptions.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { UnifiedTool } from "./registry.js";
import { startBgTask, getBgTask } from "../utils/bgTaskManager.js";
import { executeCommandDetailed } from "../utils/commandExecutor.js";
import { sanitizeLabel } from "../utils/labels.js";
import {
  collectWorktree,
  capCollectedOutput,
} from "../utils/worktreeCollect.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";

const delegateArgsSchema = z.object({
  ...executionFields,
  action: z
    .enum(["start", "status", "collect"])
    .default("start")
    .describe(
      "start: spawn delegated task; status: check progress; collect: stop + return diff + cleanup option.",
    ),
  task: z
    .string()
    .optional()
    .describe(
      "What Antigravity should accomplish (required for action=start).",
    ),
  acceptanceCriteria: z
    .array(z.string())
    .optional()
    .describe("Bullet list of criteria the implementation must satisfy."),
  baseBranch: z
    .string()
    .optional()
    .describe(
      "Branch/commit to base the worktree on (default: current HEAD of repo).",
    ),
  branchName: z
    .string()
    .optional()
    .describe(
      "Name for the new branch in the worktree. Sanitized to [a-z0-9-], at most 40 characters. Default: agy-<random>.",
    ),
  workingDir: z
    .string()
    .optional()
    .describe("Repo root (default: resolved automatically)."),
  autoTest: z
    .string()
    .optional()
    .describe(
      'Shell command Antigravity should run after editing to validate (e.g., "npm test"). If passed, the agent is told to loop until it passes.',
    ),
  model: z.string().optional(),
  timeout: z
    .number()
    .optional()
    .describe("Execution timeout in milliseconds (default 600000)."),
  // For status/collect
  taskId: z.string().optional(),
  cleanup: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "On collect: also run `git worktree remove` after grabbing the diff.",
    ),
});

interface DelegationMeta {
  taskId: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  baseSha?: string;
  repoRoot: string;
}

const DELEGATIONS_DIR = join(homedir(), ".agy-mcp", "delegations");
const META_FILE = join(DELEGATIONS_DIR, "index.json");

function ensureDir(): void {
  if (!existsSync(DELEGATIONS_DIR))
    mkdirSync(DELEGATIONS_DIR, { recursive: true });
}

function loadIndex(): Record<string, DelegationMeta> {
  ensureDir();
  try {
    if (!existsSync(META_FILE)) return {};
    return JSON.parse(readFileSync(META_FILE, "utf8")) as Record<
      string,
      DelegationMeta
    >;
  } catch {
    return {};
  }
}

function saveIndex(idx: Record<string, DelegationMeta>): void {
  ensureDir();
  writeFileSync(META_FILE, JSON.stringify(idx, null, 2), "utf8");
}

async function runGit(
  cwd: string | undefined,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const r = await executeCommandDetailed("git", args, {
    cwd,
    timeoutMs: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, ok: r.ok };
}

function buildDelegationPrompt(args: {
  task: string;
  acceptanceCriteria?: string[];
  autoTest?: string;
  worktreePath: string;
}): string {
  return [
    `# DELEGATED IMPLEMENTATION TASK`,
    ``,
    `You are operating in an isolated git worktree at: ${args.worktreePath}`,
    `Your work is sandboxed — break things freely. The caller will diff your changes and apply selectively.`,
    ``,
    `## Task`,
    args.task,
    args.acceptanceCriteria?.length
      ? `\n## Acceptance Criteria\n${args.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "",
    args.autoTest
      ? `\n## Validation\nAfter every meaningful change, run: \`${args.autoTest}\`\nLoop edit→test until it passes. If it cannot pass after reasonable attempts, summarise what blocks it.`
      : "",
    ``,
    `## Output expectations`,
    `- Make your changes directly in the worktree files.`,
    `- Keep changes minimal and focused on the task. No drive-by refactors.`,
    `- When done, print a short summary of what changed and why.`,
    `- Do NOT commit — the caller will inspect \`git diff\` and stage selectively.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const delegateAgyTool: UnifiedTool = {
  name: "delegate-antigravity",
  description:
    "Delegate an implementation task to Antigravity in an isolated git worktree. The agent defaults to sandboxed write mode on a fresh branch, optionally looping against a test command. Returns a taskId; later 'collect' to grab the diff. Safe: changes are sandboxed, caller reviews & applies.",
  zodSchema: delegateArgsSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  category: "utility",
  execute: async (args) => {
    const action = (args.action as string) || "start";

    if (action === "start") {
      const task = (args.task as string | undefined)?.trim();
      if (!task) throw new Error("task is required for action=start");

      const repoRoot = resolveWorkingDirectory({
        workingDir: args.workingDir as string | undefined,
        prompt: task,
      });

      const runOptions = executionOptions(args, "write");

      // Confirm it's a git repo
      const isRepo = await runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
      if (!isRepo.ok) {
        return `❌ ${repoRoot} is not inside a git repository — delegate-antigravity requires git for worktree isolation.`;
      }
      const actualRoot = isRepo.stdout.trim();

      const baseBranch = (args.baseBranch as string | undefined) || "HEAD";
      const base = await runGit(actualRoot, [
        "rev-parse",
        "--verify",
        baseBranch + "^{commit}",
      ]);
      if (!base.ok)
        throw new Error(base.stderr || "Cannot resolve base commit");
      const baseSha = base.stdout.trim();
      const label = sanitizeLabel(
        (args.branchName as string | undefined) ||
          "agy-" + randomBytes(4).toString("hex"),
      );
      const branchName = label;
      const status = await runGit(actualRoot, ["status", "--porcelain"]);
      const warning = status.stdout
        ? "\nWarning: uncommitted changes in the original checkout are not included.\n"
        : "";

      ensureDir();
      const worktreePath = join(
        DELEGATIONS_DIR,
        "wt-" + label + "-" + randomBytes(4).toString("hex"),
      );

      const add = await runGit(actualRoot, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        baseSha,
      ]);
      if (!add.ok) {
        return `❌ Failed to create worktree:\n${add.stderr}`;
      }

      const prompt = buildDelegationPrompt({
        task,
        acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
        autoTest: args.autoTest as string | undefined,
        worktreePath,
      });

      const gitDir = await runGit(worktreePath, [
        "rev-parse",
        "--absolute-git-dir",
      ]);
      if (!gitDir.ok) throw new Error(gitDir.stderr);
      const meta = await startBgTask(prompt, {
        ...runOptions,
        addDirs: [gitDir.stdout.trim()],
        model: args.model as string | undefined,
        workingDir: worktreePath,
        timeoutMs: args.timeout as number | undefined,
        label: `delegate:${branchName}`,
      });

      const index = loadIndex();
      index[meta.taskId] = {
        taskId: meta.taskId,
        worktreePath,
        branchName,
        baseBranch,
        baseSha,
        repoRoot: actualRoot,
      };
      saveIndex(index);

      return {
        text: `🚀 Delegated to Antigravity in isolated worktree\n\ntaskId:    ${meta.taskId}\nbranch:    ${branchName}\nworktree:  ${worktreePath}\nbase:      ${baseSha.slice(0, 12)}${warning}\n\nPoll:    delegate-antigravity action=status taskId=${meta.taskId}\nCollect: delegate-antigravity action=collect taskId=${meta.taskId}`,
        structuredContent: {
          taskId: meta.taskId,
          worktreePath,
          branchName,
          baseBranch,
          baseSha,
          pid: meta.pid,
          state: meta.state,
          error: meta.error,
        },
      };
    }

    const taskId = args.taskId as string | undefined;
    if (!taskId) throw new Error(`taskId is required for action=${action}`);

    const idx = loadIndex();
    const delegation = idx[taskId];
    if (!delegation) return `❌ No delegation found for ${taskId}`;
    const bg = getBgTask(taskId);
    if (!bg) return `❌ Background task ${taskId} state missing.`;

    if (action === "status") {
      // Lightweight: just bg state + a peek at git status in the worktree
      const gitStatus = await runGit(delegation.worktreePath, [
        "status",
        "--short",
      ]);
      return {
        text: `task ${taskId}\nstate:      ${bg.state}\nbranch:     ${delegation.branchName}\nworktree:   ${delegation.worktreePath}\n\ngit status:\n${gitStatus.stdout || "(clean)"}`,
        structuredContent: {
          state: bg.state,
          exitCode: bg.exitCode,
          gitStatusShort: gitStatus.stdout,
          delegation,
        },
      };
    }

    if (action === "collect") {
      // Stop if still running, then produce diff
      if (bg.state === "running") {
        // Don't auto-kill — instruct caller. Killing mid-edit might leave a torn change.
        return `⏳ Task ${taskId} still running. Run \`bg-antigravity action=stop taskId=${taskId}\` first, or wait for completion.`;
      }

      const patchPath = join(DELEGATIONS_DIR, taskId + ".patch");
      const collected = await collectWorktree(
        delegation,
        patchPath,
        Boolean(args.cleanup),
      );
      if (collected.cleaned) {
        delete idx[taskId];
        saveIndex(idx);
      }
      const text = `Delegation ${taskId} collected\nbranch: ${delegation.branchName}\nstate: ${bg.state}\n${collected.cleanupNote}\n\n--- diffstat ---\n${collected.diffstat || "(no changes)"}\n--- diff ---\n${collected.diff || "(no changes)"}`;
      return capCollectedOutput(
        text,
        {
          taskId,
          branch: delegation.branchName,
          worktreePath: delegation.worktreePath,
          state: bg.state,
          exitCode: bg.exitCode,
          cleaned: collected.cleaned,
          cleanupNote: collected.cleanupNote.slice(0, 2000),
        },
        collected.diffstat,
        collected.diff,
        patchPath,
      );
    }

    throw new Error(`Unknown action: ${action}`);
  },
};
