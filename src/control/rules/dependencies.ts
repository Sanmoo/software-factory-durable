// Pure native-dependency rules over observed facts (spec §4.2). No I/O, clock, storage or GitHub types: callers pass data and time.

/** One issue reached through native blocked_by. `access: 'edge-only'` = known only from an edge; its own blockers were not read. */
export type GraphNodeFacts = {
  issueId: number;
  nodeId: string;
  repository: string;
  repositoryId: number | null;
  number: number;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  access: 'read' | 'edge-only';
  repositoryRole: 'executable' | 'dependency-only' | 'not-configured';
  /** Issue ids of its native blockers; null when not read. */
  blockedBy: number[] | null;
};
export type GraphProblem = { code: string; issueId?: number; repository?: string; observedCode?: string; waitSeconds?: number; nextStep: string };
export type GraphFacts = { rootIssueId: number; nodes: GraphNodeFacts[]; problems: GraphProblem[] };
/** Minimal per-cycle memory (spec §12.4): identity/order, result and confirmed merge; no request content. */
export type OwnCycle = { work_id: string; cycle: number; result: 'open' | 'cancelled' | 'closed-unmerged' | 'delivered'; mergeConfirmed: boolean };
type Cycle = OwnCycle;
/** Local facts of a blocker that is a Factory Ticket: its applicable (current, else last) cycle from the Work or the preserved minimal memory. */
export type OwnCycleFacts = { source: 'work' | 'minimal-memory'; applicable: Cycle; previousCycles: Cycle[] } | { source: 'missing'; work_id: string };

/**
 * Own classification of one Ticket from the index entry (current/previous cycles), the preserved minimal memory and the Work records.
 * Indexed OR remembered = own, never external; the applicable cycle is the indexed current one, else the last remembered one.
 */
export function ownCycleFor(input: {
  indexed?: { current: string; previous: string[] };
  memory?: Cycle[];
  records: Record<string, Cycle | undefined>;
}): OwnCycleFacts | undefined {
  const memory = input.memory ?? [];
  if (!input.indexed && !memory.length) return undefined;
  const applicableId = input.indexed?.current ?? memory.at(-1)!.work_id;
  const others = [...new Set([...(input.indexed?.previous ?? []), ...memory.map(item => item.work_id)])].filter(id => id !== applicableId);
  const lookup = (id: string) => input.records[id] ?? memory.find(item => item.work_id === id);
  const previousCycles = others.map(lookup).filter((item): item is Cycle => item !== undefined);
  const record = input.records[applicableId];
  if (record) return { source: 'work', applicable: record, previousCycles };
  const remembered = memory.find(item => item.work_id === applicableId);
  return remembered ? { source: 'minimal-memory', applicable: remembered, previousCycles } : { source: 'missing', work_id: applicableId };
}

export type DependencyReason = {
  code: string;
  issueId?: number;
  repository?: string;
  url?: string;
  observedCode?: string;
  waitSeconds?: number;
  stateReason?: string | null;
  path?: number[];
  nextStep: string;
};
export type BlockerView = {
  issueId: number;
  nodeId: string;
  repository: string;
  repositoryId: number | null;
  number: number;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  access: 'read' | 'edge-only';
  repositoryRole: GraphNodeFacts['repositoryRole'];
  classification: 'own' | 'external';
  work_id: string | null;
  direct: boolean;
  satisfied: boolean;
  reason: string | null;
};
export type DependencyConclusion = {
  conclusion: 'satisfied' | 'pending' | 'inconclusive';
  completeness: 'complete' | 'incomplete';
  blockers: BlockerView[];
  cycles: number[][];
  shared: number[];
  reasons: DependencyReason[];
};

/** Depth-first walk from the root over read edges: an edge to a node on the current path is a cycle; to a finished node, sharing. */
export function analyseGraph(graph: GraphFacts): { cycles: number[][]; shared: number[] } {
  const nodes = new Map(graph.nodes.map(item => [item.issueId, item]));
  const state = new Map<number, 'path' | 'done'>();
  const cycles: number[][] = [];
  const shared = new Set<number>();
  const path: number[] = [];
  const visit = (id: number) => {
    state.set(id, 'path');
    path.push(id);
    for (const next of nodes.get(id)?.blockedBy ?? []) {
      const seen = state.get(next);
      if (seen === 'path') cycles.push([...path.slice(path.indexOf(next)), next]);
      else if (seen === 'done') shared.add(next);
      else if (nodes.has(next)) visit(next);
    }
    path.pop();
    state.set(id, 'done');
  };
  if (nodes.has(graph.rootIssueId)) visit(graph.rootIssueId);
  return { cycles, shared: [...shared] };
}

const externalStep = (url: string) =>
  `Blocker ${url} must be closed as completed on GitHub; open, reopened, not planned, duplicate or unknown close reasons do not prove completion and duplicates are not followed.`;
function own(facts: OwnCycleFacts): { satisfied: boolean; code: string | null; work_id: string; nextStep: string } {
  if (facts.source === 'missing')
    return {
      satisfied: false,
      code: 'OWN_CYCLE_MEMORY_MISSING',
      work_id: facts.work_id,
      nextStep:
        'The blocker is a Factory Ticket but its cycle record/memory is unavailable; it is never reclassified as external. Operator must inspect the controller state.',
    };
  const cycle = facts.applicable;
  if (cycle.result === 'delivered' && cycle.mergeConfirmed) return { satisfied: true, code: null, work_id: cycle.work_id, nextStep: '' };
  const code =
    cycle.result === 'delivered'
      ? 'OWN_DELIVERY_NOT_CONFIRMED'
      : cycle.result === 'cancelled'
        ? 'OWN_CYCLE_CANCELLED'
        : cycle.result === 'closed-unmerged'
          ? 'OWN_PULL_REQUEST_CLOSED_UNMERGED'
          : 'OWN_CYCLE_NOT_DELIVERED';
  return {
    satisfied: false,
    code,
    work_id: cycle.work_id,
    nextStep:
      `Own blocker Work ${cycle.work_id} (cycle ${cycle.cycle}) needs a confirmed merge of its own pull request; ` +
      'issue closure, cancellation or the delivery of an earlier cycle do not satisfy it.',
  };
}

/**
 * Satisfaction of the direct blockers of the root plus structural validity of the WHOLE reachable graph: any adapter problem, unread
 * edge target or cycle makes the evaluation inconclusive, even when every direct blocker is closed/delivered.
 */
export function evaluateDependencies(input: { graph: GraphFacts; own: Record<number, OwnCycleFacts | undefined> }): DependencyConclusion {
  const { graph } = input;
  const nodes = new Map(graph.nodes.map(item => [item.issueId, item]));
  const reasons: DependencyReason[] = graph.problems.map(problem => ({ ...problem }));
  const root = nodes.get(graph.rootIssueId);
  let structural = graph.problems.length > 0;
  if (!root || root.access !== 'read' || root.blockedBy === null) {
    if (!structural) reasons.push({ code: 'DEPENDENCY_ROOT_UNREAD', nextStep: 'The Ticket native blockers were not read; nothing is concluded.' });
    structural = true;
  }
  for (const item of graph.nodes)
    for (const target of item.blockedBy ?? []) {
      if (!nodes.has(target)) {
        reasons.push({
          code: 'DEPENDENCY_TARGET_UNREAD',
          issueId: target,
          nextStep: 'A native blocker edge points to an issue that was not read; the graph is incomplete.',
        });
        structural = true;
      }
    }
  const { cycles, shared } = analyseGraph(graph);
  for (const path of cycles) {
    reasons.push({
      code: 'DEPENDENCY_CYCLE',
      path: path.map(id => nodes.get(id)?.number ?? id),
      nextStep: `Native blocked_by relations form a cycle (${path.map(id => nodes.get(id)?.url ?? id).join(' -> ')}); remove one relation on GitHub.`,
    });
  }
  const direct = new Set(root?.blockedBy ?? []);
  const blockers: BlockerView[] = [];
  let pending = false;
  for (const item of graph.nodes) {
    if (item.issueId === graph.rootIssueId) continue;
    const facts = input.own[item.issueId];
    let satisfied: boolean,
      code: string | null,
      step: string,
      work_id: string | null = null;
    if (facts) ({ satisfied, code, nextStep: step, work_id } = own(facts));
    else {
      satisfied = item.state === 'closed' && item.stateReason === 'completed';
      code = satisfied ? null : item.state === 'open' ? 'EXTERNAL_BLOCKER_OPEN' : 'EXTERNAL_BLOCKER_NOT_COMPLETED';
      step = externalStep(item.url);
    }
    const isDirect = direct.has(item.issueId);
    blockers.push({
      issueId: item.issueId,
      nodeId: item.nodeId,
      repository: item.repository,
      repositoryId: item.repositoryId,
      number: item.number,
      url: item.url,
      state: item.state,
      stateReason: item.stateReason,
      access: item.access,
      repositoryRole: item.repositoryRole,
      classification: facts ? 'own' : 'external',
      work_id,
      direct: isDirect,
      satisfied,
      reason: code,
    });
    if (isDirect && !satisfied && code) {
      pending = true;
      reasons.push({ code, issueId: item.issueId, repository: item.repository, url: item.url, stateReason: item.stateReason, nextStep: step });
    }
  }
  const incomplete =
    graph.problems.length > 0 || reasons.some(reason => reason.code === 'DEPENDENCY_TARGET_UNREAD' || reason.code === 'DEPENDENCY_ROOT_UNREAD');
  return {
    conclusion: structural || cycles.length ? 'inconclusive' : pending ? 'pending' : 'satisfied',
    completeness: incomplete ? 'incomplete' : 'complete',
    blockers,
    cycles,
    shared,
    reasons,
  };
}

export const dependencyImpedimentCodes = ['DEPENDENCIES_NOT_EVALUATED', 'DEPENDENCY_PENDING', 'DEPENDENCY_EVALUATION_INCONCLUSIVE'] as const;
const satisfactionCodes = new Set([
  'EXTERNAL_BLOCKER_OPEN',
  'EXTERNAL_BLOCKER_NOT_COMPLETED',
  'OWN_CYCLE_NOT_DELIVERED',
  'OWN_CYCLE_CANCELLED',
  'OWN_PULL_REQUEST_CLOSED_UNMERGED',
  'OWN_DELIVERY_NOT_CONFIRMED',
  'OWN_CYCLE_MEMORY_MISSING',
  /** Jira ticket 04: a visible "is blocked by" neighbour of a Jira Work's Card not in the Done category. */ 'JIRA_BLOCKER_NOT_DONE',
]);

/** Work-scoped impediments derived from one evaluation; pending blockers and an inconclusive read coexist, neither hides the other. */
export function dependencyImpediments(
  result: DependencyConclusion,
  since: string,
): { code: (typeof dependencyImpedimentCodes)[number]; scope: 'work'; since: string; nextStep: string }[] {
  const pending = result.reasons.filter(reason => satisfactionCodes.has(reason.code));
  const structural = result.reasons.filter(reason => !satisfactionCodes.has(reason.code));
  return [
    ...(pending.length
      ? [
          {
            code: 'DEPENDENCY_PENDING' as const,
            scope: 'work' as const,
            since,
            nextStep: `Waiting for native blockers: ${pending.map(reason => `${reason.url ?? 'blocker'} (${reason.code})`).join(', ')}. Polling re-evaluates; no second approval is needed.`,
          },
        ]
      : []),
    ...(structural.length
      ? [
          {
            code: 'DEPENDENCY_EVALUATION_INCONCLUSIVE' as const,
            scope: 'work' as const,
            since,
            nextStep:
              `Dependency evaluation inconclusive (${[...new Set(structural.map(reason => reason.code))].join(', ')}); an earlier evaluation never releases. ` +
              structural.map(reason => reason.nextStep).join(' '),
          },
        ]
      : []),
  ];
}

/**
 * Work-level reasons that prevent a start/resume/repair now. Only an evaluation produced in the CURRENT attempt counts: an evaluation
 * from an earlier polling round, an earlier owner run or another attempt never grants a new dispatch.
 */
export function dispatchBlockers(input: {
  impediments: { code: string }[];
  evaluation: { attemptId: string; conclusion: string } | null;
  currentAttempt: string | null;
}): string[] {
  const reasons = input.impediments.map(item => item.code);
  if (!input.evaluation && !reasons.includes('DEPENDENCIES_NOT_EVALUATED')) reasons.push('DEPENDENCIES_NOT_EVALUATED');
  if (input.evaluation && (input.currentAttempt === null || input.evaluation.attemptId !== input.currentAttempt)) reasons.push('DEPENDENCIES_NOT_CURRENT');
  return reasons;
}

/** FIFO selection: impeded Works are skipped without losing their position and never block the independents behind them. */
export function selectNext(queue: { work_id: string; blockers: string[] }[]): { next: string | null; skipped: { work_id: string; reasons: string[] }[] } {
  const skipped: { work_id: string; reasons: string[] }[] = [];
  for (const item of queue) {
    if (!item.blockers.length) return { next: item.work_id, skipped };
    skipped.push({ work_id: item.work_id, reasons: item.blockers });
  }
  return { next: null, skipped };
}
