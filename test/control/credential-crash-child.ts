// Child controller for the crash test of credential-lifecycle.test.ts: real Control + Pi Durable/SQLite with doubled boundaries. It prints
// ACTIVE once the Builder Execution has started with its in-memory grant, then waits to be SIGKILLed (no revocation can run).
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { lifecycleDoubles } from './credential-doubles.js';

const storagePath = process.argv[2]!;
const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
const doubles = lifecycleDoubles();
const time = manualClock();
const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: doubles.ports,
  access: { tracker: github.tracker, repository: github.repository, repositories: [scope] }, polling: { intervalSeconds: 60, clock: time.clock } });
void control.run(new AbortController().signal);
await time.sleeping();
for (;;) {
  const list = await control.inspect({ kind: 'list' }) as ListView;
  if (list.works[0]?.execution?.state === 'started') break;
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.stdout.write('ACTIVE\n');
await new Promise(() => {});
