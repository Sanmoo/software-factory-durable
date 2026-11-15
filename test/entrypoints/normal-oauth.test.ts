import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { ended } from '../runner/budget.js';

// Ticket 37 (P1, approved): modes that only vary the provider's answer share ONE adapter→owner boot, one activation (new worker Node)
// each; what they prove is the worker's handling, not owner isolation. Modes that latch, revoke or abort the owner's state keep their own.
const shared = ['success', 'third-request', 'second-tool', 'http429', 'http500', 'mutable-error', 'provider-bytes', 'prompt-bytes',
  'tool-args-overflow', 'tool-result-overflow', 'context-bytes'];
const isolated = ['held-ack', 'rotation-ack-fail', 'deadline', 'start-failure', 'prompt-secret', 'missing-store', 'abort'];

type Chain = { root: string; code: number | null; output: string; audit: string; childPid: number | undefined };
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

async function chain(modes: string): Promise<Chain> {
  const root = await mkdtemp('/tmp/no-');
  roots.push(root);
  const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), [root, environment, `boot-${randomUUID()}`], {
    execArgv: ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url))],
    env: { ...process.env, ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', TASK178_OAUTH: modes, NODE_DISABLE_COMPILE_CACHE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
  });
  let output = ''; child.stdout?.on('data', data => { output += data; }); child.stderr?.on('data', data => { output += data; });
  // No fixed per-test timeout: the chain's own end, bounded only by the runner budget (tree killed, last audit stage named).
  const { code } = await ended(child, () => { try { return readFileSync(join(root, 'audit'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return 'no audit yet'; } });
  return { root, code, output, audit: existsSync(join(root, 'audit')) ? await readFile(join(root, 'audit'), 'utf8') : '', childPid: child.pid };
}
let sharedChain: Promise<Chain> | undefined;

for (const mode of [...shared, ...isolated]) {
  test(`OAuth public normal activation: ${mode}`, async t => {
    let audit: string, result: { pid: number; counts: object };
    const run = shared.includes(mode) ? await (sharedChain ??= chain(shared.join(','))) : await chain(mode);
    if (shared.includes(mode)) {
      const error = join(run.root, `mode-error-${mode}`);
      assert.equal(existsSync(error), false, existsSync(error) ? readFileSync(error, 'utf8') : '');
      // Only this activation's lines of the shared boot's audit.
      const lines = run.audit.split('\n');
      const begin = lines.indexOf(`mode-begin:${mode}`), end = lines.indexOf(`mode-end:${mode}`);
      assert.ok(begin >= 0 && end > begin, run.output);
      audit = lines.slice(begin + 1, end).join('\n');
      result = JSON.parse(await readFile(join(run.root, `normal-worker-result-${mode}.json`), 'utf8'));
    } else {
      assert.equal(run.code, 0, run.output);
      audit = run.audit;
      result = JSON.parse(await readFile(join(run.root, 'normal-worker-result.json'), 'utf8'));
    }
    assert.equal(audit.split('\n').filter(x => x === 'worker-spawn').length, 1);
    const models = ['success', 'third-request'].includes(mode) ? 2 : ['held-ack', 'rotation-ack-fail', 'prompt-bytes', 'start-failure', 'prompt-secret', 'missing-store'].includes(mode) ? 0 : 1;
    assert.equal(audit.split('\n').filter(x => x.includes('"kind":"provider-request"')).length, models);
    const reads = ['success', 'third-request', 'second-tool', 'tool-result-overflow', 'context-bytes'].includes(mode) ? 1 : 0;
    assert.equal(audit.split('\n').filter(x => x === 'read').length, reads, 'native tool dispatch limit is before adapter');
    if (!['prompt-bytes', 'start-failure', 'prompt-secret', 'missing-store'].includes(mode)) assert.match(audit, /secret-registration-metadata/);
    assert.match(audit, /normal-oauth-passed/);
    assert.doesNotMatch(audit + run.output, /oauth-access-canary|oauth-refresh-canary|oauth-access-rotated|oauth-refresh-rotated|unknown-http-secret-body|unknown-start-secret/);
    assert.notEqual(result.pid, run.childPid);
    t.diagnostic(JSON.stringify({ mode, ...result.counts, adapterReads: reads }));
  });
}

test('the shared OAuth boot ends cleanly after its last activation', async () => {
  const run = await (sharedChain ??= chain(shared.join(',')));
  assert.equal(run.code, 0, run.output);
  const lines = run.audit.split('\n');
  assert.equal(lines.filter(line => line === 'close').length, 1, 'the boot is closed once');
  assert.ok(lines.indexOf('close') > lines.indexOf(`mode-end:${shared.at(-1)}`), 'after every activation');
  assert.equal(lines.filter(line => line === 'worker-spawn').length, shared.length, 'one new worker Node per activation');
});
