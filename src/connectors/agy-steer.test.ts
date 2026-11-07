import { tmpdir } from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { AgyConnector } from "./agy.js";
import { JobManager } from "../jobs/manager.js";
import { fixture, until } from "../jobs/test-helpers.js";

const usageHomes: string[] = [];
const testUsageCache = () => {
  const home = mkdtempSync(join(tmpdir(), "agy-steer-usage-"));
  usageHomes.push(home);
  return { home, onBattery: false };
};
after(() => {
  for (const home of usageHomes) rmSync(home, { recursive: true, force: true });
});

test("a steer before the first result writes a user turn, keeps stdin open, and returns queued", async () => {
  const f = fixture();
  writeFileSync(
    f.script,
    `
    const fs = require('node:fs');
    let turns = 0;
    let buffer = '';
    const received = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const turn = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        turns++;
        received.push(turn.message.content);
        if (turns === 2) {
          // Both initial prompt and steer turns received: emit result 1, then result 2
          console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'First turn done' } }));
          setTimeout(() => {
            console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Steer turn done' } }));
          }, 20);
        }
      }
    });
    process.stdin.on('end', () => {
      fs.writeFileSync(process.argv[2], JSON.stringify({ turns, received, closed: true }));
    });
  `,
  );
  const connector = new AgyConnector();
  connector.detect = async () => ({ available: true, exe: process.execPath });
  const build = connector.build.bind(connector);
  connector.build = (job) => ({
    ...build(job),
    exe: process.execPath,
    args: [f.script, join(dirname(job.finalPath), "steer-out.json")],
  });
  const manager = new JobManager(connector, f.config);
  try {
    const job = await manager.start({
      prompt: "initial task",
      cwd: f.home,
      mode: "write",
    });
    await until(() => manager.store.get(job.jobId).state === "running");
    const steerRes = await manager.steer(job.jobId, "steer instruction");
    assert.deepEqual(steerRes, { delivered: "queued" });
    assert.equal(manager.store.get(job.jobId).steers, 1);
    await until(() =>
      ["completed", "failed"].includes(manager.store.get(job.jobId).state),
    );
    const result = await manager.result(job.jobId);
    assert.equal(result.state, "completed");
    assert.equal(result.final, "Steer turn done");
    const out = JSON.parse(
      readFileSync(
        join(dirname(manager.store.get(job.jobId).finalPath), "steer-out.json"),
        "utf8",
      ),
    );
    assert.equal(out.closed, true);
    assert.equal(out.turns, 2);
    assert.ok(out.received[0].endsWith("initial task"));
    assert.equal(out.received[1], "steer instruction");
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test("a result with no pending steer closes stdin", async () => {
  const f = fixture();
  writeFileSync(
    f.script,
    `
    const fs = require('node:fs');
    let turns = 0;
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const turn = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        turns++;
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Quick answer' } }));
      }
    });
    process.stdin.on('end', () => {
      fs.writeFileSync(process.argv[2], JSON.stringify({ turns, closed: true }));
    });
  `,
  );
  const connector = new AgyConnector();
  connector.detect = async () => ({ available: true, exe: process.execPath });
  const build = connector.build.bind(connector);
  connector.build = (job) => ({
    ...build(job),
    exe: process.execPath,
    args: [f.script, join(dirname(job.finalPath), "no-steer-out.json")],
  });
  const manager = new JobManager(connector, f.config);
  try {
    const job = await manager.start({
      prompt: "quick task",
      cwd: f.home,
      mode: "write",
    });
    await until(() =>
      ["completed", "failed"].includes(manager.store.get(job.jobId).state),
    );
    const result = await manager.result(job.jobId);
    assert.equal(result.state, "completed");
    assert.equal(result.final, "Quick answer");
    const out = JSON.parse(
      readFileSync(
        join(
          dirname(manager.store.get(job.jobId).finalPath),
          "no-steer-out.json",
        ),
        "utf8",
      ),
    );
    assert.equal(out.closed, true);
    assert.equal(out.turns, 1);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test("read-mode recovery is still correct", async () => {
  const f = fixture();
  writeFileSync(
    f.script,
    `
    const fs = require('node:fs');
    let turns = 0;
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const turn = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        turns++;
        if (turns === 1) {
          console.log(JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] },
          }));
        } else if (turns === 2) {
          if (!turn.message.content.includes('complete final answer')) process.exit(2);
          console.log(JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: 'Recovered read answer' },
          }));
        }
      }
    });
    process.stdin.on('end', () => {
      fs.writeFileSync(process.argv[2], JSON.stringify({ turns, closed: true }));
    });
  `,
  );
  const connector = new AgyConnector();
  connector.detect = async () => ({ available: true, exe: process.execPath });
  const build = connector.build.bind(connector);
  connector.build = (job) => ({
    ...build(job),
    exe: process.execPath,
    args: [f.script, join(dirname(job.finalPath), "read-recovery-out.json")],
  });
  const manager = new JobManager(connector, f.config);
  try {
    const job = await manager.start({
      prompt: "read task",
      cwd: f.home,
      mode: "read",
    });
    await until(() =>
      ["completed", "failed"].includes(manager.store.get(job.jobId).state),
    );
    const result = await manager.result(job.jobId);
    assert.equal(result.state, "completed");
    assert.equal(result.final, "Recovered read answer");
    const out = JSON.parse(
      readFileSync(
        join(
          dirname(manager.store.get(job.jobId).finalPath),
          "read-recovery-out.json",
        ),
        "utf8",
      ),
    );
    assert.equal(out.closed, true);
    assert.equal(out.turns, 2);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test("read-mode recovery combined with steering stays open until both results arrive", async () => {
  const f = fixture();
  writeFileSync(
    f.script,
    `
    const fs = require('node:fs');
    let turns = 0;
    let buffer = '';
    const received = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\\n')) >= 0) {
        const turn = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        turns++;
        received.push(turn.message.content);
        if (turns === 2) {
          // Turn 1 was initial prompt, Turn 2 was steer.
          // Emit result 1 (which triggers recovery turn)
          console.log(JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] },
          }));
        } else if (turns === 3) {
          // Turn 3 was recovery turn. Emit result for steer then result for recovery.
          console.log(JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: 'Steer result' },
          }));
          setTimeout(() => {
            console.log(JSON.stringify({
              event: 'result',
              result: { status: 'SUCCESS', response: 'Final recovered answer' },
            }));
          }, 20);
        }
      }
    });
    process.stdin.on('end', () => {
      fs.writeFileSync(process.argv[2], JSON.stringify({ turns, received, closed: true }));
    });
  `,
  );
  const connector = new AgyConnector();
  connector.detect = async () => ({ available: true, exe: process.execPath });
  const build = connector.build.bind(connector);
  connector.build = (job) => ({
    ...build(job),
    exe: process.execPath,
    args: [f.script, join(dirname(job.finalPath), "read-steer-out.json")],
  });
  const manager = new JobManager(connector, f.config);
  try {
    const job = await manager.start({
      prompt: "read task",
      cwd: f.home,
      mode: "read",
    });
    await until(() => manager.store.get(job.jobId).state === "running");
    const steerRes = await manager.steer(job.jobId, "steer guidance");
    assert.deepEqual(steerRes, { delivered: "queued" });
    await until(() =>
      ["completed", "failed"].includes(manager.store.get(job.jobId).state),
    );
    const result = await manager.result(job.jobId);
    assert.equal(result.state, "completed");
    assert.equal(result.final, "Final recovered answer");
    const out = JSON.parse(
      readFileSync(
        join(
          dirname(manager.store.get(job.jobId).finalPath),
          "read-steer-out.json",
        ),
        "utf8",
      ),
    );
    assert.equal(out.closed, true);
    assert.equal(out.turns, 3);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test("usagePercent returns max window percent from fake usage JSON and undefined on error", async () => {
  const fakeUsageJson = JSON.stringify({
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
                remaining_fraction: 0.7, // 30% used
                reset_time: "2026-11-01T00:17:22Z",
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.85, // 15% used
                reset_time: "2026-10-31T20:39:33Z",
              },
            ],
          },
        ],
      },
    },
  });

  const cOk = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => fakeUsageJson,
  });
  assert.equal(await cOk.usagePercent(), 30);

  const cFail = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => {
      throw new Error("quota command timed out");
    },
  });
  assert.equal(await cFail.usagePercent(), undefined);
});

test("JobManager quota guard skips optional jobs when usagePercent is above threshold", async () => {
  const f = fixture();
  const highUsageJson = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 0.05, // 95% used
                reset_time: "2026-10-31T20:39:33Z",
              },
            ],
          },
        ],
      },
    },
  });

  const connector = new AgyConnector({
    usageCache: testUsageCache(),
    runUsage: async () => highUsageJson,
  });
  connector.detect = async () => ({ available: true, exe: process.execPath });
  const manager = new JobManager(connector, f.config);
  try {
    await assert.rejects(
      manager.start({
        prompt: "optional task",
        cwd: f.home,
        priority: "optional",
      }),
      /Optional job refused: 5-hour or weekly usage window is at 95%/,
    );
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});
