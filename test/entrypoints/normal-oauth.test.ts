import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const mode of ['success', 'held-ack', 'third-request', 'second-tool', 'http429', 'http500', 'mutable-error', 'rotation-ack-fail', 'provider-bytes', 'prompt-bytes', 'tool-args-overflow', 'tool-result-overflow', 'deadline', 'context-bytes', 'start-failure', 'prompt-secret', 'missing-store', 'abort']) {
  test(`OAuth public normal activation: ${mode}`, { timeout: 45000 }, async t => {
    const root = await mkdtemp('/tmp/no-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
    const child = fork(fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), [root, environment, `boot-${randomUUID()}`], {
      execArgv: ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url))],
      env: { ...process.env, ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', TASK178_OAUTH: mode, NODE_DISABLE_COMPILE_CACHE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = ''; child.stdout?.on('data', data => { output += data; }); child.stderr?.on('data', data => { output += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    const audit = await readFile(join(root, 'audit'), 'utf8');
    assert.equal(audit.split('\n').filter(x => x === 'worker-spawn').length, 1);
    const models = ['success', 'third-request'].includes(mode) ? 2 : ['held-ack', 'rotation-ack-fail', 'prompt-bytes', 'start-failure', 'prompt-secret', 'missing-store'].includes(mode) ? 0 : 1;
    assert.equal(audit.split('\n').filter(x => x.includes('"kind":"provider-request"')).length, models);
    const reads = ['success', 'third-request', 'second-tool', 'tool-result-overflow', 'context-bytes'].includes(mode) ? 1 : 0;
    assert.equal(audit.split('\n').filter(x => x === 'read').length, reads, 'native tool dispatch limit is before adapter');
    if (!['prompt-bytes', 'start-failure', 'prompt-secret', 'missing-store'].includes(mode)) assert.match(audit, /secret-registration-metadata/);
    assert.match(audit, /normal-oauth-passed/);
    assert.doesNotMatch(audit + output, /oauth-access-canary|oauth-refresh-canary|oauth-access-rotated|oauth-refresh-rotated|unknown-http-secret-body|unknown-start-secret/);
    const result = JSON.parse(await readFile(join(root, 'normal-worker-result.json'), 'utf8'));
    assert.notEqual(result.pid, child.pid);
    t.diagnostic(JSON.stringify({ mode, ...result.counts, adapterReads: reads }));
  });
}
