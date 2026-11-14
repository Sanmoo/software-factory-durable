// Execution boundary doubles for budgets/timeout (ticket 19). Control, Pi Durable and SQLite stay real; Sandbox lifecycle, Workers
// (Builder, reviewers) and the Builder credentials are doubled, and so is the local monotonic clock. Not evidence of a VM/worker/model/GitHub.
import { createHash } from 'node:crypto';
import type { ProposalHandoff } from '../../src/contracts/index.js';
import type { ExecutionPorts, PollingClock } from '../../src/control/types.js';
import type { Invocation, WorkerQuestion } from '../../src/workers/index.js';

/** Controlled monotonic clock with any number of sleepers: `advance` wakes the due ones; `jump` moves time without waking (late timer). */
export function executionClock() {
  let now = 0;
  const sleepers = new Set<{ due: number; resolve(): void }>();
  const clock: PollingClock = {
    monotonic: () => now,
    sleep(ms, signal) {
      return new Promise<void>(resolve => {
        const sleeper = { due: now + Math.max(0, ms), resolve: () => { sleepers.delete(sleeper); resolve(); } };
        if (signal.aborted) { resolve(); return; }
        sleepers.add(sleeper);
        signal.addEventListener('abort', () => sleeper.resolve(), { once: true });
      });
    },
  };
  return { clock, now: () => now, sleepers: () => sleepers.size,
    advance(ms: number) { now += ms; for (const sleeper of [...sleepers]) if (sleeper.due <= now) sleeper.resolve(); },
    jump(ms: number) { now += ms; } };
}

/** Builder behaviour per activation (in order). `hang` runs until finished or interrupted (signal abort -> channel loss). */
export type Script = { kind: 'complete' } | { kind: 'hang' } |
  { kind: 'ask'; questionId: string; question: string; beforeAsk?: () => void | Promise<void>; /** keep running after the ACK (crash tests) */ hangAfterAck?: boolean } |
  { kind: 'launch-uncertain' } | { kind: 'handoff'; beforeHandoff?: () => void };
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');
const summary = (): ProposalHandoff => ({ version: 1, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'e'.repeat(64),
  head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40), mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: { committed: { path: '/artifacts/review/r1/committed.patch', bytes: 10, sha256: 'c'.repeat(64) }, staged: { path: '/artifacts/review/r1/staged.patch', bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 0, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/a.ts'], changedTruncated: false });

export function budgetDoubles(scripts: Script[], options: { cessation?: boolean; reviews?: boolean; clock?: PollingClock; onPrepare?: () => Promise<void>;
  /** A preparation that fails before any environment/boot exists: a PROVEN non-start, never an uncertain activation. */
  prepareFailure?: () => boolean } = {}) {
  const calls: { kind: string; detail?: unknown }[] = [];
  const signals: { role: string; signal: AbortSignal }[] = [];
  const finishers: (() => void)[] = [];
  const receipt = (invocation: Invocation) => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
  // A closed host channel (aborted activation signal) makes the activity outcome uncertain, as the real Workers facade reports it.
  const interruptible = <T>(signal: AbortSignal, value: Promise<T>) => {
    const result = new Promise<T>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('WORKER_EXECUTION_UNCERTAIN')), { once: true });
      value.then(resolve, reject);
    });
    void result.catch(() => {}); // like the real facade: an unobserved outcome is not an unhandled rejection
    return result;
  };
  let calendarOffset = 0;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: 1, calendar: { now: () => Date.now() + calendarOffset },
    builder: { skillPack: 'factory-skills-v2', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.reviews ? { reviews: { reviewer: { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5242880 } } } : {}),
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', detail: input });
        await options.onPrepare?.();
        if (options.prepareFailure?.()) return { status: 'failure' as const, code: 'SYNTHETIC_PREPARE_FAILED' };
        // Ticket 11: a resumed activation (after an accepted answer or an authorized scope change) must reuse the preserved
        // environment/checkout; the double models that resumption by reusing the same checkout from the second prepare on.
        const resumed = calls.filter(call => call.kind === 'prepare').length > 1;
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v2', manifestSha256: 'f'.repeat(64), reused: resumed }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: resumed, preparedAt: new Date().toISOString() } };
      },
      async start() { calls.push({ kind: 'start' }); return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never }; },
      async stop(input) { calls.push({ kind: 'stop', detail: input });
        return options.cessation === false ? { status: 'indeterminate', code: 'STOP_UNCONFIRMED', cessationConfirmed: false } : { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
      async observeProposal() { return { status: 'observed', sha256: '1'.repeat(64), indexSha256: 'e'.repeat(64), entries: 1, consistent: true, observedAt: new Date().toISOString() }; },
    },
    credentials: {
      async issue() {
        calls.push({ kind: 'issue' });
        return { delivery: { token: 'ghs_syntheticBudgetGrant0123' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
          permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      },
      async revoke() { calls.push({ kind: 'revoke' }); return { kind: 'revoked', nextStep: 'synthetic' }; },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        const role = invocation.context.role;
        signals.push({ role, signal: invocation.signal });
        if (role !== 'builder') {
          // Reviewers run until interrupted (they share the Execution's clock and timeout).
          calls.push({ kind: `activate-${role}` });
          return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)),
            completed: interruptible(invocation.signal, new Promise<never>(() => {})), close() { calls.push({ kind: `close-${role}` }); } };
        }
        const script = scripts.shift() ?? { kind: 'complete' };
        calls.push({ kind: 'activate', detail: { context: invocation.context, script: script.kind } });
        if (script.kind === 'launch-uncertain') throw new Error('WORKER_LAUNCH_UNCERTAIN');
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        finishers.push(finish);
        const started = Promise.resolve(receipt(invocation));
        let pending: { round: number; status: 'captured'; summary: ProposalHandoff } | null = script.kind === 'handoff' ? { round: 1, status: 'captured', summary: summary() } : null;
        const completed = interruptible(invocation.signal, started.then(async () => {
          if (script.kind === 'complete') return { status: 'success' as const, receipt: receipt(invocation).receipt };
          if (script.kind === 'ask') {
            await script.beforeAsk?.();
            const question: WorkerQuestion = { questionId: script.questionId, question: script.question, context: '', sha256: sha(script.question, ''),
              reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' } };
            const ack = await events!.question!(question);
            if (script.hangAfterAck) await finished;
            return { status: 'question' as const, receipt: receipt(invocation).receipt, question: { ...question, acknowledged: ack.status === 'recorded' } };
          }
          await finished;
          return { status: 'success' as const, receipt: receipt(invocation).receipt };
        }));
        return { worker: invocation.context.invocationId, started, completed,
          ...(script.kind === 'handoff' ? { handoffs: { async next() { const event = pending; pending = null; if (event && script.kind === 'handoff') script.beforeHandoff?.(); if (!event) await finished; return event; } } } : {}),
          close() { calls.push({ kind: 'close' }); } };
      },
      async deliver(_worker, directive) { calls.push({ kind: `deliver-${directive.kind}` }); return { status: directive.kind === 'credential' ? 'delivered' as const : directive.kind === 'withdraw-credential' ? 'withdrawn' as const : 'delivered' as const }; },
    },
  };
  return { ports, calls, signals, jumpCalendar: (ms: number) => { calendarOffset += ms; }, finish: (index = finishers.length - 1) => finishers[index]?.(),
    activations: () => calls.filter(call => call.kind === 'activate') };
}
