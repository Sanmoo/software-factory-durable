import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { sdkProfile } from '../../src/workers/sdk-profile.js';

// Actual production fixed entrypoint phase-only proof. No SDK preload/hooks or
// provider evaluation: an owned nonexistent endpoint stops before SDK import.
test('production entrypoint emits protected started receipt before unavailable tool endpoint; failed start never emits receipt', { timeout: 10000 }, async () => {
  const root = await mkdtemp('/tmp/s168p-');
  for (const path of ['profile', 'profile/sessions', 't', 'c', 'records']) await mkdir(join(root, path), { mode: 0o700 });
  const context = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'spec',
    environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
  const bootstrap = { version: 1, context, endpoint: join(root, 'missing'), recordsRoot: join(root, 'records'), knownSecrets: [] as string[], prompt: 'offline phase proof',
    profile: { id: sdkProfile.id, directory: join(root, 'profile'), systemPrompt: 'offline phase proof',
      providerId: 'offline', modelId: 'offline', apiKey: 'synthetic-phase-key',
      provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [{ id: 'offline', name: 'Offline', reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 10 }] } } };
  async function launch(input: typeof bootstrap) {
    let messages = 0, output = '', started = 0;
    const child = fork(new URL('../../src/entrypoints/worker.js', import.meta.url), [], {
      execPath: '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node', execArgv: [],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(root, 't'), XDG_CACHE_HOME: join(root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const received: unknown[] = [], receiptChecks: Promise<void>[] = [];
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { output += String(chunk); });
    child.on('message', message => {
      messages++;
      received.push(message);
      if ((message as { kind: string }).kind === 'worker-started') {
        started++;
        const reference = (message as { receipt: { workId: string; id: string } }).receipt;
        receiptChecks.push((async () => {
          const directory = join(root, 'records', reference.workId, 'evidence', reference.id);
          await readFile(join(directory, 'complete.json'));
          const body = await readFile(join(directory, 'output'), 'utf8');
          assert.doesNotMatch(body, /synthetic-phase-key/);
          assert.deepEqual(JSON.parse(body).event.suppliedContext, context);
        })());
      }
    });
    const exited = once(child, 'exit');
    child.send(input);
    const [code] = await exited;
    await Promise.all(receiptChecks);
    return { code, messages, output, started, received };
  }
  const completed = await launch(bootstrap);
  assert.equal(completed.code, 1); assert.equal(completed.messages, 2); assert.equal(completed.started, 1); assert.equal(completed.output, '');
  assert.deepEqual(completed.received[1], { kind: 'worker-error', code: 'WORKER_PROCESS_FAILED' });
  const failed = await launch({ ...bootstrap, knownSecrets: [context.invocationId] });
  assert.deepEqual(failed, { code: 1, messages: 1, started: 0, output: '', received: [{ kind: 'worker-error', code: 'PROTECTED_CAPTURE_UNAVAILABLE' }] });
  assert.deepEqual(await readdir(join(root, 'profile', 'sessions')), []);
});
