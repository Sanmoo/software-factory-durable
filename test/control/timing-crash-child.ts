// Child controller for the duration-after-crash tests of timeout-flow.test.ts: real Control + Pi Durable/SQLite with doubled boundaries and
// a controlled monotonic clock. It prints ACTIVE once the Builder Execution is running (with its last durable activity), then waits to be
// SIGKILLed: its monotonic origin dies with it, so the end of the Execution is never observed.
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { budgetDoubles, executionClock } from './budget-doubles.js';

const storagePath = process.argv[2]!;
// 'timeout': timeout 120 s, crash right after the start. 'none': no timeout. 'proven': a durable activity at 130 s, then crash.
const mode = process.argv[3] ?? 'timeout';
const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
const time = manualClock();
const monotonic = executionClock();
const doubles = budgetDoubles([mode === 'proven' ? { kind: 'handoff', beforeHandoff: () => monotonic.jump(130000) } : { kind: 'hang' }],
  { clock: monotonic.clock, reviews: mode === 'proven' });
const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: doubles.ports,
  access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...(mode === 'none' ? {} : { timeoutSeconds: 120 }) }] },
  polling: { intervalSeconds: 60, clock: time.clock } });
void control.run(new AbortController().signal);
await time.sleeping();
for (;;) {
  const execution = (await control.inspect({ kind: 'list' }) as ListView).works[0]?.execution;
  if (execution?.state === 'started' && (mode !== 'proven' || execution.timing?.lastActivity?.event.startsWith('reviewer-started'))) break;
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.stdout.write('ACTIVE\n');
await new Promise(() => {});
