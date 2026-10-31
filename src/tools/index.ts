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

export const agyJobManager = new JobManager(
  new AgyConnector(),
  undefined,
  Logger,
);
registerJobTools(toolRegistry, "agy", agyJobManager);

toolRegistry.push(
  agyUsageTool,
  askAgyTool,
  batchAgyTool,
  reviewAgyTool,
  planAgyTool,
  brainstormTool,
  bgAgyTool,
  digestAgyTool,
  delegateAgyTool,
  listSessionsTool,
  healthTool,
  listModelsTool,
  pingTool,
  helpTool,
  versionTool,
  metricsTool,
);

export * from "./registry.js";
