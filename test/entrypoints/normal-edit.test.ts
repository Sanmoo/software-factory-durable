import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ended, killTree } from '../runner/budget.js';

for (const mode of ['complete', 'absent', 'invalid', 'standards', 'spec', 'uncertain', 'persist', 'mismatch', 'no-match', 'budget', 'cancel', 'eof', 'empty', 'secret']) {
  test(`normal public Host -> owner -> new Node native Edit: ${mode}`, async t => {
    const root = await mkdtemp('/tmp/ne-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
    const child = fork(fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), [root, environment, `boot-${randomUUID()}`], {
      execArgv: ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url))],
      env: { ...process.env, ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', TASK114_EDIT: mode, NODE_DISABLE_COMPILE_CACHE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
    });
    t.after(() => { if (child.exitCode === null) killTree(child); });
    let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
    // No fixed 15 s per-test timeout (expired at ci load 18): the chain's own end, bounded by the runner budget.
    const { code } = await ended(child, () => { try { return readFileSync(join(root, 'audit'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return 'no audit yet'; } });
    const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
    assert.equal(code, 0, output + '\n' + audit.join('\n'));
    const disabled = ['absent', 'invalid', 'standards', 'spec'].includes(mode);
    const critical = ['uncertain', 'persist', 'budget', 'cancel', 'eof', 'secret'].includes(mode);
    assert.equal(audit.filter(x => x === 'worker-spawn').length, mode === 'invalid' ? 0 : 1);
    assert.equal(audit.filter(x => x.includes('"kind":"provider-request"')).length, mode === 'invalid' ? 0 : disabled || critical ? 1 : ['mismatch', 'no-match'].includes(mode) ? 3 : 2);
    assert.equal(audit.filter(x => x.includes('"kind":"provider-validated"')).length, audit.filter(x => x.includes('"kind":"provider-request"')).length);
    assert.equal(audit.filter(x => x === 'edit-create').length, disabled || critical ? 0 : 1);
    assert.equal(audit.filter(x => x === 'edit-commit').length, disabled || ['budget', 'cancel', 'eof', 'empty', 'secret'].includes(mode) ? 0 : mode === 'mismatch' ? 2 : 1);
    if (!disabled && !['budget', 'cancel', 'eof', 'empty', 'secret'].includes(mode)) assert.equal(await readFile(join(root, 'edit-result'), 'utf8'), '\ufeffnew\r\nsafe █\r\n');
    assert.equal(audit.filter(x => x === 'edit-capture').length, disabled ? 0 : ['mismatch', 'no-match'].includes(mode) ? 2 : 1);
    if (mode === 'persist') assert.ok(audit.includes('edit-result-evidence-failed'));
    assert.ok(audit.includes('normal-edit-passed'));
    assert.doesNotMatch(output, /synthetic-secret|synthetic-key/);
  });
}
