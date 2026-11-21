import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { copyPreservedSession, observePreservedSession } from '../../src/platform/host/index.js';
import type { ToolContext } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 09 (V2-13), I-local: the Node24 worker entrypoint + the REAL Pi SDK session + real Records/owner transport and the real Host
// session observation/copy. Substituted: the provider HTTP boundary (offline fixture), the VM (double) and the boot owner (this test sends
// the Host's `boot-swap` directive on the worker's IPC, as the owner's launcher does). Not evidence of a real model or a real guest.
const provider = { providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
  provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } };
const context = (n: number): ToolContext => ({ workId: 'swap-work', executionId: 'exec-1', invocationId: `builder-${n}`, role: 'builder', environmentRef: 'env-c', bootRef: `boot-${n}`, phaseId: 'p' });

async function installation(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-swap-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const worker = async (boot: string, id: string) => {
    const directory = join(root, 'r', boot, `w-${id}`);
    for (const path of [join(root, 'r'), join(root, 'r', boot), directory, join(directory, 'profile'), join(directory, 'profile', 'sessions'), join(directory, 't'), join(directory, 'c'), join(directory, 'records')]) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
    }
    return { directory, profile: join(directory, 'profile'), sessions: join(directory, 'profile', 'sessions') };
  };
  return { root, worker };
}

/** One worker process. `command`: what the guest does with the one Bash command (the test decides when it returns). */
async function runWorker(t: { after(fn: () => Promise<void>): void }, paths: { directory: string; profile: string }, toolContext: ToolContext, prompt: string,
  options: { extra?: Record<string, unknown>; command?: (child: ReturnType<typeof fork>) => Promise<void> } = {}) {
  const executed: string[] = [];
  let child!: ReturnType<typeof fork>;
  const f = await nativeOwner(toolContext, { exec(argv: readonly string[]) {
    executed.push(argv.join(' '));
    return { async *output() {}, result: (options.command ? options.command(child) : Promise.resolve()).then(() => ({ exitCode: 0 })) };
  } });
  t.after(() => f.close());
  const bootstrap = { version: 1, context: toolContext, endpoint: f.owner.endpoint, recordsRoot: join(paths.directory, 'records'), knownSecrets: ['synthetic-secret'], prompt, skillPack: 'factory-skills-v4' as const,
    profile: { id: sdkProfile.id, directory: paths.profile, systemPrompt: 'Builder swap fixture.', ...provider }, ...options.extra };
  child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
    execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/swap-provider-preload.js', import.meta.url))],
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(paths.directory, 't'), XDG_CACHE_HOME: join(paths.directory, 'c') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); });
  const messages: Record<string, any>[] = [];
  child.on('message', (message: Record<string, any>) => { messages.push(message); });
  const exited = once(child, 'exit');
  child.send(bootstrap);
  await exited;
  return { messages, executed, result: messages.find(message => message.kind === 'worker-result') ?? null, error: messages.find(message => message.kind === 'worker-error') ?? null,
    requests: messages.filter(message => message.kind === 'provider-request') };
}

test('a Builder told of the boot swap while a call is in flight lets the call return, makes no further model request and ends `boot-swap`; its session is then CONTINUED by another worker', { timeout: remainingMs() }, async t => {
  const { root, worker } = await installation(t);
  const first = await worker('bootA', 'aaaa');
  const order: string[] = [];
  const yielded = await runWorker(t, first, context(1), 'Implement the Ticket.', { command: async child => {
    // The command is running in the guest when the Host says the swap is due: it is NOT interrupted.
    order.push('command-started');
    await new Promise<void>((resolve, reject) => child.send({ kind: 'deliver', directive: { kind: 'boot-swap' } }, error => error ? reject(error) : resolve()));
    await new Promise(resolve => setImmediate(resolve));
    order.push('command-returned');
  } });
  assert.equal(yielded.result?.status, 'boot-swap', JSON.stringify(yielded.error ?? yielded.result));
  assert.deepEqual(order, ['command-started', 'command-returned']);
  assert.equal(yielded.executed.length, 1, 'the call in flight ran to its end, exactly once');
  assert.equal(yielded.requests.length, 1, 'no model request after the call returned');
  assert.deepEqual(yielded.result!.sessionTools, ['ask_user', 'bash', 'read', 'write']);
  // The owner observes the preserved session, and the result of the call that returned is in it.
  const launch = { context: { role: 'builder' }, profile: { id: sdkProfile.id, providerId: 'offline-fixture', modelId: 'reader' }, skillPack: 'factory-skills-v4' };
  const ref = (await observePreservedSession(root, first.sessions, yielded.result!.sessionFile, yielded.result!.sessionTools, launch))!;
  assert.ok(ref, 'observed');
  const preserved = SessionManager.open(String(yielded.result!.sessionFile), first.sessions).buildSessionContext();
  assert.ok(preserved.messages.some(message => message.role === 'toolResult'), 'the returned call is part of the preserved session');
  // Another worker (another boot) continues the SAME session.
  const second = await worker('bootB', 'bbbb');
  const copied = await copyPreservedSession(root, second.sessions, ref);
  const continued = await runWorker(t, second, context(2), 'continue\nFactory continuation of the SAME session after a planned boot swap: continue the work.', { extra: { continuedSession: copied } });
  assert.equal(continued.result?.status, 'completed', JSON.stringify(continued.error));
  assert.deepEqual(continued.requests.map(request => [request.continuing, request.earlierCommand, request.earlierResult]), [[true, true, true]]);
  const next = (await observePreservedSession(root, second.sessions, continued.result!.sessionFile, continued.result!.sessionTools, launch))!;
  assert.equal(next.sessionId, ref.sessionId, 'same session identity');
});

test('a Builder that is never told of a swap is unaffected: the same conversation runs to its end', { timeout: remainingMs() }, async t => {
  const { worker } = await installation(t);
  const paths = await worker('bootA', 'aaaa');
  // The fixture ends the turn only for a continuation: without the directive the session asks the provider again after the command.
  const ran = await runWorker(t, paths, context(1), 'continue\nFactory continuation of the SAME session after a planned boot swap: no swap is due here.');
  assert.equal(ran.result?.status, 'completed', JSON.stringify(ran.error));
  assert.equal(ran.requests.length, 1);
});
