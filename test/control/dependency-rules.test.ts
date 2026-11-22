import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyseGraph,
  dependencyImpediments,
  dispatchBlockers,
  evaluateDependencies,
  ownCycleFor,
  selectNext,
  type GraphFacts,
  type GraphNodeFacts,
  type OwnCycleFacts,
} from '../../src/control/rules/dependencies.js';

// Rule level (Q11): deterministic functions over observed facts; proves no storage, process or GitHub boundary.
const node = (issueId: number, overrides: Partial<GraphNodeFacts> = {}): GraphNodeFacts => ({
  issueId,
  nodeId: `I_${issueId}`,
  repository: 'acme/project',
  repositoryId: 3,
  number: issueId - 7000,
  url: `https://github.com/acme/project/issues/${issueId - 7000}`,
  state: 'open',
  stateReason: null,
  access: 'read',
  repositoryRole: 'executable',
  blockedBy: [],
  ...overrides,
});
const graph = (nodes: GraphNodeFacts[], problems: GraphFacts['problems'] = []): GraphFacts => ({ rootIssueId: nodes[0]!.issueId, nodes, problems });
const closed = (issueId: number, stateReason: string | null = 'completed', overrides: Partial<GraphNodeFacts> = {}) =>
  node(issueId, { state: 'closed', stateReason, ...overrides });
const evaluate = (facts: GraphFacts, own: Record<number, OwnCycleFacts> = {}) => evaluateDependencies({ graph: facts, own });
const codes = (result: ReturnType<typeof evaluate>) => result.reasons.map(reason => reason.code);

test('no native blocker: satisfied and complete', () => {
  const result = evaluate(graph([node(7001)]));
  assert.deepEqual([result.conclusion, result.completeness, result.reasons], ['satisfied', 'complete', []]);
  assert.deepEqual(dependencyImpediments(result, '2026-01-01T00:00:00.000Z'), []);
});

test('external blocker is satisfied only by closed + completed; open, reopened, not_planned, duplicate and unknown reasons are not', () => {
  assert.equal(evaluate(graph([node(7001, { blockedBy: [7002] }), closed(7002)])).conclusion, 'satisfied');
  for (const [blocker, code] of [
    [node(7002), 'EXTERNAL_BLOCKER_OPEN'],
    [node(7002, { stateReason: 'reopened' }), 'EXTERNAL_BLOCKER_OPEN'],
    [closed(7002, 'not_planned'), 'EXTERNAL_BLOCKER_NOT_COMPLETED'],
    [closed(7002, 'duplicate'), 'EXTERNAL_BLOCKER_NOT_COMPLETED'],
    [closed(7002, null), 'EXTERNAL_BLOCKER_NOT_COMPLETED'],
    [closed(7002, 'something_new'), 'EXTERNAL_BLOCKER_NOT_COMPLETED'],
  ] as const) {
    const result = evaluate(graph([node(7001, { blockedBy: [7002] }), blocker]));
    assert.equal(result.conclusion, 'pending', `${blocker.state}/${blocker.stateReason}`);
    assert.deepEqual(codes(result), [code]);
    assert.equal(result.blockers.find(item => item.issueId === 7002)!.satisfied, false);
  }
  const impediments = dependencyImpediments(evaluate(graph([node(7001, { blockedBy: [7002] }), closed(7002, 'duplicate')])), 'now');
  assert.deepEqual(
    impediments.map(item => [item.code, item.scope]),
    [['DEPENDENCY_PENDING', 'work']],
  );
  assert.match(impediments[0]!.nextStep, /issues\/2/);
});

test('own blocker requires confirmed merge of the applicable cycle; issue closure, cancellation and earlier deliveries never satisfy', () => {
  const facts = graph([node(7001, { blockedBy: [7002] }), closed(7002)]);
  const own = (
    applicable: Extract<OwnCycleFacts, { applicable: unknown }>['applicable'],
    source: 'work' | 'minimal-memory' = 'work',
    previous: Extract<OwnCycleFacts, { applicable: unknown }>['previousCycles'] = [],
  ): Record<number, OwnCycleFacts> => ({ 7002: { source, applicable, previousCycles: previous } });
  const delivered = { work_id: 'w2', cycle: 2, result: 'delivered' as const, mergeConfirmed: true };
  assert.equal(evaluate(facts, own(delivered)).conclusion, 'satisfied');
  assert.equal(evaluate(facts, own(delivered, 'minimal-memory')).conclusion, 'satisfied', 'minimal memory keeps a delivered cycle provable');
  for (const [applicable, code] of [
    [{ work_id: 'w', cycle: 1, result: 'open', mergeConfirmed: false }, 'OWN_CYCLE_NOT_DELIVERED'],
    [{ work_id: 'w', cycle: 1, result: 'cancelled', mergeConfirmed: false }, 'OWN_CYCLE_CANCELLED'],
    [{ work_id: 'w', cycle: 1, result: 'closed-unmerged', mergeConfirmed: false }, 'OWN_PULL_REQUEST_CLOSED_UNMERGED'],
    [{ work_id: 'w', cycle: 1, result: 'delivered', mergeConfirmed: false }, 'OWN_DELIVERY_NOT_CONFIRMED'],
  ] as const) {
    for (const source of ['work', 'minimal-memory'] as const) {
      const result = evaluate(facts, own(applicable, source));
      assert.deepEqual([result.conclusion, codes(result)], ['pending', [code]], `${applicable.result} via ${source} with issue closed/completed`);
    }
  }
  // A new cycle after a delivered one: the earlier merge does not satisfy the new cycle.
  const renewed = evaluate(facts, own({ work_id: 'w3', cycle: 3, result: 'open', mergeConfirmed: false }, 'work', [delivered]));
  assert.deepEqual([renewed.conclusion, codes(renewed)], ['pending', ['OWN_CYCLE_NOT_DELIVERED']]);
  assert.equal(evaluate(facts, own({ work_id: 'w3', cycle: 3, result: 'open', mergeConfirmed: false }, 'minimal-memory', [delivered])).conclusion, 'pending');
  // Known own Ticket without its record: never reclassified as external.
  const missing = evaluate(facts, { 7002: { source: 'missing', work_id: 'w9' } });
  assert.deepEqual([missing.conclusion, codes(missing)], ['pending', ['OWN_CYCLE_MEMORY_MISSING']]);
  assert.equal(missing.blockers[0]!.classification, 'own');
});

test('traversal analysis distinguishes a shared node (diamond) from a cycle on the path, including closed nodes', () => {
  const diamond = graph([
    node(7001, { blockedBy: [7002, 7003] }),
    closed(7002, 'completed', { blockedBy: [7004] }),
    closed(7003, 'completed', { blockedBy: [7004] }),
    closed(7004),
  ]);
  assert.deepEqual(analyseGraph(diamond), { cycles: [], shared: [7004] });
  assert.equal(evaluate(diamond).conclusion, 'satisfied');
  const loop = graph([node(7001, { blockedBy: [7002] }), closed(7002, 'completed', { blockedBy: [7003] }), closed(7003, 'completed', { blockedBy: [7002] })]);
  assert.deepEqual(analyseGraph(loop).cycles, [[7002, 7003, 7002]]);
  const result = evaluate(loop);
  assert.deepEqual([result.conclusion, result.completeness, codes(result)], ['inconclusive', 'complete', ['DEPENDENCY_CYCLE']]);
  const rootLoop = evaluate(graph([node(7001, { blockedBy: [7002] }), closed(7002, 'completed', { blockedBy: [7001] })]));
  assert.deepEqual(codes(rootLoop), ['DEPENDENCY_CYCLE']);
  assert.deepEqual(
    dependencyImpediments(rootLoop, 'now').map(item => item.code),
    ['DEPENDENCY_EVALUATION_INCONCLUSIVE'],
  );
});

test('structural problems prevent release even when every direct blocker is satisfied; pending and inconclusive coexist', () => {
  // Transitive blocker unreadable behind a closed/completed intermediate.
  const hidden = graph(
    [
      node(7001, { blockedBy: [7002] }),
      closed(7002, 'completed', { blockedBy: [8001] }),
      closed(8001, 'completed', { repository: 'other/lib', repositoryId: null, access: 'edge-only', repositoryRole: 'not-configured', blockedBy: null }),
    ],
    [{ code: 'DEPENDENCY_REPOSITORY_NOT_CONFIGURED', issueId: 8001, repository: 'other/lib', nextStep: 'configure' }],
  );
  const result = evaluate(hidden);
  assert.deepEqual([result.conclusion, result.completeness, codes(result)], ['inconclusive', 'incomplete', ['DEPENDENCY_REPOSITORY_NOT_CONFIGURED']]);
  // A transitively unsatisfied node is reported but does not by itself hold a satisfied direct blocker.
  const transitive = evaluate(graph([node(7001, { blockedBy: [7002] }), closed(7002, 'completed', { blockedBy: [7003] }), node(7003)]));
  assert.equal(transitive.conclusion, 'satisfied');
  assert.deepEqual(
    transitive.blockers.map(item => [item.issueId, item.direct, item.satisfied]),
    [
      [7002, true, true],
      [7003, false, false],
    ],
  );
  const both = evaluate(
    graph(
      [node(7001, { blockedBy: [7002] }), node(7002)],
      [{ code: 'DEPENDENCY_READ_UNAVAILABLE', observedCode: 'GITHUB_RATE_LIMITED', waitSeconds: 30, nextStep: 'wait' }],
    ),
  );
  assert.equal(both.conclusion, 'inconclusive');
  assert.deepEqual(
    dependencyImpediments(both, 'now').map(item => item.code),
    ['DEPENDENCY_PENDING', 'DEPENDENCY_EVALUATION_INCONCLUSIVE'],
  );
  // No GitHub count to cross-check: omissions are undetectable, so nothing is released and the operator gets the reason.
  const unsummarised = evaluate(
    graph([node(7001, { blockedBy: [7002] }), closed(7002)], [{ code: 'DEPENDENCY_SUMMARY_UNAVAILABLE', issueId: 7001, nextStep: 'operator must verify' }]),
  );
  assert.deepEqual([unsummarised.conclusion, unsummarised.completeness], ['inconclusive', 'incomplete']);
  assert.deepEqual(
    dependencyImpediments(unsummarised, 'now').map(item => item.code),
    ['DEPENDENCY_EVALUATION_INCONCLUSIVE'],
  );
  assert.match(dependencyImpediments(unsummarised, 'now')[0]!.nextStep, /DEPENDENCY_SUMMARY_UNAVAILABLE.*operator must verify/);
  // Root never read: nothing is known about its blockers.
  const unread = evaluate({ rootIssueId: 7001, nodes: [], problems: [{ code: 'DEPENDENCY_READ_UNAVAILABLE', nextStep: 'x' }] });
  assert.equal(unread.conclusion, 'inconclusive');
  // An unknown edge target (no node) is never silently ignored.
  const dangling = evaluate(graph([node(7001, { blockedBy: [7009] })]));
  assert.deepEqual([dangling.conclusion, codes(dangling)], ['inconclusive', ['DEPENDENCY_TARGET_UNREAD']]);
});

test('dispatch gate: only an evaluation from the current attempt can release; old observations and other impediments hold', () => {
  const satisfied = { attemptId: 'a2', conclusion: 'satisfied' as const };
  assert.deepEqual(dispatchBlockers({ impediments: [], evaluation: satisfied, currentAttempt: 'a2' }), []);
  assert.deepEqual(dispatchBlockers({ impediments: [], evaluation: { ...satisfied, attemptId: 'a1' }, currentAttempt: 'a2' }), ['DEPENDENCIES_NOT_CURRENT']);
  assert.deepEqual(
    dispatchBlockers({ impediments: [], evaluation: satisfied, currentAttempt: null }),
    ['DEPENDENCIES_NOT_CURRENT'],
    'after restart nothing is current',
  );
  assert.deepEqual(dispatchBlockers({ impediments: [{ code: 'DEPENDENCIES_NOT_EVALUATED' }], evaluation: null, currentAttempt: 'a2' }), [
    'DEPENDENCIES_NOT_EVALUATED',
  ]);
  assert.deepEqual(
    dispatchBlockers({ impediments: [], evaluation: null, currentAttempt: 'a2' }),
    ['DEPENDENCIES_NOT_EVALUATED'],
    'no evaluation is never a release, even without the admission placeholder',
  );
  assert.deepEqual(
    dispatchBlockers({ impediments: [{ code: 'DEPENDENCY_PENDING' }], evaluation: { attemptId: 'a2', conclusion: 'pending' }, currentAttempt: 'a2' }),
    ['DEPENDENCY_PENDING'],
  );
});

test('selection: FIFO skips impeded Works without losing their order; independents are selected', () => {
  assert.deepEqual(
    selectNext([
      { work_id: 'a', blockers: ['DEPENDENCY_PENDING'] },
      { work_id: 'b', blockers: [] },
      { work_id: 'c', blockers: [] },
    ]),
    { next: 'b', skipped: [{ work_id: 'a', reasons: ['DEPENDENCY_PENDING'] }] },
  );
  assert.deepEqual(selectNext([{ work_id: 'a', blockers: ['DEPENDENCIES_NOT_CURRENT'] }]), {
    next: null,
    skipped: [{ work_id: 'a', reasons: ['DEPENDENCIES_NOT_CURRENT'] }],
  });
  assert.deepEqual(selectNext([]), { next: null, skipped: [] });
});

test('own classification: index, preserved minimal memory and records; a remembered own Ticket never becomes external', () => {
  const open1 = { work_id: 'w1', cycle: 1, result: 'open' as const, mergeConfirmed: false };
  const delivered1 = { ...open1, result: 'delivered' as const, mergeConfirmed: true };
  const open2 = { work_id: 'w2', cycle: 2, result: 'open' as const, mergeConfirmed: false };
  assert.equal(ownCycleFor({ records: {} }), undefined, 'never indexed nor remembered: external');
  assert.deepEqual(ownCycleFor({ indexed: { current: 'w1', previous: [] }, memory: [open1], records: { w1: open1 } }), {
    source: 'work',
    applicable: open1,
    previousCycles: [],
  });
  // Record gone (e.g. after history exclusion): the preserved minimal memory answers, with the same semantics.
  assert.deepEqual(ownCycleFor({ indexed: { current: 'w1', previous: [] }, memory: [delivered1], records: {} }), {
    source: 'minimal-memory',
    applicable: delivered1,
    previousCycles: [],
  });
  // Index entry removed but memory kept: still own; the last remembered cycle is the applicable one.
  assert.deepEqual(ownCycleFor({ memory: [delivered1, open2], records: {} }), { source: 'minimal-memory', applicable: open2, previousCycles: [delivered1] });
  // Indexed (or remembered) but neither record nor memory of the applicable cycle: own and unsatisfied, never external.
  const missing = ownCycleFor({ indexed: { current: 'w9', previous: [] }, records: {} });
  assert.deepEqual(missing, { source: 'missing', work_id: 'w9' });
  const result = evaluate(graph([node(7001, { blockedBy: [7002] }), closed(7002)]), { 7002: missing! });
  assert.deepEqual([result.conclusion, codes(result), result.blockers[0]!.classification], ['pending', ['OWN_CYCLE_MEMORY_MISSING'], 'own']);
  assert.deepEqual(ownCycleFor({ memory: [open1], records: {}, indexed: { current: 'w3', previous: ['w1'] } }), { source: 'missing', work_id: 'w3' });
});
