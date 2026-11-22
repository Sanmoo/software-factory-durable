import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers, type WorkerSessionRef } from '../../src/workers/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';

// Real Workers facade + Protocol against a scripted owner endpoint (the owner's copy/observation is covered by session-continuation).
const boot = 'boot-77777777-2222-4333-8444-555555555551';
const environmentRef = `env-${'d'.repeat(64)}`;
const workId = 'work-11';
const profile = {
  id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const,
  systemPrompt: 'p',
  auth: 'factory-oauth' as const,
  providerId: 'openai' as const,
  modelId: 'gpt-6-luna' as const,
  api: 'openai-responses' as const,
};
const context = {
  workId,
  executionId: 'execution-2',
  invocationId: 'builder-2',
  role: 'builder' as const,
  environmentRef,
  bootRef: boot,
  phaseId: 'builder-continuation',
};
const receipt = { workId, id: '99999999-2222-4333-8444-555555555551' };
const session: WorkerSessionRef = {
  ref: 'r/bootA/w-aaaa/profile/sessions/s.jsonl',
  sessionId: '5e55a0b0-0000-4000-8000-000000000001',
  sha256: 'a'.repeat(64),
  bytes: 10,
  format: 'pi-session-jsonl-v3',
  profile: {
    sdkProfile: profile.id,
    providerId: 'openai',
    modelId: 'gpt-6-luna',
    skillPack: 'factory-skills-v4',
    tools: ['ask_user', 'bash', 'read', 'write'],
  },
};

async function owner(t: { after(fn: () => Promise<void>): void }, completion: Record<string, unknown>) {
  const root = await mkdtemp('/tmp/ac-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId, environment: environmentRef }), { mode: 0o600 });
  await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  const server = await listen(
    join(runtime, 'owner'),
    {
      async message(request, channel) {
        received.push(request);
        if (request.kind !== 'launch-worker') return;
        const launch = request.message_id;
        await channel.send({
          protocol_version: protocolVersion,
          controller_run_id: null,
          message_id: launch,
          reply_to: launch,
          kind: 'worker-launch-result',
          payload: { status: 'requested', worker: (request.payload.context as { invocationId: string }).invocationId },
        });
        const frame = (kind: string, payload: Record<string, unknown>) =>
          channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: launch, reply_to: launch, kind, payload: payload as never });
        void (async () => {
          await frame('worker-started', {
            receipt,
            invocation: { executionId: 'execution-2', invocationId: (request.payload.context as { invocationId: string }).invocationId },
          });
          await frame('worker-completed', completion);
        })();
      },
    },
    { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } },
  );
  t.after(() => server.close());
  return { root, received };
}

test('AC1: a Builder continuation reaches the owner as the exact observed session reference; the completion carries the new preserved session', async t => {
  const next = { ...session, ref: 'r/bootB/w-bbbb/profile/sessions/s.jsonl', sha256: 'b'.repeat(64), bytes: 20 };
  const o = await owner(t, { status: 'success', receipt, session: next });
  const handle = await createWorkers({ root: o.root, profile, knownSecrets: [] }).activate({
    context,
    prompt: 'continue\nanswer',
    signal: new AbortController().signal,
    skillPack: 'factory-skills-v4',
    modelBudget: 'builder-v1',
    continuation: { session },
  });
  await handle.started;
  assert.deepEqual(await handle.completed, { status: 'success', receipt, session: next });
  const launch = o.received.find(item => item.kind === 'launch-worker')!;
  assert.deepEqual(launch.payload.continueSession, { ref: session.ref, sha256: session.sha256, sessionId: session.sessionId, bytes: session.bytes });
  assert.equal(launch.payload.prompt, 'continue\nanswer');
  handle.close();
});

test('AC1/AC2: a reviewer never continues a session nor reports one; a malformed session reference is refused before any launch', async t => {
  const o = await owner(t, { status: 'success', receipt });
  const workers = createWorkers({ root: o.root, profile, knownSecrets: [], profiles: { builder: profile, standards: profile, spec: profile } });
  await assert.rejects(
    workers.activate({
      context: { ...context, role: 'spec', invocationId: 'spec-2' },
      prompt: 'review',
      signal: new AbortController().signal,
      continuation: { session },
    }),
    /WORKER_LAUNCH_INVALID/,
  );
  await assert.rejects(
    workers.activate({
      context: { ...context, invocationId: 'builder-3' },
      prompt: 'continue',
      signal: new AbortController().signal,
      continuation: { session: { ...session, ref: 'r/../../etc/passwd' } },
    }),
    /WORKER_LAUNCH_INVALID/,
  );
  assert.equal(o.received.filter(item => item.kind === 'launch-worker').length, 0, 'nothing reached the owner');
  const reporting = await owner(t, { status: 'success', receipt, session });
  const reviewer = await createWorkers({
    root: reporting.root,
    profile,
    knownSecrets: [],
    profiles: { builder: profile, standards: profile, spec: profile },
  }).activate({ context: { ...context, role: 'spec', invocationId: 'spec-4' }, prompt: 'review', signal: new AbortController().signal });
  await reviewer.started;
  await assert.rejects(reviewer.completed, /WORKER_EXECUTION_UNCERTAIN/, 'a reviewer completion carrying a session is uncertain, never adopted');
  reviewer.close();
});
