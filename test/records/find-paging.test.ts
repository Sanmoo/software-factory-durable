// Ticket 29 (review): Records-level paging of `find` for big Works, direct lookup by capture id, role filter, and a second Records open on
// a live root that changes nothing (no init/recovery/abort of another instance's partial capture).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';

const context = (index: number, role: 'builder' | 'standards' = 'builder') => ({ workId: 'page-work', executionId: 'e1', invocationId: `i${index}`, role,
  environmentRef: 'env', bootRef: 'boot', callId: `c${index}` });

test('find pages by capture id (`after`/`limit`), looks one capture up by `id` and filters by role; paging never claims more than it read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'records-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) ids.push((await records.record(context(index, index === 3 ? 'standards' : 'builder'), { kind: 'tool', index })).id);
  const sorted = [...ids].sort();
  const first = await records.find({ workId: 'page-work', limit: 2 });
  assert.deepEqual([first.captures.map(item => item.reference.id), first.next, first.completeness], [sorted.slice(0, 2), sorted[1], 'complete']);
  const second = await records.find({ workId: 'page-work', after: first.next!, limit: 10 });
  assert.deepEqual([second.captures.map(item => item.reference.id), second.next], [sorted.slice(2), null]);
  const one = await records.find({ workId: 'page-work', id: ids[3]! });
  assert.deepEqual(one.captures.map(item => item.context.role), ['standards']);
  assert.deepEqual((await records.find({ workId: 'page-work', id: '00000000-0000-4000-8000-000000000000' })), { completeness: 'complete', captures: [], next: null });
  assert.deepEqual((await records.find({ workId: 'page-work', role: 'standards' })).captures.map(item => item.reference.id), [ids[3]]);
});

test('a second Records instance on a live root reads without side effects: another instance\'s partial capture stays partial and untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'records-second-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = await createRecords({ root });
  const partial = await live.openOutput(context(0));
  await partial.write(Buffer.from('in flight'));
  const tree = async () => {
    const out: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const name of (await readdir(path)).sort()) {
        const info = await stat(join(path, name));
        out.push(`${join(path, name).slice(root.length)}:${info.mode}:${info.size}:${info.mtimeMs}:${info.isFile() ? createHash('sha256').update(await readFile(join(path, name))).digest('hex') : 'dir'}`);
        if (info.isDirectory()) await walk(join(path, name));
      }
    };
    await walk(root);
    return out;
  };
  const before = await tree();
  const reader = await createRecords({ root });
  const found = await reader.find({ workId: 'page-work' });
  assert.deepEqual(found.captures.map(item => item.state), ['partial']);
  const page = await reader.read({ reference: found.captures[0]!.reference, offset: 0, limit: 100 });
  assert.equal(page.state, 'partial');
  assert.deepEqual(await tree(), before, 'nothing created, removed, renamed or rewritten');
  await partial.write(Buffer.from(' and finished'));
  assert.equal((await partial.finish()).bytes, 22, 'the live capture continues normally');
});
