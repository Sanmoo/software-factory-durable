import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolLedger, declarationsSchema } from '../../src/workers/gates.js';

// Level R (Host logic, no SDK): gate evidence comes ONLY from the Host ledger of the Builder's own protected Bash results AND from the
// content snapshot taken before/after each command. A gate is current only when the command did not change the content and the captured
// proposal still has exactly the content the gate ran on: tool-call names/order are never the criterion.
const output = { workId: 'w', id: '11111111-2222-4333-8444-555555555555' };
const CWD = '/workspace';
const gate = (id: string, command: string, extra: object = {}) => ({ id, source: '/artifacts/spec/v1/ticket.json#validation', command, cwd: CWD, status: 'run', ...extra });
const capture = 'a'.repeat(64);
const ran = (ledger: ReturnType<typeof createToolLedger>, id: string, command: string, input: { before?: string; after?: string; exit?: number | null;
  cwd?: string; output?: typeof output | null; code?: string | null } = {}) => {
  ledger.begin('bash', `c-${id}`);
  ledger.bash(`c-${id}`, { command, cwd: input.cwd ?? CWD, exitCode: input.exit === undefined ? 0 : input.exit, output: input.output === undefined ? output : input.output,
    code: input.code ?? (input.exit === null ? 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' : null), contentBeforeSha: input.before ?? capture, contentAfterSha: input.after ?? input.before ?? capture });
};

test('AC2/AC3: run gates take outcome, exit code and protected output from the real Bash result; success, failure, absence and lost results are distinct', () => {
  const ledger = createToolLedger();
  ran(ledger, 'a', 'npm test', { exit: 1 });
  ledger.begin('write', 'w1');
  ran(ledger, 'b', 'npm test');
  ran(ledger, 'c', 'npm run lint', { exit: 2 });
  ran(ledger, 'd', 'npm run e2e', { exit: null, output: null });
  ledger.begin('read', 'r1');
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test'), gate('lint', 'npm run lint'), gate('e2e', 'npm run e2e'),
    gate('typecheck', 'npm run typecheck'), gate('docs', 'npm run docs', { status: 'not-run', reason: 'no instruction says how to build the docs' }),
    gate('ci', 'npm run ci', { status: 'waived', reason: 'operator approved', authorization: { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' }, requiredCheck: 'ci/build' })] }),
  { captureContentSha: capture });
  const byId = Object.fromEntries(resolved.gates.map(item => [item.id, item]));
  assert.deepEqual([byId.test!.outcome, byId.test!.exitCode, byId.test!.output, byId.test!.current, byId.test!.code], ['passed', 0, output, true, null], 'the LATEST run of the exact command');
  assert.deepEqual([byId.lint!.outcome, byId.lint!.exitCode], ['failed', 2]);
  assert.deepEqual([byId.e2e!.outcome, byId.e2e!.exitCode, byId.e2e!.code], ['unknown', null, 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN'], 'a lost result is never success');
  assert.deepEqual([byId.typecheck!.outcome, byId.typecheck!.code, byId.typecheck!.output], ['unverified', 'GATE_RESULT_NOT_FOUND', null], 'a declared but never executed command has no evidence');
  assert.deepEqual([byId.docs!.outcome, byId.docs!.reason], ['not-run', 'no instruction says how to build the docs']);
  assert.deepEqual([byId.ci!.outcome, byId.ci!.requiredCheck, byId.ci!.authorization], ['waived', 'ci/build', { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' }]);
  assert.equal(declarationsSchema.safeParse({ gates: [{ ...gate('x', 'npm test'), output: 'ALL GREEN', exitCode: 0 }] }).success, false, 'no declared output/status');
  assert.equal(declarationsSchema.safeParse({ gates: [gate('x', 'npm test', { status: 'waived', reason: 'faster' })] }).success, false, 'a waiver without authorization is refused');
  assert.equal(declarationsSchema.safeParse({ gates: [gate('x', 'npm test', { status: 'not-run' })] }).success, false, 'not run without a reason is refused');
});

test('AC2/AC3 HIGH review fix 1: a real gate on C0 followed by a DECLARED mutating gate to C1 makes the real gate not current (content snapshot, not tool-call names)', () => {
  const ledger = createToolLedger();
  const c0 = '0'.repeat(64), c1 = '1'.repeat(64);
  ran(ledger, 'build', 'npm test', { before: c0, after: c0 });
  ledger.begin('bash', 'mutate');
  ledger.bash('mutate', { command: 'npm run build', cwd: CWD, exitCode: 0, output, code: null, contentBeforeSha: c0, contentAfterSha: c1 });
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test'), gate('build', 'npm run build')] }), { captureContentSha: c1 });
  assert.deepEqual(resolved.gates.map(item => [item.id, item.outcome, item.current, item.code]),
    [['test', 'passed', false, 'GATE_NOT_CURRENT'], ['build', 'passed', false, 'GATE_MUTATED_CONTENT']], 'the gate that mutated the content is not evidence of the captured proposal');
});

test('AC2/AC3 HIGH review fix 1: a background mutator after a gate (or between commands) is caught by the captured content', () => {
  const ledger = createToolLedger();
  const c0 = '0'.repeat(64), c1 = '1'.repeat(64);
  ran(ledger, 'test', 'npm test', { before: c0, after: c0 });
  // A background process started earlier writes after the gate returned: the capture later sees c1.
  let resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: c1 });
  assert.deepEqual([resolved.gates[0]!.outcome, resolved.gates[0]!.current, resolved.gates[0]!.code], ['passed', false, 'GATE_NOT_CURRENT']);
  // A background mutation between before and after the command itself is a content change.
  const ledger2 = createToolLedger();
  ran(ledger2, 'test', 'npm test', { before: c0, after: c1 });
  resolved = ledger2.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: c1 });
  assert.deepEqual([resolved.gates[0]!.current, resolved.gates[0]!.code], [false, 'GATE_MUTATED_CONTENT']);
  // No content snapshots (probe failed / earlier Factory capture): fail closed, never current.
  const ledger3 = createToolLedger();
  ledger3.begin('bash', 'x');
  ledger3.bash('x', { command: 'npm test', cwd: CWD, exitCode: 0, output, code: null, contentBeforeSha: null, contentAfterSha: null });
  resolved = ledger3.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: c1 });
  assert.deepEqual([resolved.gates[0]!.current, resolved.gates[0]!.code], [false, 'GATE_SNAPSHOT_UNAVAILABLE']);
  const ledger4 = createToolLedger();
  ran(ledger4, 'test', 'npm test');
  resolved = ledger4.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: null });
  assert.deepEqual([resolved.gates[0]!.current, resolved.gates[0]!.code], [false, 'GATE_CONTENT_UNAVAILABLE']);
});

test('AC2 HIGH/MEDIUM review fix 2: the declared cwd must be the ACTUAL bash cwd; a mismatch is not current', () => {
  const ledger = createToolLedger();
  ran(ledger, 'test', 'npm test', { cwd: '/workspace' });
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('ok', 'npm test'), gate('wrong', 'npm test', { cwd: '/workspace/checkout' })] }), { captureContentSha: capture });
  const byId = Object.fromEntries(resolved.gates.map(item => [item.id, item]));
  assert.deepEqual([byId.ok!.current, byId.ok!.code], [true, null], 'the Host-fixed cwd must be declared');
  assert.deepEqual([byId.wrong!.outcome, byId.wrong!.current, byId.wrong!.code], ['passed', false, 'GATE_CWD_MISMATCH'], 'a declared cwd the command never ran in is never evidence');
});

test('AC2/AC3 LOW review fix 6: ledger exhaustion makes every declared run gate explicitly unverified, never silently stale', () => {
  const ledger = createToolLedger({ maxCalls: 2 });
  ran(ledger, 'a', 'npm test');
  ran(ledger, 'b', 'npm run lint');
  ledger.begin('bash', 'c');
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: capture });
  assert.deepEqual([resolved.gates[0]!.outcome, resolved.gates[0]!.current, resolved.gates[0]!.code], ['unverified', false, 'GATE_LEDGER_EXHAUSTED']);
});

test('AC2/AC3 LOW review fix 6: interleaved tool batches keep each Bash result bound to its call id; start order never decides validity', () => {
  const ledger = createToolLedger();
  // write/edit may overlap a Bash (only Bash-to-Bash order is exact): begin order differs from completion order here.
  ledger.begin('bash', 'first');
  ledger.begin('write', 'w1');
  ledger.begin('bash', 'second');
  ledger.bash('second', { command: 'npm test', cwd: CWD, exitCode: 0, output, code: null, contentBeforeSha: capture, contentAfterSha: capture });
  ledger.bash('first', { command: 'npm run lint', cwd: CWD, exitCode: 0, output, code: null, contentBeforeSha: capture, contentAfterSha: capture });
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test'), gate('lint', 'npm run lint')] }), { captureContentSha: capture });
  assert.deepEqual(resolved.gates.map(item => [item.id, item.outcome, item.sequence, item.current]),
    [['test', 'passed', 3, true], ['lint', 'passed', 1, true]], 'each call id keeps its own result/sequence and both are current by content');
});

test('AC2/AC3 LOW review fix 6: the real 4096-call bound never keeps a gate silently current after exhaustion', () => {
  const ledger = createToolLedger();
  ran(ledger, 'gate', 'npm test'); // call 1: real evidence on the captured content
  for (let index = 1; index < 4096; index++) ledger.begin('read', `r${index}`);
  assert.equal(ledger.exhausted(), false, 'exactly at the bound is still complete');
  let resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: capture });
  assert.deepEqual([resolved.gates[0]!.outcome, resolved.gates[0]!.current, resolved.gates[0]!.code], ['passed', true, null], 'the recorded gate is evidence while the ledger is complete');
  ledger.begin('bash', 'overflow'); // call 4097: dropped, so the ledger is explicitly exhausted
  assert.equal(ledger.exhausted(), true);
  resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test')] }), { captureContentSha: capture });
  assert.deepEqual([resolved.gates[0]!.outcome, resolved.gates[0]!.current, resolved.gates[0]!.code], ['unverified', false, 'GATE_LEDGER_EXHAUSTED'],
    'past the bound an old result is never silently presented as current evidence');
});

test('AC1: treatments record fixed or not adopted with justification, optional evidence and a concrete authorization reference', () => {
  const ledger = createToolLedger();
  const parsed = declarationsSchema.parse({ treatments: [
    { round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'Added the Rollback section.', evidence: 'docs/smoke.md#rollback' },
    { round: 1, role: 'standards', findingId: 'H1', outcome: 'not-adopted', justification: 'Heuristic; the Ticket fixes this file name.',
      authorization: { kind: 'preserved-source', reference: '/artifacts/spec/v1/ticket.json#body' } }] });
  assert.deepEqual(ledger.resolve(parsed, { captureContentSha: capture }).treatments.map(item => [item.findingId, item.outcome, item.evidence, item.authorization?.kind ?? null]),
    [['S1', 'fixed', 'docs/smoke.md#rollback', null], ['H1', 'not-adopted', null, 'preserved-source']]);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: '' }] }).success, false);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'ignored', justification: 'x' }] }).success, false);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'x',
    authorization: { kind: 'preserved-source', reference: '/workspace/checkout/README.md' } }] }).success, false, 'authorization only from a preserved source or a Question');
});
