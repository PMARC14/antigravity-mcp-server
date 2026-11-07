import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess, SpawnOptions } from "child_process";
import os from "os";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  writeSync,
  rmSync,
} from "fs";
import { join } from "path";

async function backgroundFixture(t: { after: (fn: () => void) => void }) {
  const temp = mkdtempSync(join(os.tmpdir(), "agy-bg-test-"));
  mock.method(os, "homedir", () => temp);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(temp, { recursive: true, force: true });
  });
  const url = new URL(
    `./bgTaskManager.js?fixture=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  const bg: typeof import("./bgTaskManager.js") = await import(url.href);
  return { temp, bg };
}

test("background spawn persists full prompts and separate streams with safe defaults", async (t) => {
  const { bg, temp } = await backgroundFixture(t);
  let child: ChildProcess;
  let spawnOptions: SpawnOptions;
  mock.method(
    childProcess,
    "spawn",
    (_command: string, _args: string[], options: SpawnOptions) => {
      spawnOptions = options;
      child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        pid: process.pid,
        stdin: new PassThrough(),
        unref() {},
        kill: () => true,
      });
      setImmediate(() => {
        const stdio = options.stdio as [string, number, number];
        assert.notEqual(stdio[1], stdio[2]);
        writeSync(
          stdio[1],
          JSON.stringify({
            event: "init",
            init: { conversation_id: "init-id" },
          }) + "\n",
        );
        writeSync(stdio[2], "stderr reason\n");
        child.emit("spawn");
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  const prompt = 'full prompt "\n' + "x".repeat(2000);
  const meta = await bg.startBgTask(prompt, { label: "MY/Label!" });
  assert.equal(meta.state, "running");
  assert.equal(meta.pid, process.pid);
  assert.equal(spawnOptions!.windowsHide, true);
  assert.equal(Boolean(spawnOptions!.detached), process.platform !== "win32");
  assert.ok(meta.args.includes("--sandbox"));
  assert.ok(!meta.args.includes("--dangerously-skip-permissions"));
  assert.equal(readFileSync(meta.promptFile!, "utf8"), prompt);
  assert.equal(
    JSON.parse((child!.stdin as PassThrough).read().toString()).message.content,
    prompt,
  );
  assert.equal(meta.label, "my-label");
  assert.equal(bg.getBgTask(meta.taskId)?.conversationId, "init-id");
  assert.match(bg.tailLog(meta.taskId), /stderr reason/);
  const stdoutPath = join(temp, ".agy-mcp", "bg", meta.taskId + ".log");
  writeFileSync(
    stdoutPath,
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "result-id",
        status: "SUCCESS",
        response: "done",
      },
    }) + "\n",
    { flag: "a" },
  );
  child!.emit("close", 0, null);
  assert.equal(bg.getBgTask(meta.taskId)?.conversationId, "result-id");
  assert.equal(bg.getBgTask(meta.taskId)?.state, "completed");
  assert.equal(bg.removeBgTask(meta.taskId), true);
  const readTask = await bg.startBgTask('inspect', { mode: 'read' });
  const turns = (child!.stdin as PassThrough).read().toString().trim().split('\n').map(JSON.parse);
  assert.equal(turns.length, 2, 'legacy detached read input retains its existing buffered recovery');
  assert.match(turns[1].message.content, /complete final answer/);
  assert.equal(child!.stdin!.writableEnded, true);
  child!.emit('close', 0, null);
  assert.equal(bg.removeBgTask(readTask.taskId), true);
});

test("background spawn failure is persisted without a running pid", async (t) => {
  const { bg } = await backgroundFixture(t);
  mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: new PassThrough() });
    setImmediate(() => child.emit("error", new Error("binary missing")));
    return child;
  });
  syncBuiltinESMExports();
  const meta = await bg.startBgTask("prompt");
  assert.equal(meta.state, "failed");
  assert.equal(meta.pid, 0);
  assert.match(bg.getBgTask(meta.taskId)?.error ?? "", /binary missing/);
  assert.equal(bg.stopBgTask(meta.taskId), false);
  assert.equal(bg.removeBgTask(meta.taskId), true);
});
