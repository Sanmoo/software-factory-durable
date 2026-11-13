import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('public normal activation -> existing boot owner -> fixed new child -> protected start -> filtered native session', { timeout: 15000 }, async t => {
  const root = await mkdtemp('/tmp/nw-');
  t.after(async () => { try { t.diagnostic(await readFile(join(root, 'audit'), 'utf8')); } catch { /* startup may fail */ } await rm(root, { recursive: true, force: true }); });
  const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), [root, environment, `boot-${randomUUID()}`], {
    execArgv: ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url))],
    env: { ...process.env, ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', NODE_DISABLE_COMPILE_CACHE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = ''; child.stdout?.on('data', data => { output += data; }); child.stderr?.on('data', data => { output += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
  assert.equal(audit.filter(event => event === 'worker-spawn').length, 2);
  assert.equal(audit.filter(event => event.includes('"kind":"provider-request"')).length, 2);
  assert.equal(audit.filter(event => event.includes('"kind":"worker-started"')).length, 1);
  assert.equal(audit.filter(event => event.includes('"kind":"worker-error"')).length, 1);
  assert.equal(audit.filter(event => event === 'read').length, 1);
  assert.ok(audit.indexOf('normal-worker-passed') < audit.indexOf('close'));
  const result = JSON.parse(await readFile(join(root, 'normal-worker-result.json'), 'utf8'));
  assert.notEqual(result.pid, child.pid);
  assert.doesNotMatch(output, /synthetic-secret|synthetic-key/);
});
