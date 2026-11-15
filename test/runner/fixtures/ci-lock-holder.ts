// One `ci` tier execution whose only real effect is the machine lock: static analysis announces
// "working" and holds until stdin closes, so the parent test drives the interleaving without sleeps.
import { acquireMachineLock } from '../../../scripts/test-runner/lock.ts';
import { runTier } from '../../../scripts/test-runner/runner.ts';

const [lockPath, name] = process.argv.slice(2) as [string, string];
const log = (text: string) => { for (const line of text.split('\n')) process.stdout.write(`${name}: ${line}\n`); };
const stdinClosed = new Promise<void>(resolve => { process.stdin.on('end', resolve); process.stdin.resume(); });
const outcome = await runTier({ tier: 'ci', filters: [] }, {
  cpus: 1, now: () => Date.now(), log, loadAverage: () => [0, 0, 0],
  checkDependencies: async () => [], loadManifest: async () => new Map(),
  acquireLock: tier => acquireMachineLock(lockPath, { pid: process.pid, tier, name }, log),
  staticAnalysis: async () => { log('working'); await stdinClosed; log('done'); return []; },
  listTests: async () => [], loadTimings: async () => ({}), saveTimings: async () => {},
  sandboxRoot: async () => { throw new Error('unused'); },
  runFile: async () => { throw new Error('unused'); },
});
process.exitCode = outcome.exitCode;
