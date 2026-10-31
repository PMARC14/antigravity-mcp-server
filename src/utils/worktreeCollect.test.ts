import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectWorktree,
  capCollectedOutput,
  GitRunner,
} from "./worktreeCollect.js";

// File-backed stdio also works in Windows sandboxes that prohibit Node pipes.
function gitRunner(temp: string): GitRunner {
  return async (cwd, args) => {
    const outPath = join(temp, "git.stdout");
    const errPath = join(temp, "git.stderr");
    const out = openSync(outPath, "w");
    const err = openSync(errPath, "w");
    let result;
    try {
      result = spawnSync("git", args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", out, err],
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(readFileSync(errPath, "utf8"));
    return readFileSync(outPath, "utf8");
  };
}

test("collect saves new and binary files against the starting SHA, including worker commits", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agy-collect-"));
  const repo = join(temp, "repo");
  const git = gitRunner(temp);
  try {
    await git(temp, ["init", repo]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "fixture base"]);
    const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    writeFileSync(join(repo, "committed.txt"), "worker committed this\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "fixture worker commit"]);
    writeFileSync(join(repo, "new.txt"), "untracked new contents\n");
    const binary = Buffer.from([0, 255, 0, 17, 128, 0, 42]);
    writeFileSync(join(repo, "new.bin"), binary);
    const patchPath = join(temp, "saved.patch");
    const record = {
      worktreePath: repo,
      repoRoot: repo,
      branchName: "unused",
      baseBranch: "HEAD",
      baseSha,
    };
    const result = await collectWorktree(record, patchPath, false, git);
    const patch = readFileSync(patchPath, "utf8");
    assert.equal(result.diff, patch);
    assert.match(patch, /\+untracked new contents/);
    assert.match(patch, /\+worker committed this/);
    assert.match(patch, /GIT binary patch/);
    assert.match(result.diffstat, /new.bin/);
    // Applying the saved patch onto the original base reconstructs every file.
    await git(repo, ["reset", "--hard", baseSha]);
    await git(repo, ["apply", "--binary", patchPath]);
    assert.equal(
      readFileSync(join(repo, "new.txt"), "utf8"),
      "untracked new contents\n",
    );
    assert.deepEqual(readFileSync(join(repo, "new.bin")), binary);
    assert.equal(
      readFileSync(join(repo, "committed.txt"), "utf8"),
      "worker committed this\n",
    );
    // Legacy records without baseSha still collect against their saved base ref.
    const legacy = await collectWorktree(
      { ...record, baseSha: undefined, baseBranch: baseSha },
      join(temp, "legacy.patch"),
      false,
      git,
    );
    assert.match(legacy.diff, /GIT binary patch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("cleanup cannot run until a patch has been saved; failures remain visible", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agy-collect-order-"));
  const patchPath = join(temp, "patch.diff");
  const record = {
    worktreePath: temp,
    repoRoot: temp,
    branchName: "branch",
    baseBranch: "HEAD",
    baseSha: "saved-sha",
  };
  const calls: string[][] = [];
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === "worktree") {
      assert.equal(readFileSync(patchPath, "utf8"), "patch\n");
      throw new Error("locked worktree");
    }
    return args.includes("--binary") ? "patch\n" : "";
  };
  try {
    await assert.rejects(
      collectWorktree(record, join(temp, "missing", "patch"), true, git),
      /ENOENT/,
    );
    assert.ok(!calls.some((args) => args[0] === "worktree"));
    const result = await collectWorktree(record, patchPath, true, git);
    assert.ok(existsSync(patchPath));
    assert.equal(result.cleaned, false);
    assert.match(result.cleanupNote, /locked worktree/);
    assert.ok(!calls.some((args) => args[0] === "branch"));
    const count = calls.length;
    await assert.rejects(
      collectWorktree(record, patchPath, true, async () => {
        throw new Error("git failed");
      }),
      /git failed/,
    );
    assert.equal(calls.length, count);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("collect caps both text and serialized structured output at 20k plus the patch path", () => {
  const patchPath = "/tmp/saved.patch";
  const result = capCollectedOutput(
    "text".repeat(10000),
    { taskId: "abc", state: "completed" },
    "stat\n".repeat(10000),
    '\\"\n'.repeat(10000),
    patchPath,
  );
  assert.ok(
    result.text.replace(`\n\nFull patch: ${patchPath}`, "").length <= 20000,
  );
  const { patchPath: savedPath, ...fields } = result.structuredContent;
  assert.equal(savedPath, patchPath);
  assert.ok(JSON.stringify(fields).length <= 20000);
  assert.ok(fields.diff.length > 0);
});
