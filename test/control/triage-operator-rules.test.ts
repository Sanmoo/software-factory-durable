import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveTriageRequest,
  triageAttemptUsage,
  triageAttemptView,
  triageDetail,
  triageDetailProtections,
  triageDetailsView,
  triageRequestImpediments,
  triageStatus,
  triageSummary,
  triageUsageTotal,
  type TriageViewFacts,
} from '../../src/control/rules/triage-operator.js';
import { triageRequestStates, type TriageRequestState } from '../../src/control/rules/triage.js';
import type { TriageAttempt, TriageRequest } from '../../src/control/types.js';

// Spec #68 §10 (ticket #80): the operator views as pure rules over the request records.
const at = '2026-03-01T10:00:00.000Z';
const day = 86_400_000;
const calendar = { ms: (instant: string) => Date.parse(instant), instant: (ms: number) => new Date(ms).toISOString() };
const facts: TriageViewFacts = { budget: { investigationMs: 15 * 60_000, attempts: 2 }, now: Date.parse(at) + 60_000, retentionDays: 30, queue: [], calendar };
const terminal: readonly TriageRequestState[] = ['concluded', 'abandoned', 'failed'];
function attempt(ordinal: number, end: Partial<NonNullable<TriageAttempt['end']>> | null = {}): TriageAttempt {
  return {
    attempt: `t1-${ordinal}-0a1b2c3d`,
    ordinal,
    startedAt: at,
    environment: { attempt: `t1-${ordinal}-0a1b2c3d`, unit: 'u', hostBoot: 'b' } as TriageAttempt['environment'],
    skillPack: { id: 'factory-skills-v13', version: '13', manifestSha256: 'f'.repeat(64) },
    clones: [],
    end: end && {
      at,
      code: 'TRIAGER_ENDED_WITHOUT_VERDICT',
      cessation: { cessationConfirmed: true, evidence: 'unit-inactive' },
      transcript: 'triage/a/x/profile/sessions/s.jsonl',
      spentMs: 120_000,
      ...end,
    },
  };
}
function request(state: TriageRequestState, overrides: Partial<TriageRequest> = {}): TriageRequest {
  return {
    triage_request_id: '0b9c6a52-3d3e-4c8f-9a51-000000000001',
    sequence: 1,
    ordinal: 1,
    previous: [],
    ticket: {
      tracker: 'github',
      repository: 'acme/project',
      repositoryId: 1,
      issueId: 7,
      nodeId: 'n',
      number: 7,
      url: 'https://github.test/acme/project/issues/7',
    },
    source: { tracker: 'github', repository: 'acme/project' },
    state,
    authorization: { label: 'needs-triage', observedAt: at, application: null },
    suspension: state === 'suspended' ? { code: 'TRIAGE_LABEL_CONFLICT', labels: ['wontfix'], since: at } : null,
    end: terminal.includes(state) ? { at, code: state === 'failed' ? 'TRIAGE_ATTEMPTS_EXHAUSTED' : 'VERDICT_PUBLISHED' } : null,
    requestedAt: at,
    timeline: [{ at, event: 'requested' }],
    ...overrides,
  };
}
const retainedStop = { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' } as NonNullable<TriageAttempt['end']>['cessation'];

test('TR-44: each of the seven states has its own summary and next step; none is a retry state and none is an Impediment by itself', () => {
  assert.equal(triageRequestStates.length, 7);
  for (const state of triageRequestStates) {
    const summary = triageSummary(request(state), facts);
    assert.deepEqual([summary.state, summary.impediments, summary.ticket], [state, [], 'acme/project#7']);
    assert.ok(summary.nextStep.length > 20, state);
  }
  const queued = triageSummary(request('queued', { attempts: [attempt(1)] }), { ...facts, queue: ['other', '0b9c6a52-3d3e-4c8f-9a51-000000000001'] });
  assert.match(queued.nextStep, /position 2.*new session \(1 attempt\(s\) spent/, 'between attempts the request is queued again, with its counter');
  assert.deepEqual(
    [queued.attempts, queued.investigation],
    [
      { used: 1, total: 2 },
      { spentMs: 120_000, remainingMs: 13 * 60_000 },
    ],
  );
  assert.match(triageSummary(request('suspended'), facts).nextStep, /wontfix.*single state label/);
});

test('TR-44: `failed` tells the operator to remove and reapply the label and is never an Impediment', () => {
  const failed = request('failed', { attempts: [attempt(1), attempt(2)] });
  assert.deepEqual(triageRequestImpediments(failed), []);
  assert.match(triageSummary(failed, facts).nextStep, /TRIAGE_ATTEMPTS_EXHAUSTED.*not an Impediment.*remove and reapply needs-triage/);
  assert.deepEqual(triageStatus([failed], 1, 0).intervention, { requests: 0, impediments: [] });
});

test('the only Impediments are retained capacity and ambiguous authorship, each with its next step', () => {
  const retained = request('failed', { attempts: [attempt(1, { cessation: retainedStop })] });
  const [capacity] = triageRequestImpediments(retained);
  assert.deepEqual([capacity!.code, capacity!.ref], ['TRIAGE_CAPACITY_RETAINED', 't1-1-0a1b2c3d']);
  const summary = triageSummary(retained, facts);
  assert.deepEqual([summary.capacity, summary.impediments, summary.nextStep], ['retained', ['t1-1-0a1b2c3d'], capacity!.nextStep]);
  const impediment = { ref: 'r-1', code: 'TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS' as const, since: at, effects: [1], nextStep: 'factory triage complete ...' };
  const publishing = request('publishing', { publication: { mode: 'verdict', startedAt: at, impediment, hold: null } });
  assert.deepEqual(
    triageRequestImpediments(publishing).map(item => [item.code, item.ref]),
    [['TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS', 'r-1']],
  );
  // The same record on a request that already left `publishing` is no longer open.
  assert.deepEqual(triageRequestImpediments({ ...publishing, state: 'abandoned' }), []);
  const status = triageStatus([retained, publishing], 2, 3);
  assert.deepEqual([status.capacity, status.intervention.requests, status.held], [{ configured: 2, investigating: 0, retained: 1 }, 1, 3]);
});

test('a Verdict is `recorded` until its comment is confirmed, then a link; an attempt shows names and counts only', () => {
  const verdict = {
    outcome: 'needs-info' as const,
    category: 'bug' as const,
    component: null,
    attempt: 't1-1-0a1b2c3d',
    recordedAt: at,
    textSha256: 'a'.repeat(64),
    textBytes: 90,
  };
  const recorded = request('publishing', { verdict, intended: [{ kind: 'comment', status: 'pending' }] });
  assert.deepEqual(triageSummary(recorded, facts).verdict, { state: 'recorded', link: null });
  const published = request('concluded', { verdict, intended: [{ kind: 'comment', status: 'confirmed', reference: 'https://github.test/c/1' }] });
  assert.deepEqual(triageSummary(published, facts).verdict, { state: 'published', link: 'https://github.test/c/1' });
  const view = triageAttemptView({
    ...attempt(1, { toolCalls: { bash: 3, mcp__logs__search: 2, mcp__logs__tail: 1, mcp__metrics__query: 4 } }),
    mcpProfiles: ['logs-read', 'metrics', 'unused'],
    release: 'r-2026-03',
  });
  assert.deepEqual(view.mcp, { active: ['logs-read', 'metrics', 'unused'], calls: { logs: 3, metrics: 4 } });
  assert.deepEqual(
    [view.release, view.skillPack, view.transcript, view.capacity],
    ['r-2026-03', { id: 'factory-skills-v13', version: '13' }, 'recorded', 'released'],
  );
  const detail = triageDetail(published, [request('failed', { triage_request_id: 'older', ordinal: 0 }), published], facts);
  assert.deepEqual([detail.latest, detail.previous.map(item => item.triage_request_id), detail.later], [true, ['older'], []]);
  assert.ok(!JSON.stringify(detail).includes('textSha256'));
});

test('TR-46: details are protected while the request is live or has an Impediment, kept for the term after its end, then eligible; a removal is final', () => {
  const now = Date.parse(at);
  const state = (subject: TriageRequest, elapsedDays: number) =>
    triageDetailsView(subject, { now: now + elapsedDays * day, retentionDays: 30, calendar }).state;
  assert.deepEqual(triageDetailProtections(request('publishing')), ['TRIAGE_REQUEST_NOT_TERMINAL']);
  assert.equal(state(request('queued'), 400), 'protected');
  const concluded = request('concluded', { attempts: [attempt(1)] });
  assert.deepEqual([state(concluded, 0), state(concluded, 29.9), state(concluded, 30)], ['retained', 'retained', 'eligible']);
  assert.equal(triageDetailsView(concluded, { now, retentionDays: 30, calendar }).dueAt, '2026-03-31T10:00:00.000Z');
  const impeded = request('failed', { attempts: [attempt(1, { cessation: retainedStop })] });
  assert.deepEqual([state(impeded, 400), triageDetailProtections(impeded)], ['protected', ['TRIAGE_IMPEDIMENT_OPEN']]);
  const running = request('abandoned', { attempts: [attempt(1, null)] });
  assert.deepEqual(triageDetailProtections(running), ['TRIAGE_ATTEMPT_OPEN'], 'abandoned while its attempt still runs');
  const removal = { intendedAt: at, removedAt: at };
  assert.equal(state({ ...concluded, details: { removal: { origin: 'retention', ...removal }, plan: null } }, 31), 'expired');
  assert.equal(state({ ...concluded, details: { removal: { origin: 'explicit', ...removal }, plan: null } }, 1), 'removed');
  assert.equal(state({ ...concluded, details: { removal: { origin: 'explicit', intendedAt: at, removedAt: null }, plan: null } }, 1), 'removing');
});

test('a Ticket reference names the most recent request of the Ticket; an id names that request', () => {
  const older = request('failed', { triage_request_id: '0b9c6a52-3d3e-4c8f-9a51-00000000000a' });
  const newer = request('queued', { triage_request_id: '0b9c6a52-3d3e-4c8f-9a51-00000000000b', ordinal: 2 });
  assert.equal(resolveTriageRequest([older, newer], 'Acme/Project#7'), newer);
  assert.equal(resolveTriageRequest([older, newer], older.triage_request_id), older);
  assert.equal(resolveTriageRequest([older, newer], 'acme/project#8'), undefined);
});

test('TR-47: the tokens of an attempt that cannot be measured are unavailable, never zero, and a total sums only what was measured', () => {
  const entry = {
    id: 'e',
    provider: 'p',
    model: 'm',
    outcome: 'ok' as const,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.5,
  };
  const measured = triageAttemptUsage('a1', { state: 'read', sessionId: 's', entries: [entry, entry], malformed: 0 });
  assert.deepEqual([measured.measurement, measured.tokens?.total, measured.cost?.total], ['complete', 30, 1]);
  const lost = triageAttemptUsage('a2', { state: 'lost', code: 'TRIAGE_SESSION_ABSENT' });
  assert.deepEqual([lost.measurement, lost.tokens, lost.code], ['unavailable', null, 'TRIAGE_SESSION_ABSENT']);
  const total = triageUsageTotal([measured, lost]);
  assert.deepEqual([total.measurement, total.activities, total.measured, total.tokens?.total], ['partial', 2, 1, 30]);
  assert.equal(triageUsageTotal([]).tokens, null);
});
