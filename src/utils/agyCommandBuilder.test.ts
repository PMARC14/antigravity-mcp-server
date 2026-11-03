import { test } from "node:test";
import assert from "node:assert/strict";
import { AgyCommandBuilder, resolveAgyMode } from "./agyCommandBuilder.js";
import { DEFAULT_MODEL } from "../constants.js";

const builder = new AgyCommandBuilder();
for (const mode of ["read", "write", "full"] as const) {
  test(`builds ${mode} mode with one NDJSON prompt on stdin`, async () => {
    const prompt = 'quoted "prompt"\nUnicode: ☃; ` $() &';
    const result = await builder.build(prompt, { mode });
    const first =
      JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
    if (mode === "read") {
      // Plan mode ends a headless run after its planning turn, so read mode
      // sends a second turn asking for the full answer.
      const lines = result.stdin.trimEnd().split("\n");
      assert.equal(lines.length, 2);
      // A denied command aborts a headless run, so the first turn says the
      // content is provided, and read-only commands get a session allow rule.
      const firstTurn = JSON.parse(lines[0]).message.content;
      assert.match(firstTurn, /^This is a read-only task/);
      assert.ok(firstTurn.endsWith(prompt));
      assert.match(JSON.parse(lines[1]).message.content, /complete final answer/);
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
        '{"permissions":{"allow":["command(*)"]}}',
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
  assert.deepEqual(JSON.parse(settings), { permissions: { allow: ["command(*)"] } });
  assert.equal(resolveAgyMode({ mode: "trusted", skipPermissions: false }), "trusted");
  assert.throws(() => resolveAgyMode({ mode: "trusted", skipPermissions: true }), /conflicts/);
});
