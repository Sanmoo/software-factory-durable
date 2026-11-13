import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ToolContext } from '../../src/sandbox/index.js';

const context: ToolContext = { workId: 'work-05', executionId: 'execution-05', invocationId: 'standards-05',
  role: 'standards', environmentRef: 'environment-05', bootRef: 'boot-05', phaseId: 'review-1' };

test('fixed worker entrypoint runs native SDK in a new Node process; private receipt precedes filtered native JSONL', { timeout: 10000 }, async t => {
  let guestCalls = 0;
  const text = 'prefix\n'.repeat(5000) + 'synthetic-secret synthetic-key\ntarget\nlast';
  const f = await nativeOwner(context, { exec(argv) {
    guestCalls++;
    assert.deepEqual(argv, ['/bin/cat', '--', '/workspace/source.txt']);
    return { async *output() {
      for (let i = 0; i < text.length; i += 11) yield { stream: 'stdout' as const, data: Buffer.from(text.slice(i, i + 11)) };
    }, result: Promise.resolve({ exitCode: 0 }) };
  } });
  t.after(() => f.close());
  // Distinct Records owners must know secrets before any capture/use.
  f.records.registerSecret('synthetic-key');
  const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'sessions'), { mode: 0o700 });
  const recordsRoot = join(f.root, 'worker-records'); await mkdir(recordsRoot, { mode: 0o700 });
  const bootstrap = { version: 1, context, endpoint: f.owner.endpoint, recordsRoot,
    knownSecrets: ['synthetic-secret', 'synthetic-key'], prompt: 'Read source.txt at offset 5001, limit 2.',
    profile: { id: sdkProfile.id, directory, systemPrompt: 'Private read-only fixture. No personal resources.',
      providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
      provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
        { id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
      ] } } };

  for (const name of ['t', 'c']) await mkdir(join(f.root, name), { mode: 0o700 });
  async function child(input: object) {
    const processChild = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
      execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/provider-preload.js', import.meta.url))],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1',
        TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Array<Record<string, unknown>> = [];
    let output = '';
    processChild.stdout!.on('data', chunk => { output += String(chunk); });
    processChild.stderr!.on('data', chunk => { output += String(chunk); });
    let receiptAtRequest = false;
    const checks: Promise<void>[] = [];
    processChild.on('message', message => {
      messages.push(message as Record<string, unknown>);
      if ((message as { kind: string }).kind === 'provider-request') checks.push((async () => {
        const evidence = join(recordsRoot, context.workId, 'evidence');
        for (const id of await readdir(evidence)) {
          const stored = await readFile(join(evidence, id, 'output'), 'utf8');
          await readFile(join(evidence, id, 'complete.json'));
          if (JSON.parse(stored).event.kind === 'worker-start') receiptAtRequest = true;
        }
      })());
    });
    const exited = once(processChild, 'exit');
    processChild.send(input);
    const [code, signal] = await exited;
    await Promise.all(checks);
    assert.equal(signal, null); assert.equal(output, '', 'no raw bootstrap, credential, or SDK diagnostics on stdio');
    return { code, messages, pid: processChild.pid, receiptAtRequest };
  }

  const success = await child(bootstrap);
  assert.equal(success.code, 0);
  assert.equal(success.messages.filter(message => message.kind === 'provider-request').length, 2);
  assert.equal(success.receiptAtRequest, true);
  assert.equal(guestCalls, 1);
  const completed = success.messages.find(message => message.kind === 'worker-result')!;
  assert.equal(completed.status, 'completed');
  const stored = await readFile(String(completed.sessionFile), 'utf8');
  assert.match(stored, /█/); assert.match(stored, /target/);
  assert.doesNotMatch(stored, /synthetic-secret|synthetic-key|prefix/);
  const reopened = SessionManager.open(String(completed.sessionFile), join(directory, 'sessions'));
  assert.ok(reopened.buildSessionContext().messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('█')));
  const receipt = completed.receipt as { workId: string; id: string };
  const recorded = JSON.parse(await readFile(join(recordsRoot, receipt.workId, 'evidence', receipt.id, 'output'), 'utf8'));
  assert.equal(recorded.event.observedProcess.pid, success.pid);
  assert.notEqual(recorded.event.observedProcess.pid, process.pid);
  assert.equal(recorded.event.observedProcess.parentPid, process.pid);
  assert.equal(recorded.event.observedProcess.nodeVersion.split('.')[0], '24');
  assert.equal(recorded.event.suppliedContext.role, 'standards');
  assert.equal(recorded.event.profile.id, sdkProfile.id);
  assert.ok(Date.parse(recorded.event.observedProcess.observedAt) >= recorded.event.observedProcess.timeOrigin);
  assert.doesNotMatch(JSON.stringify(recorded), /synthetic-key|synthetic-secret/);

  for (const invalid of [
    { ...bootstrap, unexpected: 'not allowed' },
    { ...bootstrap, version: 2 },
    { ...bootstrap, prompt: 'x'.repeat(65537) },
    { ...bootstrap, context: { ...context, role: 'builder' } },
    { ...bootstrap, profile: { ...bootstrap.profile, systemPrompt: 'Never persist synthetic-key' } },
  ]) {
    const rejected = await child(invalid);
    assert.equal(rejected.code, 1);
    assert.deepEqual(rejected.messages, [{ kind: 'worker-error', code: 'WORKER_BOOTSTRAP_INVALID' }]);
  }

  // A structural metadata collision makes the critical Records publication fail.
  // It is real Records failure, not a callback replacing the SDK/start body.
  f.records.registerSecret(context.invocationId);
  const failed = await child({ ...bootstrap, knownSecrets: [...bootstrap.knownSecrets, context.invocationId] });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.messages, [{ kind: 'worker-error', code: 'PROTECTED_CAPTURE_UNAVAILABLE' }]);
  assert.equal(guestCalls, 1, 'failed receipt must not execute guest tools');
  assert.equal((await readdir(join(directory, 'sessions'))).length, 1, 'failed receipt must not create another SDK session');
});
