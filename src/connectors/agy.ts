import { dirname, join } from "path";
import type { Connector, JobEvent, JobSpec } from "../jobs/connector.js";
import { AgyCommandBuilder, AgyEffort } from "../utils/agyCommandBuilder.js";
import { executeCommand } from "../utils/commandExecutor.js";
import { fetchModels } from "../utils/modelList.js";
import { CLI, DEFAULT_MODEL, MODELS, REVIEW_MODEL } from "../constants.js";

const QUOTA_PATTERN =
  /quota|rate[ _-]?limit|resource[ _]exhausted|exhausted|usage limit|\b429\b/i;
const DENIED_PATTERN = /no output produced.*auto-denied/i;

/**
 * Best-effort reset time from quota text. The real agy quota message has not
 * been captured, so this handles common shapes: "in 2h 30m", "retry after 90
 * seconds", "retryDelay":"3600s", and an ISO timestamp after "reset(s) at".
 */
export function agyUsageReset(
  message: string,
  now = new Date(),
): number | undefined {
  const iso =
    /reset(?:s|ting)?(?:\s+at|\s+on|:)?\s*"?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      message,
    );
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  const delay = /retry[_ ]?(?:delay|after)"?[:\s]+"?(\d+(?:\.\d+)?)\s*s/i.exec(
    message,
  );
  if (delay) return now.getTime() + Number(delay[1]) * 1000;
  const rel =
    /\b(?:in|after)\s+(?=\d)(?:(\d+)\s*(?:h|hours?)\s*)?(?:(\d+)\s*(?:m|min|minutes?)\s*)?(?:(\d+)\s*(?:s|sec|seconds?))?\b/i.exec(
      message,
    );
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms =
      (Number(rel[1] ?? 0) * 3600 +
        Number(rel[2] ?? 0) * 60 +
        Number(rel[3] ?? 0)) *
      1000;
    if (ms > 0) return now.getTime() + ms;
  }
  return undefined;
}

function quotaEvent(message: string): JobEvent {
  return {
    error: message,
    usageLimit: { resetAt: agyUsageReset(message) },
  };
}

export class AgyConnector implements Connector {
  readonly id = "agy";
  readonly defaultModel = DEFAULT_MODEL;
  readonly reviewModel = REVIEW_MODEL;
  private readonly builder = new AgyCommandBuilder();

  async detect() {
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

  sandboxDirs(job: JobSpec): string[] {
    return job.worktree ? [job.worktree.gitDir] : [];
  }

  build(job: JobSpec) {
    const built = this.builder.buildSync(job.prompt, {
      model: job.model ?? this.defaultModel,
      mode: job.mode,
      effort: job.effort as AgyEffort | undefined,
      conversationId: job.resumeSession,
      addDirs: this.sandboxDirs(job),
      workingDir: job.cwd,
      logFile: join(dirname(job.finalPath), "agy.log"),
    });
    return { exe: CLI.COMMANDS.AGY, args: built.args, stdin: built.stdin };
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
