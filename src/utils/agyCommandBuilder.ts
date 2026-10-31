import { CLI, DEFAULT_MODEL } from "../constants.js";
import { resolveWorkingDirectory } from "./workingDirResolver.js";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export type AgyMode = "read" | "write" | "full";
export type AgyEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Options verified against the agy 1.4.9 spike. */
export interface AgyCommandBuilderOptions {
  readonly model?: string;
  readonly mode?: AgyMode;
  readonly effort?: AgyEffort;
  readonly jsonSchema?: string | Record<string, unknown>;
  readonly skipPermissions?: boolean;
  readonly sandbox?: boolean;
  readonly cd?: string;
  readonly workingDir?: string;
  readonly addDirs?: string[];
  readonly conversationId?: string;
  readonly continueLatest?: boolean;
  readonly timeoutMs?: number;
  /** Caller-owned log; otherwise a temporary fallback log is cleaned up. */
  readonly logFile?: string;
  readonly concisePrompt?: boolean;
}

export interface BuildResult {
  args: string[];
  tempFiles: string[];
  finalPrompt: string;
  useResume: boolean;
  workingDir?: string;
  logFile: string;
  stdin: string;
}

export function resolveAgyMode(
  options: AgyCommandBuilderOptions = {},
  defaultMode: AgyMode = "read",
): AgyMode {
  const mode =
    options.mode ??
    (options.skipPermissions === true
      ? "full"
      : options.sandbox !== undefined
        ? options.sandbox
          ? "write"
          : "read"
        : defaultMode);
  if (!["read", "write", "full"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Expected read, write or full.`);
  }
  if (
    options.skipPermissions !== undefined &&
    options.skipPermissions !== (mode === "full")
  ) {
    throw new Error(
      `mode=${mode} conflicts with skipPermissions=${options.skipPermissions}.`,
    );
  }
  if (options.sandbox !== undefined && options.sandbox !== (mode === "write")) {
    throw new Error(`mode=${mode} conflicts with sandbox=${options.sandbox}.`);
  }
  return mode;
}

export class AgyCommandBuilder {
  async build(
    prompt: string,
    options: AgyCommandBuilderOptions = {},
  ): Promise<BuildResult> {
    return this.buildSync(prompt, options);
  }

  /** Synchronous form for callers (job connector) that cannot await. */
  buildSync(
    prompt: string,
    options: AgyCommandBuilderOptions = {},
  ): BuildResult {
    if (options.conversationId && options.continueLatest) {
      throw new Error(
        "Cannot combine conversationId (--conversation) with continueLatest (--continue).",
      );
    }
    const mode = resolveAgyMode(options);
    const args = [CLI.FLAGS.MODEL, options.model ?? DEFAULT_MODEL];
    if (mode === "full") {
      args.push(CLI.FLAGS.SKIP_PERMISSIONS);
    } else if (mode === "write") {
      args.push(
        CLI.FLAGS.MODE,
        "accept-edits",
        CLI.FLAGS.SANDBOX,
        "--settings",
        JSON.stringify({ permissions: { allow: ["command(*)"] } }),
      );
    } else {
      args.push(CLI.FLAGS.MODE, "plan");
    }
    if (options.effort) args.push(CLI.FLAGS.EFFORT, options.effort);
    if (options.jsonSchema !== undefined) {
      args.push(
        CLI.FLAGS.JSON_SCHEMA,
        typeof options.jsonSchema === "string"
          ? options.jsonSchema
          : JSON.stringify(options.jsonSchema),
      );
    }
    if (options.conversationId)
      args.push(CLI.FLAGS.CONVERSATION, options.conversationId);
    else if (options.continueLatest) args.push(CLI.FLAGS.CONTINUE);
    for (const dir of options.addDirs ?? []) args.push(CLI.FLAGS.ADD_DIR, dir);

    const logFile =
      options.logFile ??
      join(tmpdir(), `agy-mcp-${randomBytes(8).toString("hex")}.log`);
    args.push(
      CLI.FLAGS.LOG_FILE,
      logFile,
      CLI.FLAGS.INPUT_FORMAT,
      "stream-json",
      CLI.FLAGS.OUTPUT_FORMAT,
      "stream-json",
    );
    const finalPrompt = options.concisePrompt
      ? `Please provide a focused, concise response without unnecessary elaboration. ${prompt}`
      : prompt;
    return {
      args,
      tempFiles: options.logFile ? [] : [logFile],
      finalPrompt,
      useResume: Boolean(options.conversationId || options.continueLatest),
      workingDir: resolveWorkingDirectory({
        workingDir: options.workingDir || options.cd,
        prompt,
      }),
      logFile,
      stdin:
        JSON.stringify({ event: "user", message: { content: finalPrompt } }) +
        "\n",
    };
  }

  static cleanupTempFile(tempFile: string): void {
    try {
      unlinkSync(tempFile);
    } catch {
      /* The CLI may not have created the log. */
    }
  }
}
