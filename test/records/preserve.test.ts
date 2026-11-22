import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveEvidence } from '../../src/records/index.js';

// Ticket 17 (Q8 `preserve`): evidence that must survive cleanup is staged into a NEW protected directory of the Work, hashed into a
// manifest and synced before a reference is returned. Not a documentary collector: only what the stage callback wrote.
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function root(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-preserve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('preserveEvidence writes a manifest with per-file sha256 under <root>/<work>/evidence/<id> and returns its reference', async t => {
  const dir = await root(t);
  const result = await preserveEvidence({
    root: dir,
    workId: 'work-1',
    label: 'env-x',
    stage: async destination => {
      await mkdir(join(destination, 'review/r1'), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, 'review/r1/index.json'), '{"round":1}', { mode: 0o600 });
    },
  });
  assert.equal(result.status, 'preserved');
  if (result.status !== 'preserved') return;
  const directory = join(dir, 'work-1', 'evidence', result.reference.id);
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(manifest), {
    version: 1,
    kind: 'environment-evidence',
    label: 'env-x',
    files: [{ path: 'files/review/r1/index.json', bytes: 11, sha256: sha('{"round":1}') }],
    totalBytes: 11,
  });
  assert.deepEqual(result.reference, { workId: 'work-1', id: result.reference.id, manifestSha256: sha(manifest), files: 1, bytes: 11 });
  assert.equal((await stat(directory)).mode & 0o077, 0, 'private');
});

test('a failed stage leaves no reference and no half-written evidence directory', async t => {
  const dir = await root(t);
  const result = await preserveEvidence({
    root: dir,
    workId: 'work-1',
    label: 'env-x',
    stage: async destination => {
      await writeFile(join(destination, 'partial'), 'x');
      throw new Error('EVIDENCE_UNSAFE');
    },
  });
  assert.deepEqual(result, { status: 'failed', code: 'EVIDENCE_UNSAFE' });
  assert.deepEqual(await readdir(join(dir, 'work-1', 'evidence')), []);
  assert.deepEqual(await preserveEvidence({ root: dir, workId: '../escape', label: 'x', stage: async () => {} }), {
    status: 'failed',
    code: 'EVIDENCE_REFERENCE_INVALID',
  });
});
