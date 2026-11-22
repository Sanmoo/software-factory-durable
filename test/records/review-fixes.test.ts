import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, copyFile, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { remainingMs } from '../runner/budget.js';

const context = {
  workId: 'work-05',
  executionId: 'execution-05',
  invocationId: 'builder-05',
  role: 'builder' as const,
  environmentRef: 'environment-05',
  bootRef: 'boot-05',
  callId: 'review-fixes',
};
const unavailable = /PROTECTED_CAPTURE_UNAVAILABLE/;
const execute = promisify(execFile);

for (const event of [{ 'secret-A': false, 'secret-B': true }, { 'secret-A': false, '█': true }, { nested: [{ 'secret-A': false, 'secret-B': true }] }]) {
  test(`Records rejects resulting-key collisions before capture: ${JSON.stringify(event)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'records-review-'));
    try {
      const records = await createRecords({ root });
      records.registerSecret('secret-A');
      records.registerSecret('secret-B');
      await assert.rejects(records.record(context, event), unavailable);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const shape of ['string', 'utf8-bytes', 'wide', 'wide-object', 'deep', 'cycle'] as const) {
  test(`Records rejects ${shape} event before traversing beyond its budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'records-review-'));
    try {
      let touched = 0;
      const sentinel = {
        get beyondBudget() {
          touched++;
          return 'must not inspect';
        },
      };
      let event: object;
      if (shape === 'string') event = { huge: '🔒'.repeat(65536), sentinel };
      else if (shape === 'utf8-bytes') event = { huge: '🔒'.repeat(20000), sentinel };
      else if (shape === 'wide') event = [...Array(70000).fill(0), sentinel];
      else if (shape === 'wide-object') {
        event = Object.fromEntries(Array.from({ length: 70000 }, (_, i) => [`key-${i}`, 0]));
        Object.assign(event, { sentinel });
      } else if (shape === 'deep') {
        event = sentinel;
        for (let i = 0; i < 40; i++) event = { nested: event };
      } else {
        const cycle: unknown[] = [];
        cycle.push(cycle, sentinel);
        event = cycle;
      }
      const records = await createRecords({ root });
      await assert.rejects(records.record(context, event), unavailable);
      assert.equal(touched, 0, 'preflight must stop before later getters/values');
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('Records preflight rejects executable object traps before invoking caller code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-review-'));
  try {
    const records = await createRecords({ root });
    let touched = 0;
    const event = new Proxy(
      {},
      {
        getPrototypeOf() {
          touched++;
          return Object.prototype;
        },
      },
    );
    await assert.rejects(records.record(context, event), unavailable);
    assert.equal(touched, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const stage of ['temporary-sync', 'parent-sync'] as const)
  for (const call of ['write', 'finish', 'abort'] as const) {
    test(`Records invalidation by overlapping ${call} during ${stage} cannot publish completion`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'records-review-'));
      let resume!: () => void;
      const resumed = new Promise<void>(resolve => {
        resume = resolve;
      });
      let paused!: () => void;
      const publicationPaused = new Promise<void>(resolve => {
        paused = resolve;
      });
      try {
        const records = await createRecords({ root });
        const output = await records.openOutput(context);
        const directory = join(root, context.workId, 'evidence', output.reference.id);
        const originalOpen = fs.open;
        t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
          const handle = await originalOpen(...args);
          if (stage === 'temporary-sync' ? String(args[0]).includes('complete.json-') : String(args[0]) === directory) {
            const originalSync = handle.sync.bind(handle);
            t.mock.method(handle, 'sync', async () => {
              paused();
              await resumed;
              await originalSync();
            });
          }
          return handle;
        });
        syncBuiltinESMExports();
        const finishing = output.finish();
        // Attach rejection handling before releasing the external filesystem pause.
        const rejectedFinish = assert.rejects(finishing, unavailable);
        await publicationPaused;
        if (call === 'abort') await output.abort();
        else await assert.rejects(call === 'write' ? output.write(Buffer.from('overlap')) : output.finish(), unavailable);
        assert.equal((await records.read({ reference: output.reference, offset: 0, limit: 1 })).state, 'partial');
        resume();
        await rejectedFinish;
        await assert.rejects(output.finish(), unavailable);
        assert.equal((await records.read({ reference: output.reference, offset: 0, limit: 1 })).state, 'partial');
        assert.ok(!(await readdir(join(root, context.workId, 'evidence', output.reference.id))).some(name => name.startsWith('complete.json')));
      } finally {
        resume();
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

test('Records removes completion if parent sync fails after rename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'records-review-'));
  try {
    const records = await createRecords({ root });
    const output = await records.openOutput(context);
    const directory = join(root, context.workId, 'evidence', output.reference.id);
    const originalOpen = fs.open;
    let injected = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === directory) {
        assert.ok((await readFile(join(directory, 'complete.json'))).length > 0, 'rename already happened');
        t.mock.method(handle, 'sync', async () => {
          injected = true;
          throw new Error('owned fixture sync failure');
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(output.finish(), unavailable);
    assert.equal(injected, true);
    assert.equal((await records.read({ reference: output.reference, offset: 0, limit: 1 })).state, 'partial');
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('complete.json')));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const metadata of ['capture.json', 'complete.json']) {
  for (const corruption of ['oversize', 'symlink', 'fifo', 'public']) {
    test(`Records rejects ${corruption} ${metadata} without following or blocking`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'records-review-'));
      try {
        const records = await createRecords({ root });
        const output = await records.openOutput(context);
        await output.finish();
        const path = join(root, context.workId, 'evidence', output.reference.id, metadata);
        if (corruption === 'oversize') await writeFile(path, `${await readFile(path, 'utf8')}${' '.repeat(65536)}`);
        if (corruption === 'public') await chmod(path, 0o644);
        if (corruption === 'symlink') {
          const external = join(root, 'external.json');
          await copyFile(path, external);
          await chmod(external, 0o600);
          await rm(path);
          await symlink(external, path);
        }
        if (corruption === 'fifo') {
          await rm(path);
          await execute('mkfifo', ['-m', '600', path]);
          // Own child only: a regression cannot hang this test process on FIFO open.
          await execute(process.execPath, [join(import.meta.dirname, 'read-metadata.fixture.js'), root, output.reference.id], { timeout: remainingMs() });
        } else await assert.rejects(records.read({ reference: output.reference, offset: 0, limit: 1 }), unavailable);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
