import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkers } from '../../src/workers/index.js';

test('unconfigured host activation stays closed with no caller-side SDK fallback', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('host must not execute SDK/provider requests'); });
  const workers = createWorkers();
  await assert.rejects(workers.activate({} as never), /WORKER_EXECUTION_NOT_ENABLED/);
  await assert.rejects(workers.activate({ context: { workId: 'work-05', executionId: 'execution-05',
    invocationId: 'standards-05', role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' },
    prompt: 'Must not run in caller', signal: new AbortController().signal }), /WORKER_EXECUTION_NOT_ENABLED/);
});
