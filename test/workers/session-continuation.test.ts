import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { createWorkers } from '../../src/workers/index.js';
import { builderToolNames } from '../../src/workers/session-ref.js';
import { copyPreservedSession, launchToolNames, observePreservedSession, readSessionFile } from '../../src/platform/host/index.js';
import { skillPackContinues } from '../../src/workers/skill-pack.js';
import type { ToolContext } from '../../src/sandbox/index.js';

// I-local: new Node24 worker entrypoint + REAL Pi SDK SessionManager/AgentSession + real Records/Protocol owner transport + real Host
// confined session reads/copies and the real Workers facade `observe`. Substituted: the provider HTTP boundary (offline fixtures), the
// VM (double), systemd spawn (forked directly) and the Control (this test). Not evidence of a real model consuming the continuation.
const provider = { providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
  provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function installation(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-session-')));
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

async function runWorker(t: { after(fn: () => Promise<void>): void }, paths: { directory: string; profile: string }, context: ToolContext, preload: string, prompt: string,
  extra: Record<string, unknown> = {}) {
  const f = await nativeOwner(context, { exec() { return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) }; } });
  t.after(() => f.close());
  const recordsRoot = join(paths.directory, 'records');
  const bootstrap = { version: 1, context, endpoint: f.owner.endpoint, recordsRoot, knownSecrets: ['synthetic-secret'], prompt, skillPack: 'factory-skills-v4' as const,
    profile: { id: sdkProfile.id, directory: paths.profile, systemPrompt: 'Builder continuation fixture.', ...provider }, ...extra };
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
    execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL(`./fixtures/${preload}`, import.meta.url))],
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(paths.directory, 't'), XDG_CACHE_HOME: join(paths.directory, 'c') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); });
  const messages: Record<string, any>[] = [];
  child.on('message', (message: Record<string, any>) => {
    messages.push(message);
    if (message.kind === 'worker-question') child.send({ kind: 'worker-question-ack', version: 1, context, questionId: message.question.questionId, status: 'recorded' });
  });
  const exited = once(child, 'exit');
  child.send(bootstrap);
  await exited;
  return { messages, recordsRoot, result: messages.find(message => message.kind === 'worker-result') ?? null, error: messages.find(message => message.kind === 'worker-error') ?? null };
}
const context = (n: number): ToolContext => ({ workId: 'continue-work', executionId: `exec-${n}`, invocationId: `builder-${n}`, role: 'builder', environmentRef: 'env-c', bootRef: `boot-${n}`, phaseId: 'p' });

test('AC1: a preserved Builder session is observed by its owner, found compatible, copied and CONTINUED by a new worker with `continue` (no restart)', { timeout: 30000 }, async t => {
  const { root, worker } = await installation(t);
  const first = await worker('bootA', 'aaaa');
  const asked = await runWorker(t, first, context(1), 'ask-provider-preload.js', 'Implement the Ticket.');
  assert.equal(asked.result!.status, 'question');
  assert.deepEqual(asked.result!.sessionTools, ['ask_user', 'bash', 'read', 'write'], 'the worker reports its exact tool set');
  // Owner observation of the preserved session (Host path, not guest; identity/hash from the file itself).
  const launch = { context: { role: 'builder' }, profile: { id: sdkProfile.id, providerId: 'offline-fixture', modelId: 'reader' }, skillPack: 'factory-skills-v4' };
  const planned = { skillPack: 'factory-skills-v4' as const, handoff: false };
  const ref = (await observePreservedSession(root, first.sessions, asked.result!.sessionFile, asked.result!.sessionTools, launch))!;
  assert.ok(ref, 'observed');
  assert.match(ref.ref, /^r\/bootA\/w-aaaa\/profile\/sessions\/[^/]+\.jsonl$/);
  const original = await readFile(join(root, ref.ref));
  assert.deepEqual([ref.sha256, ref.bytes, ref.format, ref.profile], [sha(original), original.length, 'pi-session-jsonl-v3',
    { sdkProfile: sdkProfile.id, providerId: 'offline-fixture', modelId: 'reader', skillPack: 'factory-skills-v4', tools: ['ask_user', 'bash', 'read', 'write'] }]);
  assert.deepEqual(builderToolNames(planned), ref.profile.tools, 'the facade predicts the very tool set the SDK session had');
  // Workers.observe (Q6): compatible for the same policies; incompatible when the planned tools differ; never a guest read.
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfile.id, systemPrompt: 's', ...provider } });
  const observed = await workers.observe({ workId: 'continue-work', executionId: 'exec-1', invocationId: 'builder-1', session: ref, next: planned });
  assert.deepEqual(observed.session, { state: 'compatible', session: ref });
  assert.ok(observed.limitations[0]!.includes('not proof of consumption'));
  const other = await workers.observe({ workId: 'continue-work', executionId: 'exec-1', invocationId: 'builder-1', session: ref, next: { ...planned, editSourceMaxBytes: 8192 } });
  assert.deepEqual(other.session, { state: 'incompatible', code: 'SESSION_PROFILE_CHANGED', differences: ['tools'] });
  // finding 2: the PACK decides whether it defines the continue protocol (v1-v3 do not); an explicit pack is required.
  assert.equal(await skillPackContinues('factory-skills-v4'), true);
  for (const older of ['factory-skills-v1', 'factory-skills-v2', 'factory-skills-v3'] as const) assert.equal(await skillPackContinues(older), false, older);
  const v3Session = { ...ref, profile: { ...ref.profile, skillPack: 'factory-skills-v3', tools: ['ask_user', 'bash', 'read', 'write'] } };
  const v3Observed = await workers.observe({ workId: 'continue-work', executionId: 'exec-1', invocationId: 'builder-1', session: v3Session, next: { skillPack: 'factory-skills-v3', handoff: false } });
  assert.deepEqual(v3Observed.session, { state: 'incompatible', code: 'SESSION_CONTINUATION_UNSUPPORTED', differences: ['continuation'] });
  assert.deepEqual((await workers.observe({ workId: 'continue-work', executionId: 'exec-1', invocationId: 'builder-1', session: ref, next: planned })).session.state,
    'compatible');
  assert.deepEqual((await workers.observe({ workId: 'continue-work', executionId: 'exec-1', invocationId: 'builder-1', session: ref, next: { handoff: false } })).session,
    { state: 'incompatible', code: 'SESSION_CONTINUATION_UNSUPPORTED', differences: ['continuation'] }, 'a plan without a pack cannot continue');
  // finding 5: the Host derives the tool set from the LAUNCH policy, not from the worker's claim; a contradicting claim withholds the session.
  assert.deepEqual(ref.profile.tools, launchToolNames({ context: { role: 'builder' }, skillPack: 'factory-skills-v4', handoff: false }));
  assert.equal(await observePreservedSession(root, first.sessions, asked.result!.sessionFile, ['bash', 'write'], launch), undefined,
    'a claim contradicting the launch policy is not adopted');
  assert.equal(await observePreservedSession(root, first.sessions, asked.result!.sessionFile, asked.result!.sessionTools,
    { ...launch, editSourceMaxBytes: 8192 }), undefined, 'the policy, not the claim, decides the expected tool set');
  // Owner copy for the new worker, then the continuation in the SAME session.
  const second = await worker('bootB', 'bbbb');
  const copied = await copyPreservedSession(root, second.sessions, ref);
  const prompt = 'continue\nFactory continuation of the SAME session: Execution exec-2 continues after Execution exec-1 ended.\n\nAccepted answer:\n```\nUse docs/factory-question.md\n```';
  const continued = await runWorker(t, second, context(2), 'continue-provider-preload.js', prompt, { continuedSession: copied });
  assert.equal(continued.result?.status, 'completed', JSON.stringify(continued.error));
  const requests = continued.messages.filter(message => message.kind === 'provider-request');
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], kind: undefined, count: undefined }, { kind: undefined, count: undefined, earlierQuestion: true, earlierAck: true, continueMessage: true,
    answer: true, implementRestarted: false }, 'the model request carries the earlier conversation and the continue message');
  const reopened = SessionManager.open(String(continued.result!.sessionFile), second.sessions).buildSessionContext();
  assert.ok(reopened.messages.some(message => JSON.stringify(message).includes('Which file name should the smoke doc use?')), 'history kept');
  assert.ok(reopened.messages.some(message => message.role === 'assistant' && JSON.stringify(message).includes('Continued with docs/factory-question.md.')));
  assert.equal(sha(await readFile(join(root, ref.ref))), ref.sha256, 'the original preserved session is never appended to');
  const next = (await observePreservedSession(root, second.sessions, continued.result!.sessionFile, continued.result!.sessionTools, launch))!;
  assert.equal(next.sessionId, ref.sessionId, 'same session identity, new content hash');
  assert.notEqual(next.sha256, ref.sha256);
  // The start receipt records the session format and the continuation identity (spec §6.1: "formato de sessão por Execução").
  const receipt = JSON.parse(await readFile(join(continued.recordsRoot, 'continue-work', 'evidence', continued.result!.receipt.id, 'output'), 'utf8')).event;
  assert.deepEqual(receipt.session, { format: 'pi-session-jsonl-v3', mode: 'continue', sessionId: ref.sessionId, sha256: ref.sha256 });
  const fresh = JSON.parse(await readFile(join(asked.recordsRoot, 'continue-work', 'evidence', asked.result!.receipt.id, 'output'), 'utf8')).event;
  assert.deepEqual(fresh.session, { format: 'pi-session-jsonl-v3', mode: 'new' });
});

test('AC2: altered, lost, unsafe or foreign sessions are never continued; a tampered copy stops the worker before any model request', { timeout: 30000 }, async t => {
  const { root, worker } = await installation(t);
  const first = await worker('bootA', 'aaaa');
  const asked = await runWorker(t, first, context(1), 'ask-provider-preload.js', 'Implement the Ticket.');
  const launch = { context: { role: 'builder' }, profile: { id: sdkProfile.id, providerId: 'offline-fixture', modelId: 'reader' }, skillPack: 'factory-skills-v4' };
  const ref = (await observePreservedSession(root, first.sessions, asked.result!.sessionFile, asked.result!.sessionTools, launch))!;
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfile.id, systemPrompt: 's', ...provider } });
  const observe = (session: typeof ref) => workers.observe({ workId: 'w', executionId: 'e', invocationId: 'i', session, next: { skillPack: 'factory-skills-v4', handoff: false } })
    .then(result => result.session);
  // A reviewer never reports a session; a file outside the worker's own sessions directory is never one.
  assert.equal(await observePreservedSession(root, first.sessions, asked.result!.sessionFile, asked.result!.sessionTools, { ...launch, context: { role: 'spec' } }), undefined);
  assert.equal(await observePreservedSession(root, first.sessions, join(first.directory, 'records', 'x.jsonl'), asked.result!.sessionTools, launch), undefined);
  assert.deepEqual((await observe({ ...ref, ref: '../etc/passwd' })).state, 'unavailable');
  assert.deepEqual(await observe({ ...ref, profile: { ...ref.profile, modelId: 'other' } }), { state: 'incompatible', code: 'SESSION_PROFILE_CHANGED', differences: ['modelId'] });
  assert.deepEqual(await workers.observe({ workId: 'w', executionId: 'e', invocationId: 'i', session: ref, next: { skillPack: 'factory-skills-v1', handoff: false } }).then(result => result.session),
    { state: 'incompatible', code: 'SESSION_CONTINUATION_UNSUPPORTED', differences: ['continuation'] },
    'an older planned pack cannot continue any session, whatever the recorded profile says');
  // Tampered copy: the worker refuses before creating any model request.
  const second = await worker('bootB', 'bbbb');
  const copied = await copyPreservedSession(root, second.sessions, ref);
  await writeFile(copied.file, Buffer.concat([await readFile(copied.file), Buffer.from('{"type":"message"}\n')]));
  const refused = await runWorker(t, second, context(2), 'continue-provider-preload.js', 'continue\nx', { continuedSession: copied });
  assert.equal(refused.result, null);
  assert.ok(refused.error, 'worker error, no result');
  assert.equal(refused.messages.filter(message => message.kind === 'provider-request').length, 0);
  // Altered and lost originals.
  const path = join(root, ref.ref);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('{"type":"message"}\n')]));
  assert.deepEqual(await observe(ref), { state: 'altered', code: 'SESSION_HASH_MISMATCH', differences: [] });
  await assert.rejects(copyPreservedSession(root, (await worker('bootC', 'cccc')).sessions, ref), /WORKER_SESSION_UNAVAILABLE/);
  await unlink(path);
  assert.deepEqual(await observe(ref), { state: 'lost', code: 'SESSION_FILE_MISSING', differences: [] });
  assert.deepEqual((await readSessionFile(root, ref.ref)).state, 'lost');
  // A group/world-readable runtime directory is not private: unavailable, never followed.
  await chmod(join(root, 'r', 'bootA'), 0o755);
  assert.equal((await readSessionFile(root, ref.ref)).state, 'unsafe');
});

test('finding 5: the Host tool set derived from the launch policy is exactly the set the SDK session is offered for every policy combination', async () => {
  const { builderToolNames } = await import('../../src/workers/session-ref.js');
  const policies = [
    { handoff: false }, { handoff: false, copyOutput: true }, { handoff: false, skillPack: 'factory-skills-v4' as const },
    { handoff: false, editSourceMaxBytes: 8192 }, { handoff: true, copyOutput: true, editSourceMaxBytes: 8192, skillPack: 'factory-skills-v4' as const },
  ];
  for (const policy of policies) {
    assert.deepEqual(launchToolNames({ context: { role: 'builder' }, ...policy }), builderToolNames(policy), JSON.stringify(policy));
  }
  assert.deepEqual(launchToolNames({ context: { role: 'builder' }, handoff: false, copyOutput: true, editSourceMaxBytes: 0,
    skillPack: 'factory-skills-v4' }), ['ask_user', 'bash', 'edit', 'read', 'write']);
});
