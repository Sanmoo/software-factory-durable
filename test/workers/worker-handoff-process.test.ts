import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ToolContext } from '../../src/sandbox/index.js';

// I-local: fixed worker entrypoint in a NEW Node24 process, native SDK, real owner transport/Records; doubled the VM exec and provider HTTP.
const context: ToolContext = { workId: 'work-12', executionId: 'execution-12', invocationId: 'builder-12', role: 'builder',
  environmentRef: 'environment-12', bootRef: 'boot-12', phaseId: 'builder-initial' };
const summary = { version: 1, round: 1, index: '/artifacts/review/r1/index.json', indexSha256: 'e'.repeat(64), head: 'b'.repeat(40), branch: 'factory/3-x', base: 'a'.repeat(40), mergeBase: 'a'.repeat(40),
  counts: { entries: 0, committed: 0, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: Object.fromEntries(['committed', 'staged', 'unstaged'].map(name => [name, { path: `/artifacts/review/r1/${name}.patch`, bytes: 0, sha256: 'd'.repeat(64) }])),
  spec: null, instructions: null, changed: [], changedTruncated: false };

test('AC3: the Builder child notifies its suspended handoff over the fixed IPC and continues only after the Host directive', { timeout: 30000 }, async t => {
  const commands: string[] = [];
  const f = await nativeOwner(context, { exec(argv) {
    commands.push(argv[argv.length - 1]!);
    return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from(JSON.stringify(summary)) }; }, result: Promise.resolve({ exitCode: 0 }) };
  } });
  t.after(() => f.close());
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const recordsRoot = join(f.root, 'worker-records'); await mkdir(recordsRoot, { mode: 0o700 });
  for (const name of ['t', 'c']) await mkdir(join(f.root, name), { mode: 0o700 });
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
    execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/handoff-provider-preload.js', import.meta.url))],
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { output += String(chunk); });
  const messages: Record<string, unknown>[] = [];
  child.on('message', message => {
    messages.push(message as Record<string, unknown>);
    if ((message as { kind: string }).kind === 'worker-handoff') setTimeout(() => {
      assert.equal(messages.filter(item => item.kind === 'provider-request').length, 1, 'suspended: no provider turn before the directive');
      child.send({ kind: 'deliver', directive: { kind: 'review-results', round: 1, prompt: 'FACTORY REVIEW RESULTS round 1: no findings.' } });
    }, 150);
  });
  const exited = once(child, 'exit');
  child.send({ version: 1, context, endpoint: f.owner.endpoint, recordsRoot, knownSecrets: ['synthetic-secret'], prompt: 'Implement then hand off.', handoff: { baseCommit: 'a'.repeat(40) },
    profile: { id: sdkProfile.id, directory, systemPrompt: 'Builder fixture.', providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
      provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
  const [code] = await exited;
  assert.equal(code, 0, output);
  const kinds = messages.map(message => message.kind).filter(kind => kind !== 'worker-secret-register');
  assert.deepEqual(kinds, ['worker-started', 'provider-request', 'worker-handoff', 'provider-request', 'worker-result']);
  assert.deepEqual(messages.find(message => message.kind === 'worker-handoff')!.event, { round: 1, status: 'captured', summary });
  assert.equal(messages.find(message => message.kind === 'worker-result')!.status, 'completed');
  assert.equal(commands.length, 1); assert.match(commands[0]!, /^exec \/usr\/bin\/python3 -I -S - \/workspace\/checkout \/artifacts 1 a{40} /);
});
