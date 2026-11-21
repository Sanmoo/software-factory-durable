import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderBash } from '../../src/workers/bash.js';
import { builderWrite } from '../../src/workers/write.js';
import { builderEdit } from '../../src/workers/edit.js';
import type { BashObservation } from '../../src/workers/gates.js';

// v2 ticket 11 (V2-21): a tool call whose channel dropped and whose orphan the sandbox ended reaches the SESSION as "indeterminate" and
// the session goes on. Real tool owner and Records; the guest is a double that says what the Lambda adapter says after a recovered drop.
const context: ToolContext = { workId: 'drop-work', executionId: 'drop-exec', invocationId: 'drop-invocation',
  role: 'builder', environmentRef: 'drop-env', bootRef: 'drop-boot', phaseId: 'drop-phase' };
type Exec = ReturnType<Parameters<typeof nativeOwner>[1]['exec']>;
const dropped = (): Exec => ({ async *output() { yield { stream: 'stdout' as const, data: Buffer.from('half the output\n') }; }, result: Promise.resolve({ exitCode: null, channel: 'orphan-ended' as const }) });
const exited = (text = ''): Exec => ({ async *output() { if (text) yield { stream: 'stdout' as const, data: Buffer.from(text) }; }, result: Promise.resolve({ exitCode: 0 }) });
/** What the model must be able to read in the result: not a success, not "it did not run". */
const indeterminate = (error: unknown) => {
  const text = (error as Error).message;
  assert.match(text, /RESULT INDETERMINATE/);
  assert.match(text, /may have happened/);
  assert.match(text, /not confirmed as executed and not confirmed as not executed/i);
  assert.match(text, /inspect/i);
  assert.doesNotMatch(text, /did not run|was not executed/i);
  return true;
};

test('Bash: a dropped command is an indeterminate result the session reads, and the Builder runs its next command in the same session', async t => {
  let drop = true;
  const f = await nativeOwner(context, { exec: () => drop ? dropped() : exited('clean\n') });
  t.after(() => f.close());
  let critical = 0;
  const observed: BashObservation[] = [];
  const bash = builderBash(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical += 1; }, false, (_id, observation) => { observed.push(observation); });
  await assert.rejects(bash.execute('call-1', { command: 'mvn deploy' }, undefined, undefined, {} as never), indeterminate);
  assert.equal(critical, 0, 'the session is not ended');
  // The Host's own record of the command says the same: no exit status, no output reference, the indeterminate code.
  assert.deepEqual(observed.map(item => [item.command, item.exitCode, item.output, item.code]), [['mvn deploy', null, null, 'BASH_RESULT_INDETERMINATE']]);
  drop = false;
  const next = await bash.execute('call-2', { command: 'git status' }, undefined, undefined, {} as never);
  assert.equal((next.structuredContent as { exit_code: number }).exit_code, 0);
  assert.equal(critical, 0);
});

test('write: a dropped write is indeterminate and the session keeps writing', async t => {
  let drop = false;
  const f = await nativeOwner(context, { exec: argv => drop && argv[5] === 'create' ? dropped() : exited() });
  t.after(() => f.close());
  let critical = 0;
  const write = builderWrite(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical += 1; });
  drop = true;
  await assert.rejects(write.execute('w-1', { path: 'a.txt', content: 'x' }, undefined, undefined, { cwd: '/workspace' } as never), indeterminate);
  drop = false;
  await write.execute('w-2', { path: 'b.txt', content: 'y' }, undefined, undefined, { cwd: '/workspace' } as never);
  assert.equal(critical, 0);
});

test('edit: a dropped commit is indeterminate and the session keeps editing', async t => {
  let drop = false;
  const f = await nativeOwner(context, { exec: argv => argv[5] === 'commit' ? (drop ? dropped() : exited()) : exited('old') }, { editSourceMaxBytes: 8192 });
  t.after(() => f.close());
  let critical = 0;
  const edit = builderEdit(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), () => { critical += 1; });
  const input = { path: 'source', edits: [{ oldText: 'old', newText: 'new' }] };
  drop = true;
  await assert.rejects(edit.execute('e-1', input, undefined, undefined, undefined as never), indeterminate);
  drop = false;
  await edit.execute('e-2', input, undefined, undefined, undefined as never);
  assert.equal(critical, 0);
});
