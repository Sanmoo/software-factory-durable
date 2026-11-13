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
import { png, jpeg, gif, webp, withMetadata } from './fixtures/images.js';

for (const [name, source, mime, role] of [['PNG', png, 'image/png', 'standards'], ['JPEG', jpeg, 'image/jpeg', 'spec'], ['GIF', gif, 'image/gif', 'standards'], ['WebP', webp, 'image/webp', 'spec']] as const) {
  for (const blocked of [false, true]) test(`new Node24 fixed worker ${name}: ${blocked ? 'secret image aborts without next model turn' : 'actual native image/session/reopen'}`, { timeout: 15000 }, async t => {
    const context: ToolContext = { workId: 'image-work', executionId: 'image-exec', invocationId: 'image-invocation',
      role, environmentRef: 'image-env', bootRef: 'image-boot', phaseId: 'image-phase' };
    const secret = 'segredo-🔒-ação';
    const image = withMetadata(source, Buffer.from(blocked ? 'prefix-' + secret + '-suffix' : 'clean-local-metadata-'.repeat(2600)));
    const cut = blocked ? image.indexOf(Buffer.from(secret)) + 10 : 24576;
    let guestCalls = 0;
    const f = await nativeOwner(context, { exec(argv, options) {
      guestCalls++; assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
      assert.equal(argv.length, 6); assert.equal(argv[5], '/workspace/renamed.txt'); assert.equal(options.windowBytes, 65536);
      return { async *output() {
        yield { stream: 'stdout' as const, data: image.subarray(0, cut) };
        yield { stream: 'stdout' as const, data: image.subarray(cut) };
      }, result: Promise.resolve({ exitCode: 0 }) };
    } }, { imageSourceMaxBytes: image.length }); t.after(() => f.close());
    for (const value of [secret, 'synthetic-key']) f.records.registerSecret(value);
    const directory = join(f.root, 'profile'); await mkdir(directory, { mode: 0o700 });
    for (const path of [join(directory, 'sessions'), join(f.root, 'worker-records'), join(f.root, 't'), join(f.root, 'c')]) await mkdir(path, { mode: 0o700 });
    const recordsRoot = join(f.root, 'worker-records');
    const bootstrap = { version: 1, context, endpoint: f.owner.endpoint, recordsRoot, imageSourceMaxBytes: image.length,
      knownSecrets: [secret, 'synthetic-secret', 'synthetic-key'], prompt: `${name} ${blocked ? 'blocked-image' : 'clean-image'}: Read renamed.txt.`,
      profile: { id: sdkProfile.id, directory, systemPrompt: 'Private read-only image fixture.', providerId: 'offline-fixture', modelId: 'reader',
        apiKey: 'synthetic-key', provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
          { id: 'reader', name: 'Reader', reasoning: false, input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
        ] } } };
    const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
      execPath: process.execPath, execArgv: ['--import', fileURLToPath(new URL('./fixtures/image-provider-preload.js', import.meta.url))],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const messages: Record<string, unknown>[] = []; let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { output += String(chunk); });
    child.on('message', message => { messages.push(message as Record<string, unknown>); });
    const exited = once(child, 'exit'); child.send(bootstrap);
    const [code, signal] = await exited;
    assert.equal(signal, null); assert.equal(code, 0); assert.equal(output, '', 'no raw diagnostics or secrets');
    assert.equal(guestCalls, 1); assert.equal(messages.filter(message => message.kind === 'provider-request').length, blocked ? 1 : 2);
    const result = messages.find(message => message.kind === 'worker-result'); assert.ok(result);
    assert.equal(result.status, blocked ? 'interrupted' : 'completed');
    const receipt = result.receipt as { workId: string; id: string };
    const start = JSON.parse(await readFile(join(recordsRoot, receipt.workId, 'evidence', receipt.id, 'output'), 'utf8'));
    assert.equal(start.event.observedProcess.pid, child.pid); assert.notEqual(start.event.observedProcess.pid, process.pid);
    assert.equal(start.event.observedProcess.nodeVersion.split('.')[0], '24'); assert.equal(start.event.suppliedContext.role, role);
    const session = SessionManager.open(String(result.sessionFile), join(directory, 'sessions'));
    const images = session.buildSessionContext().messages.flatMap(message => message.role === 'toolResult'
      ? message.content.filter(block => block.type === 'image') : []);
    assert.equal(images.length, blocked ? 0 : 1);
    if (!blocked) {
      assert.equal(images[0]!.mimeType, mime); assert.deepEqual(Buffer.from(images[0]!.data, 'base64'), image);
    }
    for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      assert.equal(bytes.includes(Buffer.from(secret)), false); assert.equal(bytes.includes(Buffer.from('synthetic-key')), false);
      if (blocked) assert.equal(bytes.includes(Buffer.from(image.toString('base64'))), false);
    }
  });
}
