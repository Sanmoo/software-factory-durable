import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type BootRef, type EnvironmentRef } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';

// v2 ticket 14 (V2-32): what each boot and each image build consumed, as the Lambda adapter reports it in adapter-neutral terms. The
// instants are the service's own (GetMicrovm) on the account's fake clock; no AWS call, no ssh, no socket.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: sha('d'), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [{ name: 'maven', version: '3.9.11-r0' }], images: [] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const token = 'ghs_builderTokenOfThisExecution';
const checkout = { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1', credential: { token } };

async function installation(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guest = lambdaGuestFake(fake);
  guest.world.origins[remote] = { commits: [startingCommit], token };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaTransport: guest.transport, lambdaBootClock: clock,
    lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepare = (work = workId, environment = pinned) => sandbox.prepare({ workId: work, configuration, environment });
  const prepared = await prepare();
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const start = async (reason?: 'start' | 'planned-swap') => {
    const result = await sandbox.start({ environment, configuration, checkout, ...(reason ? { reason } : {}) });
    assert.equal(result.status, 'success', JSON.stringify(result));
    return (result as { boot: BootRef }).boot;
  };
  const usage = async () => {
    const report = await sandbox.usage({ environment });
    assert.equal(report.status, 'reported', JSON.stringify(report));
    return report as Extract<typeof report, { status: 'reported' }>;
  };
  return { root, fake, sandbox, environment, prepare, start, usage, microvm: (index = -1) => fake.account.microvms.at(index)! };
}

test('each boot is reported with identity, reasons, size, start, end and seconds, the instants being the ones the service gave', async t => {
  const { fake, sandbox, environment, start, usage, microvm } = await installation(t);
  const first = await start();
  fake.account.clock.now += 600_000;
  await sandbox.stop({ environment, boot: first, reason: 'planned-swap' });
  const firstVm = microvm();
  const second = await start('planned-swap');
  fake.account.clock.now += 90_000;
  await sandbox.stop({ environment, boot: second, reason: 'end' });
  const secondVm = microvm();
  const report = await usage();
  assert.equal(report.unit, 'microvm-seconds');
  assert.deepEqual(report.boots.map(boot => [boot.boot, boot.begin, boot.end, boot.state]),
    [[first, 'start', 'planned-swap', 'measured'], [second, 'planned-swap', 'end', 'measured']]);
  const [one, two] = report.boots;
  assert.equal(one!.size, '4096 MiB / 2 vCPU (baseline 1024 MiB)');
  assert.equal(one!.startedAt, new Date(firstVm.startedAt).toISOString());
  assert.equal(one!.endedAt, new Date(firstVm.terminatedAt!).toISOString());
  // The seconds are the service's end minus the service's start, not what the host clock saw around its own calls.
  assert.equal(one!.seconds, (firstVm.terminatedAt! - firstVm.startedAt) / 1000);
  assert.equal(two!.seconds, (secondVm.terminatedAt! - secondVm.startedAt) / 1000);
  assert.ok(one!.seconds! >= 600 && two!.seconds! >= 90 && two!.seconds! < 600);
  // The same seconds are part of the boot's own record.
  assert.equal((await sandbox.bootRecord({ environment, boot: first }))?.end?.seconds, one!.seconds);
});

test('a boot whose end the service never confirmed is reported with unknown seconds, never zero, until the service is read again', async t => {
  const { fake, sandbox, environment, start, usage, microvm } = await installation(t);
  const boot = await start();
  fake.account.clock.now += 300_000;
  fake.account.terminateSeconds = null;
  assert.equal((await sandbox.stop({ environment, boot, reason: 'end' })).status, 'indeterminate');
  const pending = (await usage()).boots[0]!;
  assert.deepEqual([pending.state, pending.seconds, pending.endedAt, pending.end], ['unknown', null, null, 'end']);
  assert.equal(pending.startedAt, new Date(microvm().startedAt).toISOString());
  // Once the service reports the end, the same boot becomes measured with the service's instants.
  microvm().terminatesAt = fake.account.clock.now;
  assert.equal((await sandbox.stop({ environment, boot, reason: 'end' })).status, 'success');
  const settled = (await usage()).boots[0]!;
  assert.deepEqual([settled.state, settled.seconds], ['measured', (microvm().terminatedAt! - microvm().startedAt) / 1000]);
});

test('a boot still running has no seconds yet, a lost boot is measured up to its death, and a refused start ran nothing', async t => {
  const { fake, sandbox, environment, start, usage, microvm } = await installation(t);
  const lost = await start();
  assert.deepEqual((await usage()).boots.map(boot => [boot.state, boot.seconds, boot.end]), [['running', null, null]]);
  fake.account.clock.now += 120_000;
  fake.kill(microvm().microvmId);
  assert.equal((await sandbox.observe({ environment, boot: lost })).condition, 'stopped');
  fake.account.runRefusal = { kind: 'capacity', detail: 'ServiceQuotaExceededException' };
  const refused = await sandbox.start({ environment, configuration, checkout });
  assert.deepEqual([refused.status, refused.status !== 'success' && refused.code], ['failure', 'SERVICE_CAPACITY_REFUSED']);
  const boots = (await usage()).boots;
  assert.deepEqual(boots.map(boot => [boot.state, boot.end, boot.code ?? null]), [['measured', 'loss', null], ['not-run', 'end', 'SERVICE_CAPACITY_REFUSED']]);
  assert.equal(boots[0]!.seconds, (microvm().terminatedAt! - microvm().startedAt) / 1000);
  assert.deepEqual([boots[1]!.seconds, boots[1]!.startedAt, boots[1]!.endedAt], [0, null, null]);
});

test('a start whose RunMicrovm answer was unreadable is reported as unknown: a MicroVM may be running', async t => {
  const { fake, sandbox, environment, usage } = await installation(t);
  fake.account.runRefusal = { kind: 'unknown', detail: 'Unreadable answer' };
  assert.equal((await sandbox.start({ environment, configuration, checkout })).status, 'indeterminate');
  assert.deepEqual((await usage()).boots.map(boot => [boot.state, boot.seconds]), [['unknown', null]]);
});

test('an environment that is not of this adapter, or does not exist, reports no boot usage instead of an empty one', async t => {
  const { sandbox } = await installation(t);
  assert.deepEqual(await sandbox.usage({ environment: `env-${sha('9')}` as EnvironmentRef }), { status: 'unavailable', code: 'BOOT_USAGE_NOT_MEASURED' });
});

test('image builds are recorded per environment key: one build serves every Work with the key, another declaration is another build', async t => {
  const { fake, sandbox, prepare } = await installation(t);
  const firstBuilt = fake.account.clock.now;
  // Preparing the same Work again, and another Work with the same declaration, reuses the image: no new build.
  assert.equal((await prepare()).status, 'success');
  const other = await prepare('7c0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a02');
  assert.equal(other.status, 'success');
  const changed = await prepare('8d0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a03', { ...pinned, sha256: sha('e'), declaration: { ...pinned.declaration, apk: [{ name: 'maven', version: '3.9.12-r0' }] } });
  assert.equal(changed.status, 'success', JSON.stringify(changed));
  const report = await sandbox.environmentBuilds();
  assert.ok(report.status === 'reported');
  const key = (result: typeof other) => (result as { base: { base: string } }).base.base;
  assert.deepEqual(report.keys.map(entry => [entry.key, entry.builds, entry.last.outcome, entry.works]), [[key(other), 1, 'created', 2], [key(changed), 1, 'created', 1]]);
  assert.equal(fake.account.images.length, 2);
  // The instants are the account's time around the build the installation helper already waited for (130 s in the fake).
  const requested = Date.parse(report.keys[0]!.last.requestedAt);
  assert.ok(requested >= Date.UTC(2026, 10, 21) && requested < firstBuilt, report.keys[0]!.last.requestedAt);
  assert.ok(Date.parse(report.keys[0]!.last.settledAt!) - requested >= 130_000);
});

test('a failed build is recorded as failed, and the Operator retry of the same key is a second build of that key', async t => {
  const { fake, sandbox } = await installation(t);
  const failing = { ...pinned, sha256: sha('f'), declaration: { ...pinned.declaration, apk: [{ name: 'maven', version: '0.0.0-r0' }] } };
  fake.account.buildFailure = [' > [2/5] RUN apk add maven=0.0.0-r0:\n', '0.1 ERROR: unable to select packages\n', '------\n'];
  const failed = await sandbox.prepare({ workId: '9e0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a04', configuration, environment: failing });
  assert.deepEqual([failed.status, failed.status !== 'success' && failed.code], ['failure', 'ENVIRONMENT_BASE_PREPARATION_FAILED']);
  const after = await sandbox.environmentBuilds();
  assert.ok(after.status === 'reported');
  assert.deepEqual(after.keys.map(entry => [entry.builds, entry.last.outcome]), [[1, 'created'], [1, 'failed']]);
  fake.account.buildFailure = null;
  const retried = await sandbox.prepare({ workId: '9e0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a04', configuration, environment: failing, retryEnvironmentBase: true });
  assert.equal(retried.status, 'success', JSON.stringify(retried));
  const final = await sandbox.environmentBuilds();
  assert.ok(final.status === 'reported');
  assert.deepEqual(final.keys.map(entry => [entry.builds, entry.last.outcome]), [[1, 'created'], [2, 'created']]);
});
