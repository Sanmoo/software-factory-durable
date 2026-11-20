import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderHandoff } from '../../src/workers/builder-handoff.js';
import { createToolLedger, gateCommandDocumented } from '../../src/workers/gates.js';

// Ticket 18 real-run regression (q18-journey-v2, issue #7): the Builder declared a gate that the repository does not document, only to say it
// does not exist; it ended `not-run` and made the Execution unverifiable (VERIFICATION:GATE_NOT_RUN:typecheck-lint). A declared gate must carry
// an executable command its cited preserved source documents; otherwise the handoff is refused IN SESSION with the reason, and no round is used.
const realDeclaration = { id: 'typecheck-lint', source: '/artifacts/instructions/v2/AGENTS.md#Agent skills',
  command: 'Not applicable: no typecheck or lint command is required…', cwd: '/workspace', status: 'not-run', reason: 'The repository documents no typecheck or lint command.' };
const agents = '# Agent instructions\n\n## Agent skills\n\nUse the skills in `.agents/skills`. Keep changes small.\n';
const ticket = JSON.stringify({ number: 7, title: 't', body: 'Validation (documented gate):\n`cd /workspace/checkout && test -f docs/FACTORY_JOURNEY.md && grep -q \'^## Steps\' docs/FACTORY_JOURNEY.md`' });
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('');
const call = async (gate: ReturnType<typeof builderHandoff>, args: object) => {
  gate.batch(1);
  return await gate.tool.execute('call', args as never, undefined, undefined, undefined as never) as { content: { type: string; text?: string }[]; isError?: boolean; terminate?: boolean };
};

test('rule: a gate command is documented only when its cited source carries it as a command (code span/block, also inside a JSON Ticket)', () => {
  assert.equal(gateCommandDocumented(realDeclaration.command, agents), false, 'prose saying a gate does not exist is never a gate');
  const documented = 'cd /workspace/checkout && test -f docs/FACTORY_JOURNEY.md && grep -q \'^## Steps\' docs/FACTORY_JOURNEY.md';
  assert.equal(gateCommandDocumented(documented, ticket), true, 'the exact Ticket gate');
  assert.equal(gateCommandDocumented('cd /workspace/checkout && npm test', '## Tests\n\nRun `npm test` before committing.'), true, 'a documented command run in its cwd');
  assert.equal(gateCommandDocumented('cd /workspace/checkout && npm run lint', '## Tests\n\nRun `npm test` before committing.'), false, 'an undocumented command');
  assert.equal(gateCommandDocumented('cd /workspace/checkout', 'Run `cd /workspace/checkout` first.'), false, 'a bare directory change is not a gate');
  assert.equal(gateCommandDocumented('./mvnw -q verify', '```sh\n./mvnw -q verify\n```'), true, 'fenced block line');
  assert.equal(gateCommandDocumented('N/A', '`N/A`'), false);
});

test('handoff: the exact q18-v2 declaration is refused in session with an explicit reason, no round used; omitting it is accepted', async () => {
  const sources: Record<string, string> = { '/artifacts/instructions/v2/AGENTS.md': agents, '/artifacts/spec/v1/ticket.json': ticket };
  const read: string[] = [];
  const ledger = createToolLedger();
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async path => { read.push(path); return sources[path] ?? null; });
  const refused = await call(gate, { gates: [realDeclaration] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^HANDOFF_GATE_NOT_DOCUMENTED: no handoff happened/);
  assert.match(text(refused), /typecheck-lint/);
  assert.match(text(refused), /never declare a gate to say it does not exist/);
  assert.deepEqual([gate.round(), gate.pending(), gate.suspended()], [0, false, false], 'no round consumed, tools not suspended');
  assert.deepEqual(read, ['/artifacts/instructions/v2/AGENTS.md']);
  const outside = await call(gate, { gates: [{ ...realDeclaration, source: '/workspace/checkout/AGENTS.md#x', command: 'npm test', status: 'run', reason: undefined }] });
  assert.match(text(outside), /HANDOFF_GATE_NOT_DOCUMENTED.*not a preserved Ticket\/instructions source/);
  const unreadable = await call(gate, { gates: [{ ...realDeclaration, source: '/artifacts/instructions/v9/AGENTS.md#x', command: 'npm test', status: 'run', reason: undefined }] });
  assert.match(text(unreadable), /HANDOFF_GATE_NOT_DOCUMENTED.*could not be read/);
  const documented = { id: 'docs', source: '/artifacts/spec/v1/ticket.json#validation', cwd: '/workspace', status: 'run',
    command: 'cd /workspace/checkout && test -f docs/FACTORY_JOURNEY.md && grep -q \'^## Steps\' docs/FACTORY_JOURNEY.md' };
  // Ticket 56: a `run` gate is accepted only after a green bash call of exactly its command.
  ledger.begin('bash', 'g1');
  ledger.bash('g1', { command: documented.command, cwd: '/workspace', exitCode: 0, output: null, code: null, contentBeforeSha: 'a', contentAfterSha: 'a' });
  const accepted = await call(gate, { gates: [documented] });
  assert.equal(accepted.terminate, true, 'a documented gate is accepted');
  assert.equal(gate.round(), 1);
  // A REAL documented gate that was not run stays declarable (fail-closed later in Control's verification), never refused here.
  gate.declarations(); gate.listed(1, { standards: [], spec: [] }); gate.resume();
  assert.equal((await call(gate, { gates: [{ ...documented, status: 'not-run', reason: 'timed out' }] })).terminate, true);
});

test('the Host reads the cited source with a fixed command through the Builder binding; anything but a preserved path is never sent', async () => {
  const { readGateSource } = await import('../../src/workers/builder-handoff.js');
  const commands: string[] = [];
  const sandbox = { async executeTool(_context: unknown, call: { command: string }, onData: (data: Uint8Array) => void) {
    commands.push(call.command); onData(Buffer.from(agents)); return { status: 'success', format: 'text', exitCode: 0 };
  } } as never;
  const context = { workId: 'w', executionId: 'e', invocationId: 'i', role: 'builder', environmentRef: 'env', bootRef: 'boot', phaseId: 'builder-initial' } as never;
  assert.equal(await readGateSource(context, sandbox, '/artifacts/instructions/v2/AGENTS.md', new AbortController().signal), agents);
  assert.deepEqual(commands, [`p='/artifacts/instructions/v2/AGENTS.md'; [ -f "$p" ] && [ ! -L "$p" ] && head -c 262144 -- "$p"`]);
  for (const path of ["/artifacts/spec/v1/x';rm -rf /;'", '/workspace/checkout/AGENTS.md', '/artifacts/spec/v1/../../etc/passwd']) {
    assert.equal(await readGateSource(context, sandbox, path, new AbortController().signal), null, path);
  }
  assert.equal(commands.length, 1, 'nothing else was sent');
});

test('real run q21-human-v6: a `run` gate whose EXACT command never ran alone is refused in session (no round used) with the command to run', async () => {
  const declared = "cd /workspace/checkout && test -f docs/FACTORY_HUMAN_CHANGES.md && grep -q '^## Steps' docs/FACTORY_HUMAN_CHANGES.md";
  const ticket24 = JSON.stringify({ number: 24, body: `Validation:\n\`${declared}\`` });
  const ledger = createToolLedger();
  const observe = (callId: string, command: string) => { ledger.begin('bash', callId); ledger.bash(callId, { command, cwd: '/workspace', exitCode: 0, output: null, code: null, contentBeforeSha: 'a', contentAfterSha: 'a' }); };
  // Exactly what the Builder did: the gate inside a larger script, then the Ticket's text WITH the `cd /workspace &&` prefix.
  observe('c1', `set -eu\ncd /workspace/checkout\ngit add docs/FACTORY_HUMAN_CHANGES.md\ngit commit -m "Add"\ncd /workspace && ${declared}\n`);
  observe('c2', `cd /workspace && ${declared}`);
  const gate = builderHandoff({ first: 1, max: 4 }, ledger, async () => ticket24);
  const gateDeclaration = { id: 'ticket-validation', source: '/artifacts/spec/v1/ticket.json#Validation', command: declared, cwd: '/workspace', status: 'run' };
  const refused = await call(gate, { gates: [gateDeclaration] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^HANDOFF_GATE_NOT_RUN: no handoff happened and no review round was used/);
  assert.ok(text(refused).includes(`ticket-validation: run exactly this command ALONE as its own bash call, then hand off again: ${declared}`), text(refused));
  assert.equal(gate.suspended(), false);
  observe('c3', declared);
  const accepted = await call(gate, { gates: [gateDeclaration] });
  assert.match(text(accepted), /^Handoff accepted for capture round 1/);
  // Ticket 56: a gate that never ran at all is refused the same way (it used to be accepted and end unverified after a whole round).
  const fresh = builderHandoff({ first: 1, max: 4 }, createToolLedger(), async () => ticket24);
  assert.match(text(await call(fresh, { gates: [gateDeclaration] })), /^HANDOFF_GATE_NOT_RUN: no handoff happened/);
});
