import { dirname, join } from "path";
import type { Connector, JobEvent, JobSpec } from "../jobs/connector.js";
import { AgyCommandBuilder, AgyEffort } from "../utils/agyCommandBuilder.js";
import { executeCommand } from "../utils/commandExecutor.js";
import { fetchModels } from "../utils/modelList.js";
import { CLI, DEFAULT_MODEL, MODELS, REVIEW_MODEL } from "../constants.js";
import { fetchAgyQuota, runAgyUsage, type UsageRunner } from "../utils/agyUsage.js";

const QUOTA_PATTERN =
  /quota|rate[ _-]?limit|resource[ _]exhausted|exhausted|usage limit|\b429\b/i;
const DENIED_PATTERN = /no output produced.*auto-denied/i;

// Vendor-neutral reset formats, including minute-precision local clocks.
export { usageReset as agyUsageReset } from "../jobs/usage-reset.js";
import { usageLimit, usageReset as agyUsageReset } from "../jobs/usage-reset.js";

function quotaEvent(message: string): JobEvent {
  return {
    error: message,
    usageLimit: usageLimit(message),
  };
}

export function isUnauthenticated(raw: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;

  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (t.startsWith("AGY_ERROR:")) {
      try {
        const data = JSON.parse(t.slice("AGY_ERROR:".length).trim());
        if (
          String(data?.status).toUpperCase() === "UNAUTHENTICATED" ||
          data?.error_code === 401 ||
          data?.error_code === "401"
        ) {
          return true;
        }
        const text = `${data?.short_error ?? ""} ${data?.error ?? ""}`;
        if (
          /unauthenticated|not authenticated|sign[ -]?in|login|unauthorized|\b401\b/i.test(
            text,
          )
        ) {
          return true;
        }
      } catch {
        /* fall through */
      }
    }
  }

  try {
    const data = JSON.parse(trimmed);
    if (
      String(data?.status).toUpperCase() === "SUCCESS" ||
      data?.command?.data?.groups ||
      data?.groups ||
      data?.quotaGroups ||
      data?.quota_groups
    ) {
      return false;
    }
    if (
      String(data?.status).toUpperCase() === "UNAUTHENTICATED" ||
      data?.error_code === 401 ||
      data?.error_code === "401" ||
      data?.code === 401
    ) {
      return true;
    }
    const text = `${data?.response ?? ""} ${data?.error ?? ""} ${data?.message ?? ""} ${data?.short_error ?? ""}`;
    if (
      /unauthenticated|not authenticated|sign[ -]?in|login|unauthorized|\b401\b/i.test(
        text,
      )
    ) {
      return true;
    }
    return false;
  } catch {
    /* not JSON */
  }

  if (
    /unauthenticated|not authenticated|not signed in|please sign in|sign in again|\b401\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

export interface AgyConnectorOptions {
  runUsage?: UsageRunner;
  executeCommand?: (
    command: string,
    args: string[],
    onProgress?: (newOutput: string) => void,
    timeoutMs?: number,
  ) => Promise<string>;
  now?: () => number;
  authCacheTtlMs?: number;
  negativeAuthCacheTtlMs?: number;
}

export class AgyConnector implements Connector {
  readonly id = "agy";
  readonly defaultModel = DEFAULT_MODEL;
  readonly reviewModel = REVIEW_MODEL;
  private readonly builder = new AgyCommandBuilder();
  private readonly runUsage: UsageRunner;
  private readonly executeCmd: (
    command: string,
    args: string[],
    onProgress?: (newOutput: string) => void,
    timeoutMs?: number,
  ) => Promise<string>;
  private readonly now: () => number;
  private readonly authCacheTtlMs: number;
  private readonly negativeAuthCacheTtlMs: number;
  private authCache?: { authenticated: boolean; timestamp: number };

  constructor(options: AgyConnectorOptions = {}) {
    this.runUsage = options.runUsage ?? runAgyUsage;
    this.executeCmd = options.executeCommand ?? executeCommand;
    this.now = options.now ?? Date.now;
    this.authCacheTtlMs = options.authCacheTtlMs ?? 10 * 60 * 1000;
    this.negativeAuthCacheTtlMs = options.negativeAuthCacheTtlMs ?? 60 * 1000;
  }

  clearAuthCache(): void {
    this.authCache = undefined;
  }

  async detect(): ReturnType<Connector['detect']> {
    let version = "";
    try {
      version = (
        await this.executeCmd(CLI.COMMANDS.AGY, ["--version"], undefined, 5000)
      ).trim();
    } catch {
      /* fall through */
    }
    if (!version) {
      return {
        available: false,
        reason:
          "Antigravity CLI not found or not runnable - install `agy` and run it once interactively to sign in",
      };
    }

    const now = this.now();
    if (this.authCache) {
      const ttl = this.authCache.authenticated
        ? this.authCacheTtlMs
        : this.negativeAuthCacheTtlMs;
      if (now - this.authCache.timestamp < ttl) {
        if (!this.authCache.authenticated) {
          return {
            available: false,
            reason: "agy is not signed in: run agy once interactively",
          };
        }
        return { available: true, version, exe: CLI.COMMANDS.AGY };
      }
    }

    try {
      const probeOutput = await this.runUsage(5000);
      if (isUnauthenticated(probeOutput)) {
        this.authCache = { authenticated: false, timestamp: now };
        return {
          available: false,
          reason: "agy is not signed in: run agy once interactively",
        };
      }
      this.authCache = { authenticated: true, timestamp: now };
      return { available: true, version, exe: CLI.COMMANDS.AGY };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isUnauthenticated(msg)) {
        this.authCache = { authenticated: false, timestamp: now };
        return {
          available: false,
          reason: "agy is not signed in: run agy once interactively",
        };
      }
      // A failed probe for other reasons, like a timeout, must not mark agy unavailable: fail open.
      return { available: true, version, exe: CLI.COMMANDS.AGY };
    }
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

  /**
   * Returns the max used percent across the 5-hour and weekly windows of the
   * model group the job would use. Jobs default to DEFAULT_MODEL (Gemini),
   * so this inspects the Gemini model group.
   * Returns undefined on any error.
   */
  async usagePercent(): Promise<number | undefined> {
    try {
      const quota = await fetchAgyQuota({
        refresh: true,
        run: this.runUsage,
        now: this.now(),
      });
      if (!quota?.available) return undefined;
      // Jobs default to DEFAULT_MODEL (gemini-3.8-flash-high), so inspect the Gemini model group.
      const group =
        quota.groups.find((g) => g.short === "gem") ??
        quota.groups.find((g) => /gemini/i.test(g.name)) ??
        quota.groups[0];
      if (!group) return undefined;
      const percents: number[] = [];
      if (typeof group.fiveHour?.usedPercent === "number") {
        percents.push(group.fiveHour.usedPercent);
      }
      if (typeof group.weekly?.usedPercent === "number") {
        percents.push(group.weekly.usedPercent);
      }
      return percents.length ? Math.max(...percents) : undefined;
    } catch {
      return undefined;
    }
  }

  parse(line: string, stream: "stdout" | "stderr"): JobEvent | null {
    if (stream === "stderr") {
      const trimmed = line.trim();
      if (trimmed.startsWith("AGY_ERROR:")) {
        try {
          const payload = trimmed.slice("AGY_ERROR:".length).trim();
          const data = JSON.parse(payload);
          const shortError =
            typeof data?.short_error === "string"
              ? data.short_error
              : typeof data?.error === "string"
                ? data.error
                : payload;
          const combinedText =
            [data?.short_error, data?.error, data?.message]
              .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
              .join(" ") || shortError;
          if (
            String(data?.status).toUpperCase() === "RESOURCE_EXHAUSTED" ||
            data?.error_code === 429 ||
            data?.error_code === "429"
          ) {
            return {
              error: shortError,
              usageLimit: {
                ...usageLimit(combinedText),
                resetAt: agyUsageReset(combinedText),
              },
            };
          }
          const isRetryable = Boolean(
            data?.retryable === true || data?.retryable === "true",
          );
          return {
            error: isRetryable ? `${shortError} (retryable)` : shortError,
          };
        } catch {
          /* malformed AGY_ERROR json: fall through to regex */
        }
      }
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
