import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workerLaunchSchema, workerOwnerEndpoint, type WorkerLaunch } from '../platform/host/index.js';
import { connect, protocolVersion } from '../protocol/index.js';
import type { Invocation } from './worker-start.js';
export type { ReviewerProfile, Invocation } from './worker-start.js';
export { builderSkillPack } from './skill-pack.js';
/** Transient material handed to the host handshake, never part of the (serializable) invocation. */
export type ActivationDelivery = { credential?: Readonly<{ token: string }> };

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
  return { async activate(invocation: Invocation, delivery?: ActivationDelivery) {
    if (!configuration) throw new Error('WORKER_EXECUTION_NOT_ENABLED');
    const request = workerLaunchSchema.safeParse({ context: invocation.context, prompt: invocation.prompt,
      ...(invocation.copyOutput === undefined ? {} : { copyOutput: invocation.copyOutput }),
      ...(invocation.selectedOutputCopies === undefined ? {} : { selectedOutputCopies: invocation.selectedOutputCopies }),
      ...(invocation.skillPack === undefined ? {} : { skillPack: invocation.skillPack }),
      ...(invocation.modelBudget === undefined ? {} : { modelBudget: invocation.modelBudget }),
      ...(invocation.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: invocation.imageSourceMaxBytes }),
      ...(invocation.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: invocation.editSourceMaxBytes }),
      profile: configuration.profile, knownSecrets: configuration.knownSecrets });
    if (!request.success || invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
    if (delivery?.credential !== undefined && (request.data.context.role !== 'builder' || typeof delivery.credential.token !== 'string')) throw new Error('WORKER_LAUNCH_INVALID');
    const context = request.data.context;
    const { imageSourceMaxBytes, editSourceMaxBytes, copyOutput, selectedOutputCopies, skillPack, modelBudget, ...baseRequest } = request.data;
    const payload = { ...baseRequest, ...(skillPack === undefined ? {} : { skillPack }), ...(modelBudget === undefined ? {} : { modelBudget }), ...(selectedOutputCopies === undefined ? {} : { selectedOutputCopies: [...selectedOutputCopies] }), ...(copyOutput === undefined ? {} : { copyOutput }), ...(imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes }),
      ...(editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes }) };
    const endpoint = await workerOwnerEndpoint(configuration.root, context);
    const channel = await connect(endpoint, { kind: 'host-boot', binding: { workId: context.workId,
      environmentRef: context.environmentRef, bootRef: context.bootRef } });
    const close = () => channel.close();
    invocation.signal.addEventListener('abort', close, { once: true });
    try {
      if (invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
      const messages = channel.messages[Symbol.asyncIterator]();
      if (delivery?.credential !== undefined) {
        // Host handshake (spec §8.1): the credential reaches the owner's tool path BEFORE the worker exists; it is never in the launch payload.
        const credentialId = randomUUID();
        await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: credentialId, reply_to: null,
          kind: 'deliver-credential', payload: { context, token: delivery.credential.token } });
        const reply = await messages.next();
        if (reply.done || reply.value.kind !== 'credential-result' || reply.value.reply_to !== credentialId ||
            JSON.stringify(reply.value.payload) !== '{"status":"delivered"}') throw new Error('CREDENTIAL_DELIVERY_FAILED');
      }
      const id = randomUUID();
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null,
        kind: 'launch-worker', payload });
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

// Narrow standalone installation prerequisite; no arbitrary auth routing/CRUD.
export { firstFactoryOAuthLogin } from './factory-oauth.js';
