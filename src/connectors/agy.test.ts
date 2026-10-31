import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { AgyConnector, agyUsageReset } from "./agy.js";
import type { JobEvent, JobSpec } from "../jobs/connector.js";

const connector = new AgyConnector();
const spec: JobSpec = {
  id: "job",
  connector: "agy",
  prompt: 'hello\n$() & "quote"',
  cwd: process.cwd(),
  mode: "read",
  timeoutMin: 120,
  finalPath: "/jobs/job/final.txt",
};
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../src/utils/fixtures/${name}`, import.meta.url),
    "utf8",
  );
const parseAll = (stdout: string, stderr = ""): JobEvent => {
  let event: JobEvent = {};
  for (const [text, stream] of [
    [stdout, "stdout"],
    [stderr, "stderr"],
  ] as const)
    for (const line of text.split("\n")) {
      const parsed = line ? connector.parse(line, stream) : null;
      if (parsed)
        event = {
          ...event,
          ...parsed,
          usageLimit: parsed.usageLimit ?? event.usageLimit,
        };
    }
  return event;
};
const at = (args: string[], flag: string, count = 2) =>
  args.slice(args.indexOf(flag), args.indexOf(flag) + count);

test("read mode uses plan, stdin NDJSON and the default model", () => {
  const { exe, args, stdin } = connector.build(spec);
  assert.equal(exe, "agy");
  assert.deepEqual(args.slice(0, 4), [
    "--model",
    "gemini-3.8-flash-high",
    "--mode",
    "plan",
  ]);
  assert.ok(
    args.includes("--input-format") && args.includes("--output-format"),
  );
  assert.equal(args.filter((a) => a === "stream-json").length, 2);
  assert.equal(args.includes(spec.prompt), false);
  assert.equal(args.includes("-p"), false);
  assert.deepEqual(JSON.parse(stdin), {
    event: "user",
    message: { content: spec.prompt },
  });
  assert.ok(stdin.endsWith("\n") && stdin.trim().split("\n").length === 1);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("write mode uses accept-edits, sandbox and a single settings argv", () => {
  const { args } = connector.build({ ...spec, mode: "write", effort: "high" });
  assert.deepEqual(args.slice(2, 5), ["--mode", "accept-edits", "--sandbox"]);
  assert.equal(
    args[args.indexOf("--settings") + 1],
    '{"permissions":{"allow":["command(*)"]}}',
  );
  assert.deepEqual(at(args, "--effort"), ["--effort", "high"]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("full mode uses only the skip-permissions flag", () => {
  const { args } = connector.build({ ...spec, mode: "full" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args.includes("--mode"), false);
  assert.equal(args.includes("--sandbox"), false);
});

test("resume, worktree dirs and explicit models", () => {
  const { args } = connector.build({
    ...spec,
    model: "claude-opus-5-5-high",
    resumeSession: "conv-1",
    worktree: {
      root: "/repo",
      path: "/wt",
      gitDir: "/repo/.git/worktrees/job",
      branch: "agy/job",
      baseSha: "abc",
    },
  });
  assert.equal(args[1], "claude-opus-5-5-high");
  assert.deepEqual(at(args, "--conversation"), ["--conversation", "conv-1"]);
  assert.deepEqual(at(args, "--add-dir"), [
    "--add-dir",
    "/repo/.git/worktrees/job",
  ]);
  assert.equal(connector.reviewModel, "gemini-4-argon-high");
  assert.doesNotMatch(connector.defaultModel, /^claude-/);
});

test("a slash-command looking prompt still travels on stdin, never argv", () => {
  const { args, stdin } = connector.build({ ...spec, prompt: "/usage" });
  assert.equal(args.includes("/usage"), false);
  assert.equal(args.includes("-p"), false);
  assert.equal(JSON.parse(stdin).message.content, "/usage");
});

test("parses the real write-run fixture", () => {
  const event = parseAll(fixture("agy-write-success.ndjson"));
  assert.equal(event.sessionId, "ae1e3504-5457-4ded-a5b9-b607da8afb1f");
  assert.match(event.final ?? "", /has been fixed/);
  assert.equal(event.error, undefined);
  assert.equal(event.usageLimit, undefined);
});

test("real denied run fails with the stderr reason", () => {
  const event = parseAll(
    fixture("agy-denied.ndjson"),
    fixture("agy-denied.stderr.txt"),
  );
  assert.equal(event.sessionId, "2e89aa8e-4c69-4c50-a64e-0e48ccbbebe1");
  assert.equal(event.final, undefined);
  assert.match(event.error ?? "", /auto-denied/);
  assert.match(
    parseAll(fixture("agy-denied.ndjson")).error ?? "",
    /auto-denied actions: command/,
  );
});

test("quota errors become usage_limit with best-effort reset", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  assert.equal(
    agyUsageReset("quota exhausted, resets at 2026-10-31T20:39:33Z", now),
    Date.parse("2026-10-31T20:39:33Z"),
  );
  assert.equal(
    agyUsageReset("rate limit, try again in 2h 30m", now),
    now.getTime() + 9000000,
  );
  assert.equal(
    agyUsageReset('"retryDelay":"3600s"', now),
    now.getTime() + 3600000,
  );
  assert.equal(agyUsageReset("quota exhausted", now), undefined);
  assert.ok(
    connector.parse("Error 429: Resource has been exhausted (quota)", "stderr")
      ?.usageLimit,
  );
  const failed = connector.parse(
    JSON.stringify({
      event: "result",
      result: {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED: quota exceeded",
        response: "",
      },
    }),
    "stdout",
  );
  assert.ok(failed?.usageLimit);
  const answer = connector.parse(
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "The rate limit is 5/min" },
    }),
    "stdout",
  );
  assert.equal(answer?.usageLimit, undefined);
  assert.equal(answer?.final, "The rate limit is 5/min");
  assert.equal(connector.parse("not json", "stdout"), null);
});
