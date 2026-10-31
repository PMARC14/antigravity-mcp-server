import { writeFileSync } from "fs";
import { executeCommandDetailed } from "./commandExecutor.js";

export interface WorktreeRecord {
  worktreePath: string;
  repoRoot: string;
  branchName: string;
  baseSha?: string;
  baseBranch: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await executeCommandDetailed("git", args, {
    cwd,
    timeoutMs: 60_000,
    trimOutput: false,
  });
  if (!result.ok) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

/** Save a complete patch before any cleanup, including worker commits. */
export async function collectWorktree(
  record: WorktreeRecord,
  patchPath: string,
  cleanup = false,
  runGit: GitRunner = git,
) {
  // Older records only have baseBranch. Resolve it once, before staging.
  const baseSha =
    record.baseSha ??
    (
      await runGit(record.worktreePath, [
        "rev-parse",
        "--verify",
        `${record.baseBranch}^{commit}`,
      ])
    ).trim();
  await runGit(record.worktreePath, ["add", "-A"]);
  const diff = await runGit(record.worktreePath, [
    "diff",
    "--binary",
    "--cached",
    baseSha,
  ]);
  const diffstat = await runGit(record.worktreePath, [
    "diff",
    "--stat",
    "--cached",
    baseSha,
  ]);
  writeFileSync(patchPath, diff, "utf8");

  let cleaned = false;
  let cleanupNote = "";
  if (cleanup) {
    try {
      await runGit(record.repoRoot, [
        "worktree",
        "remove",
        "--force",
        record.worktreePath,
      ]);
      await runGit(record.repoRoot, ["branch", "-D", record.branchName]);
      cleaned = true;
      cleanupNote = "Worktree and branch removed.";
    } catch (error) {
      cleanupNote = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { diff, diffstat, patchPath, cleaned, cleanupNote };
}

export function capCollectedOutput(
  text: string,
  fields: Record<string, unknown>,
  diffstat: string,
  diff: string,
  patchPath: string,
) {
  const boundedFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 2000) : value,
    ]),
  );
  const structuredContent = {
    ...boundedFields,
    diffstat: diffstat.slice(0, 2000),
    diff: "",
  };
  // Bound serialized output too: escaped newlines and binary patches count.
  let low = 0;
  let high = Math.min(diff.length, 20_000);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    structuredContent.diff = diff.slice(0, mid);
    if (JSON.stringify(structuredContent).length <= 20_000) low = mid;
    else high = mid - 1;
  }
  structuredContent.diff = diff.slice(0, low);
  return {
    text: text.slice(0, 20_000) + `\n\nFull patch: ${patchPath}`,
    structuredContent: { ...structuredContent, patchPath },
  };
}
