import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workId = 'producer-ordering-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}`;
const boot = 'boot-66666666-2222-4333-8444-555555555555';

async function shortRoot() {
  // The runtime socket profile needs a short root. Locally, the configured test
  // directory's parent is the already-authorized /home/.../software-factory-test.
  const base = process.env.FACTORY_SANDBOX_TEST_ROOT ? dirname(process.env.FACTORY_SANDBOX_TEST_ROOT) : tmpdir();
  for (let attempt = 0; attempt < 10; attempt++) {
    const root = join(base, randomBytes(1).toString('hex'));
    try { await mkdir(root, { mode: 0o700 }); return root; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  throw new Error('NO_NEW_SHORT_TEST_DIRECTORY_AVAILABLE');
}

for (const mode of ['slow-write', 'write-fails', 'unknown-error', 'without-stop'] as const) {
  test(`Sandbox adapter entrypoint orders diagnostic attempt before owned close: ${mode} (external doubles, no VM/signal)`, async () => {
    const root = await shortRoot();
    try {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import',
        fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
        fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), root, environment, boot],
      { timeout: 5000, maxBuffer: 16384, encoding: 'utf8', env: {
        PATH: '', NODE_DISABLE_COMPILE_CACHE: '1', ADAPTER_DIAGNOSTIC_FIXTURE_MODE: mode,
      } });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 1, child.stderr);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_CODE_CANARY'), false);
      const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
      assert.deepEqual(audit, mode === 'write-fails'
        ? ['failure-begin', 'failure-failed', 'close']
        : ['failure-begin', 'failure-written', 'failure-file-synced', 'failure-durable', 'close']);
      const diagnostic = await readFile(join(root, 'environments', environment, boot, 'failure.json'), 'utf8');
      assert.equal(diagnostic.includes('PRIVATE_TOKEN_CANARY'), false);
      assert.equal(diagnostic.includes('PRIVATE_CODE_CANARY'), false);
      if (mode !== 'write-fails') assert.deepEqual(JSON.parse(diagnostic), {
        version: 1, boot, phase: 'vm-start',
        code: mode === 'unknown-error' ? 'UNCLASSIFIED_STARTUP_FAILURE' : 'GUEST_READINESS_TIMEOUT',
      });
      else assert.equal(diagnostic, '');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ['markers-slow-write', 'markers-write-fails', 'markers-success'] as const) {
  test(`Sandbox adapter publishes bounded markers before close/guest exec: ${mode} (no VM/signal)`, async () => {
    const root = await shortRoot();
    try {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import',
        fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
        fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), root, environment, boot],
      { timeout: 5000, maxBuffer: 16384, encoding: 'utf8', env: {
        PATH: '', NODE_DISABLE_COMPILE_CACHE: '1', ADAPTER_DIAGNOSTIC_FIXTURE_MODE: mode,
      } });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, mode === 'markers-success' ? 0 : 1, child.stderr);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
      const path = join(root, 'environments', environment, boot);
      for (const name of await readdir(path)) {
        assert.equal((await readFile(join(path, name), 'utf8')).includes('PRIVATE_TOKEN_CANARY'), false);
      }
      const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
      const publication = mode === 'markers-write-fails' ? ['markers-begin', 'markers-failed']
        : ['markers-begin', 'markers-written', 'markers-file-synced', 'markers-durable'];
      assert.deepEqual(audit, [...publication, ...(mode === 'markers-success' ? ['guest-exec']
        : ['failure-begin', 'failure-written', 'failure-file-synced', 'failure-durable']), 'close']);
      const content = await readFile(join(path, 'boot-markers.json'), 'utf8');
      if (mode === 'markers-write-fails') assert.equal(content, '');
      else assert.deepEqual(JSON.parse(content), { version: 1, boot,
        stages: ['console-text-observed', 'kernel-version-text', 'root-init-text'], callbacks: 2, oversized: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
