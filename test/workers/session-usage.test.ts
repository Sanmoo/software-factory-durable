// Ticket 29: usage entries of a Pi JSONL v3 session as the SDK recorded them (assistant messages, usage/compaction entries), gaps counted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkers, sessionUsage } from '../../src/workers/index.js';

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
