import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ended } from '../runner/budget.js';

test('normal Host -> same qualified owner -> new Node24 native Bash copy/Read; fresh Builder denied, reviewers explicitly selected only', async () => {
  const root = await mkdtemp('/tmp/p149-');
  try {
    const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
    const child = spawn(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url)),
        fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
        root,
        environment,
        'boot-66666666-2222-4333-8444-555555555555',
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '',
          NODE_DISABLE_COMPILE_CACHE: '1',
          ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker',
          TASK83_NATIVE_BUILDER: '1',
          TASK85_NATIVE_BASH: '1',
          TASK145_COPY: 'ok',
          TASK149_READ: '1',
        },
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', data => {
      stdout += data;
    });
    child.stderr.on('data', data => {
      stderr += data;
    });
    // No fixed timeout: the adapter's own exit, bounded only by the runner budget (tree killed, last audit stage named).
    const { code } = await ended(child, () => {
      try {
        return readFileSync(join(root, 'audit'), 'utf8').trim().split('\n').slice(-3).join(' | ');
      } catch {
        return 'no audit yet';
      }
    });
    assert.ok(stdout.length <= 32768 && stderr.length <= 32768, 'the chain stays quiet (the former spawnSync maxBuffer bound, per stream)');
    const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
    assert.equal(code, 0, stderr + '\n' + audit.join('\n'));
    assert.equal(audit.filter(l => l === 'vm-create').length, 1);
    assert.equal(audit.filter(l => l === 'worker-spawn').length, 5);
    assert.equal(audit.filter(l => l.startsWith('worker-message:{"kind":"provider-attempt"')).length, 12);
    assert.equal(audit.filter(l => l.startsWith('worker-message:{"kind":"provider-validated"')).length, 12);
    assert.equal(audit.filter(l => l === 'copy-output').length, 1);
    assert.equal(audit.filter(l => l === 'read-attempt').length, 3);
    assert.equal(audit.filter(l => l === 'read-validated').length, 3);
    assert.ok(!audit.some(l => l.startsWith('write-')));
    assert.ok(audit.includes('normal-copy-read-passed'));
    const bytes = await readFile(join(root, 'copy-double-bytes'));
    assert.ok(bytes.length > 1000000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
