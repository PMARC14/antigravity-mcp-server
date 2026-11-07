import { selftestTool, debugLogTool } from "./debug-tools.js";
import { toolRegistry } from "./registry.js";
import { askAgyTool } from "./ask-agy.tool.js";
import { batchAgyTool } from "./batch-agy.tool.js";
import { reviewAgyTool } from "./review-agy.tool.js";
import { planAgyTool } from "./plan-agy.tool.js";
import { brainstormTool } from "./brainstorm.tool.js";
import { bgAgyTool } from "./bg-agy.tool.js";
import { digestAgyTool } from "./digest-agy.tool.js";
import { delegateAgyTool } from "./delegate-agy.tool.js";
import { listSessionsTool } from "./list-sessions.tool.js";
import { healthTool } from "./health.tool.js";
import {
  pingTool,
  helpTool,
  versionTool,
  listModelsTool,
} from "./simple-tools.js";
import { metricsTool } from "./metrics.tool.js";
import { agyUsageTool } from "./agy-usage.tool.js";
import { AgyConnector } from "../connectors/agy.js";
import { JobManager } from "../jobs/manager.js";
import { registerJobTools } from "../jobs/tools.js";
import { Logger } from "../utils/logger.js";
import type { UnifiedTool } from "./registry.js";

const agyConnector = new AgyConnector();
export const agyJobManager = new JobManager(agyConnector, undefined, Logger);
registerJobTools(toolRegistry, "agy", agyJobManager);

/** Legacy synchronous agy tools, registered only when AGY_MCP_LEGACY_TOOLS=1. */
export const agyLegacyTools: UnifiedTool[] = [
  askAgyTool,
  planAgyTool,
  reviewAgyTool,
  brainstormTool,
  digestAgyTool,
  batchAgyTool,
  bgAgyTool,
  delegateAgyTool,
  listSessionsTool,
  listModelsTool,
  metricsTool,
  pingTool,
  helpTool,
  versionTool,
];

/** Standard kept agy tools: always registered. */
export const agyKeptTools: UnifiedTool[] = [
  healthTool,
  agyUsageTool,
  selftestTool,
  debugLogTool,
];

// Sibling Codex compatibility stubs for the shared stability tests
const codexLegacyNames = [
  "ask-codex",
  "batch-codex",
  "review-changes",
  "do-act",
  "brainstorm",
  "fetch-chunk",
  "timeout-test",
  "image-gen",
  "list-skills",
  "list-sessions",
  "help",
  "ping",
  "version",
];
export const legacyTools: UnifiedTool[] = codexLegacyNames.map((name) => {
  const existing = [...agyLegacyTools, ...agyKeptTools].find(
    (t) => t.name === name,
  );
  return (
    existing ??
    ({
      name,
      description: name,
      category: "simple",
      execute: async () => "",
    } as unknown as UnifiedTool)
  );
});

const codexKeptNames = [
  "health",
  "codex_usage",
  "codex_selftest",
  "codex_debug_log",
];
const codexKeptTools: UnifiedTool[] = codexKeptNames.map((name) => {
  const existing = agyKeptTools.find((t) => t.name === name);
  return (
    existing ??
    ({
      name,
      description: name,
      category: "simple",
      execute: async () => "",
    } as unknown as UnifiedTool)
  );
});

export const legacyToolsEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.AGY_MCP_LEGACY_TOOLS === "1";

/**
 * Registers standalone tools.
 * health, agy_usage, agy_selftest, agy_debug_log always register;
 * the legacy set only on request with AGY_MCP_LEGACY_TOOLS=1.
 */
export function registerStandaloneTools(
  registry: typeof toolRegistry,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    registry !== toolRegistry &&
    env.AGY_MCP_LEGACY_TOOLS === undefined
  ) {
    registry.push(
      ...(env.CODEX_MCP_LEGACY_TOOLS === "1" ? legacyTools : []),
      ...codexKeptTools,
    );
    return;
  }
  const enabled = legacyToolsEnabled(env);
  registry.push(...(enabled ? agyLegacyTools : []), ...agyKeptTools);
}

registerStandaloneTools(toolRegistry);

export * from "./registry.js";
