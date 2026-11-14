import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workerLaunchSchema, workerOwnerEndpoint, workerQuestionSchema, type WorkerLaunch } from '../platform/host/index.js';
import { connect, protocolVersion, type Channel, type Envelope } from '../protocol/index.js';
import type { Invocation } from './worker-start.js';
import type { WorkerIpc } from './worker-process.js';
import { handoffSummarySchema } from './handoff.js';
import { opinionSchema } from './review.js';
import type { ReviewOpinion } from '../contracts/index.js';
import type { BuilderDirective, HandoffEvent } from './builder-handoff.js';
export type { ReviewerProfile, Invocation } from './worker-start.js';
export type { BuilderDirective, HandoffEvent } from './builder-handoff.js';
export { builderSkillPack, builderSkillPacks, skillPacks, type SkillPackId } from './skill-pack.js';
import { skillPackGuestFiles } from './skill-pack.js';
/** Transient material handed to the host handshake, never part of the (serializable) invocation. */
export type ActivationDelivery = { credential?: Readonly<{ token: string }> };
/** `deliver` directives (Q6): a renewed transient Builder credential for NEW commands, or its final withdrawal. Never serialized/persisted. */
export type WorkerDirective = { kind: 'credential'; credential: Readonly<{ token: string }> } | { kind: 'withdraw-credential' } |
  /** Ticket 12: the effective review results to the Builder session suspended at handoff (continuation of the SAME session). */
  BuilderDirective;
/** Delivery is not proof of consumption by the SDK/tools; failure codes never carry the secret. */
export type DeliveryResult = { status: 'delivered' | 'withdrawn' } | { status: 'failure'; code: string };

/**
 * Demultiplexes one host channel: each waiter receives the next frame it matches, so a credential reply never consumes a start frame.
 * Only replies to requests this facade sent (`expect`) are accepted; any other frame makes the whole channel uncertain (every waiter ends),
 * exactly as an unexpected frame did before demultiplexing.
 */
function mailbox(channel: Channel) {
  const iterator = channel.messages[Symbol.asyncIterator]();
  const buffered: Envelope[] = [];
  const expected = new Set<string>();
  const waiters: { match(message: Envelope): boolean; resolve(message: Envelope | undefined): void }[] = [];
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.reply_to === null || !expected.has(next.value.reply_to)) break; // unexpected/unmatched: uncertain
        const index = waiters.findIndex(waiter => waiter.match(next.value));
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve(next.value); else buffered.push(next.value);
      }
    } catch { /* channel failure ends every waiter below */ }
    ended = true;
    buffered.length = 0;
    for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
  })();
  return {
    get ended() { return ended; },
    expect(id: string) { expected.add(id); },
    release(id: string) { expected.delete(id); },
    next(match: (message: Envelope) => boolean, timeoutMs?: number): Promise<Envelope | undefined> {
      const index = buffered.findIndex(match);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      if (ended) return Promise.resolve(undefined);
      return new Promise(resolve => {
        const waiter = { match, resolve: (message: Envelope | undefined) => { if (timer) clearTimeout(timer); resolve(message); } };
        const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          resolve(undefined);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}
/**
 * `ask_user` request of a Builder (spec §5.5): identity assigned by the worker, complete text and its hash, and the reference of the
 * protected Records evidence that preserved it BEFORE the notification. Not authorization; the Control validates and correlates it.
 */
export type WorkerQuestion = { questionId: string; question: string; context: string; sha256: string; reference: { workId: string; id: string } };
/** Control's answer to a notification: `recorded` only after the durable commit of Question + impediment + publication intent. */
export type QuestionAck = { status: 'recorded' } | { status: 'refused'; code: string };
/** Host-side handlers of worker events during one activation (no Promise waits for a human: the handler only commits). */
export type ActivationEvents = { question?(question: WorkerQuestion): Promise<QuestionAck> };
/** `question`: the activation ended after asking; `acknowledged` says whether the worker saw a `recorded` ACK (lost ACK => false). */
export type WorkerCompletion = { status: 'success'; receipt: { workId: string; id: string }; opinion?: ReviewOpinion } | { status: 'failure'; code: string } |
  { status: 'question'; receipt: { workId: string; id: string }; question: WorkerQuestion & { acknowledged: boolean } };

/** `profiles` configures a model/profile per role (spec §6.1: explicit per role, may coincide; no silent fallback between roles). */
type Configuration = { root: string; profile: WorkerLaunch['profile']; knownSecrets: string[]; profiles?: Partial<Record<'builder' | 'standards' | 'spec', WorkerLaunch['profile']>> };
const reference = z.strictObject({ workId: z.string(), id: z.uuid() });
const startSchema = z.strictObject({ receipt: reference, invocation: z.strictObject({ executionId: z.string(), invocationId: z.string() }) });
const completionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), receipt: reference, opinion: opinionSchema.optional() }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
  z.strictObject({ status: z.literal('question'), receipt: reference, question: workerQuestionSchema.extend({ acknowledged: z.boolean() }) }),
]);

const handoffEventSchema = z.union([
  z.strictObject({ round: z.number().int().min(1).max(99), status: z.literal('captured'), summary: handoffSummarySchema }),
  z.strictObject({ round: z.number().int().min(1).max(99), status: z.literal('failure'), code: z.string().regex(/^[A-Z_]{1,64}$/),
    detail: z.string().regex(/^[A-Z_]{1,32}:[a-z-]{1,32}$/).optional() }),
]);

/** Trusted Control caller must have confirmed admission/reservation BEFORE this
 * operation. This Host facade neither grants authority nor runs a caller SDK. */
export function createWorkers(configuration?: Configuration) {
  // Live activations of THIS facade (memory only): the current recipient of `deliver`. Closed/ended channels are removed.
  const live = new Map<string, { channel: Channel; inbox: ReturnType<typeof mailbox>; context: Invocation['context']; launchId: string; handoff: boolean }>();
  return { async deliver(worker: string, directive: WorkerDirective): Promise<DeliveryResult> {
    const entry = live.get(worker);
    if (!entry || entry.inbox.ended) return { status: 'failure', code: 'WORKER_NOT_CURRENT' };
    if (directive.kind === 'review-results') {
      // Only to a Builder launched with a handoff policy; delivery is not proof of consumption by the SDK.
      if (entry.context.role !== 'builder' || !entry.handoff) return { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' };
      const deliveryId = randomUUID();
      entry.inbox.expect(deliveryId);
      try {
        await entry.channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: deliveryId, reply_to: entry.launchId,
          kind: 'deliver-directive', payload: { directive: { kind: directive.kind, round: directive.round, prompt: directive.prompt } } });
      } catch { entry.inbox.release(deliveryId); return { status: 'failure', code: 'DELIVERY_UNCONFIRMED' }; }
      const reply = await entry.inbox.next(message => message.reply_to === deliveryId, 15000);
      entry.inbox.release(deliveryId);
      if (!reply) return { status: 'failure', code: 'DELIVERY_UNCONFIRMED' };
      if (reply.kind !== 'delivery-result' || JSON.stringify(reply.payload) !== '{"status":"delivered"}') return { status: 'failure', code: 'DELIVERY_DENIED' };
      return { status: 'delivered' };
    }
    // Reviewers never receive the Builder's secret environment (spec §8: handoff does not deliver it).
    if (entry.context.role !== 'builder') return { status: 'failure', code: 'CREDENTIAL_ROLE_DENIED' };
    if (directive.kind === 'credential' && (typeof directive.credential?.token !== 'string' || !directive.credential.token)) return { status: 'failure', code: 'WORKER_DIRECTIVE_INVALID' };
    const id = randomUUID();
    entry.inbox.expect(id);
    try {
      await entry.channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null, kind: directive.kind === 'credential' ? 'deliver-credential' : 'withdraw-credential',
        payload: directive.kind === 'credential' ? { context: entry.context, token: directive.credential.token } : { context: entry.context } });
    } catch { return { status: 'failure', code: 'CREDENTIAL_DELIVERY_UNCERTAIN' }; }
    const reply = await entry.inbox.next(message => message.reply_to === id, 15000);
    entry.inbox.release(id); // a late reply after a timeout is unexpected: the channel becomes uncertain
    const expected = directive.kind === 'credential' ? '{"status":"delivered"}' : '{"status":"withdrawn"}';
    if (!reply) return { status: 'failure', code: 'CREDENTIAL_DELIVERY_UNCERTAIN' };
    if (reply.kind !== 'credential-result' || JSON.stringify(reply.payload) !== expected) return { status: 'failure', code: directive.kind === 'credential' ? 'CREDENTIAL_DELIVERY_DENIED' : 'CREDENTIAL_WITHDRAWAL_DENIED' };
    return { status: directive.kind === 'credential' ? 'delivered' : 'withdrawn' };
  }, async activate(invocation: Invocation, delivery?: ActivationDelivery, events?: ActivationEvents) {
    if (!configuration) throw new Error('WORKER_EXECUTION_NOT_ENABLED');
    // Spec §6.1: provider/model explicit PER ROLE, no silent fallback. With per-role profiles every role must be listed; a ticket-12
    // reviewer (review input) always needs its own entry. Only legacy single-profile compositions keep using `profile`.
    const roleProfile = configuration.profiles?.[invocation.context.role];
    if ((configuration.profiles !== undefined || invocation.review !== undefined) && !roleProfile) throw new Error('WORKER_PROFILE_NOT_CONFIGURED');
    const request = workerLaunchSchema.safeParse({ context: invocation.context, prompt: invocation.prompt,
      ...(invocation.copyOutput === undefined ? {} : { copyOutput: invocation.copyOutput }),
      ...(invocation.selectedOutputCopies === undefined ? {} : { selectedOutputCopies: invocation.selectedOutputCopies }),
      ...(invocation.skillPack === undefined ? {} : { skillPack: invocation.skillPack }),
      // The Host (not the worker or model) derives the exact readable pack paths from the verified manifest of THIS version.
      ...(invocation.skillPack === undefined || invocation.context.role !== 'builder' ? {} : { skillPackFiles: await skillPackGuestFiles(invocation.skillPack) }),
      ...(invocation.modelBudget === undefined ? {} : { modelBudget: invocation.modelBudget }), ...(invocation.deadlineMs === undefined ? {} : { deadlineMs: invocation.deadlineMs }),
      ...(invocation.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: invocation.imageSourceMaxBytes }),
      ...(invocation.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: invocation.editSourceMaxBytes }),
      ...(invocation.handoff === undefined ? {} : { handoff: invocation.handoff }),
      ...(invocation.review === undefined ? {} : { review: invocation.review }),
      profile: roleProfile ?? configuration.profile, knownSecrets: configuration.knownSecrets });
    if (!request.success || invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
    if (delivery?.credential !== undefined && (request.data.context.role !== 'builder' || typeof delivery.credential.token !== 'string')) throw new Error('WORKER_LAUNCH_INVALID');
    const context = request.data.context;
    const { imageSourceMaxBytes, editSourceMaxBytes, copyOutput, selectedOutputCopies, skillPack, skillPackFiles, modelBudget, deadlineMs, handoff, review, ...baseRequest } = request.data;
    const payload = { ...baseRequest, ...(handoff === undefined ? {} : { handoff: { ...handoff } }),
      ...(review === undefined ? {} : { review: { ...review, required: [...review.required], missing: [...review.missing] } }), ...(skillPack === undefined ? {} : { skillPack }), ...(skillPackFiles === undefined ? {} : { skillPackFiles: [...skillPackFiles] }), ...(modelBudget === undefined ? {} : { modelBudget }), ...(deadlineMs === undefined ? {} : { deadlineMs }), ...(selectedOutputCopies === undefined ? {} : { selectedOutputCopies: [...selectedOutputCopies] }), ...(copyOutput === undefined ? {} : { copyOutput }), ...(imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes }),
      ...(editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes }) };
    const endpoint = await workerOwnerEndpoint(configuration.root, context);
    const channel = await connect(endpoint, { kind: 'host-boot', binding: { workId: context.workId,
      environmentRef: context.environmentRef, bootRef: context.bootRef } });
    const close = () => { if (live.get(context.invocationId)?.channel === channel) live.delete(context.invocationId); channel.close(); };
    invocation.signal.addEventListener('abort', close, { once: true });
    try {
      if (invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
      const inbox = mailbox(channel);
      if (delivery?.credential !== undefined) {
        // Host handshake (spec §8.1): the credential reaches the owner's tool path BEFORE the worker exists; it is never in the launch payload.
        const credentialId = randomUUID();
        inbox.expect(credentialId);
        await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: credentialId, reply_to: null,
          kind: 'deliver-credential', payload: { context, token: delivery.credential.token } });
        const reply = await inbox.next(message => message.reply_to === credentialId);
        inbox.release(credentialId);
        if (!reply || reply.kind !== 'credential-result' || JSON.stringify(reply.payload) !== '{"status":"delivered"}') throw new Error('CREDENTIAL_DELIVERY_FAILED');
      }
      const id = randomUUID();
      inbox.expect(id);
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null,
        kind: 'launch-worker', payload });
      const receive = async (kind: string) => {
        const response = await inbox.next(message => message.reply_to === id);
        if (!response || response.kind !== kind || response.message_id !== id || response.controller_run_id !== null) throw new Error('WORKER_EXECUTION_UNCERTAIN');
        return response.payload;
      };
      const acknowledgement = z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('requested'), worker: z.string() }),
        z.strictObject({ status: z.literal('failure'), code: z.enum(['WORKER_LAUNCH_INVALID', 'STALE_TOOL_CONTEXT', 'WORKER_LAUNCH_UNCERTAIN']) }),
      ]).parse(await receive('worker-launch-result'));
      if (acknowledgement.status === 'failure') throw new Error(acknowledgement.code);
      if (acknowledgement.worker !== context.invocationId) throw new Error('WORKER_EXECUTION_UNCERTAIN');
      live.set(acknowledgement.worker, { channel, inbox, context, launchId: id, handoff: context.role === 'builder' && invocation.handoff !== undefined });
      // Ticket 12: handoff notices of a suspended Builder (frames of this launch), consumed in order by `handoffs.next()`.
      const handoffs: HandoffEvent[] = [];
      let waiting: ((event: HandoffEvent | null) => void) | undefined;
      let finished = false;
      const endHandoffs = () => { finished = true; waiting?.(null); waiting = undefined; };
      // One ordered pump: start receipt, then at most one ask_user notification (answered with the Control's ACK), then completion.
      let startedResolve!: (value: z.infer<typeof startSchema>) => void, startedReject!: (error: unknown) => void;
      let completedResolve!: (value: z.infer<typeof completionSchema>) => void, completedReject!: (error: unknown) => void;
      const started = new Promise<z.infer<typeof startSchema>>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
      const completed = new Promise<z.infer<typeof completionSchema>>((resolve, reject) => { completedResolve = resolve; completedReject = reject; });
      void started.catch(() => {}); void completed.catch(() => {});
      const questionSchema = z.strictObject({ context: z.record(z.string(), z.string()), question: workerQuestionSchema });
      void (async () => {
        let start: z.infer<typeof startSchema> | undefined;
        let asked = false;
        try {
          while (true) {
            // Frames of this launch (start, ask_user notification, completion) share its reply_to; deliver replies have their own.
            const message = await inbox.next(frame => frame.reply_to === id);
            if (!message || message.controller_run_id !== null) throw new Error('WORKER_EXECUTION_UNCERTAIN');
            if (message.kind === 'worker-question') {
              const parsed = questionSchema.safeParse(message.payload);
              if (!start || asked || !parsed.success || message.message_id !== parsed.data.question.questionId || context.role !== 'builder' ||
                  Object.keys(parsed.data.context).length !== Object.keys(context).length || Object.entries(context).some(([key, value]) => parsed.data.context[key] !== value) || parsed.data.question.reference.workId !== context.workId) throw new Error('WORKER_EXECUTION_UNCERTAIN');
              asked = true;
              // No ACK unless the handler confirms: a failed commit leaves the worker unacknowledged (it ends; the completion repeats it).
              const ack = events?.question ? await events.question(parsed.data.question).catch(() => undefined) : { status: 'refused' as const, code: 'QUESTIONS_NOT_ENABLED' };
              if (ack) await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: randomUUID(), reply_to: message.message_id,
                kind: 'question-ack', payload: ack.status === 'recorded' ? { status: 'recorded' } : { status: 'refused', code: ack.code } });
              continue;
            }
            if (message.message_id !== id) throw new Error('WORKER_EXECUTION_UNCERTAIN');
            if (message.kind === 'worker-handoff' && start && context.role === 'builder' && invocation.handoff) {
              const event = handoffEventSchema.parse(message.payload) as HandoffEvent;
              if (waiting) { const resolve = waiting; waiting = undefined; resolve(event); } else handoffs.push(event);
              continue;
            }
            if (message.kind === 'worker-started' && !start) {
              const parsed = startSchema.parse(message.payload);
              if (parsed.receipt.workId !== context.workId || parsed.invocation.executionId !== context.executionId ||
                  parsed.invocation.invocationId !== context.invocationId) throw new Error('WORKER_EXECUTION_UNCERTAIN');
              start = parsed;
              startedResolve(parsed);
              continue;
            }
            if (message.kind === 'worker-completed' && start) {
              const parsed = completionSchema.parse(message.payload);
              if (parsed.status === 'question' && (context.role !== 'builder' || parsed.question.reference.workId !== context.workId)) throw new Error('WORKER_EXECUTION_UNCERTAIN');
              // A reviewer opinion must be THIS invocation's, of its role and round; a Builder never returns one.
              if (parsed.status === 'success' && parsed.opinion && (context.role === 'builder' || parsed.opinion.role !== context.role ||
                  parsed.opinion.invocationId !== context.invocationId || parsed.opinion.round !== invocation.review?.round)) throw new Error('WORKER_EXECUTION_UNCERTAIN');
              completedResolve(parsed as WorkerCompletion);
              endHandoffs();
              return;
            }
            throw new Error('WORKER_EXECUTION_UNCERTAIN');
          }
        } catch (error) { startedReject(error); completedReject(error); endHandoffs(); }
      })();
      return { worker: acknowledgement.worker, started, completed: completed as Promise<WorkerCompletion>,
        /** Next handoff of this Builder, or null once the worker completed (or the channel failed). */
        handoffs: { next(): Promise<HandoffEvent | null> {
          if (handoffs.length) return Promise.resolve(handoffs.shift()!);
          if (finished) return Promise.resolve(null);
          return new Promise(resolve => { waiting = resolve; });
        } },
        close() {
        invocation.signal.removeEventListener('abort', close); close();
      } };
    } catch (error) { invocation.signal.removeEventListener('abort', close); close(); throw error; }
  } };
}

/** Technical fixed-entrypoint composition only; not Control authorization. */
export async function runWorkerProcess(bootstrap: unknown, signal: AbortSignal, ipc?: WorkerIpc) {
  const { run } = await import('./worker-process.js');
  return run(bootstrap, signal, ipc);
}

// Narrow standalone installation prerequisite; no arbitrary auth routing/CRUD.
export { firstFactoryOAuthLogin } from './factory-oauth.js';
