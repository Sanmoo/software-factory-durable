// Standalone fixed synthetic sender, NOT the production Worker entrypoint.
import { createRecords } from '../../src/records/index.js';
import { createSecretPublisher } from '../../src/platform/host/index.js';
process.once('message', async (input: { root: string; context: Parameters<typeof createSecretPublisher>[1]; values: string[] }) => {
  const signal = new AbortController();
  const publisher = createSecretPublisher(process, input.context, signal.signal);
  const records = await createRecords({ root: input.root });
  for (const value of input.values) records.registerSecret(value);
  publisher.protectedStarted();
  let uses = 0;
  try {
    await publisher.acknowledgeSecrets(input.values);
    uses++;
    const { phaseId: _phase, ...context } = input.context;
    const reference = await records.record({ ...context, callId: 'local-proof' }, { value: input.values[0] });
    if (process.connected) process.send!({ kind: 'fixture-result', uses, reference }, () => {});
  } catch { if (process.connected) process.send!({ kind: 'fixture-result', uses, code: 'SECRET_SYNC_DENIED' }, () => {}); }
  finally { publisher.close(); if (process.connected) process.disconnect(); }
});
