import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { planWorkerLaunch } from '../../src/platform/host/index.js';

const bootRef = 'boot-66666666-2222-4333-8444-555555555555';
const unit = `factory-sandbox-${bootRef}.service`;
const host = {
  workId: 'work',
  environmentRef: `env-${'a'.repeat(64)}`,
  bootRef,
  unit,
  invocation: 'b'.repeat(32),
  cgroup: `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`,
  cgroupNamespace: 'cgroup:[42]',
  mountNamespace: 'mnt:[43]',
  runtimeDirectory: '/private/r/boot',
};
const request = { workId: host.workId, environmentRef: host.environmentRef, bootRef, invocationId: 'review-1', role: 'standards' as const };

test('closed host launch plan inherits only the already correlated boot, fixed release entrypoint and explicit environment', () => {
  const plan = planWorkerLaunch(host, request);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.executable, process.execPath);
  assert.deepEqual(plan.argv, [fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url))]);
  assert.deepEqual(plan.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(plan.env, {
    PATH: '',
    LANG: 'C',
    LC_ALL: 'C',
    NODE_DISABLE_COMPILE_CACHE: '1',
    TMPDIR: '/private/r/boot/t',
    XDG_CACHE_HOME: '/private/r/boot/c',
  });
  assert.equal(plan.detached, false);
  assert.equal(plan.supervision.unit, unit);
  assert.equal(plan.supervision.invocation, 'b'.repeat(32));
  assert.equal(plan.binding.invocationId, 'review-1');
  assert.equal(planWorkerLaunch(host, { ...request, role: 'builder' }).binding.role, 'builder');
});

test('host launch planning refuses cross-boot/work/environment, unsupported roles and arbitrary launch fields', () => {
  for (const changed of [
    { bootRef: 'boot-77777777-2222-4333-8444-555555555555' },
    { workId: 'other' },
    { environmentRef: `env-${'c'.repeat(64)}` },
    { role: 'administrator' },
    { argv: ['--eval', 'bad'] },
    { env: { NODE_OPTIONS: 'bad' } },
  ]) {
    assert.throws(() => planWorkerLaunch(host, { ...request, ...changed }), /WORKER_LAUNCH_INVALID|WORKER_BOOT_MISMATCH/);
  }
  assert.throws(() => planWorkerLaunch({ ...host, unit: 'different.service' }, request), /WORKER_BOOT_MISMATCH/);
  assert.throws(() => planWorkerLaunch({ ...host, cgroup: '/unrelated' }, request), /WORKER_BOOT_MISMATCH/);
});
