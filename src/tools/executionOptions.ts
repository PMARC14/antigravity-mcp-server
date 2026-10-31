import { z } from "zod";
import { ToolArguments } from "../constants.js";
import {
  AgyCommandBuilderOptions,
  AgyMode,
  resolveAgyMode,
} from "../utils/agyCommandBuilder.js";

export const executionFields = {
  mode: z
    .enum(["read", "write", "full"])
    .optional()
    .describe(
      "Permission mode. Read tools default to read; bg, delegate and batch default to write. Full requires an explicit request.",
    ),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  jsonSchema: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("JSON schema passed to --json-schema."),
  skipPermissions: z
    .boolean()
    .optional()
    .describe("Legacy full-mode switch (default false). Must agree with mode."),
  sandbox: z
    .boolean()
    .optional()
    .describe("Legacy write-mode switch. Must agree with mode."),
};

export function executionOptions(
  args: ToolArguments,
  defaultMode: AgyMode = "read",
): AgyCommandBuilderOptions {
  const options = {
    mode: args.mode,
    effort: args.effort,
    jsonSchema: args.jsonSchema,
    skipPermissions: args.skipPermissions as boolean | undefined,
    sandbox: args.sandbox as boolean | undefined,
  };
  return { ...options, mode: resolveAgyMode(options, defaultMode) };
}
