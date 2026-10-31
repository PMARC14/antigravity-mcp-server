import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tool index builds the job manager on import, so point its store at a
// temp dir before loading it; the real ~/.agent-jobs must never be touched.
const home = mkdtempSync(join(tmpdir(), "agy-index-"));
process.env.AGENT_JOBS_HOME = home;

test("the server registers the agy job tools and agy_usage", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { toolRegistry, agyJobManager } = await import("./index.js");
  t.after(() => (agyJobManager as { dispose?: () => unknown }).dispose?.());
  const names = toolRegistry.map((tool) => tool.name);
  for (const name of [
    "agy_job_start",
    "agy_job_status",
    "agy_job_result",
    "agy_job_cancel",
    "agy_job_list",
    "agy_job_read",
    "agy_job_requeue",
    "agy_worktree_collect",
    "agy_usage",
    "ask-antigravity",
    "bg-antigravity",
  ]) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
});
