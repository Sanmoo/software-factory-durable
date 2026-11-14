import { join } from 'node:path';
import { deliverSchema, workerLaunchSchema, launchWorker, type WorkerBootHost } from '../platform/host/index.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connect, listen, protocolVersion, type Channel, type Envelope } from '../protocol/index.js';
import { createRecords } from '../records/index.js';
import { bootRuntimePaths } from './start.js';
import { currentSchema, metadata, ownedEnvironment, type BootRef } from './lifecycle.js';
import type { EnvironmentRef } from './prepare.js';
import { connectReadTools, contextSchema, serveReadToolBindings, type GuestOwner, type ToolContext, type ReadBinding } from './read-tools.js';

const credentialSchema = z.strictObject({ context: contextSchema, token: z.string().min(1).max(1024).regex(/^[a-zA-Z0-9._~+/-]+=*$/) });
const questionAckSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('recorded') }),
  z.strictObject({ status: z.literal('refused'), code: z.string().regex(/^[A-Z_]{1,64}$/) })]);

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
  // Transient Builder credentials of a host-boot channel (spec §8.1): the first delivery precedes its launch; after the launch the SAME
  // invocation may receive renewals (new commands only) and a final withdrawal (ticket 20). Memory only; one mutable holder per channel.
  const credentials = new Map<Channel, { token: string | undefined; readonly invocationId: string; withdrawn: boolean }>();
  // ask_user relays awaiting the Control's ACK on the SAME host-boot channel that launched the worker (bounded wait, no retry).
  const questionAcks = new Map<string, { channel: Channel; resolve(ack: z.infer<typeof questionAckSchema>): void; reject(error: Error): void }>();
  // Ticket 12: the launched worker of each host-boot channel, for Host directives to a suspended Builder (Q6 deliver).
  const launched = new Map<Channel, { launchId: string; deliver(directive: Record<string, unknown>): Promise<boolean> }>();
  let sequence = 0;
  const server = await listen(join(directory, 'owner'), {
    async message(request, channel, peer) {
      if (request.kind === 'deliver-directive') {
        const worker = launched.get(channel);
        const parsed = deliverSchema.safeParse({ kind: 'deliver', directive: request.payload.directive });
        const delivered = worker && parsed.success && request.reply_to === worker.launchId && Object.keys(request.payload).length === 1
          ? await worker.deliver(parsed.data.directive) : false;
        await channel.send(frame(request.message_id, 'delivery-result', delivered ? { status: 'delivered' } : { status: 'failure', code: 'DELIVERY_DENIED' }, request.message_id));
        return;
      }
      if (request.kind === 'question-ack') {
        const pending = request.reply_to ? questionAcks.get(request.reply_to) : undefined;
        const parsed = questionAckSchema.safeParse(request.payload);
        if (!pending || pending.channel !== channel || !lifetimes.has(channel)) return;
        questionAcks.delete(request.reply_to!);
        if (parsed.success) pending.resolve(parsed.data); else pending.reject(new Error('QUESTION_ACK_INVALID'));
        return;
      }
      if (request.kind === 'deliver-credential' || request.kind === 'withdraw-credential') {
        const withdrawal = request.kind === 'withdraw-credential';
        const parsed = (withdrawal ? z.strictObject({ context: contextSchema }) : credentialSchema).safeParse(request.payload);
        const context = parsed.success ? parsed.data.context : undefined;
        const holder = credentials.get(channel);
        const sameBoot = context !== undefined && context.workId === peer.binding.workId && context.environmentRef === peer.binding.environmentRef &&
          context.bootRef === peer.binding.bootRef;
        // Initial: before this channel's launch, for a never-launched invocation. Renewal/withdrawal: after the launch, for THE invocation
        // the initial credential was bound to, while its lifetime is open and it was not withdrawn. Reviewers never qualify.
        const initial = !withdrawal && !lifetimes.has(channel) && !holder && !invocations.has(context?.invocationId ?? '');
        const later = holder !== undefined && !holder.withdrawn && lifetimes.has(channel) && !lifetimes.get(channel)!.signal.aborted &&
          holder.invocationId === context?.invocationId;
        if (!parsed.success || !context || context.role !== 'builder' || !sameBoot || !(initial || later)) {
          await channel.send(frame(request.message_id, 'credential-result', { status: 'failure', code: withdrawal ? 'CREDENTIAL_WITHDRAWAL_DENIED' : 'CREDENTIAL_DELIVERY_DENIED' }, request.message_id));
          return;
        }
        if (withdrawal) {
          holder!.token = undefined; holder!.withdrawn = true;
          await channel.send(frame(request.message_id, 'credential-result', { status: 'withdrawn' }, request.message_id));
          return;
        }
        const value = 'token' in parsed.data && typeof parsed.data.token === 'string' ? parsed.data.token : '';
        if (!value) {
          await channel.send(frame(request.message_id, 'credential-result', { status: 'failure', code: 'CREDENTIAL_DELIVERY_DENIED' }, request.message_id));
          return;
        }
        // Registered in the SAME owner Records used by this invocation's tool captures before acknowledging/using; no await in between.
        records.registerSecret(value);
        if (holder) holder.token = value;
        else credentials.set(channel, { token: value, invocationId: context.invocationId, withdrawn: false });
        await channel.send(frame(request.message_id, 'credential-result', { status: 'delivered' }, request.message_id));
        return;
      }
      if (request.kind === 'launch-worker') {
        const parsed = workerLaunchSchema.safeParse(request.payload);
        if (!parsed.success || lifetimes.has(channel) || (parsed.data.copyOutput === true &&
            (parsed.data.context.role !== 'builder' || !privateCapabilities.copyOutput ||
             privateCapabilities.profileOrigin !== 'factory-development-gondolin-0.14.0-stdin-capacity-v1'))) {
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'failure', code: 'WORKER_LAUNCH_INVALID' }, request.message_id));
          return;
        }
        const context = Object.freeze({ ...parsed.data.context });
        const credential = credentials.get(channel);
        if (context.workId !== peer.binding.workId || context.environmentRef !== peer.binding.environmentRef ||
            context.bootRef !== peer.binding.bootRef || invocations.has(context.invocationId) ||
            (credential !== undefined && (credential.invocationId !== context.invocationId || context.role !== 'builder'))) {
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, request.message_id));
          return;
        }
        // Technical once-only claim, not an admission ledger. Never remove this
        // tombstone on error/EOF; uncertain startup must not invite replacement.
        invocations.add(context.invocationId);
        const lifetime = new AbortController();
        lifetimes.set(channel, lifetime);
        for (const secret of [...parsed.data.knownSecrets, ...('apiKey' in parsed.data.profile ? [parsed.data.profile.apiKey] : [])]) records.registerSecret(secret);
        const endpoint = join(directory, `b${++sequence}`);
        try {
          await bindings.add({ ...privateCapabilities, copyOutput: parsed.data.copyOutput === true, endpoint, context, signal: lifetime.signal, records,
            ...(credential === undefined ? {} : { credential: Object.freeze({ current: () => credential.token }) }),
            ...(parsed.data.selectedOutputCopies === undefined ? {} : { selectedOutputCopies: parsed.data.selectedOutputCopies }),
            ...(parsed.data.skillPackFiles === undefined ? {} : { skillPackFiles: parsed.data.skillPackFiles }),
            ...(parsed.data.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: parsed.data.editSourceMaxBytes }),
            ...(parsed.data.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: parsed.data.imageSourceMaxBytes }) });
          const worker = await launchWorker(host, { ...parsed.data, context }, endpoint, root, lifetime.signal, {
            // EXACT same Records instance already passed to bindings.add above.
            registerSecret(value) { records.registerSecret(value); },
            revoke() { lifetime.abort(); },
          }, { question: question => new Promise((resolve, reject) => {
            // Relay only: the Control commits Question + impediment + intent, then ACKs. Silence is never treated as recorded.
            const timer = setTimeout(() => { questionAcks.delete(question.questionId); reject(new Error('QUESTION_ACK_TIMEOUT')); }, 30000);
            questionAcks.set(question.questionId, { channel, resolve: ack => { clearTimeout(timer); resolve(ack); }, reject: error => { clearTimeout(timer); reject(error); } });
            channel.send(frame(question.questionId, 'worker-question', { context, question }, request.message_id))
              .catch(() => { questionAcks.get(question.questionId)?.reject(new Error('QUESTION_RELAY_FAILED')); questionAcks.delete(question.questionId); });
          }) }, event => { void channel.send(frame(request.message_id, 'worker-handoff', event as Envelope['payload'], request.message_id)).catch(() => { lifetime.abort(); channel.close(); }); });
          launched.set(channel, { launchId: request.message_id, deliver: typeof worker.deliver === 'function' ? worker.deliver : async () => false });
          await channel.send(frame(request.message_id, 'worker-launch-result', { status: 'requested', worker: context.invocationId }, request.message_id));
          // Request, durable start and completion are distinct observations.
          void (async () => {
            try {
              const started = await worker.started;
              await channel.send(frame(request.message_id, 'worker-started', started, request.message_id));
              let completed = await worker.completed as Envelope['payload'];
              // A reviewer opinion is forwarded only after redaction by THIS owner's Records, which holds every secret of the boot
              // (including a live Builder grant the reviewer process never knew). Failure to redact is a failed completion, never raw text.
              if (completed.status === 'success' && completed.opinion !== undefined) {
                try {
                  const { phaseId: _phase, ...captureContext } = context;
                  const reference = await records.record({ ...captureContext, callId: 'review-opinion-forward' }, { opinion: completed.opinion });
                  const page = await records.read({ reference, offset: 0, limit: 65536 });
                  if (page.state !== 'complete' || page.nextOffset !== page.bytes) throw new Error('PROTECTED_CAPTURE_UNAVAILABLE');
                  completed = { ...completed, opinion: (JSON.parse(page.data.toString('utf8')) as { event: { opinion: Envelope['payload'] } }).event.opinion };
                } catch { completed = { status: 'failure', code: 'OPINION_REDACTION_UNAVAILABLE' }; }
              }
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
      // Context-only registration carries no trusted per-invocation opt-in.
      await bindings.add({ ...privateCapabilities, copyOutput: false, endpoint, context, signal: lifetime.signal, records });
      await channel.send(frame(request.message_id, 'binding-result', { status: 'success', endpoint }, request.message_id));
    },
    closed(_error, _peer, channel) {
      lifetimes.get(channel)?.abort(); credentials.delete(channel); launched.delete(channel);
      for (const [id, pending] of questionAcks) if (pending.channel === channel) { questionAcks.delete(id); pending.reject(new Error('QUESTION_RELAY_CLOSED')); }
    },
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
