import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolLedger, declarationsSchema } from '../../src/workers/gates.js';

// Level R (Host logic, no SDK): gate evidence comes ONLY from the Host ledger of the Builder's own protected Bash results.
const output = { workId: 'w', id: '11111111-2222-4333-8444-555555555555' };
const gate = (id: string, command: string, extra: object = {}) => ({ id, source: '/artifacts/spec/v1/ticket.json#validation', command, cwd: '/workspace/checkout', status: 'run', ...extra });

test('AC2/AC3: run gates take outcome, exit code and protected output from the real Bash result; success, failure and lost result are distinct', () => {
  const ledger = createToolLedger();
  ledger.begin('bash', 'c1'); ledger.bash('c1', { command: 'npm test', exitCode: 1, output, code: null });
  ledger.begin('write', 'c2');
  ledger.begin('bash', 'c3'); ledger.bash('c3', { command: 'npm test', exitCode: 0, output, code: null });
  ledger.begin('bash', 'c4'); ledger.bash('c4', { command: 'npm run lint', exitCode: 2, output, code: null });
  ledger.begin('bash', 'c5'); ledger.bash('c5', { command: 'npm run e2e', exitCode: null, output: null, code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' });
  ledger.begin('read', 'c6');
  const resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('test', 'npm test'), gate('lint', 'npm run lint'), gate('e2e', 'npm run e2e'),
    gate('typecheck', 'npm run typecheck'), gate('docs', 'npm run docs', { status: 'not-run', reason: 'no instruction says how to build the docs' }),
    gate('ci', 'npm run ci', { status: 'waived', reason: 'operator approved', authorization: { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' }, requiredCheck: 'ci/build' })] }));
  const byId = Object.fromEntries(resolved.gates.map(item => [item.id, item]));
  assert.deepEqual([byId.test!.outcome, byId.test!.exitCode, byId.test!.output, byId.test!.current], ['passed', 0, output, true], 'the LATEST run of the exact command');
  assert.deepEqual([byId.lint!.outcome, byId.lint!.exitCode], ['failed', 2]);
  assert.deepEqual([byId.e2e!.outcome, byId.e2e!.exitCode, byId.e2e!.code], ['unknown', null, 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN'], 'a lost result is never success');
  assert.deepEqual([byId.typecheck!.outcome, byId.typecheck!.code, byId.typecheck!.output], ['unverified', 'GATE_RESULT_NOT_FOUND', null], 'a declared but never executed command has no evidence');
  assert.deepEqual([byId.docs!.outcome, byId.docs!.reason], ['not-run', 'no instruction says how to build the docs']);
  assert.deepEqual([byId.ci!.outcome, byId.ci!.requiredCheck, byId.ci!.authorization], ['waived', 'ci/build', { kind: 'question', questionId: '22222222-2222-4333-8444-555555555555' }]);
});

test('AC2/AC3: a gate followed by a write/edit/other Bash is not current; other declared gate runs do not stale it; declared stdout is not an input', () => {
  const ledger = createToolLedger();
  ledger.begin('bash', 'a'); ledger.bash('a', { command: 'npm run lint', exitCode: 0, output, code: null });
  ledger.begin('bash', 'b'); ledger.bash('b', { command: 'npm test', exitCode: 0, output, code: null });
  ledger.begin('read', 'r');
  let resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('lint', 'npm run lint'), gate('test', 'npm test')] }));
  assert.deepEqual(resolved.gates.map(item => item.current), [true, true]);
  ledger.begin('edit', 'e');
  resolved = ledger.resolve(declarationsSchema.parse({ gates: [gate('lint', 'npm run lint'), gate('test', 'npm test')] }));
  assert.deepEqual(resolved.gates.map(item => [item.outcome, item.current, item.code]), [['passed', false, 'GATE_NOT_CURRENT'], ['passed', false, 'GATE_NOT_CURRENT']]);
  assert.equal(declarationsSchema.safeParse({ gates: [{ ...gate('x', 'npm test'), output: 'ALL GREEN', exitCode: 0 }] }).success, false, 'no declared output/status');
  assert.equal(declarationsSchema.safeParse({ gates: [gate('x', 'npm test', { status: 'waived', reason: 'faster' })] }).success, false, 'a waiver without authorization is refused');
  assert.equal(declarationsSchema.safeParse({ gates: [gate('x', 'npm test', { status: 'not-run' })] }).success, false, 'not run without a reason is refused');
});

test('AC1: treatments record fixed or not adopted with justification, optional evidence and a concrete authorization reference', () => {
  const ledger = createToolLedger();
  const parsed = declarationsSchema.parse({ treatments: [
    { round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'Added the Rollback section.', evidence: 'docs/smoke.md#rollback' },
    { round: 1, role: 'standards', findingId: 'H1', outcome: 'not-adopted', justification: 'Heuristic; the Ticket fixes this file name.',
      authorization: { kind: 'preserved-source', reference: '/artifacts/spec/v1/ticket.json#body' } }] });
  assert.deepEqual(ledger.resolve(parsed).treatments.map(item => [item.findingId, item.outcome, item.evidence, item.authorization?.kind ?? null]),
    [['S1', 'fixed', 'docs/smoke.md#rollback', null], ['H1', 'not-adopted', null, 'preserved-source']]);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: '' }] }).success, false);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'ignored', justification: 'x' }] }).success, false);
  assert.equal(declarationsSchema.safeParse({ treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'x',
    authorization: { kind: 'preserved-source', reference: '/workspace/checkout/README.md' } }] }).success, false, 'authorization only from a preserved source or a Question');
});
