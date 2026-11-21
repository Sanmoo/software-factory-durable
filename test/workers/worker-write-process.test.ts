import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '#factory-pi';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ToolContext } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

for (const mode of ['complete', 'overwrite', 'overwrite-empty', 'guest-failure', 'persist-failure'] as const)
  test(`new Node24 native Builder write/session: ${mode}`, { timeout: remainingMs() }, async t => {
    const blocked = mode === 'guest-failure' || mode === 'persist-failure';
    const content = mode === 'overwrite-empty' ? '' : 'hello π\n';
    const context: ToolContext = {
      workId: 'write-work',
      executionId: 'write-exec',
      invocationId: 'write-invocation',
      role: 'builder',
      environmentRef: 'write-env',
      bootRef: 'write-boot',
      phaseId: 'write-phase',
    };
    // External VM double only: no guest helper execution or kernel/inode proof.
    const virtualFiles = new Map<string, string>(mode !== 'complete' ? [['/workspace/nested/new.txt', 'previous longer content']] : []);
    virtualFiles.set('/outside/sentinel', 'untouched');
    let guestCalls = 0;
    const f = await nativeOwner(context, {
      exec(argv, options) {
        guestCalls++;
        const protectedEvents = [join(f.root, 'records'), join(f.root, 'worker-records')].flatMap(root =>
          readdirSync(join(root, context.workId, 'evidence')).map(id => {
            readFileSync(join(root, context.workId, 'evidence', id, 'complete.json'));
            return JSON.parse(readFileSync(join(root, context.workId, 'evidence', id, 'output'), 'utf8')).event;
          }),
        );
        assert.ok(
          protectedEvents.some(event => event.kind === 'worker-start'),
          'durable start before guest effect',
        );
        assert.equal(protectedEvents.filter(event => event.kind === 'mutation-intent').length, guestCalls, 'this call has protected intent before effect');
        assert.deepEqual(options.env, {});
        assert.equal(options.cwd, '/');
        assert.equal(argv[6], guestCalls === 1 ? '/workspace/nested' : '/workspace/nested/new.txt');
        if (argv[5] === 'create') {
          if (mode !== 'complete') assert.equal(virtualFiles.get(argv[6]!), 'previous longer content');
          assert.equal(options.stdin, content);
          virtualFiles.set(argv[6]!, mode === 'guest-failure' ? '' : options.stdin!);
          if (mode === 'persist-failure') f.records.registerSecret(context.invocationId);
        }
        // VM virtual filesystem only: does NOT execute/qualify the FD helper.
        return {
          async *output() {
            yield { stream: 'stdout' as const, data: Buffer.from('unsafe synthetic-secret synthetic-key guest error') };
          },
          result: Promise.resolve({ exitCode: mode === 'guest-failure' && argv[5] === 'create' ? 1 : 0 }),
        };
      },
    });
    t.after(() => f.close());
    f.records.registerSecret('synthetic-key');
    const directory = join(f.root, 'profile');
    await mkdir(directory, { mode: 0o700 });
    const recordsRoot = join(f.root, 'worker-records');
    for (const path of [join(directory, 'sessions'), recordsRoot, join(f.root, 't'), join(f.root, 'c')]) await mkdir(path, { mode: 0o700 });
    const bootstrap = {
      version: 1,
      context,
      endpoint: f.owner.endpoint,
      recordsRoot,
      knownSecrets: ['synthetic-secret', 'synthetic-key'],
      prompt: blocked ? 'blocked-write new file.' : mode === 'overwrite-empty' ? 'overwrite-empty file.' : 'Create or overwrite file.',
      profile: {
        id: sdkProfile.id,
        directory,
        systemPrompt: 'Private regular-file Builder write fixture.',
        providerId: 'offline-fixture',
        modelId: 'reader',
        apiKey: 'synthetic-key',
        provider: {
          api: 'openai-completions',
          baseUrl: 'https://offline.invalid',
          models: [
            {
              id: 'reader',
              name: 'Reader',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
        },
      },
    };
    const child = fork(fileURLToPath(new URL('../../src/entrypoints/worker.js', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: ['--import', fileURLToPath(new URL('./fixtures/write-provider-preload.js', import.meta.url))],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(f.root, 't'), XDG_CACHE_HOME: join(f.root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const messages: Record<string, unknown>[] = [];
    let output = '';
    child.stdout!.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr!.on('data', chunk => {
      output += String(chunk);
    });
    child.on('message', message => {
      messages.push(message as Record<string, unknown>);
    });
    const exited = once(child, 'exit');
    child.send(bootstrap);
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(output, '');
    assert.equal(guestCalls, 2);
    assert.equal(virtualFiles.get('/workspace/nested/new.txt'), mode === 'guest-failure' ? '' : content);
    assert.equal(virtualFiles.get('/outside/sentinel'), 'untouched');
    assert.equal(messages.filter(message => message.kind === 'provider-request').length, blocked ? 1 : 2);
    const result = messages.find(message => message.kind === 'worker-result');
    assert.ok(result);
    assert.equal(result.status, blocked ? 'interrupted' : 'completed');
    const receipt = result.receipt as { workId: string; id: string };
    const start = JSON.parse(await readFile(join(recordsRoot, receipt.workId, 'evidence', receipt.id, 'output'), 'utf8'));
    assert.equal(start.event.observedProcess.pid, child.pid);
    assert.equal(start.event.suppliedContext.role, 'builder');
    const reopened = SessionManager.open(String(result.sessionFile), join(directory, 'sessions'));
    assert.ok(
      reopened
        .buildSessionContext()
        .messages.some(
          message =>
            message.role === 'toolResult' &&
            JSON.stringify(message).includes(
              mode === 'persist-failure' ? 'WRITE_EVIDENCE_OR_EFFECTS_UNCERTAIN' : blocked ? 'WRITE_EFFECTS_UNCERTAIN' : 'Successfully wrote to nested/new.txt',
            ),
        ),
    );
    const events: Array<{ kind: string; contentBytes?: number; semantics?: string; effects?: string }> = [];
    for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      assert.equal(bytes.includes(Buffer.from('synthetic-secret')), false);
      assert.equal(bytes.includes(Buffer.from('synthetic-key')), false);
      if (entry.name === 'output') {
        const parsed = JSON.parse(bytes.toString());
        events.push(parsed.event);
        assert.equal(bytes.includes(Buffer.from('hello')), false, 'mutation evidence contains no raw file content');
      }
    }
    assert.equal(events.filter(event => event.kind === 'mutation-intent').length, 2);
    assert.equal(events.filter(event => event.kind === 'mutation-result').length, mode === 'persist-failure' ? 1 : 2);
    assert.ok(events.filter(event => event.kind === 'mutation-intent').every(event => event.semantics === 'regular-file-write-non-atomic'));
    if (!blocked) assert.ok(events.some(event => event.effects === 'regular-file-written'));
  });
