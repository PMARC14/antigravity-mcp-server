import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { fetchAgyQuota } from "../utils/agyUsage.js";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { AgyConnector, agyUsageReset, isUnauthenticated } from "./agy.js";
import type { JobEvent, JobSpec } from "../jobs/connector.js";

const usageHomes: string[] = [];
const testUsageCache = () => {
  const home = mkdtempSync(join(tmpdir(), "agy-usage-test-"));
  usageHomes.push(home);
  return { home, onBattery: false };
};
after(() => {
  for (const home of usageHomes) rmSync(home, { recursive: true, force: true });
});
const connector = new AgyConnector();
const spec: JobSpec = {
  id: "job",
  connector: "agy",
  prompt: 'hello\n$() & "quote"',
  cwd: mkdtempSync(join(tmpdir(), "agy-connector-test-")),
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
  const turns = stdin
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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
    '{"permissions":{"allow":["read_file(*)","list_dir(*)","command(*)","mcp(agent_bridge/*)"]}}',
  );
  assert.deepEqual(at(args, "--effort"), ["--effort", "high"]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("full mode uses only the skip-permissions flag", () => {
  const { args } = connector.build({ ...spec, mode: "full" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args.includes("--mode"), false);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--settings"), false);
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
  assert.ok(
    JSON.parse(stdin.split("\n")[0]).message.content.endsWith("/usage"),
  );
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
  assert.equal(
    connector.parse('quota for model "fake-model" exhausted', "stderr")
      ?.usageLimit?.model,
    "fake-model",
  );
  const justPassed = new Date(2026, 10, 4, 17, 37, 10);
  assert.equal(
    agyUsageReset("try again at 5:37 PM", justPassed),
    justPassed.getTime() + 60000,
  );
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

test("AGY_ERROR parsing finds reset time and model in error and message fields", () => {
  const line =
    'AGY_ERROR: {"short_error":"Quota reached","error":"Limit reached for model gemini-2.5-pro","message":"Resets in 2h30m","status":"RESOURCE_EXHAUSTED","error_code":429}';
  const before = Date.now();
  const event = connector.parse(line, "stderr");
  assert.ok(event?.usageLimit);
  assert.equal(event.usageLimit.model, "gemini-2.5-pro");
  assert.ok(typeof event.usageLimit.resetAt === "number");
  const expectedSec = 2 * 3600 + 30 * 60;
  assert.ok(event.usageLimit.resetAt >= before + expectedSec * 1000);
});

test("a non-quota retryable AGY_ERROR appends (retryable) and returns no usageLimit", () => {
  const retryableLine =
    'AGY_ERROR: {"short_error":"UNAVAILABLE (code 503): Service temporarily unavailable","status":"UNAVAILABLE","error_code":503,"retryable":true}';
  const event = connector.parse(retryableLine, "stderr");
  assert.deepEqual(event, {
    error:
      "UNAVAILABLE (code 503): Service temporarily unavailable (retryable)",
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
    usageCache: testUsageCache(),
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
    usageCache: testUsageCache(),
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
    usageCache: testUsageCache(),
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

test("valid usage JSON containing 0.401 is not treated as unauthenticated", async () => {
  const usageJson = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            fraction: 0.401,
          },
        ],
      },
    },
  });
  assert.equal(isUnauthenticated(usageJson), false);

  const c = new AgyConnector({
    usageCache: testUsageCache(),
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () => usageJson,
  });
  const res = await c.detect();
  assert.equal(res.available, true);
});

test("detect, quota guard and usage tool share the machine cache and failure backoff", async () => {
  let now = 1000000,
    calls = 0;
  const usageCache = testUsageCache();
  let raw = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                window: "5h",
                remaining_fraction: 0.75,
                reset_time: "2026-11-08T00:00:00Z",
              },
            ],
          },
        ],
      },
    },
  });
  const options = {
    usageCache,
    executeCommand: async () => "agy 1.5.2",
    now: () => now,
    runUsage: async () => {
      calls++;
      return raw;
    },
  };
  const c = new AgyConnector(options);
  assert.equal((await c.detect()).available, true);
  assert.equal(await c.usagePercent(), 25);
  const quota = await fetchAgyQuota({ usageCache, now, run: options.runUsage });
  assert.equal(quota.available, true);
  assert.equal(calls, 1);
  now += 899999;
  assert.equal((await new AgyConnector(options).detect()).available, true);
  assert.equal(calls, 1);
  now++;
  raw = 'AGY_ERROR: {"status":"UNAUTHENTICATED","short_error":"not signed in"}';
  assert.equal((await c.detect()).available, false);
  assert.equal(calls, 2);
  now += 59999;
  assert.equal((await c.detect()).available, false);
  assert.equal(calls, 2);
  now++;
  await c.detect();
  assert.equal(calls, 3);
});

test("usagePercent returns max used percent across 5h and weekly for Gemini model group", async () => {
  const usageJsonWeeklyMax = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.75, // 25% used
                reset_time: "2026-11-01T00:17:22Z",
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.98, // 2% used
                reset_time: "2026-10-31T20:39:33Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                id: "3p-weekly",
                window: "weekly",
                remaining_fraction: 0.05, // 95% used (should NOT be used, jobs use Gemini)
                reset_time: "2026-11-07T15:48:01Z",
              },
            ],
          },
        ],
      },
    },
  });

  const c1 = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => usageJsonWeeklyMax,
  });
  const percent1 = await c1.usagePercent();
  assert.equal(percent1, 25);

  const usageJson5hMax = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.75, // 25% used
                reset_time: "2026-11-01T00:17:22Z",
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.15, // 85% used
                reset_time: "2026-10-31T20:39:33Z",
              },
            ],
          },
        ],
      },
    },
  });

  const c2 = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => usageJson5hMax,
  });
  const percent2 = await c2.usagePercent();
  assert.equal(percent2, 85);
});

test("usagePercent returns undefined on any error", async () => {
  // Scenario 1: runUsage throws
  const cErr = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => {
      throw new Error("timed out");
    },
  });
  assert.equal(await cErr.usagePercent(), undefined);

  // Scenario 2: malformed JSON
  const cBadJson = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => "not a json string",
  });
  assert.equal(await cBadJson.usagePercent(), undefined);

  // Scenario 3: error status / sign in required
  const cSign = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () =>
      JSON.stringify({ status: "ERROR", response: "please sign in" }),
  });
  assert.equal(await cSign.usagePercent(), undefined);

  // Scenario 4: empty groups
  const cEmpty = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () =>
      JSON.stringify({
        status: "SUCCESS",
        command: { data: { groups: [] } },
      }),
  });
  assert.equal(await cEmpty.usagePercent(), undefined);
});

test("bridge preamble requires a global entry; worker identity is supplied only in spawn env", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agy-bridge-"));
  const configPath = join(cwd, "mcp_config.json");
  const c = new AgyConnector({ mcpConfigPath: configPath });
  const job = {
    ...spec,
    cwd,
    id: "bridge-test",
    finalPath: join(cwd, "jobs", "bridge-test", "final.txt"),
  };
  try {
    assert.doesNotMatch(c.build(job).stdin, /ask_orchestrator/);
    const original = JSON.stringify({
      mcpServers: {
        agent_bridge: { command: process.execPath, args: ["bridge.js"] },
      },
    });
    writeFileSync(configPath, original);
    const command = c.build(job);
    assert.match(command.stdin, /ask_orchestrator/);
    assert.equal(command.env.AGENT_JOB_ID, job.id);
    assert.equal(command.env.AGENT_JOBS_HOME, cwd);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(existsSync(join(cwd, ".agents")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("detect does not check isUnauthenticated when usage.ok is true even if raw text contains sign in strings", async () => {
  const c = new AgyConnector({
    usageCache: testUsageCache(),
    executeCommand: async () => "agy 1.5.0",
    runUsage: async () =>
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    window: "5h",
                    remaining_fraction: 0.8,
                    reset_time: "2026-11-08T00:00:00Z",
                  },
                ],
              },
            ],
          },
        },
        response: "Please sign in to web console for more details 401",
      }),
  });
  const res = await c.detect();
  assert.equal(res.available, true);
});

test("usagePercent picks group matching the job model: Argon, Claude/GPT, or Gemini", async () => {
  const usageJson = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                window: "5h",
                remaining_fraction: 0.8,
                reset_time: "2026-11-08T00:00:00Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                window: "5h",
                remaining_fraction: 0.4,
                reset_time: "2026-11-08T00:00:00Z",
              },
            ],
          },
          {
            name: "Gemini 4 Argon",
            buckets: [
              {
                window: "weekly",
                remaining_fraction: 0.1,
                reset_time: "2026-11-08T00:00:00Z",
              },
            ],
          },
        ],
      },
    },
  });
  const c = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => usageJson,
  });
  // Default (Gemini): 100 - 80 = 20%
  assert.equal(await c.usagePercent(), 20);
  assert.equal(await c.usagePercent("gemini-3.8-flash-high"), 20);
  // Claude / GPT (3p): 100 - 40 = 60%
  assert.equal(await c.usagePercent("claude-3-7-sonnet"), 60);
  assert.equal(await c.usagePercent("gpt-4o"), 60);
  // Argon: 100 - 10 = 90%
  assert.equal(await c.usagePercent("gemini-4-argon"), 90);
});

test("detect caches --version across invocations within the usage interval", async () => {
  let now = 1000000;
  let versionCalls = 0;
  const c = new AgyConnector({
    usageCache: testUsageCache(),
    now: () => now,
    executeCommand: async (_cmd, args) => {
      if (args.includes("--version")) {
        versionCalls++;
        return "agy 2.0.0";
      }
      return "";
    },
    runUsage: async () =>
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    window: "5h",
                    remaining_fraction: 0.8,
                    reset_time: "2026-11-08T00:00:00Z",
                  },
                ],
              },
            ],
          },
        },
      }),
  });
  const res1 = await c.detect();
  assert.equal(res1.available, true);
  assert.equal(res1.version, "agy 2.0.0");
  assert.equal(versionCalls, 1);

  // Calling detect again within the 15-minute usage interval does not spawn agy --version
  now += 300000; // 5 minutes
  const res2 = await c.detect();
  assert.equal(res2.available, true);
  assert.equal(res2.version, "agy 2.0.0");
  assert.equal(versionCalls, 1);

  // Advancing past the 15-minute interval (900,000 ms) refreshes version
  now += 600001; // total 900,001 ms
  const res3 = await c.detect();
  assert.equal(res3.available, true);
  assert.equal(res3.version, "agy 2.0.0");
  assert.equal(versionCalls, 2);
});
