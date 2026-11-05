import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgyCommandBuilder,
  resolveAgyMode,
  createAgyStdinPlan,
  userTurn,
  READ_FINAL_TURN,
} from "./agyCommandBuilder.js";
import { DEFAULT_MODEL } from "../constants.js";

const builder = new AgyCommandBuilder();
for (const mode of ["read", "write", "full"] as const) {
  test(`builds ${mode} mode with one NDJSON prompt on stdin`, async () => {
    const prompt = 'quoted "prompt"\nUnicode: ☃; ` $() &';
    const result = await builder.build(prompt, { mode });
    const first =
      JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
    assert.ok(result.stdinPlan);
    if (mode === "read") {
      // Read mode waits for the first result before deciding on recovery.
      const lines = result.stdin.trimEnd().split("\n");
      assert.equal(lines.length, 1);
      // A denied command aborts a headless run, so the first turn says the
      // content is provided, and read-only commands get a session allow rule.
      const firstTurn = JSON.parse(lines[0]).message.content;
      assert.match(firstTurn, /^This is a read-only task/);
      assert.ok(firstTurn.endsWith(prompt));
      const settings = JSON.parse(result.args[result.args.indexOf("--settings") + 1]);
      assert.ok(settings.permissions.allow.includes("command(git diff*)"));
      assert.ok(!settings.permissions.allow.includes("command(*)"));
    } else {
      assert.equal(result.stdin, first);
    }
    assert.ok(!result.args.includes(prompt));
    assert.ok(!result.args.includes("-p"));
    assert.ok(!result.args.includes("--print-timeout"));
    for (const flag of ["--input-format", "--output-format"]) {
      assert.equal(result.args[result.args.indexOf(flag) + 1], "stream-json");
    }
    assert.equal(
      result.args[result.args.indexOf("--model") + 1],
      DEFAULT_MODEL,
    );
    assert.equal(
      result.args.includes("--dangerously-skip-permissions"),
      mode === "full",
    );
    assert.equal(result.args.includes("--sandbox"), mode === "write");
    if (mode !== "full")
      assert.equal(
        result.args[result.args.indexOf("--mode") + 1],
        mode === "read" ? "plan" : "accept-edits",
      );
    if (mode === "write") {
      assert.equal(
        result.args[result.args.indexOf("--settings") + 1],
        '{"permissions":{"allow":["read_file(*)","list_dir(*)","command(*)"]}}',
      );
    }
  });
}

test("long prompts use the same stdin transport", async () => {
  const prompt = "x".repeat(150000);
  const result = await builder.build(prompt);
  assert.ok(JSON.parse(result.stdin.split("\n")[0]).message.content.endsWith(prompt));
  assert.ok(!result.args.some((arg) => arg.includes(prompt)));
});

test("resume and continue use native flags", async () => {
  const resumed = await builder.build("hi", { conversationId: "native-id" });
  assert.equal(
    resumed.args[resumed.args.indexOf("--conversation") + 1],
    "native-id",
  );
  assert.ok(resumed.useResume);
  assert.ok(
    (await builder.build("hi", { continueLatest: true })).args.includes(
      "--continue",
    ),
  );
  await assert.rejects(
    builder.build("hi", { conversationId: "id", continueLatest: true }),
    /Cannot combine/,
  );
});

test("effort, JSON schema and workspace arguments stay separate", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const result = await builder.build("hi", {
      effort,
      jsonSchema: { type: "object" },
      addDirs: ["dir with spaces"],
    });
    assert.equal(result.args[result.args.indexOf("--effort") + 1], effort);
    assert.equal(
      result.args[result.args.indexOf("--json-schema") + 1],
      '{"type":"object"}',
    );
    assert.ok(result.args.includes("dir with spaces"));
  }
  const schema = '{"type": "string"}';
  const result = await builder.build("hi", {
    jsonSchema: schema,
    concisePrompt: true,
  });
  assert.ok(result.args.includes(schema));
  assert.ok(JSON.parse(result.stdin.split("\n")[0]).message.content.endsWith(result.finalPrompt));
});

test("legacy permission switches map onto safe modes", () => {
  assert.equal(resolveAgyMode(), "read");
  assert.equal(resolveAgyMode({}, "write"), "write");
  assert.equal(resolveAgyMode({ skipPermissions: false }, "write"), "write");
  assert.equal(resolveAgyMode({ skipPermissions: true }), "full");
  assert.equal(resolveAgyMode({ sandbox: true }), "write");
  assert.equal(resolveAgyMode({ sandbox: false }, "write"), "read");
});

for (const options of [
  { mode: "read", skipPermissions: true },
  { mode: "write", skipPermissions: true },
  { mode: "full", skipPermissions: false },
  { mode: "read", sandbox: true },
  { mode: "write", sandbox: false },
  { mode: "full", sandbox: true },
  { skipPermissions: true, sandbox: true },
] as const) {
  test(`rejects conflicting permissions ${JSON.stringify(options)}`, async () => {
    await assert.rejects(builder.build("hi", options), /conflicts/);
  });
}

test("trusted mode edits and runs commands without agy's sandbox (Git Bash breaks under it)", () => {
  const result = new AgyCommandBuilder().buildSync("run the tests", { mode: "trusted" });
  assert.ok(result.args.includes("accept-edits"));
  assert.equal(result.args.includes("--sandbox"), false);
  assert.equal(result.args.includes("--dangerously-skip-permissions"), false);
  const settings = result.args[result.args.indexOf("--settings") + 1];
  assert.deepEqual(JSON.parse(settings), { permissions: { allow: ["read_file(*)", "list_dir(*)", "command(*)"] } });
  assert.equal(resolveAgyMode({ mode: "trusted", skipPermissions: false }), "trusted");
  assert.throws(() => resolveAgyMode({ mode: "trusted", skipPermissions: true }), /conflicts/);
});

test("settings JSON contains read_file(*) and list_dir(*) in read, write, and trusted modes", async () => {
  for (const mode of ["read", "write", "trusted"] as const) {
    const result = await builder.build("test", { mode });
    const settingsIdx = result.args.indexOf("--settings");
    assert.ok(settingsIdx !== -1, `Mode ${mode} must include --settings`);
    const settings = JSON.parse(result.args[settingsIdx + 1]);
    const allow: string[] = settings?.permissions?.allow ?? [];
    assert.ok(allow.includes("read_file(*)"), `Mode ${mode} must allow read_file(*)`);
    assert.ok(allow.includes("list_dir(*)"), `Mode ${mode} must allow list_dir(*)`);
  }
});

test("createAgyStdinPlan handles steer and result lifecycle", async () => {
  const plan = createAgyStdinPlan("write");
  const handler = plan({ apply: () => {}, emit: () => {} });

  assert.ok(handler.onSteer);

  // Steer before first result writes user turn, keeps stdin open, and returns queued
  const steer1 = await handler.onSteer("steer turn 1");
  assert.equal(steer1.delivered, "queued");
  assert.equal(steer1.close, undefined);
  assert.equal(steer1.write, userTurn("steer turn 1"));

  // First result arrives while steer is pending -> keep stdin open
  const r1 = handler(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done 1" } }),
    "stdout",
  );
  assert.equal(r1, undefined);

  // Second result arrives (for steer turn 1) -> no steer pending -> close stdin
  const r2 = handler(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done 2" } }),
    "stdout",
  );
  assert.deepEqual(r2, { close: true });
});

test("createAgyStdinPlan closes stdin on first result when no steer is pending", () => {
  const plan = createAgyStdinPlan("write");
  const handler = plan({ apply: () => {}, emit: () => {} });

  const r1 = handler(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
    "stdout",
  );
  assert.deepEqual(r1, { close: true });
});

test("createAgyStdinPlan in read mode combines recovery with steering", async () => {
  const plan = createAgyStdinPlan("read");
  const handler = plan({ apply: () => {}, emit: () => {} });

  // Steer arrives before first result
  const steerAction = await handler.onSteer!("do something else");
  assert.equal(steerAction.delivered, "queued");

  // First result has denied actions -> needs recovery turn, but steer is pending, so keep stdin open
  const r1 = handler(
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "denied", denied_actions: [{ action: "cmd" }] },
    }),
    "stdout",
  );
  assert.deepEqual(r1, { write: userTurn(READ_FINAL_TURN) });

  // Next result arrives (one turn finished) -> still pending
  const r2 = handler(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "turn 2 done" } }),
    "stdout",
  );
  assert.equal(r2, undefined);

  // Next result arrives (last turn finished) -> close stdin
  const r3 = handler(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "turn 3 done" } }),
    "stdout",
  );
  assert.deepEqual(r3, { close: true });
});

test("createAgyStdinPlan closes stdin when stderr line starts with AGY_ERROR:", () => {
  for (const mode of ["read", "write", "trusted", "full"] as const) {
    const plan = createAgyStdinPlan(mode);
    const handler = plan({ apply: () => {}, emit: () => {} });
    const action = handler('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED"}', "stderr");
    assert.deepEqual(action, { close: true }, `Mode ${mode} must close stdin on AGY_ERROR`);
  }
});
