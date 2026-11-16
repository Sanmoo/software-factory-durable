// Execution boundary doubles for ticket 26 (recovery). Control, Pi Durable/SQLite, Records and the Workers receipt facet (`observeStart`) are
// REAL; the Sandbox host (boots, stop, observe) is a file-backed double so a surviving "boot" outlives a SIGKILLed controller process exactly
// like a systemd unit does, and the Builder is scripted. Not evidence of a VM, systemd, worker process, model or GitHub.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ProposalHandoff, ReviewOpinion } from '../../src/contracts/index.js';
import type { ExecutionPorts } from '../../src/control/types.js';
import { createRecords } from '../../src/records/index.js';
import { createWorkers, type Invocation, type WorkerQuestion } from '../../src/workers/index.js';

export type HostState = { prepared: string[]; current: Record<string, string | null>; boots: Record<string, 'active' | 'stopped'>;
  /** Boots whose host stop never confirms cessation (unit stuck, observation unavailable). */
  stuck: string[];
  /** When true, a confirmed stop reports a FORCED termination (grace period expired). */
  forced?: boolean; log: { kind: string; detail?: unknown }[]; calendarOffsetMs: number };
/** Builder behaviour per activation: the receipt is written to the protected Records BEFORE the start notification (like the worker host). */
export type RecoveryScript = { kind: 'complete' } | { kind: 'hang' } | { kind: 'fail'; code: string } |
  /** Receipt written, notification lost: `started` never resolves (the worker keeps running until its boot stops). */
  { kind: 'lose-notification' } |
  /** Activation requested, the worker never wrote its receipt (dies/hangs before it). */
  { kind: 'no-receipt' } |
  { kind: 'ask'; questionId: string; question: string; hangAfterAck?: boolean } |
  /** Ticket 27: the worker PRESERVES its complete ask_user request in Records (same record as worker-session) and then never notifies the
   * Control (it dies with the controller): the notification and its ACK are lost. `partial` leaves the record unfinished (content lost). */
  { kind: 'ask-preserved'; questionId: string; question: string; context?: string; partial?: boolean;
    /** The start notification is lost too (receipt written): an administrative stop then reconciles it before any start is confirmed. */
    loseNotification?: boolean;
    /** The worker DOES notify, with a request the Control refuses (hash mismatch): the live refusal must stand at boot. */
    notifyInvalid?: boolean } |
  /** Hands off ONE captured round to the Factory reviewers (who then run until their boot stops), then waits. */
  { kind: 'handoff' };

const handoffSummary = (): ProposalHandoff => ({ version: 1, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'e'.repeat(64),
  head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40), mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: { committed: { path: '/artifacts/review/r1/committed.patch', bytes: 10, sha256: 'c'.repeat(64) }, staged: { path: '/artifacts/review/r1/staged.patch', bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 0, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/a.ts'], changedTruncated: false });
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');

export function hostFile(dir: string) { return join(dir, 'host.json'); }
export function readHost(dir: string): HostState {
  try { return JSON.parse(readFileSync(hostFile(dir), 'utf8')) as HostState; }
  catch { return { prepared: [], current: {}, boots: {}, stuck: [], log: [], calendarOffsetMs: 0 }; }
}
function writeHost(dir: string, state: HostState) {
  const temporary = `${hostFile(dir)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, hostFile(dir));
}
export function updateHost(dir: string, change: (state: HostState) => void) { const state = readHost(dir); change(state); writeHost(dir, state); }

/** Ticket 28 reviewer behaviour on the shared boot: `lost` = Standards preserves its complete opinion in Records then its notification is lost
 * (it runs until the boot stops), Spec just runs; `retry` = Spec fails at once (completion observed) and its retry waits; `complete` = both
 * reviewers preserve and notify a clean opinion. The handoff captures a content identity so a recovery capture can match it. */
export type Review28 = 'lost' | 'retry' | 'complete';
export function recoveryDoubles(dir: string, scripts: RecoveryScript[], options: { capacity?: number; observe?: boolean; observeStart?: boolean; reviews?: boolean; review28?: Review28;
  onPrepare?: () => Promise<void>; onActivate?: (invocation: Invocation) => void | Promise<void>;
  /** Ticket 24: the Builder script chosen by the activation itself (e.g. per Work); `undefined` falls back to the ordered `scripts`. */
  script?: (invocation: Invocation) => RecoveryScript | undefined } = {}) {
  const prompts: { executionId: string; phaseId: string; prompt: string }[] = [];
  const log = (kind: string, detail?: unknown) => updateHost(dir, state => { state.log.push({ kind, ...(detail === undefined ? {} : { detail }) }); });
  const finishers: (() => void)[] = [];
  // Ticket 24: the same finishers by Execution, independent of the (concurrent) activation order.
  const byExecution = new Map<string, () => void>();
  // The REAL Workers facade, used only for its Records receipt facet (no activation through it).
  const workers = createWorkers({ root: dir, knownSecrets: [], profile: {} as never });
  const interruptible = <T>(signal: AbortSignal, value: Promise<T>) => {
    const result = new Promise<T>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('WORKER_EXECUTION_UNCERTAIN')), { once: true });
      value.then(resolve, reject);
    });
    void result.catch(() => {});
    return result;
  };
  /** The reviewer worker's complete protected opinion record (same shape as worker-session), returned as its notification would carry it. */
  async function writeOpinion(invocation: Invocation): Promise<ReviewOpinion> {
    const records = await createRecords({ root: dir });
    const { phaseId: _phase, ...context } = invocation.context;
    const review = invocation.review!;
    const composed = { version: 1 as const, role: invocation.context.role as 'standards' | 'spec', round: review.round, attempt: review.attempt, invocationId: invocation.context.invocationId,
      session: { file: null }, model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
      input: { handoffIndexSha256: review.handoffIndexSha256, required: [...review.required], missing: [...review.missing] }, finalMessageSha256: null,
      conclusion: 'clean' as const, code: null, coverage: { scope: 'broad' as const, justification: 'all', examined: [] }, findings: [], limitations: [],
      hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, recordedAt: new Date().toISOString() };
    const reference = await records.record({ ...context, callId: 'review-opinion' }, { kind: 'review-opinion', ...composed });
    log('opinion-recorded', { role: composed.role, round: review.round, invocationId: invocation.context.invocationId });
    return { ...composed, reference };
  }
  /** The worker-session ask_user record (callId `ask-user-<id>`), complete or left partial (an interrupted preservation). */
  async function preserveQuestion(invocation: Invocation, script: Extract<RecoveryScript, { kind: 'ask-preserved' }>) {
    const records = await createRecords({ root: dir });
    const { phaseId, ...context } = invocation.context;
    const asked = { questionId: script.questionId, question: script.question, context: script.context ?? '', sha256: sha(script.question, script.context ?? '') };
    const event = { version: 1, kind: 'ask-user', ...asked, phaseId, toolCallId: 'call-27', askedAt: new Date().toISOString() };
    if (script.partial) {
      const output = await records.openOutput({ ...context, callId: `ask-user-${script.questionId}` });
      await output.write(Buffer.from(JSON.stringify({ version: 1, context: { ...context, callId: `ask-user-${script.questionId}` }, event }).slice(0, 40)));
      log('question-preserved', { questionId: script.questionId, partial: true });
      return;
    }
    const reference = await records.record({ ...context, callId: `ask-user-${script.questionId}` }, event);
    log('question-preserved', { questionId: script.questionId, reference: reference.id });
  }
  async function writeReceipt(invocation: Invocation) {
    const records = await createRecords({ root: dir });
    const { phaseId: _phase, ...context } = invocation.context;
    return records.record({ ...context, callId: 'worker-start' }, { version: 1, kind: 'worker-start', suppliedContext: invocation.context, startedAt: new Date().toISOString() });
  }
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: options.capacity ?? 1,
    calendar: { now: () => Date.now() + readHost(dir).calendarOffsetMs },
    ...(options.reviews ? { reviews: { reviewer: { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5242880 } } } : {}),
    ...(options.review28 ? { reviews: { reviewer: { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5242880 }, rounds: { max: 2 }, partialRecovery: true },
      // The persisted retry wait never ends on its own in `retry` (the cut happens during it); other waits end at once.
      clock: { monotonic: () => performance.now(), sleep: (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
        if (options.review28 !== 'retry' || ms !== 5000) { setTimeout(resolve, Math.min(ms, 20)); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      }) } } : {}),
    builder: { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async observeProposal() { return { status: 'observed', sha256: '1'.repeat(64), indexSha256: 'e'.repeat(64), entries: 1, consistent: true, observedAt: new Date().toISOString() }; },
      async prepare(input) {
        const environment = `env-${createHash('sha256').update(input.workId).digest('hex')}`;
        const reused = readHost(dir).prepared.includes(environment);
        log('prepare', { environment, reused });
        await options.onPrepare?.();
        updateHost(dir, state => { if (!state.prepared.includes(environment)) state.prepared.push(environment); state.current[environment] ??= null; });
        return { status: 'success', environment: environment as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v4', manifestSha256: 'f'.repeat(64), reused }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused, preparedAt: new Date().toISOString() } };
      },
      async start(input) {
        const boot = `boot-${randomUUID()}`;
        updateHost(dir, state => { state.boots[boot] = 'active'; state.current[input.environment] = boot; state.log.push({ kind: 'start', detail: { boot, pass: (input as { pass?: string }).pass ?? null } }); });
        return { status: 'success', boot: boot as never };
      },
      async stop(input) {
        const stuck = readHost(dir).stuck.includes(input.boot);
        updateHost(dir, state => { state.log.push({ kind: 'stop', detail: { boot: input.boot, reason: input.reason, stuck } }); if (!stuck) state.boots[input.boot] = 'stopped'; });
        return stuck ? { status: 'indeterminate', code: 'ENVIRONMENT_STOP_UNCONFIRMED', cessationConfirmed: false }
          : { status: 'success', cessationConfirmed: true, termination: readHost(dir).forced ? 'forced' : 'unconfirmed', guestFinalization: 'observed' };
      },
      ...(options.observe === false ? {} : { async observe(input: { environment: string; boot?: string }) {
        const state = readHost(dir);
        log('observe', input);
        const boot = input.boot ?? state.current[input.environment] ?? null;
        if (!boot) return state.prepared.includes(input.environment) ? { condition: 'not-booted', cessationConfirmed: true, boot: null } : { condition: 'indeterminate', cessationConfirmed: false };
        if (state.stuck.includes(boot)) return { condition: 'indeterminate', cessationConfirmed: false };
        return state.boots[boot] === 'active' ? { condition: 'active', cessationConfirmed: false, boot: boot as never } : { condition: 'stopped', cessationConfirmed: true, boot: boot as never };
      } }),
    } as ExecutionPorts['sandbox'],
    credentials: {
      async issue() {
        log('issue');
        return { delivery: { token: 'ghs_syntheticRecoveryGrant0123' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
          permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      },
      async revoke() { log('revoke'); return { kind: 'revoked', nextStep: 'synthetic' }; },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        if (invocation.context.role !== 'builder' && options.review28) {
          log('activate-reviewer', { role: invocation.context.role, review: invocation.review, boot: invocation.context.bootRef });
          const started = writeReceipt(invocation).then(reference => ({ receipt: reference, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } }));
          const mode = options.review28;
          const completed = started.then(async start => {
            const preserved = mode === 'complete' || (mode === 'lost' && invocation.context.role === 'standards') ? await writeOpinion(invocation) : null;
            if (mode === 'retry' && invocation.context.role === 'spec') return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
            if (mode === 'complete') return { status: 'success' as const, receipt: start.receipt, opinion: preserved! };
            return new Promise<never>(() => {}); // runs until its boot stops; a lost notification never arrives
          });
          return { worker: invocation.context.invocationId, started: interruptible(invocation.signal, started), completed: interruptible(invocation.signal, completed),
            close() { log('close-reviewer'); } };
        }
        if (invocation.context.role !== 'builder') {
          // A reviewer of the SAME boot: receipt first, then it runs until its activation (boot) is gone.
          log('activate-reviewer', { role: invocation.context.role, boot: invocation.context.bootRef });
          const started = writeReceipt(invocation).then(reference => ({ receipt: reference, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } }));
          return { worker: invocation.context.invocationId, started: interruptible(invocation.signal, started),
            completed: interruptible(invocation.signal, new Promise<never>(() => {})), close() { log('close-reviewer'); } };
        }
        const script = options.script?.(invocation) ?? scripts.shift() ?? { kind: 'complete' };
        prompts.push({ executionId: invocation.context.executionId, phaseId: invocation.context.phaseId ?? '', prompt: invocation.prompt });
        log('activate', { executionId: invocation.context.executionId, boot: invocation.context.bootRef, phaseId: invocation.context.phaseId, script: script.kind,
          bootActive: readHost(dir).boots[invocation.context.bootRef] === 'active' });
        await options.onActivate?.(invocation);
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        finishers.push(finish);
        byExecution.set(invocation.context.executionId, finish);
        const started = script.kind === 'no-receipt' ? new Promise<never>(() => {}) : (async () => {
          const reference = await writeReceipt(invocation);
          log('receipt', { executionId: invocation.context.executionId, id: reference.id });
          if (script.kind === 'lose-notification') await new Promise<never>(() => {});
          if (script.kind === 'ask-preserved' && script.loseNotification) { await preserveQuestion(invocation, script); await new Promise<never>(() => {}); }
          return { receipt: reference, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } };
        })();
        const completed = interruptible(invocation.signal, started.then(async start => {
          if (script.kind === 'complete') return { status: 'success' as const, receipt: start.receipt };
          if (script.kind === 'fail') return { status: 'failure' as const, code: script.code };
          if (script.kind === 'ask-preserved') {
            await preserveQuestion(invocation, script);
            if (script.notifyInvalid) {
              const ack = await events!.question!({ questionId: script.questionId, question: script.question, context: script.context ?? '', sha256: 'f'.repeat(64),
                reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' } });
              log('question-ack', ack);
            }
            await new Promise<never>(() => {});
          }
          if (script.kind === 'ask') {
            const question: WorkerQuestion = { questionId: script.questionId, question: script.question, context: '', sha256: sha(script.question, ''),
              reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' } };
            const ack = await events!.question!(question);
            if (script.hangAfterAck) await finished;
            return { status: 'question' as const, receipt: start.receipt, question: { ...question, acknowledged: ack.status === 'recorded' } };
          }
          await finished;
          return { status: 'success' as const, receipt: start.receipt };
        }));
        let pending = script.kind === 'handoff';
        return { worker: invocation.context.invocationId, started: interruptible(invocation.signal, started), completed, close() { log('close'); },
          ...(script.kind === 'handoff' ? { handoffs: { async next() {
            if (pending) {
              pending = false;
              // Ticket 28: the capture numbers continue the Work's rounds and carry the SAME content identity in every Execution.
              const round = invocation.handoff?.rounds?.first ?? 1;
              return { round, status: 'captured' as const, summary: { ...handoffSummary(), round, ...(options.review28 ? { content: { sha256: '9'.repeat(64), clean: false, headMatches: false } } : {}) } };
            }
            await finished; return null;
          } } } : {}) };
      },
      async deliver(_worker, directive) { log(`deliver-${directive.kind}`); return { status: directive.kind === 'withdraw-credential' ? 'withdrawn' as const : 'delivered' as const }; },
      ...(options.observeStart === false ? {} : { observeStart: (input: { workId: string; executionId: string; invocationId: string }) => workers.observeStart(input) }),
      // Ticket 27: the REAL question facet (Records) — logged, so a test can prove it was consulted.
      observeQuestion: (input: { workId: string; executionId: string; invocationId: string }) => { log('observe-question', input); return workers.observeQuestion(input); },
      ...(options.review28 ? { observeOpinion: (input: { workId: string; executionId: string; invocationId: string }) => { log('observe-opinion', input); return workers.observeOpinion(input); } } : {}),
    },
  };
  return { ports, prompts, finish: (index = finishers.length - 1) => finishers[index]?.(), finishExecution: (executionId: string) => byExecution.get(executionId)?.(), host: () => readHost(dir),
    calls: (kind: string) => readHost(dir).log.filter(item => item.kind === kind),
    jumpCalendar: (ms: number) => updateHost(dir, state => { state.calendarOffsetMs += ms; }) };
}
