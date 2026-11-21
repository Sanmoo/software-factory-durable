// One `ci` tier execution whose only real effect is the machine lock: static analysis announces
// "working" and holds until stdin closes, so the parent test drives the interleaving without sleeps.
import { acquireMachineLock } from '../../../scripts/test-runner/lock.ts';
import { runTier } from '../../../scripts/test-runner/runner.ts';
import { fixturePolicy } from '../policy-fixture.ts';

const [lockPath, name] = process.argv.slice(2) as [string, string];
const log = (text: string) => {
  for (const line of text.split('\n')) process.stdout.write(`${name}: ${line}\n`);
};
const stdinClosed = new Promise<void>(resolve => {
  process.stdin.on('end', resolve);
  process.stdin.resume();
});
const outcome = await runTier(
  { tier: 'ci', filters: [] },
  {
    cpus: 1,
    now: () => Date.now(),
    log,
    loadAverage: () => [0, 0, 0],
    checkDependencies: async () => [],
    loadManifest: async () => new Map(),
    loadPolicy: async () => fixturePolicy(),
    changedSet: async base => ({ widened: 'fixture', base }),
    loadIntegral: async () => undefined,
    saveIntegral: async () => {},
    headCommit: async () => 'c',
    loadLevels: async () => () => 'integration',
    audit: async () => ({ name: 'npm audit', ms: 0, ok: true }),
    acquireLock: tier => acquireMachineLock(lockPath, { pid: process.pid, tier, name }, log),
    staticAnalysis: async () => {
      log('working');
      await stdinClosed;
      log('done');
      return [];
    },
    listTests: async () => [],
    loadTimings: async () => ({}),
    saveTimings: async () => {},
    sandboxRoot: async () => {
      throw new Error('unused');
    },
    runDirectory: async () => ({ path: '/unused', cleanup: async () => {} }),
    runFile: async () => {
      throw new Error('unused');
    },
  },
);
process.exitCode = outcome.exitCode;
