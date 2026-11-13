import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ToolContext } from '../../src/sandbox/index.js';

for (const mode of ['complete', 'binary', 'capture-failure', 'transport-loss', 'temp-failure', 'session-failure'] as const) {
  test(`new Node24 native Bash/session/host spill: ${mode}`, { timeout: 15000 }, async t => {
    const blocked = mode !== 'complete';
    const context: ToolContext = { workId: 'bash-work', executionId: 'bash-exec', invocationId: 'bash-invocation',
      role: 'builder', environmentRef: 'bash-env', bootRef: 'bash-boot', phaseId: 'bash-phase' };
    const secret = 'segredo-🔒-ação';
    const source = Buffer.from('head π synthetic-secret synthetic-key ' + secret + '\n' + 'filtered output\n'.repeat(80000) + 'tail π');
    let guestCalls = 0;
    const f = await nativeOwner(context, { exec(argv, options) {
      guestCalls++;
      assert.deepEqual(argv, ['/usr/bin/env', '-i', '/bin/bash', '-c', "printf 'syn''thetic-se''cret'; printf 'tail π' >&2"]);
      assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/workspace');
      assert.equal(options.stdout, 'pipe'); assert.equal(options.stderr, 'pipe'); assert.equal(options.windowBytes, 65536);
      return { async *output() {
        if (mode === 'capture-failure') {
          const evidence = join(f.root, 'records', context.workId, 'evidence');
          for (const id of await readdir(evidence)) await mkdir(join(evidence, id, 'complete.json'), { mode: 0o700 });
        }
        if (mode === 'session-failure') {
          const sessions = join(f.root, 'profile', 'sessions');
          await rename(sessions, sessions + '-held'); await writeFile(sessions, 'not a directory', { mode: 0o600 });
        }
        if (mode === 'temp-failure') {
          await rmdir(join(f.root, 't')); await writeFile(join(f.root, 't'), 'not a directory', { mode: 0o600 });
        }
        if (mode === 'binary') { yield { stream: 'stdout' as const, data: Buffer.from([255]) }; return; }
        if (mode === 'transport-loss') throw new Error('synthetic-secret synthetic-key ' + secret);
        for (let offset = 0; offset < source.length; offset += 8191) yield {
          stream: offset % 2 ? 'stderr' as const : 'stdout' as const, data: source.subarray(offset, offset + 8191),
        };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } }); t.after(() => f.close());
    for (const value of ['synthetic-key', secret]) f.records.registerSecret(value);
    const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
    const recordsRoot = join(f.root, 'worker-records');
    for (const path of [join(directory, 'sessions'), recordsRoot, join(f.root, 't'), join(f.root, 'c')]) await mkdir(path, { mode: 0o700 });
    const bootstrap = { version: 1, context, endpoint: f.owner.endpoint, recordsRoot,
      knownSecrets: ['synthetic-secret', 'synthetic-key', secret], prompt: blocked ? 'blocked-bash output.' : 'Run Bash output.',
      profile: { id: sdkProfile.id, directory, systemPrompt: 'Private UTF-8 Bash Builder fixture.', providerId: 'offline-fixture', modelId: 'reader',
        apiKey: 'synthetic-key', provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
          { id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
        ] } } };
    const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
      execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/bash-provider-preload.js', import.meta.url))],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const messages: Record<string, unknown>[] = []; let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { output += String(chunk); });
    child.on('message', message => { messages.push(message as Record<string, unknown>); });
    const exited = once(child, 'exit'); child.send(bootstrap);
    const [code, signal] = await exited;
    assert.equal(signal, null); assert.equal(output, ''); assert.equal(guestCalls, 1);
    assert.equal(messages.filter(message => message.kind === 'provider-request').length, blocked ? 1 : 2);
    // The adopted drain-aware native SDK catches spill open errors: capture
    // failure interrupts the session rather than becoming an uncaught worker fault.
    if (mode === 'session-failure') {
      assert.equal(code, 1);
      assert.deepEqual(messages.filter(message => message.kind === 'worker-error'), [{ kind: 'worker-error', code: 'WORKER_PROCESS_FAILED' }]);
      assert.equal(messages.some(message => message.kind === 'worker-result'), false);
      return;
    }
    assert.equal(code, 0);
    const result = messages.find(message => message.kind === 'worker-result'); assert.ok(result);
    assert.equal(result.status, blocked ? 'interrupted' : 'completed');
    const reopened = SessionManager.open(String(result.sessionFile), join(directory, 'sessions'));
    const tools = reopened.buildSessionContext().messages.filter(message => message.role === 'toolResult');
    assert.equal(tools.length, 1);
    if (!blocked) {
      assert.match(JSON.stringify(tools), /tail π/);
      const spill = (await readdir(join(f.root, 't'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
      assert.equal(spill.length, 1);
      const path = join(spill[0]!.parentPath, spill[0]!.name);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const full = await readFile(path, 'utf8'); assert.ok(Buffer.byteLength(full) > 1024 * 1024);
      assert.match(full, /head π █ █ █/); assert.match(full, /tail π$/);
      assert.match(JSON.stringify(tools), /Full output:/);
    }
    for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      for (const value of ['synthetic-secret', 'synthetic-key', secret]) assert.equal(bytes.includes(Buffer.from(value)), false, entry.name);
    }
    for (const value of ['synthetic-secret', 'synthetic-key', secret]) assert.equal(JSON.stringify(messages).includes(value), false);
  });
}
