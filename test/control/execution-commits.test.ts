import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, initialize, readWork, recordDependencies } from '../../src/control/durable/admission.js';
import { admitExecution, advance, confirmActivation, confirmStart, heldSlots, initializeSlots, recordPhase } from '../../src/control/durable/execution.js';
import type { DependencyEvaluation } from '../../src/control/types.js';
import { ticket } from './doubles.js';

// Real Pi Durable/SQLite commits of the Execution boundaries (spec §3.4 "Admitir Execução" / "Confirmar início").
const evaluation = (attemptId: string, conclusion: DependencyEvaluation['conclusion'] = 'satisfied'): DependencyEvaluation => ({ evaluationId: `ev-${attemptId}`, attemptId,
  source: 'github-rest', observedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(), principals: [], completeness: 'complete', conclusion,
  blockers: [], cycles: [], shared: [], reasons: conclusion === 'satisfied' ? [] : [{ code: 'EXTERNAL_BLOCKER_OPEN', url: 'u', nextStep: 'x' }], limitations: [] });
const request = { ticket: 'https://github.com/acme/project/issues/1', repository: 'acme/project', base: 'main', branch: 'factory/1-x', policies: {} };
const grant = { role: 'builder' as const, purpose: 'builder-start' as const, repository: 'acme/project', repositoryId: 3, installationId: 2, permissions: { contents: 'read' as const }, issuedAt: 'a', expiresAt: 'b' };

async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-exec-commits-'));
  const opened = await openStore(join(dir, 'c.sqlite'));
  t.after(async () => { await opened.close(); await rm(dir, { recursive: true, force: true }); });
  await initialize(opened.session); await initializeSlots(opened.session);
  const admit = async (number: number) => {
    const result = await admitTicket(opened.session, { ticket: ticket(number), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
      observedAt: new Date().toISOString(), label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: new Date().toISOString(), limitations: [] } });
    assert.equal(result.kind, 'admitted');
    return result.work_id;
  };
  return { session: opened.session, admit };
}

test('AC1: the reservation accepts only a satisfied evaluation of ITS OWN attempt, and a free Slot', async t => {
  const { session, admit } = await store(t);
  const a = await admit(1), b = await admit(2);
  await recordDependencies(session, a, evaluation('polling-round'));
  assert.deepEqual(await admitExecution(session, { work_id: a, attemptId: 'dispatch-1', capacity: 1, authorizationObservedAt: 'now', request }),
    { kind: 'refused', reasons: ['DEPENDENCIES_NOT_CURRENT'] }, 'an evaluation of another attempt never releases');
  await recordDependencies(session, a, evaluation('dispatch-2', 'pending'));
  assert.deepEqual((await admitExecution(session, { work_id: a, attemptId: 'dispatch-2', capacity: 1, authorizationObservedAt: 'now', request })).kind, 'refused');
  await recordDependencies(session, a, evaluation('dispatch-3'));
  const reserved = await admitExecution(session, { work_id: a, attemptId: 'dispatch-3', capacity: 1, authorizationObservedAt: 'now', request });
  assert.equal(reserved.kind, 'reserved');
  assert.equal(await heldSlots(session), 1);
  await recordDependencies(session, b, evaluation('dispatch-4'));
  assert.deepEqual(await admitExecution(session, { work_id: b, attemptId: 'dispatch-4', capacity: 1, authorizationObservedAt: 'now', request }),
    { kind: 'refused', reasons: ['NO_SLOT_AVAILABLE'] });
  assert.deepEqual(await admitExecution(session, { work_id: a, attemptId: 'dispatch-3', capacity: 2, authorizationObservedAt: 'now', request }),
    { kind: 'refused', reasons: ['EXECUTION_ALREADY_ACTIVE'] }, 'never a second Execution for the same Work');
});

test('AC1: start receipt is consumed exactly once, only after the activation intent of the current Execution; a different receipt conflicts', async t => {
  const { session, admit } = await store(t);
  const a = await admit(1);
  await recordDependencies(session, a, evaluation('d1'));
  const reserved = await admitExecution(session, { work_id: a, attemptId: 'd1', capacity: 1, authorizationObservedAt: 'now', request });
  assert.ok(reserved.kind === 'reserved');
  const id = reserved.execution.executionId;
  const receipt = { workId: a, id: '99999999-2222-4333-8444-555555555555' };
  assert.equal(await confirmStart(session, a, id, receipt), 'stale', 'no start before the activation intent');
  assert.equal((await recordPhase(session, a, id, 'reserved', 'prepared', 'execution-prepared', () => {})).kind, 'advanced');
  assert.equal((await recordPhase(session, a, id, 'prepared', 'booted', 'execution-booted', () => {})).kind, 'advanced');
  assert.deepEqual(await confirmActivation(session, a, id, 'other-attempt', grant, 'sha'), { kind: 'refused', reasons: ['DEPENDENCIES_NOT_CURRENT'] });
  await recordDependencies(session, a, evaluation('activation-1'));
  assert.equal((await confirmActivation(session, a, id, 'activation-1', grant, 'sha')).kind, 'advanced');
  assert.equal(await confirmStart(session, a, 'another-execution', receipt), 'stale');
  assert.equal(await confirmStart(session, a, id, receipt), 'confirmed');
  assert.equal(await confirmStart(session, a, id, receipt), 'already-confirmed');
  assert.equal(await confirmStart(session, a, id, { ...receipt, id: '88888888-2222-4333-8444-555555555555' }), 'conflict');
  const work = await readWork(session, a);
  assert.equal(work!.history.filter(item => item.event === 'execution-started').length, 1);
  assert.equal((await advance(session, a, id, { state: 'reserved', phases: ['activation-requested'] }, () => {})).kind, 'stale');
});
