// Execution boundary doubles for ticket 26 (recovery). Control, Pi Durable/SQLite, Records and the Workers receipt facet (`observeStart`) are
// REAL; the Sandbox host (boots, stop, observe) is a file-backed double so a surviving "boot" outlives a SIGKILLed controller process exactly
// like a systemd unit does, and the Builder is scripted. Not evidence of a VM, systemd, worker process, model or GitHub.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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
  { kind: 'ask'; questionId: string; question: string; hangAfterAck?: boolean };

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

export function recoveryDoubles(dir: string, scripts: RecoveryScript[], options: { capacity?: number; observe?: boolean; observeStart?: boolean;
  onPrepare?: () => Promise<void>; onActivate?: (invocation: Invocation) => void | Promise<void> } = {}) {
  const prompts: { executionId: string; phaseId: string; prompt: string }[] = [];
  const log = (kind: string, detail?: unknown) => updateHost(dir, state => { state.log.push({ kind, ...(detail === undefined ? {} : { detail }) }); });
  const finishers: (() => void)[] = [];
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
  async function writeReceipt(invocation: Invocation) {
    const records = await createRecords({ root: dir });
    const { phaseId: _phase, ...context } = invocation.context;
    return records.record({ ...context, callId: 'worker-start' }, { version: 1, kind: 'worker-start', suppliedContext: invocation.context, startedAt: new Date().toISOString() });
  }
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: options.capacity ?? 1,
    calendar: { now: () => Date.now() + readHost(dir).calendarOffsetMs },
    builder: { skillPack: 'factory-skills-v4', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
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
        updateHost(dir, state => { state.boots[boot] = 'active'; state.current[input.environment] = boot; state.log.push({ kind: 'start', detail: { boot } }); });
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
        const script = scripts.shift() ?? { kind: 'complete' };
        prompts.push({ executionId: invocation.context.executionId, phaseId: invocation.context.phaseId ?? '', prompt: invocation.prompt });
        log('activate', { executionId: invocation.context.executionId, boot: invocation.context.bootRef, phaseId: invocation.context.phaseId, script: script.kind,
          bootActive: readHost(dir).boots[invocation.context.bootRef] === 'active' });
        await options.onActivate?.(invocation);
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        finishers.push(finish);
        const started = script.kind === 'no-receipt' ? new Promise<never>(() => {}) : (async () => {
          const reference = await writeReceipt(invocation);
          log('receipt', { executionId: invocation.context.executionId, id: reference.id });
          if (script.kind === 'lose-notification') await new Promise<never>(() => {});
          return { receipt: reference, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } };
        })();
        const completed = interruptible(invocation.signal, started.then(async start => {
          if (script.kind === 'complete') return { status: 'success' as const, receipt: start.receipt };
          if (script.kind === 'fail') return { status: 'failure' as const, code: script.code };
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
        return { worker: invocation.context.invocationId, started: interruptible(invocation.signal, started), completed, close() { log('close'); } };
      },
      async deliver(_worker, directive) { log(`deliver-${directive.kind}`); return { status: directive.kind === 'withdraw-credential' ? 'withdrawn' as const : 'delivered' as const }; },
      ...(options.observeStart === false ? {} : { observeStart: (input: { workId: string; executionId: string; invocationId: string }) => workers.observeStart(input) }),
    },
  };
  return { ports, prompts, finish: (index = finishers.length - 1) => finishers[index]?.(), host: () => readHost(dir),
    calls: (kind: string) => readHost(dir).log.filter(item => item.kind === kind),
    jumpCalendar: (ms: number) => updateHost(dir, state => { state.calendarOffsetMs += ms; }) };
}
