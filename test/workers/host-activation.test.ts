import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkers } from '../../src/workers/index.js';

test('host activation is closed without admission/credential launch wiring and never runs SDK', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('host must not execute SDK/provider requests'); });
  const workers = createWorkers();
  await assert.rejects(workers.activate({}), /WORKER_EXECUTION_NOT_ENABLED/);
  await assert.rejects(workers.activate({ context: { workId: 'work-05', executionId: 'execution-05',
    invocationId: 'standards-05', role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' },
    prompt: 'Must not run in caller', signal: new AbortController().signal }), /WORKER_EXECUTION_NOT_ENABLED/);
});
