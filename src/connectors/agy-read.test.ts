import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AgyConnector } from './agy.js';
import { JobManager } from '../jobs/manager.js';
import { fixture, until } from '../jobs/test-helpers.js';

for (const scenario of [
  { name: 'complete', first: 'Complete answer', denied: [], turns: 1, final: 'Complete answer' },
  { name: 'denied', first: "I'll start by reading", denied: [{}], second: 'Recovered answer', turns: 2, final: 'Recovered answer' },
  { name: 'empty first', first: ' ', denied: [], second: 'Recovered answer', turns: 2, final: 'Recovered answer' },
  { name: 'empty second', first: 'Earlier answer', denied: [{}], second: '', turns: 2, final: 'Earlier answer' },
  { name: 'no result', first: '', denied: [], turns: 1, timeout: true },
]) {
  test(`background agy read mode: ${scenario.name}`, async () => {
    const f = fixture();
    writeFileSync(f.script, `
      const fs = require('node:fs');
      const scenario = ${JSON.stringify(scenario)};
      let turns = 0, buffer = '';
      const result = response => console.log(JSON.stringify({event:'result', result:{status:'SUCCESS', response, denied_actions:turns===1?scenario.denied:[]}}));
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\\n')) >= 0) {
          const turn = JSON.parse(buffer.slice(0,newline)); buffer = buffer.slice(newline+1);
          turns++;
          if (turns > 1 && !turn.message.content.includes('complete final answer')) process.exit(2);
          if (!scenario.timeout) result(turns === 1 ? scenario.first : scenario.second);
        }
      });
      process.stdin.on('end', () => {
        fs.writeFileSync(process.argv[2], JSON.stringify({turns, closed:true}));
        // Timeout scenario stays alive until killed; EOF alone is insufficient.
        if (scenario.timeout) setInterval(()=>{},1000);
      });
    `);
    const connector = new AgyConnector();
    connector.detect = async () => ({ available: true, exe: process.execPath });
    const build = connector.build.bind(connector);
    connector.build = job => ({ ...build(job), exe: process.execPath,
      args: [f.script, join(dirname(job.finalPath), 'input.json')] });
    const manager = new JobManager(connector, f.config);
    try {
      const job = await manager.start({ prompt: 'task', cwd: f.home, mode: 'read', timeoutMin: 0.02 });
      await until(() => ['completed', 'failed'].includes(manager.store.get(job.jobId).state));
      const result = await manager.result(job.jobId);
      assert.equal(result.state, scenario.timeout ? 'failed' : 'completed');
      if (scenario.timeout) assert.equal(result.reason, 'timeout');
      else assert.equal(result.final, scenario.final);
      const input = JSON.parse(readFileSync(join(dirname(manager.store.get(job.jobId).finalPath), 'input.json'), 'utf8'));
      assert.deepEqual(input, { turns: scenario.turns, closed: true });
    } finally {
      await manager.dispose();
      f.cleanup();
    }
  });
}
