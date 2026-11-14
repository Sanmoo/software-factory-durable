import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import type { ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { BuilderDirective, HandoffEvent, Invocation, OpinionObservation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

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
type Behaviour = 'clean' | 'fail' | 'invalid' | 'lost' | 'lost-unreadable' | 'config' | string[];
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

function doubles(script: { captures: HandoffEvent[]; behaviour: (role: Role, round: number, attempt: number) => Behaviour;
  /** The Host identity of round N at its k-th observation (default: the capture's content). */ identity?: (round: number, call: number) => string | null }) {
  const directives: BuilderDirective[] = [];
  const invocations: Invocation[] = [];
  const kinds: string[] = [];
  const sleeps: number[] = [];
  const records = new Map<string, ReviewOpinion>();
  const observations = new Map<number, number>();
  const identity = (round: number): ProposalIdentity => {
    const call = (observations.get(round) ?? 0) + 1;
    observations.set(round, call);
    const event = script.captures.find(item => item.round === round);
    const content = script.identity?.(round, call) ?? (event?.status === 'captured' ? event.summary.content?.sha256 ?? 'x' : 'x');
    return { status: 'observed', sha256: content.slice(0, 64), indexSha256: event?.status === 'captured' ? event.summary.indexSha256 : '',
      entries: 1, consistent: true, observedAt: new Date().toISOString() };
  };
  const receipt = (invocation: Invocation) => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: 1, builder: { skillPack: 'factory-skills-v3', modelBudget: 'builder-v1', copyOutput: true },
    reviews: { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 }, rounds: { max: 4 }, partialRecovery: true },
    // Retry waits are recorded, not slept: the persisted 5/15/45 s schedule is asserted on the requested durations.
    clock: { monotonic: () => performance.now(), async sleep(ms) { sleeps.push(ms); kinds.push(`sleep-${ms}`); } },
    sandbox: {
      async prepare(input) {
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v3', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: false, preparedAt: new Date().toISOString() } };
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
          const queue = [...script.captures];
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
  return { ports, directives, invocations, kinds, sleeps };
}

async function harness(t: { after(fn: () => Promise<void>): void }, script: Parameters<typeof doubles>[0], limits: { recoveryLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review28-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const execution = doubles(script);
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [{ ...scope, ...limits }] }, polling: { intervalSeconds: 60, clock: manualClock().clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView | undefined;
  for (let i = 0; i < 800; i++) {
    const current = await work();
    if (current?.execution?.slot.held === false || current?.execution?.state === 'held') {
      const shown = await control.inspect({ kind: 'show', work_id: current.work_id });
      return { execution, work: current, shown: 'work' in shown ? shown.work : undefined };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('condition not reached');
}
const activations = (kinds: string[]) => kinds.filter(kind => kind.startsWith('activate-'));

test('AC3/AC4/AC5: a failed Spec reviewer is re-obtained alone in the same round; the valid Standards opinion is kept; one recovery unit with the 5 s wait', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt === 1 ? 'fail' : 'clean' });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-spec-r1a2'], 'Standards is never rerun');
  assert.deepEqual([round.conclusion, round.applicability, round.reasons], ['clean', 'current', []]);
  const spec = round.reviewers.spec;
  assert.deepEqual([spec.attempt, spec.invocationId, spec.opinion?.attempt, spec.opinion?.invocationId, spec.source], [2, `spec-${h.work.execution!.executionId}-r1a2`, 2, spec.invocationId, 'notification']);
  assert.deepEqual(spec.attempts?.map(item => [item.attempt, item.invocationId.endsWith('-r1a1'), item.state, item.failure?.code, item.cessation]), [[1, true, 'failed', 'WORKER_INTERRUPTED', 'completion-observed']]);
  assert.deepEqual([spec.charge?.state, spec.retry?.waitSeconds, spec.retry?.after], ['consumed', 5, 'WORKER_INTERRUPTED']);
  assert.deepEqual([round.reviewers.standards.attempt, round.reviewers.standards.attempts, round.reviewers.standards.opinion?.attempt], [undefined, undefined, 1]);
  assert.deepEqual(h.execution.sleeps, [5000], 'the persisted wait of the first operational recovery');
  const budget = h.shown!.budget!.recoveries;
  assert.deepEqual([budget.consumed, budget.reserved, budget.limit], [1, null, 3], 'the existing recoveries counter, no parallel review budget');
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

test('AC4: retries draw only on the existing recoveries counter; exhaustion and non-transient failures stay explicit failures', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'spec' ? 'invalid' : ['H1'] }, { recoveryLimit: 1 });
  const round = h.work.execution!.review!.rounds[0]!;
  assert.deepEqual(activations(h.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1', 'activate-spec-r1a2']);
  assert.deepEqual([round.reviewers.spec.attempt, round.reviewers.spec.opinion?.conclusion, round.reviewers.spec.notRetried?.code], [2, 'failure', 'RECOVERY_LIMIT_REACHED']);
  assert.deepEqual([round.conclusion, round.reasons], ['incomplete', ['SPEC_FAILURE', 'SPEC_NOT_RETRIED:RECOVERY_LIMIT_REACHED']]);
  assert.deepEqual([h.shown!.budget!.recoveries.consumed, h.shown!.budget!.recoveries.reserved], [1, null]);
  assert.equal(round.reviewers.standards.opinion?.findings[0]?.id, 'H1', 'the valid opinion with findings is preserved as is');
  assert.ok(h.shown!.history.some(item => item.event === 'budget-exhausted'));

  const config = await harness(t, { captures: [capture(1, '1', true)], behaviour: role => role === 'spec' ? 'config' : 'clean' });
  const refused = config.work.execution!.review!.rounds[0]!;
  assert.deepEqual([refused.reviewers.spec.failure?.code, refused.reviewers.spec.cessation, refused.reviewers.spec.notRetried?.code], ['REVIEWER_UNAVAILABLE', 'never-started', 'REVIEWER_FAILURE_NOT_TRANSIENT']);
  assert.deepEqual(activations(config.execution.kinds), ['activate-builder', 'activate-standards-r1a1', 'activate-spec-r1a1']);
  assert.equal(config.shown!.budget!.recoveries.consumed, 0);
});

test('AC4: the persisted waits follow the recoveries already consumed (5 then 15 s); a second failure of the same role is retried again within the budget', async t => {
  const h = await harness(t, { captures: [capture(1, '1', true)], behaviour: (role, _round, attempt) => role === 'spec' && attempt < 3 ? 'fail' : 'clean' });
  const spec = h.work.execution!.review!.rounds[0]!.reviewers.spec;
  assert.deepEqual(h.execution.sleeps, [5000, 15000]);
  assert.deepEqual([spec.attempt, spec.attempts?.map(item => item.charge?.state ?? null), spec.charge?.state], [3, [null, 'consumed'], 'consumed']);
  assert.equal(h.shown!.budget!.recoveries.consumed, 2);
  assert.equal(h.work.execution!.review!.rounds[0]!.conclusion, 'clean');
});
