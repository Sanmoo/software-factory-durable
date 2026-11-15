import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizationChange, authorizationFacts, cancelDecision, newCycleDecision, reopenDecision, resumeDecision, settleCancellation } from '../../src/control/rules/cycles.js';
import type { ExecutionView, WorkView } from '../../src/control/types.js';
import { ticket } from './doubles.js';

// Ticket 25 pure rules: the variations of withdrawal/restoration, cancellation, resume, reopen and new cycles (flows cover one per mechanism).
const at = '2026-11-15T12:00:00.000Z';
const authorization = { state: 'authorized', source: 'github-rest', observedAt: at, basis: { repositoryConfigured: true, issueState: 'open', label: { id: 55, name: 'ready-for-agent' } },
  publication: { observedAt: at, completeness: 'complete', associatedPullRequests: 0, limitations: [] }, tracking: '' } as WorkView['authorization'];
const execution = (state: ExecutionView['state'], held: boolean) => ({ executionId: 'e', state, slot: { held } }) as ExecutionView;
const work = (overrides: Partial<WorkView> = {}) => ({ result: 'open', impediments: [], execution: null, previousExecutions: [], cancellation: null, closure: null, delivery: null,
  publication: null, authorization, queue: { category: 'normal', sequence: 1, pending: true }, pendingRecovery: null, ...overrides }) as unknown as WorkView;
const observed = (state: 'open' | 'closed', labels: string[], extra: { pullRequest?: boolean; number?: number } = {}) => ({ kind: 'observed' as const, ticket: { ...ticket(3), number: extra.number ?? 3 },
  state, labels: labels.map((name, id) => ({ id, name })), pullRequest: extra.pullRequest ?? false });

test('authorization facts: closed, label absent, pull request and identity drift are withdrawals; an unavailable read or unknown repository concludes nothing', () => {
  const facts = (f: Parameters<typeof authorizationFacts>[0]['facts'], label: string | undefined = 'ready-for-agent') => authorizationFacts({ configuredLabel: label, ticket: ticket(3), facts: f });
  assert.deepEqual(facts(observed('open', ['Ready-For-Agent'])), { kind: 'authorized' });
  assert.deepEqual(facts(observed('closed', ['ready-for-agent'])), { kind: 'withdrawn', codes: ['TICKET_NOT_OPEN'] });
  assert.deepEqual(facts(observed('open', [])), { kind: 'withdrawn', codes: ['LABEL_NOT_PRESENT'] });
  assert.deepEqual(facts(observed('closed', [], { pullRequest: true })).kind, 'withdrawn');
  assert.deepEqual(facts(observed('open', ['ready-for-agent'], { number: 4 })), { kind: 'withdrawn', codes: ['TICKET_IDENTITY_MISMATCH'] });
  assert.deepEqual(facts({ kind: 'unavailable', code: 'GITHUB_RATE_LIMITED', nextStep: '' }), { kind: 'unknown', code: 'GITHUB_RATE_LIMITED' });
  assert.deepEqual(authorizationFacts({ configuredLabel: undefined, ticket: ticket(3), facts: observed('open', []) }), { kind: 'unknown', code: 'REPOSITORY_NOT_CONFIGURED' });
});

test('authorization change: withdrawal once; restoration only observed (once); resume/new-cycle confirmations need an authorized read; other impediments untouched', () => {
  const withdrawn = authorizationChange(work({ impediments: [{ code: 'QUESTION_PENDING', scope: 'work', nextStep: '' }] }), { kind: 'withdrawn', codes: ['LABEL_NOT_PRESENT'] }, at);
  assert.deepEqual([withdrawn.add.map(item => item.code), withdrawn.remove, withdrawn.events.map(item => item.event), withdrawn.state], [['AUTHORIZATION_WITHDRAWN'], [], ['authorization-withdrawn'], 'withdrawn']);
  const suspended = work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN', scope: 'work', nextStep: '' }], authorization: { ...authorization, withdrawal: { observedAt: at, codes: ['X'], restoredObservedAt: null } } });
  assert.deepEqual(authorizationChange(suspended, { kind: 'withdrawn', codes: ['X'] }, at).add, [], 'repeated withdrawal adds nothing');
  const restored = authorizationChange(suspended, { kind: 'authorized' }, at);
  assert.deepEqual([restored.add, restored.remove, restored.events.map(item => item.event), restored.withdrawal?.restoredObservedAt], [[], [], ['authorization-restored-observed'], at]);
  const again = authorizationChange(work({ ...suspended, authorization: { ...authorization, withdrawal: { observedAt: at, codes: ['X'], restoredObservedAt: at } } }), { kind: 'authorized' }, at);
  assert.deepEqual(again.events, [], 'restoration observed once');
  const pending = work({ impediments: [{ code: 'AUTHORIZATION_RESUME_PENDING', scope: 'work', nextStep: '' }, { code: 'AUTHORIZATION_NOT_CONFIRMED', scope: 'work', nextStep: '' }] });
  assert.deepEqual(authorizationChange(pending, { kind: 'authorized' }, at).remove, ['AUTHORIZATION_RESUME_PENDING', 'AUTHORIZATION_NOT_CONFIRMED']);
  const refused = authorizationChange(pending, { kind: 'withdrawn', codes: ['TICKET_NOT_OPEN'] }, at);
  assert.deepEqual([refused.remove, refused.add.map(item => item.code), refused.events.map(item => item.event)],
    [['AUTHORIZATION_RESUME_PENDING', 'AUTHORIZATION_NOT_CONFIRMED'], ['AUTHORIZATION_WITHDRAWN'], ['resume-not-confirmed', 'authorization-withdrawn']]);
});

test('cancel / resume / reopen decisions never revive a cancelled or delivered cycle; resume during an activity informs it', () => {
  assert.deepEqual(cancelDecision(null, false), { kind: 'refuse', code: 'WORK_NOT_FOUND' });
  assert.deepEqual(cancelDecision(work(), false), { kind: 'refuse', code: 'WORK_NOT_CURRENT' });
  assert.deepEqual(cancelDecision(work({ result: 'delivered' }), true), { kind: 'refuse', code: 'WORK_DELIVERED' });
  assert.deepEqual(cancelDecision(work({ result: 'cancelled' }), true), { kind: 'already' });
  assert.deepEqual(cancelDecision(work({ result: 'closed-unmerged' }), true), { kind: 'accept' }, 'abandoning a closed cycle is a cancel');
  assert.deepEqual(resumeDecision(work({ result: 'cancelled' }), true), { kind: 'refuse', code: 'WORK_CANCELLED' });
  assert.deepEqual(resumeDecision(work({ result: 'delivered' }), true), { kind: 'refuse', code: 'WORK_DELIVERED' });
  assert.deepEqual(resumeDecision(work(), true), { kind: 'refuse', code: 'NOTHING_TO_RESUME' });
  assert.deepEqual(resumeDecision(work({ execution: execution('started', true) }), true), { kind: 'already', code: 'EXECUTION_ACTIVE' });
  assert.deepEqual(resumeDecision(work({ impediments: [{ code: 'AUTHORIZATION_WITHDRAWN', scope: 'work', nextStep: '' }, { code: 'EXECUTION_TIMEOUT', scope: 'work', nextStep: '' }] }), true),
    { kind: 'accept', remove: ['AUTHORIZATION_WITHDRAWN'] });
  assert.deepEqual(reopenDecision(work(), true, true), { kind: 'refuse', code: 'PULL_REQUEST_NOT_CLOSED_UNMERGED' });
  assert.deepEqual(reopenDecision(work({ result: 'closed-unmerged', closure: { observedAt: at, pullRequest: 1, reopen: null, nextStep: '' } }), true, false), { kind: 'refuse', code: 'OWN_PULL_REQUEST_UNKNOWN' });
  assert.deepEqual(reopenDecision(work({ result: 'closed-unmerged', closure: { observedAt: at, pullRequest: 1, nextStep: '',
    reopen: { effectId: 'x', request_id: 'r', intendedAt: at, state: 'attempted', sendingAt: at, attempt: null, observation: null, settledAt: null } } }), true, true), { kind: 'already', code: 'REOPEN_PENDING' });
});

test('settleCancellation: ceased only when no own Execution occupies anything; always drops queue work and pending recovery', () => {
  const stopping = () => ({ request_id: 'c', requestedAt: at, state: 'stopping' as const, ceasedAt: null, executionId: 'e', nextStep: '' });
  const held = work({ cancellation: stopping(), execution: execution('ended', true), pendingRecovery: { reason: 'x', requestedAt: at } });
  assert.equal(settleCancellation(held, at), false);
  assert.deepEqual([held.cancellation?.state, held.queue.pending, held.pendingRecovery], ['stopping', false, null]);
  const released = work({ cancellation: stopping(), execution: execution('ended', false), previousExecutions: [execution('released', false)] });
  assert.equal(settleCancellation(released, at), true);
  assert.deepEqual([released.cancellation?.state, released.cancellation?.ceasedAt], ['ceased', at]);
  assert.equal(settleCancellation(work(), at), false, 'no cancellation: unchanged');
});

test('new cycle decision: only after delivery or a ceased cancellation; unreconciled publication and a possibly open own PR need attention', () => {
  const cancelled = (overrides: Partial<WorkView> = {}) => work({ result: 'cancelled', cancellation: { request_id: 'c', requestedAt: at, state: 'ceased', ceasedAt: at, executionId: null, nextStep: '' }, ...overrides });
  const decide = (w: WorkView | null, keep = false, own = false) => newCycleDecision(w, { keepPredecessorPullRequest: keep, ownPullRequest: own });
  assert.deepEqual(decide(null), { kind: 'refuse', code: 'TICKET_NOT_KNOWN' });
  assert.deepEqual(decide(work()), { kind: 'refuse', code: 'CYCLE_STILL_CURRENT' });
  assert.deepEqual(decide(work({ result: 'closed-unmerged' })), { kind: 'refuse', code: 'CYCLE_STILL_CURRENT' });
  assert.deepEqual(decide(work({ result: 'delivered', execution: execution('ended', true) })), { kind: 'refuse', code: 'PREDECESSOR_CESSATION_UNCONFIRMED' });
  assert.deepEqual(decide(work({ result: 'delivered', execution: execution('ended', false) }), false, true), { kind: 'accept' }, 'delivered: its PR is merged');
  assert.deepEqual(decide(cancelled({ cancellation: { request_id: 'c', requestedAt: at, state: 'stopping', ceasedAt: null, executionId: 'e', nextStep: '' } })), { kind: 'refuse', code: 'PREDECESSOR_CESSATION_UNCONFIRMED' });
  assert.deepEqual(decide(cancelled({ publication: { state: 'awaiting-discovery' } as NonNullable<WorkView['publication']> })), { kind: 'refuse', code: 'PREDECESSOR_PUBLICATION_NOT_RECONCILED' });
  assert.deepEqual(decide(cancelled(), false, true), { kind: 'refuse', code: 'PREDECESSOR_PULL_REQUEST_OPEN' });
  assert.deepEqual(decide(cancelled(), true, true), { kind: 'accept' });
  assert.deepEqual(decide(cancelled({ delivery: { observations: [{ outcome: 'closed-unmerged' }] } as unknown as NonNullable<WorkView['delivery']> }), false, true), { kind: 'accept' }, 'own PR observed closed');
  assert.deepEqual(decide(cancelled(), false, false), { kind: 'accept' });
});
