import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import type { GateEvidence, HandoffDeclarations, ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { BuilderDirective, HandoffEvent, Invocation } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { until } from '../runner/budget.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite. Doubled: GitHub, clock, Sandbox lifecycle/identity, Workers (a scripted
// Builder emitting captures, scripted reviewers) and credentials. Ticket 13: repeated rounds, exemptions, session preference, verification.
// Not evidence of a real VM, worker, model, reviewer or gate.
const summary = (round: number, content: string, extra: { head?: string; clean?: boolean } = {}): ProposalHandoff => ({ version: 1, round,
  index: `/artifacts/review/r${round}/index.json`, indexSha256: `${round}${content}`.padEnd(64, '0'), head: (extra.head ?? 'b').repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: { committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 0, sha256: 'c'.repeat(64) }, staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 4, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) }, instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'], changedTruncated: false, content: { sha256: content.repeat(64), clean: extra.clean ?? false, headMatches: extra.clean ?? false } });
const gate = (id: string, outcome: GateEvidence['outcome'], extra: Partial<GateEvidence> = {}): GateEvidence => ({ id, source: '/artifacts/spec/v1/ticket.json#validation',
  command: `check ${id}`, cwd: '/workspace/checkout', requiredCheck: null, declared: 'run', outcome, code: null, exitCode: outcome === 'passed' ? 0 : null,
  output: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' }, sequence: 3, current: true, reason: null, authorization: null, ...extra });
const capture = (round: number, content: string, extra: { head?: string; clean?: boolean; closing?: boolean; declarations?: Partial<HandoffDeclarations> } = {}): HandoffEvent => ({
  round, status: 'captured', summary: summary(round, content, extra), ...(extra.closing ? { closing: true as const } : {}),
  ...(extra.declarations ? { declarations: { treatments: [], gates: [], ...extra.declarations } } : {}) });
type Verdict = 'clean' | 'fail' | string[];

function doubles(control: () => Control, script: { captures: HandoffEvent[]; verdicts: (role: 'standards' | 'spec', round: number) => Verdict; max?: number }) {
  const directives: BuilderDirective[] = [];
  const invocations: Invocation[] = [];
  const kinds: string[] = [];
  const identity = (round: number): ProposalIdentity => {
    const event = script.captures.find(item => item.round === round);
    return { status: 'observed', sha256: `${event?.status === 'captured' ? event.summary.content?.sha256 : 'x'}`.slice(0, 64), indexSha256: event?.status === 'captured' ? event.summary.indexSha256 : '',
      entries: 1, consistent: true, observedAt: new Date().toISOString() };
  };
  const receipt = (invocation: Invocation) => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: 1, builder: { skillPack: 'factory-skills-v3', modelBudget: 'builder-v1', copyOutput: true },
    reviews: { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 }, rounds: { max: script.max ?? 4 } },
    sandbox: {
      async prepare(input) {
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v3', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: false, preparedAt: new Date().toISOString() } };
      },
      async start() { return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never }; },
      async stop() { kinds.push('stop'); return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
      async observeProposal(input) { kinds.push(`observe-r${input.round}`); return identity(input.round); },
      async verifyPreservedSource(input) {
        kinds.push(`verify-source:${input.reference}`);
        // Only the sources listed in the preserved copy count; an unlisted reference is never an authorization.
        return input.reference === '/artifacts/spec/v1/ticket.json' ? { status: 'verified' as const, code: 'PRESERVED_SOURCE_VERIFIED' }
          : { status: 'invalid' as const, code: 'PRESERVED_SOURCE_NOT_LISTED' };
      },
    },
    credentials: {
      async issue() { return { delivery: { token: 'ghs_synthetic' }, metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
        permissions: { metadata: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } }; },
      async revoke() { return { kind: 'not-attempted', nextStep: 'ticket 20' }; },
    },
    workers: {
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
        kinds.push(`activate-${role}${invocation.review ? `-r${invocation.review.round}` : ''}`);
        if (role === 'builder') {
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
        const verdict = script.verdicts(role as 'spec', invocation.review!.round);
        const completed = Promise.resolve().then(() => {
          if (verdict === 'fail') return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
          const findings = verdict === 'clean' ? [] : verdict;
          const opinion: ReviewOpinion = { version: 1, role: role as 'spec', round: invocation.review!.round, attempt: 1, invocationId: invocation.context.invocationId,
            reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' },
            session: { file: `/run/w-${role}${invocation.review!.round}/profile/sessions/s.jsonl`, mode: invocation.review!.continueFrom ? 'continued' : 'new', from: invocation.review!.continueFrom ?? null, code: null },
            model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
            input: { handoffIndexSha256: invocation.review!.handoffIndexSha256, required: [...invocation.review!.required], missing: [...invocation.review!.missing] },
            conclusion: findings.length ? 'findings' : 'clean', code: null, coverage: { scope: 'broad', justification: 'all', examined: [] },
            findings: findings.map(id => ({ id, basis: role === 'spec' ? 'requirement' as const : 'heuristic' as const, reference: 'r', location: { path: '/workspace/checkout/docs/a.md' }, summary: 's' })),
            limitations: [], hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: new Date().toISOString() };
          return { status: 'success' as const, receipt: receipt(invocation).receipt, opinion };
        });
        return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)), completed, close() { kinds.push(`close-${role}`); } };
      },
    },
  };
  return { ports, directives, invocations, kinds };
}

async function harness(t: { after(fn: () => Promise<void>): void }, script: Parameters<typeof doubles>[1]) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-review13-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const execution = doubles(() => control!, script);
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: execution.ports,
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope] }, polling: { intervalSeconds: 60, clock: manualClock().clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  const work = async () => ((await control!.inspect({ kind: 'list' })) as ListView).works.find(item => item.ticket.number === 3) as WorkView | undefined;
  const current = await until('Execution ended or held', async () => {
    const value = await work();
    return value?.execution?.slot.held === false || value?.execution?.state === 'held' ? value : undefined;
  }, 5);
  return { execution, work: current };
}
const fixed = (findingId: string, role: 'spec' | 'standards' = 'spec') => ({ round: 1, role, findingId, outcome: 'fixed' as const, justification: 'Fixed in docs/a.md.', evidence: null, authorization: null });

test('AC1/AC4/AC5/AC6: a fixed finding gets a new round of BOTH reviewers on the changed content (preferring their sessions); an identical commit needs no round; verified', async t => {
  const h = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'failed', { exitCode: 1 })] } }),
    capture(2, '2', { declarations: { treatments: [fixed('S1')], gates: [gate('docs', 'passed')] } }),
    capture(3, '2', { head: 'd', clean: true, closing: true })],
  verdicts: (role, round) => role === 'spec' && round === 1 ? ['S1'] : 'clean' });
  const execution = h.work.execution!;
  assert.equal(execution.state, 'ended');
  const rounds = execution.review!.rounds;
  assert.deepEqual(rounds.map(item => [item.round, item.kind, item.closing, item.state, item.conclusion]),
    [[1, 'review', false, 'delivered', 'findings'], [2, 'review', false, 'delivered', 'clean'], [3, 'exemption', true, 'delivered', 'clean']]);
  assert.deepEqual(rounds[2]!.exemption, { kind: 'identical-commit', reviewedRound: 2, head: 'd'.repeat(40), reviewedHead: 'b'.repeat(40), contentSha256: '2'.repeat(64) });
  assert.deepEqual([rounds[2]!.reviewers.standards.state, rounds[2]!.reviewers.spec.state], ['not-required', 'not-required']);
  assert.deepEqual(rounds[1]!.declarations!.treatments.map(item => [item.findingId, item.outcome]), [['S1', 'fixed']]);
  // Both reviewers ran again after the change, never only the one that had findings; each continued its own round 1 session.
  assert.deepEqual(h.execution.kinds.filter(kind => kind.startsWith('activate-')), ['activate-builder', 'activate-standards-r1', 'activate-spec-r1', 'activate-standards-r2', 'activate-spec-r2']);
  const second = h.execution.invocations.filter(item => item.review?.round === 2);
  assert.deepEqual(second.map(item => [item.context.role, item.review!.continueFrom]), [['standards', '/run/w-standards1/profile/sessions/s.jsonl'], ['spec', '/run/w-spec1/profile/sessions/s.jsonl']]);
  assert.deepEqual(rounds[1]!.reviewers.spec.opinion!.session.mode, 'continued');
  assert.equal(rounds[1]!.reviewers.spec.opinion!.round, 2, 'the round 1 approval/opinion is never reused for round 2');
  // Delivery: results for 1 and 2 (the Builder continues and hands off again), the closing exemption ends the activation.
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.end ?? false]), [[1, false], [2, false], [3, true]]);
  // Real-run regression (q13-rounds-v3): the delivered results list each role's finding ids, so the handoff can refuse placeholders.
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.findings]),
    [[1, { standards: [], spec: ['S1'] }], [2, { standards: [], spec: [] }], [3, { standards: [], spec: [] }]]);
  assert.match(h.execution.directives[0]!.prompt, /call handoff again, alone, with `treatments`/);
  assert.match(h.execution.directives[2]!.prompt, /holds exactly the content reviewed in round 2/);
  assert.equal(execution.request.promptSha256 !== null, true);
  const builder = h.execution.invocations[0]!;
  assert.deepEqual(builder.handoff, { baseCommit: 'a'.repeat(40), rounds: { first: 1, max: 4 } });
  assert.match(builder.prompt, /reviews=factory-handoff review-rounds=multi/);
  const verification = execution.review!.verification!;
  assert.deepEqual([verification.status, verification.reasons, verification.reviewedRound, verification.finalRound, verification.applicability.kind],
    ['verified', [], 2, 3, 'identical-commit']);
  assert.deepEqual(verification.gates, [{ id: 'docs', outcome: 'passed', current: true, boundToFinalContent: true, requiredCheck: null }]);
  const events = h.work.history.map(item => item.event);
  assert.deepEqual(events.filter(event => ['review-handoff', 'review-concluded', 'review-exempted', 'review-delivered', 'review-verified', 'execution-ended'].includes(event)),
    ['review-handoff', 'review-concluded', 'review-delivered', 'review-handoff', 'review-concluded', 'review-delivered', 'review-handoff', 'review-exempted', 'review-delivered',
      'review-verified', 'execution-ended'], 'the verification is durable before the end of the Execution');
  // Ticket 19 composition: further review rounds inside the SAME Execution charge nothing, and they run on the Execution's own clock.
  assert.deepEqual(execution.charge, { kind: 'none', correctionId: null, counter: null, state: 'none', settledAt: null });
  assert.deepEqual(events.filter(event => event.startsWith('budget-')), [], 'no correction/recovery charge for repeated rounds');
  assert.ok(execution.timing?.startedAt, 'the reviewer rounds ran under the Execution timing');
});

test('AC1/AC5: a justified non-adoption without content change needs no new round; the treatment is recorded and verified', async t => {
  const h = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'passed')] } }),
    capture(2, '1', { declarations: { treatments: [{ round: 1, role: 'standards', findingId: 'H1', outcome: 'not-adopted', justification: 'A heuristic; the Ticket fixes the file name.',
      evidence: '/artifacts/spec/v1/ticket.json#body', authorization: null }], gates: [gate('docs', 'passed')] } }),
    capture(3, '1', { closing: true })],
  verdicts: role => role === 'standards' ? ['H1'] : 'clean' });
  const rounds = h.work.execution!.review!.rounds;
  assert.deepEqual(rounds.map(item => [item.round, item.kind, item.exemption?.kind ?? null]), [[1, 'review', null], [2, 'exemption', 'unchanged'], [3, 'exemption', 'unchanged']]);
  assert.deepEqual(h.execution.kinds.filter(kind => kind.startsWith('activate-')), ['activate-builder', 'activate-standards-r1', 'activate-spec-r1']);
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.end ?? false]), [[1, false], [2, false], [3, true]]);
  const verification = h.work.execution!.review!.verification!;
  assert.deepEqual([verification.status, verification.reasons], ['verified', []]);
  assert.deepEqual(verification.treatments, [{ round: 1, role: 'standards', findingId: 'H1', outcome: 'not-adopted' }]);
});

test('AC4/AC6/AC7: content changed after review without a handoff forces a round at the closing capture; gates of other content do not verify', async t => {
  const h = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'passed')] } }),
    capture(2, '2', { closing: true }),
    capture(3, '2', { closing: true })],
  verdicts: () => 'clean' });
  const rounds = h.work.execution!.review!.rounds;
  assert.deepEqual(rounds.map(item => [item.round, item.kind, item.closing]), [[1, 'review', false], [2, 'review', true], [3, 'exemption', true]]);
  assert.deepEqual(h.execution.kinds.filter(kind => kind.startsWith('activate-')), ['activate-builder', 'activate-standards-r1', 'activate-spec-r1', 'activate-standards-r2', 'activate-spec-r2']);
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.end ?? false]), [[1, false], [2, false], [3, true]], 'the forced round results reach the Builder');
  const verification = h.work.execution!.review!.verification!;
  assert.deepEqual([verification.status, verification.reasons], ['not-verified', ['GATES_NOT_BOUND_TO_FINAL_CONTENT']], 'the opinions are current, the old gate results are not');
});

test('AC6/AC7: a failed reviewer is never reused as approval; a lost gate result and a waiver of a required check never verify', async t => {
  const h = await harness(t, { max: 2, captures: [
    capture(1, '1', { declarations: { gates: [gate('e2e', 'unknown', { exitCode: null, output: null, code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' }),
      gate('ci', 'waived', { declared: 'waived', reason: 'operator', requiredCheck: 'ci/build', authorization: { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' } })] } }),
    capture(2, '1', { closing: true })],
  verdicts: (role, round) => role === 'spec' && round === 1 ? 'fail' : 'clean' });
  const rounds = h.work.execution!.review!.rounds;
  assert.deepEqual(rounds.map(item => [item.round, item.kind, item.conclusion]), [[1, 'review', 'incomplete'], [2, 'review', 'clean']], 'unchanged content after an incomplete round is reviewed again');
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.end ?? false]), [[1, false], [2, true]], 'the closing capture in the last slot ends after its results');
  const verification = h.work.execution!.review!.verification!;
  assert.equal(verification.status, 'not-verified');
  assert.deepEqual(verification.reasons, ['GATE_RESULT_UNKNOWN:e2e', 'WAIVER_NOT_AUTHORIZED:ci', 'WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:ci']);
  assert.deepEqual(verification.requiredChecks, ['ci/build']);
});

test('AC6/AC7: a failed closing capture ends the activation and never verifies: no identity, no content, no success by absence', async t => {
  const h = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'passed')] } }),
    { round: 2, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED', detail: 'GIT_FAILED:git-head', closing: true }],
  verdicts: () => 'clean' });
  const rounds = h.work.execution!.review!.rounds;
  assert.deepEqual(rounds.map(item => [item.round, item.kind, item.closing, item.conclusion, item.handoff.status]), [[1, 'review', false, 'clean', 'captured'], [2, 'review', true, 'incomplete', 'failure']]);
  assert.deepEqual(h.execution.kinds.filter(kind => kind.startsWith('activate-')), ['activate-builder', 'activate-standards-r1', 'activate-spec-r1'], 'no reviewer on a failed capture');
  assert.deepEqual(h.execution.directives.map(item => [item.round, item.end ?? false]), [[1, false], [2, true]]);
  const verification = h.work.execution!.review!.verification!;
  assert.equal(verification.status, 'not-verified');
  assert.deepEqual(verification.reasons, ['FINAL_CAPTURE_UNAVAILABLE', 'STANDARDS_OPINION_MISSING', 'SPEC_OPINION_MISSING', 'REVIEW_INCOMPLETE', 'REVIEW_NOT_APPLICABLE', 'GATES_NOT_BOUND_TO_FINAL_CONTENT']);
});

test('AC1/AC6 review fix 3: a preserved-source authorization is verified by the Host (exists + listed) before Control counts it', async t => {
  const treatment = (reference: string) => ({ round: 1, role: 'standards' as const, findingId: 'H1', outcome: 'not-adopted' as const,
    justification: 'Heuristic; the Ticket itself fixes the file name.', evidence: null, authorization: { kind: 'preserved-source' as const, reference } });
  const good = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'passed')] } }),
    capture(2, '1', { declarations: { treatments: [treatment('/artifacts/spec/v1/ticket.json#body')], gates: [gate('docs', 'passed')] } }),
    capture(3, '1', { closing: true })], verdicts: role => role === 'standards' ? ['H1'] : 'clean' });
  assert.deepEqual([good.work.execution!.review!.verification!.status, good.work.execution!.review!.verification!.reasons], ['verified', []]);
  assert.ok(good.execution.kinds.includes('verify-source:/artifacts/spec/v1/ticket.json'), 'the Host verified the preserved source');
  const bad = await harness(t, { captures: [
    capture(1, '1', { declarations: { gates: [gate('docs', 'passed')] } }),
    capture(2, '1', { declarations: { treatments: [treatment('/artifacts/spec/v1/not-listed.md#body')], gates: [gate('docs', 'passed')] } }),
    capture(3, '1', { closing: true })], verdicts: role => role === 'standards' ? ['H1'] : 'clean' });
  assert.deepEqual([bad.work.execution!.review!.verification!.status, bad.work.execution!.review!.verification!.reasons],
    ['not-verified', ['AUTHORIZATION_NOT_CORRELATED:1/standards/H1']]);
});
