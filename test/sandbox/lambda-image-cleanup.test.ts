import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupLambdaImages, createSandbox, installationTagKey, planImageCleanup, type EnvironmentRef } from '../../src/sandbox/index.js';
import { accountClock, lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';

// v2 ticket 15 (V2-33): MicroVM images stay while a Work holds them and leave only by the explicit cleanup, which refuses an image in
// use. Over the in-memory account; no AWS call.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const declaration = (version: string) => ({ path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: sha(version), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [{ name: 'maven', version: `3.9.1${version}-r0` }], images: [] } });
const first = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01', second = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a02';
const remote = 'https://github.com/acme/shop.git';
const checkout = { repository: 'acme/shop', commit: '1'.repeat(40), credential: { token: 'ghs_builderTokenOfThisExecution' } };

async function installation(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-image-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guest = lambdaGuestFake(fake);
  guest.world.origins[remote] = { commits: [checkout.commit], token: checkout.credential.token };
  const clock = accountClock(fake);
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaTransport: guest.transport, lambdaBootClock: clock, lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepare = async (workId: string, version: string) => {
    const prepared = await sandbox.prepare({ workId, configuration, environment: declaration(version) });
    assert.equal(prepared.status, 'success', JSON.stringify(prepared));
    return (prepared as { environment: EnvironmentRef }).environment;
  };
  const remove = async (workId: string, environment: EnvironmentRef) => assert.equal((await sandbox.remove({ environment,
    cleanup: { workId, workDisposition: 'delivered', confirmed: true, evidencePreserved: true } })).status, 'success');
  const cleanup = async (input: { image?: string; confirm?: boolean } = {}) => (await cleanupLambdaImages({ root, configuration, lambdaService: fake.service, confirm: false, ...input }))!;
  const deletions = () => fake.mutations.map(call => call.operation).filter(operation => operation.startsWith('delete'));
  return { root, fake, sandbox, prepare, remove, cleanup, deletions };
}

test('an image is in use while the environment of a Work holds it: the cleanup plans nothing for it and refuses it by name, and nothing is deleted', async t => {
  const { fake, prepare, cleanup, deletions } = await installation(t);
  await prepare(first, 'a');
  const name = fake.account.images[0]!.name;
  fake.mutations.length = 0;
  const planned = await cleanup();
  assert.deepEqual([planned.status, planned.images.map(image => [image.imageName, image.decision, image.works])], ['planned', [[name, 'in-use', [first]]]]);
  const all = await cleanup({ confirm: true });
  assert.deepEqual([all.status, all.images.map(image => image.outcome)], ['cleaned', ['kept']], 'a cleanup of everything removable keeps what is in use');
  const named = await cleanup({ image: name, confirm: true });
  assert.deepEqual([named.status, named.code], ['refused', 'IMAGE_IN_USE']);
  assert.deepEqual(fake.mutations, [], 'neither the plan nor a refusal changes the account');
  assert.deepEqual(deletions(), []);
  assert.equal(fake.account.images.length, 1);
});

test('once every Work that held it had its environment removed, the image leaves ONLY by the confirmed cleanup, with its build artifact and build log', async t => {
  const { fake, prepare, remove, cleanup, deletions } = await installation(t);
  const one = await prepare(first, 'a'), two = await prepare(second, 'a');
  assert.equal(fake.account.images.length, 1, 'both Works share the image of the key');
  const name = fake.account.images[0]!.name;
  await remove(first, one);
  // One of the two Works is still open with the key.
  assert.deepEqual((await cleanup({ image: name, confirm: true })).code, 'IMAGE_IN_USE');
  await remove(second, two);
  // Removing the last environment does not delete the image: only the explicit command does, and its plan deletes nothing.
  assert.equal(fake.account.images.length, 1);
  const planned = await cleanup();
  assert.deepEqual([planned.status, planned.images.map(image => [image.decision, image.works, image.outcome])], ['planned', [['removable', [], undefined]]]);
  assert.deepEqual(deletions(), []);
  const cleaned = await cleanup({ confirm: true });
  assert.deepEqual([cleaned.status, cleaned.images.map(image => [image.imageName, image.outcome])], ['cleaned', [[name, 'removed']]]);
  assert.deepEqual(deletions(), ['deleteImageVersion', 'deleteImage', 'deleteBuildArtifact', 'deleteBuildLog']);
  assert.deepEqual([fake.account.images, Object.values(fake.account.objects).flatMap(bucket => Object.keys(bucket)), Object.keys(fake.account.logs)], [[], [], []]);
});

test('the cleanup leaves the build ledger alone: the builds per environment key are still reported after the image is gone (ticket 14)', async t => {
  const { root, sandbox, prepare, remove, cleanup } = await installation(t);
  await remove(first, await prepare(first, 'a'));
  const ledger = join(root, 'lambda', 'image-builds.jsonl');
  const before = [await readFile(ledger, 'utf8'), await sandbox.environmentBuilds()];
  assert.ok((before[0] as string).includes('"requested"'), 'the Prepare recorded its build');
  assert.deepEqual((await cleanup({ confirm: true })).images.map(image => image.outcome), ['removed']);
  assert.deepEqual([await readFile(ledger, 'utf8'), await sandbox.environmentBuilds()], before);
});

test('an image a MicroVM still runs from, or that is still being built, is in use whatever the host records say', async t => {
  const { root, fake, sandbox, prepare, cleanup } = await installation(t);
  const environment = await prepare(first, 'a');
  assert.equal((await sandbox.start({ environment, configuration, checkout })).status, 'success');
  // The host's image record vanishes (a restored installation root): the account still shows a MicroVM of that image.
  await rm(join(root, 'lambda', 'works', environment, 'image.json'));
  const name = fake.account.images[0]!.name;
  const planned = await cleanup();
  assert.deepEqual(planned.images.map(image => [image.decision, image.works, image.running]), [['in-use', [], 1]]);
  assert.equal((await cleanup({ image: name, confirm: true })).code, 'IMAGE_IN_USE');
  // A build in flight belongs to a Prepare that has not recorded its Work yet.
  const building = fake.service({ awsProfile: 'factory', region: 'us-east-1' });
  const other = `factory-acme-${'e'.repeat(32)}`;
  const source = fake.account.images[0]!.request!;
  assert.equal((await building.createImage({ ...source, name: other })).ok, true);
  assert.deepEqual((await cleanup()).images.map(image => [image.imageName, image.state, image.decision]), [[name, 'CREATED', 'in-use'], [other, 'CREATING', 'in-use']]);
});

test('images of another installation are never listed for cleanup nor deleted, and an unreadable account plans nothing', async t => {
  const { fake, prepare, remove, cleanup } = await installation(t);
  await remove(first, await prepare(first, 'a'));
  const other = fake.plantOtherInstallation('acme-2');
  fake.account.terminateSeconds = 0;
  const planned = await cleanup();
  assert.equal(planned.images.some(image => image.imageArn === other.imageArn), false);
  fake.account.denied.push('lambda:ListMicrovms');
  assert.deepEqual([(await cleanup({ confirm: true })).status, fake.account.images.length], ['unavailable', 2]);
  fake.account.denied.length = 0;
  assert.equal((await cleanup({ confirm: true })).status, 'cleaned');
  assert.deepEqual(fake.account.images.map(image => image.imageArn), [other.imageArn]);
  assert.deepEqual(await cleanup({ image: 'factory-acme-2-' + '9'.repeat(32), confirm: true }).then(result => [result.status, result.code]), ['refused', 'IMAGE_NOT_FOUND']);
});

// Pure rule.
const arn = (name: string) => `arn:aws:lambda:us-east-1:123456789012:microvm-image:${name}`;
const image = (letter: string, change: object = {}) => ({ name: `factory-acme-${letter.repeat(32)}`, imageArn: arn(`factory-acme-${letter.repeat(32)}`), state: 'CREATED', tags: { [installationTagKey]: 'acme' } as Record<string, string> | null, ...change });
test('rule: in use = held by a Work environment, run by a MicroVM that has not ended, or still building; a name alone never makes an image ours', () => {
  const planned = planImageCleanup({ installation: 'acme', images: [image('a'), image('b'), image('c', { state: 'CREATING' }), image('d'), image('e', { state: 'CREATE_FAILED' }),
    image('f', { tags: { [installationTagKey]: 'someone-else' } }), image('0', { tags: null }), { ...image('a'), name: 'factory-acme-2-' + 'a'.repeat(32), imageArn: arn('factory-acme-2-' + 'a'.repeat(32)) }],
  works: [{ workId: 'work-1', imageArn: arn('factory-acme-' + 'a'.repeat(32)) }, { workId: 'work-2', imageArn: arn('factory-acme-' + 'a'.repeat(32)) }],
  microvms: [{ microvmId: 'm-1', state: 'RUNNING', imageArn: arn('factory-acme-' + 'b'.repeat(32)) }, { microvmId: 'm-2', state: 'TERMINATED', imageArn: arn('factory-acme-' + 'd'.repeat(32)) }] });
  assert.deepEqual(planned.map(item => [item.imageName.slice(13, 14), item.decision, item.works, item.running]), [
    ['0', 'unverifiable', [], 0], ['a', 'in-use', ['work-1', 'work-2'], 0], ['b', 'in-use', [], 1], ['c', 'in-use', [], 0], ['d', 'removable', [], 0], ['e', 'removable', [], 0]]);
});
