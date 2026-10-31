import { spawnCommand } from "./processSpawner.js";
import { Logger } from "./logger.js";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  partialStdout?: string;
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number;
  retryOn: ("timeout" | "exit_nonzero" | "spawn_error" | "transient")[];
}

export interface ExecuteOptions {
  onProgress?: (newOutput: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
  retry?: RetryOptions;
  cwd?: string;
  /**
   * Optional content to write to the child's stdin and then close.
   * Prompts use this pipe rather than the command line.
   */
  stdin?: string;
  trimOutput?: boolean;
}

/**
 * Execute a command with streaming output and structured error handling
 */
export async function executeCommandDetailed(
  command: string,
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  const {
    onProgress,
    timeoutMs = 600000,
    maxOutputBytes = 50 * 1024 * 1024, // 50MB default
    retry,
    cwd,
    stdin,
    trimOutput = true,
  } = options;

  let attempt = 0;
  const maxAttempts = retry?.attempts || 1;

  while (attempt < maxAttempts) {
    attempt++;
    const result = await executeOnce(command, args, {
      onProgress,
      timeoutMs,
      maxOutputBytes,
      cwd,
      stdin,
      trimOutput,
    });

    if (result.ok) return result;

    const isTransient = result.code === 75; // EX_TEMPFAIL convention
    const shouldRetry =
      retry &&
      ((result.timedOut && retry.retryOn.includes("timeout")) ||
        (result.code !== 0 &&
          result.code !== null &&
          retry.retryOn.includes("exit_nonzero")) ||
        (isTransient && retry.retryOn.includes("transient")) ||
        (result.code === null &&
          !result.signal &&
          retry.retryOn.includes("spawn_error")));

    if (!shouldRetry || attempt >= maxAttempts) return result;

    const delay = retry.backoffMs * Math.pow(2, attempt - 1);
    Logger.warn(
      `Retrying command after ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error("Unexpected retry loop exit");
}

async function executeOnce(
  command: string,
  args: string[],
  {
    onProgress,
    timeoutMs,
    maxOutputBytes,
    cwd,
    stdin,
    trimOutput,
  }: Omit<ExecuteOptions, "retry">,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    Logger.commandExecution(command, args, startTime);

    let childProcess;
    try {
      childProcess = spawnCommand(command, args, {
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: String(error),
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalStdoutBytes = 0;
    let isResolved = false;
    let outputExceeded = false;
    let stdinError: Error | undefined;
    let didTimeOut = false;

    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        didTimeOut = true;
        childProcess.kill("SIGTERM");
        Logger.warn(`Process timeout after ${timeoutMs}ms, sending SIGTERM`);
        const killTimer = setTimeout(() => {
          if (!isResolved) {
            childProcess.kill("SIGKILL");
            Logger.error(`Process did not terminate, sending SIGKILL`);
          }
        }, 5000);
        killTimer.unref();
      }
    }, timeoutMs || 600000);

    childProcess.stdout?.on("data", (data: Buffer) => {
      if (maxOutputBytes && totalStdoutBytes + data.length > maxOutputBytes) {
        if (!outputExceeded) {
          outputExceeded = true;
          Logger.warn(
            `Output exceeded ${maxOutputBytes} bytes, stopping collection`,
          );
          childProcess.kill("SIGTERM");
        }
        return;
      }
      stdoutChunks.push(data);
      totalStdoutBytes += data.length;
      if (onProgress) onProgress(data.toString("utf8"));
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    childProcess.on("error", (error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        Logger.error(`Process error:`, error);

        if ((error as any).code === "ENOENT") {
          resolve({
            ok: false,
            code: null,
            stdout: "",
            stderr: `Command '${command}' not found. Is it installed and in PATH?`,
            timedOut: false,
          });
        } else {
          resolve({
            ok: false,
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: error.message,
            timedOut: false,
          });
        }
      }
    });

    childProcess.on("close", (code, signal) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr =
          Buffer.concat(stderrChunks).toString("utf8") ||
          stdinError?.message ||
          "";
        const timedOut = didTimeOut;

        Logger.commandComplete(startTime, code, stdout.length);

        resolve({
          ok: code === 0 && !outputExceeded && !stdinError && !timedOut,
          code,
          signal: signal || undefined,
          stdout: trimOutput ? stdout.trim() : stdout,
          stderr: stderr.trim(),
          timedOut,
          partialStdout: outputExceeded ? stdout : undefined,
        });
      }
    });
    childProcess.stdin?.on("error", (error: Error) => {
      stdinError = error;
    });
    if (stdin !== undefined) childProcess.stdin?.end(stdin);
  });
}

/**
 * Backward compatible wrapper that returns stdout string
 */
export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (newOutput: string) => void,
  timeoutMs: number = 600000,
): Promise<string> {
  const result = await executeCommandDetailed(command, args, {
    onProgress,
    timeoutMs,
  });
  if (!result.ok) {
    const errorMessage = result.stderr || "Unknown error";
    throw new Error(
      result.timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : `Command failed with exit code ${result.code}: ${errorMessage}`,
    );
  }
  return result.stdout;
}
