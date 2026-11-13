import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workerLaunchSchema, workerOwnerEndpoint, type WorkerLaunch } from '../platform/host/index.js';
import { connect, protocolVersion } from '../protocol/index.js';
import type { Invocation } from './worker-start.js';
export type { ReviewerProfile } from './worker-start.js';

type Configuration = { root: string; profile: WorkerLaunch['profile']; knownSecrets: string[] };
const reference = z.strictObject({ workId: z.string(), id: z.uuid() });
const startSchema = z.strictObject({ receipt: reference });
const completionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), receipt: reference }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
]);

/** Trusted Control caller must have confirmed admission/reservation BEFORE this
 * operation. This Host facade neither grants authority nor runs a caller SDK. */
export function createWorkers(configuration?: Configuration) {
  return { async activate(invocation: Invocation) {
    if (!configuration) throw new Error('WORKER_EXECUTION_NOT_ENABLED');
    const request = workerLaunchSchema.safeParse({ context: invocation.context, prompt: invocation.prompt,
      ...(invocation.copyOutput === undefined ? {} : { copyOutput: invocation.copyOutput }),
      ...(invocation.selectedOutputCopies === undefined ? {} : { selectedOutputCopies: invocation.selectedOutputCopies }),
      ...(invocation.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: invocation.imageSourceMaxBytes }),
      ...(invocation.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: invocation.editSourceMaxBytes }),
      profile: configuration.profile, knownSecrets: configuration.knownSecrets });
    if (!request.success || invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
    const context = request.data.context;
    const { imageSourceMaxBytes, editSourceMaxBytes, copyOutput, selectedOutputCopies, ...baseRequest } = request.data;
    const payload = { ...baseRequest, ...(selectedOutputCopies === undefined ? {} : { selectedOutputCopies: [...selectedOutputCopies] }), ...(copyOutput === undefined ? {} : { copyOutput }), ...(imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes }),
      ...(editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes }) };
    const endpoint = await workerOwnerEndpoint(configuration.root, context);
    const channel = await connect(endpoint, { kind: 'host-boot', binding: { workId: context.workId,
      environmentRef: context.environmentRef, bootRef: context.bootRef } });
    const close = () => channel.close();
    invocation.signal.addEventListener('abort', close, { once: true });
    try {
      if (invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
      const id = randomUUID();
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null,
        kind: 'launch-worker', payload });
      const messages = channel.messages[Symbol.asyncIterator]();
      const receive = async (kind: string) => {
        const response = await messages.next();
        if (response.done || response.value.kind !== kind || response.value.reply_to !== id || response.value.message_id !== id ||
            response.value.controller_run_id !== null) throw new Error('WORKER_EXECUTION_UNCERTAIN');
        return response.value.payload;
      };
      const acknowledgement = z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('requested'), worker: z.string() }),
        z.strictObject({ status: z.literal('failure'), code: z.enum(['WORKER_LAUNCH_INVALID', 'STALE_TOOL_CONTEXT', 'WORKER_LAUNCH_UNCERTAIN']) }),
      ]).parse(await receive('worker-launch-result'));
      if (acknowledgement.status === 'failure') throw new Error(acknowledgement.code);
      if (acknowledgement.worker !== context.invocationId) throw new Error('WORKER_EXECUTION_UNCERTAIN');
      const started = receive('worker-started').then(value => startSchema.parse(value));
      const completed = started.then(async () => completionSchema.parse(await receive('worker-completed')));
      void started.catch(() => {}); void completed.catch(() => {});
      return { worker: acknowledgement.worker, started, completed, close() {
        invocation.signal.removeEventListener('abort', close); close();
      } };
    } catch (error) { invocation.signal.removeEventListener('abort', close); close(); throw error; }
  } };
}

/** Technical fixed-entrypoint composition only; not Control authorization. */
export async function runWorkerProcess(bootstrap: unknown, signal: AbortSignal) {
  const { run } = await import('./worker-process.js');
  return run(bootstrap, signal);
}
