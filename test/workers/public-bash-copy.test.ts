import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ended } from '../runner/budget.js';

for (const mode of ['ok', 'fail', 'absent', 'false', 'invalid']) test(`public normal native Bash copy ${mode} via guarded SAME owner and fixed new Node24 child`, async () => {
  const root = await mkdtemp('/tmp/p145-');
  try {
    const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import',
      fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url)),
      fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), root, environment,
      'boot-66666666-2222-4333-8444-555555555555'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '', NODE_DISABLE_COMPILE_CACHE: '1',
        ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', TASK83_NATIVE_BUILDER: '1', TASK85_NATIVE_BASH: '1', TASK145_COPY: mode },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    // No fixed 15 s spawnSync timeout (expired once at ci load 18): the adapter's own exit, bounded by the runner budget.
    const { code } = await ended(child, () => { try { return readFileSync(join(root, 'audit'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return 'no audit yet'; } });
    assert.ok(stdout.length <= 32768 && stderr.length <= 32768, 'the chain stays quiet (the former spawnSync maxBuffer bound, per stream)');
    const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
    assert.equal(code, 0, stderr + '\n' + audit.join('\n'));
    const invalid = mode === 'invalid'; const enabled = mode === 'ok' || mode === 'fail';
    assert.equal(audit.filter(line => line === 'vm-create').length, 1);
    assert.equal(audit.filter(line => line === 'worker-spawn').length, invalid ? 0 : 1);
    const attempts = audit.filter(line => line.startsWith('worker-message:{"kind":"provider-attempt"'));
    assert.equal(attempts.length, invalid ? 0 : mode === 'fail' ? 1 : 2, 'all provider attempts counted before assertions');
    assert.equal(audit.filter(line => line.startsWith('worker-message:{"kind":"provider-validated"')).length, attempts.length,
      'SDK-swallowed fetch assertions cannot masquerade as success');
    assert.equal(audit.filter(line => line === 'bash').length, invalid ? 0 : 1);
    assert.equal(audit.filter(line => line === 'copy-output').length, enabled ? 1 : 0);
    if (enabled) assert.ok(audit.indexOf('copy-output') > audit.indexOf('bash-complete'));
    assert.ok(!audit.some(line => line.startsWith('write-')), 'no queued guest write after uncertainty');
    if (mode === 'ok') {
      const bytes = await readFile(join(root, 'copy-double-bytes'));
      assert.ok(bytes.length > 1000000);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(
        'head π █ █ █\n' + 'filtered output\n'.repeat(80000) + 'tail π').digest('hex'));
    }
    assert.ok(audit.includes('normal-bash-copy-passed')); assert.ok(audit.includes('close'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
