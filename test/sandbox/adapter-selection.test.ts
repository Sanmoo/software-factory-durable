import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, selectSandboxAdapter } from '../../src/sandbox/index.js';

// v2 ticket 01 (V2-01, V2-03): the installation configuration selects ONE sandbox adapter and each adapter declares its capabilities.
// Pure selection and the public `validate`; no VM, no AWS, no manager.
const existing = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
const effective = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 };

test('an existing installation (Gondolin profile, no adapter key) selects Gondolin with an unchanged effective configuration', () => {
  const selection = selectSandboxAdapter(existing);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') return;
  assert.equal(selection.adapter, 'gondolin');
  assert.deepEqual(selection.configuration, effective, 'the identity of environments already prepared does not change');
});

test('naming the Gondolin adapter explicitly yields the same effective configuration (the adapter key is never part of its profile)', () => {
  const selection = selectSandboxAdapter({ adapter: 'gondolin', ...existing, memoryMiB: 4096 });
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') return;
  assert.deepEqual(selection.configuration, { ...effective, memoryMiB: 4096 });
  // The effective configuration is itself a valid selection input (the controller composes with it).
  assert.deepEqual(selectSandboxAdapter(selection.configuration), selection);
});

test('Gondolin declares Docker, a disk that survives the boot, no maximum boot duration and HTTP(S)-mediated egress', () => {
  const selection = selectSandboxAdapter(existing);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') return;
  assert.deepEqual(selection.capabilities, { docker: true, persistentDisk: true, bootDuration: null, egress: { mediation: 'http', publicTcp: false, udp: false, ipv6: false, privateNetwork: false } });
});

test('an unknown adapter or a list of adapters is invalid; each adapter refuses a profile that is not its own', () => {
  // v2 ticket 02: the Lambda adapter has its own profile (test/sandbox/lambda-profile.test.ts); a bare selection lacks its required names.
  assert.deepEqual(selectSandboxAdapter({ adapter: 'lambda', schemaVersion: 1 }), { status: 'refused', adapter: 'lambda', errors: [
    { code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.awsProfile' }, { code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.installation' }] });
  for (const adapter of ['firecracker', '', 7, null, ['gondolin', 'lambda'], { default: 'gondolin' }]) {
    assert.deepEqual(selectSandboxAdapter({ ...existing, adapter }), { status: 'refused', adapter: null,
      errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.adapter' }] }, JSON.stringify(adapter));
  }
  // A Gondolin profile that is invalid on its own keeps its MVP diagnostic.
  assert.deepEqual(selectSandboxAdapter({ ...existing, memoryMiB: 0 }), { status: 'refused', adapter: 'gondolin',
    errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.memoryMiB' }] });
  assert.deepEqual(selectSandboxAdapter(undefined), { status: 'refused', adapter: 'gondolin', errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox' }] });
});

test('the Gondolin lifecycle refuses a Lambda selection and never falls back to another adapter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-adapter-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = createSandbox({ root });
  // An invalid Lambda profile names no account: validate contacts nothing and says Works cannot run under the adapter in this release.
  const report = await sandbox.validate({ adapter: 'lambda', schemaVersion: 1 });
  assert.equal(report.configuration.valid, false);
  const check = report.checks.find(item => item.id === 'sandbox-adapter');
  assert.equal(check?.status, 'blocked');
  assert.match(check!.message, /lambda/);
  assert.match(check!.nextStep, /no fallback/i);
  // A VALID Lambda selection is never prepared or started under another adapter: Prepare is the Lambda adapter's own (v2 ticket 03; a Work
  // without a pinned declaration is refused before the account is contacted) and so is Start (v2 ticket 04: no MicroVM without a prepared image).
  const lambda = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
  const prepared = await sandbox.prepare({ workId: 'work-1', configuration: lambda });
  assert.deepEqual([prepared.status, 'code' in prepared && prepared.code], ['failure', 'ENVIRONMENT_NOT_PINNED']);
  assert.deepEqual(await sandbox.start({ environment: `env-${'0'.repeat(64)}` as never, configuration: lambda }), { status: 'failure', code: 'ENVIRONMENT_NOT_PREPARED' });
  assert.deepEqual(await sandbox.prepare({ workId: 'work-1', configuration: { adapter: 'lambda', schemaVersion: 1 } }), { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' });
  const accepted = await sandbox.validate({ adapter: 'gondolin', ...existing });
  assert.deepEqual(accepted.configuration, { valid: true, effective });
  assert.equal(accepted.checks.some(item => item.id === 'sandbox-adapter'), false, 'the Gondolin diagnostics are the MVP ones');
});
