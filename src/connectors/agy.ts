import { dirname, join } from "path";
import type { Connector, JobEvent, JobSpec } from "../jobs/connector.js";
import { AgyCommandBuilder, AgyEffort } from "../utils/agyCommandBuilder.js";
import { executeCommand } from "../utils/commandExecutor.js";
import { fetchModels } from "../utils/modelList.js";
import { CLI, DEFAULT_MODEL, MODELS, REVIEW_MODEL } from "../constants.js";

const QUOTA_PATTERN =
  /quota|rate[ _-]?limit|resource[ _]exhausted|exhausted|usage limit|\b429\b/i;
const DENIED_PATTERN = /no output produced.*auto-denied/i;

// Vendor-neutral reset formats, including minute-precision local clocks.
export { usageReset as agyUsageReset } from "../jobs/usage-reset.js";
import { usageLimit } from "../jobs/usage-reset.js";

function quotaEvent(message: string): JobEvent {
  return {
    error: message,
    usageLimit: usageLimit(message),
  };
}

export class AgyConnector implements Connector {
  readonly id = "agy";
  readonly defaultModel = DEFAULT_MODEL;
  readonly reviewModel = REVIEW_MODEL;
  private readonly builder = new AgyCommandBuilder();

  async detect(): ReturnType<Connector['detect']> {
    try {
      const version = (
        await executeCommand(CLI.COMMANDS.AGY, ["--version"], undefined, 5000)
      ).trim();
      if (version) return { available: true, version, exe: CLI.COMMANDS.AGY };
    } catch {
      /* fall through */
    }
    return {
      available: false,
      reason:
        "Antigravity CLI not found or not runnable - install `agy` and run it once interactively to sign in",
    };
  }

  async models(): Promise<string[]> {
    try {
      const ids = (await fetchModels()).map((m) => m.id).filter(Boolean);
      if (ids.length) return ids;
    } catch {
      /* offline: use known list */
    }
    return Object.values(MODELS);
  }

  async health() {
    return { ...(await this.detect()), models: await this.models(), reviewModel: this.reviewModel };
  }

  sandboxDirs(job: JobSpec): string[] {
    return job.worktree ? [job.worktree.gitDir] : [];
  }

  build(job: JobSpec): ReturnType<Connector['build']> {
    const built = this.builder.buildSync(job.prompt, {
      model: job.model ?? this.defaultModel,
      mode: job.mode,
      effort: job.effort as AgyEffort | undefined,
      conversationId: job.resumeSession,
      addDirs: this.sandboxDirs(job),
      workingDir: job.cwd,
      logFile: join(dirname(job.finalPath), "agy.log"),
    });
    return { exe: CLI.COMMANDS.AGY, args: built.args, stdin: built.stdin, stdinPlan: built.stdinPlan };
  }

  parse(line: string, stream: "stdout" | "stderr"): JobEvent | null {
    if (stream === "stderr") {
      if (DENIED_PATTERN.test(line)) return { error: line.trim() };
      return QUOTA_PATTERN.test(line) ? quotaEvent(line.trim()) : null;
    }
    let data: Record<string, any>;
    try {
      data = JSON.parse(line);
    } catch {
      return null;
    }
    if (!data || typeof data.event !== "string") return null;
    if (data.event === "init") {
      const id = data.init?.conversation_id || data.conversation_id;
      return typeof id === "string" ? { sessionId: id } : null;
    }
    if (data.event === "step_update") {
      const message = data.step_update?.tool_info?.error?.message;
      return typeof message === "string" && QUOTA_PATTERN.test(message)
        ? quotaEvent(message)
        : null;
    }
    if (data.event !== "result" || !data.result) return null;
    const result = data.result;
    const event: JobEvent = {};
    if (typeof result.conversation_id === "string")
      event.sessionId = result.conversation_id;
    const response =
      typeof result.response === "string" ? result.response.trim() : "";
    const failed =
      typeof result.status === "string" &&
      result.status.toUpperCase() !== "SUCCESS";
    const errorText =
      typeof result.error === "string"
        ? result.error
        : typeof result.error?.message === "string"
          ? result.error.message
          : undefined;
    if (errorText && QUOTA_PATTERN.test(errorText))
      return { ...event, ...quotaEvent(errorText) };
    if (failed || errorText) {
      event.error = errorText ?? (response || `agy status ${result.status}`);
    } else if (response) {
      event.final = result.response;
    } else if (
      Array.isArray(result.denied_actions) &&
      result.denied_actions.length
    ) {
      const names = result.denied_actions
        .map((a: any) => a?.action ?? a?.display_name)
        .filter(Boolean)
        .join(", ");
      event.error = `agy produced no response; auto-denied actions: ${names}`;
    }
    return event;
  }
}
