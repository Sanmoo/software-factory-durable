import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBootMarkers } from '../../src/sandbox/boot-markers.js';

const boot = 'boot-66666666-2222-4333-8444-555555555555';

test('boot markers retain literal observations, never raw console or protocol payload', () => {
  const markers = createBootMarkers(boot);
  markers.observe('protocol', 'PRIVATE_TOKEN_CANARY');
  markers.observe('qemu', 'PRIVATE_TOKEN_CANARY');
  markers.observe('qemu', 'stdout: [    0.000000] Linux version PRIVATE_TOKEN_CANARY');
  markers.observe('qemu', 'stdout: [    0.100000] ACPI: PRIVATE_TOKEN_CANARY');
  markers.observe('qemu', 'stdout: [init] /dev entries:');
  markers.observe('qemu', 'stdout: [init] starting sandboxfs at /data');
  markers.observe('qemu', 'stdout: [init] starting sandboxd');
  assert.deepEqual(markers.seal().stages, ['console-text-observed', 'kernel-version-text', 'acpi-text',
    'root-init-text', 'sandboxfs-launch-text', 'pre-sandboxd-hook-text']);
  assert.equal(JSON.stringify(markers.seal()).includes('PRIVATE_TOKEN_CANARY'), false);
});

test('initramfs and panic observations do not manufacture root-mounted or SDK-ready proof', () => {
  const markers = createBootMarkers(boot);
  for (const line of ['[initramfs] virtio ports not ready', '[initramfs] root device /dev/vda not found',
    '[initramfs] failed to mount /dev/vda', 'Kernel panic - not syncing: PRIVATE_TOKEN_CANARY']) {
    markers.observe('qemu', `stdout: ${line}`);
  }
  assert.deepEqual(markers.seal().stages, ['console-text-observed', 'initramfs-ports-unready-text',
    'initramfs-root-device-missing-text', 'initramfs-root-mount-failed-text', 'kernel-panic-text']);
  assert.equal('operational' in markers.seal(), false);
});

test('own marker state is bounded under repeats and oversized/unstructured callbacks', () => {
  const markers = createBootMarkers(boot);
  for (let n = 0; n < 2000; n++) markers.observe('qemu', 'stdout: [init] /dev entries:');
  markers.observe('qemu', `stdout: ${'PRIVATE_TOKEN_CANARY'.repeat(1000)}`);
  markers.observe('qemu', 'stdout: [init] starting sandboxd\nPRIVATE_TOKEN_CANARY');
  const result = markers.seal();
  assert.equal(result.callbacks, 1024);
  assert.equal(result.oversized, 1);
  assert.deepEqual(result.stages, ['console-text-observed', 'root-init-text']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
});

test('seal freezes diagnostic collection before guest commands and returns defensive snapshots', () => {
  const markers = createBootMarkers(boot);
  markers.observe('qemu', 'stdout: [init] /dev entries:');
  const first = markers.seal();
  first.stages.length = 0;
  markers.observe('qemu', 'stdout: [init] starting sandboxd');
  assert.deepEqual(markers.seal().stages, ['console-text-observed', 'root-init-text']);
});

test('missing callbacks remain empty observations, not a diagnosis of no guest execution', () => {
  assert.deepEqual(createBootMarkers(boot).seal(), { version: 1, boot, stages: [], callbacks: 0, oversized: 0 });
});
