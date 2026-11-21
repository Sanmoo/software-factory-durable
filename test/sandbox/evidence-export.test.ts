import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';

// Ticket 17: before an environment is removed, the guest-written evidence that sustains retained records (review captures, preserved
// request/instruction versions) is copied out by confined, no-follow host reads. Factory seeds and the agent's output copies are not.
const environment = `env-${createHash('sha256').update('export-work').digest('hex')}` as EnvironmentRef;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, 'environments', environment, 'artifacts');
  const write = async (path: string, text: string) => {
    await mkdir(join(artifacts, path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(join(artifacts, path), text, { mode: 0o600 });
  };
  await write('review/r1/index.json', '{"round":1}');
  await write('review/r1/diff.patch', 'diff --git a b');
  await write('spec/v1/ticket.json', '{"spec":1}');
  await write('instructions/v1/AGENTS.md', '# rules');
  await write('factory/skill-pack/factory-skills-v5/manifest.json', '{}');
  await write('factory-output-11111111-1111-4111-8111-111111111111.txt', 'copy of a protected record');
  const destination = join(root, 'destination');
  await mkdir(destination, { mode: 0o700 });
  return { root, artifacts, destination, sandbox: createSandbox({ root }) };
}
const list = async (dir: string, prefix = ''): Promise<string[]> =>
  (
    await Promise.all(
      (await readdir(join(dir, prefix), { withFileTypes: true })).map(entry =>
        entry.isDirectory() ? list(dir, join(prefix, entry.name)) : [join(prefix, entry.name)],
      ),
    )
  )
    .flat()
    .sort();

test('exportEvidence copies only review captures and preserved request/instruction versions', async t => {
  const f = await fixture(t);
  const result = await f.sandbox.exportEvidence({ environment, destination: f.destination });
  assert.deepEqual(result, { status: 'success', files: 4, bytes: 11 + 14 + 10 + 7 });
  assert.deepEqual(await list(f.destination), ['instructions/v1/AGENTS.md', 'review/r1/diff.patch', 'review/r1/index.json', 'spec/v1/ticket.json']);
  assert.equal(await readFile(join(f.destination, 'review/r1/index.json'), 'utf8'), '{"round":1}');
});

test('exportEvidence refuses a guest symlink instead of following it, and reports a removed artifacts tree as absent', async t => {
  const f = await fixture(t);
  await symlink('/etc/passwd', join(f.artifacts, 'review/r1/leak'));
  const result = await f.sandbox.exportEvidence({ environment, destination: f.destination });
  assert.equal(result.status, 'failure');
  assert.equal(result.status === 'failure' && result.code, 'EVIDENCE_UNSAFE');
  await rm(f.artifacts, { recursive: true });
  assert.deepEqual(await f.sandbox.exportEvidence({ environment, destination: join(f.root, 'other') }), { status: 'absent' });
  assert.deepEqual(await f.sandbox.exportEvidence({ environment: 'env-../x' as EnvironmentRef, destination: f.destination }), {
    status: 'failure',
    code: 'ENVIRONMENT_REF_INVALID',
  });
});
