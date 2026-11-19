import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprintCheckout } from '../../src/sandbox/checkout-fingerprint.js';

// Ticket 48: the Host fingerprint of a Work checkout (confined reads + bounded no-follow walk; no host git, no guest command) changes with
// commits and with edits of the working tree, not with build output, and never follows a link.

async function environment(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'fingerprint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'workspace', 'checkout');
  await mkdir(join(checkout, '.git', 'refs', 'heads', 'factory'), { recursive: true });
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/factory/3-x\n');
  await writeFile(join(checkout, '.git', 'refs', 'heads', 'factory', '3-x'), `${'a'.repeat(40)}\n`);
  await writeFile(join(checkout, '.git', 'index'), 'index-1');
  await writeFile(join(checkout, 'src', 'Main.java'), 'class Main {}');
  return { dir, checkout };
}
const observed = async (dir: string) => {
  const value = await fingerprintCheckout(dir);
  assert.equal(value.status, 'observed');
  return value as Extract<typeof value, { status: 'observed' }>;
};

test('ticket 48: same checkout, same fingerprint; a commit changes HEAD\'s ref; an edit changes the tree; build output does not', async t => {
  const { dir, checkout } = await environment(t);
  const first = await observed(dir);
  assert.deepEqual([first.head, first.ref], ['ref: refs/heads/factory/3-x', 'a'.repeat(40)]);
  const again = await observed(dir);
  assert.deepEqual([again.git, again.tree, again.ref], [first.git, first.tree, first.ref]);
  await mkdir(join(checkout, 'build', 'classes'), { recursive: true });
  await writeFile(join(checkout, 'build', 'classes', 'Main.class'), 'bytes');
  await mkdir(join(checkout, 'module', '.gradle'), { recursive: true });
  await writeFile(join(checkout, 'module', '.gradle', 'cache.bin'), 'cache');
  const built = await observed(dir);
  assert.equal(built.git, first.git);
  // The new `module` directory itself is a tree change; its `.gradle` content is not walked.
  await writeFile(join(checkout, 'module', '.gradle', 'cache.bin'), 'cache changed');
  assert.equal((await observed(dir)).tree, built.tree, 'cache content is not progress');
  await writeFile(join(checkout, 'src', 'Main.java'), 'class Main { int x; }');
  const edited = await observed(dir);
  assert.notEqual(edited.tree, built.tree, 'an uncommitted edit changes the checkout');
  await writeFile(join(checkout, '.git', 'refs', 'heads', 'factory', '3-x'), `${'b'.repeat(40)}\n`);
  const committed = await observed(dir);
  assert.deepEqual([committed.ref, committed.git === edited.git], ['b'.repeat(40), false]);
});

test('ticket 48: a packed branch ref is read; links are never followed; an over-large tree has no tree hash; a missing HEAD is unavailable', async t => {
  const { dir, checkout } = await environment(t);
  await rm(join(checkout, '.git', 'refs', 'heads', 'factory', '3-x'));
  await writeFile(join(checkout, '.git', 'packed-refs'), `# pack-refs with: peeled\n${'c'.repeat(40)} refs/heads/factory/3-x\n`);
  assert.equal((await observed(dir)).ref, 'c'.repeat(40));
  const outside = await mkdtemp(join(tmpdir(), 'fingerprint-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'one');
  await symlink(outside, join(checkout, 'link'));
  const linked = await observed(dir);
  await writeFile(join(outside, 'secret.txt'), 'two, longer');
  await utimes(join(outside, 'secret.txt'), new Date(0), new Date(0));
  assert.equal((await observed(dir)).tree, linked.tree, 'the link target is never read or walked');
  const bounded = await fingerprintCheckout(dir, { entries: 2, metadataBytes: 1024 * 1024 });
  assert.deepEqual([bounded.status, bounded.status === 'observed' ? bounded.tree : 'x'], ['observed', null]);
  await rm(join(checkout, '.git', 'HEAD'));
  assert.deepEqual(await fingerprintCheckout(dir), { status: 'unavailable', code: 'CHECKOUT_HEAD_MISSING' });
});
