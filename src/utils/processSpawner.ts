import { spawn, SpawnOptions, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "path";

/** Resolve npm shims to their script; prompts and settings never enter a shell. */
export function resolveExecutable(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  let executable = command;
  if (process.platform === "win32") {
    const extensions = extname(command)
      ? [""]
      : [".exe", ".com", ".cmd", ".bat"];
    const dirs =
      isAbsolute(command) || /[\\/]/.test(command)
        ? [""]
        : (process.env.PATH ?? "").split(delimiter);
    const candidates = dirs.flatMap((dir) =>
      extensions.map((ext) =>
        dir
          ? join(dir.replace(/^"|"$/g, ""), command + ext)
          : resolve(command + ext),
      ),
    );
    executable =
      candidates.find((candidate) => existsSync(candidate)) ?? command;
  }
  if (/\.(cmd|bat)$/i.test(executable)) {
    const shim = readFileSync(executable, "utf8");
    const target = [...shim.matchAll(/"([^"\r\n]+\.(?:[cm]?js))"/gi)]
      .map((match) => match[1].replace(/%~?dp0%?/gi, dirname(executable) + "/"))
      .find((script) => !script.includes("%") && existsSync(script));
    if (!target)
      throw new Error(
        `Cannot resolve npm shim ${executable} to a JavaScript entry point.`,
      );
    return { command: process.execPath, args: [target, ...args] };
  }
  return { command: executable, args };
}

export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const resolved = resolveExecutable(command, args);
  return spawn(resolved.command, resolved.args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}
