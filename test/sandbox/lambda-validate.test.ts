import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from './lambda-service-fake.js';

// v2 ticket 02 (V2-02 Validar, V2-30, V2-31): `validate` of a Lambda installation against the in-memory account. No AWS, no MicroVM.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };

async function validate(t: { after(fn: () => unknown): void }, fake: ReturnType<typeof lambdaAccountFake>, extra: Record<string, unknown> = {}, concurrency = 1) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-validate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await createSandbox({ root, lambdaService: fake.service }).validate({ ...configuration, ...extra }, { concurrency });
  assert.deepEqual(await readdir(root), [], 'validate writes nothing under the installation (no credential, no cache)');
  const check = (id: string) => report.checks.find(item => item.id === id);
  return { report, check, blocked: report.checks.filter(item => item.status === 'blocked').map(item => item.id) };
}

test('a correctly installed account validates: identity, operation role, region, permissions, resources and quota, without starting a MicroVM', async t => {
  const fake = lambdaAccountFake();
  const { report, check, blocked } = await validate(t, fake);
  assert.equal(report.configuration.valid, true);
  for (const id of ['lambda-aws-profile', 'lambda-identity', 'lambda-operation-role', 'lambda-region', 'lambda-permissions', 'lambda-build-role',
    'lambda-artifact-bucket', 'lambda-quota', 'lambda-boot-duration']) assert.equal(check(id)?.status, 'ok', id);
  assert.match(check('lambda-identity')!.message, /123456789012/);
  // v2 ticket 06: the adapter is composed into the controller; a correctly installed account has no blocked check.
  assert.deepEqual(blocked, []);
  assert.deepEqual(fake.mutations, [], 'nothing was created, started or tagged');
  assert.deepEqual([...new Set(fake.calls.map(call => call.operation))].sort(),
    ['allocatedMemoryQuota', 'bucketRegion', 'callerIdentity', 'listImages', 'role', 'simulatePermissions']);
  assert.ok(fake.calls.every(call => call.awsProfile === 'factory' && call.region === 'us-east-1'));
  // No Gondolin host diagnostics for a Lambda installation.
  assert.equal(check('kvm-access'), undefined);
  assert.equal(check('lambda-runtime')?.status, 'unverified');
});

test('a missing AWS profile, a profile without identity and a missing aws CLI are three causes; the account is then declared not checked', async t => {
  const missing = lambdaAccountFake();
  delete missing.account.profiles.factory;
  const absent = await validate(t, missing);
  assert.deepEqual(absent.blocked, ['lambda-aws-profile']);
  assert.match(absent.check('lambda-aws-profile')!.message, /factory/);
  assert.equal(absent.check('lambda-account')?.status, 'unverified');
  assert.deepEqual(missing.calls.map(call => call.operation), ['callerIdentity'], 'nothing else is asked of an account without identity');

  const expired = lambdaAccountFake();
  expired.account.profiles.factory = { expired: true };
  const anonymous = await validate(t, expired);
  assert.deepEqual(anonymous.blocked, ['lambda-identity']);
  assert.equal(anonymous.check('lambda-aws-profile')?.status, 'ok');

  const bare = lambdaAccountFake();
  bare.account.cli = false;
  assert.deepEqual((await validate(t, bare)).blocked, ['lambda-aws-cli']);
});

test('a profile that is not the installation operation role is diagnosed and its permissions are not presumed', async t => {
  const fake = lambdaAccountFake();
  fake.account.profiles.factory = { arn: 'arn:aws:iam::123456789012:user/admin' };
  const { check, blocked } = await validate(t, fake);
  assert.deepEqual(blocked, ['lambda-operation-role']);
  assert.match(check('lambda-operation-role')!.message, /factory-acme-operation/);
  assert.equal(check('lambda-permissions')?.status, 'unverified');
  assert.equal(fake.calls.some(call => call.operation === 'simulatePermissions'), false);
});

test('the wrong region is its own cause: the service does not answer there, or the build bucket lives elsewhere', async t => {
  const elsewhere = lambdaAccountFake({ region: 'eu-west-1' });
  elsewhere.account.regions = ['us-east-1'];
  const unavailable = await validate(t, elsewhere, { region: 'eu-west-1' });
  assert.deepEqual(unavailable.blocked, ['lambda-region']);
  assert.match(unavailable.check('lambda-region')!.message, /eu-west-1/);

  const moved = lambdaAccountFake();
  moved.account.buckets[moved.resources.artifactBucket] = 'us-west-2';
  const mismatch = await validate(t, moved);
  assert.deepEqual(mismatch.blocked, ['lambda-region']);
  assert.match(mismatch.check('lambda-region')!.message, /us-west-2/);
  assert.equal(mismatch.check('lambda-artifact-bucket')?.status, 'ok', 'the bucket exists; its region is the problem');
});

test('each missing permission is diagnosed naming the action', async t => {
  const fake = lambdaAccountFake();
  fake.account.denied = ['lambda:RunMicrovm', 'lambda:TagResource', 's3:PutObject'];
  const { check, blocked } = await validate(t, fake);
  assert.deepEqual(blocked, ['lambda-permission:lambda:TagResource', 'lambda-permission:lambda:RunMicrovm', 'lambda-permission:s3:PutObject']);
  assert.match(check('lambda-permission:lambda:RunMicrovm')!.message, /lambda:RunMicrovm/);
  assert.equal(check('lambda-permissions'), undefined);
  // The installation tag is part of the simulated request: TagResource is only allowed with it.
  const tagging = fake.calls.find(call => call.operation === 'simulatePermissions' && (call.input as { actions: string[] }).actions.includes('lambda:TagResource'));
  assert.deepEqual((tagging!.input as { context: unknown }).context, [{ key: 'aws:RequestTag/software-factory-installation', value: 'acme' }]);
  assert.equal((tagging!.input as { principalArn: string }).principalArn, 'arn:aws:iam::123456789012:role/factory-acme-operation');

  // A permission needed by validate's own reads is named the same way, and what it could not read is declared unverified.
  const blind = lambdaAccountFake();
  blind.account.denied = ['iam:SimulatePrincipalPolicy', 'iam:GetRole'];
  const unread = await validate(t, blind);
  assert.deepEqual(unread.blocked, ['lambda-permission:iam:GetRole', 'lambda-permission:iam:SimulatePrincipalPolicy']);
  assert.equal(unread.check('lambda-build-role')?.status, 'unverified');
  assert.equal(unread.check('lambda-permissions')?.status, 'unverified');
});

test('a missing installation resource is diagnosed by name: build role, build bucket', async t => {
  const noRole = lambdaAccountFake();
  noRole.account.roles = noRole.account.roles.filter(name => name !== noRole.resources.buildRole);
  const role = await validate(t, noRole);
  assert.deepEqual(role.blocked, ['lambda-build-role']);
  assert.match(role.check('lambda-build-role')!.message, /factory-acme-build/);
  assert.match(role.check('lambda-build-role')!.nextStep, /template/);

  const noBucket = lambdaAccountFake();
  noBucket.account.buckets = {};
  const bucket = await validate(t, noBucket);
  assert.deepEqual(bucket.blocked, ['lambda-artifact-bucket']);
  assert.match(bucket.check('lambda-artifact-bucket')!.message, /factory-acme-build-123456789012-us-east-1/);
});

test('Builder concurrency x boot size above the account memory quota is diagnosed, never adjusted', async t => {
  // Observed account: 8 GB of allocated memory = two MicroVMs of the acceptance profile (4 GB peak each).
  const fits = await validate(t, lambdaAccountFake(), {}, 2);
  assert.equal(fits.check('lambda-quota')?.status, 'ok');
  const over = await validate(t, lambdaAccountFake(), {}, 3);
  assert.deepEqual(over.blocked, ['lambda-quota']);
  assert.match(over.check('lambda-quota')!.message, /3 .*4096 MiB.*12288 MiB.*8192 MiB/);
  assert.match(over.check('lambda-quota')!.nextStep, /concurrency/);
  assert.equal(over.report.configuration.valid, true, 'the configuration is reported, not rewritten');
  // A bigger profile reaches the quota sooner.
  assert.deepEqual((await validate(t, lambdaAccountFake(), { baselineMemoryMiB: 2048 }, 2)).blocked, ['lambda-quota']);
  // An unreadable quota is declared, never presumed sufficient.
  const unreadable = lambdaAccountFake();
  unreadable.account.memoryQuotaMiB = null;
  assert.equal((await validate(t, unreadable, {}, 2)).check('lambda-quota')?.status, 'unverified');
});

test('a boot duration above 3600 s and a profile outside the acceptance profile are accepted and marked as not proven', async t => {
  const long = await validate(t, lambdaAccountFake(), { maxBootSeconds: 7200 });
  assert.equal(long.report.configuration.valid, true);
  assert.equal(long.check('lambda-boot-duration')?.status, 'unverified');
  assert.match(long.check('lambda-boot-duration')!.message, /7200.*not proven/);
  assert.equal(long.check('lambda-acceptance-profile'), undefined);
  const x86 = await validate(t, lambdaAccountFake(), { architecture: 'x86_64' });
  assert.equal(x86.check('lambda-acceptance-profile')?.status, 'unverified');
});

test('an invalid Lambda profile is a configuration error and the account is never contacted', async t => {
  const fake = lambdaAccountFake();
  const { report } = await validate(t, fake, { awsProfile: 'AKIAIOSFODNN7EXAMPLE' });
  assert.deepEqual(report.configuration, { valid: false, errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.awsProfile' }] });
  assert.deepEqual(fake.calls, []);
});
