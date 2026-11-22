import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ControlReceipt, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import type { ProposalHandoff, ReviewOpinion } from '../../src/contracts/index.js';
import type { BuilderDirective, HandoffEvent, Invocation, WorkerQuestion } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { until } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite; doubled GitHub, clock, Sandbox, Workers and credentials. Ticket 13 AC1:
// a requirement doubt about a finding goes through ask_user; the recovery Execution continues the round numbering of the Work and the
// non-adoption references the ANSWERED Question as its concrete authorization, which Control correlates (presence, Work, state).
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000013';
const summary = (round: number, content: string): ProposalHandoff => ({
  version: 1,
  round,
  index: `/artifacts/review/r${round}/index.json`,
  indexSha256: `${round}${content}`.padEnd(64, '0'),
  head: 'b'.repeat(40),
  branch: 'factory/3-x',
  base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40),
  counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: {
    committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 4, sha256: 'c'.repeat(64) },
  },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) },
  instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'],
  changedTruncated: false,
  content: { sha256: content.repeat(64), clean: false, headMatches: false },
});
const passed = {
  id: 'docs',
  source: '/artifacts/spec/v1/ticket.json#validation',
  command: 'test -f docs/a.md',
  cwd: '/workspace/checkout',
  requiredCheck: null,
  declared: 'run' as const,
  outcome: 'passed' as const,
  code: null,
  exitCode: 0,
  output: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' },
  sequence: 2,
  current: true,
  reason: null,
  authorization: null,
};
type Activation = { captures: HandoffEvent[]; ask?: boolean };

const notAdopted = (round: number) => ({
  round,
  role: 'spec' as const,
  findingId: 'S1',
  outcome: 'not-adopted' as const,
  justification: 'The operator answered that the Ticket does not require it.',
  evidence: null,
  authorization: { kind: 'question' as const, questionId: qid },
});

async function scenario(t: { after(fn: () => Promise<void>): void }, partialRecovery: boolean, treatInherited = false) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review13q-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const builders: Invocation[] = [];
  const directives: BuilderDirective[] = [];
  const activations: Activation[] = [
    { captures: [{ round: 1, status: 'captured', summary: summary(1, '1'), declarations: { treatments: [], gates: [passed] } }], ask: true },
    // Real run R-CAND v2: a continued session may first treat the finding its predecessor delivered (round 1) with the answered Question.
    {
      captures: [
        { round: 2, status: 'captured', summary: summary(2, '1'), declarations: { treatments: treatInherited ? [notAdopted(1)] : [], gates: [passed] } },
        { round: 3, status: 'captured', summary: summary(3, '1'), declarations: { gates: [passed], treatments: [notAdopted(2)] } },
        { round: 4, status: 'captured', summary: summary(4, '1'), closing: true },
      ],
    },
  ];
  const allCaptures = activations.flatMap(item => item.captures);
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v3', modelBudget: 'builder-v1', copyOutput: true },
    reviews: {
      reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 },
      rounds: { max: 4 },
      ...(partialRecovery ? { partialRecovery: true } : {}),
    },
    sandbox: {
      async prepare(input) {
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v3', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: builders.length > 0,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(builders.length + 1).padStart(12, '5')}` as never };
      },
      async stop() {
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
      async observeProposal(input) {
        const event = allCaptures.find(item => item.round === input.round)!;
        return {
          status: 'observed',
          sha256: '7'.repeat(64),
          indexSha256: event.status === 'captured' ? event.summary.indexSha256 : '',
          entries: 1,
          consistent: true,
          observedAt: new Date().toISOString(),
        };
      },
    },
    credentials: {
      async issue() {
        return {
          delivery: { token: 'ghs_synthetic13' },
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
        return { kind: 'not-attempted', nextStep: 'ticket 20' };
      },
    },
    workers: {
      async deliver(_worker, directive) {
        if (directive.kind !== 'review-results') return { status: 'withdrawn' as const };
        directives.push(directive);
        delivered?.(directive);
        return { status: 'delivered' as const };
      },
      async activate(invocation, _delivery, events) {
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({
          receipt,
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        if (invocation.context.role !== 'builder') {
          const findings = invocation.context.role === 'spec' ? ['S1'] : [];
          const opinion: ReviewOpinion = {
            version: 1,
            role: invocation.context.role,
            round: invocation.review!.round,
            attempt: 1,
            invocationId: invocation.context.invocationId,
            reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' },
            session: { file: null },
            model: { providerId: 'openai', modelId: 'gpt-6-luna' },
            profile: { id: 'p', modelBudget: 'reviewer-v1' },
            input: { handoffIndexSha256: invocation.review!.handoffIndexSha256, required: [], missing: [] },
            conclusion: findings.length ? 'findings' : 'clean',
            code: null,
            coverage: { scope: 'broad', justification: 'all', examined: [] },
            findings: findings.map(id => ({
              id,
              basis: 'requirement' as const,
              reference: '/artifacts/spec/v1/ticket.json#body',
              location: { path: '/workspace/checkout/docs/a.md' },
              summary: 'Missing section?',
            })),
            limitations: [],
            hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] },
            finalMessageSha256: null,
            recordedAt: new Date().toISOString(),
          };
          return { worker: invocation.context.invocationId, started, completed: Promise.resolve({ status: 'success' as const, receipt, opinion }), close() {} };
        }
        builders.push(invocation);
        const script = activations.shift()!;
        const queue = [...script.captures];
        let finish!: (value: 'done' | 'ask') => void;
        const done = new Promise<'done' | 'ask'>(resolve => {
          finish = resolve;
        });
        let waiting: Promise<BuilderDirective> | null = null;
        const completed = done.then(async outcome => {
          if (outcome === 'done') return { status: 'success' as const, receipt };
          const text = 'Spec finding S1 asks for a Rollback section; is it a requirement of the Ticket?';
          const question: WorkerQuestion = {
            questionId: qid,
            question: text,
            context: '',
            sha256: createHash('sha256')
              .update(JSON.stringify({ question: text, context: '' }))
              .digest('hex'),
            reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' },
          };
          const ack = await events!.question!(question);
          return { status: 'question' as const, receipt, question: { ...question, acknowledged: ack.status === 'recorded' } };
        });
        return {
          worker: invocation.context.invocationId,
          started,
          completed,
          close() {},
          handoffs: {
            async next() {
              if (waiting) {
                const directive = await waiting;
                if (directive.end) {
                  finish('done');
                  return null;
                }
              }
              const event = queue.shift();
              if (!event) {
                finish(script.ask ? 'ask' : 'done');
                return null;
              }
              waiting = new Promise(resolve => {
                delivered = resolve;
              });
              return event;
            },
          },
        };
      },
    },
  };
  const time = manualClock();
  const control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    stop.abort();
    await running;
  });
  const work = async () => ((await control!.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView | undefined;
  const settle = async (predicate: (value: WorkView | undefined) => boolean) => {
    return await until(
      'condition',
      async () => {
        const value = await work();
        if (predicate(value)) return value!;
        if (time.isSleeping()) time.advance();
        return undefined;
      },
      5,
    );
  };
  const waiting = await settle(value => value?.execution?.end?.outcome === 'question' && value.execution.slot.held === false);
  assert.equal(waiting.execution!.review!.verification ?? null, null, 'an Execution waiting for an answer is not verified');
  const receipt = (await control.accept({
    request_id: 'cli-13',
    operation: 'answer',
    question_id: qid,
    text: 'Not required: keep the section out.',
    origin: 'local-cli',
  })) as ControlReceipt;
  assert.equal(receipt.kind === 'durable' && receipt.operation === 'answer' && receipt.outcome, 'accepted');
  const resumed = await settle(value => value?.execution?.mode === 'recovery' && value.execution.slot.held === false);
  assert.deepEqual(
    builders.map(item => item.handoff),
    [
      { baseCommit: 'a'.repeat(40), rounds: { first: 1, max: 4 } },
      { baseCommit: 'a'.repeat(40), rounds: { first: 2, max: 4, delivered: [{ round: 1, standards: [], spec: ['S1'] }] } },
    ],
    'the recovery continues the Work round numbering (earlier /artifacts/review/r<N> are preserved) and its handoff knows the findings delivered before the Question',
  );
  assert.match(builders[1]!.prompt, /reviews=factory-handoff review-rounds=multi/);
  const rounds = resumed.execution!.review!.rounds;
  assert.equal(resumed.execution!.review!.firstRound, 2);
  assert.deepEqual(
    rounds.map(item => [item.round, item.kind, item.exemption?.kind ?? null]),
    [
      [2, 'review', null],
      [3, 'exemption', 'unchanged'],
      [4, 'exemption', 'unchanged'],
    ],
  );
  const verification = resumed.execution!.review!.verification!;
  assert.deepEqual([verification.status, verification.reasons], ['verified', []]);
  assert.deepEqual(
    verification.treatments,
    [
      ...(treatInherited ? [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'not-adopted' }] : []),
      { round: 2, role: 'spec', findingId: 'S1', outcome: 'not-adopted' },
    ],
    'an untreated inherited finding is not owed (round 2 reviewed it again)',
  );
  assert.deepEqual(
    directives.map(item => [item.round, item.end ?? false]),
    [
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ],
  );
  return { builders };
}

test('AC1: a requirement doubt is asked; the recovery continues the round numbers and the non-adoption is authorized by the answered Question', async t => {
  const { builders } = await scenario(t, false);
  assert.doesNotMatch(builders[1]!.prompt, /PRESERVED REVIEW STATE/, 'tickets 12/13 composition: unchanged prompt');
});

test('ticket 28 AC6: the substitute session receives the preserved review state as context only (delivery is not consumption); both review again', async t => {
  const { builders } = await scenario(t, true);
  const prompt = builders[1]!.prompt;
  assert.match(
    prompt,
    /PRESERVED REVIEW STATE of the previous Execution — round 1 \(delivered; conclusion findings; delivery to the previous Builder session: delivered, not proof that it was consumed\)/,
  );
  assert.match(prompt, /"role":"spec","conclusion":"findings","findings":\[\{"id":"S1"/);
  assert.match(
    prompt,
    /the Factory obtains new opinions of both reviewers; treat the findings of the results it then delivers to you \(their round\), never these/,
  );
});

test('real run R-CAND v2: the continuation treats the finding delivered before the Question; Control knows it (no TREATMENT_UNKNOWN_FINDING)', async t => {
  await scenario(t, false, true);
});
