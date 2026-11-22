// Child controller of lambda-crash-reconciliation.test.ts (v2 ticket 15): real Control + Pi Durable/SQLite over the production execution
// composition with the Lambda adapter and the file-backed fake AWS account. It runs until the Work's Execution has started in a boot
// (a MicroVM running, the Builder at work), prints CUT and waits to be SIGKILLed: the boot owner dies with the process and the MicroVM
// is left running in the account with nobody.
import { openControl, type ListView } from '../../src/control/index.js';
import { composeProductionAccess } from '../../src/entrypoints/controller/composition.js';
import { manualClock } from '../control/doubles.js';
import { untilHolds } from '../runner/budget.js';
import { composeCrashInstallation, effective } from './lambda-crash-fixture.js';
import { installNativeAppFixture } from './native-app-fixture.js';

const [root, executable, accountFile, storagePath] = process.argv.slice(2) as [string, string, string, string];
installNativeAppFixture(executable, 'world');
const installation = await composeCrashInstallation({ root, executable, accountFile });
const time = manualClock();
const control = await openControl({
  storagePath,
  runtimeInventory: 'empty',
  execution: installation.ports,
  access: composeProductionAccess({ github: installation.github, effective }),
  polling: { intervalSeconds: 60, clock: time.clock },
});
void control.run(new AbortController().signal);
// Bounded by the runner's budget (docs/guides/testing-strategy.md): past it this child fails naming the stage instead of polling forever.
await untilHolds(
  'the Execution of the Work started in a Lambda boot',
  async () => {
    const work = ((await control.inspect({ kind: 'list' })) as ListView).works[0];
    if (work?.execution?.state === 'started' && installation.launched.length > 0) return true;
    if (time.isSleeping()) time.advance();
    return false;
  },
  10,
);
process.stdout.write('CUT\n');
await new Promise(() => {});
