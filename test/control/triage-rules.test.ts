import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterAttemptWithoutVerdict,
  evaluateTriage,
  latestLabelApplication,
  stateLabelConflict,
  suspendsAdmission,
  interruptedAttemptSpentMs,
  triageBalance,
  triageImpediments,
  triageStarts,
  triageTransitionAllowed,
  type TriageEvaluationInput,
  type TriageLabelEvent,
} from '../../src/control/rules/triage.js';

// Spec #68 §4-§5 (ticket #71): pure rules of the Triage request up to `queued`. No I/O, no clock: callers pass the observed facts.
const roles = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', admission: 'ready-for-agent' };
const added = (eventId: string, label = 'needs-triage'): TriageLabelEvent => ({ eventId, action: 'added', label });
const removed = (eventId: string, label = 'needs-triage'): TriageLabelEvent => ({ eventId, action: 'removed', label });
const input = (overrides: Partial<TriageEvaluationInput> = {}): TriageEvaluationInput => ({
  roles,
  caseSensitive: false,
  facts: { open: true, inSource: true, labels: ['needs-triage'], hasWork: false },
  latest: null,
  history: { kind: 'observed', events: [added('e1')] },
  ...overrides,
});
const facts = (overrides: Partial<TriageEvaluationInput['facts']>) => ({ open: true, inSource: true, labels: ['needs-triage'], hasWork: false, ...overrides });
const terminal = (overrides: Partial<NonNullable<TriageEvaluationInput['latest']>> = {}) => ({
  state: 'failed' as const,
  endCode: 'BUDGET_EXHAUSTED',
  application: { eventId: 'e1' },
  ...overrides,
});

test('TR-02: an open Ticket without Work carrying needs-triage gets a request; the label author is not a fact the rule takes', () => {
  assert.deepEqual(evaluateTriage(input()), { action: 'create', application: { eventId: 'e1' } });
  assert.deepEqual(
    evaluateTriage(input({ history: { kind: 'observed', events: [] } })),
    { action: 'create', application: null },
    'a label that came with the Ticket (no application event) still authorizes the first request',
  );
});

test('TR-02: a closed Ticket, one that left its source, or one with a Work in any state is never triaged', () => {
  assert.deepEqual(evaluateTriage(input({ facts: facts({ open: false }) })), { action: 'hold', code: 'TRIAGE_TICKET_NOT_OPEN' });
  assert.deepEqual(evaluateTriage(input({ facts: facts({ inSource: false }) })), { action: 'hold', code: 'TRIAGE_TICKET_LEFT_SOURCE' });
  assert.deepEqual(evaluateTriage(input({ facts: facts({ hasWork: true }) })), { action: 'hold', code: 'TRIAGE_WORK_EXISTS' });
  assert.deepEqual(evaluateTriage(input({ facts: facts({ labels: ['bug'] }) })), { action: 'none' }, 'no needs-triage, no request');
});

test('TR-03: needs-triage beside another state label is a conflict; no winner is chosen and no request is created', () => {
  for (const other of ['needs-info', 'ready-for-human', 'wontfix', 'ready-for-agent'])
    assert.deepEqual(
      evaluateTriage(input({ facts: facts({ labels: ['needs-triage', other, 'bug'] }) })),
      { action: 'hold', code: 'TRIAGE_LABEL_CONFLICT', labels: [other] },
      other,
    );
  assert.deepEqual(stateLabelConflict(roles, ['Needs-Triage', 'WONTFIX', 'needs-info'], false), ['needs-info', 'WONTFIX']);
  assert.deepEqual(stateLabelConflict(roles, ['needs-triage', 'WONTFIX'], true), [], 'Jira labels are case-sensitive');
  assert.deepEqual(stateLabelConflict(roles, ['wontfix', 'needs-info'], false), [], 'without needs-triage there is no Triage conflict');
});

test('TR-04: needs-triage present suspends admission by the admission label', () => {
  assert.equal(suspendsAdmission(roles, ['ready-for-agent', 'Needs-Triage'], false), true);
  assert.equal(suspendsAdmission(roles, ['ready-for-agent'], false), false);
  assert.equal(suspendsAdmission(roles, ['ready-for-agent', 'Needs-Triage'], true), false);
});

test('TR-03/§5: a conflict suspends a queued request, and removing only the conflicting label returns the same request to the queue', () => {
  const queued = { state: 'queued' as const, endCode: null, application: { eventId: 'e1' } };
  const conflict = facts({ labels: ['needs-triage', 'wontfix'] });
  assert.deepEqual(evaluateTriage(input({ latest: queued, facts: conflict })), { action: 'suspend', labels: ['wontfix'] });
  assert.deepEqual(evaluateTriage(input({ latest: { ...queued, state: 'suspended' }, facts: conflict })), { action: 'keep' });
  assert.deepEqual(evaluateTriage(input({ latest: { ...queued, state: 'suspended' } })), { action: 'requeue' });
  assert.deepEqual(evaluateTriage(input({ latest: queued })), { action: 'keep' });
});

test('TR-12/§5: a queued or suspended request ends abandoned when the Ticket closes, gains a Work, leaves the source or loses needs-triage', () => {
  for (const state of ['queued', 'suspended'] as const) {
    const latest = { state, endCode: null, application: null };
    assert.deepEqual(evaluateTriage(input({ latest, facts: facts({ labels: [] }) })), { action: 'abandon', code: 'NEEDS_TRIAGE_REMOVED' });
    assert.deepEqual(evaluateTriage(input({ latest, facts: facts({ open: false }) })), { action: 'abandon', code: 'TICKET_CLOSED' });
    assert.deepEqual(evaluateTriage(input({ latest, facts: facts({ hasWork: true }) })), { action: 'abandon', code: 'WORK_EXISTS' });
    assert.deepEqual(evaluateTriage(input({ latest, facts: facts({ inSource: false }) })), { action: 'abandon', code: 'TICKET_LEFT_SOURCE' });
  }
});

test('a request being investigated or published is not moved by discovery (its re-read belongs to the publication)', () => {
  for (const state of ['investigating', 'publishing'] as const)
    assert.deepEqual(evaluateTriage(input({ latest: { state, endCode: null, application: null }, facts: facts({ labels: [] }) })), { action: 'keep' });
});

test('TR-06: after a terminal request the label still present is not a new request; only a later application is', () => {
  assert.deepEqual(evaluateTriage(input({ latest: terminal(), history: { kind: 'not-read' } })), { action: 'read-history' });
  assert.deepEqual(
    evaluateTriage(input({ latest: terminal() })),
    { action: 'hold', code: 'TRIAGE_REAPPLICATION_REQUIRED' },
    'the latest application is the one the earlier request consumed',
  );
  assert.deepEqual(evaluateTriage(input({ latest: terminal(), history: { kind: 'observed', events: [added('e1'), removed('e2'), added('e3')] } })), {
    action: 'create',
    application: { eventId: 'e3' },
  });
  assert.deepEqual(
    evaluateTriage(input({ latest: terminal({ application: null }), history: { kind: 'observed', events: [] } })),
    { action: 'hold', code: 'TRIAGE_REAPPLICATION_REQUIRED' },
    'no application event then and none now',
  );
  assert.deepEqual(evaluateTriage(input({ latest: terminal({ application: null }), history: { kind: 'observed', events: [removed('e2'), added('e3')] } })), {
    action: 'create',
    application: { eventId: 'e3' },
  });
});

test('TR-06/TR-12: a withdrawal the Control observed itself is evidence, whatever the history shows', () => {
  const abandoned = terminal({ state: 'abandoned', endCode: 'NEEDS_TRIAGE_REMOVED' });
  assert.deepEqual(evaluateTriage(input({ latest: abandoned })), { action: 'create', application: { eventId: 'e1' } });
  assert.deepEqual(
    evaluateTriage(input({ latest: terminal({ state: 'abandoned', endCode: 'CANCELLED_BY_OPERATOR' }) })),
    { action: 'hold', code: 'TRIAGE_REAPPLICATION_REQUIRED' },
    'a cancelled request is not recreated by the label that stayed',
  );
});

test('the label history is read before any request is created, and an unread history creates none', () => {
  assert.deepEqual(evaluateTriage(input({ history: { kind: 'not-read' } })), { action: 'read-history' });
  assert.deepEqual(evaluateTriage(input({ history: { kind: 'unavailable', code: 'GITHUB_QUERY_FAILED' } })), {
    action: 'hold',
    code: 'TRIAGE_LABEL_HISTORY_UNAVAILABLE',
    observedCode: 'GITHUB_QUERY_FAILED',
  });
  assert.deepEqual(
    evaluateTriage(input({ history: { kind: 'not-read' }, facts: facts({ labels: ['needs-triage', 'wontfix'] }) })),
    { action: 'hold', code: 'TRIAGE_LABEL_CONFLICT', labels: ['wontfix'] },
    'nothing is read for a Ticket that cannot be triaged anyway',
  );
});

test('latestLabelApplication is the last `added` event of the label, in the order the origin reports', () => {
  const events = [added('e1'), added('x1', 'bug'), removed('e2'), added('E3', 'Needs-Triage'), removed('x2', 'bug')];
  assert.deepEqual(latestLabelApplication(events, 'needs-triage', false), { eventId: 'E3' });
  assert.deepEqual(latestLabelApplication(events, 'needs-triage', true), { eventId: 'e1' });
  assert.equal(latestLabelApplication(events, 'wontfix', false), null);
});

test('TR-44 groundwork: seven states, no retry state; terminal states never move and every live state may be abandoned', () => {
  for (const from of ['queued', 'investigating', 'suspended', 'publishing'] as const) assert.equal(triageTransitionAllowed(from, 'abandoned'), true, from);
  for (const from of ['concluded', 'abandoned', 'failed'] as const)
    for (const to of ['queued', 'investigating', 'suspended', 'publishing', 'concluded', 'abandoned', 'failed'] as const)
      assert.equal(triageTransitionAllowed(from, to), false, `${from} -> ${to}`);
  assert.equal(triageTransitionAllowed('queued', 'investigating'), true);
  assert.equal(triageTransitionAllowed('investigating', 'queued'), true, 'between attempts the request goes back to the queue');
  assert.equal(triageTransitionAllowed('investigating', 'publishing'), true);
  assert.equal(triageTransitionAllowed('publishing', 'concluded'), true);
  assert.equal(triageTransitionAllowed('queued', 'publishing'), false);
  assert.equal(triageTransitionAllowed('suspended', 'investigating'), false);
});

// ---- Ticket #76 (spec §5): capacity, the three budget axes and what becomes of a request after an attempt without a Verdict ----
const budget = { investigationMs: 15 * 60_000, attempts: 2 };
const confirmed: { cessationConfirmed: boolean; code?: string } = { cessationConfirmed: true };
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const ended = (from: number, to: number, code = 'TRIAGER_PROVIDER_UNAVAILABLE', cessation = confirmed) => ({
  attempt: `t1-${from}`,
  end: { at: at(to), code, spentMs: (to - from) * 60_000, cessation },
});

test('TR-08: the balance counts only the time of the attempts, never the queue, and a recorded attempt is never given back', () => {
  assert.deepEqual(triageBalance(budget, []), { attemptsLeft: 2, remainingMs: 900_000 });
  // 4 minutes investigating, then 50 minutes in the queue: only the 4 minutes are spent.
  assert.deepEqual(triageBalance(budget, [ended(0, 4)]), { attemptsLeft: 1, remainingMs: 660_000 });
  assert.deepEqual(triageBalance(budget, [ended(0, 4), ended(54, 60)]), { attemptsLeft: 0, remainingMs: 300_000 });
  // An attempt still open has spent up to `now`; the balance never goes below zero.
  assert.deepEqual(triageBalance(budget, [{ end: null }], 360_000), { attemptsLeft: 1, remainingMs: 540_000 });
  assert.deepEqual(triageBalance(budget, [ended(0, 40), ended(41, 42), ended(43, 44)]), { attemptsLeft: 0, remainingMs: 0 });
});

test('TR-08: each budget axis ends the request with its own code; an attempt that ends with balance sends it back to the queue', () => {
  // Model budget of the attempt (`triager-v1`): the attempt is spent, the next one starts only with time left.
  assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 4, 'TRIAGER_MODEL_BUDGET_EXHAUSTED')]), { to: 'queued' });
  assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 15, 'TRIAGER_MODEL_BUDGET_EXHAUSTED')]), {
    to: 'failed',
    code: 'TRIAGE_INVESTIGATION_TIME_EXHAUSTED',
  });
  // The clock ended the attempt itself.
  assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 15, 'TRIAGE_INVESTIGATION_TIME_EXHAUSTED')]), {
    to: 'failed',
    code: 'TRIAGE_INVESTIGATION_TIME_EXHAUSTED',
  });
  // The attempts.
  assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 2), ended(3, 5)]), { to: 'failed', code: 'TRIAGE_ATTEMPTS_EXHAUSTED' });
  assert.deepEqual(afterAttemptWithoutVerdict({ ...budget, attempts: 3 }, [ended(0, 2), ended(3, 5)]), { to: 'queued' });
});

test('TR-09/TR-11: a transient end is retried with balance; a session the profile refuses is not; an interrupted attempt counts as spent', () => {
  for (const code of ['TRIAGER_PROVIDER_UNAVAILABLE', 'TRIAGER_AGENT_EXITED', 'TRIAGER_INTERRUPTED', 'INVESTIGATION_INTERRUPTED', 'CONTROLLER_STOPPED'])
    assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 1, code)]), { to: 'queued' }, code);
  for (const code of ['WORKER_MODEL_MISMATCH', 'WORKER_THINKING_LEVEL_UNSUPPORTED', 'WORKER_MODEL_UNAVAILABLE'])
    assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 1, code)]), { to: 'failed', code }, code);
  assert.deepEqual(afterAttemptWithoutVerdict(budget, [ended(0, 1), ended(2, 3, 'INVESTIGATION_INTERRUPTED')]), {
    to: 'failed',
    code: 'TRIAGE_ATTEMPTS_EXHAUSTED',
  });
});

test('TR-11: an attempt a dead Control left open is charged up to the latest instant its records show, never the time the Control was down', () => {
  const minute = 60_000;
  // The session asked for clones at minutes 2 and 4; the new Control ended the attempt at minute 70.
  assert.equal(interruptedAttemptSpentMs({ startedAt: 0, recorded: [2 * minute, 4 * minute], endedAt: 70 * minute }), 4 * minute);
  // No instant after the start in the records: nothing bounds what it consumed, so the whole span up to its end is charged.
  assert.equal(interruptedAttemptSpentMs({ startedAt: 0, recorded: [], endedAt: 70 * minute }), 70 * minute);
  assert.equal(interruptedAttemptSpentMs({ startedAt: 5 * minute, recorded: [5 * minute, minute], endedAt: 70 * minute }), 65 * minute);
  // Never past the end, never negative.
  assert.equal(interruptedAttemptSpentMs({ startedAt: 0, recorded: [90 * minute], endedAt: 70 * minute }), 70 * minute);
  assert.equal(interruptedAttemptSpentMs({ startedAt: 10 * minute, recorded: [], endedAt: 9 * minute }), 0);
});

test('TR-07: free capacity goes to the queue in arrival order; a request whose earlier attempt is not confirmed stopped never starts', () => {
  const queue = ['a', 'b', 'c'].map(triage_request_id => ({ triage_request_id, attempts: [] as ReturnType<typeof ended>[] }));
  assert.deepEqual(triageStarts({ capacity: 1, held: 0, queue }), ['a']);
  assert.deepEqual(triageStarts({ capacity: 1, held: 1, queue }), []);
  assert.deepEqual(triageStarts({ capacity: 2, held: 0, queue }), ['a', 'b']);
  assert.deepEqual(triageStarts({ capacity: 3, held: 1, queue }), ['a', 'b']);
  // TR-09: `a` went back to the queue while the stop of its attempt is unconfirmed: it holds a unit and is not started again.
  const retained = [
    { triage_request_id: 'a', attempts: [ended(0, 1, 'TRIAGER_AGENT_EXITED', { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' })] },
  ];
  assert.deepEqual(triageStarts({ capacity: 2, held: 1, queue: [...retained, ...queue.slice(1)] }), ['b']);
  assert.deepEqual(triageStarts({ capacity: 1, held: 1, queue: retained }), []);
});

test('TR-09/TR-27: an attempt whose stop is not confirmed is an Impediment of retained capacity with its next step; `failed` is none', () => {
  const held = ended(0, 1, 'TRIAGER_AGENT_EXITED', { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' });
  const impediments = triageImpediments({ triage_request_id: 'r1', attempts: [ended(5, 6), held, { attempt: 't1-9', end: null }] });
  assert.equal(impediments.length, 1);
  const { nextStep, ...impediment } = impediments[0]!;
  assert.deepEqual(impediment, {
    ref: 't1-0',
    code: 'TRIAGE_CAPACITY_RETAINED',
    scope: 'installation',
    triage_request_id: 'r1',
    attempt: 't1-0',
    since: at(1),
    observed: 'INVESTIGATION_MANAGER_UNAVAILABLE',
  });
  assert.match(nextStep, /triage release r1 --attempt t1-0/);
  assert.deepEqual(triageImpediments({ triage_request_id: 'r2', attempts: [ended(0, 1), ended(2, 3)] }), []);
  assert.deepEqual(triageImpediments({ triage_request_id: 'r3' }), []);
});
