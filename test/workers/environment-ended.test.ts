import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { builderBash } from '../../src/workers/bash.js';
import { builderWrite } from '../../src/workers/write.js';
import { builderEdit } from '../../src/workers/edit.js';
import { reviewerRead } from '../../src/workers/read.js';

// v2 ticket 10 (V2-15): what the SESSION does with a tool call the sandbox answered "environment ended". Real worker tools, real tool
// owner and Records; the guest is a double and the end of the environment is stated by the binding, as the Lambda adapter states it.
// `critical` is the callback the worker session wires to "abort the session": once it ran, the agent loop makes no further model request.
// Not covered here: the agent SDK and a model (no worker process runs).
const context = (role: ToolContext['role']): ToolContext => ({ workId: 'gone-work', executionId: 'gone-exec', invocationId: `gone-${role}`,
  role, environmentRef: 'gone-env', bootRef: 'gone-boot', phaseId: 'gone-phase' });
type Exec = ReturnType<Parameters<typeof nativeOwner>[1]['exec']>;
const exited = (text = ''): Exec => ({ async *output() { if (text) yield { stream: 'stdout' as const, data: Buffer.from(text) }; }, result: Promise.resolve({ exitCode: 0 }) });
const ended = /SANDBOX_ENVIRONMENT_ENDED/;

async function fixture(t: { after(fn: () => Promise<void>): void }, role: ToolContext['role'], options: { editSourceMaxBytes?: number } = {}) {
  const state = { gone: false, guestCalls: 0 };
  const f = await nativeOwner(context(role), { exec: () => { state.guestCalls += 1; return exited('old'); } }, { ...options, environmentEnded: () => state.gone });
  t.after(() => f.close());
  let critical = 0;
  return { state, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }), critical: () => { critical += 1; }, criticals: () => critical };
}

test('Bash: a command answered "environment ended" ends the session (critical), and nothing reaches the guest afterwards', async t => {
  const f = await fixture(t, 'builder');
  const bash = builderBash(context('builder'), f.sandbox, f.critical, false);
  await bash.execute('call-1', { command: 'git status' }, undefined, undefined, {} as never);
  assert.equal(f.criticals(), 0);
  f.state.gone = true;
  const before = f.state.guestCalls;
  // The Builder's Bash reports every failed command to the model under its one "effects unknown" text; what matters is that it is critical.
  await assert.rejects(bash.execute('call-2', { command: 'mvn deploy' }, undefined, undefined, {} as never), /BASH_EFFECTS_OR_CAPTURE_UNKNOWN/);
  assert.equal(f.criticals() >= 1, true, 'the session is aborted: no further model request');
  await assert.rejects(bash.execute('call-3', { command: 'git status' }, undefined, undefined, {} as never));
  assert.equal(f.state.guestCalls, before);
});

test('write: a write answered "environment ended" ends the session', async t => {
  const f = await fixture(t, 'builder');
  const write = builderWrite(context('builder'), f.sandbox, f.critical);
  f.state.gone = true;
  await assert.rejects(write.execute('w-1', { path: 'a.txt', content: 'x' }, undefined, undefined, { cwd: '/workspace' } as never), ended);
  assert.equal(f.criticals() >= 1, true);
  assert.equal(f.state.guestCalls, 0);
});

test('edit: an edit answered "environment ended" ends the session', async t => {
  const f = await fixture(t, 'builder', { editSourceMaxBytes: 8192 });
  const edit = builderEdit(context('builder'), f.sandbox, f.critical);
  f.state.gone = true;
  await assert.rejects(edit.execute('e-1', { path: 'source', edits: [{ oldText: 'old', newText: 'new' }] }, undefined, undefined, undefined as never));
  assert.equal(f.criticals() >= 1, true);
  assert.equal(f.state.guestCalls, 0);
});

test('reviewer read: a read answered "environment ended" ends the session', async t => {
  const f = await fixture(t, 'standards');
  const read = reviewerRead(context('standards'), f.sandbox, f.critical);
  f.state.gone = true;
  await assert.rejects(read.execute('r-1', { path: '/workspace/checkout/README.md' }, undefined, undefined));
  assert.equal(f.criticals() >= 1, true);
  assert.equal(f.state.guestCalls, 0);
});
