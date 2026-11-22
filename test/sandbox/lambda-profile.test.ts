import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSandboxAdapter } from '../../src/sandbox/index.js';

// v2 ticket 02 (V2-29, V2-12, V2-31): the Lambda adapter's own profile, selected by `sandbox.adapter: lambda`. Pure; no AWS.
const minimal = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };

test('the Lambda adapter is selected with the acceptance profile as defaults', () => {
  const selection = selectSandboxAdapter(minimal);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') return;
  assert.equal(selection.adapter, 'lambda');
  assert.deepEqual(selection.configuration, {
    adapter: 'lambda',
    schemaVersion: 1,
    awsProfile: 'factory',
    installation: 'acme',
    region: 'us-east-1',
    architecture: 'arm64',
    baselineMemoryMiB: 1024,
    additionalOsCapabilities: ['ALL'],
    maxBootSeconds: 3600,
    rotationMarginSeconds: 600,
    observationIntervalSeconds: 30,
  });
  // The effective profile is itself a valid selection input (the controller composes with it).
  assert.deepEqual(selectSandboxAdapter(selection.configuration), selection);
});

test('the Lambda adapter declares Docker, no disk that survives the boot, its boot duration and margin, and unmediated public TCP egress', () => {
  const selection = selectSandboxAdapter({ ...minimal, maxBootSeconds: 1800, rotationMarginSeconds: 300 });
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') return;
  assert.deepEqual(selection.capabilities, {
    docker: true,
    persistentDisk: false,
    bootDuration: { maxSeconds: 1800, rotationMarginSeconds: 300 },
    egress: { mediation: 'none', publicTcp: true, udp: false, ipv6: false, privateNetwork: false },
    channelRecovery: true,
    environmentWatch: true,
  });
  // V2-29: what Control receives (the capabilities) carries no region, size, architecture, account or AWS profile.
  assert.doesNotMatch(JSON.stringify(selection.capabilities), /us-east-1|arm64|1024|factory|acme/);
});

test('a boot duration above 3600 s is accepted; the service maximum, a margin that leaves no boot and unknown keys are refused', () => {
  const long = selectSandboxAdapter({ ...minimal, maxBootSeconds: 7200 });
  assert.equal(long.status, 'selected');
  const refused = (extra: Record<string, unknown>, path: string) =>
    assert.deepEqual(
      selectSandboxAdapter({ ...minimal, ...extra }),
      { status: 'refused', adapter: 'lambda', errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path }] },
      JSON.stringify(extra),
    );
  refused({ maxBootSeconds: 28801 }, 'sandbox.maxBootSeconds');
  refused({ maxBootSeconds: 0 }, 'sandbox.maxBootSeconds');
  refused({ rotationMarginSeconds: 3600 }, 'sandbox.rotationMarginSeconds');
  refused({ architecture: 'riscv' }, 'sandbox.architecture');
  refused({ region: 'US East' }, 'sandbox.region');
  refused({ installation: 'Not Valid' }, 'sandbox.installation');
  refused({ profile: 'gondolin-qemu-alpine-dev-v1' }, 'sandbox');
  refused({ memoryMiB: 2048 }, 'sandbox');
});

test('the AWS profile is a NAME: the profile and installation are required and credentials are never accepted in the configuration', () => {
  assert.deepEqual(selectSandboxAdapter({ adapter: 'lambda', schemaVersion: 1 }), {
    status: 'refused',
    adapter: 'lambda',
    errors: [
      { code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.awsProfile' },
      { code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.installation' },
    ],
  });
  for (const extra of [{ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }, { secretAccessKey: 'x' }, { sessionToken: 'x' }, { credentials: {} }]) {
    const selection = selectSandboxAdapter({ ...minimal, ...extra });
    assert.equal(selection.status, 'refused', JSON.stringify(extra));
  }
  for (const awsProfile of ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'has space', '', '--profile']) {
    assert.deepEqual(
      selectSandboxAdapter({ ...minimal, awsProfile }),
      { status: 'refused', adapter: 'lambda', errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.awsProfile' }] },
      awsProfile,
    );
  }
});
