import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = { workId: 'work-05', executionId: 'execution-05', invocationId: 'builder-05',
  role: 'builder' as const, environmentRef: 'environment-05', bootRef: 'boot-05', callId: 'call-05' };

test('Records refuses secret-bearing correlation metadata before creating any artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('builder-05');
    await assert.rejects(records.openOutput(context), /PROTECTED_CAPTURE_UNAVAILABLE/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Records does not write a known secret that collides with capture/completion metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('startedAt');
    await assert.rejects(records.openOutput(context), /PROTECTED_CAPTURE_UNAVAILABLE/);
    assert.deepEqual(await readdir(root), []);
    const other = await createRecords({ root });
    const output = await other.openOutput(context);
    other.registerSecret('finishedAt');
    await assert.rejects(output.finish(), /PROTECTED_CAPTURE_UNAVAILABLE/);
    assert.equal((await other.read({ reference: output.reference, offset: 0, limit: 1 })).state, 'partial');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Records fails closed for invalid UTF-8 and cannot subsequently finalize or release a buffered secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  try {
    const records = await createRecords({ root });
    records.registerSecret('synthetic-secret');
    const output = await records.openOutput(context);
    assert.equal(await output.write(Buffer.from('synthetic-')), '');
    await assert.rejects(output.write(Buffer.from([0xff])), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await assert.rejects(output.write(Buffer.from('secret')), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await assert.rejects(output.finish(), /PROTECTED_CAPTURE_UNAVAILABLE/);
    const partial = await records.read({ reference: output.reference, offset: 0, limit: 100 });
    assert.equal(partial.state, 'partial');
    assert.equal(partial.data.byteLength, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Records refuses nonprivate and symlinked roots and traversal references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-05-'));
  const alias = `${root}-link`;
  try {
    await symlink(root, alias);
    await assert.rejects(createRecords({ root: alias }), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await chmod(root, 0o755);
    await assert.rejects(createRecords({ root }), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await chmod(root, 0o700);
    const records = await createRecords({ root });
    await assert.rejects(records.read({ reference: { workId: '../escape', id: 'invalid' }, offset: 0, limit: 1 }), /PROTECTED_CAPTURE_UNAVAILABLE/);
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }); }
});
