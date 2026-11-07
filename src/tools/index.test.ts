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
    "agy_agent",
    "agy_agent_message",
    "agy_agent_answer",
    "agy_agent_follow",
    "agy_selftest",
    "agy_debug_log",
    "agy_agent_status",
    "agy_agent_result",
    "agy_agent_stop",
    "agy_agent_list",
    "agy_agent_read",
    "agy_agent_retry",
    "agy_agent_collect",
    "agy_usage",
    "ask-antigravity",
    "bg-antigravity",
  ]) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
});
