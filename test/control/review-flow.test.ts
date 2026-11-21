import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import type { ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { HandoffEvent, Invocation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clock, Sandbox lifecycle/identity, Workers (Builder and
// reviewers) and credentials. Not evidence of a real VM, worker, model or reviewer.
type Call = { kind: string; at: number; detail?: unknown };
const summary = (overrides: Partial<ProposalHandoff> = {}): ProposalHandoff => ({
  version: 1,
  round: 1,
  index: '/artifacts/review/r1/index.json',
  indexSha256: 'e'.repeat(64),
  head: 'b'.repeat(40),
  branch: 'factory/3-x',
  base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40),
  counts: { entries: 3, committed: 1, staged: 1, unstaged: 1, untracked: 1, removed: 1 },
  patches: {
    committed: { path: '/artifacts/review/r1/committed.patch', bytes: 10, sha256: 'c'.repeat(64) },
    staged: { path: '/artifacts/review/r1/staged.patch', bytes: 5, sha256: 'c'.repeat(64) },
    unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 5, sha256: 'c'.repeat(64) },
  },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) },
  instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/a.ts'],
  changedTruncated: false,
  ...overrides,
});
const identity = (sha: string): ProposalIdentity => ({
  status: 'observed',
  sha256: sha.repeat(64),
  indexSha256: 'e'.repeat(64),
  entries: 3,
  consistent: true,
  observedAt: new Date().toISOString(),
});
const opinion = (invocation: Invocation, conclusion: ReviewOpinion['conclusion'] = 'clean'): ReviewOpinion => ({
  version: 1,
  role: invocation.context.role as 'spec',
  round: 1,
  attempt: 1,
  invocationId: invocation.context.invocationId,
  reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' },
  session: { file: '/r/session.jsonl' },
  model: { providerId: 'openai', modelId: 'gpt-6-luna' },
  profile: { id: 'p', modelBudget: 'reviewer-v1' },
  input: { handoffIndexSha256: invocation.review!.handoffIndexSha256, required: [...invocation.review!.required], missing: [...invocation.review!.missing] },
  conclusion,
  code: null,
  coverage: { scope: 'broad', justification: 'all', examined: [] },
  findings:
    conclusion === 'findings'
      ? [
          {
            id: 'F1',
            basis: invocation.context.role === 'spec' ? 'requirement' : 'heuristic',
            reference: 'r',
            location: { path: '/workspace/checkout/a.ts', line: 3 },
            summary: 's',
          },
        ]
      : [],
  limitations: [],
  hostChecks: { reads: 3, failedReads: [], requiredNotFullyRead: [], downgraded: [] },
  finalMessageSha256: 'f'.repeat(64),
  recordedAt: new Date().toISOString(),
});

type Options = {
  handoff?: HandoffEvent;
  reviewer?: Partial<Record<'standards' | 'spec', 'clean' | 'findings' | 'fail' | 'throw' | 'uncertain' | 'reject' | 'foreign'>>;
  identities?: ProposalIdentity[];
  gate?: Partial<Record<'standards' | 'spec', Promise<void>>>;
  delivery?: { status: 'failure'; code: string };
};

function doubles(control: () => Control, options: Options = {}) {
  const calls: Call[] = [];
  const snapshots: Record<string, unknown> = {};
  const invocations: Invocation[] = [];
  const identities = [...(options.identities ?? [identity('1'), identity('1')])];
  let finishBuilder: (() => void) | undefined;
  const firstWork = async () =>
    ((await control().inspect({ kind: 'list' })) as ListView).works.find(work => work.execution && work.execution.state !== 'released');
  const receipt = (invocation: Invocation) => ({
    receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
  });
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true },
    reviews: { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 } },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', at: calls.length });
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: false,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        calls.push({ kind: 'start', at: calls.length });
        return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never };
      },
      async stop() {
        calls.push({ kind: 'stop', at: calls.length });
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
      async observeProposal(input) {
        calls.push({ kind: 'observe-proposal', at: calls.length, detail: input });
        return identities.shift() ?? { status: 'unavailable', code: 'X' };
      },
    },
    credentials: {
      async issue() {
        calls.push({ kind: 'issue', at: calls.length });
        return {
          delivery: { token: 'ghs_synthetic' },
          metadata: {
            role: 'builder',
            purpose: 'builder-start',
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions: { metadata: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push({ kind: 'revoke', at: calls.length });
        return { kind: 'not-attempted', nextStep: 'ticket 20' };
      },
    },
    workers: {
      async deliver(worker, directive) {
        calls.push({ kind: 'deliver', at: calls.length, detail: directive });
        if (directive.kind !== 'review-results' || !worker.startsWith('builder-')) return { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' };
        snapshots.deliver = await firstWork();
        if (options.delivery) return options.delivery;
        finishBuilder?.();
        return { status: 'delivered' as const };
      },
      async activate(invocation, delivery) {
        const role = invocation.context.role;
        invocations.push(invocation);
        calls.push({ kind: `activate-${role}`, at: calls.length, detail: { delivery } });
        if (role === 'builder') {
          let finish!: () => void;
          const done = new Promise<void>(resolve => {
            finish = resolve;
          });
          let pending: HandoffEvent | null = options.handoff ?? { round: 1, status: 'captured', summary: summary() };
          finishBuilder = finish;
          return {
            worker: invocation.context.invocationId,
            started: Promise.resolve(receipt(invocation)),
            completed: done.then(() => ({ status: 'success' as const, receipt: receipt(invocation).receipt })),
            handoffs: {
              async next() {
                const event = pending;
                pending = null;
                if (!event) await done;
                return event;
              },
            },
            close() {
              calls.push({ kind: 'close-builder', at: calls.length });
            },
          };
        }
        snapshots[`activate-${role}`] = ((await control().inspect({ kind: 'list' })) as ListView).slots;
        const behaviour = options.reviewer?.[role as 'spec'] ?? 'clean';
        if (behaviour === 'throw') throw new Error('WORKER_LAUNCH_INVALID');
        if (behaviour === 'uncertain') throw new Error('WORKER_LAUNCH_UNCERTAIN');
        if (behaviour === 'reject')
          return {
            worker: invocation.context.invocationId,
            started: Promise.resolve(receipt(invocation)),
            completed: Promise.reject(new Error('WORKER_EXECUTION_UNCERTAIN')),
            close() {
              calls.push({ kind: `close-${role}`, at: calls.length });
            },
          };
        const completed = (options.gate?.[role as 'spec'] ?? Promise.resolve()).then(() => {
          calls.push({ kind: `completed-${role}`, at: calls.length });
          if (behaviour === 'fail') return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
          const value = opinion(invocation, behaviour === 'findings' ? 'findings' : 'clean');
          return {
            status: 'success' as const,
            receipt: receipt(invocation).receipt,
            opinion: behaviour === 'foreign' ? { ...value, role: role === 'spec' ? ('standards' as const) : ('spec' as const) } : value,
          };
        });
        return {
          worker: invocation.context.invocationId,
          started: Promise.resolve(receipt(invocation)),
          completed,
          close() {
            calls.push({ kind: `close-${role}`, at: calls.length });
          },
        };
      },
    },
  };
  return { ports, calls, snapshots, invocations };
}

async function harness(t: { after(fn: () => Promise<void>): void }, options: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  let control: Control | undefined;
  const execution = doubles(() => control!, options);
  const time = manualClock();
  control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    stop.abort();
    await running;
  });
  const work = async () => ((await control!.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView | undefined;
  const until = async (predicate: (work: WorkView | undefined) => boolean) => {
    await untilHolds('condition', async () => predicate(await work()), 5);
    return (await work())!;
  };
  return { execution, work, until, time };
}
const ended = (work: WorkView | undefined) => work?.execution?.slot.held === false || work?.execution?.state === 'held';

test('AC1/AC3/AC4/AC5: handoff -> durable round -> Standards and Spec in parallel in the SAME Execution/Slot/boot -> durable opinions -> delivery to the Builder', async t => {
  const h = await harness(t);
  const work = await h.until(ended);
  const execution = work.execution!;
  const kinds = h.execution.calls.map(call => call.kind);
  assert.deepEqual(kinds.slice(0, 5), ['prepare', 'start', 'issue', 'activate-builder', 'observe-proposal']);
  // Parallel: both reviewers are activated before either completes; the Builder gets nothing until both ended and the round concluded.
  assert.ok(kinds.indexOf('activate-spec') < kinds.indexOf('completed-standards') && kinds.indexOf('activate-standards') < kinds.indexOf('completed-spec'));
  assert.ok(
    Math.max(kinds.indexOf('close-standards'), kinds.indexOf('close-spec')) < kinds.indexOf('deliver'),
    'reviewer activity closed before the Builder resumes',
  );
  assert.equal(kinds.filter(kind => kind === 'observe-proposal').length, 2);
  assert.ok(kinds.lastIndexOf('observe-proposal') < kinds.indexOf('deliver'));
  assert.deepEqual(kinds.slice(-3), ['close-builder', 'revoke', 'stop']);
  // Shared Slot/clock: one Slot held for the whole Execution, none added for the reviewers.
  assert.deepEqual(h.execution.snapshots['activate-standards'], { capacity: 1, held: 1 });
  assert.deepEqual(h.execution.snapshots['activate-spec'], { capacity: 1, held: 1 });
  const [builder, ...reviewers] = h.execution.invocations;
  assert.deepEqual(builder!.handoff, { baseCommit: 'a'.repeat(40) });
  assert.match(builder!.prompt, /reviews=factory-handoff/);
  for (const reviewer of reviewers) {
    const role = reviewer.context.role as 'spec' | 'standards';
    assert.deepEqual(
      { ...reviewer.context },
      {
        workId: work.work_id,
        executionId: execution.executionId,
        invocationId: `${role}-${execution.executionId}-r1a1`,
        role,
        environmentRef: `env-${'c'.repeat(64)}`,
        bootRef: 'boot-11111111-2222-4333-8444-555555555555',
        phaseId: 'review-r1',
      },
    );
    assert.deepEqual(
      [reviewer.modelBudget, reviewer.imageSourceMaxBytes, reviewer.skillPack, reviewer.copyOutput, reviewer.handoff],
      ['reviewer-v1', 5242880, undefined, undefined, undefined],
    );
    assert.equal(
      (h.execution.calls.find(call => call.kind === `activate-${role}`)!.detail as { delivery: unknown }).delivery,
      undefined,
      'no credential/token for reviewers',
    );
    assert.deepEqual(reviewer.review, {
      round: 1,
      attempt: 1,
      handoffIndexSha256: 'e'.repeat(64),
      missing: [],
      required: [
        '/artifacts/review/r1/index.json',
        role === 'spec' ? '/artifacts/spec/v1/sources.json' : '/artifacts/instructions/v1/sources.json',
        '/artifacts/review/r1/committed.patch',
        '/artifacts/review/r1/staged.patch',
        '/artifacts/review/r1/unstaged.patch',
        '/workspace/checkout/a.ts',
      ],
    });
    assert.match(reviewer.prompt, role === 'spec' ? /preserved request/ : /"heuristic", never presented as a violation/);
    assert.match(reviewer.prompt, /ONLY the read tool/);
  }
  const round = execution.review!.rounds[0]!;
  assert.deepEqual([round.round, round.attempt, round.state, round.conclusion, round.applicability], [1, 1, 'delivered', 'clean', 'current']);
  assert.deepEqual(round.handoff.summary!.counts, { entries: 3, committed: 1, staged: 1, unstaged: 1, untracked: 1, removed: 1 });
  assert.deepEqual(
    [round.versions.spec!.version, round.versions.instructions!.version, round.versions.base, round.versions.head],
    ['v1', 'v1', 'a'.repeat(40), 'b'.repeat(40)],
  );
  assert.deepEqual(round.versions.profile.skillPack, { name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64) });
  assert.deepEqual(round.versions.profile.reviewer, { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 });
  assert.deepEqual([round.identity.before?.status, round.identity.after?.status], ['observed', 'observed']);
  for (const role of ['standards', 'spec'] as const) {
    assert.deepEqual(
      [round.reviewers[role].state, round.reviewers[role].opinion!.conclusion, round.reviewers[role].receiptId],
      ['ended', 'clean', '99999999-2222-4333-8444-555555555555'],
    );
  }
  // Durable BEFORE the notification to the Builder: at delivery time the round was concluded with both opinions and an intent.
  const atDeliver = (h.execution.snapshots.deliver as WorkView).execution!.review!.rounds[0]!;
  assert.deepEqual(
    [atDeliver.state, atDeliver.conclusion, atDeliver.delivery!.outcome, !!atDeliver.reviewers.spec.opinion, !!atDeliver.reviewers.standards.opinion],
    ['concluded', 'clean', 'requested', true, true],
  );
  const directive = h.execution.calls.find(call => call.kind === 'deliver')!.detail as { kind: string; round: number; prompt: string };
  assert.deepEqual([directive.kind, directive.round], ['review-results', 1]);
  assert.match(directive.prompt, /FACTORY REVIEW RESULTS — round 1\. Round conclusion: clean; applicability: current/);
  assert.deepEqual([execution.state, execution.end!.outcome, execution.slot.held, execution.completion.automatic], ['ended', 'completed', false, false]);
  assert.deepEqual(
    work.history.filter(item => item.origin === 'controller-dispatch').map(item => item.event),
    [
      'execution-reserved',
      'execution-prepared',
      'execution-booted',
      'activation-requested',
      'execution-started',
      'review-handoff',
      'reviewer-started',
      'reviewer-started',
      'reviewer-ended',
      'reviewer-ended',
      'review-concluded',
      'review-delivered',
      'execution-ended',
      'slot-released',
    ],
  );
});

test('AC3: the Builder stays suspended until BOTH reviewers ended, whichever finishes first', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const h = await harness(t, { gate: { spec: gate } });
  await h.until(work => work?.execution?.review?.rounds[0]?.reviewers.standards.state === 'ended');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    h.execution.calls.some(call => call.kind === 'deliver'),
    false,
    'no delivery while Spec is still active',
  );
  assert.equal((await h.work())!.execution!.review!.rounds[0]!.state, 'reviewing');
  release();
  const work = await h.until(ended);
  assert.equal(work.execution!.review!.rounds[0]!.state, 'delivered');
});

test('AC6: an unavailable reviewer and a failed one are recorded explicitly, never retried nor read as zero findings; Spec is never omitted', async t => {
  const h = await harness(t, { reviewer: { standards: 'throw', spec: 'fail' } });
  const work = await h.until(ended);
  const round = work.execution!.review!.rounds[0]!;
  assert.deepEqual(
    [round.reviewers.standards.state, round.reviewers.standards.failure, round.reviewers.spec.state, round.reviewers.spec.failure],
    ['failed', { code: 'REVIEWER_UNAVAILABLE' }, 'failed', { code: 'WORKER_INTERRUPTED' }],
  );
  assert.deepEqual([round.conclusion, round.reasons], ['incomplete', ['STANDARDS_OPINION_MISSING', 'SPEC_OPINION_MISSING']]);
  assert.equal(h.execution.calls.filter(call => call.kind === 'activate-spec').length, 1, 'no automatic retry');
  assert.equal(h.execution.calls.filter(call => call.kind === 'activate-standards').length, 1);
  const directive = h.execution.calls.find(call => call.kind === 'deliver')!.detail as { prompt: string };
  assert.match(directive.prompt, /"code": "REVIEWER_UNAVAILABLE"/);
  assert.match(directive.prompt, /"code": "WORKER_INTERRUPTED"/);
  assert.match(directive.prompt, /NOT zero findings/);
});

test('AC7: a proposal change observed during the analysis invalidates the applicability: two clean opinions do not make a clean round', async t => {
  const h = await harness(t, { identities: [identity('1'), identity('2')] });
  const round = (await h.until(ended)).execution!.review!.rounds[0]!;
  assert.deepEqual([round.reviewers.spec.opinion!.conclusion, round.reviewers.standards.opinion!.conclusion], ['clean', 'clean']);
  assert.deepEqual([round.applicability, round.conclusion, round.reasons], ['invalidated', 'incomplete', ['PROPOSAL_CHANGED_DURING_REVIEW']]);
});

test('AC6: a failed handoff capture starts no reviewer but records both explicitly; findings and a foreign opinion are kept distinct', async t => {
  const failed = await harness(t, { handoff: { round: 1, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED', detail: 'GIT_FAILED:git-head' } });
  const round = (await failed.until(ended)).execution!.review!.rounds[0]!;
  assert.equal(
    failed.execution.calls.some(call => call.kind.startsWith('activate-s')),
    false,
  );
  assert.deepEqual(
    [round.reviewers.spec.failure, round.reviewers.standards.failure, round.conclusion],
    [{ code: 'HANDOFF_UNAVAILABLE' }, { code: 'HANDOFF_UNAVAILABLE' }, 'incomplete'],
  );
  assert.equal(round.reasons[0], 'HANDOFF_HANDOFF_CAPTURE_FAILED');
  assert.deepEqual([round.handoff.code, round.handoff.detail], ['HANDOFF_CAPTURE_FAILED', 'GIT_FAILED:git-head'], 'real-run fix 2: the cause is recorded');
  const mixed = await harness(t, {
    reviewer: { standards: 'findings', spec: 'foreign' },
    handoff: { round: 1, status: 'captured', summary: summary({ spec: null }) },
  });
  const second = (await mixed.until(ended)).execution!.review!.rounds[0]!;
  assert.deepEqual(second.reviewers.spec.input.missing, ['spec-version'], 'no preserved request: Spec still runs, with insufficient context declared');
  assert.deepEqual([second.reviewers.spec.failure, second.reviewers.standards.opinion!.findings[0]!.basis], [{ code: 'OPINION_NOT_CORRELATED' }, 'heuristic']);
  assert.equal(second.conclusion, 'incomplete');
});

test('review fix 4: a reviewer whose launch or outcome is uncertain holds the round: no delivery, the Builder stays suspended', async t => {
  for (const behaviour of ['uncertain', 'reject'] as const) {
    const h = await harness(t, { reviewer: { spec: behaviour } });
    const work = await h.until(ended);
    assert.equal(work.execution!.state, 'held');
    assert.equal(work.execution!.held!.code, 'REVIEWER_CESSATION_UNCONFIRMED');
    assert.equal(work.execution!.slot.held, true, 'Slot kept');
    assert.equal(work.execution!.review!.rounds[0]!.reviewers.spec.cessation, 'unconfirmed');
    const directives = h.execution.calls.filter(call => call.kind === 'deliver').map(call => (call.detail as { kind: string }).kind);
    assert.deepEqual(directives, ['withdraw-credential'], `${behaviour}: no review results; the hold withdraws the Builder credential (ticket 20)`);
  }
});

test('review fix 5: a host-read index differing from the handoff summary starts no reviewer and the round is incomplete', async t => {
  const h = await harness(t, { identities: [{ ...identity('1'), indexSha256: 'd'.repeat(64) } as ProposalIdentity] });
  const round = (await h.until(ended)).execution!.review!.rounds[0]!;
  assert.equal(
    h.execution.calls.some(call => call.kind.startsWith('activate-s')),
    false,
  );
  assert.deepEqual([round.reviewers.spec.failure, round.conclusion], [{ code: 'PROPOSAL_INDEX_MISMATCH' }, 'incomplete']);
});

test('review fix 9: an unconfirmed delivery is recorded as uncertain (not failed) and the Execution is held', async t => {
  const h = await harness(t, { delivery: { status: 'failure', code: 'DELIVERY_UNCONFIRMED' } });
  const work = await h.until(ended);
  assert.deepEqual(
    [work.execution!.state, work.execution!.held!.code, work.execution!.review!.rounds[0]!.delivery!.outcome],
    ['held', 'REVIEW_DELIVERY_UNCERTAIN', 'uncertain'],
  );
  const refused = await harness(t, { delivery: { status: 'failure', code: 'DELIVERY_DENIED' } });
  const second = await refused.until(ended);
  assert.deepEqual([second.execution!.held!.code, second.execution!.review!.rounds[0]!.delivery!.outcome], ['REVIEW_DELIVERY_FAILED', 'failed']);
});
