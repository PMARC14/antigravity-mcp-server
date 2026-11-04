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
  const turns = stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(turns[0].event, "user");
  assert.ok(turns[0].message.content.endsWith(spec.prompt));
  // Recovery is conditional on the first result.
  assert.ok(stdin.endsWith("\n") && turns.length === 1);
  assert.ok(connector.build(spec).stdinPlan);
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
  assert.ok(JSON.parse(stdin.split("\n")[0]).message.content.endsWith("/usage"));
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
  assert.equal(connector.parse('quota for model "fake-model" exhausted', 'stderr')?.usageLimit?.model, 'fake-model');
  const justPassed = new Date(2026, 10, 4, 17, 37, 10);
  assert.equal(agyUsageReset('try again at 5:37 PM', justPassed), justPassed.getTime() + 60000);
});

test("the quota AGY_ERROR parses status RESOURCE_EXHAUSTED and error_code 429 into usageLimit", () => {
  const line =
    'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h57m36s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"test-err"}';
  const before = Date.now();
  const event = connector.parse(line, "stderr");
  const after = Date.now();
  assert.ok(event);
  assert.equal(
    event.error,
    "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h57m36s.",
  );
  assert.ok(event.usageLimit);
  assert.ok(typeof event.usageLimit.resetAt === "number");
  const expectedSec = 4 * 3600 + 57 * 60 + 36;
  assert.ok(event.usageLimit.resetAt >= before + expectedSec * 1000);
  assert.ok(event.usageLimit.resetAt <= after + expectedSec * 1000);

  // ISO timestamp format resets at exact time
  const isoLine =
    'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED: quota resets at 2026-11-04T23:00:00Z","status":"RESOURCE_EXHAUSTED","error_code":429}';
  const isoEvent = connector.parse(isoLine, "stderr");
  assert.equal(
    isoEvent?.usageLimit?.resetAt,
    Date.parse("2026-11-04T23:00:00Z"),
  );

  // error_code 429 without RESOURCE_EXHAUSTED status also returns usageLimit
  const code429Line =
    'AGY_ERROR: {"short_error":"Rate limit reached (code 429)","error_code":429}';
  const code429Event = connector.parse(code429Line, "stderr");
  assert.ok(code429Event?.usageLimit);
});

test("a non-quota retryable AGY_ERROR appends (retryable) and returns no usageLimit", () => {
  const retryableLine =
    'AGY_ERROR: {"short_error":"UNAVAILABLE (code 503): Service temporarily unavailable","status":"UNAVAILABLE","error_code":503,"retryable":true}';
  const event = connector.parse(retryableLine, "stderr");
  assert.deepEqual(event, {
    error: "UNAVAILABLE (code 503): Service temporarily unavailable (retryable)",
  });

  // When retryable is false, (retryable) is not appended
  const nonRetryableLine =
    'AGY_ERROR: {"short_error":"INVALID_ARGUMENT (code 400): Bad argument","status":"INVALID_ARGUMENT","error_code":400,"retryable":false}';
  const nonRetryableEvent = connector.parse(nonRetryableLine, "stderr");
  assert.deepEqual(nonRetryableEvent, {
    error: "INVALID_ARGUMENT (code 400): Bad argument",
  });
});

test("the old regex path handles legacy quota errors on stderr", () => {
  const legacyLine = "Error 429: Resource has been exhausted (quota)";
  const legacyEvent = connector.parse(legacyLine, "stderr");
  assert.ok(legacyEvent?.usageLimit);
  assert.equal(legacyEvent?.error, legacyLine);

  // Malformed AGY_ERROR line falls back to regex
  const malformedLine = "AGY_ERROR: not-json quota exceeded";
  const malformedEvent = connector.parse(malformedLine, "stderr");
  assert.ok(malformedEvent?.usageLimit);

  // Normal non-quota stderr returns null
  assert.equal(connector.parse("Some random stderr message", "stderr"), null);
});

test("unauthenticated detect returns available false with interactive sign-in reason", async () => {
  // Scenario A: AGY_ERROR with UNAUTHENTICATED status
  const c1 = new AgyConnector({
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () =>
      'AGY_ERROR: {"short_error":"UNAUTHENTICATED (code 401): Please sign in","status":"UNAUTHENTICATED","error_code":401}',
  });
  const res1 = await c1.detect();
  assert.deepEqual(res1, {
    available: false,
    reason: "agy is not signed in: run agy once interactively",
  });

  // Scenario B: JSON with ERROR status and response "please sign in"
  const c2 = new AgyConnector({
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () =>
      JSON.stringify({ status: "ERROR", response: "please sign in" }),
  });
  const res2 = await c2.detect();
  assert.deepEqual(res2, {
    available: false,
    reason: "agy is not signed in: run agy once interactively",
  });
});

test("a probe timeout failing open keeps agy available", async () => {
  const c = new AgyConnector({
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () => {
      throw new Error("agy /usage timed out");
    },
  });
  const res = await c.detect();
  assert.deepEqual(res, {
    available: true,
    version: "agy 1.5.0",
    exe: "agy",
  });
});

test("the cache preserves auth result for 10 minutes", async () => {
  let fakeNow = 1000000;
  let probeCalls = 0;
  const c = new AgyConnector({
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () => {
      probeCalls++;
      return JSON.stringify({
        status: "SUCCESS",
        command: { data: { groups: [{ name: "Gemini Models" }] } },
      });
    },
    now: () => fakeNow,
  });

  // First detect calls probe
  const res1 = await c.detect();
  assert.equal(res1.available, true);
  assert.equal(probeCalls, 1);

  // 5 minutes later: still within 10 min cache TTL, probe not called again
  fakeNow += 5 * 60 * 1000;
  const res2 = await c.detect();
  assert.equal(res2.available, true);
  assert.equal(probeCalls, 1);

  // 10 minutes later (15 min elapsed): cache expired, probe is called again
  fakeNow += 10 * 60 * 1000;
  const res3 = await c.detect();
  assert.equal(res3.available, true);
  assert.equal(probeCalls, 2);

  // Also verify unauthenticated result is cached
  let unauthCalls = 0;
  let unauthNow = 2000000;
  const cUnauth = new AgyConnector({
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () => {
      unauthCalls++;
      return 'AGY_ERROR: {"status":"UNAUTHENTICATED","short_error":"not signed in"}';
    },
    now: () => unauthNow,
  });

  const u1 = await cUnauth.detect();
  assert.equal(u1.available, false);
  assert.equal(unauthCalls, 1);

  unauthNow += 5 * 60 * 1000;
  const u2 = await cUnauth.detect();
  assert.equal(u2.available, false);
  assert.equal(unauthCalls, 1);
});
