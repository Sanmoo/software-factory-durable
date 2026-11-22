import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ToolContext } from '../../src/sandbox/index.js';
import type { WorkerQuestion } from '../../src/workers/index.js';
import { remainingMs } from '../runner/budget.js';

/** A worker IPC message as this test reads it (`question` only on `worker-question` and a question result). */
type WorkerMessage = Record<string, unknown> & { question?: WorkerQuestion & { acknowledged?: boolean } };
// I-local: new Node24 worker entrypoint + real Pi SDK session + real Records/Protocol owner transport; the provider HTTP boundary
// (offline fixture), the VM (double) and the Control (this test answering the IPC notification) are substituted.
for (const mode of ['recorded', 'refused', 'ask-then-write', 'ask-secret'] as const) test(`AC1/AC3: Builder ask_user preserves, notifies and ENDS the activation: ${mode}`, { timeout: remainingMs() }, async t => {
  const context: ToolContext = { workId: 'ask-work', executionId: 'ask-exec', invocationId: 'ask-invocation', role: 'builder', environmentRef: 'ask-env', bootRef: 'ask-boot', phaseId: 'ask-phase' };
  let guestCalls = 0;
  const f = await nativeOwner(context, { exec() { guestCalls++; return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) }; } });
  t.after(() => f.close());
  const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
  const recordsRoot = join(f.root, 'worker-records');
  for (const path of [join(directory, 'sessions'), recordsRoot, join(f.root, 't'), join(f.root, 'c')]) await mkdir(path, { mode: 0o700 });
  const bootstrap = { version: 1, context, endpoint: f.owner.endpoint, recordsRoot, knownSecrets: ['synthetic-secret'],
    prompt: mode === 'ask-then-write' ? 'ask-then-write please' : mode === 'ask-secret' ? 'ask-secret please' : 'Implement the Ticket.',
    profile: { id: sdkProfile.id, directory, systemPrompt: 'Builder ask fixture.', providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
      provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } };
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
    execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/ask-provider-preload.js', import.meta.url))],
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const messages: WorkerMessage[] = []; let output = '';
  child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { output += String(chunk); });
  let preservedAtNotification = false;
  child.on('message', (message: WorkerMessage) => {
    messages.push(message);
    if (message.kind !== 'worker-question') return;
    // The complete request is already preserved as protected evidence when the notification arrives.
    preservedAtNotification = existsSync(join(recordsRoot, context.workId, 'evidence', message.question!.reference.id, 'complete.json'));
    child.send({ kind: 'worker-question-ack', version: 1, context, questionId: message.question!.questionId,
      ...(mode === 'refused' ? { status: 'refused', code: 'STALE_EXECUTION' } : { status: 'recorded' }) });
  });
  const exited = once(child, 'exit'); child.send(bootstrap);
  const [code] = await exited;
  assert.equal(code, 0); assert.equal(output, '');
  const notifications = messages.filter(message => message.kind === 'worker-question');
  const result = messages.find(message => message.kind === 'worker-result')!;
  if (mode === 'ask-secret') {
    assert.equal(notifications.length, 0, 'a question containing a known secret is never sent');
    assert.notEqual(result.status, 'question');
    return;
  }
  assert.equal(notifications.length, 1);
  const asked = notifications[0]!.question!;
  assert.match(asked.questionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'stable identity assigned by the worker');
  assert.deepEqual([asked.question, asked.context], ['Which file name should the smoke doc use?', 'The Ticket names no file.']);
  assert.equal(preservedAtNotification, true);
  const evidence = JSON.parse(await readFile(join(recordsRoot, context.workId, 'evidence', asked.reference.id, 'output'), 'utf8'));
  assert.deepEqual([evidence.event.kind, evidence.event.questionId, evidence.event.question, evidence.event.sha256], ['ask-user', asked.questionId, asked.question, asked.sha256]);
  if (mode === 'refused') {
    // Refused: nothing pending; the model sees the error and may continue (a second provider request is allowed here).
    assert.notEqual(result.status, 'question');
    return;
  }
  assert.equal(result.status, 'question');
  assert.deepEqual({ ...result.question, acknowledged: undefined }, { ...asked, acknowledged: undefined });
  assert.equal(result.question!.acknowledged, true);
  assert.equal(messages.filter(message => message.kind === 'provider-request').length, 1, 'no further model turn: the activation ended');
  assert.equal(guestCalls, 0, 'a tool batched after ask_user is refused before any guest effect');
  const session = SessionManager.open(String(result.sessionFile), join(directory, 'sessions')).buildSessionContext();
  assert.ok(session.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('recorded durably by the Factory')), 'session preserved with the ACK');
  if (mode === 'ask-then-write') assert.ok(session.messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('ACTIVATION_ENDED_AFTER_QUESTION')));
  for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.equal((await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from('synthetic-key')), false);
  }
});
