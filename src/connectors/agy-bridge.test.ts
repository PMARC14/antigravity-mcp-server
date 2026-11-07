import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { AgyConnector } from "./agy.js";
import { JobManager } from "../jobs/manager.js";
import { fixture, until } from "../jobs/test-helpers.js";

const installer = resolve("scripts/install-agy-bridge.sh").replace(/\\/g, "/");
const bash =
  process.env.AGENT_JOBS_BASH ??
  process.env.CLAUDE_CODE_GIT_BASH_PATH ??
  (process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
    : "bash");

test("global bridge installer is idempotent, backs up originals and preserves other servers on uninstall", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy installer "));
  const config = join(dir, "mcp_config.json");
  const original = JSON.stringify({
    custom: true,
    mcpServers: {
      other: { command: "user-command", env: { USER_VALUE: "preserved" } },
    },
  });
  const run = (...args: string[]) =>
    spawn.sync(bash, [installer, ...args], {
      env: { ...process.env, AGY_MCP_CONFIG_PATH: config },
      encoding: "utf8",
      windowsHide: true,
    });
  try {
    writeFileSync(config, original);
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const installed = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(
      installed.mcpServers.other,
      JSON.parse(original).mcpServers.other,
    );
    assert.equal(installed.custom, true);
    assert.equal(installed.mcpServers.agent_bridge.command, process.execPath);
    assert.equal(
      installed.mcpServers.agent_bridge.args[0],
      fileURLToPath(new URL("../bridge/agent-bridge.js", import.meta.url)),
    );
    assert.equal(installed.mcpServers.agent_bridge.env, undefined);
    assert.ok(installed.mcpServers.agent_bridge.timeoutSeconds >= 86400);
    const backups = () =>
      readdirSync(dir).filter((name) => name.includes(".backup-"));
    assert.equal(backups().length, 1);
    assert.equal(readFileSync(join(dir, backups()[0]), "utf8"), original);
    const before = readFileSync(config, "utf8");
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(backups().length, 1);
    result = run("--uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(config, "utf8")),
      JSON.parse(original),
    );
    assert.equal(run("--uninstall").status, 0);
    writeFileSync(config, "invalid JSON");
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(config, "utf8"), "invalid JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared runner passes worker identity through agy spawn env to an inheriting fake MCP child", async () => {
  const f = fixture();
  const connector = new AgyConnector({
    mcpConfigPath: join(f.home, "absent-config.json"),
  });
  connector.detect = async () => ({ available: true });
  const build = connector.build.bind(connector);
  connector.build = (job) => ({
    ...build(job),
    exe: process.execPath,
    args: [f.script],
  });
  writeFileSync(
    f.script,
    `
    const { spawnSync } = require("node:child_process");
    const script = 'console.log(JSON.stringify({ id: process.env.AGENT_JOB_ID, home: process.env.AGENT_JOBS_HOME }))';
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    process.stdin.resume();
    process.stdin.on('end', () => console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: child.stdout.trim() } })));
    // End the worker's turn; agy's stdin plan will close its input.
    console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: child.stdout.trim() } }));
  `,
  );
  const manager = new JobManager(connector, f.config);
  try {
    const { jobId } = await manager.start({
      prompt: "fake env test",
      cwd: f.home,
      mode: "write",
    });
    await until(() => manager.store.get(jobId).state === "completed");
    const result = await manager.result(jobId);
    assert.deepEqual(JSON.parse(result.final!), { id: jobId, home: f.home });
    assert.equal(existsSync(join(f.home, ".agents")), false);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test("bridge without worker env advertises no tools and exits quietly on EOF", async () => {
  const env = { ...process.env };
  delete env.AGENT_JOB_ID;
  delete env.AGENT_JOBS_HOME;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../bridge/agent-bridge.js", import.meta.url))],
    {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stderr!.on("data", (chunk) => (err += chunk));
  try {
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    );
    await until(() => out.includes("\n"), "empty tools reply", 5000);
    assert.deepEqual(JSON.parse(out.trim()).result.tools, []);
    child.stdin!.end();
    await until(() => child.exitCode !== null, "inactive bridge exit", 5000);
    assert.equal(child.exitCode, 0);
    assert.equal(err, "");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("global bridge installer prints run npm run build first when dist is not built", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy installer unbuilt "));
  const config = join(dir, "mcp_config.json");
  const fakeScript = join(dir, "install-agy-bridge.sh");
  const scriptContent = readFileSync(installer, "utf8");
  writeFileSync(fakeScript, scriptContent);
  const result = spawn.sync(bash, [fakeScript.replace(/\\/g, "/")], {
    env: { ...process.env, AGY_MCP_CONFIG_PATH: config },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run npm run build first/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
