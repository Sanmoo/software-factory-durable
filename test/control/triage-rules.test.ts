import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateTriage,
  latestLabelApplication,
  stateLabelConflict,
  suspendsAdmission,
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
