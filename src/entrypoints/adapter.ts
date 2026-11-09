import { runSandboxAdapter, type BootRef, type EnvironmentRef } from '../sandbox/index.js';

try {
  const [root, environment, boot] = process.argv.slice(2);
  if (!root || !environment || !boot || process.argv.length !== 5) throw new Error('INVALID_ADAPTER_ARGUMENTS');
  await runSandboxAdapter(root, environment as EnvironmentRef, boot as BootRef);
} catch {
  // Do not serialize SDK errors, guest output, host environment or credentials.
  process.exitCode = 1;
}
