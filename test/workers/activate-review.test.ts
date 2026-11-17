import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';

// Real Workers facade + Protocol against a scripted owner endpoint (the real owner side is test/sandbox/owner-handoff).
const boot = 'boot-77777777-2222-4333-8444-555555555555';
const environmentRef = `env-${'b'.repeat(64)}`;
const workId = 'work-12';
const receipt = { workId, id: '99999999-2222-4333-8444-555555555555' };
const oauth = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'builder', auth: 'factory-oauth' as const, providerId: 'openai' as const,
  modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const summary = { version: 1, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'e'.repeat(64), head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40), mergeBase: 'a'.repeat(40),
  counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: Object.fromEntries(['committed', 'staged', 'unstaged'].map(name => [name, { path: `/artifacts/review/r1/${name}.patch`, bytes: 0, sha256: 'd'.repeat(64) }])),
  spec: null, instructions: null, changed: [], changedTruncated: false };
const opinion = (role: string, invocationId: string) => ({ version: 1, role, round: 1, attempt: 1, invocationId, reference: { workId, id: '88888888-2222-4333-8444-555555555555' },
  session: { file: null }, model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: oauth.id, modelBudget: 'reviewer-v1' },
  input: { handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] }, conclusion: 'clean', code: null,
  coverage: { scope: 'broad', justification: 'j', examined: [] }, findings: [], limitations: [],
  hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: 'f'.repeat(64), recordedAt: new Date().toISOString() });

async function owner(t: { after(fn: () => Promise<void>): void }, completion: (launch: Envelope) => Record<string, unknown>) {
  const root = await mkdtemp('/tmp/arev-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId, environment: environmentRef }), { mode: 0o600 });
  await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  let launch: Envelope | undefined;
  const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
    received.push(request);
    const send = (kind: string, payload: Record<string, unknown>, id = launch!.message_id) => channel.send({ protocol_version: protocolVersion, controller_run_id: null,
      message_id: id, reply_to: id, kind, payload: payload as never });
    if (request.kind === 'launch-worker') {
      launch = request;
      await send('worker-launch-result', { status: 'requested', worker: (request.payload.context as { invocationId: string }).invocationId });
      await send('worker-started', { receipt, invocation: { executionId: 'execution', invocationId: (request.payload.context as { invocationId: string }).invocationId } });
      if ((request.payload.context as { role: string }).role === 'builder') await send('worker-handoff', { round: 1, status: 'captured', summary });
      else await send('worker-completed', completion(request));
    } else if (request.kind === 'deliver-directive') {
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: request.message_id, reply_to: request.message_id, kind: 'delivery-result', payload: { status: 'delivered' } });
      await send('worker-completed', completion(request));
    }
  } }, { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
  t.after(() => server.close());
  return { root, received };
}
const context = (role: 'builder' | 'standards' | 'spec', invocationId: string) => ({ workId, executionId: 'execution', invocationId, role, environmentRef, bootRef: boot, phaseId: 'phase' });

test('AC3: activate exposes the Builder handoff and delivers the review results on the same launch; completion follows', async t => {
  const o = await owner(t, () => ({ status: 'success', receipt }));
  const facade = createWorkers({ root: o.root, profile: oauth, knownSecrets: [] });
  const handle = await facade.activate({ context: context('builder', 'builder-1'), prompt: '/implement x',
    signal: new AbortController().signal, modelBudget: 'builder-v1', handoff: { baseCommit: 'a'.repeat(40) } });
  t.after(() => handle.close());
  await handle.started;
  assert.deepEqual(await handle.handoffs.next(), { round: 1, status: 'captured', summary });
  assert.deepEqual(await facade.deliver(handle.worker, { kind: 'review-results', round: 1, prompt: 'results', findings: { standards: [], spec: ['S1'] } }), { status: 'delivered' });
  assert.deepEqual(await handle.completed, { status: 'success', receipt });
  assert.equal(await handle.handoffs.next(), null, 'no handoff after completion');
  const launch = o.received.find(message => message.kind === 'launch-worker')!;
  assert.deepEqual(launch.payload.handoff, { baseCommit: 'a'.repeat(40) });
  const deliver = o.received.find(message => message.kind === 'deliver-directive')!;
  assert.deepEqual([deliver.reply_to, deliver.payload], [launch.message_id, { directive: { kind: 'review-results', round: 1, prompt: 'results', findings: { standards: [], spec: ['S1'] } } }],
    'ticket 13: the listed finding ids travel with the results');
});

test('ticket 21: the reconciliation Builder launch carries the authorized remote tip the Host capture checks (`preserve`); a malformed one refuses the launch', async t => {
  const o = await owner(t, () => ({ status: 'success', receipt }));
  const facade = createWorkers({ root: o.root, profile: oauth, knownSecrets: [] });
  const handle = await facade.activate({ context: context('builder', 'builder-r'), prompt: 'Factory reconciliation instruction', signal: new AbortController().signal,
    modelBudget: 'builder-v1', handoff: { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4 }, preserve: '1'.repeat(40) } });
  t.after(() => handle.close());
  await handle.started;
  assert.deepEqual(o.received.find(message => message.kind === 'launch-worker')!.payload.handoff, { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4 }, preserve: '1'.repeat(40) });
  await assert.rejects(facade.activate({ context: context('builder', 'builder-bad'), prompt: 'x', signal: new AbortController().signal,
    handoff: { baseCommit: 'a'.repeat(40), preserve: 'HEAD' } }), /WORKER_LAUNCH_INVALID/, 'only an exact commit id, never a ref the guest resolves');
});

test('real run R-CAND v2: a continuation Builder launch carries the findings delivered before its first round; a later or malformed one refuses the launch', async t => {
  const o = await owner(t, () => ({ status: 'success', receipt }));
  const facade = createWorkers({ root: o.root, profile: oauth, knownSecrets: [] });
  const delivered = [{ round: 4, standards: [], spec: ['S1'] }];
  const handle = await facade.activate({ context: context('builder', 'builder-c'), prompt: 'continue', signal: new AbortController().signal,
    modelBudget: 'builder-v1', handoff: { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4, delivered } } });
  t.after(() => handle.close());
  await handle.started;
  assert.deepEqual(o.received.find(message => message.kind === 'launch-worker')!.payload.handoff, { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4, delivered } });
  for (const bad of [[{ round: 5, standards: [], spec: ['S1'] }], [{ round: 4, standards: [], spec: ['S 1'] }]])
    await assert.rejects(facade.activate({ context: context('builder', 'builder-bad'), prompt: 'x', signal: new AbortController().signal,
      handoff: { baseCommit: 'a'.repeat(40), rounds: { first: 5, max: 4, delivered: bad } } }), /WORKER_LAUNCH_INVALID/);
});

test('AC4/AC5: reviewers launch with their own configured profile, budget and review input; the opinion must be this invocation\'s', async t => {
  const o = await owner(t, launch => {
    const invocationId = (launch.payload.context as { invocationId: string }).invocationId;
    return { status: 'success', receipt, opinion: opinion(invocationId === 'spec-bad' ? 'standards' : 'spec', invocationId) };
  });
  const reviewerProfile = { ...oauth, systemPrompt: 'spec reviewer' };
  const workers = createWorkers({ root: o.root, profile: oauth, knownSecrets: [], profiles: { spec: reviewerProfile, builder: oauth } });
  const review = { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: ['/artifacts/review/r1/index.json'], missing: [] };
  const handle = await workers.activate({ context: context('spec', 'spec-1'), prompt: 'review', signal: new AbortController().signal, modelBudget: 'reviewer-v1', review });
  t.after(() => handle.close());
  const done = await handle.completed;
  assert.ok(done.status === 'success' && done.opinion?.conclusion === 'clean');
  const launch = o.received.find(message => message.kind === 'launch-worker')!;
  assert.deepEqual([(launch.payload.profile as { systemPrompt: string }).systemPrompt, launch.payload.modelBudget, launch.payload.review], ['spec reviewer', 'reviewer-v1', review]);
  assert.deepEqual(await workers.deliver(handle.worker, { kind: 'review-results', round: 1, prompt: 'x' }), { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' }, 'no directive to a reviewer');
  const bad = await workers.activate({ context: context('spec', 'spec-bad'), prompt: 'review', signal: new AbortController().signal, review });
  t.after(() => bad.close());
  await assert.rejects(bad.completed, /WORKER_EXECUTION_UNCERTAIN/, 'an opinion of another role is never accepted');
  await assert.rejects(workers.activate({ context: context('spec', 'spec-2'), prompt: 'review', signal: new AbortController().signal, handoff: { baseCommit: 'a'.repeat(40) } }), /WORKER_LAUNCH_INVALID/);
  await assert.rejects(workers.activate({ context: context('builder', 'b-2'), prompt: 'x', signal: new AbortController().signal, review }), /WORKER_LAUNCH_INVALID/);
});

test('review fix 6: a reviewer with a review input refuses to launch without its own explicitly configured profile (no role fallback)', async t => {
  const o = await owner(t, () => ({ status: 'success', receipt }));
  const review = { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] };
  const invocation = { context: context('standards', 'standards-1'), prompt: 'review', signal: new AbortController().signal, review };
  await assert.rejects(createWorkers({ root: o.root, profile: oauth, knownSecrets: [] }).activate(invocation), /WORKER_PROFILE_NOT_CONFIGURED/);
  await assert.rejects(createWorkers({ root: o.root, profile: oauth, knownSecrets: [], profiles: { spec: oauth } }).activate(invocation), /WORKER_PROFILE_NOT_CONFIGURED/);
  await assert.rejects(createWorkers({ root: o.root, profile: oauth, knownSecrets: [], profiles: { spec: oauth } }).activate({ context: context('builder', 'b-9'), prompt: 'x',
    signal: new AbortController().signal }), /WORKER_PROFILE_NOT_CONFIGURED/, 'with per-role profiles, every role must be explicit');
  assert.equal(o.received.length, 0, 'refused before any launch');
});

test('ticket 18: the Builder system prompt is chosen per session from its phase and exact tool set; an unsupported mode refuses before launch', async t => {
  const o = await owner(t, () => ({ status: 'success', receipt }));
  const seen: { phaseId: string; tools: string[] }[] = [];
  const workers = createWorkers({ root: o.root, profile: oauth, knownSecrets: [], builderPrompt: session => {
    seen.push(session);
    if (session.phaseId === 'refused') throw new Error('BUILDER_SESSION_MODE_UNSUPPORTED');
    return session.tools.includes('handoff') ? 'implementation prompt' : 'publication prompt';
  } });
  const handle = await workers.activate({ context: { ...context('builder', 'builder-p'), phaseId: 'builder-publication' }, prompt: 'publish', signal: new AbortController().signal,
    skillPack: 'factory-skills-v6', copyOutput: true });
  t.after(() => handle.close());
  await handle.started;
  const launch = o.received.find(message => message.kind === 'launch-worker')!;
  assert.equal((launch.payload.profile as { systemPrompt: string }).systemPrompt, 'publication prompt');
  assert.deepEqual(seen, [{ phaseId: 'builder-publication', tools: ['ask_user', 'bash', 'read', 'write'] }]);
  const launches = o.received.filter(message => message.kind === 'launch-worker').length;
  await assert.rejects(workers.activate({ context: { ...context('builder', 'builder-r'), phaseId: 'refused' }, prompt: 'x', signal: new AbortController().signal }), /BUILDER_SESSION_MODE_UNSUPPORTED/);
  assert.equal(o.received.filter(message => message.kind === 'launch-worker').length, launches, 'nothing launched');
});
