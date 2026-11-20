import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { builderHandoff } from '../../src/workers/builder-handoff.js';
import { createToolLedger } from '../../src/workers/gates.js';

// Level R (Host logic, no SDK): the multi-round handoff validates every declared treatment against the findings the Host DELIVERED for
// that round/role and refuses an unknown one WITHOUT consuming a capture round. Regression fixture: the real declarations of the ticket 13
// run y5/q13-rounds-v3, where the Builder declared placeholder `findingId: "none"` treatments for reviewers without findings.
type Fixture = { findings: Record<string, { standards: string[]; spec: string[] }>; handoffs: Record<string, { treatments: object[]; gates: object[] }> };
const real = async () => JSON.parse(await readFile('test/workers/fixtures/real-run-q13v3-declarations.json', 'utf8')) as Fixture;
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('');
const call = async (gate: ReturnType<typeof builderHandoff>, args: object) => {
  gate.batch(1);
  return await gate.tool.execute('call', args as never, undefined, undefined, undefined as never) as { content: { type: string; text?: string }[]; isError?: boolean; terminate?: boolean };
};

test('AC1 real-run regression: placeholder treatments for reviewers without findings are refused at handoff, without consuming a round', async () => {
  const fixture = await real();
  // Ticket 56: a `run` gate is accepted only after a green bash call of exactly its command (as in the real run).
  const ledger = createToolLedger();
  ledger.begin('bash', 'gate');
  ledger.bash('gate', { command: (fixture.handoffs['2']!.gates[0] as { command: string }).command, cwd: '/workspace', exitCode: 0, output: null, code: null,
    contentBeforeSha: 'a', contentAfterSha: 'a' });
  const gate = builderHandoff({ first: 1, max: 4 }, ledger);
  const first = await call(gate, { gates: fixture.handoffs['2']!.gates });
  assert.equal(first.terminate, true, 'round 1 handoff accepted');
  assert.equal(gate.round(), 1);
  gate.declarations();
  gate.listed(1, fixture.findings['1']!);
  gate.resume();
  // Real round 2 declarations: S1 fixed (listed) + `1/standards/none` (Standards listed nothing).
  const refused = await call(gate, fixture.handoffs['2']!);
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^HANDOFF_TREATMENT_UNKNOWN_FINDING: no handoff happened/);
  assert.match(text(refused), /1\/standards\/none/);
  assert.doesNotMatch(text(refused), /1\/spec\/S1/, 'only the unknown treatment is named');
  assert.match(text(refused), /omit reviewers and rounds without findings/);
  assert.deepEqual([gate.round(), gate.pending(), gate.suspended(), gate.declarations()], [1, false, false, undefined], 'no round consumed, nothing pending');
  // Corrected: only the listed finding.
  const accepted = await call(gate, { ...fixture.handoffs['2']!, treatments: fixture.handoffs['2']!.treatments.slice(0, 1) });
  assert.equal(accepted.terminate, true);
  assert.equal(gate.round(), 2);
  assert.deepEqual(gate.declarations()!.treatments!.map(item => item.findingId), ['S1']);
  gate.listed(2, fixture.findings['2']!);
  gate.resume();
  // Real round 3 declarations: two placeholders for a clean round.
  const again = await call(gate, fixture.handoffs['3']!);
  assert.match(text(again), /HANDOFF_TREATMENT_UNKNOWN_FINDING/);
  assert.match(text(again), /2\/standards\/none, 2\/spec\/none/);
  assert.equal(gate.round(), 2);
  assert.equal((await call(gate, { gates: fixture.handoffs['3']!.gates })).terminate, true, 'no treatments for a clean round');
  assert.equal(gate.round(), 3);
});

test('AC1: a treatment of a round that was never delivered is refused; a round delivered without a findings list is checked only at the end', async () => {
  const gate = builderHandoff({ first: 1, max: 4 }, createToolLedger());
  assert.equal((await call(gate, {})).terminate, true);
  gate.declarations();
  gate.listed(1, undefined);
  gate.resume();
  const treatment = (round: number, findingId: string) => ({ round, role: 'spec', findingId, outcome: 'fixed', justification: 'x' });
  const future = await call(gate, { treatments: [treatment(5, 'S1')] });
  assert.match(text(future), /HANDOFF_TREATMENT_UNKNOWN_FINDING[\s\S]*5\/spec\/S1/);
  assert.equal(gate.round(), 1);
  // Round 1 was delivered without a list (no Host list to check against): accepted here, the end-of-Execution check stays as defence.
  assert.equal((await call(gate, { treatments: [treatment(1, 'S1')] })).terminate, true);
});

test('real run R-CAND v2: a continuation knows the findings its predecessor delivered before the Question; unknown ones are still refused', async () => {
  // Work 4b2d22b4: round 4 Spec S1 delivered, the Builder asked a Question, and the continuation Execution (first round 5) treated S1.
  const gate = builderHandoff({ first: 5, max: 4, delivered: [{ round: 4, standards: [], spec: ['S1'] }, { round: 9, standards: ['X'], spec: [] }] }, createToolLedger());
  const treatment = (round: number, role: string, findingId: string) => ({ round, role, findingId, outcome: 'not-adopted', justification: 'Operator answered.' });
  for (const unknown of [treatment(4, 'spec', 'S2'), treatment(4, 'standards', 'S1'), treatment(3, 'spec', 'S1'), treatment(9, 'standards', 'X')]) {
    const refused = await call(gate, { treatments: [unknown] });
    assert.match(text(refused), /^HANDOFF_TREATMENT_UNKNOWN_FINDING/, JSON.stringify(unknown));
  }
  assert.equal(gate.pending(), false, 'no round consumed; a delivered round not before `first` is ignored');
  const accepted = await call(gate, { treatments: [treatment(4, 'spec', 'S1')] });
  assert.equal(accepted.terminate, true);
  assert.equal(gate.round(), 5);
  assert.deepEqual(gate.declarations()!.treatments!.map(item => `${item.round}/${item.role}/${item.findingId}`), ['4/spec/S1']);
});
