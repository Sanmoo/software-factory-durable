// Child controller of recovery-crash.test.ts: real Control + Pi Durable/SQLite + Records with the file-backed host double. It drives the
// polling clock until the requested cut point, prints CUT, then waits to be SIGKILLed: the process dies with the Execution in flight and its
// doubled boot left active (a survivor), exactly what the next controller boot must reconcile.
import { openControl } from '../../src/control/index.js';
import type { ListView } from '../../src/control/types.js';
import { githubDoubles, manualClock, remoteIssue, scope } from './doubles.js';
import { readHost, recoveryDoubles, updateHost, type RecoveryScript } from './recovery-doubles.js';

const [dir, mode] = [process.argv[2]!, process.argv[3]!];
let cut = false;
const scripts: Record<string, RecoveryScript[]> = {
  reservation: [], spawn: [{ kind: 'no-receipt' }], receipt: [{ kind: 'fail', code: 'WORKER_EXECUTION_UNCERTAIN' }, { kind: 'lose-notification' }],
  tool: [{ kind: 'hang' }], two: [{ kind: 'hang' }, { kind: 'hang' }], question: [{ kind: 'ask', questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000026', question: 'Which port?', hangAfterAck: true }],
};
const doubles = recoveryDoubles(dir, scripts[mode]!, { capacity: mode === 'two' ? 2 : 1,
  ...(mode === 'reservation' ? { onPrepare: async () => { cut = true; await new Promise<void>(() => {}); } } : {}) });
const github = githubDoubles({ pulls: {}, issues: [remoteIssue(3), ...(mode === 'two' ? [remoteIssue(4)] : [])] });
const time = manualClock();
const control = await openControl({ storagePath: `${dir}/control.sqlite`, runtimeInventory: 'empty', execution: doubles.ports,
  access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
void control.run(new AbortController().signal);
const reached = async () => {
  if (cut) return true;
  const works = (await control.inspect({ kind: 'list' }) as ListView).works;
  const log = readHost(dir).log;
  if (mode === 'spawn') return log.some(item => item.kind === 'activate');
  if (mode === 'receipt') {
    // The first (transient) failure requested a recovery: its persisted wait is passed on the doubled calendar, then the recovery's receipt is cut.
    if (works[0]?.pendingRecovery && readHost(dir).calendarOffsetMs === 0) updateHost(dir, state => { state.calendarOffsetMs = 60000; });
    return log.filter(item => item.kind === 'receipt').length === 2;
  }
  if (mode === 'question') return works[0]?.questions.length === 1;
  return works.length > 0 && works.every(work => work.execution?.state === 'started');
};
for (;;) {
  if (await reached()) break;
  if (time.isSleeping()) time.advance();
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.stdout.write('CUT\n');
await new Promise(() => {});
