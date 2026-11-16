import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { untilHolds } from '../runner/budget.js';

// Flow level with ONE module-internal fault: the durable hold commit fails (e.g. storage unavailable). Real Control/Pi Durable/SQLite otherwise.
const actual = await import('../../src/control/durable/execution.js');
let holdAttempts = 0;
mock.module(new URL('../../src/control/durable/execution.js', import.meta.url).href, { namedExports: { ...actual,
  holdExecution: async () => { holdAttempts++; throw new Error('SYNTHETIC_STORAGE_UNAVAILABLE'); } } });
const { openControl } = await import('../../src/control/index.js');
const { githubDoubles, manualClock, remoteIssue, scope } = await import('./doubles.js');
const { lifecycleDoubles, tokenOf } = await import('./credential-doubles.js');

test('review 3: even when the hold commit fails, the held Execution still withdraws its credentials and attempts revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-credential-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const doubles = lifecycleDoubles({ startConflict: true });
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: doubles.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  await untilHolds('grant revoked', () => doubles.calls.some(call => call.kind === 'revoke'), 5);
  assert.ok(holdAttempts >= 1, 'the receipt conflict tried to hold');
  assert.deepEqual(doubles.calls.filter(call => call.kind === 'revoke').map(call => call.token), [tokenOf(1)]);
  assert.ok(doubles.calls.some(call => call.directive === 'withdraw-credential'), 'the live worker loses the credential for new commands');
  stop.abort();
  await running;
});
