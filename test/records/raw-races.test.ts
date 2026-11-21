import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = {
  workId: 'raw-work',
  executionId: 'execution',
  invocationId: 'invocation',
  role: 'builder' as const,
  environmentRef: 'environment',
  bootRef: 'boot',
  callId: 'race',
};
const unavailable = /PROTECTED_CAPTURE_UNAVAILABLE/;

for (const stage of ['output-sync', 'temporary-sync', 'parent-sync'] as const) {
  for (const action of ['rotate', 'abort', 'write', 'finish'] as const) {
    test(`raw ${action} fences finish at ${stage}`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'raw-race-'));
      let resume!: () => void;
      const resumed = new Promise<void>(resolve => {
        resume = resolve;
      });
      let pause!: () => void;
      const paused = new Promise<void>(resolve => {
        pause = resolve;
      });
      try {
        const records = await createRecords({ root });
        const originalOpen = fs.open;
        let directory = '';
        t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
          const handle = await originalOpen(...args);
          if (
            stage === 'output-sync'
              ? String(args[0]).endsWith('/output')
              : stage === 'temporary-sync'
                ? String(args[0]).includes('complete.json-')
                : String(args[0]) === directory
          ) {
            const originalSync = handle.sync.bind(handle);
            t.mock.method(handle, 'sync', async () => {
              pause();
              await resumed;
              await originalSync();
            });
          }
          return handle;
        });
        syncBuiltinESMExports();
        const out = await records.openOutput(context, { format: 'raw', maxBytes: 100 });
        directory = join(root, context.workId, 'evidence', out.reference.id);
        await out.write(Buffer.from([0, 255, 137, 80, 78, 71]));
        const finished = assert.rejects(out.finish(), unavailable);
        await paused;
        if (action === 'rotate') records.registerSecret('newly-registered-pattern');
        else if (action === 'abort') await out.abort();
        else await assert.rejects(action === 'write' ? out.write(Buffer.from('overlap')) : out.finish(), unavailable);
        const page = await records.read({ format: 'raw', reference: out.reference, offset: 0, limit: 100 });
        assert.equal(page.state, 'partial');
        assert.equal(page.data.length, 0);
        resume();
        await finished;
        await out.abort();
        assert.ok(!(await readdir(directory)).some(name => name.startsWith('complete.json')));
      } finally {
        resume();
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const fault of ['writeFile', 'sync'] as const)
  test(`raw ${fault} failure is protected and partial`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raw-fault-'));
    try {
      const records = await createRecords({ root });
      const originalOpen = fs.open;
      t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith('/output'))
          t.mock.method(handle, fault, async () => {
            throw new Error('untrusted diagnostic bytes');
          });
        return handle;
      });
      syncBuiltinESMExports();
      const out = await records.openOutput(context, { format: 'raw', maxBytes: 100 });
      if (fault === 'writeFile') await assert.rejects(out.write(Buffer.from([255, 0])), unavailable);
      else await out.write(Buffer.from([255, 0]));
      await assert.rejects(out.finish(), unavailable);
      const directory = join(root, context.workId, 'evidence', out.reference.id);
      assert.equal((await readdir(directory)).includes('complete.json'), false);
      assert.equal((await records.read({ format: 'raw', reference: out.reference, offset: 0, limit: 10 })).state, 'partial');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

test('raw opening is fenced by registry changes while capture metadata syncs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'raw-open-'));
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => {
    resume = resolve;
  });
  let pause!: () => void;
  const paused = new Promise<void>(resolve => {
    pause = resolve;
  });
  try {
    const records = await createRecords({ root });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('capture.json-')) {
        const originalSync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => {
          pause();
          await resumed;
          await originalSync();
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const opening = assert.rejects(records.openOutput(context, { format: 'raw', maxBytes: 100 }), unavailable);
    await paused;
    records.registerSecret('new-secret');
    resume();
    await opening;
    const evidence = join(root, context.workId, 'evidence');
    for (const id of await readdir(evidence)) assert.deepEqual(await readdir(join(evidence, id)), []);
  } finally {
    resume();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('raw concurrent write invalidates the first write and cannot publish', async t => {
  const root = await mkdtemp(join(tmpdir(), 'raw-write-'));
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => {
    resume = resolve;
  });
  let pause!: () => void;
  const paused = new Promise<void>(resolve => {
    pause = resolve;
  });
  try {
    const records = await createRecords({ root });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('/output')) {
        const originalWrite = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (data: Parameters<typeof handle.writeFile>[0]) => {
          pause();
          await resumed;
          await originalWrite(data);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const out = await records.openOutput(context, { format: 'raw', maxBytes: 100 });
    const first = assert.rejects(out.write(Buffer.from('first')), unavailable);
    await paused;
    await assert.rejects(out.write(Buffer.from('overlap')), unavailable);
    resume();
    await first;
    await assert.rejects(out.finish(), unavailable);
    const disk = await readFile(join(root, context.workId, 'evidence', out.reference.id, 'output'));
    assert.equal(disk.includes(Buffer.from('overlap')), false);
  } finally {
    resume();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
