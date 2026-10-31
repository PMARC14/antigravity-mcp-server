import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { computeAgyUsage, fetchAgyQuota } from "../utils/agyUsage.js";

const agyUsageArgsSchema = z.object({
  refresh: z
    .boolean()
    .default(false)
    .describe("Ignore the 5-minute cache and run agy /usage again."),
  tallies: z
    .boolean()
    .default(false)
    .describe(
      "Also include best-effort token totals and the latest usage-limit failure from the shared job store.",
    ),
});

export const agyUsageTool: UnifiedTool = {
  name: "agy_usage",
  description:
    "Official agy quota via `agy -p /usage` (no model turn, cached 5 minutes): per model group, 5-hour and weekly used % with reset times, plus a short meter line. Never fails hard; reports unavailable with a reason.",
  zodSchema: agyUsageArgsSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  category: "simple",
  execute: async (args) => {
    const parsed = agyUsageArgsSchema.parse(args);
    const quota = await fetchAgyQuota({ refresh: parsed.refresh });
    return JSON.stringify(
      parsed.tallies ? { ...quota, tallies: computeAgyUsage() } : quota,
      null,
      2,
    );
  },
};
