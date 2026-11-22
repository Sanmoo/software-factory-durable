import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import type { ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { BuilderDirective, HandoffEvent, Invocation, OpinionObservation } from '../../src/workers/index.js';
import { foreignPull, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { recipeWork, verdict } from '../entrypoints/review28-qualification.js';
import { until } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clocks, Sandbox lifecycle/identity, Workers (a scripted
// suspended Builder, scripted reviewers per attempt, a scripted Records opinion facet) and credentials. Ticket 28: partial review recovery
// inside the Execution. Not evidence of a real VM, worker, model, reviewer, Records discovery or crash.
const summary = (round: number, content: string): ProposalHandoff => ({ version: 1, round,
  index: `/artifacts/review/r${round}/index.json`, indexSha256: `${round}${content}`.padEnd(64, '0'), head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: { committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 0, sha256: 'c'.repeat(64) }, staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 4, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'], changedTruncated: false, content: { sha256: content.repeat(64), clean: false, headMatches: false } });
const capture = (round: number, content: string, closing = false): HandoffEvent => ({ round, status: 'captured', summary: summary(round, content), ...(closing ? { closing: true as const } : {}) });
/** Reviewer behaviour of ONE attempt: a verdict, a transient failure, a completion whose opinion is only in Records, or a config refusal. */
type Behaviour = 'clean' | 'fail' | 'budget' | 'invalid' | 'lost' | 'lost-unreadable' | 'config' | string[];
type Role = 'standards' | 'spec';

function opinionOf(invocation: Invocation, findings: string[], conclusion?: ReviewOpinion['conclusion'], code: string | null = null): ReviewOpinion {
  const role = invocation.context.role as Role;
  return { version: 1, role, round: invocation.review!.round, attempt: invocation.review!.attempt, invocationId: invocation.context.invocationId,
    reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' }, session: { file: null, mode: 'new', from: null, code: null },
    model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
    input: { handoffIndexSha256: invocation.review!.handoffIndexSha256, required: [...invocation.review!.required], missing: [...invocation.review!.missing] },
    conclusion: conclusion ?? (findings.length ? 'findings' : 'clean'), code, coverage: conclusion === 'failure' ? null : { scope: 'broad', justification: 'all', examined: [] },
    findings: findings.map(id => ({ id, basis: role === 'spec' ? 'requirement' as const : 'heuristic' as const, reference: 'r', location: { path: '/workspace/checkout/docs/a.md' }, summary: 's' })),
    limitations: [], hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: new Date().toISOString() };
}

function doubles(script: { captures: HandoffEvent[];
  /** Ticket 51: the captures of the n-th Builder activation (1-based) when a later Execution hands off again; default `captures`. */
  capturesOf?: (activation: number) => HandoffEvent[]; behaviour: (role: Role, round: number, attempt: number) => Behaviour;
  /** The Host identity of round N at its k-th observation (default: the capture's content). */ identity?: (round: number, call: number) => string | null;
  /** A retry wait (ms) that never ends before an interruption, or that fails. Other durations (the Execution timer) sleep briefly for real. */
  clock?: { hang?: number; reject?: number } }) {
  const directives: BuilderDirective[] = [];
  const invocations: Invocation[] = [];
  const kinds: string[] = [];
  const sleeps: number[] = [];
  let now = 0;
  const timers: (() => void)[] = [];
  const records = new Map<string, ReviewOpinion>();
  const observations = new Map<number, number>();
  const identity = (round: number): ProposalIdentity => {
    const call = (observations.get(round) ?? 0) + 1;
    observations.set(round, call);
    const event = [...script.captures, ...(script.capturesOf?.(2) ?? [])].find(item => item.round === round);
    const content = script.identity?.(round, call) ?? (event?.status === 'captured' ? event.summary.content?.sha256 ?? 'x' : 'x');
    return { status: 'observed', sha256: content.slice(0, 64), indexSha256: event?.status === 'captured' ? event.summary.indexSha256 : '',
      entries: 1, consistent: true, observedAt: new Date().toISOString() };
  };
  const receipt = (invocation: Invocation) => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  // Ticket 51: calendar of the persisted recovery waits, jumped by the test (never slept).
  let calendarOffsetMs = 0;
  const prepared = new Set<string>();
  const ports: ExecutionPorts = {
    calendar: { now: () => Date.now() + calendarOffsetMs },
    configuration: { schemaVersion: 1 }, capacity: 1, builder: { skillPack: 'factory-skills-v3', modelBudget: 'builder-v1', copyOutput: true },
    reviews: { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 }, rounds: { max: 4 }, partialRecovery: true },
    // Retry waits are recorded, not slept: the persisted 5/15/45 s schedule is asserted on the requested durations.
    // Fake monotonic clock, no real timer: the Execution timer (any non-retry duration) waits until a provoked hanging retry wait begins,
    // then the clock jumps past it, so the timeout fires exactly DURING that wait.
    clock: { monotonic: () => now, sleep(ms, signal) {
      const retryWait = [5000, 15000, 45000].includes(ms);
      if (!retryWait) return new Promise<void>(resolve => { timers.push(() => { now += ms; resolve(); }); signal.addEventListener('abort', () => resolve(), { once: true }); });
      sleeps.push(ms); kinds.push(`sleep-${ms}`);
      if (script.clock?.reject === ms) return Promise.reject(new Error('CLOCK_FAILED'));
      if (script.clock?.hang === ms) return new Promise<void>(resolve => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
        for (const fire of timers.splice(0)) fire();
      });
      return Promise.resolve();
    } },
    sandbox: {
      async prepare(input) {
        // Ticket 51: a later Execution of the same Work reuses its preserved environment (required by a recovery's continuation context).
        const reused = prepared.has(input.workId);
        prepared.add(input.workId);
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v3', manifestSha256: 'f'.repeat(64), reused }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused, preparedAt: new Date().toISOString() } };
      },
      async start() { return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never }; },
      async stop() { kinds.push('stop'); return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
      async observeProposal(input) { kinds.push(`observe-r${input.round}`); return identity(input.round); },
    },
    credentials: {
      async issue() { return { delivery: { token: 'ghs_synthetic' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
        permissions: { metadata: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } }; },
      async revoke() { return { kind: 'not-attempted', nextStep: 'ticket 20' }; },
    },
    workers: {
      async observeOpinion(input): Promise<OpinionObservation> {
        kinds.push(`records-find-${input.invocationId.split('-')[0]}`);
        const found = records.get(input.invocationId);
        return found ? { kind: 'opinion', opinion: found } : { kind: 'uncertain', code: 'OPINION_RECORD_INCOMPLETE' };
      },
      async deliver(_worker, directive) {
        if (directive.kind !== 'review-results') return { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' };
        kinds.push(`deliver-r${directive.round}${directive.end ? '-end' : ''}`);
        directives.push(directive);
        delivered?.(directive);
        return { status: 'delivered' as const };
      },
      async activate(invocation) {
        invocations.push(invocation);
        const role = invocation.context.role;
        if (role === 'builder') {
          kinds.push('activate-builder');
          const queue = [...(script.capturesOf?.(invocations.filter(item => item.context.role === 'builder').length) ?? script.captures)];
          let finish!: () => void;
          const done = new Promise<void>(resolve => { finish = resolve; });
          let waiting: Promise<BuilderDirective> | null = null;
          return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)),
            completed: done.then(() => ({ status: 'success' as const, receipt: receipt(invocation).receipt })),
            handoffs: { async next() {
              if (waiting) { const directive = await waiting; if (directive.end) { finish(); return null; } }
              const event = queue.shift();
              if (!event) { finish(); return null; }
              waiting = new Promise(resolve => { delivered = resolve; });
              return event;
            } },
            close() { kinds.push('close-builder'); } };
        }
        const { round, attempt } = invocation.review!;
        kinds.push(`activate-${role}-r${round}a${attempt}`);
        const behaviour = script.behaviour(role as Role, round, attempt);
        if (behaviour === 'config') throw new Error('WORKER_PROFILE_NOT_CONFIGURED');
        const completed = Promise.resolve().then(() => {
          kinds.push(`end-${role}-r${round}a${attempt}`);
          if (behaviour === 'fail') return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
          // Ticket 57: the reviewer's own request budget closed its session (pilot 2, #126 Spec): a recorded cancellation with its cause.
          if (behaviour === 'budget') return { status: 'success' as const, receipt: receipt(invocation).receipt, opinion: opinionOf(invocation, [], 'cancelled', 'REVIEWER_BUDGET_EXHAUSTED') };
          if (behaviour === 'invalid') return { status: 'success' as const, receipt: receipt(invocation).receipt, opinion: opinionOf(invocation, [], 'failure', 'REVIEW_VERDICT_INVALID') };
          // The worker preserved the complete opinion before notifying; the notification arrives without it (or the record is unreadable).
          if (behaviour === 'lost') { records.set(invocation.context.invocationId, opinionOf(invocation, [])); return { status: 'success' as const, receipt: receipt(invocation).receipt }; }
          if (behaviour === 'lost-unreadable') return { status: 'success' as const, receipt: receipt(invocation).receipt };
          return { status: 'success' as const, receipt: receipt(invocation).receipt, opinion: opinionOf(invocation, behaviour === 'clean' ? [] : behaviour) };
        });
        return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)), completed, close() { kinds.push(`close-${role}`); } };
      },
    },
  };
  return { ports, directives, invocations, kinds, sleeps, jumpCalendar: (ms: number) => { calendarOffsetMs += ms; } };
}

async function harness(t: { after(fn: () => Promise<void>): void }, script: Parameters<typeof doubles>[0], limits: { recoveryLimit?: number; timeoutSeconds?: number } = {},
  world: { remote?: Remote; ticket?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review28-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = world.remote ?? { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const execution = doubles(script);
  const time = manualClock();
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...limits }] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  const list = async () => (await control.inspect({ kind: 'list' })) as ListView;
  const work = async () => (await list()).works.find(item => item.ticket.number === (world.ticket ?? 3)) as WorkView | undefined;
  const current = await until('Execution ended or held', async () => {
    const value = await work();
    return value?.execution?.slot.held === false || value?.execution?.state === 'held' ? value : undefined;
  }, 5);
  const shown = await control.inspect({ kind: 'show', work_id: current.work_id });
  /** Ticket 51: waits for a later state, advancing the polling clock while the owner sleeps (bounded by the runner budget). */
  let lastSeen: WorkView | undefined;
  const settle = (stage: string, probe: (value: WorkView) => boolean) => until(() => `${stage}; last: ${JSON.stringify({ execution: lastSeen?.execution && { id: lastSeen.execution.executionId,
    state: lastSeen.execution.state, held: lastSeen.execution.held, end: lastSeen.execution.end, phase: lastSeen.execution.dispatch.phase }, impediments: lastSeen?.impediments.map(item => item.code),
    pending: lastSeen?.pendingRecovery, queue: lastSeen?.queue, kinds: execution.kinds.slice(-8) })}`, async () => {
    const value = lastSeen = await work();
    if (value && probe(value)) return value;
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 5);
  return { execution, work: current, shown: 'work' in shown ? shown.work : undefined, list: await list(), control, settle };
}
const activations = (kinds: string[]) => kinds.filter(kind => kind.startsWith('activate-'));

test('AC3/AC4/AC5: a failed Spec reviewer is re-obtained alone in the same round; the valid Standards opinion is kept; the 5 s wait, no recovery unit', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean' });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-spec-r1a2'], 'Standards is never rerun');
  assert.deepEqual([round.conclusion, round.applicability, round.reasons], ['clean', 'current', []]);
  const spec = round.reviewers.spec;
  assert.deepEqual([spec.attempt, spec.invocationId, spec.opinion?.attempt, spec.opinion?.invocationId, spec.source], [2, `spec-${h.work.execution!.executionId}-r1a2`, 2, spec.invocationId, 'notification']);
  assert.deepEqual(spec.attempts?.map(item => [item.attempt, item.invocationId.endsWith('-r1a1'), item.state, item.failure?.code, item.cessation]), [[1, true, 'failed', 'WORKER_INTERRUPTED', 'completion-observed']]);
  assert.deepEqual([spec.charge, spec.retry?.waitSeconds, spec.retry?.after], [null, 5, 'WORKER_INTERRUPTED']);
  assert.deepEqual([round.reviewers.standards.attempt, round.reviewers.standards.attempts, round.reviewers.standards.opinion?.attempt], [undefined, undefined, 1]);
  assert.deepEqual(h.execution.sleeps, [5000], 'the persisted wait of the first retry of this role in this round');
  const budget = h.shown!.budget!.recoveries;
  assert.deepEqual([budget.consumed, budget.reserved, budget.limit], [0, null, 3], 'ticket 57: a reviewer retry never charges the Work recoveries');
  assert.ok(h.shown!.history.some(item => item.event === 'reviewer-retried' && 'detail' in item && item.detail === 'r1:spec:a2:after:WORKER_INTERRUPTED:wait:5s:retry:1/2'));
  assert.equal(h.shown!.history.some(item => item.event.startsWith('budget-')), false);
  // The Builder stays suspended until BOTH reviewers' activity ended: the only delivery follows the retried Spec's end.
  const order = h.execution.kinds;
  assert.ok(order.indexOf('deliver-r1') > order.indexOf('end-spec-r1a2') && order.indexOf('deliver-r1') > order.indexOf('end-standards-r1a1'));
  assert.equal(h.execution.directives.length, 1);
  assert.match(h.execution.directives[0]!.prompt, /Round conclusion: clean/);
  assert.equal(h.work.execution!.review!.verification!.reasons.some(reason => reason.includes('NOT_CORRELATED')), false, 'the attempt-2 opinion correlates');
});

test('AC1/AC2: a complete opinion whose notification was lost is located in Records and incorporated once, without rerunning; an unreadable record is a failure, then re-obtained', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'standards' ? 'lost' : 'clean' });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1'], 'never rerun for a lost notification');
  assert.deepEqual([round.reviewers.standards.state, round.reviewers.standards.source, round.reviewers.standards.cessation, round.conclusion], ['ended', 'records-discovery', 'completion-observed', 'clean']);
  assert.equal(h.execution.kinds.filter(kind => kind === 'records-find-standards').length, 1, 'located once');
  assert.equal(h.shown!.budget!.recoveries.consumed, 0, 'incorporating a preserved opinion charges nothing');
  assert.ok(h.shown!.history.some(item => item.event === 'reviewer-ended' && item.detail === 'r1:standards:clean'));

  const partial = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'standards' && attempt === 1 ? 'lost-unreadable' : 'clean' });
  const first = partial.work.execution!.review!.rounds[0]!;
  assert.deepEqual(first.reviewers.standards.attempts?.map(item => item.failure?.code), ['OPINION_MISSING'], 'an incomplete/unreadable record is never an opinion or zero findings');
  assert.deepEqual([first.reviewers.standards.attempt, first.reviewers.standards.opinion?.conclusion, first.conclusion], [2, 'clean', 'clean']);
});

test('AC3: a changed proposal is never retried on the old input; the round is invalidated and the next capture gets new opinions of BOTH reviewers', async t => {
  const h = await harness(t, { captures: [capture(1, '1'), capture(2, '2', true)],
    behaviour: (role, round) => role === 'spec' && round === 1 ? 'fail' : 'clean',
    // Round 1: observed '1' at the handoff, then '9' when the failed Spec would be retried (the content changed meanwhile).
    identity: (round, call) => round === 1 && call >= 2 ? '9' : null });
  const [first, second] = h.work.execution!.review!.rounds;
  assert.deepEqual([first!.reviewers.spec.notRetried?.code, first!.reviewers.spec.attempt, first!.conclusion, first!.applicability], ['PROPOSAL_CHANGED', undefined, 'incomplete', 'invalidated']);
  assert.ok(first!.reasons.includes('SPEC_NOT_RETRIED:PROPOSAL_CHANGED') && first!.reasons.includes('PROPOSAL_CHANGED_DURING_REVIEW'));
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-standards-r2a1', 'activate-spec-r2a1']);
  assert.deepEqual([second!.conclusion, second!.reviewers.standards.source, second!.reviewers.spec.source], ['clean', 'notification', 'notification']);
  assert.equal(h.shown!.budget!.recoveries.consumed, 0);
  assert.match(h.execution.directives[0]!.prompt, /"code": "WORKER_INTERRUPTED"/, 'the real failure reaches the Builder, never zero findings');
});

test('AC4 / ticket 57: retries draw on the round\'s own limit, never on the Work recoveries; non-transient failures stay explicit failures', async t => {
  // One recovery unit only: two Spec retries in the round still run, and the Work keeps its unit for a Builder interruption.
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt < 3 ? 'invalid' : role === 'spec' ? 'clean' : ['H1'] },
    { recoveryLimit: 1 });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-spec-r1a2', 'activate-spec-r1a3']);
  assert.deepEqual([round.reviewers.spec.attempt, round.reviewers.spec.opinion?.conclusion, round.reviewers.spec.notRetried ?? null], [3, 'clean', null]);
  assert.deepEqual([round.conclusion, round.reasons], ['findings', []]);
  assert.deepEqual([h.shown!.budget!.recoveries.consumed, h.shown!.budget!.recoveries.reserved], [0, null]);
  assert.equal(round.reviewers.standards.opinion?.findings[0]?.id, 'H1', 'the valid opinion with findings is preserved as is');
  assert.equal(h.shown!.history.some(item => item.event.startsWith('budget-')), false, 'nothing reserved, consumed or exhausted');

  const config = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'spec' ? 'config' : 'clean' });
  const refused = config.work.execution!.review!.rounds[0]!;
  assert.deepEqual([refused.reviewers.spec.failure?.code, refused.reviewers.spec.cessation, refused.reviewers.spec.notRetried?.code], ['REVIEWER_UNAVAILABLE', 'never-started', 'REVIEWER_FAILURE_NOT_TRANSIENT']);
  assert.deepEqual(activations(config.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1']);
  assert.equal(config.shown!.budget!.recoveries.consumed, 0);
});

test('AC4: the persisted waits follow the retries of the role in the round (5 then 15 s); a second failure of the same role is retried again within the limit', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt < 3 ? 'fail' : 'clean' });
  const spec = h.work.execution!.review!.rounds[0]!.reviewers.spec;
  assert.deepEqual(h.execution.sleeps, [5000, 15000]);
  assert.deepEqual([spec.attempt, spec.attempts?.map(item => item.charge), spec.charge], [3, [null, null], null]);
  assert.equal(h.shown!.budget!.recoveries.consumed, 0);
  assert.equal(h.work.execution!.review!.rounds[0]!.conclusion, 'clean');
});

test('ticket 57 (pilot 2, #126): Spec reviewers closed by their own budget are retried in each round without touching the Work recoveries', async t => {
  // Round 1: a1 and a2 budget-closed, a3 concludes; round 2: a1 budget-closed, a2 concludes (the pilot spent 3/3 recoveries on these).
  const h = await harness(t, { captures: [capture(1, '1'), capture(2, '2', true)],
    behaviour: (role, round, attempt) => role === 'spec' && ((round === 1 && attempt < 3) || (round === 2 && attempt === 1)) ? 'budget' : 'clean' }, { recoveryLimit: 3 });
  const [first, second] = h.work.execution!.review!.rounds;
  assert.deepEqual([first!.reviewers.spec.attempts?.map(item => item.opinion?.code), first!.reviewers.spec.attempt, first!.conclusion],
    [['REVIEWER_BUDGET_EXHAUSTED', 'REVIEWER_BUDGET_EXHAUSTED'], 3, 'clean']);
  assert.deepEqual([second!.reviewers.spec.attempts?.map(item => item.opinion?.code), second!.reviewers.spec.attempt, second!.conclusion],
    [['REVIEWER_BUDGET_EXHAUSTED'], 2, 'clean']);
  assert.deepEqual(h.execution.sleeps, [5000, 15000, 5000], 'the wait restarts with each round (it follows the round, not the Work)');
  const recoveries = h.shown!.budget!.recoveries;
  assert.deepEqual([recoveries.consumed, recoveries.reserved, recoveries.limit], [0, null, 3], 'all three units stay for a Builder interruption');
  assert.deepEqual(h.shown!.history.filter(item => item.event === 'reviewer-retried').map(item => 'detail' in item ? item.detail : null), [
    'r1:spec:a2:after:REVIEWER_BUDGET_EXHAUSTED:wait:5s:retry:1/2', 'r1:spec:a3:after:REVIEWER_BUDGET_EXHAUSTED:wait:15s:retry:2/2',
    'r2:spec:a2:after:REVIEWER_BUDGET_EXHAUSTED:wait:5s:retry:1/2']);
  assert.equal(h.shown!.history.some(item => item.event.startsWith('budget-')), false);
});

test('review HIGH 1: an Execution interrupted during the persisted wait records the retry as a proven non-start, never left requested', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean',
    clock: { hang: 5000 } }, { timeoutSeconds: 1 });
  const spec = h.work.execution!.review!.rounds[0]!.reviewers.spec;
  assert.equal(h.work.execution!.end?.code, 'EXECUTION_TIMEOUT');
  assert.deepEqual([spec.attempt, spec.state, spec.failure?.code, spec.cessation, spec.charge, spec.notRetried?.code],
    [2, 'failed', 'RETRY_NOT_LAUNCHED', 'never-started', null, 'RETRY_NOT_LAUNCHED']);
  assert.deepEqual([h.shown!.budget!.recoveries.reserved, h.shown!.budget!.recoveries.consumed], [null, 0]);
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1'], 'never launched');
});

test('review MED 3 / ticket 57: both reviewers failing at once are BOTH re-obtained, each with its own first-retry wait (5 s), never dropped', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (_role, _round, attempt) => attempt === 1 ? 'fail' : 'clean' });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual([round.reviewers.standards.attempt, round.reviewers.spec.attempt, round.reviewers.standards.notRetried ?? null, round.reviewers.spec.notRetried ?? null], [2, 2, null, null]);
  assert.deepEqual([round.conclusion, h.shown!.budget!.recoveries.consumed, h.shown!.budget!.recoveries.reserved], ['clean', 0, null]);
  assert.deepEqual(h.execution.sleeps, [5000, 5000]);
});

test('review LOW: the proposal is re-observed right before the launch; a change during the wait is recorded and never reviewed', async t => {
  // Round 1 observations: 1 handoff, 2 retry decision, 3 right before the launch (changed), 4 conclusion.
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean',
    identity: (round, call) => round === 1 && call >= 3 ? '9' : null });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual([round.reviewers.spec.notRetried?.code, round.reviewers.spec.charge, round.applicability], ['PROPOSAL_CHANGED', null, 'invalidated']);
  assert.deepEqual([h.shown!.budget!.recoveries.reserved, h.shown!.budget!.recoveries.consumed], [null, 0]);
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1']);
});

test('review MED 6: a failure inside one role\'s recovery never abandons the sibling: all roles settle, the retry is recorded not launched and the Execution is held', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean',
    clock: { reject: 5000 } });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual([h.work.execution!.state, h.work.execution!.held?.code], ['held', 'REVIEWER_RECOVERY_FAILED']);
  assert.deepEqual([round.reviewers.standards.state, round.reviewers.spec.charge, round.reviewers.spec.notRetried?.code], ['ended', null, 'RETRY_NOT_LAUNCHED']);
  assert.equal(h.shown!.budget!.recoveries.reserved, null);
  assert.equal(h.execution.directives.length, 0, 'nothing is delivered to the suspended Builder');
});

/** Ticket 51: the Execution stopped by REVIEWER_RETRY_LIMIT, once its own boot was stopped and the Execution settled (Slot released). */
const retryLimited = (h: Awaited<ReturnType<typeof harness>>) =>
  h.settle('REVIEWER_RETRY_LIMIT settled', value => value.execution?.state === 'ended' && value.execution.slot.held === false);

test('operator decision 2026-11-15: after 2 failed retries of the same role in the round the Execution stops REVIEWER_RETRY_LIMIT, even with budget left', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'spec' ? 'fail' : 'clean' }, { recoveryLimit: 10 });
  const work = await retryLimited(h);
  const round = work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-spec-r1a2', 'activate-spec-r1a3']);
  assert.deepEqual([round.reviewers.spec.attempt, round.reviewers.spec.notRetried?.code, work.budget!.recoveries.consumed], [3, 'REVIEWER_RETRY_LIMIT', 0]);
  assert.equal(h.execution.directives.length, 0, 'nothing is delivered: the unverified round never reaches the Builder as results');
  // Ticket 51: it never stays held. The own boot (the suspended Builder) is stopped and the Execution settled at once: Slot released, nothing
  // retried automatically, and the Work blocked for the operator's decision, which the impediment names.
  assert.deepEqual([work.execution!.held?.code, work.execution!.end?.outcome, work.execution!.end?.code, work.execution!.end?.cessation],
    ['REVIEWER_RETRY_LIMIT', 'failure', 'REVIEWER_RETRY_LIMIT', 'confirmed']);
  assert.deepEqual(work.execution!.recovery!.map(item => [item.trigger, item.decision, item.code]), [['review-retry-limit', 'blocked', 'REVIEWER_RETRY_LIMIT']]);
  assert.ok(h.execution.kinds.indexOf('stop') > h.execution.kinds.indexOf('end-spec-r1a3'), 'the own boot is stopped after the last reviewer ended');
  assert.equal(work.pendingRecovery, null, 'no automatic recovery');
  const blocked = work.impediments.find(item => item.code === 'RECOVERY_BLOCKED')!;
  assert.ok(blocked.nextStep.includes(`factory resume ${work.work_id} --new-review-round --request-id <id>`) && blocked.nextStep.includes(`factory cancel ${work.work_id}`), blocked.nextStep);
});

test('ticket 51: the operator decides a NEW REVIEW ROUND: one audited, deduplicated decision; the Work comes back through ONE operational recovery that reviews again', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], capturesOf: activation => [capture(activation, '1', true)],
    behaviour: (role, round) => role === 'spec' && round === 1 ? 'fail' : 'clean' }, { recoveryLimit: 10 });
  const work = await retryLimited(h);
  const decide = (request_id: string) => h.control.accept({ request_id, operation: 'resume', work_id: work.work_id, new_review_round: true, origin: 'local-cli' });
  // A plain resume never lifts it; nothing accepts the unverified round.
  const plain = await h.control.accept({ request_id: 'r51-plain', operation: 'resume', work_id: work.work_id, origin: 'local-cli' });
  assert.equal('reason' in plain && plain.reason, 'NOTHING_TO_RESUME');
  const receipt = await decide('r51-round');
  assert.deepEqual(receipt, { kind: 'durable', request_id: 'r51-round', operation: 'resume', work_id: work.work_id, outcome: 'accepted', reason: null, created: null });
  assert.deepEqual(await decide('r51-round'), receipt, 'replay returns the recorded receipt');
  const again = await decide('r51-again');
  assert.deepEqual(['outcome' in again && again.outcome, 'reason' in again && again.reason], ['already-satisfied', 'NEW_REVIEW_ROUND_ALREADY_DECIDED']);
  let after = await h.settle('decision recorded', value => value.pendingRecovery !== null);
  const decision = after.execution!.reviewRetryLimit!;
  assert.deepEqual([decision.decision, decision.request_id, decision.operator], ['new-review-round', 'r51-round', { kind: 'local-administrator' }]);
  assert.deepEqual(after.history.filter(item => item.event === 'review-retry-limit-decided').map(item => 'detail' in item ? item.detail : null), ['r51-round:new-review-round']);
  assert.deepEqual([after.impediments.some(item => item.code === 'RECOVERY_BLOCKED'), after.pendingRecovery!.reason, after.pendingRecovery!.waitSeconds], [false, 'operator-new-review-round', 5]);
  // The persisted wait (5 s: the reviewer retries consumed no recovery, ticket 57) runs on the calendar; then the recovery Execution hands off and is reviewed again.
  h.execution.jumpCalendar(60000);
  after = await h.settle('recovery reviewed and completed', value => value.execution?.executionId !== work.execution!.executionId && value.execution?.end?.outcome === 'completed');
  assert.deepEqual([after.execution!.interruption, after.execution!.charge!.kind, after.budget!.recoveries.consumed],
    [{ previousExecutionId: work.execution!.executionId, reason: 'OPERATIONAL_RECOVERY', code: 'REVIEWER_RETRY_LIMIT' }, 'recovery', 1]);
  const round = after.execution!.review!.rounds[0]!;
  assert.deepEqual([round.round, round.conclusion, round.reviewers.spec.opinion?.conclusion], [2, 'clean', 'clean']);
  assert.ok(activations(h.execution.kinds).includes('activate-spec-r2a1'), 'Spec reviews again in the new round');
  assert.match(h.execution.directives.at(-1)!.prompt, /Round conclusion: clean/);
});

test('ticket 51: the operator CANCELS instead: the decision is recorded and the cancellation ceases at once (nothing held, no Slot, no restart)', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'spec' ? 'fail' : 'clean' }, { recoveryLimit: 10 });
  const work = await retryLimited(h);
  const receipt = await h.control.accept({ request_id: 'r51-cancel', operation: 'cancel', work_id: work.work_id, origin: 'local-cli' });
  assert.equal('outcome' in receipt && receipt.outcome, 'accepted');
  const after = await h.settle('cancellation ceased', value => value.cancellation?.state === 'ceased');
  assert.deepEqual([after.result, after.execution!.reviewRetryLimit?.decision, after.execution!.reviewRetryLimit?.request_id], ['cancelled', 'cancel', 'r51-cancel']);
  assert.deepEqual(after.history.filter(item => item.event === 'review-retry-limit-decided').map(item => 'detail' in item ? item.detail : null), ['r51-cancel:cancel']);
  const round = await h.control.accept({ request_id: 'r51-late', operation: 'resume', work_id: work.work_id, new_review_round: true, origin: 'local-cli' });
  assert.equal('reason' in round && round.reason, 'WORK_CANCELLED', 'a cancel decision is final');
  assert.equal(activations(h.execution.kinds).filter(kind => kind === 'activate-builder').length, 1, 'nothing runs again');
});

test('q28 recipe world: issue #3 (labeled, with the ticket 14 draft PR attached) is held FOREIGN_PULL_REQUEST — no Work, no Slot — and only #6 runs; the oracle reads #6', async t => {
  const remote: Remote = { issues: [remoteIssue(3), remoteIssue(6)], pulls: { 3: [foreignPull(5, { state: 'open' })] } };
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean' }, {},
    { remote, ticket: 6 });
  assert.deepEqual(h.list.works.map(item => item.ticket.number), [6], 'the held Ticket never becomes a Work (nothing reserved, no Slot)');
  const held = h.list.polling.repositories[0]!.candidates!.find(item => item.ticket.number === 3)!;
  assert.deepEqual([held.outcome, held.outcome === 'held' && held.holds[0]!.code], ['held', 'FOREIGN_PULL_REQUEST']);
  assert.deepEqual([h.work.execution!.state, h.work.execution!.slot.held, h.work.execution!.review!.rounds[0]!.reviewers.spec.attempt], ['ended', false, 2]);
  // The recipe selects ITS Ticket by number and repository id; another Work (or none) never feeds the verdict.
  const mine = recipeWork(h.list.works.map(item => ({ ...item, ticket: { ...item.ticket, repositoryId: 1256893534 } })));
  assert.equal(mine?.ticket.number, 6);
  assert.equal(recipeWork([{ ...h.work, ticket: { ...h.work.ticket, number: 3, repositoryId: 1256893534 } }]), undefined);
  assert.equal(verdict(h.work.execution!, h.shown!.budget).checks.find(item => item.name === 'execution-ended')!.ok, true);
});
