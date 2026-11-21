// Ticket 34: the candidate qualification matrix (docs/evidence/34-qualification-matrix.json) stays honest against the approved
// acceptance plan (.scratch/software-factory/acceptance-and-incremental-plan.md). Pure checks over files of the checkout: every
// scenario V-01..V-17 and every RF/RNF/CA of the plan is present, statuses come from the allowed set, an approved obligation cites
// existing evidence and the real levels the plan requires (a historical real run counts only when its applicability to the
// candidate is recorded), the aggregates never turn a pilot dependency or an inconclusive obligation into an approval, and every
// open obligation has a gate and a pointer. Operator decisions (D-01..D-08, 2026-11-16; D-09..D-10, 2026-11-17; D-11..D-17, 2026-11-18) are recorded with their resolution: a level is
// waived only by a `level-waived` decision naming the obligation (never P), and a pre-pilot obligation is a pilot dependency only when a
// decision carried it to the pilot (ticket 35). It does not run anything real and does not judge the evidence itself.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const statuses = ['aprovada', 'reprovada', 'inconclusiva', 'dependente-do-piloto'] as const;
type Status = (typeof statuses)[number];
const levels = ['S', 'I', 'A', 'P'] as const;
const applicabilities = ['aplicavel', 'aplicavel-encadeada', 'inconclusiva'] as const;

interface Obligation {
  id: string;
  scenario: string;
  requirements: string[];
  requiredLevels: string[];
  observedLevels: string[];
  status: string;
  expectation: string;
  observed: string;
  evidence: string[];
  runs: string[];
  commands: string[];
  gate?: string;
  pointer?: string;
  reexecution?: string[];
  decision?: { id: string; waivedLevels?: string[] };
}
interface Matrix {
  schemaVersion: number;
  candidate: { commit: string; integrationBranch: string };
  realRuns: { id: string; commit: string; applicability: string; reason: string; evidence: string[] }[];
  scenarios: { id: string; requiredLevels: string[]; status: string }[];
  requirements: { id: string; status: string }[];
  obligations: Obligation[];
  gates: { id: string; status: string; blockers: string[] }[];
  reexecutionGroups: { id: string; covers: string[]; authorizationRequired: boolean }[];
  operatorDecisions: {
    id: string;
    obligations: string[];
    dependency: string;
    decidedAt?: string;
    decidedBy?: string;
    decision?: string;
    resolution?: string;
  }[];
  counts: Record<string, number>;
}
const resolutions = [
  'carried-to-pilot',
  'out-of-scope-unless-pilot-needs',
  'scope-required',
  'level-waived',
  'proof-accepted',
  'limit-accepted',
  'implemented',
] as const;
const pilotResolutions = new Set<string>(['carried-to-pilot', 'out-of-scope-unless-pilot-needs']);

interface Plan {
  scenarios: Map<string, string[]>;
  requirements: string[];
  requirementScenarios: Map<string, string[]>;
}

/** Scenario ids with their required levels ("**Evidência exigida: S + I; A …**") and the RF/RNF/CA rows of the plan. */
export function parsePlan(text: string): Plan {
  const scenarios = new Map<string, string[]>();
  const sections = text.split(/^### /m).slice(1);
  for (const section of sections) {
    const id = /^(V-\d{2})\b/.exec(section)?.[1];
    if (id === undefined) continue;
    const line = /\*\*Evidência exigida: ([^*]+)\*\*/.exec(section)?.[1] ?? '';
    scenarios.set(
      id,
      levels.filter(level => new RegExp(`\\b${level}\\b`).test(line)),
    );
  }
  const rows = [...text.matchAll(/^\| ((?:RF|RNF|CA)-\d{2}) —(.*)$/gm)];
  const requirements = rows.map(match => match[1]!);
  const requirementScenarios = new Map(rows.map(match => [match[1]!, [...match[2]!.matchAll(/\(#v-(\d{2})-/g)].map(link => `V-${link[1]!}`)]));
  return { scenarios, requirements, requirementScenarios };
}

const rank: Record<Status, number> = { aprovada: 0, 'dependente-do-piloto': 1, inconclusiva: 2, reprovada: 3 };

/** The aggregate of a set of obligations: the worst one wins; a pilot dependency is never an approval. */
export function aggregate(values: string[]): Status {
  if (values.length === 0) return 'inconclusiva';
  return values.map(value => value as Status).reduce((worst, value) => (rank[value] > rank[worst] ? value : worst), 'aprovada');
}

/** Every problem found, as text; an empty list means the matrix is consistent with the plan and the checkout. */
export function problems(matrix: Matrix, plan: Plan, exists: (path: string) => boolean): string[] {
  const found: string[] = [];
  const add = (problem: string): void => {
    found.push(problem);
  };
  if (matrix.schemaVersion !== 1) add(`schemaVersion ${String(matrix.schemaVersion)}`);
  if (!/^[0-9a-f]{40}$/.test(matrix.candidate.commit)) add('candidate.commit is not a full commit id');
  const runs = new Map(matrix.realRuns.map(run => [run.id, run]));
  for (const run of matrix.realRuns) {
    if (!(applicabilities as readonly string[]).includes(run.applicability)) add(`run ${run.id}: applicability ${run.applicability}`);
    if (run.reason.trim() === '') add(`run ${run.id}: no applicability reason`);
    if (!/^([0-9a-f]{7,40}|nao-registrado)$/.test(run.commit)) add(`run ${run.id}: commit ${run.commit}`);
    for (const path of run.evidence) if (!exists(path)) add(`run ${run.id}: missing evidence ${path}`);
  }
  const scenarioIds = new Set(matrix.scenarios.map(scenario => scenario.id));
  for (const [id, required] of plan.scenarios) {
    const scenario = matrix.scenarios.find(candidate => candidate.id === id);
    if (scenario === undefined) {
      add(`scenario ${id} missing`);
      continue;
    }
    if ([...scenario.requiredLevels].sort().join() !== [...required].sort().join()) {
      add(`scenario ${id}: levels ${scenario.requiredLevels.join('+')} differ from the plan ${required.join('+')}`);
    }
  }
  for (const id of scenarioIds) if (!plan.scenarios.has(id)) add(`scenario ${id} not in the plan`);
  const requirementIds = new Set(matrix.requirements.map(requirement => requirement.id));
  for (const id of plan.requirements) if (!requirementIds.has(id)) add(`requirement ${id} missing`);
  for (const id of requirementIds) if (!plan.requirements.includes(id)) add(`requirement ${id} not in the plan`);
  const groups = new Set(matrix.reexecutionGroups.map(group => group.id));
  const obligationIds = new Set<string>();
  const decisions = new Map(matrix.operatorDecisions.map(decision => [decision.id, decision]));
  for (const obligation of matrix.obligations) {
    const name = `obligation ${obligation.id}`;
    if (obligationIds.has(obligation.id)) add(`${name} duplicated`);
    obligationIds.add(obligation.id);
    if (!(statuses as readonly string[]).includes(obligation.status)) add(`${name}: status ${obligation.status}`);
    if (!plan.scenarios.has(obligation.scenario)) add(`${name}: unknown scenario ${obligation.scenario}`);
    else {
      const allowed = plan.scenarios.get(obligation.scenario)!;
      for (const level of obligation.requiredLevels) if (!allowed.includes(level)) add(`${name}: level ${level} not required by ${obligation.scenario}`);
    }
    if (obligation.requirements.length === 0) add(`${name}: no RF/RNF/CA`);
    for (const id of obligation.requirements) {
      if (!requirementIds.has(id)) add(`${name}: unknown requirement ${id}`);
      else if (!(plan.requirementScenarios.get(id) ?? []).includes(obligation.scenario))
        add(`${name}: the plan does not trace ${id} to ${obligation.scenario}`);
    }
    for (const level of obligation.observedLevels) if (!(levels as readonly string[]).includes(level)) add(`${name}: level ${level}`);
    if (obligation.expectation.trim() === '' || obligation.observed.trim() === '') add(`${name}: no expectation/observed`);
    for (const path of obligation.evidence) if (!exists(path)) add(`${name}: missing evidence ${path}`);
    for (const id of obligation.runs) if (!runs.has(id)) add(`${name}: unknown run ${id}`);
    for (const id of obligation.reexecution ?? []) if (!groups.has(id)) add(`${name}: unknown re-execution group ${id}`);
    const pilot = obligation.requiredLevels.includes('P');
    if (pilot && obligation.status !== 'dependente-do-piloto') add(`${name}: a P obligation is ${obligation.status} before the pilot`);
    const decided = obligation.decision ? decisions.get(obligation.decision.id) : undefined;
    if (obligation.decision && (!decided || !decided.obligations.includes(obligation.id))) add(`${name}: decision ${obligation.decision.id} does not name it`);
    const carried = decided !== undefined && pilotResolutions.has(decided.resolution ?? '') && /ticket 35/.test(decided.dependency);
    if (!pilot && obligation.status === 'dependente-do-piloto' && !carried) add(`${name}: pre-pilot obligation marked as pilot dependency`);
    for (const level of obligation.decision?.waivedLevels ?? []) {
      if (decided?.resolution !== 'level-waived') add(`${name}: level ${level} waived without a level-waived decision`);
      if (level === 'P') add(`${name}: the pilot level is never waived`);
      if (obligation.requiredLevels.includes(level)) add(`${name}: level ${level} both waived and required`);
      if (!(plan.scenarios.get(obligation.scenario) ?? []).includes(level)) add(`${name}: waived level ${level} is not a level of ${obligation.scenario}`);
    }
    if (obligation.status === 'aprovada') {
      if (obligation.evidence.length === 0) add(`${name}: approved without evidence`);
      for (const level of obligation.requiredLevels) if (!obligation.observedLevels.includes(level)) add(`${name}: approved without level ${level}`);
      const real = obligation.requiredLevels.some(level => level === 'I' || level === 'A');
      const usable = obligation.runs.filter(id => runs.get(id)?.applicability !== 'inconclusiva' && runs.has(id));
      if (real && usable.length === 0) add(`${name}: approved at I/A without an applicable real run`);
      if (obligation.commands.length === 0) add(`${name}: approved without commands`);
    } else if (obligation.gate === undefined || obligation.pointer === undefined || obligation.pointer.trim() === '') {
      add(`${name}: ${obligation.status} without gate and pointer`);
    }
  }
  for (const scenario of matrix.scenarios) {
    const expected = aggregate(matrix.obligations.filter(obligation => obligation.scenario === scenario.id).map(obligation => obligation.status));
    if (scenario.status !== expected) add(`scenario ${scenario.id}: status ${scenario.status}, obligations give ${expected}`);
  }
  for (const requirement of matrix.requirements) {
    const expected = aggregate(matrix.obligations.filter(obligation => obligation.requirements.includes(requirement.id)).map(obligation => obligation.status));
    if (requirement.status !== expected) add(`requirement ${requirement.id}: status ${requirement.status}, obligations give ${expected}`);
  }
  for (const gate of matrix.gates) {
    for (const id of gate.blockers) if (!obligationIds.has(id)) add(`gate ${gate.id}: unknown blocker ${id}`);
    if (gate.status === 'aprovada' && gate.blockers.length > 0) add(`gate ${gate.id}: approved with blockers`);
  }
  for (const obligation of matrix.obligations) {
    if (obligation.status !== 'inconclusiva' && obligation.status !== 'reprovada') continue;
    if (!matrix.gates.some(gate => gate.id === obligation.gate && gate.blockers.includes(obligation.id))) {
      add(`obligation ${obligation.id}: does not block its gate ${String(obligation.gate)}`);
    }
  }
  for (const group of matrix.reexecutionGroups) {
    if (!group.authorizationRequired) add(`re-execution ${group.id}: without its own authorization`);
    for (const id of group.covers) if (!obligationIds.has(id)) add(`re-execution ${group.id}: unknown obligation ${id}`);
  }
  for (const decision of matrix.operatorDecisions) {
    if (decision.dependency.trim() === '') add(`decision ${decision.id}: no explicit dependency`);
    for (const id of decision.obligations) if (!obligationIds.has(id)) add(`decision ${decision.id}: unknown obligation ${id}`);
    // A recorded decision names its date, author, text and resolution, and every obligation it names points back to it.
    if (decision.resolution === undefined) continue;
    if (!(resolutions as readonly string[]).includes(decision.resolution)) add(`decision ${decision.id}: resolution ${decision.resolution}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(decision.decidedAt ?? '') || !decision.decidedBy || !decision.decision?.trim())
      add(`decision ${decision.id}: incomplete record`);
    for (const id of decision.obligations)
      if (matrix.obligations.find(obligation => obligation.id === id)?.decision?.id !== decision.id) add(`decision ${decision.id}: ${id} does not cite it`);
  }
  const counted = Object.fromEntries(statuses.map(status => [status, matrix.obligations.filter(obligation => obligation.status === status).length]));
  if (JSON.stringify(counted) !== JSON.stringify(Object.fromEntries(statuses.map(status => [status, matrix.counts[status] ?? 0])))) {
    add(`counts ${JSON.stringify(matrix.counts)} differ from the obligations ${JSON.stringify(counted)}`);
  }
  return found;
}

const root = process.cwd();
const plan = parsePlan(readFileSync(join(root, '.scratch/software-factory/acceptance-and-incremental-plan.md'), 'utf8'));
const matrix = JSON.parse(readFileSync(join(root, 'docs/evidence/34-qualification-matrix.json'), 'utf8')) as Matrix;

test('the plan parses into V-01..V-17 and the 31 RF/RNF/CA rows', () => {
  assert.deepEqual(
    [...plan.scenarios.keys()],
    Array.from({ length: 17 }, (_, index) => `V-${String(index + 1).padStart(2, '0')}`),
  );
  assert.deepEqual(plan.scenarios.get('V-01'), ['S', 'I']);
  assert.deepEqual(plan.scenarios.get('V-02'), ['I', 'A']);
  assert.deepEqual(plan.scenarios.get('V-17'), ['I', 'A', 'P']);
  assert.equal(plan.requirements.length, 14 + 5 + 12);
  assert.deepEqual(plan.requirementScenarios.get('CA-08'), ['V-02', 'V-06', 'V-17']);
});

test('aggregate: the worst obligation wins and a pilot dependency never reads as approved', () => {
  assert.equal(aggregate(['aprovada', 'aprovada']), 'aprovada');
  assert.equal(aggregate(['aprovada', 'dependente-do-piloto']), 'dependente-do-piloto');
  assert.equal(aggregate(['dependente-do-piloto', 'inconclusiva']), 'inconclusiva');
  assert.equal(aggregate(['inconclusiva', 'reprovada', 'aprovada']), 'reprovada');
  assert.equal(aggregate([]), 'inconclusiva', 'no obligation is not an approval');
});

test('the checker detects the dishonest shapes it exists for', () => {
  const base = structuredClone(matrix);
  const approved = base.obligations.find(obligation => obligation.status === 'aprovada' && obligation.requiredLevels.includes('I'));
  assert.ok(approved, 'the matrix has an approved I obligation to mutate');
  const cases: [string, (copy: Matrix) => void, RegExp][] = [
    [
      'missing evidence file',
      copy => {
        copy.obligations.find(o => o.id === approved.id)!.evidence.push('docs/evidence/does-not-exist.md');
      },
      /missing evidence/,
    ],
    [
      'unknown status',
      copy => {
        copy.obligations.find(o => o.id === approved.id)!.status = 'parcial';
      },
      /status parcial/,
    ],
    [
      'approved by S only',
      copy => {
        copy.obligations.find(o => o.id === approved.id)!.observedLevels = ['S'];
      },
      /approved without level I/,
    ],
    [
      'stale real run',
      copy => {
        for (const run of copy.realRuns) run.applicability = 'inconclusiva';
      },
      /without an applicable real run/,
    ],
    [
      'scenario dropped',
      copy => {
        copy.scenarios = copy.scenarios.filter(s => s.id !== 'V-09');
      },
      /scenario V-09 missing/,
    ],
    [
      'requirement dropped',
      copy => {
        copy.requirements = copy.requirements.filter(r => r.id !== 'CA-08');
      },
      /requirement CA-08 missing/,
    ],
    [
      'pilot as approval',
      copy => {
        const o = copy.obligations.find(x => x.requiredLevels.includes('P'))!;
        o.status = 'aprovada';
      },
      /a P obligation is aprovada/,
    ],
    // No obligation is inconclusive since 2026-11-18 (99/0/0/13): reopen one to check the rule.
    [
      'open without pointer',
      copy => {
        const o = copy.obligations.find(x => x.id === approved.id)!;
        o.status = 'inconclusiva';
        delete o.pointer;
      },
      /without gate and pointer/,
    ],
    [
      'untraced requirement',
      copy => {
        copy.obligations.find(o => o.id === 'V-01.a')!.requirements.push('CA-08');
      },
      /does not trace CA-08 to V-01/,
    ],
    [
      're-execution without authorization',
      copy => {
        copy.reexecutionGroups[0]!.authorizationRequired = false;
      },
      /without its own authorization/,
    ],
    [
      'pilot dependency without a decision',
      copy => {
        delete copy.obligations.find(o => o.id === 'V-06.e')!.decision;
      },
      /V-06.e: pre-pilot obligation marked as pilot dependency/,
    ],
    [
      'carried without naming the pilot',
      copy => {
        copy.operatorDecisions.find(d => d.id === 'D-01')!.dependency = 'CA-08';
      },
      /V-06.e: pre-pilot obligation marked as pilot dependency/,
    ],
    [
      'waiver without a level-waived decision',
      copy => {
        copy.obligations.find(o => o.id === 'V-07.e')!.decision!.waivedLevels = ['A'];
      },
      /waived without a level-waived decision/,
    ],
    [
      'pilot level waived',
      copy => {
        const o = copy.obligations.find(x => x.id === 'V-15.e')!;
        o.decision!.waivedLevels = ['I', 'P'];
      },
      /the pilot level is never waived/,
    ],
    [
      'decision not cited',
      copy => {
        delete copy.obligations.find(o => o.id === 'V-14.g')!.decision;
      },
      /decision D-07: V-14.g does not cite it/,
    ],
    [
      'counts drift',
      copy => {
        copy.counts['aprovada'] = 66;
      },
      /counts .* differ from the obligations/,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const copy = structuredClone(base);
    mutate(copy);
    const found = problems(copy, plan, path => existsSync(join(root, path)));
    assert.ok(
      found.some(problem => expected.test(problem)),
      `${name}: ${found.join('; ') || 'no problem found'}`,
    );
  }
});

test('docs/evidence/34-qualification-matrix.json is consistent with the plan and the checkout', () => {
  assert.deepEqual(
    problems(matrix, plan, path => existsSync(join(root, path))),
    [],
  );
});

test('the operator decisions D-01..D-08 of 2026-11-16, D-09..D-10 of 2026-11-17 and D-11..D-17 of 2026-11-18 are all recorded with a resolution', () => {
  assert.deepEqual(
    matrix.operatorDecisions.map(decision => [decision.id, decision.decidedAt, decision.resolution]),
    [
      ['D-01', '2026-11-16', 'carried-to-pilot'],
      ['D-02', '2026-11-16', 'scope-required'],
      ['D-03', '2026-11-16', 'level-waived'],
      ['D-04', '2026-11-16', 'out-of-scope-unless-pilot-needs'],
      ['D-05', '2026-11-16', 'proof-accepted'],
      ['D-06', '2026-11-16', 'limit-accepted'],
      ['D-07', '2026-11-16', 'implemented'],
      ['D-08', '2026-11-16', 'level-waived'],
      ['D-09', '2026-11-17', 'proof-accepted'],
      ['D-10', '2026-11-17', 'proof-accepted'],
      ['D-11', '2026-11-18', 'proof-accepted'],
      ['D-12', '2026-11-18', 'proof-accepted'],
      ['D-13', '2026-11-18', 'proof-accepted'],
      ['D-14', '2026-11-18', 'proof-accepted'],
      ['D-15', '2026-11-18', 'carried-to-pilot'],
      ['D-16', '2026-11-18', 'proof-accepted'],
      ['D-17', '2026-11-18', 'limit-accepted'],
    ],
  );
  // D-02 keeps cross-repository dependencies as a required pre-pilot proof: approved only by the real R-GH-DEP run, never by the decision.
  // D-15 records V-06.g as a KNOWN PILOT RISK: carried to the pilot (ticket 35), never an approval.
  const pilotRisk = matrix.obligations.find(obligation => obligation.id === 'V-06.g')!;
  assert.equal(pilotRisk.status, 'dependente-do-piloto');
  assert.match(matrix.operatorDecisions.find(decision => decision.id === 'D-15')!.decision ?? '', /RISCO CONHECIDO DO PILOTO/);
  const crossRepository = matrix.obligations.find(obligation => obligation.id === 'V-05.c')!;
  assert.ok(crossRepository.reexecution?.includes('R-GH-DEP'));
  if (crossRepository.status === 'aprovada') assert.ok(crossRepository.runs.includes('q34-ghdep-v1'), 'V-05.c approved by the R-GH-DEP run');
  else assert.ok(matrix.gates.some(gate => gate.blockers.includes('V-05.c')));
});

test('the report names the candidate commit and every open obligation of the matrix', () => {
  const report = readFileSync(join(root, 'docs/evidence/34-candidate-qualification.md'), 'utf8');
  assert.ok(report.includes(matrix.candidate.commit), 'report names the candidate commit');
  const open = matrix.obligations.filter(obligation => obligation.status === 'inconclusiva' || obligation.status === 'reprovada');
  for (const obligation of open) assert.ok(report.includes(obligation.id), `report lists ${obligation.id}`);
  for (const group of matrix.reexecutionGroups) assert.ok(report.includes(group.id), `report lists re-execution ${group.id}`);
});
