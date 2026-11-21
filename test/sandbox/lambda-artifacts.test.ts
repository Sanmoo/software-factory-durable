import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLambdaArtifacts, observeLambdaProposal, restoreLambdaArtifacts, uploadLambdaSeeds, verifyLambdaPreservedSource, type GuestRoots } from '../../src/sandbox/lambda/artifacts.js';
import { observeProposal } from '../../src/sandbox/proposal-identity.js';
import type { LambdaChannel } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 06 (Operator decisions 1A, 2b-A, 2c): the fixed programs that replace the host reads of the workspace, run with the LOCAL
// interpreter against a temporary tree standing for the guest disk. No guest, no channel: the transport is a local process.
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A channel whose guest is this host: each program runs as a local bash process. */
const localChannel = (): LambdaChannel => ({
  async exec(request) {
    const run = spawnSync('/bin/bash', ['-c', request.script], { input: Buffer.from(request.stdin ?? []), encoding: 'utf8', timeout: remainingMs(), maxBuffer: 256 * 1024 * 1024 });
    return { status: 'exited', exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  },
  close() {},
});

/** A guest disk with a handed-off proposal of round 1: two indexed files and the Git metadata the identity covers. */
async function guestDisk(t: TestContext) {
  const environment = await mkdtemp(join(tmpdir(), 'factory-lambda-artifacts-'));
  t.after(() => rm(environment, { recursive: true, force: true }));
  const checkout = join(environment, 'workspace', 'checkout'), artifacts = join(environment, 'artifacts');
  const head = 'a'.repeat(40);
  await mkdir(join(checkout, '.git', 'refs', 'heads', 'factory'), { recursive: true });
  await mkdir(join(checkout, 'docs'), { recursive: true });
  await mkdir(join(artifacts, 'review', 'r1'), { recursive: true });
  await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/factory/work-1\n');
  await writeFile(join(checkout, '.git', 'index'), 'index-bytes');
  await writeFile(join(checkout, '.git', 'refs', 'heads', 'factory', 'work-1'), `${head}\n`);
  await writeFile(join(checkout, 'docs', 'a.md'), 'first\n');
  await writeFile(join(checkout, 'b.txt'), 'second\n');
  const entries = [{ path: 'docs/a.md', present: true, kind: 'file', sha256: sha('first\n') }, { path: 'b.txt', present: true, kind: 'file', sha256: sha('second\n') },
    { path: 'gone.txt', present: false }];
  const index = JSON.stringify({ round: 1, head, branch: 'factory/work-1', counts: { entries: entries.length }, entries });
  await writeFile(join(artifacts, 'review', 'r1', 'index.json'), index);
  const roots: GuestRoots = { checkout, artifacts, python: 'python3' };
  return { environment, checkout, artifacts, roots, index };
}

test('the proposal identity computed in the guest answers like the host read: same index hash, consistent, and it changes when an indexed file changes', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  const before = await observeLambdaProposal(channel, 1, disk.roots);
  const host = await observeProposal(disk.environment, 1);
  assert.equal(before.status, 'observed', JSON.stringify(before));
  assert.equal(host.status, 'observed');
  if (before.status !== 'observed' || host.status !== 'observed') return;
  assert.deepEqual([before.indexSha256, before.entries, before.consistent], [host.indexSha256, host.entries, host.consistent]);
  assert.equal(before.indexSha256, sha(disk.index));
  assert.equal(before.consistent, true);
  // Unchanged proposal: the same identity twice.
  const again = await observeLambdaProposal(channel, 1, disk.roots);
  assert.equal(again.status === 'observed' && again.sha256, before.sha256);
  // The Builder (or anything else in the guest) changes an indexed file during the review: the identity moves and is no longer consistent.
  await writeFile(join(disk.checkout, 'docs', 'a.md'), 'changed\n');
  const after = await observeLambdaProposal(channel, 1, disk.roots);
  assert.equal(after.status, 'observed');
  if (after.status !== 'observed') return;
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(after.consistent, false);
  // A new commit alone (the branch ref moves) also changes it.
  await writeFile(join(disk.checkout, 'docs', 'a.md'), 'first\n');
  await writeFile(join(disk.checkout, '.git', 'refs', 'heads', 'factory', 'work-1'), `${'b'.repeat(40)}\n`);
  const moved = await observeLambdaProposal(channel, 1, disk.roots);
  assert.equal(moved.status === 'observed' && moved.sha256 !== before.sha256 && !moved.consistent, true);
});

test('the proposal identity is unavailable without the round index and refused for an index that is not the counted one', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  assert.deepEqual(await observeLambdaProposal(channel, 2, disk.roots), { status: 'unavailable', code: 'PROPOSAL_INDEX_MISSING' });
  await writeFile(join(disk.artifacts, 'review', 'r1', 'index.json'), JSON.stringify({ round: 1, head: 'a'.repeat(40), branch: null, counts: { entries: 2 }, entries: [] }));
  assert.deepEqual(await observeLambdaProposal(channel, 1, disk.roots), { status: 'refused', code: 'PROPOSAL_INDEX_INVALID' });
  assert.deepEqual(await observeLambdaProposal(channel, 0, disk.roots), { status: 'refused', code: 'PROPOSAL_ROUND_INVALID' });
  // A program that gives no answer (the interpreter is missing) is never a guessed identity.
  assert.deepEqual(await observeLambdaProposal(channel, 1, { ...disk.roots, python: '/nonexistent/python3' }), { status: 'unavailable', code: 'PROPOSAL_IDENTITY_UNAVAILABLE' });
});

test('a preserved source is verified only when the version lists the file and the file exists', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  await mkdir(join(disk.artifacts, 'spec', 'v1'), { recursive: true });
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'sources.json'), JSON.stringify({ sources: [{ copy: './ticket.json' }, { copy: 'missing.json' }] }));
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'ticket.json'), '{}');
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'unlisted.json'), '{}');
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/spec/v1/ticket.json#body', disk.roots), { status: 'verified', code: 'PRESERVED_SOURCE_VERIFIED' });
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/spec/v1/unlisted.json', disk.roots), { status: 'invalid', code: 'PRESERVED_SOURCE_NOT_LISTED' });
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/spec/v1/missing.json', disk.roots), { status: 'invalid', code: 'PRESERVED_SOURCE_MISSING' });
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/instructions/v1/a.md', disk.roots), { status: 'invalid', code: 'PRESERVED_SOURCE_INDEX_MISSING' });
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/spec/v1/../v2/x', disk.roots), { status: 'invalid', code: 'AUTHORIZATION_REFERENCE_INVALID' });
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/workspace/checkout/README.md', disk.roots), { status: 'invalid', code: 'AUTHORIZATION_REFERENCE_INVALID' });
});

test('the artifacts collection copies review, spec and instructions to the host as the guest holds them, and nothing else', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  await mkdir(join(disk.artifacts, 'spec', 'v1'), { recursive: true });
  await mkdir(join(disk.artifacts, 'instructions', 'v2'), { recursive: true });
  await mkdir(join(disk.artifacts, 'factory', 'skill-pack', 'p1'), { recursive: true });
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'ticket.json'), '{"body":"x"}');
  await writeFile(join(disk.artifacts, 'instructions', 'v2', 'AGENTS.md'), Buffer.from([0, 255, 10, 13]));
  await writeFile(join(disk.artifacts, 'factory', 'skill-pack', 'p1', 'manifest.json'), '{}');
  await writeFile(join(disk.artifacts, 'factory-output-1.txt'), 'an output copy');
  const destination = await mkdtemp(join(tmpdir(), 'factory-lambda-collected-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const collected = await collectLambdaArtifacts(channel, destination, disk.roots);
  assert.deepEqual(collected, { status: 'success', files: 3, bytes: disk.index.length + 12 + 4 });
  assert.deepEqual((await readdir(destination)).sort(), ['instructions', 'review', 'spec']);
  assert.equal(await readFile(join(destination, 'review', 'r1', 'index.json'), 'utf8'), disk.index);
  assert.deepEqual([...await readFile(join(destination, 'instructions', 'v2', 'AGENTS.md'))], [0, 255, 10, 13]);
  // A link inside an evidence tree fails the whole collection: nothing is followed.
  await symlink('/etc/passwd', join(disk.artifacts, 'spec', 'v1', 'link'));
  const second = await mkdtemp(join(tmpdir(), 'factory-lambda-collected-'));
  t.after(() => rm(second, { recursive: true, force: true }));
  assert.deepEqual(await collectLambdaArtifacts(channel, second, disk.roots), { status: 'failure', code: 'EVIDENCE_UNSAFE' });
  assert.deepEqual(await readdir(second), []);
  assert.deepEqual(await collectLambdaArtifacts(channel, second, { ...disk.roots, artifacts: join(disk.environment, 'no-artifacts') }), { status: 'absent' });
});

test('a seed is written into the guest exactly as its manifest lists it and reported with the manifest hash; a drifted source is never sent', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  const source = await mkdtemp(join(tmpdir(), 'factory-lambda-seed-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(join(source, 'skills', 'pr'), { recursive: true });
  await writeFile(join(source, 'skills', 'pr', 'SKILL.md'), '# pr\n');
  const manifest = JSON.stringify({ files: [{ path: 'skills/pr/SKILL.md', sha256: sha('# pr\n') }] });
  await writeFile(join(source, 'manifest.json'), manifest);
  const seeds = [{ name: 'factory/skill-pack/pack-1', directory: source }];
  assert.deepEqual(await uploadLambdaSeeds(channel, seeds, disk.roots), { status: 'success', seeds: [{ name: 'factory/skill-pack/pack-1', manifestSha256: sha(manifest), reused: false }] });
  const target = join(disk.artifacts, 'factory', 'skill-pack', 'pack-1');
  assert.equal(await readFile(join(target, 'skills', 'pr', 'SKILL.md'), 'utf8'), '# pr\n');
  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), manifest);
  // The same version is never overwritten in a guest that already has it.
  assert.deepEqual(await uploadLambdaSeeds(channel, seeds, disk.roots), { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' });
  await writeFile(join(source, 'skills', 'pr', 'SKILL.md'), '# drifted\n');
  assert.deepEqual(await uploadLambdaSeeds(channel, [{ name: 'factory/skill-pack/pack-2', directory: source }], disk.roots), { status: 'failure', code: 'ARTIFACT_SEED_SOURCE_DRIFT' });
});

// v2 ticket 08 (Operator decision 3D): what one boot collected before its stop is what the next boot gets back, spec and instructions only.
test('the next boot receives exactly the spec and instructions collected before the previous stop, and a preserved source of an earlier round verifies there again', async t => {
  const disk = await guestDisk(t);
  const channel = localChannel();
  await mkdir(join(disk.artifacts, 'spec', 'v1'), { recursive: true });
  await mkdir(join(disk.artifacts, 'spec', 'v2'), { recursive: true });
  await mkdir(join(disk.artifacts, 'instructions', 'v1', 'docs'), { recursive: true });
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'sources.json'), JSON.stringify({ sources: [{ copy: './ticket.json' }] }));
  await writeFile(join(disk.artifacts, 'spec', 'v1', 'ticket.json'), '{"body":"x"}');
  await writeFile(join(disk.artifacts, 'spec', 'v2', 'sources.json'), JSON.stringify({ sources: [] }));
  await writeFile(join(disk.artifacts, 'instructions', 'v1', 'docs', 'AGENTS.md'), Buffer.from([0, 255, 10, 13]));
  await writeFile(join(disk.artifacts, 'factory-output-1.txt'), 'an output copy');
  const collected = await mkdtemp(join(tmpdir(), 'factory-lambda-collected-'));
  t.after(() => rm(collected, { recursive: true, force: true }));
  assert.equal((await collectLambdaArtifacts(channel, collected, disk.roots)).status, 'success');

  // The new boot: an empty guest that already received the skill pack.
  const next = await mkdtemp(join(tmpdir(), 'factory-lambda-next-boot-'));
  t.after(() => rm(next, { recursive: true, force: true }));
  const roots: GuestRoots = { checkout: join(next, 'workspace', 'checkout'), artifacts: join(next, 'artifacts'), python: 'python3' };
  await mkdir(join(roots.artifacts, 'factory', 'skill-pack', 'p1'), { recursive: true });
  assert.deepEqual(await restoreLambdaArtifacts(channel, collected, roots), { status: 'restored', versions: ['spec/v1', 'spec/v2', 'instructions/v1'], files: 4 });
  assert.deepEqual((await readdir(roots.artifacts)).sort(), ['factory', 'instructions', 'spec'], 'no review capture and no output copy comes back');
  assert.equal(await readFile(join(roots.artifacts, 'spec', 'v1', 'ticket.json'), 'utf8'), '{"body":"x"}');
  assert.deepEqual([...await readFile(join(roots.artifacts, 'instructions', 'v1', 'docs', 'AGENTS.md'))], [0, 255, 10, 13]);
  // The end-of-Execution verification of an inherited round reads the same reference in the new boot.
  assert.deepEqual(await verifyLambdaPreservedSource(channel, '/artifacts/spec/v1/ticket.json#body', roots), { status: 'verified', code: 'PRESERVED_SOURCE_VERIFIED' });
  // The Builder can add the next version beside the restored ones.
  await mkdir(join(roots.artifacts, 'spec', 'v3'));
  // Never over a guest that already holds them, and a collection with neither tree restores nothing.
  assert.deepEqual(await restoreLambdaArtifacts(channel, collected, roots), { status: 'failure', code: 'ARTIFACT_RESTORE_CONFLICT' });
  const empty = await mkdtemp(join(tmpdir(), 'factory-lambda-collected-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await mkdir(join(empty, 'review', 'r1'), { recursive: true });
  await writeFile(join(empty, 'review', 'r1', 'index.json'), '{}');
  assert.deepEqual(await restoreLambdaArtifacts(channel, empty, { ...roots, artifacts: join(next, 'other') }), { status: 'restored', versions: [], files: 0 });
  // A link in the host copy is never followed.
  await symlink('/etc/passwd', join(collected, 'spec', 'v1', 'link'));
  assert.deepEqual(await restoreLambdaArtifacts(channel, collected, { ...roots, artifacts: join(next, 'third') }), { status: 'failure', code: 'ARTIFACT_RESTORE_SOURCE_UNSAFE' });
});
