import { randomUUID } from 'node:crypto';
import { createRecords } from '../records/index.js';
import { z } from 'zod';
import { readSessionFile, sessionRefSchema, workerLaunchSchema, workerOwnerEndpoint, workerQuestionSchema, type WorkerLaunch } from '../platform/host/index.js';
import { builderToolNames, compareSessionProfile } from './session-ref.js';
import { connect, protocolVersion, type Channel, type Envelope } from '../protocol/index.js';
import type { Invocation } from './worker-start.js';
import type { WorkerIpc } from './worker-process.js';
import { handoffSummarySchema } from './handoff.js';
import { resolvedDeclarationsSchema } from './gates.js';
import { opinionSchema } from './review.js';
import { observeOpinionRecord, type OpinionObservation } from './opinion-observation.js';
export type { OpinionObservation } from './opinion-observation.js';
import { observeQuestionRecord, type QuestionObservation } from './question-observation.js';
export type { QuestionObservation } from './question-observation.js';
import { observeSessionCopyUsage, observeSessionUsage, type SessionUsage, type SessionUsageCache } from './session-usage.js';
export { sessionUsage, type SessionUsage, type SessionUsageEntry } from './session-usage.js';
import type { ReviewOpinion } from '../contracts/index.js';
import type { BuilderDirective, HandoffEvent } from './builder-handoff.js';
export type { ReviewerProfile, Invocation } from './worker-start.js';
export type { BuilderDirective, HandoffEvent } from './builder-handoff.js';
export { builderSkillPack, builderSkillPacks, skillPackContinues, skillPacks, type SkillPackId } from './skill-pack.js';
/** Ticket 13 gate evidence (Host ledger) as a public Worker surface, so Control-level tests can resolve real evidence instead of
 * synthesizing it. Runtime use remains inside the Builder host (`worker-session`). */
export { createToolLedger, declarationsSchema } from './gates.js';
export type { BashObservation, Declarations } from './gates.js';
import { skillPackContinues, skillPackGuestFiles } from './skill-pack.js';
/** Transient material handed to the host handshake, never part of the (serializable) invocation. */
export type ActivationDelivery = { credential?: Readonly<{ token: string }> };
/** `deliver` directives (Q6): a renewed transient Builder credential for NEW commands, or its final withdrawal. Never serialized/persisted. */
export type WorkerDirective = { kind: 'credential'; credential: Readonly<{ token: string }> } | { kind: 'withdraw-credential' } |
  /** Ticket 12: the effective review results to the Builder session suspended at handoff (continuation of the SAME session). */
  BuilderDirective |
  /** v2 ticket 09 (V2-13): the boot of this Builder crossed its rotation margin. The session is NOT interrupted: it yields at its next call
   * boundary (the call in flight returns first) and the activation completes `boot-swap` with its session preserved. */
  { kind: 'boot-swap' };
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
export type { SessionProfile, WorkerSessionRef, SessionObservation } from './session-ref.js';
import type { SessionObservation, WorkerSessionRef } from './session-ref.js';
/** `question`: the activation ended after asking; `acknowledged` says whether the worker saw a `recorded` ACK (lost ACK => false).
 * `session`: the preserved session (Builder), when its owner could observe it; absent = not recorded (never invented). */
export type WorkerCompletion = { status: 'success'; receipt: { workId: string; id: string }; opinion?: ReviewOpinion; session?: WorkerSessionRef } | { status: 'failure'; code: string } |
  { status: 'question'; receipt: { workId: string; id: string }; question: WorkerQuestion & { acknowledged: boolean }; session?: WorkerSessionRef } |
  /** v2 ticket 09 (V2-13): the Builder yielded at a call boundary after a `boot-swap` directive; nothing of its work is concluded. */
  { status: 'boot-swap'; receipt: { workId: string; id: string }; session?: WorkerSessionRef };

/** `profiles` configures a model/profile per role (spec §6.1: explicit per role, may coincide; no silent fallback between roles). */
/** `builderPrompt` (ticket 18): the Builder system prompt of ONE session, chosen from its mode (phase) and the exact tool set the SDK session
 * will have (`builderToolNames`, the same prediction session continuation uses), so a prompt never names a tool its session lacks. A throw
 * refuses the activation before any launch. Absent: the profile's fixed prompt. */
type Configuration = { root: string; profile: WorkerLaunch['profile']; knownSecrets: string[]; profiles?: Partial<Record<'builder' | 'standards' | 'spec', WorkerLaunch['profile']>>;
  builderPrompt?: (session: { phaseId: string; tools: string[] }) => string;
  /** v2 ticket 06: where the owner of a boot listens (the Sandbox's own discovery). Absent: the supervised per-boot owner of the MVP. */
  ownerEndpoint?: (context: WorkerLaunch['context']) => Promise<string> };
export { builderToolNames, compareSessionProfile } from './session-ref.js';
const reference = z.strictObject({ workId: z.string(), id: z.uuid() });
const startSchema = z.strictObject({ receipt: reference, invocation: z.strictObject({ executionId: z.string(), invocationId: z.string() }) });
const completionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), receipt: reference, opinion: opinionSchema.optional(), session: sessionRefSchema.optional() }),
  z.strictObject({ status: z.literal('failure'), code: z.string() }),
  z.strictObject({ status: z.literal('question'), receipt: reference, question: workerQuestionSchema.extend({ acknowledged: z.boolean() }), session: sessionRefSchema.optional() }),
  z.strictObject({ status: z.literal('boot-swap'), receipt: reference, session: sessionRefSchema.optional() }),
]);

// Ticket 13: `closing` (the Host's capture after the session ended) and the Host-resolved `declarations` (treatments, gate evidence).
const handoffExtras = { closing: z.literal(true).optional(), declarations: resolvedDeclarationsSchema.optional() };
/** The protected `worker-start` record (worker-start.ts): its correlation and supplied context, never its process details. */
const startRecordSchema = z.object({ version: z.literal(1), recordedAt: z.iso.datetime(),
  context: z.object({ workId: z.string(), executionId: z.string(), invocationId: z.string(), callId: z.string() }),
  event: z.object({ kind: z.literal('worker-start'), suppliedContext: z.object({ workId: z.string(), executionId: z.string(), invocationId: z.string() }) }) });
/** Ticket 26: what the receipt facet of `observe` established (see `observeStart`). */
export type StartObservation = { kind: 'receipt'; receipt: { workId: string; id: string; executionId: string; invocationId: string }; recordedAt: string } |
  { kind: 'absent'; completeness: 'complete' } | { kind: 'uncertain'; code: string };

const handoffEventSchema = z.union([
  z.strictObject({ round: z.number().int().min(1).max(99), status: z.literal('captured'), summary: handoffSummarySchema, ...handoffExtras }),
  z.strictObject({ round: z.number().int().min(1).max(99), status: z.literal('failure'), code: z.string().regex(/^[A-Z_]{1,64}$/),
    detail: z.string().regex(/^[A-Z_]{1,32}:[a-z-]{1,32}$/).optional(), ...handoffExtras }),
]);

/** Trusted Control caller must have confirmed admission/reservation BEFORE this
 * operation. This Host facade neither grants authority nor runs a caller SDK. */
export function createWorkers(configuration?: Configuration) {
  // Live activations of THIS facade (memory only): the current recipient of `deliver`. Closed/ended channels are removed.
  const live = new Map<string, { channel: Channel; inbox: ReturnType<typeof mailbox>; context: Invocation['context']; launchId: string; handoff: boolean }>();
  // The observe facets (start receipt, ticket 26; opinion, ticket 28) share ONE Records handle, opened lazily (its private-root check runs
  // once); each call is then only a bounded listing and bounded reads. A failed open is retried by the next call.
  let observedRecords: ReturnType<typeof createRecords> | undefined;
  // Ticket 29: hash-verified session usage, read once per unchanged file (bounded).
  const usageCache: SessionUsageCache = new Map();
  const protectedRecords = async (root: string) => {
    observedRecords ??= createRecords({ root });
    try { return await observedRecords; } catch { observedRecords = undefined; return null; }
  };
  return {
    /**
   * Ticket 26 — Q6 `observe`, receipt facet: the complete synchronized start receipt the worker host wrote in the protected Records BEFORE any
   * model/tool, discovered without its notification and without rerunning anything. Exactly one complete, intact, correlated receipt is a
   * start; a complete listing with none is absence; partial/corrupt/multiple/unreadable evidence is uncertain (never absence). Not cessation.
   */
  async observeStart(input: { workId: string; executionId: string; invocationId: string }): Promise<StartObservation> {
    if (!configuration) return { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' };
    const records = await protectedRecords(configuration.root);
    if (!records) return { kind: 'uncertain', code: 'RECORDS_UNAVAILABLE' };
    const found = await records.find({ workId: input.workId, executionId: input.executionId, invocationId: input.invocationId, callId: 'worker-start' }).catch(() => null);
    if (!found || found.completeness !== 'complete') return { kind: 'uncertain', code: 'START_RECEIPT_LISTING_INCOMPLETE' };
    if (found.captures.length === 0) return { kind: 'absent', completeness: 'complete' };
    if (found.captures.length > 1) return { kind: 'uncertain', code: 'START_RECEIPT_MULTIPLE' };
    const capture = found.captures[0]!;
    if (capture.state !== 'complete') return { kind: 'uncertain', code: 'START_RECEIPT_INCOMPLETE' };
    try {
      const page = await records.read({ reference: capture.reference, offset: 0, limit: 65536 });
      if (page.state !== 'complete' || page.nextOffset !== page.bytes) return { kind: 'uncertain', code: 'START_RECEIPT_INCOMPLETE' };
      const parsed = startRecordSchema.parse(JSON.parse(page.data.toString('utf8')));
      const supplied = parsed.event.suppliedContext;
      if (parsed.context.callId !== 'worker-start' || supplied.workId !== input.workId || supplied.executionId !== input.executionId ||
          supplied.invocationId !== input.invocationId) return { kind: 'uncertain', code: 'START_RECEIPT_MISMATCH' };
      return { kind: 'receipt', receipt: { workId: input.workId, id: capture.reference.id, executionId: input.executionId, invocationId: input.invocationId }, recordedAt: parsed.recordedAt };
    } catch { return { kind: 'uncertain', code: 'START_RECEIPT_INVALID' }; }
  },
    /**
     * Ticket 28 — Q6 `observe`, opinion facet: the complete opinion a reviewer invocation preserved in the protected Records before its
     * notification, located without that notification and without rerunning the reviewer. Read-only; never proof of cessation.
     */
    async observeOpinion(input: { workId: string; executionId: string; invocationId: string }): Promise<OpinionObservation> {
      if (!configuration) return { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' };
      const records = await protectedRecords(configuration.root);
      if (!records) return { kind: 'uncertain', code: 'RECORDS_UNAVAILABLE' };
      return observeOpinionRecord(records, input);
    },
    /**
     * Ticket 27 — Q6 `observe`, question facet: the complete `ask_user` request a Builder invocation preserved in the protected Records BEFORE
     * notifying the Control, located when that notification or its ACK was lost (controller crash). Read-only; never proof of cessation.
     */
    async observeQuestion(input: { workId: string; executionId: string; invocationId: string }): Promise<QuestionObservation> {
      if (!configuration) return { kind: 'uncertain', code: 'WORKER_EXECUTION_NOT_ENABLED' };
      const records = await protectedRecords(configuration.root);
      if (!records) return { kind: 'uncertain', code: 'RECORDS_UNAVAILABLE' };
      return observeQuestionRecord(records, input);
    },
    /** Ticket 29 — Q6 `observe`, usage facet: model usage of one preserved session, read-only and confined (never an invoice). */
    async observeUsage(input: { workId: string; boot: string | null; session: { ref: string; sha256: string } | { file: string } | { copy: { workId: string; name: string; sha256: string } } }): Promise<SessionUsage> {
      if (!configuration) return { state: 'unavailable', code: 'WORKER_EXECUTION_NOT_ENABLED' };
      // Ticket 30: a Records session copy of THIS Work only.
      if ('copy' in input.session) return input.session.copy.workId === input.workId ? observeSessionCopyUsage(configuration.root, input.session.copy).catch(() => ({ state: 'unavailable' as const, code: 'SESSION_USAGE_UNREADABLE' }))
        : { state: 'unavailable', code: 'SESSION_COPY_NOT_OF_WORK' };
      try { return await observeSessionUsage(configuration.root, input.session, input.boot, usageCache); } catch { return { state: 'unavailable', code: 'SESSION_USAGE_UNREADABLE' }; }
    },
    /**
     * Q6 `observe` (ticket 11): whether the preserved session of an ended Builder invocation can be CONTINUED by the planned next Builder
     * activation — present, intact (same hash/identity) and with the same SDK profile, provider/model, pack and tool set. Read-only and
     * confined to the installation's private runtime tree; it never adopts a process or proves what the SDK consumed.
     */
    async observe(input: { workId: string; executionId: string; invocationId: string; session: WorkerSessionRef;
      next: Pick<Invocation, 'skillPack' | 'copyOutput' | 'editSourceMaxBytes'> & { handoff: boolean } }): Promise<{ session: SessionObservation; limitations: string[] }> {
      const limitations = ['Session availability and compatibility only; the SDK may still refuse it, and delivery of a continuation is not proof of consumption.'];
      if (!configuration) return { session: { state: 'unavailable', code: 'WORKER_EXECUTION_NOT_ENABLED', differences: [] }, limitations };
      const recorded = sessionRefSchema.safeParse(input.session);
      if (!recorded.success) return { session: { state: 'unavailable', code: 'SESSION_REF_INVALID', differences: [] }, limitations };
      // The PACK defines the continue protocol (manifest capability); an older pack, or no pack, cannot continue a session.
      if (!input.next.skillPack || !(await skillPackContinues(input.next.skillPack))) {
        return { session: { state: 'incompatible', code: 'SESSION_CONTINUATION_UNSUPPORTED', differences: ['continuation'] }, limitations };
      }
      const read = await readSessionFile(configuration.root, recorded.data.ref);
      if (read.state === 'lost') return { session: { state: 'lost', code: read.code, differences: [] }, limitations };
      if (read.state !== 'read') return { session: { state: read.state === 'unsafe' ? 'unavailable' : 'altered', code: read.code, differences: [] }, limitations };
      if (read.sha256 !== recorded.data.sha256 || read.sessionId !== recorded.data.sessionId || read.data.length !== recorded.data.bytes) {
        return { session: { state: 'altered', code: 'SESSION_HASH_MISMATCH', differences: [] }, limitations };
      }
      const profile = configuration.profiles?.builder ?? configuration.profile;
      const differences = compareSessionProfile(recorded.data.profile, { sdkProfile: profile.id, providerId: profile.providerId, modelId: profile.modelId,
        skillPack: input.next.skillPack ?? null, tools: builderToolNames(input.next) });
      if (differences.length) return { session: { state: 'incompatible', code: 'SESSION_PROFILE_CHANGED', differences }, limitations };
      return { session: { state: 'compatible', session: recorded.data }, limitations };
    }, async deliver(worker: string, directive: WorkerDirective): Promise<DeliveryResult> {
  const entry = live.get(worker);
  if (!entry || entry.inbox.ended) return { status: 'failure', code: 'WORKER_NOT_CURRENT' };
  if (directive.kind === 'review-results' || directive.kind === 'boot-swap') {
    // Review results only to a Builder launched with a handoff policy; delivery is not proof of consumption by the SDK.
    if (entry.context.role !== 'builder' || (directive.kind === 'review-results' && !entry.handoff)) return { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' };
    const deliveryId = randomUUID();
    entry.inbox.expect(deliveryId);
    try {
      await entry.channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: deliveryId, reply_to: entry.launchId,
        kind: 'deliver-directive', payload: { directive: directive.kind === 'boot-swap' ? { kind: directive.kind }
          : { kind: directive.kind, round: directive.round, prompt: directive.prompt, ...(directive.end ? { end: true } : {}),
            ...(directive.findings ? { findings: { standards: [...directive.findings.standards], spec: [...directive.findings.spec] } } : {}) } } });
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
    const baseProfile = roleProfile ?? configuration.profile;
    const profile = invocation.context.role === 'builder' && configuration.builderPrompt ? { ...baseProfile, systemPrompt: configuration.builderPrompt({ phaseId: invocation.context.phaseId,
      tools: builderToolNames({ skillPack: invocation.skillPack, copyOutput: invocation.copyOutput, editSourceMaxBytes: invocation.editSourceMaxBytes, handoff: invocation.handoff !== undefined }) }) }
      : baseProfile;
    const request = workerLaunchSchema.safeParse({ context: invocation.context, prompt: invocation.prompt,
      ...(invocation.copyOutput === undefined ? {} : { copyOutput: invocation.copyOutput }),
      ...(invocation.selectedOutputCopies === undefined ? {} : { selectedOutputCopies: invocation.selectedOutputCopies }),
      ...(invocation.skillPack === undefined ? {} : { skillPack: invocation.skillPack }),
      // The Host (not the worker or model) derives the exact readable pack paths from the verified manifest of THIS version.
      ...(invocation.skillPack === undefined || invocation.context.role !== 'builder' ? {} : { skillPackFiles: await skillPackGuestFiles(invocation.skillPack) }),
      ...(invocation.modelBudget === undefined ? {} : { modelBudget: invocation.modelBudget }),
      ...(invocation.builderBudget === undefined ? {} : { builderBudget: { ...invocation.builderBudget } }), ...(invocation.deadlineMs === undefined ? {} : { deadlineMs: invocation.deadlineMs }),
      ...(invocation.secretAckTimeoutMs === undefined ? {} : { secretAckTimeoutMs: invocation.secretAckTimeoutMs }),
      ...(invocation.imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes: invocation.imageSourceMaxBytes }),
      ...(invocation.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: invocation.editSourceMaxBytes }),
      ...(invocation.handoff === undefined ? {} : { handoff: invocation.handoff }),
      ...(invocation.review === undefined ? {} : { review: invocation.review }),
      ...(invocation.pushPolicy === undefined ? {} : { pushPolicy: invocation.pushPolicy }),
      // Ticket 11: continue the preserved session (Builder only; the owner re-checks identity/hash before copying it for the new worker).
      ...(invocation.continuation === undefined ? {} : { continueSession: { ref: invocation.continuation.session.ref, sha256: invocation.continuation.session.sha256,
        sessionId: invocation.continuation.session.sessionId, bytes: invocation.continuation.session.bytes } }),
      profile, knownSecrets: configuration.knownSecrets });
    if (!request.success || invocation.signal.aborted) throw new Error('WORKER_LAUNCH_INVALID');
    if (delivery?.credential !== undefined && (request.data.context.role !== 'builder' || typeof delivery.credential.token !== 'string')) throw new Error('WORKER_LAUNCH_INVALID');
    const context = request.data.context;
    const { imageSourceMaxBytes, editSourceMaxBytes, copyOutput, selectedOutputCopies, skillPack, skillPackFiles, modelBudget, builderBudget, deadlineMs, secretAckTimeoutMs, handoff, review, continueSession, pushPolicy, ...baseRequest } = request.data;
    const payload = { ...baseRequest, ...(handoff === undefined ? {} : { handoff: { baseCommit: handoff.baseCommit, ...(handoff.rounds ? { rounds: { first: handoff.rounds.first, max: handoff.rounds.max, ...(handoff.rounds.delivered?.length ? { delivered: handoff.rounds.delivered.map(item => ({ round: item.round, standards: [...item.standards], spec: [...item.spec] })) } : {}) } } : {}), ...(handoff.preserve ? { preserve: handoff.preserve } : {}) } }),
      ...(review === undefined ? {} : { review: { round: review.round, attempt: review.attempt, handoffIndexSha256: review.handoffIndexSha256,
        required: [...review.required], missing: [...review.missing], ...(review.continueFrom === undefined ? {} : { continueFrom: review.continueFrom }) } }), ...(skillPack === undefined ? {} : { skillPack }), ...(skillPackFiles === undefined ? {} : { skillPackFiles: [...skillPackFiles] }), ...(modelBudget === undefined ? {} : { modelBudget }), ...(builderBudget === undefined ? {} : { builderBudget: { ...builderBudget } }), ...(deadlineMs === undefined ? {} : { deadlineMs }), ...(secretAckTimeoutMs === undefined ? {} : { secretAckTimeoutMs }), ...(selectedOutputCopies === undefined ? {} : { selectedOutputCopies: [...selectedOutputCopies] }), ...(copyOutput === undefined ? {} : { copyOutput }), ...(imageSourceMaxBytes === undefined ? {} : { imageSourceMaxBytes }),
      ...(editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes }), ...(continueSession === undefined ? {} : { continueSession: { ...continueSession } }),
      ...(pushPolicy === undefined ? {} : { pushPolicy: { branch: pushPolicy.branch, expected: pushPolicy.expected, head: pushPolicy.head, ...(pushPolicy.remote === undefined ? {} : { remote: pushPolicy.remote }), ...(pushPolicy.wip ? { wip: true as const } : {}) } }) };
    const endpoint = await (configuration.ownerEndpoint ? configuration.ownerEndpoint(context) : workerOwnerEndpoint(configuration.root, context));
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
              // A preserved session is the Builder's only, under this installation's runtime tree (checked again by observe before any use).
              if (parsed.status !== 'failure' && parsed.session && context.role !== 'builder') throw new Error('WORKER_EXECUTION_UNCERTAIN');
              if (parsed.status === 'boot-swap' && context.role !== 'builder') throw new Error('WORKER_EXECUTION_UNCERTAIN');
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
