import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../../src/entrypoints/doctor.js';
import { lambdaAccountFake } from '../sandbox/lambda-service-fake.js';

// v2 ticket 02: `factory doctor` of a Lambda installation, composed in-process over the in-memory account (the CLI itself would run `aws`).
const configuration = (sandbox: string, concurrency = 1) => `schemaVersion: 1
operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: ${sandbox}
concurrency: ${concurrency}
repositories:
  - repository: owner/project
    base: main
    installationId: 456
    workflows: false
`;
async function diagnose(t: { after(fn: () => unknown): void }, yaml: string, fake = lambdaAccountFake()) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.yaml'), yaml, { mode: 0o600 });
  const report = await doctor(root, { lambdaService: fake.service });
  assert.deepEqual(await readdir(root), ['config.yaml'], 'doctor writes nothing: no AWS credential or cache enters the installation');
  return { report, fake, check: (id: string) => report.checks.find(item => item.id === id) };
}

test('doctor accepts a Lambda installation, shows its effective profile and diagnoses the account instead of this host\'s virtualization', async t => {
  const { report, check, fake } = await diagnose(t, configuration('{adapter: lambda, schemaVersion: 1, awsProfile: factory, installation: acme}', 2));
  assert.equal(report.configuration.valid, true);
  if (!report.configuration.valid) return;
  assert.deepEqual(report.configuration.effective.sandbox, { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme', region: 'us-east-1',
    architecture: 'arm64', baselineMemoryMiB: 1024, additionalOsCapabilities: ['ALL'], maxBootSeconds: 3600, rotationMarginSeconds: 600, observationIntervalSeconds: 30 });
  for (const id of ['lambda-identity', 'lambda-region', 'lambda-permissions', 'lambda-build-role', 'lambda-artifact-bucket', 'lambda-quota']) assert.equal(check(id)?.status, 'ok', id);
  for (const id of ['kvm-access', 'qemu-system-x86_64', 'capacity', 'environment-identity']) assert.equal(check(id), undefined, id);
  assert.deepEqual(fake.mutations, []);
});

test('doctor diagnoses the configured Builder concurrency against the account quota, a missing permission and a missing resource', async t => {
  const fake = lambdaAccountFake();
  fake.account.denied = ['lambda:CreateMicrovmAuthToken'];
  fake.account.buckets = {};
  const { report, check } = await diagnose(t, configuration('{adapter: lambda, schemaVersion: 1, awsProfile: factory, installation: acme}', 3), fake);
  assert.equal(report.code, 'PREREQUISITES_MISSING');
  assert.equal(check('lambda-quota')?.status, 'blocked');
  assert.equal(check('lambda-permission:lambda:CreateMicrovmAuthToken')?.status, 'blocked');
  assert.equal(check('lambda-artifact-bucket')?.status, 'blocked');
  assert.equal(report.configuration.valid && report.configuration.effective.concurrency, 3, 'concurrency is never adjusted');
});
