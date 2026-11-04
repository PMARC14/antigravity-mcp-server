import { spawnCommand } from "./processSpawner.js";
import { parseAgyOutput } from "./outputParser.js";
import { sanitizeLabel } from "./labels.js";
import { resolveAgyMode } from "./agyCommandBuilder.js";
import { DEFAULT_MODEL } from "../constants.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  readSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import {
  AgyCommandBuilder,
  AgyCommandBuilderOptions,
  READ_FINAL_TURN,
  userTurn,
} from "./agyCommandBuilder.js";
import { Logger } from "./logger.js";
import { parseConversationIdFromLog } from "./agyExecutor.js";
import { metrics } from "./metrics.js";

/**
 * Background task manager for Antigravity CLI.
 *
 * Runs agy processes in the background and persists records for later polling.
 * POSIX children are detached; Windows children stay attached to avoid consoles.
 *
 * Layout:
 *   ~/.agy-mcp/bg/
 *     <taskId>.json    — metadata (pid, exit code, timestamps, conversation id)
 *     <taskId>.log     — stdout (merged stdout/stderr in legacy records)
 *     <taskId>.stderr  — stderr
 *     <taskId>.prompt  — full prompt
 *     <taskId>.agylog  — fallback CLI log
 */

const STATE_DIR = join(homedir(), ".agy-mcp", "bg");

export type BgTaskState =
  "running" | "completed" | "failed" | "killed" | "unknown";

export interface BgTaskMeta {
  taskId: string;
  pid: number;
  state: BgTaskState;
  prompt: string;
  workingDir?: string;
  model?: string;
  args: string[];
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  conversationId?: string;
  label?: string;
  promptFile?: string;
  stderrFile?: string;
  error?: string;
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function metaPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.json`);
}

function logPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.log`);
}

function agyLogPath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.agylog`);
}

function readMeta(taskId: string): BgTaskMeta | null {
  const p = metaPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BgTaskMeta;
  } catch (err) {
    Logger.warn(`Corrupted bg task meta ${taskId}: ${err}`);
    return null;
  }
}

function writeMeta(meta: BgTaskMeta): void {
  writeFileSync(metaPath(meta.taskId), JSON.stringify(meta, null, 2), "utf8");
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

function liftConversationId(meta: BgTaskMeta): void {
  let id: string | undefined;
  try {
    id = parseAgyOutput(
      readFileSync(logPath(meta.taskId), "utf8"),
    ).conversationId;
  } catch {
    /* Not created yet. */
  }
  id ||=
    meta.conversationId ||
    parseConversationIdFromLog(agyLogPath(meta.taskId)) ||
    undefined;
  if (id) meta.conversationId = id;
}

/**
 * Reconcile on-disk state with reality: if the meta says "running" but the PID
 * is gone, mark unknown rather than inventing an exit status.
 */
function reconcile(meta: BgTaskMeta): BgTaskMeta {
  if (meta.state !== "running") return meta;
  if (isAlive(meta.pid)) {
    liftConversationId(meta);
    return meta;
  }

  meta.state = "unknown";
  meta.finishedAt = meta.finishedAt ?? Date.now();
  // The original exit code cannot be recovered after a restart.
  meta.exitCode = meta.exitCode ?? null;

  liftConversationId(meta);
  writeMeta(meta);
  return meta;
}

export interface StartOptions extends AgyCommandBuilderOptions {
  label?: string;
}

export async function startBgTask(
  prompt: string,
  options: StartOptions = {},
): Promise<BgTaskMeta> {
  metrics.incrementAgyInvocations();
  ensureDir();

  const taskId = randomBytes(6).toString("hex");
  const builder = new AgyCommandBuilder();
  const mode = resolveAgyMode(options, "write");
  const { args, workingDir, stdin } = await builder.build(prompt, {
    ...options,
    mode,
    logFile: agyLogPath(taskId),
  });
  const promptFile = join(STATE_DIR, taskId + ".prompt");
  const stderrFile = join(STATE_DIR, taskId + ".stderr");
  writeFileSync(promptFile, prompt, "utf8");
  const meta: BgTaskMeta = {
    taskId,
    pid: 0,
    state: "unknown",
    prompt: prompt.slice(0, 500),
    promptFile,
    stderrFile,
    workingDir,
    model: options.model ?? DEFAULT_MODEL,
    args,
    startedAt: Date.now(),
    label: options.label ? sanitizeLabel(options.label) : undefined,
  };
  writeMeta(meta);

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let settled = false;
  let timeoutId: NodeJS.Timeout | undefined;
  const finish = (state: BgTaskState, code: number | null, error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    meta.state = state;
    meta.exitCode = code;
    meta.error = error;
    meta.finishedAt = Date.now();
    liftConversationId(meta);
    try {
      writeMeta(meta);
    } catch (err) {
      Logger.error("Failed to save bg task:", err);
    }
  };
  try {
    stdoutFd = openSync(logPath(taskId), "a");
    stderrFd = openSync(stderrFile, "a");
    const child = spawnCommand("agy", args, {
      cwd: workingDir,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
      stdio: [stdin !== undefined ? "pipe" : "ignore", stdoutFd, stderrFd],
      env: process.env,
    });
    child.on("error", (error) => finish("failed", null, error.message));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // A child that exits before reading all of stdin is not a failure:
      // POSIX reports EPIPE, Windows reports EOF (or ECONNRESET).
      if (["EPIPE", "EOF", "ECONNRESET"].includes(error.code ?? "")) return;
      finish("failed", null, error.message);
      child.kill();
    });
    child.on("close", (code, signal) =>
      finish(signal ? "killed" : code === 0 ? "completed" : "failed", code),
    );
    await new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("spawn", () => {
        meta.pid = child.pid!;
        meta.state = "running";
        try {
          writeMeta(meta);
        } catch (error) {
          finish("failed", null, String(error));
          child.kill();
          resolve();
          return;
        }
        timeoutId = setTimeout(() => {
          finish("failed", null, "Execution timed out");
          child.kill("SIGKILL");
        }, options.timeoutMs ?? 600000);
        timeoutId.unref();
        // This legacy detached runner writes stdout directly to files and has no
        // event loop that survives server exit. Preserve its buffered read input;
        // shared jobs and synchronous tools use the conditional stdin plan.
        child.stdin?.end(stdin + (mode === "read" ? userTurn(READ_FINAL_TURN) : ""));
        child.unref();
        resolve();
      });
    });
    return meta;
  } catch (error) {
    finish("failed", null, String(error));
    return meta;
  } finally {
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export function getBgTask(taskId: string): BgTaskMeta | null {
  const meta = readMeta(taskId);
  if (!meta) return null;
  return reconcile(meta);
}

export function listBgTasks(): BgTaskMeta[] {
  ensureDir();
  const entries = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  const tasks: BgTaskMeta[] = [];
  for (const e of entries) {
    const id = e.replace(/\.json$/, "");
    const meta = readMeta(id);
    if (meta) tasks.push(reconcile(meta));
  }
  return tasks.sort((a, b) => b.startedAt - a.startedAt);
}

export function tailLog(taskId: string, lines: number = 100): string {
  const stdout = tailFile(logPath(taskId), lines);
  const stderr = tailFile(join(STATE_DIR, `${taskId}.stderr`), lines);
  return stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");
}

function tailFile(p: string, lines: number): string {
  if (!existsSync(p)) return "";
  // For typical task logs (<few MB) just read fully then slice.
  // Bound: cap at 5MB read to be safe.
  const st = statSync(p);
  const cap = 5 * 1024 * 1024;
  if (st.size <= cap) {
    const all = readFileSync(p, "utf8");
    const arr = all.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  }
  // Large log: read tail chunk only.
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(cap);
    const read = readSync(fd, buf, 0, cap, st.size - cap);
    const text = buf.slice(0, read).toString("utf8");
    const arr = text.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } finally {
    closeSync(fd);
  }
}

export function stopBgTask(
  taskId: string,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const meta = readMeta(taskId);
  if (!meta) return false;
  if (!isAlive(meta.pid)) {
    reconcile(meta);
    return false;
  }
  try {
    process.kill(meta.pid, signal);
    meta.state = "killed";
    meta.finishedAt = Date.now();
    liftConversationId(meta);
    writeMeta(meta);
    return true;
  } catch (err) {
    Logger.warn(`Failed to kill ${meta.pid}: ${err}`);
    return false;
  }
}

export function removeBgTask(taskId: string): boolean {
  const meta = readMeta(taskId);
  if (!meta) return false;
  if (meta.state === "running" && isAlive(meta.pid)) {
    // Refuse to delete a live task — caller must stop first.
    return false;
  }
  try {
    if (existsSync(metaPath(taskId))) unlinkSync(metaPath(taskId));
    if (existsSync(logPath(taskId))) unlinkSync(logPath(taskId));
    if (existsSync(agyLogPath(taskId))) unlinkSync(agyLogPath(taskId));
    for (const suffix of [".stderr", ".prompt"]) {
      const file = join(STATE_DIR, taskId + suffix);
      if (existsSync(file)) unlinkSync(file);
    }
    return true;
  } catch (err) {
    Logger.warn(`Failed to remove ${taskId}: ${err}`);
    return false;
  }
}
