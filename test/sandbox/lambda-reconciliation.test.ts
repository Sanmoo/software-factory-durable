import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, installationTagKey, planLambdaReconciliation, reconcileLambdaRuntime, workTagKey, type BootRef, type EnvironmentRef } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';

// v2 ticket 15 (V2-33, V2-34): the inventory of the installation's MicroVMs taken when the controller starts, over the in-memory account
// and the in-process guest. No AWS call, no ssh, no socket; time is the account's fake clock. The crash itself (a real SIGKILL of a
// controller with a boot in progress) is `test/entrypoints/lambda-crash-reconciliation.test.ts`; these are its variations.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: sha('d'), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [{ name: 'maven', version: '3.9.11-r0' }], images: [] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const checkout = { repository: 'acme/shop', commit: startingCommit, credential: { token: 'ghs_builderTokenOfThisExecution' } };

async function installation(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guest = lambdaGuestFake(fake);
  guest.world.origins[remote] = { commits: [startingCommit], token: checkout.credential.token };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const lambda = { lambdaService: fake.service, lambdaBootClock: clock };
  const sandbox = createSandbox({ root, ...lambda, lambdaTransport: guest.transport, lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepared = await sandbox.prepare({ workId, configuration, environment: pinned });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const start = () => sandbox.start({ environment, configuration, checkout });
  /** The controller start's reconciliation, as a NEW process would run it: same root, same account, nothing shared in memory. */
  const reconcile = () => reconcileLambdaRuntime({ root, configuration, ...lambda });
  const terminations = () => fake.mutations.filter(call => call.operation === 'terminateMicrovm').map(call => call.input);
  const records = async () => {
    const names = await readdir(join(root, 'lambda', 'reconciliations')).catch(() => [] as string[]);
    return Promise.all(names.sort().map(async name => JSON.parse(await readFile(join(root, 'lambda', 'reconciliations', name), 'utf8')) as {
      at: string; listed: number; otherInstallations: number; microvms: { microvmId: string; workId: string | null; action: string; cessation: string; terminatedAt?: string }[];
      boots: { boot: string; action: string }[] }));
  };
  /** RunMicrovm answered by the service while the host never got to record the id: the controller died, or the answer was unreadable. */
  const unrecordedStart = async () => {
    fake.account.runRefusal = { kind: 'unknown', detail: 'Unreadable answer from aws lambda-microvms run-microvm' };
    const started = await start();
    assert.deepEqual([started.status, 'code' in started && started.code], ['indeterminate', 'MICROVM_START_UNCONFIRMED']);
    fake.account.runRefusal = null;
    const image = fake.account.images[0]!;
    const run = await fake.service({ awsProfile: 'factory', region: 'us-east-1' }).runMicrovm({ imageArn: image.imageArn, maximumDurationSeconds: 3600, runHookPayload: '{}',
      tags: { [installationTagKey]: 'acme', [workTagKey]: workId } });
    assert.equal(run.ok, true);
    fake.account.clock.now += 3000;
    return { boot: (started as { boot: BootRef }).boot, microvmId: fake.account.microvms.at(-1)!.microvmId };
  };
  return { root, fake, guest, sandbox, environment, start, reconcile, terminations, records, unrecordedStart };
}

test('AC1: the MicroVM, its image and the build artifact all carry the installation tag and the Work tag', async t => {
  const { fake, start } = await installation(t);
  assert.equal((await start()).status, 'success');
  const tags = { [installationTagKey]: 'acme', [workTagKey]: workId };
  assert.deepEqual(fake.account.microvms.map(microvm => microvm.request.tags), [tags]);
  assert.deepEqual(fake.account.images.map(image => image.tags), [tags]);
  const objects = Object.values(fake.account.objects).flatMap(bucket => Object.values(bucket));
  assert.deepEqual(objects.map(object => object.tags), [tags]);
});

for (const listsMicrovmTags of [false, true]) {
  const mode = listsMicrovmTags ? 'MicroVM tags listed' : 'observed listing, no MicroVM tags';
  test(`AC2 (${mode}): a MicroVM no boot record holds is terminated by the inventory, cessation is confirmed by GetMicrovm and recorded, and the unanswered start is closed`, async t => {
    const { fake, sandbox, environment, reconcile, terminations, records, unrecordedStart } = await installation(t);
    fake.account.listsMicrovmTags = listsMicrovmTags;
    const { boot, microvmId } = await unrecordedStart();
    fake.settle();
    assert.equal(fake.account.microvms.at(-1)!.state, 'RUNNING');
    // Before the inventory the host cannot tell whether that start left a MicroVM: Control would keep the Slot.
    assert.deepEqual([(await sandbox.observe({ environment })).condition, (await sandbox.stop({ environment, boot, reason: 'end' })).cessationConfirmed], ['indeterminate', false]);

    const result = await reconcile();
    assert.equal(result.status, 'reconciled', JSON.stringify(result));
    assert.deepEqual(terminations(), [microvmId]);
    assert.equal(fake.account.microvms.at(-1)!.state, 'TERMINATED');
    assert.deepEqual(result.status === 'reconciled' && [result.environments, result.unknown], [[], []], 'nothing of the installation is left running for Control to settle');
    const [record] = await records();
    assert.deepEqual(record!.microvms.map(item => [item.microvmId, item.workId, item.action, item.cessation, typeof item.terminatedAt]),
      [[microvmId, listsMicrovmTags ? workId : null, 'terminated', 'confirmed', 'string']]);
    // The lifecycle evidence is GetMicrovm's: the confirmation was a read of the service after the request.
    const reads = fake.calls.map(call => call.operation);
    assert.equal(reads.lastIndexOf('microvm') > reads.lastIndexOf('terminateMicrovm'), true);
    // The start that never recorded an id is now known to have left nothing running: the boot is ended, with the code of its failure.
    const ended = await sandbox.bootRecord({ environment, boot });
    assert.deepEqual([ended!.phase, ended!.end?.reason, ended!.end?.code], ['ended', 'end', 'MICROVM_START_UNCONFIRMED']);
    assert.deepEqual([(await sandbox.observe({ environment })).condition, (await sandbox.observe({ environment })).cessationConfirmed], ['stopped', true]);
  });

  test(`AC3 (${mode}): a MicroVM of another installation in the same account is never touched, read or listed`, async t => {
    const { fake, reconcile, terminations, records, unrecordedStart } = await installation(t);
    fake.account.listsMicrovmTags = listsMicrovmTags;
    const other = fake.plantOtherInstallation('acme-2');
    await unrecordedStart();
    fake.calls.length = 0;
    const result = await reconcile();
    assert.equal(result.status, 'reconciled');
    assert.equal(fake.account.microvms.find(microvm => microvm.microvmId === other.microvmId)!.state, 'RUNNING');
    assert.equal(terminations().includes(other.microvmId), false);
    assert.equal(fake.calls.some(call => call.input === other.microvmId || call.input === other.imageArn), false, 'not even a read names the other installation\'s resources');
    assert.equal(JSON.stringify(result).includes(other.microvmId), false);
    const [record] = await records();
    assert.equal(record!.otherInstallations, 1);
    assert.equal(JSON.stringify(record).includes(other.microvmId), false);
  });
}

test('AC4: a MicroVM held by a boot that has not ended is not terminated by the inventory; it is listed with its Work for Control, whose stop then confirms cessation', async t => {
  const { fake, sandbox, environment, start, reconcile, terminations, records } = await installation(t);
  const started = await start();
  assert.equal(started.status, 'success');
  const boot = (started as { boot: BootRef }).boot;
  const result = await reconcile();
  assert.deepEqual(result, { status: 'reconciled', at: new Date(fake.account.clock.now).toISOString(), environments: [{ environment, workId }], unknown: [] });
  assert.deepEqual(terminations(), []);
  assert.equal(fake.account.microvms[0]!.state, 'RUNNING');
  assert.deepEqual((await records())[0]!.microvms.map(item => [item.action, item.cessation]), [['listed', 'not-requested']]);
  // Control decides: only an Execution that is not alive has its boot stopped (never adopted), through the same seam as any stop.
  assert.equal((await sandbox.observe({ environment })).condition, 'active');
  assert.deepEqual([(await sandbox.stop({ environment, boot, reason: 'controller recovery: own survivor stopped, not adopted' })).cessationConfirmed, fake.account.microvms[0]!.state], [true, 'TERMINATED']);
  assert.deepEqual(await reconcile().then(next => next.status === 'reconciled' && next.environments), []);
  assert.equal((await records()).length, 1, 'an inventory that finds nothing running leaves no record');
});

test('a listing the account refuses is an UNKNOWN inventory: nothing is terminated, nothing is closed, and dispatch stays closed', async t => {
  const { fake, sandbox, environment, reconcile, terminations, records, unrecordedStart } = await installation(t);
  const { boot } = await unrecordedStart();
  fake.account.denied.push('lambda:ListMicrovms');
  const result = await reconcile();
  assert.deepEqual([result.status, result.status === 'unavailable' && result.code], ['unavailable', 'MICROVM_INVENTORY_UNAVAILABLE']);
  assert.deepEqual(terminations(), []);
  assert.equal((await sandbox.bootRecord({ environment, boot }))!.phase, 'requested');
  assert.deepEqual(await records(), []);
});

test('an end the service does not confirm leaves the MicroVM as an unknown resource and the unanswered start open', async t => {
  const { fake, sandbox, environment, reconcile, unrecordedStart, records } = await installation(t);
  const { boot, microvmId } = await unrecordedStart();
  fake.account.terminateSeconds = null;
  const result = await reconcile();
  assert.deepEqual(result.status === 'reconciled' && result.unknown, [`lambda/microvm/${microvmId}`]);
  assert.deepEqual((await records())[0]!.microvms.map(item => [item.action, item.cessation]), [['terminated', 'unconfirmed']]);
  assert.equal((await sandbox.bootRecord({ environment, boot }))!.phase, 'requested');
  assert.equal((await sandbox.observe({ environment })).cessationConfirmed, false);
});

test('an installation of another adapter has no account to inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  assert.deepEqual(await reconcileLambdaRuntime({ root, configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, lambdaService: fake.service }), { status: 'not-applicable' });
  assert.deepEqual(fake.calls, []);
});

// Pure rule: what the listing, the image tags and the host's boot records say about each MicroVM.
const account = '123456789012';
const imageOf = (name: string) => `arn:aws:lambda:us-east-1:${account}:microvm-image:${name}`;
const own = imageOf(`factory-acme-${'a'.repeat(32)}`);
const ownTags = { [installationTagKey]: 'acme', [workTagKey]: 'work-1' };
const record = (change: object = {}) => ({ boot: 'boot-1', environment: 'env-1', workId: 'work-1', phase: 'active' as const, microvmId: 'microvm-1', imageArn: own, ...change });
const plan = (input: Partial<Parameters<typeof planLambdaReconciliation>[0]>) => planLambdaReconciliation({ installation: 'acme', microvms: [], images: {}, records: [], ...input });

test('rule: without MicroVM tags the installation is decided by the image, whose name AND own installation tag must both be this installation\'s', () => {
  const microvms = [
    { microvmId: 'microvm-1', state: 'RUNNING', imageArn: own },
    { microvmId: 'microvm-2', state: 'RUNNING', imageArn: imageOf(`factory-acme-2-${'a'.repeat(32)}`) },
    { microvmId: 'microvm-3', state: 'RUNNING', imageArn: imageOf('somebody-elses-image') },
    { microvmId: 'microvm-4', state: 'RUNNING' },
    { microvmId: 'microvm-5', state: 'RUNNING', imageArn: imageOf(`factory-acme-${'b'.repeat(32)}`) },
    { microvmId: 'microvm-6', state: 'RUNNING', imageArn: imageOf(`factory-acme-${'c'.repeat(32)}`) },
  ];
  const planned = plan({ microvms, images: { [own]: ownTags, [imageOf(`factory-acme-${'b'.repeat(32)}`)]: { [installationTagKey]: 'someone-else' }, [imageOf(`factory-acme-${'c'.repeat(32)}`)]: null } });
  assert.deepEqual(planned.orphans.map(item => item.microvmId), ['microvm-1']);
  // An image named like ours whose tag could not be read is neither ours nor someone else's: reported, never terminated.
  assert.deepEqual(planned.unverifiable, ['microvm-6']);
  assert.equal(planned.otherInstallations, 4);
});

test('rule: when the service lists MicroVM tags, the installation tag alone decides, and the Work tag attributes the MicroVM', () => {
  const planned = plan({ microvms: [
    { microvmId: 'microvm-1', state: 'RUNNING', imageArn: own, tags: ownTags },
    { microvmId: 'microvm-2', state: 'RUNNING', imageArn: own, tags: { [installationTagKey]: 'acme-2', [workTagKey]: 'work-9' } },
    { microvmId: 'microvm-3', state: 'PENDING', imageArn: imageOf('renamed'), tags: { [installationTagKey]: 'acme' } }], images: {} });
  assert.deepEqual(planned.orphans, [{ microvmId: 'microvm-1', workId: 'work-1' }, { microvmId: 'microvm-3', workId: null }]);
  assert.equal(planned.otherInstallations, 1);
});

test('rule: a MicroVM is held only by a boot record that has not ended; terminated MicroVMs need nothing', () => {
  const microvms = [{ microvmId: 'microvm-1', state: 'RUNNING', imageArn: own }, { microvmId: 'microvm-2', state: 'TERMINATING', imageArn: own },
    { microvmId: 'microvm-3', state: 'TERMINATED', imageArn: own }, { microvmId: 'microvm-4', state: 'RUNNING', imageArn: own }];
  const planned = plan({ microvms, images: { [own]: ownTags }, records: [record(), record({ boot: 'boot-2', phase: 'ending', microvmId: 'microvm-2' }),
    record({ boot: 'boot-3', phase: 'ended', microvmId: 'microvm-4' })] });
  assert.deepEqual(planned.held, [{ microvmId: 'microvm-1', environment: 'env-1', boot: 'boot-1', workId: 'work-1' }, { microvmId: 'microvm-2', environment: 'env-1', boot: 'boot-2', workId: 'work-1' }]);
  // The record says ended but the service says running: no boot holds it any more.
  assert.deepEqual(planned.orphans, [{ microvmId: 'microvm-4', workId: null }]);
});

test('rule: a start whose RunMicrovm was never answered stays open until the inventory accounts for every MicroVM it could have left', () => {
  const requested = record({ boot: 'boot-9', phase: 'requested', microvmId: undefined });
  assert.deepEqual(plan({ records: [requested, record({ boot: 'boot-0', phase: 'ended' })] }).unansweredStarts, [{ environment: 'env-1', boot: 'boot-9', workId: 'work-1' }]);
});
