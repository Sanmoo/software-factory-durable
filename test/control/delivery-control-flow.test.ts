import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import type { CleanupPorts, Control, ControlStatus, ExecutionPorts, ListView, ShowView, WorkView } from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { works } from '../../src/control/durable/admission.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { deliveryRepository, headSha, merged, ownFacts, ownPublication } from './delivery-fixture.js';
import { untilHolds } from '../runner/budget.js';

// Flow level: real Control (dispatcher, delivery desk, Pi Durable + SQLite). Doubled: GitHub, clock, Sandbox lifecycle/cleanup, Workers and
// credentials. The own PR link is seeded in ticket 14's typed PublicationView shape (its discovery is exercised by ticket 14's own tests). Not evidence of real GitHub/VM.
const environment = `env-${'c'.repeat(64)}`;
function ports(calls: string[]): ExecutionPorts & { cleanup: CleanupPorts } {
  let activations = 0;
  return {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push('prepare');
        return {
          status: 'success',
          environment: environment as never,
          seeds: [],
          checkout: {
            path: '/workspace/checkout',
            repository: 'acme/project',
            repositoryId: 3,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: activations > 0,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        calls.push('start');
        return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never };
      },
      async stop() {
        calls.push('stop');
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
    },
    credentials: {
      async issue() {
        calls.push('issue');
        return {
          delivery: { token: 'ghs_syntheticDelivery0123456789' },
          metadata: {
            role: 'builder',
            purpose: 'builder-start',
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions: { metadata: 'read', contents: 'read', issues: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push('revoke');
        return { kind: 'revoked', code: 'X', nextStep: 'x' };
      },
    },
    workers: {
      async activate(invocation) {
        calls.push('activate');
        const first = activations++ === 0;
        const receipt = { workId: invocation.context.workId, id: `99999999-2222-4333-8444-55555555555${activations}` };
        const started = Promise.resolve({
          receipt,
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        // The first activation completes; the second hangs until the activity is interrupted (merge confirmed meanwhile).
        const completed = first ? started.then(() => ({ status: 'success' as const, receipt })) : new Promise<never>(() => {});
        if (!first) invocation.signal.addEventListener('abort', () => calls.push('activity-aborted'), { once: true });
        return {
          worker: invocation.context.invocationId,
          started,
          completed,
          close() {
            calls.push('close');
          },
        };
      },
      async deliver(_worker, directive) {
        calls.push(`deliver-${directive.kind}`);
        return { status: directive.kind === 'credential' ? 'delivered' : 'withdrawn' };
      },
    },
    cleanup: {
      async preserve(input) {
        calls.push(`preserve:${input.environment}`);
        return {
          status: 'preserved',
          reference: { workId: input.workId, id: '11111111-1111-4111-8111-111111111111', manifestSha256: 'f'.repeat(64), files: 3, bytes: 42 },
        };
      },
      async remove(input) {
        calls.push(`remove:${input.environment}`);
        return {
          status: 'success',
          resources: [
            { resource: 'disk', status: 'removed' },
            { resource: 'workspace', status: 'removed' },
            { resource: 'artifacts', status: 'removed' },
            { resource: 'runtime', status: 'removed' },
          ],
        };
      },
      retrySeconds: 0,
    },
  };
}

test('AC1/AC7 (control flow): merge observed during an activity delivers, interrupts it, admits nothing new, cleans own resources; CLI views explain delivery and cleanup separately', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-delivery-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, 'control.sqlite');
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const pr = { pull: ownFacts() as ReturnType<typeof ownFacts> | 'unavailable', branch: {} as Record<string, string> };
  const delivery = deliveryRepository(pr);
  const calls: string[] = [];
  const execution = ports(calls);
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  const start = async () => {
    const time = manualClock();
    const control = await openControl({
      storagePath,
      runtimeInventory: 'empty',
      execution,
      access: {
        tracker: github.tracker,
        repository: { ...github.repository, readOwnMerge: delivery.repository.readOwnMerge!, cleanupBranch: delivery.repository.cleanupBranch! },
        repositories: [scope],
      },
      polling: { intervalSeconds: 60, clock: time.clock },
    });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  };
  const stop = async () => {
    current!.stop.abort();
    assert.deepEqual(await current!.running, { kind: 'clean' });
  };
  t.after(async () => {
    if (current && !current.stop.signal.aborted) await stop();
  });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0]!;
  const until = async (predicate: () => Promise<boolean>) => {
    await untilHolds('condition', predicate, 5);
  };
  const cycle = async () => {
    current!.time.advance();
    await current!.time.sleeping();
  };

  // 1. Implementation Execution completes (no PR link yet: nothing to observe).
  await start();
  await until(async () => (await work())?.execution?.slot.held === false);
  const work_id = (await work()).work_id;
  assert.equal(delivery.calls.length, 0, 'no own pull request linked: nothing is read');
  await stop();
  // 2. Ticket 14 links the own PR (seeded in its recorded shape).
  const seeded = await openStore(storagePath);
  await seeded.session.commit(async tx => {
    const record = (await tx.doc(works, work_id, null)).work!;
    record.publication = ownPublication(work_id, { branch: record.execution!.request.branch });
  }, BACKGROUND_CONTEXT);
  await seeded.close();
  const branch = (
    await (async () => {
      await start();
      return work();
    })()
  ).execution!.request.branch;
  pr.pull = ownFacts({ headRef: branch });
  pr.branch[branch] = headSha;
  // 3. An operator scope update resumes the Work: a second activity runs (and hangs).
  assert.equal(
    (
      (await current!.control.accept({
        request_id: 'scope-1',
        operation: 'update-scope',
        work_id,
        reason: 'Also cover the empty case.',
        origin: 'local-cli',
      })) as { outcome: string }
    ).outcome,
    'accepted',
  );
  await cycle();
  await until(async () => (await work()).execution?.state === 'started' && calls.filter(call => call === 'activate').length === 2);
  const active = (await work()).execution!.executionId;
  // 4. A human merges the own PR; the next cycle confirms it.
  pr.pull = merged({ headRef: branch });
  await cycle();
  await until(async () => (await work()).execution?.slot.held === false);
  // The cleanup evaluated during that cycle waited for the activity to cease; the next owner cycle sweeps it.
  assert.deepEqual((await work()).cleanup?.state, 'waiting');
  await cycle();
  await until(async () => (await work()).cleanup?.state === 'complete');
  const delivered: WorkView = ((await current!.control.inspect({ kind: 'show', work_id })) as Extract<ShowView, { kind: 'work' }>).work;
  assert.equal(delivered.result, 'delivered');
  assert.equal(delivered.delivery?.merge?.duringActivity, active);
  assert.ok(calls.includes('activity-aborted'), 'the running activity was interrupted');
  assert.deepEqual(
    [delivered.execution!.end?.outcome, delivered.execution!.end?.code, delivered.execution!.end?.cessation, delivered.execution!.credentialLifecycle.reason],
    ['failure', 'WORK_DELIVERED', 'confirmed', 'delivered'],
  );
  assert.deepEqual(
    delivered.cleanup!.resources.map(item => [item.kind, item.state]),
    [
      ['environment', 'removed'],
      ['checkout', 'removed'],
      ['local-branch', 'removed'],
      ['temporaries', 'removed'],
      ['remote-branch', 'removed'],
    ],
  );
  assert.ok(calls.indexOf(`preserve:${environment}`) < calls.indexOf(`remove:${environment}`), 'evidence preserved before removal');
  // CLI payloads (`factory show` / `factory status` print these views): delivery and cleanup are separate sections with their own next step.
  assert.match(delivered.delivery!.nextStep, /^Delivered: a human merged the own pull request/);
  assert.match(delivered.cleanup!.nextStep, /^Cleanup complete/);
  const status = (await current!.control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual(status.delivery, { delivered: 1, cleanup: { waiting: 0, pending: 0, complete: 1 } });
  assert.equal(status.works.open, 0);
  // No new agent action after delivery, whatever later cycles or commands.
  await cycle();
  await cycle();
  assert.equal(calls.filter(call => call === 'activate').length, 2);
  assert.equal(
    (
      (await current!.control.accept({ request_id: 'scope-2', operation: 'update-scope', work_id, reason: 'More.', origin: 'local-cli' })) as {
        outcome: string;
      }
    ).outcome,
    'not-applied',
  );
  assert.equal(calls.filter(call => call.startsWith('remove:')).length, 1, 'complete cleanup is not repeated');
});
