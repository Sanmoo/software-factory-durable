// Ticket 29: usage entries of a Pi JSONL v3 session as the SDK recorded them (assistant messages, usage/compaction entries), gaps counted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkers, sessionUsage } from '../../src/workers/index.js';
import { recordWorkerLaunch } from '../../src/platform/host/index.js';

const line = (value: unknown) => JSON.stringify(value);
const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };

test('AC6/AC7 session usage: assistant messages (errors/aborts included), usage and compaction entries; user/tool lines ignored; unreadable usage is a gap', () => {
  const data = Buffer.from(
    [
      line({ type: 'session', version: 3, id: 's', timestamp: 't', cwd: '/workspace' }),
      line({ type: 'message', id: 'u1', message: { role: 'user', content: 'secret prompt text is never read here' } }),
      line({ type: 'message', id: 'a1', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', stopReason: 'stop', usage } }),
      line({ type: 'message', id: 'a2', message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', stopReason: 'error', usage } }),
      line({
        type: 'message',
        id: 'a3',
        message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', stopReason: 'aborted', usage: { ...usage, cost: undefined } },
      }),
      line({ type: 'usage', id: 'x1', kind: 'cache_warm', provider: 'p', model: 'm', usage }),
      line({ type: 'compaction', id: 'c1', summary: 's', firstKeptEntryId: 'a1', tokensBefore: 1, usage: { input: -1 } }),
      '{not json',
      '',
    ].join('\n'),
  );
  const result = sessionUsage(data, 's');
  assert.deepEqual(
    result.entries.map(item => [item.id, item.outcome, item.cost, item.model]),
    [
      ['a1', 'ok', 0.01, 'gpt-5.5'],
      ['a2', 'error', 0.01, 'gpt-5.5'],
      ['a3', 'aborted', null, 'gpt-5.5'],
      ['x1', 'other', 0.01, 'm'],
    ],
  );
  assert.deepEqual(result.entries[0]!.tokens, { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6 });
  assert.equal(result.malformed, 2, 'the invalid compaction usage and the unparsable line are gaps, never zero');
  assert.ok(!JSON.stringify(result).includes('secret prompt'), 'no content is carried');
});

test("review MED: a session is measured only inside its Execution's boot runtime tree; foreign, `..` or unnormalized paths are unavailable; hash checked", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'usage-bind-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boot = 'boot-11111111-2222-4333-8444-555555555555',
    other = 'boot-99999999-2222-4333-8444-555555555555';
  const dir = (value: string) => Buffer.from(value.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
  const write = async (bootRef: string) => {
    const directory = join(root, 'r', dir(bootRef), 'w-x', 'profile', 'sessions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 's.jsonl');
    await writeFile(
      file,
      [
        line({ type: 'session', version: 3, id: 's', timestamp: 't', cwd: '/workspace' }),
        line({ type: 'message', id: 'a1', message: { role: 'assistant', stopReason: 'stop', usage } }),
      ].join('\n'),
      { mode: 0o600 },
    );
    return file;
  };
  const own = await write(boot),
    foreign = await write(other);
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'p' } as never });
  const reviewer = await workers.observeUsage({ workId: 'w', boot, session: { file: own } });
  assert.deepEqual([reviewer.state, reviewer.state === 'read' && reviewer.integrity], ['read', 'unverified']);
  for (const file of [foreign, `${root}/r/${dir(boot)}/../${dir(other)}/w-x/profile/sessions/s.jsonl`, 'relative/s.jsonl']) {
    const result = await workers.observeUsage({ workId: 'w', boot, session: { file } });
    assert.equal(result.state, 'unavailable', file);
  }
  assert.equal((await workers.observeUsage({ workId: 'w', boot: null, session: { file: own } })).state, 'unavailable');
  const ref = own.slice(root.length + 1);
  const mismatch = await workers.observeUsage({ workId: 'w', boot, session: { ref, sha256: '0'.repeat(64) } });
  assert.deepEqual(mismatch, { state: 'altered', code: 'SESSION_HASH_MISMATCH' });
});

// Acceptance finding A7: an activation that never returned (its boot was lost) leaves no session reference in Control. The owner names
// each worker directory after the invocation it launched there, so the session that worker wrote can still be found and measured.
test('A7: the session of an invocation that never returned is found by the launch record of its worker directory, in its own boot only, and read unverified', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'usage-invocation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boot = 'boot-11111111-2222-4333-8444-555555555555',
    other = 'boot-99999999-2222-4333-8444-555555555555';
  const dir = (value: string) => Buffer.from(value.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
  const launch = async (
    bootRef: string,
    worker: string,
    identity: { workId: string; executionId: string; invocationId: string; role: 'builder' | 'standards' | 'spec' } | null,
    sessions: string[],
  ) => {
    const directory = join(root, 'r', dir(bootRef), worker);
    await mkdir(join(directory, 'profile', 'sessions'), { recursive: true, mode: 0o700 });
    if (identity) await recordWorkerLaunch(directory, identity);
    for (const name of sessions)
      await writeFile(
        join(directory, 'profile', 'sessions', name),
        [
          line({ type: 'session', version: 3, id: `id-${worker}`, timestamp: 't', cwd: '/workspace' }),
          line({ type: 'message', id: 'a1', message: { role: 'assistant', stopReason: 'stop', usage } }),
          line({ type: 'message', id: 'a2', message: { role: 'assistant', stopReason: 'aborted', usage } }),
        ].join('\n'),
        { mode: 0o600 },
      );
    return directory;
  };
  const builder = { workId: 'w', executionId: 'e-1', invocationId: 'builder-1', role: 'builder' as const };
  await launch(boot, 'w-builder', builder, ['s.jsonl']);
  await launch(boot, 'w-reviewer', { ...builder, invocationId: 'standards-1', role: 'standards' }, ['s.jsonl']);
  await launch(boot, 'w-legacy', null, ['s.jsonl']);
  await launch(other, 'w-builder', { ...builder, executionId: 'e-2', invocationId: 'builder-2' }, ['s.jsonl']);
  assert.deepEqual(await readdir(join(root, 'r', dir(boot), 'w-builder')), ['launch.json', 'profile']);
  await assert.rejects(recordWorkerLaunch(join(root, 'r', dir(boot), 'w-builder'), builder), 'a launch record is written once, never replaced');
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'p' } as never });
  const observe = (bootRef: string | null, invocation: { executionId: string; invocationId: string }, workId = 'w') =>
    workers.observeUsage({ workId, boot: bootRef, session: { invocation } });
  const found = await observe(boot, builder);
  assert.deepEqual(
    [
      found.state,
      found.state === 'read' && found.sessionId,
      found.state === 'read' && found.integrity,
      found.state === 'read' && found.entries.map(item => [item.id, item.outcome, item.tokens.total]),
    ],
    [
      'read',
      'id-w-builder',
      'unverified',
      [
        ['a1', 'ok', 6],
        ['a2', 'aborted', 6],
      ],
    ],
  );
  // Another Work, Execution, invocation or boot, a reviewer's directory and a directory without a launch record are never this session.
  assert.deepEqual(await observe(boot, builder, 'other-work'), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
  assert.deepEqual(await observe(boot, { ...builder, executionId: 'e-2' }), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
  assert.deepEqual(await observe(boot, { executionId: 'e-1', invocationId: 'standards-1' }), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
  assert.deepEqual(await observe(other, builder), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
  assert.deepEqual(await observe(null, builder), { state: 'unavailable', code: 'SESSION_BOOT_UNKNOWN' });
  // The runtime tree of the boot is gone (environment removed): lost, like any removed session file.
  assert.deepEqual(await observe('boot-77777777-2222-4333-8444-555555555555', builder), { state: 'lost', code: 'SESSION_FILE_MISSING' });
  // A worker that wrote no session, or more than one, is never guessed.
  await launch(boot, 'w-empty', { ...builder, executionId: 'e-3', invocationId: 'builder-3' }, []);
  await launch(boot, 'w-two', { ...builder, executionId: 'e-4', invocationId: 'builder-4' }, ['a.jsonl', 'b.jsonl']);
  assert.deepEqual(await observe(boot, { executionId: 'e-3', invocationId: 'builder-3' }), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
  assert.deepEqual(await observe(boot, { executionId: 'e-4', invocationId: 'builder-4' }), { state: 'unavailable', code: 'SESSION_AMBIGUOUS' });
  // A launch record that is not a private regular file of this installation (here: a symbolic link to a valid one) names nothing.
  const forged = await launch(boot, 'w-forged', null, ['s.jsonl']);
  await symlink(join(root, 'r', dir(other), 'w-builder', 'launch.json'), join(forged, 'launch.json'));
  assert.deepEqual(await observe(boot, { executionId: 'e-2', invocationId: 'builder-2' }), { state: 'unavailable', code: 'SESSION_NOT_RECORDED' });
});
