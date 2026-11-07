import type {
  StdinAction,
  StdinPlan,
  StdinHandler,
  SteerResult,
} from "../jobs/stdin.js";
import { CLI, DEFAULT_MODEL } from "../constants.js";
import { resolveWorkingDirectory } from "./workingDirResolver.js";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// trusted: accept-edits plus the session-only command allow rule, without
// --sandbox. agy's sandbox breaks Git Bash/MSYS2 on Windows, so jobs that run
// bash or npm tests need it. full also skips every permission check.
export type AgyMode = "read" | "write" | "trusted" | "full";
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
  stdinPlan?: StdinPlan;
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
  if (!["read", "write", "trusted", "full"].includes(mode)) {
    throw new Error(
      `Invalid mode: ${mode}. Expected read, write, trusted or full.`,
    );
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

/** Read-only tool permissions allowed in headless runs to prevent aborting on reads. */
export const FILE_READ_PERMISSIONS = ["read_file(*)", "list_dir(*)"];

/** Read-only commands a read-mode run may use without a prompt. */
export const READ_ONLY_COMMANDS = [
  "command(git status*)",
  "command(git diff*)",
  "command(git log*)",
  "command(git show*)",
  "command(rg *)",
  "command(Get-ChildItem*)",
  "command(Get-Content*)",
  "command(ls*)",
  "command(cat *)",
];

/** Steers read-mode runs away from shell commands, which can abort the run. */
export const READ_PREFIX =
  "This is a read-only task: everything you need is in this message. Use file-reading tools if you must; avoid shell commands.\n\n";

/** Recovery turn, sent only when the first result is empty or reports denials. */
export const READ_FINAL_TURN =
  "Now give your complete final answer to the task above, in full. Do not ask for approval and do not modify anything.";

export const userTurn = (content: string): string =>
  JSON.stringify({ event: "user", message: { content } }) + "\n";

/**
 * Stdin plan for agy background jobs:
 * - Keeps stdin open while a turn is running.
 * - Mid-work steer messages are queued as subsequent user turns on stdin.
 * - When a turn's result event arrives and no steer is pending, closes stdin so agy exits.
 * - When a steer arrived during the turn, stays open until the next result.
 * - Read mode keeps its existing recovery rule and combines with steering.
 */
export function createAgyStdinPlan(mode: AgyMode = "read"): StdinPlan {
  return () => {
    let firstResultSeen = false;
    let pendingSteers = 0;

    const handler: StdinHandler = (
      line: string,
      stream: "stdout" | "stderr",
    ): StdinAction | void => {
      if (stream === "stderr") {
        if (line.startsWith("AGY_ERROR:")) {
          return { close: true };
        }
        return;
      }
      if (stream !== "stdout") return;
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      if (data?.event !== "result" || !data.result) return;
      const result = data.result;

      if (!firstResultSeen) {
        firstResultSeen = true;

        if (mode === "read") {
          const needsAnswer =
            (Array.isArray(result.denied_actions) &&
              result.denied_actions.length > 0) ||
            typeof result.response !== "string" ||
            !result.response.trim();

          if (needsAnswer) {
            if (pendingSteers > 0) {
              pendingSteers++;
              return { write: userTurn(READ_FINAL_TURN) };
            }
            return { write: userTurn(READ_FINAL_TURN), close: true };
          }
        }

        if (pendingSteers > 0) {
          return;
        }

        return { close: true };
      }

      // Subsequent results (from steer turns or recovery turns)
      if (pendingSteers > 0) {
        pendingSteers--;
        if (pendingSteers === 0) {
          return { close: true };
        }
        return;
      }

      return { close: true };
    };

    handler.onSteer = (message: string): SteerResult => {
      pendingSteers++;
      return { write: userTurn(message), delivered: "queued" };
    };

    return handler;
  };
}

/** One decision per process; a retry gets a fresh handler. */
export const readStdinPlan: StdinPlan = createAgyStdinPlan("read");

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
      args.push(
        CLI.FLAGS.SKIP_PERMISSIONS,
        "--settings",
        JSON.stringify({ permissions: { allow: ["mcp(agent_bridge/*)"] } }),
      );
    } else if (mode === "write" || mode === "trusted") {
      args.push(CLI.FLAGS.MODE, "accept-edits");
      if (mode === "write") args.push(CLI.FLAGS.SANDBOX);
      args.push(
        "--settings",
        JSON.stringify({
          permissions: {
            allow: [
              ...FILE_READ_PERMISSIONS,
              "command(*)",
              "mcp(agent_bridge/*)",
            ],
          },
        }),
      );
    } else {
      // A denied command aborts a headless run with no output, so plan mode
      // gets a session-only allow rule for read-only commands. Nothing broader.
      args.push(
        CLI.FLAGS.MODE,
        "plan",
        "--settings",
        JSON.stringify({
          permissions: {
            allow: [
              ...FILE_READ_PERMISSIONS,
              ...READ_ONLY_COMMANDS,
              "mcp(agent_bridge/*)",
            ],
          },
        }),
      );
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
      stdin: userTurn(
        mode === "read" ? READ_PREFIX + finalPrompt : finalPrompt,
      ),
      stdinPlan: createAgyStdinPlan(mode),
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
