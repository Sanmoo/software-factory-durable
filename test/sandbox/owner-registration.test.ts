import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remainingMs } from '../runner/budget.js';

test('root-only client recovers pre-owner discovery failure on same boot and preserves binding isolation', async () => {
  const root = await mkdtemp('/tmp/or-');
  try {
    const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import',
      fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
      fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), root, environment,
      'boot-66666666-2222-4333-8444-555555555555'],
    { timeout: remainingMs(), maxBuffer: 16384, encoding: 'utf8', env: { PATH: '', NODE_DISABLE_COMPILE_CACHE: '1',
      ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'owner-registration' } });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr + '\n' + await readFile(join(root, 'audit'), 'utf8'));
    assert.deepEqual((await readFile(join(root, 'audit'), 'utf8')).trim().split('\n'),
      ['discovery-unavailable', 'vm-create', 'profile-ready', 'worker-launch-closed', 'read', 'discovery-recovered',
        'read', 'read', 'registration-isolated', 'guest-finalize', 'close']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
