// Child controller of triage-crash.test.ts (spec #68 TR-11): it investigates one Triage request in the real Investigation Environment,
// prints `INVESTIGATING <attempt> <unit>` once the attempt's invocation is recorded, then waits to be SIGKILLed. Nothing of it is stopped:
// the unit of the attempt, with its Triager agent, outlives it.
import { until } from '../runner/budget.js';
import { openCrashControl } from './triage-crash-world.js';

const [factoryRoot, storagePath, modelUrl] = process.argv.slice(2) as [string, string, string];
const world = await openCrashControl({ factoryRoot, storagePath, modelUrl });
void world.control.run(new AbortController().signal);
await world.time.sleeping();
const attempt = await until('the attempt to record its invocation', async () => {
  const open = (await world.requests())[0]?.attempts?.[0];
  return open?.environment.invocation ? open : undefined;
});
process.stdout.write(`INVESTIGATING ${attempt.attempt} ${attempt.environment.unit}\n`);
await new Promise(() => {});
