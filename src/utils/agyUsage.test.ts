import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeAgyUsage, fetchAgyQuota, parseAgyQuota } from "./agyUsage.js";

const NOW = Date.parse("2026-10-31T18:00:00Z");
const bucket = (
  id: string,
  window: string,
  remaining: number,
  reset: string,
) => ({
  id,
  window,
  remaining_fraction: remaining,
  reset_time: reset,
});
const usageJson = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "tsv",
  usage: { total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            bucket("gemini-weekly", "weekly", 0.7526, "2026-11-01T00:17:22Z"),
            bucket("gemini-5h", "5h", 0.9799, "2026-10-31T20:39:33Z"),
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            bucket("3p-weekly", "weekly", 1, "2026-11-07T15:48:01Z"),
            bucket("3p-5h", "5h", 1, "2026-10-31T20:48:01Z"),
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            bucket(
              "gemini-argon-wtu-weekly",
              "weekly",
              0.0045,
              "2026-11-01T00:38:09Z",
            ),
          ],
        },
      ],
    },
  },
});

test("parses /usage into used percentages, resets and a meter line", () => {
  const q = parseAgyQuota(usageJson, NOW);
  assert.equal(q.available, true);
  assert.equal(q.groups[0].fiveHour?.usedPercent, 2);
  assert.equal(q.groups[0].weekly?.usedPercent, 25);
  assert.equal(q.groups[0].fiveHour?.resetIn, "in 2h 39m");
  assert.equal(q.groups[2].fiveHour, undefined);
  assert.equal(q.groups[2].weekly?.usedPercent, 100);
  assert.equal(
    q.summary,
    "agy gem 5h 2% · wk 25% · 3p 5h 0% · wk 0% · argon wk 100%",
  );
});

test("failures are reported as unavailable", async () => {
  assert.equal(parseAgyQuota("not json").available, false);
  assert.equal(
    parseAgyQuota('{"status":"ERROR","response":"please sign in"}').reason,
    "please sign in",
  );
  const dir = mkdtempSync(join(tmpdir(), "agy-usage-"));
  try {
    const opts = {
      cachePath: join(dir, "c.json"),
      claudeUsageDir: join(dir, "none"),
    };
    const failed = await fetchAgyQuota({
      ...opts,
      run: async () => {
        throw new Error("spawn agy ENOENT");
      },
    });
    assert.equal(failed.available, false);
    assert.match(failed.reason ?? "", /ENOENT/);
    assert.equal(
      (await fetchAgyQuota({ ...opts, run: async () => "garbage" })).available,
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caches for five minutes, honors refresh, writes status file only if dir exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-usage-"));
  try {
    let calls = 0;
    const run = async () => (calls++, usageJson);
    const claudeUsageDir = join(dir, "usage");
    const cachePath = join(dir, "cache.json");
    await fetchAgyQuota({ run, cachePath, claudeUsageDir, now: NOW });
    assert.equal(existsSync(join(claudeUsageDir, "agy.json")), false);
    mkdirSync(claudeUsageDir);
    await fetchAgyQuota({
      run,
      cachePath,
      claudeUsageDir,
      now: NOW,
      refresh: true,
    });
    assert.equal(calls, 2);
    const file = JSON.parse(
      readFileSync(join(claudeUsageDir, "agy.json"), "utf8"),
    );
    assert.equal(file.taken_at, Math.floor(NOW / 1000));
    assert.match(file.summary, /^agy gem 5h 2%/);
    assert.equal(file.groups.length, 3);
    // The cache age uses file mtime, so a real-clock now is a hit.
    const hit = await fetchAgyQuota({
      run,
      cachePath,
      claudeUsageDir,
      now: Date.now(),
    });
    assert.equal(calls, 2);
    assert.equal(hit.available, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional tallies sum tokens per model from a fake store", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-store-"));
  try {
    const now = new Date("2026-10-31T18:00:00");
    const add = (
      id: string,
      connector: string,
      finishedAt: number,
      stdout: string,
      extra = {},
    ) => {
      mkdirSync(join(home, "jobs", id), { recursive: true });
      writeFileSync(
        join(home, "jobs", id, "meta.json"),
        JSON.stringify({ id, connector, finishedAt, ...extra }),
      );
      writeFileSync(join(home, "jobs", id, "stdout"), stdout);
    };
    const run = (model: string, tokens: number) =>
      JSON.stringify({ event: "init", conversation_id: "c", init: { model } }) +
      "\n" +
      JSON.stringify({
        event: "result",
        result: { usage: { total_tokens: tokens } },
      }) +
      "\n";
    add("a", "agy", now.getTime() - 3600000, run("m1", 100));
    add("b", "agy", now.getTime() - 3600000, run("m1", 50));
    add("c", "agy", now.getTime() - 8 * 3600000, run("m2", 7));
    add("d", "codex", now.getTime() - 3600000, run("m1", 999));
    add("e", "agy", now.getTime() - 1800000, "", {
      reason: "usage_limit",
      resetAt: Date.parse("2026-10-31T23:00:00Z"),
      error: "quota",
    });
    const report = computeAgyUsage(now, { AGENT_JOBS_HOME: home });
    assert.deepEqual(report.last5h, { m1: { jobs: 2, totalTokens: 150 } });
    assert.deepEqual(report.today.m1, { jobs: 2, totalTokens: 150 });
    assert.equal(report.lastUsageLimit?.jobId, "e");
    assert.equal(report.lastUsageLimit?.resetAt, "2026-10-31T23:00:00.000Z");
    assert.deepEqual(
      computeAgyUsage(now, { AGENT_JOBS_HOME: join(home, "missing") }).today,
      {},
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
