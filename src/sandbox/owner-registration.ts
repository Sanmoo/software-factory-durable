import { join } from 'node:path';
import { workerLaunchSchema, launchWorker, type WorkerBootHost } from '../platform/host/index.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connect, listen, protocolVersion, type Channel, type Envelope } from '../protocol/index.js';
import { createRecords } from '../records/index.js';
import { bootRuntimePaths } from './start.js';
import { currentSchema, metadata, ownedEnvironment, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
import { connectReadTools, contextSchema, serveReadToolBindings, type GuestOwner, type ToolContext, type ReadBinding } from './read-tools.js';

function frame(id: string, kind: string, payload: Envelope['payload'], replyTo: string | null = null): Envelope {
  return { protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: replyTo, kind, payload };
}

/** Private same-account host endpoint. Only this endpoint accepts registration;
 * worker projections get only a separately bound tool endpoint. Not admission. */
export async function serveOwnerRegistration(root: string, identity: { workId: string; environmentRef: string; bootRef: BootRef },
  vm: GuestOwner, host: WorkerBootHost, capabilities?: Pick<ReadBinding, 'profileOrigin' | 'copyOutput'>) {
  const privateCapabilities = Object.freeze({ ...(capabilities?.profileOrigin === undefined ? {} : { profileOrigin: capabilities.profileOrigin }),
    copyOutput: capabilities?.copyOutput === true });
  const directory = bootRuntimePaths(root, identity.bootRef).directory;
  const bindings = await serveReadToolBindings([], vm);
  const records = await createRecords({ root });
  const lifetimes = new Map<Channel, AbortController>();
  const invocations = new Set<string>();
  let sequence = 0;
  const server = await listen(join(directory, 'owner'), {
    async message(request, channel, peer) {
      if (request.kind === 'launch-worker') {
        const parsed = workerLaunchSchema.safeParse(request.payload);
        if (!parsed.success || lifetimes.has(channel)) {
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'failure', code: 'WORKER_LAUNCH_INVALID' }, request.message_id));
          return;
        }
        const context = Object.freeze({ ...parsed.data.context });
        if (context.workId !== peer.binding.workId || context.environmentRef !== peer.binding.environmentRef ||
            context.bootRef !== peer.binding.bootRef || invocations.has(context.invocationId)) {
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, request.message_id));
          return;
        }
        // Technical once-only claim, not an admission ledger. Never remove this
        // tombstone on error/EOF; uncertain startup must not invite replacement.
        invocations.add(context.invocationId);
        const lifetime = new AbortController();
        lifetimes.set(channel, lifetime);
        for (const secret of [...parsed.data.knownSecrets, parsed.data.profile.apiKey]) records.registerSecret(secret);
        const endpoint = join(directory, `b${++sequence}`);
        try {
          await bindings.add({ ...privateCapabilities, endpoint, context, signal: lifetime.signal, records,
            ...(parsed.data.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: parsed.data.editSourceMaxBytes }),
            ...(parsed.data.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: parsed.data.imageSourceMaxBytes }) });
          const worker = await launchWorker(host, { ...parsed.data, context }, endpoint, root, lifetime.signal);
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'requested', worker: context.invocationId }, request.message_id));
          // Request, durable start and completion are distinct observations.
          void (async () => {
            try {
              const started = await worker.started;
              await channel.send(frame(request.message_id, 'worker-started', started, request.message_id));
              const completed = await worker.completed;
              await channel.send(frame(request.message_id, 'worker-completed', completed, request.message_id));
            } catch { lifetime.abort(); channel.close(); }
          })();
        } catch {
          lifetime.abort();
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'failure', code: 'WORKER_LAUNCH_UNCERTAIN' }, request.message_id));
        }
        return;
      }
      const parsed = z.strictObject({ context: contextSchema }).safeParse(request.payload);
      if (request.kind !== 'register-binding' || !parsed.success || lifetimes.has(channel)) {
        await channel.send(frame(request.message_id, 'binding-result', { status: 'failure', code: 'INVALID_REGISTRATION' }, request.message_id));
        return;
      }
      const context = parsed.data.context;
      if (context.workId !== peer.binding.workId || context.environmentRef !== peer.binding.environmentRef ||
          context.bootRef !== peer.binding.bootRef || invocations.has(context.invocationId)) {
        await channel.send(frame(request.message_id, 'binding-result', { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, request.message_id));
        return;
      }
      // Reserve before awaiting transport setup. Closed channels revoke only their binding.
      invocations.add(context.invocationId);
      const lifetime = new AbortController();
      lifetimes.set(channel, lifetime);
      const endpoint = join(directory, `b${++sequence}`);
      await bindings.add({ ...privateCapabilities, endpoint, context, signal: lifetime.signal, records });
      await channel.send(frame(request.message_id, 'binding-result', { status: 'success', endpoint }, request.message_id));
    },
    closed(_error, _peer, channel) { lifetimes.get(channel)?.abort(); },
  }, { kind: 'host-boot', binding: Object.freeze({ ...identity }) });
  let closing: Promise<void> | undefined;
  return { close() {
    return closing ??= (async () => {
      for (const lifetime of lifetimes.values()) lifetime.abort();
      try { await server.close(); } finally { await bindings.close(); }
    })();
  } };
}

/** Host half of existing executeTool composition. Context is an explicit trusted
 * host input, not a guest claim/Records receipt; Control admission stays separate. */
export async function registerOwnerTools(root: string, input: ToolContext) {
  const context = contextSchema.parse(input);
  const { directory, owner } = await ownedEnvironment(root, context.environmentRef as EnvironmentRef);
  const current = await metadata(join(directory, 'current.json'), currentSchema);
  if (owner.workId !== context.workId || current.boot !== context.bootRef) throw new Error('TOOL_CHANNEL_UNAVAILABLE');
  const endpoint = join(bootRuntimePaths(root, context.bootRef as BootRef).directory, 'owner');
  const channel = await connect(endpoint, { kind: 'host-boot', binding: { workId: owner.workId,
    environmentRef: current.environment, bootRef: current.boot } });
  try {
    const id = randomUUID();
    await channel.send(frame(id, 'register-binding', { context }));
    const response = await channel.messages[Symbol.asyncIterator]().next();
    if (response.done || response.value.kind !== 'binding-result' || response.value.reply_to !== id) throw new Error('TOOL_CHANNEL_UNAVAILABLE');
    const result = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('success'), endpoint: z.string() }),
      z.strictObject({ status: z.literal('failure'), code: z.string() })]).parse(response.value.payload);
    if (result.status === 'failure') throw new Error(result.code);
    const projection = await connectReadTools(result.endpoint, context);
    return { executeTool: projection.executeTool, close() { projection.close(); channel.close(); } };
  } catch (error) { channel.close(); throw error; }
}
