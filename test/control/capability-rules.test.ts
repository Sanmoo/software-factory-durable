import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SandboxCapabilities } from '../../src/contracts/index.js';
import { capabilityImpediment, missingCapabilities, requiredCapabilities, sandboxCapabilityImpediment } from '../../src/control/rules/capabilities.js';

// v2 ticket 01 (V2-03/V2-04), pure rules: what a repository's environment declaration requires of the sandbox and what a missing capability
// does to its Work. Test adapters only: Control never names a real one.
const digest = `sha256:${'a'.repeat(64)}`;
const withImages = { schemaVersion: 1 as const, apk: [], images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }] };
const withoutImages = { schemaVersion: 1 as const, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [] };
const full: SandboxCapabilities = {
  docker: true,
  persistentDisk: true,
  bootDuration: null,
  egress: { mediation: 'http', publicTcp: false, udp: false, ipv6: false, privateNetwork: false },
};
const noDocker: SandboxCapabilities = { ...full, docker: false };

test('a declaration with container images requires Docker; without images it requires nothing', () => {
  assert.deepEqual(requiredCapabilities(withImages), ['docker']);
  assert.deepEqual(requiredCapabilities(withoutImages), []);
});

test('only capabilities that are required AND not declared are missing; a sandbox composed without a declaration is not gated', () => {
  assert.deepEqual(missingCapabilities(withImages, noDocker), ['docker']);
  assert.deepEqual(missingCapabilities(withImages, full), []);
  assert.deepEqual(missingCapabilities(withoutImages, noDocker), []);
  assert.deepEqual(missingCapabilities(withImages, undefined), []);
  // Whether the disk survives a boot is not something a declaration requires: it changes how Control preserves work, not whether it starts.
  assert.deepEqual(missingCapabilities(withImages, { ...full, persistentDisk: false, bootDuration: { maxSeconds: 3600, rotationMarginSeconds: 600 } }), []);
});

test('the impediment names the missing capability, what requires it and that there is no fallback to another sandbox', () => {
  const impediment = capabilityImpediment(['docker'], { repository: 'owner/project' });
  assert.equal(impediment.code, sandboxCapabilityImpediment);
  assert.equal(impediment.code, 'SANDBOX_CAPABILITY_MISSING');
  assert.equal(impediment.scope, 'work');
  assert.match(impediment.nextStep, /\bdocker\b/);
  assert.match(impediment.nextStep, /owner\/project/);
  assert.match(impediment.nextStep, /\.factory\/environment\.yaml/);
  assert.match(impediment.nextStep, /images/);
  assert.match(impediment.nextStep, /no fallback to another sandbox/);
});
