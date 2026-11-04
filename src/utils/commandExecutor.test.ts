import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess, SpawnOptions } from "child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeCommandDetailed } from "./commandExecutor.js";
import { resolveExecutable } from "./processSpawner.js";
import { executeAgy } from "./agyExecutor.js";
import { readStdinPlan, READ_FINAL_TURN } from "./agyCommandBuilder.js";

function fakeSpawn(
  t: { after: (fn: () => void) => void },
  callback: (child: ChildProcess, options: SpawnOptions) => void,
) {
  mock.method(
    childProcess,
    "spawn",
    (_command: string, _args: string[], options: SpawnOptions) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
      });
      setImmediate(() => callback(child, options as SpawnOptions));
      return child;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("spawns hidden with no shell and ignores stdin without input", async (t) => {
  fakeSpawn(t, (child, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal((options.stdio as string[])[0], "ignore");
    child.stdout?.emit("data", Buffer.from("hello\n"));
    child.emit("close", 0, null);
  });
  const result = await executeCommandDetailed("fixture", []);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "hello");
});

test("writes stdin once, closes it, and preserves patch whitespace on request", async (t) => {
  fakeSpawn(t, (child, options) => {
    assert.equal((options.stdio as string[])[0], "pipe");
    assert.equal((child.stdin as PassThrough).read().toString(), "prompt\n");
    assert.equal(child.stdin?.writableEnded, true);
    child.stdout?.emit("data", Buffer.from(" patch\n"));
    child.emit("close", 0, null);
  });
  const result = await executeCommandDetailed("fixture", [], {
    stdin: "prompt\n",
    trimOutput: false,
  });
  assert.equal(result.stdout, " patch\n");
});

test("missing binaries become results rather than uncaught child errors", async (t) => {
  fakeSpawn(t, (child) =>
    child.emit(
      "error",
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    ),
  );
  const result = await executeCommandDetailed("missing-binary", [], {
    stdin: "prompt\n",
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not found/);
});

test("stdin EPIPE is handled even when the child exits successfully", async (t) => {
  fakeSpawn(t, (child) => {
    child.stdin?.emit(
      "error",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );
    child.emit("close", 0, null);
  });
  const result = await executeCommandDetailed("fixture", [], {
    stdin: "prompt\n",
  });
  assert.equal(result.ok, true);
  assert.equal(result.stderr, "");
});

test("synchronous spawn errors are handled", async (t) => {
  mock.method(childProcess, "spawn", () => {
    throw new Error("invalid cwd");
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await executeCommandDetailed("fixture", []);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /invalid cwd/);
});

test("npm .cmd shims resolve directly to node and a script", () => {
  const temp = mkdtempSync(join(tmpdir(), "agy-shim-"));
  try {
    const script = join(temp, "entry.js");
    const shim = join(temp, "fixture.cmd");
    writeFileSync(script, "");
    writeFileSync(
      shim,
      '@ECHO off\r\n"%dp0%/node.exe" "%dp0%/entry.js" %*\r\n',
    );
    const resolved = resolveExecutable(shim, [
      '{"permissions":{"allow":["command(*)"]}}',
    ]);
    assert.equal(resolved.command, process.execPath);
    assert.equal(resolved.args.length, 2);
    assert.equal(resolved.args[1], '{"permissions":{"allow":["command(*)"]}}');
    writeFileSync(shim, "@echo unknown shim\n");
    assert.throws(() => resolveExecutable(shim, []), /Cannot resolve npm shim/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "complete", first: "Complete answer", denied: [], second: undefined, turns: 1, final: "Complete answer" },
  { name: "denied", first: "I'll start by reading", denied: [{ action: "command" }], second: "Recovered answer", turns: 2, final: "Recovered answer" },
  { name: "empty first", first: "  ", denied: [], second: "Recovered answer", turns: 2, final: "Recovered answer" },
  { name: "empty second", first: "Earlier answer", denied: [{ action: "command" }], second: " \n", turns: 2, final: "Earlier answer" },
]) {
  test(`legacy executeAgy read mode: ${scenario.name}`, async (t) => {
    fakeSpawn(t, child => {
      const input = child.stdin as PassThrough;
      const first = JSON.parse(input.read().toString().trim());
      assert.match(first.message.content, /task/);
      assert.equal(input.writableEnded, false);
      const result = JSON.stringify({ event: "result", result: {
        status: "SUCCESS", response: scenario.first, denied_actions: scenario.denied,
      } }) + "\n";
      child.stdout!.emit("data", Buffer.from(result.slice(0, 15)));
      assert.equal(input.writableEnded, false, "partial NDJSON does not decide");
      child.stdout!.emit("data", Buffer.from(result.slice(15)));
      assert.equal(input.writableEnded, true);
      if (scenario.turns === 2) {
        assert.equal(JSON.parse(input.read().toString().trim()).message.content, READ_FINAL_TURN);
        child.stdout!.emit("data", Buffer.from(JSON.stringify({ event: "result", result: {
          status: "SUCCESS", response: scenario.second,
        } }) + "\n"));
      }
      assert.equal(input.read(), null, "no extra turns");
      child.emit("close", 0, null);
    });
    const result = await executeAgy("task", { mode: "read" });
    assert.equal(result.output, scenario.final);
  });
}

test("read mode with no result times out and closes stdin before killing", async t => {
  let input: PassThrough | undefined;
  fakeSpawn(t, child => {
    input = child.stdin as PassThrough;
    assert.equal(input.writableEnded, false);
    Object.assign(child, { kill: () => {
      assert.equal(input!.writableEnded, true);
      child.emit("close", null, "SIGTERM");
      return true;
    } });
  });
  const result = await executeCommandDetailed("fixture", [], {
    stdin: "first\n", stdinPlan: readStdinPlan, timeoutMs: 30,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(input!.writableEnded, true);
});

test("read recovery safely ignores a synchronous EPIPE", async t => {
  fakeSpawn(t, child => {
    const input = child.stdin as PassThrough;
    input.read();
    input.write = () => { throw Object.assign(new Error("closed"), { code: "EPIPE" }); };
    child.stdout!.emit("data", Buffer.from('{"event":"result","result":{"response":""}}\n'));
    assert.equal(input.writableEnded, true);
    child.emit("close", 0, null);
  });
  const result = await executeCommandDetailed("fixture", [], { stdin: "first\n", stdinPlan: readStdinPlan });
  assert.equal(result.ok, true);
});

test("a retried read process gets a fresh first-result decision", async t => {
  let attempts = 0;
  fakeSpawn(t, child => {
    attempts++;
    const input = child.stdin as PassThrough;
    input.read();
    assert.equal(input.writableEnded, false);
    child.stdout!.emit("data", Buffer.from('{"event":"result","result":{"response":""}}\n'));
    assert.equal(JSON.parse(input.read().toString()).message.content, READ_FINAL_TURN);
    assert.equal(input.writableEnded, true);
    child.emit("close", attempts === 1 ? 75 : 0, null);
  });
  const result = await executeCommandDetailed("fixture", [], {
    stdin: "first\n", stdinPlan: readStdinPlan,
    retry: { attempts: 2, backoffMs: 1, retryOn: ["transient"] },
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
});
