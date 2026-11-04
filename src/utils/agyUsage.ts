import { usageWindow, type UsageWindow as CommonUsageWindow } from "../jobs/usage.js";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { spawnCommand } from "./processSpawner.js";

// ---------------------------------------------------------------------------
// Official quota: `agy -p /usage --output-format json`
// ---------------------------------------------------------------------------

export interface UsageWindow extends CommonUsageWindow {
  /** Compatibility alias for resetAtIso. */
  resetAt: string;
  resetIn: string;
}

export interface UsageGroup {
  name: string;
  short: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

export interface AgyQuota {
  available: boolean;
  reason?: string;
  source: "live" | "cache";
  snapshotAt?: string;
  snapshotAgeSec?: number;
  meter?: string;
  /** Compatibility aliases: takenAt is epoch seconds; summary is meter. */
  takenAt?: number;
  groups: UsageGroup[];
  summary?: string;
}

const shortName = (name: string): string =>
  /argon/i.test(name)
    ? "argon"
    : /gemini/i.test(name)
      ? "gem"
      : /claude|gpt/i.test(name)
        ? "3p"
        : name.toLowerCase().replace(/\W+/g, "-");

/** Parse the JSON printed by `agy -p /usage --output-format json`. */
export function parseAgyQuota(raw: string, now = Date.now()): AgyQuota {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      available: false,
      source: "live",
      reason: "agy /usage did not return JSON",
      groups: [],
    };
  }
  const rawGroups = data?.command?.data?.groups;
  if (!Array.isArray(rawGroups)) {
    const why =
      typeof data?.response === "string" && data.response.trim()
        ? data.response.trim().slice(0, 300)
        : "no usage groups in agy output (sign in again?)";
    return { available: false, source: "live", reason: why, groups: [] };
  }
  const groups: UsageGroup[] = [];
  for (const g of rawGroups) {
    const name = String(g?.name ?? "?");
    const group: UsageGroup = { name, short: shortName(name) };
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      const reset = Date.parse(b?.reset_time);
      if (typeof b?.remaining_fraction !== "number" || Number.isNaN(reset))
        continue;
      const window: UsageWindow = {
        ...usageWindow(Math.round((1 - b.remaining_fraction) * 100), reset / 1000, now,
          b.window === "5h" ? 300 : b.window === "weekly" ? 10080 : undefined),
        resetAt: new Date(reset).toISOString(),
      };
      if (b.window === "5h") group.fiveHour = window;
      else if (b.window === "weekly") group.weekly = window;
    }
    if (group.fiveHour || group.weekly) groups.push(group);
  }
  if (!groups.length)
    return {
      available: false,
      source: "live",
      reason: "agy returned no quota buckets",
      groups,
    };
  const summary =
    "agy " +
    groups
      .map((g) =>
        [
          g.fiveHour ? `5h ${g.fiveHour.usedPercent}%` : "",
          g.weekly ? `wk ${g.weekly.usedPercent}%` : "",
        ]
          .filter(Boolean)
          .map((part, i) => (i === 0 ? `${g.short} ${part}` : part))
          .join(" · "),
      )
      .join(" · ");
  return { available: true, source: "live", snapshotAt: new Date(now).toISOString(),
    snapshotAgeSec: 0, meter: summary, takenAt: Math.floor(now / 1000), groups, summary };
}

export type UsageRunner = (timeoutMs: number) => Promise<string>;

/** Spawns agy directly (no shell). Starts no model turn; takes about a second. */
export const runAgyUsage: UsageRunner = (timeoutMs) =>
  new Promise((resolveRun, reject) => {
    const child = spawnCommand(
      "agy",
      ["-p", "/usage", "--output-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("agy /usage timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolveRun(out);
    });
  });

export interface FetchUsageOptions {
  refresh?: boolean;
  run?: UsageRunner;
  now?: number;
  cachePath?: string;
  /** Claude Code status line directory; agy.json is written only if it exists. */
  claudeUsageDir?: string;
  cacheTtlMs?: number;
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

export async function fetchAgyQuota(
  options: FetchUsageOptions = {},
): Promise<AgyQuota> {
  const now = options.now ?? Date.now();
  const cachePath =
    options.cachePath ?? join(tmpdir(), "agy-mcp-usage-cache.json");
  const ttl = options.cacheTtlMs ?? 5 * 60 * 1000;
  if (!options.refresh) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (now - statSync(cachePath).mtimeMs < ttl && cached?.available) {
        for (const g of cached.groups as UsageGroup[])
          for (const w of [g.fiveHour, g.weekly])
            if (w) Object.assign(w, usageWindow(w.usedPercent, Date.parse(w.resetAt) / 1000, now, w.windowMinutes));
        cached.source = "cache";
        cached.snapshotAt ??= new Date(cached.takenAt * 1000).toISOString();
        cached.snapshotAgeSec = Math.max(0, Math.round((now - Date.parse(cached.snapshotAt)) / 1000));
        cached.meter ??= cached.summary;
        return cached as AgyQuota;
      }
    } catch {
      /* no usable cache */
    }
  }
  let quota: AgyQuota;
  try {
    quota = parseAgyQuota(await (options.run ?? runAgyUsage)(15000), now);
  } catch (error) {
    quota = {
      available: false,
      source: "live",
      reason: `agy /usage failed: ${(error as Error).message}`,
      groups: [],
    };
  }
  if (quota.available) {
    try {
      atomicJson(cachePath, quota);
    } catch {
      /* cache is optional */
    }
    const dir = options.claudeUsageDir ?? join(homedir(), ".claude", "usage");
    try {
      if (existsSync(dir))
        atomicJson(join(dir, "agy.json"), {
          taken_at: quota.takenAt,
          summary: quota.summary,
          groups: quota.groups,
        });
    } catch {
      /* status line file is optional */
    }
  }
  return quota;
}

// ---------------------------------------------------------------------------
// Optional extra: token tallies from the shared job store (local files only)
// ---------------------------------------------------------------------------

export interface ModelUsage {
  jobs: number;
  totalTokens: number;
}

export interface AgyTallies {
  note: string;
  today: Record<string, ModelUsage>;
  last5h: Record<string, ModelUsage>;
  lastUsageLimit?: {
    jobId: string;
    model?: string;
    at: string;
    resetAt?: string;
    error?: string;
  };
}

export const AGY_TALLY_NOTE =
  "Token tallies are best-effort sums from agy jobs in the shared agent-jobs store; they do not count agy runs made outside these job tools.";

function jobsHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.AGENT_JOBS_HOME || join(homedir(), ".agent-jobs"));
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function computeAgyUsage(
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): AgyTallies {
  const jobsDir = join(jobsHome(env), "jobs");
  const report: AgyTallies = { note: AGY_TALLY_NOTE, today: {}, last5h: {} };
  if (!existsSync(jobsDir)) return report;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const fiveHoursAgo = now.getTime() - 5 * 3600 * 1000;
  let latestLimit: number | undefined;
  for (const id of readdirSync(jobsDir)) {
    const dir = join(jobsDir, id);
    const meta = readJson(join(dir, "meta.json"));
    if (!meta || meta.connector !== "agy") continue;
    const at: number = meta.finishedAt ?? meta.updatedAt ?? meta.createdAt ?? 0;
    let model: string | undefined = meta.model;
    let tokens = 0;
    try {
      for (const line of readFileSync(join(dir, "stdout"), "utf8").split(
        "\n",
      )) {
        if (!line.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.event === "init" && !model) model = event.init?.model;
        if (event?.event === "result") {
          const total = event.result?.usage?.total_tokens;
          if (typeof total === "number") tokens += total;
        }
      }
    } catch {
      /* missing stdout */
    }
    if (tokens > 0) {
      const key = model ?? "unknown";
      for (const [bucket, since] of [
        [report.today, startOfDay.getTime()],
        [report.last5h, fiveHoursAgo],
      ] as const) {
        if (at < since) continue;
        const entry = (bucket[key] ??= { jobs: 0, totalTokens: 0 });
        entry.jobs += 1;
        entry.totalTokens += tokens;
      }
    }
    if (meta.reason === "usage_limit" && (latestLimit ?? -1) < at) {
      latestLimit = at;
      report.lastUsageLimit = {
        jobId: meta.id ?? id,
        model: meta.pauseModel ?? meta.model,
        at: new Date(at).toISOString(),
        resetAt: meta.resetAt
          ? new Date(meta.resetAt).toISOString()
          : undefined,
        error: meta.error,
      };
    }
  }
  return report;
}
