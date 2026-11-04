import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgyConnector } from '../connectors/agy.js';
import { fixture } from '../jobs/test-helpers.js';
import { buildHealthStatus, healthTool } from './health.tool.js';

test('health reports detection, model IDs and effective job configuration with fakes', async t => {
  const f = fixture();
  const original = process.env.AGENT_JOBS_HOME;
  process.env.AGENT_JOBS_HOME = f.home;
  t.after(() => {
    if (original === undefined) delete process.env.AGENT_JOBS_HOME;
    else process.env.AGENT_JOBS_HOME = original;
    f.cleanup();
  });
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ connectors: {
    agy: { enabled: false, defaultModel: 'custom-default', reviewModel: 'custom-review' },
  } }));
  const connector = new AgyConnector();
  t.mock.method(connector, 'detect', async () => ({ available: true, exe: 'fake-agy', version: 'fake-version' }));
  const status = await buildHealthStatus(undefined, connector, async () => ['fake-model-id']);
  assert.deepEqual(status.agyCli, {
    available: true, exe: 'fake-agy', version: 'fake-version', installed: true,
    authenticated: true, models: ['fake-model-id'], reviewModel: 'custom-review',
    defaultModel: 'custom-default', jobsEnabled: false,
  });
  t.mock.method(connector, 'models', async () => ['fake-model-id']);
  assert.deepEqual(await connector.health(), {
    available: true, exe: 'fake-agy', version: 'fake-version', models: ['fake-model-id'],
    reviewModel: connector.reviewModel,
  });
  t.mock.method(AgyConnector.prototype, 'detect', async () => { throw new Error('fake detection failure'); });
  const failed = await healthTool.execute({});
  assert.equal(typeof failed, 'object');
  assert.equal((failed as any).structuredContent.status, 'unhealthy');
  for (const field of ['agyCli', 'sessions', 'issues', 'error'])
    assert.ok(field in (failed as any).structuredContent);
});
