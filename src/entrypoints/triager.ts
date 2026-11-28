import { createInvestigationEnvironment, investigationEnvironmentRoot } from '../sandbox/index.js';
import { runTriagerAgent } from '../workers/index.js';

// The fixed agent of one Triager attempt. The Investigation Environment starts it as the main process of the
// attempt's unit, outside the command confinement. Its only argument is the private bootstrap file the Control wrote for the attempt; the
// shell it hands to the session only exists inside this unit, so the stop of the unit covers every command the session ran.
const lifetime = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => lifetime.abort());
try {
  const bootstrap = process.argv[2];
  if (process.argv.length !== 3 || !bootstrap) throw new Error('TRIAGER_BOOTSTRAP_INVALID');
  await runTriagerAgent(bootstrap, {
    signal: lifetime.signal,
    shell: (attempt, factoryRoot) => createInvestigationEnvironment({ root: investigationEnvironmentRoot(factoryRoot), factoryRoot }).shell(attempt),
  });
} catch {
  // No diagnostic leaves this process: the Control reads the end of the attempt from its own channel and from the unit.
  process.exitCode = 1;
}
