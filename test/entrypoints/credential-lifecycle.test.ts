import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { ExecutionPorts, ListView, WorkView } from '../../src/control/index.js';
import type { BuilderGrant } from '../../src/contracts/index.js';
import { createBuilderCredentials, createGitHubAccess } from '../../src/platform/github/index.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';
import { listen, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope } from '../control/doubles.js';
import { githubWorld } from './github-world-fixture.js';
import { remainingMs } from '../runner/budget.js';

// I-local composition (ticket 20): real Control + Pi Durable/SQLite, real GitHub App issuer and gh self-revocation against the synthetic
// GitHub world (gh + App HTTPS substituted, synthetic secrets), real Workers facade and Protocol to a scripted owner endpoint. The owner
// side of the same deliver/withdraw frames runs as real code in test/sandbox/owner-credential. Not evidence of real GitHub/VM/worker/model.
const boot = 'boot-77777777-2222-4333-8444-555555555555';
const environmentRef = `env-${'b'.repeat(64)}`;
const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'p', auth: 'factory-oauth' as const, providerId: 'openai' as const,
  modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };

test('ticket 20 AC1/AC2/AC4/AC7: a long Builder activity is renewed by real reduced issuances delivered over the host channel, and every known grant is self-revoked at the end', { timeout: remainingMs() }, async t => {
  const world = await githubWorld(t, { repositories: [{ name: 'acme/project', id: 3, installation: 2 }], issues: [], pulls: [], tokenLifetimeSeconds: 32 });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const real = createBuilderCredentials({ github, repositories: [{ repository: 'acme/project', installationId: 2, workflows: false }] });
  const grants: BuilderGrant[] = [];
  const credentials: ExecutionPorts['credentials'] = { async issue(context) { const grant = await real.issue(context); grants.push(grant); return grant; }, revoke: grant => real.revoke(grant) };

  // Scripted owner endpoint at the real host-boot path, consuming the real Workers frames.
  const root = await mkdtemp('/tmp/c20-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = join(root, 'environments', environmentRef);
  await mkdir(environment, { recursive: true, mode: 0o700 });
  await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId: 'unused', environment: environmentRef }), { mode: 0o600 });
  const runtime = workerRuntimeDirectory(root, boot);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'owner.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
  const received: Envelope[] = [];
  let finish!: () => Promise<void>;
  let workId = '';
  const startOwner = async () => {
    const server = await listen(join(runtime, 'owner'), { async message(request, channel) {
      received.push(request);
      const frame = (kind: string, payload: Record<string, unknown>) => channel.send({ protocol_version: protocolVersion, controller_run_id: null,
        message_id: request.message_id, reply_to: request.message_id, kind, payload: payload as never });
      if (request.kind === 'deliver-credential') { await frame('credential-result', { status: 'delivered' }); return; }
      if (request.kind === 'withdraw-credential') { await frame('credential-result', { status: 'withdrawn' }); return; }
      const context = request.payload.context as Record<string, string>;
      await frame('worker-launch-result', { status: 'requested', worker: context.invocationId });
      await frame('worker-started', { receipt: { workId: context.workId, id: '99999999-2222-4333-8444-555555555555' }, invocation: { executionId: context.executionId, invocationId: context.invocationId } });
      finish = () => frame('worker-completed', { status: 'success', receipt: { workId: context.workId, id: '99999999-2222-4333-8444-555555555555' } });
    } }, { kind: 'host-boot', binding: { workId, environmentRef, bootRef: boot } });
    t.after(() => server.close());
  };

  const tracker = githubDoubles({ pulls: {}, issues: [remoteIssue(3)] });
  const time = manualClock();
  const storagePath = join(root, 'control.sqlite');
  const control = await openControl({ storagePath, runtimeInventory: 'empty', access: { tracker: tracker.tracker, repository: tracker.repository, repositories: [scope] },
    polling: { intervalSeconds: 60, clock: time.clock }, execution: {
      configuration: {}, capacity: 1, builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1' }, credentials,
      credentialRenewal: { beforeExpirySeconds: 30.5 },
      workers: createWorkers({ root, profile, knownSecrets: [] }),
      sandbox: {
        async prepare(input) {
          workId = input.workId;
          await writeFile(join(environment, 'owner.json'), JSON.stringify({ workId, environment: environmentRef }), { mode: 0o600 });
          await writeFile(join(environment, 'current.json'), JSON.stringify({ environment: environmentRef, boot }), { mode: 0o600 });
          await startOwner();
          return { status: 'success', environment: environmentRef as never, seeds: [], checkout: { path: '/workspace/checkout', repository: 'acme/project', repositoryId: 3, base: 'main',
            branch: input.checkout.branch, baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: false, preparedAt: new Date().toISOString() } };
        },
        async start() { return { status: 'success', boot: boot as never }; },
        async stop() { return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
      } } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const until = async (predicate: () => Promise<boolean> | boolean, limit = 6000) => {
    for (let i = 0; i < limit; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('condition not reached');
  };
  await time.sleeping();
  await until(() => received.filter(message => message.kind === 'deliver-credential').length >= 4);
  finish();
  await until(async () => (await work())?.execution?.slot.held === false);
  const execution = (await work())!.execution!;
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });

  const deliveries = received.filter(message => message.kind === 'deliver-credential');
  const issued = grants.map(grant => grant.delivery.token);
  assert.ok(issued.length >= 4);
  assert.equal(new Set(issued).size, issued.length, 'each renewal is a NEW grant');
  assert.deepEqual(deliveries.map(message => message.payload.token), issued.slice(0, deliveries.length), 'initial handshake + renewals, in issuance order, over the host channel');
  assert.deepEqual(received.filter(message => message.kind === 'launch-worker').length, 1, 'one activation: renewal never restarts or replays');
  assert.ok(received.filter(message => message.kind === 'launch-worker').every(message => !JSON.stringify(message.payload).includes('synthetic-installation-secret')));
  const trace = await world.trace();
  const posts = trace.filter(entry => entry.method === 'POST');
  assert.equal(posts.length, issued.length);
  assert.ok(posts.every(entry => JSON.stringify(entry.permissions) === JSON.stringify({ metadata: 'read', contents: 'read', issues: 'read' })), 'every renewal keeps the reduced read purpose, no Workflows/write');
  // End: one self-revocation per known grant; GitHub no longer accepts any of them.
  assert.deepEqual((await world.revoked()).sort(), [...issued].sort());
  assert.equal(trace.filter(entry => entry.method === 'DELETE' && entry.endpoint === '/installation/token').length, issued.length);
  assert.equal((await real.revoke(grants[0]!)).kind, 'already-invalid');
  assert.deepEqual([execution.credentialLifecycle.reason, execution.credentialIssuance!.revocation], ['ended', 'revoked']);
  assert.ok(execution.credentialRenewals.every(renewal => renewal.revocation === 'revoked' && renewal.metadata!.permissions.issues === 'read'));
  assert.ok(execution.credentialRenewals.slice(0, 3).every(renewal => renewal.delivery === 'delivered'));
  for (const file of ['control.sqlite', 'control.sqlite-wal']) {
    const bytes = await readFile(join(root, file)).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from('synthetic-installation-secret')), false, `${file} holds no grant value`);
  }
  assert.doesNotMatch(JSON.stringify(execution), /synthetic-installation-secret/);
});
