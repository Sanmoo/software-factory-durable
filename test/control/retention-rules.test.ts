import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDetails, inUse, planBasis, planExplicitCleanup, retentionDeadline, retentionNextStep, retentionProtections, retentionState, revalidateItem,
  type PlanFacts } from '../../src/control/rules/retention.js';
import type { DetailInventory, ExecutionView, WorkView } from '../../src/control/types.js';

// Ticket 30 pure rules (spec §12.3/§12.4) with controlled instants (milliseconds): deadline, protection, use and the explicit plan.
const day = 86_400_000;
const merge = Date.UTC(2026, 10, 1);
type Work = Parameters<typeof retentionProtections>[0];
function execution(overrides: Partial<ExecutionView> = {}): ExecutionView {
  return { executionId: 'e-1', state: 'ended', slot: { held: false }, dispatch: { boot: 'boot-1', environment: 'env-x' }, end: { cessation: 'confirmed', outcome: 'completed' },
    ...overrides } as unknown as ExecutionView;
}
function work(overrides: Record<string, unknown> = {}): Work {
  return { work_id: 'w-1', result: 'delivered', execution: execution(), previousExecutions: [], impediments: [], cancellation: null, closure: null, readiness: null,
    publication: null, pendingRecovery: null, retention: null,
    delivery: { state: 'delivered', merge: { confirmedAt: new Date(merge).toISOString() } } as unknown as WorkView['delivery'],
    cleanup: { state: 'complete', resources: [], explicit: null } as unknown as WorkView['cleanup'], ...overrides } as Work;
}
const inventory = (items: DetailInventory['items'] = [{ id: 'log:a', kind: 'log', executionId: 'e-1', bytes: 10, state: 'complete' },
  { id: 'session:e-1', kind: 'session', executionId: 'e-1', bytes: 20, state: 'complete' }]): DetailInventory => ({ completeness: 'complete', observedAt: 'now', items, evidence: 1, unknown: [] });
const facts = (overrides: Partial<PlanFacts> = {}): PlanFacts => ({ running: false, questions: [], inventory: inventory(), repositoryConfigured: true, plannedResources: [], ...overrides });

test('AC1: delivered logs/sessions are eligible `days` after the CONFIRMED merge (configurable); undelivered results never get a deadline', () => {
  assert.equal(retentionDeadline(work(), merge, 30), merge + 30 * day);
  assert.equal(retentionDeadline(work(), merge, 7), merge + 7 * day, 'configurable');
  for (const result of ['open', 'cancelled', 'closed-unmerged'] as const) assert.equal(retentionDeadline(work({ result }), merge, 30), null, result);
  assert.equal(retentionDeadline(work({ delivery: { state: 'watching', merge: null } as unknown as WorkView['delivery'] }), merge, 30), null, 'no confirmed merge, no deadline');
  const due = merge + 30 * day;
  const decide = (subject: Work, now: number, protections: string[] = []) => classifyDetails(subject, inventory(), { protections, now, dueAtMs: retentionDeadline(subject, merge, 30) })
    .map(item => item.decision);
  assert.deepEqual(decide(work(), due - 1), ['retained', 'retained']);
  assert.deepEqual(decide(work(), due), ['eligible', 'eligible']);
});

test('AC2: undelivered Works (open/blocked/cancelled/closed without merge) keep everything whatever the age; no removal to free space', () => {
  for (const result of ['open', 'cancelled', 'closed-unmerged'] as const) {
    const subject = work({ result, delivery: null, cleanup: null });
    const decisions = classifyDetails(subject, inventory(), { protections: [], now: merge + 4000 * day, dueAtMs: retentionDeadline(subject, merge, 30) });
    assert.deepEqual(decisions.map(item => [item.decision, item.reason]), [['retained', 'UNDELIVERED_RETAINED_UNTIL_EXPLICIT_CLEANUP'], ['retained', 'UNDELIVERED_RETAINED_UNTIL_EXPLICIT_CLEANUP']]);
    assert.equal(retentionState({ class: 'undelivered', dueAtMs: null, now: merge + 4000 * day, protections: [], remaining: 2, explicit: false }), 'retained');
  }
  assert.match(retentionNextStep({ class: 'undelivered', dueAt: null, protections: [], state: 'retained', removed: { logs: 0, sessions: 0, bytes: 0 }, days: 30 }),
    /kept in full until an explicit `factory cleanup`.*never removed to free space/);
});

test('AC3: needed evidence and resources in use are protected past the deadline; the end of a protection makes them eligible with no new period', () => {
  const due = merge + 30 * day;
  const later = due + 90 * day;
  const cases: [string, Work, PlanFacts['questions'], boolean, string][] = [
    ['activity', work(), [], true, 'ACTIVITY_RUNNING'],
    ['slot', work({ execution: execution({ slot: { held: true } as ExecutionView['slot'] }) }), [], false, 'EXECUTION_OCCUPYING:e-1'],
    ['cessation', work({ execution: execution({ end: { cessation: 'unconfirmed' } as ExecutionView['end'] }) }), [], false, 'CESSATION_UNCONFIRMED:e-1'],
    ['question', work(), [{ questionId: 'q-1', state: 'open', publication: { state: 'published' } as never }], false, 'QUESTION_OPEN:q-1'],
    ['question effect', work(), [{ questionId: 'q-2', state: 'answered', publication: { state: 'ambiguous' } as never }], false, 'EFFECT_UNSETTLED:question-publication:q-2'],
    ['readiness effect', work({ readiness: { effect: { effectId: 'r-1', state: 'attempted' } } as unknown as WorkView['readiness'] }), [], false, 'EFFECT_UNSETTLED:readiness:r-1'],
    ['cleanup', work({ cleanup: { state: 'pending', resources: [{ id: 'remote-branch:x', state: 'kept' }] } as unknown as WorkView['cleanup'] }), [], false, 'CLEANUP_PENDING'],
    ['removal unsettled', work({ retention: { removals: [{ outcome: 'intended' }] } as unknown as WorkView['retention'] }), [], false, 'DETAIL_REMOVAL_UNSETTLED'],
  ];
  for (const [name, subject, questions, running, reason] of cases) {
    const protections = retentionProtections(subject, { running, questions });
    assert.ok(protections.includes(reason), `${name}: ${protections.join(',')}`);
    const decisions = classifyDetails(subject, inventory(), { protections, now: later, dueAtMs: due });
    assert.ok(decisions.every(item => item.decision !== 'eligible'), name);
    assert.equal(retentionState({ class: 'delivered', dueAtMs: due, now: later, protections, remaining: 2, explicit: false }), 'protected', name);
  }
  // Recovery of a cycle that can still continue protects; on a cancelled (ended) cycle the impediment no longer needs the details.
  const blocked = { impediments: [{ code: 'RECOVERY_BLOCKED', scope: 'work', nextStep: '' }] };
  assert.ok(retentionProtections(work({ ...blocked, result: 'open' }), { running: false, questions: [] }).includes('IMPEDIMENT:RECOVERY_BLOCKED'));
  assert.deepEqual(retentionProtections(work({ ...blocked, result: 'cancelled', cleanup: null }), { running: false, questions: [] }), []);
  // The protection ends at day 120: the deadline is still the merge + 30, so it is eligible at once (no new 30 days).
  assert.deepEqual(classifyDetails(work(), inventory(), { protections: [], now: later, dueAtMs: retentionDeadline(work(), merge, 30) }).map(item => item.decision), ['eligible', 'eligible']);
  // A partial capture of an Execution not ended with confirmed cessation is in use, whatever the class.
  const partial = { id: 'log:p', kind: 'log' as const, executionId: 'e-2', bytes: 1, state: 'partial' as const };
  assert.equal(inUse(work(), partial), true, 'unknown Execution: may still be written');
  assert.equal(inUse(work({ previousExecutions: [execution({ executionId: 'e-2' })] }), partial), false, 'ended and ceased: an incomplete capture, not in use');
  assert.match(retentionNextStep({ class: 'delivered', dueAt: 'D', protections: ['CLEANUP_PENDING'], state: 'protected', removed: { logs: 0, sessions: 0, bytes: 0 }, days: 30 }),
    /still needed \(CLEANUP_PENDING\).*no new period/);
});

test('AC4/AC8: expired details are explained (counts and removals), never an empty list; summary/history/reviews/decisions/evidence stay', () => {
  const text = retentionNextStep({ class: 'delivered', dueAt: '2026-12-01T00:00:00.000Z', protections: [], state: 'expired', removed: { logs: 3, sessions: 1, bytes: 99 }, days: 30 });
  assert.match(text, /expired: removed by retention after 2026-12-01/);
  assert.match(text, /3 log\(s\), 1 session\(s\), 99 bytes \(see removals: they are not missing\)/);
  assert.match(text, /Summary, history, references, reviews, decisions and preserved evidence stay until explicit history deletion/);
});

test('AC5/AC7: explicit plan — losses, warnings and refusals; a cycle that can continue needs `cancel` first; nothing protected or unproven is selected', () => {
  for (const result of ['open', 'closed-unmerged'] as const) {
    const plan = planExplicitCleanup(work({ result, delivery: null, cleanup: null }), ['logs', 'sessions', 'environment'], facts());
    assert.deepEqual(plan.items, [], result);
    assert.deepEqual(plan.refusals.map(item => [item.target, item.code]), [['logs', 'CANCEL_REQUIRED'], ['sessions', 'CANCEL_REQUIRED'], ['environment', 'CANCEL_REQUIRED']]);
    assert.match(plan.refusals[0]!.detail, /`factory cancel <work>` first; cleanup never cancels implicitly/);
  }
  const cancelled = work({ result: 'cancelled', delivery: null, cleanup: null, cancellation: { state: 'ceased' } as WorkView['cancellation'],
    retention: { removals: [], sessions: [{ id: 'session:e-1', role: 'builder', executionId: 'e-1', state: 'preserved', sha256: 'f'.repeat(64) }] } as unknown as WorkView['retention'] });
  const plan = planExplicitCleanup(cancelled, ['logs', 'sessions', 'environment', 'remote-branch'],
    facts({ plannedResources: [{ id: 'environment:env-x', kind: 'environment', target: 'env-x/root.qcow2' }, { id: 'remote-branch:b', kind: 'remote-branch', target: 'b' }] }));
  assert.deepEqual(plan.items.map(item => [item.id, item.kind]), [['log:a', 'log'], ['session:e-1', 'session'], ['environment:env-x', 'environment']]);
  assert.deepEqual(plan.refusals.map(item => item.code), ['REMOTE_BRANCH_NOT_DELIVERED'], 'cancellation never touches GitHub');
  assert.equal(plan.losses.length, 3);
  assert.match(plan.losses[1]!, /can never be continued or inspected again/);
  assert.ok(plan.warnings.some(item => /`resume` does not recreate a session and `factory new` starts a new cycle/.test(item)), plan.warnings.join('|'));
  assert.ok(plan.warnings.some(item => /evidence and recorded sessions are preserved first/.test(item)));
  // Protected (pending question), incomplete inventory, unrecorded session ownership, in-use partial capture.
  const asked = planExplicitCleanup(cancelled, ['logs'], facts({ questions: [{ questionId: 'q', state: 'open', publication: { state: 'published' } as never }] }));
  assert.deepEqual([asked.items.length, asked.refusals[0]?.code], [0, 'PROTECTED']);
  const incomplete = planExplicitCleanup(cancelled, ['logs'], facts({ inventory: { ...inventory(), completeness: 'incomplete' } }));
  assert.ok(incomplete.refusals.some(item => item.code === 'INVENTORY_INCOMPLETE'));
  const unproven = planExplicitCleanup({ ...cancelled, retention: null }, ['sessions'], facts());
  assert.deepEqual(unproven.refusals.map(item => item.code), ['SESSION_NOT_RECORDED']);
  const stillRunning = planExplicitCleanup({ ...cancelled, execution: execution({ state: 'started' }) }, ['logs'], facts());
  assert.equal(stillRunning.items.length, 0);
  // Delivered: refused/kept own resources are planned for ONE fresh attempt; concluded ones are not selectable.
  const delivered = work({ cleanup: { state: 'pending', explicit: null, resources: [{ id: 'remote-branch:b', kind: 'remote-branch', target: 'acme:b', state: 'kept' },
    { id: 'environment:env-x', kind: 'environment', target: 't', state: 'removed' }] } as unknown as WorkView['cleanup'] });
  const resources = planExplicitCleanup(delivered, ['remote-branch', 'environment'], facts());
  assert.deepEqual(resources.items.map(item => item.id), ['remote-branch:b']);
  assert.deepEqual(resources.refusals.map(item => item.code), ['NOTHING_TO_REMOVE']);
});

test('AC6: revalidation at execution — an old plan never removes what became active, protected or continuable', () => {
  const cancelled = work({ result: 'cancelled', delivery: null, cleanup: null });
  const item = { id: 'log:a', kind: 'log' as const, target: 'log:a', bytes: 10, loss: '', state: 'planned' as const, code: null };
  assert.equal(revalidateItem(cancelled, item, { running: false, questions: [] }), null);
  assert.equal(revalidateItem(cancelled, item, { running: true, questions: [] }), 'BECAME_PROTECTED:ACTIVITY_RUNNING');
  assert.equal(revalidateItem({ ...cancelled, result: 'open' }, item, { running: false, questions: [] }), 'CANCEL_REQUIRED');
  assert.equal(revalidateItem(cancelled, item, { running: false, questions: [], inventory: inventory([{ id: 'log:a', kind: 'log', executionId: 'e-9', bytes: 1, state: 'partial' }]) }),
    'RESOURCE_IN_USE');
  assert.notEqual(planBasis(cancelled, { running: false }), planBasis({ ...cancelled, execution: execution({ state: 'started' }) }, { running: false }), 'a changed fact makes the plan obsolete');
});
