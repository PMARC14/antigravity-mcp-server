import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tool index builds the job manager on import, so point its store at a
// temp dir before loading it; the real ~/.agent-jobs must never be touched.
const home = mkdtempSync(join(tmpdir(), "agy-index-"));
process.env.AGENT_JOBS_HOME = home;

test("the server registers the agy job tools and agy_usage, but legacy tools only with AGY_MCP_LEGACY_TOOLS=1", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { toolRegistry, agyJobManager, registerStandaloneTools, agyLegacyTools } = await import("./index.js");
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
    "health",
  ]) {
    assert.ok(names.includes(name), `missing kept tool ${name}`);
  }

  // Without AGY_MCP_LEGACY_TOOLS=1, legacy tools are not registered
  if (process.env.AGY_MCP_LEGACY_TOOLS !== "1") {
    for (const tool of agyLegacyTools) {
      assert.ok(!names.includes(tool.name), `legacy tool ${tool.name} should not be registered by default`);
    }
  }

  // With AGY_MCP_LEGACY_TOOLS=1, registerStandaloneTools registers legacy tools
  const customRegistry: any[] = [];
  registerStandaloneTools(customRegistry as any, { AGY_MCP_LEGACY_TOOLS: "1" });
  const customNames = customRegistry.map((tool) => tool.name);
  for (const tool of agyLegacyTools) {
    assert.ok(customNames.includes(tool.name), `expected legacy tool ${tool.name} when AGY_MCP_LEGACY_TOOLS=1`);
  }
  for (const name of ["health", "agy_usage", "agy_selftest", "agy_debug_log"]) {
    assert.ok(customNames.includes(name), `expected kept tool ${name}`);
  }
});
