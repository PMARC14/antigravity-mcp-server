import { test } from "node:test";
import assert from "node:assert/strict";
import { executionOptions } from "./executionOptions.js";
import { askAgyTool } from "./ask-agy.tool.js";
import { bgAgyTool } from "./bg-agy.tool.js";
import { delegateAgyTool } from "./delegate-agy.tool.js";
import { batchAgyTool } from "./batch-agy.tool.js";
import { digestAgyTool } from "./digest-agy.tool.js";
import { planAgyTool } from "./plan-agy.tool.js";
import { reviewAgyTool } from "./review-agy.tool.js";
import { brainstormTool } from "./brainstorm.tool.js";

for (const [tool, required, defaultMode] of [
  [askAgyTool, { prompt: "question" }, "read"],
  [bgAgyTool, { action: "start", prompt: "task" }, "write"],
  [delegateAgyTool, { task: "task" }, "write"],
  [batchAgyTool, { tasks: [{ task: "task" }] }, "write"],
  [digestAgyTool, { question: "question", paths: ["src"] }, "read"],
  [planAgyTool, { goal: "goal" }, "read"],
  [reviewAgyTool, {}, "read"],
  [brainstormTool, { prompt: "ideas" }, "read"],
] as const) {
  test(`${tool.name} accepts execution options without injecting unsafe defaults`, () => {
    const defaults = tool.zodSchema.parse(required);
    assert.notEqual(defaults.skipPermissions, true);
    assert.equal(executionOptions(defaults, defaultMode).mode, defaultMode);
    const options = tool.zodSchema.parse({
      ...required,
      mode: "full",
      effort: "xhigh",
      jsonSchema: { type: "object" },
    });
    assert.deepEqual(executionOptions(options), {
      mode: "full",
      effort: "xhigh",
      jsonSchema: { type: "object" },
      skipPermissions: undefined,
      sandbox: undefined,
    });
    assert.throws(
      () => executionOptions({ ...options, skipPermissions: false }),
      /conflicts/,
    );
  });
}

test("batch rejects conflicting modes before attempting any tasks", async () => {
  await assert.rejects(
    batchAgyTool.execute({
      tasks: [{ task: "task" }],
      mode: "write",
      skipPermissions: true,
    }),
    /conflicts/,
  );
});
