import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderHandoff } from '../../src/workers/builder-handoff.js';
import { createToolLedger } from '../../src/workers/gates.js';

// Ticket 56 (pilot 2, #125): the last Bash call of EXACTLY the documented gate failed; the Builder then ran the gate only inside compound
// commands (`git add && git commit && ./gradlew …`), which are never bound to the gate, and declared it `run` in three handoffs. The Host kept the
// failed exact result (correct), but the handoff accepted the contradicting declaration silently and the Work ended not-publishable with no next
// step. A `run` declaration is now refused in session, without using a round, unless the LAST exact run of that command passed.
const declared = 'cd /workspace/checkout && ./gradlew check acceptanceTest';
const ticket = JSON.stringify({ number: 125, body: `Validation (documented gate):\n\`${declared}\`` });
const gateDeclaration = { id: 'check-acceptance', source: '/artifacts/spec/v1/ticket.json#Validation', command: declared, cwd: '/workspace', status: 'run' };
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('');
type Result = { content: { type: string; text?: string }[]; isError?: boolean; terminate?: boolean };
const call = async (gate: ReturnType<typeof builderHandoff>, args: object) => {
  gate.batch(1);
  return (await gate.tool.execute('call', args as never, undefined, undefined, undefined as never)) as Result;
};
const observer = (ledger: ReturnType<typeof createToolLedger>) => {
  let n = 0;
  return (command: string, exitCode: number | null) => {
    const callId = `c${++n}`;
    ledger.begin('bash', callId);
    ledger.bash(callId, {
      command,
      cwd: '/workspace',
      exitCode,
      output: null,
      code: exitCode === null ? 'TOOL_TIMEOUT' : null,
      contentBeforeSha: 'a',
      contentAfterSha: 'a',
    });
  };
};

test('pilot 2 #125: last exact run failed, green runs only inside compound commands → `run` refused in session with the command to run ALONE', async () => {
  const ledger = createToolLedger();
  const observe = observer(ledger);
  observe(declared, 1);
  observe(`cd /workspace/checkout && git add -A && git commit -m fix && ./gradlew check acceptanceTest`, 0);
  observe(`cd /workspace/checkout && git status && git log --oneline -3 && ./gradlew check acceptanceTest`, 0);
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async () => ticket);
  const refused = await call(gate, { gates: [gateDeclaration] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^HANDOFF_GATE_FAILED: no handoff happened and no review round was used/);
  assert.match(text(refused), /never inside a compound command/);
  assert.match(text(refused), /declare it `not-run` with the reason/);
  assert.ok(
    text(refused).includes(
      `check-acceptance: your last bash call of exactly this command failed (exit 1); run it ALONE as its own bash call, ` +
        `as your last command, then hand off again: ${declared}`,
    ),
    text(refused),
  );
  assert.deepEqual([gate.round(), gate.pending(), gate.suspended()], [0, false, false], 'no round consumed, tools not suspended');
  // A green EXACT run afterwards is accepted.
  observe(declared, 0);
  const accepted = await call(gate, { gates: [gateDeclaration] });
  assert.equal(accepted.terminate, true);
  assert.match(text(accepted), /^Handoff accepted for capture round 1/);
});

test('a `run` gate with NO exact run at all is refused in session; with only the latest exact run green it is accepted', async () => {
  const fresh = builderHandoff({ first: 1, max: 4 }, createToolLedger(), async () => ticket);
  const refused = await call(fresh, { gates: [gateDeclaration] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^HANDOFF_GATE_NOT_RUN: no handoff happened and no review round was used/);
  assert.ok(text(refused).includes(`check-acceptance: run exactly this command ALONE as its own bash call, then hand off again: ${declared}`), text(refused));
  assert.equal(fresh.round(), 0);

  // Only the LATEST exact run counts: green then red is refused; a lost result (no exit code) is not a pass either.
  const ledger = createToolLedger();
  const observe = observer(ledger);
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async () => ticket);
  observe(declared, 0);
  observe(declared, 2);
  assert.match(text(await call(gate, { gates: [gateDeclaration] })), /check-acceptance: your last bash call of exactly this command failed \(exit 2\)/);
  observe(declared, null);
  assert.match(
    text(await call(gate, { gates: [gateDeclaration] })),
    /check-acceptance: your last bash call of exactly this command ended without an exit code/,
  );
  observe(declared, 0);
  assert.equal((await call(gate, { gates: [gateDeclaration] })).terminate, true);
});

test('`not-run` and `waived` declarations are unchanged: accepted whatever the ledger holds (Control fails them closed later)', async () => {
  const ledger = createToolLedger();
  observer(ledger)(declared, 1);
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async () => ticket);
  assert.equal(
    (await call(gate, { gates: [{ ...gateDeclaration, status: 'not-run', reason: 'fails on a dependency I cannot fix; asked the operator' }] })).terminate,
    true,
  );
});

test('an exhausted ledger refuses nothing here: every declared run gate already ends GATE_LEDGER_EXHAUSTED (unverified)', async () => {
  const ledger = createToolLedger({ maxCalls: 1 });
  const observe = observer(ledger);
  observe('true', 0);
  observe(declared, 0);
  assert.equal(ledger.exhausted(), true);
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async () => ticket);
  assert.equal((await call(gate, { gates: [gateDeclaration] })).terminate, true);
});
