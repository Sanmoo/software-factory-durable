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
  const gate = builderHandoff({ first: 1, max: 4 }, createToolLedger(), async path => { read.push(path); return sources[path] ?? null; });
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
