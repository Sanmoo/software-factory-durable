import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { observeProposal } from '../../src/sandbox/proposal-identity.js';

// Sandbox-internal: host identity over a hand-written guest-shaped environment (no git needed; .git files are plain files here).
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function environment(t: { after(fn: () => Promise<void>): void }, entries: { path: string; content?: string }[], counts?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'env', 'workspace', 'checkout');
  await mkdir(join(checkout, '.git', 'refs', 'heads'), { recursive: true });
  await mkdir(join(dir, 'env', 'artifacts', 'review', 'r1'), { recursive: true });
  await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/b\n');
  await writeFile(join(checkout, '.git', 'refs', 'heads', 'b'), `${'b'.repeat(40)}\n`);
  for (const entry of entries) if (entry.content !== undefined) {
    await mkdir(join(checkout, entry.path, '..'), { recursive: true });
    await writeFile(join(checkout, entry.path), entry.content);
  }
  const index = { round: 1, head: 'b'.repeat(40), branch: 'b', counts: { entries: counts ?? entries.length },
    entries: entries.map(entry => ({ path: entry.path, present: entry.content !== undefined, ...(entry.content !== undefined ? { kind: 'file', sha256: sha(entry.content) } : {}) })) };
  await writeFile(join(dir, 'env', 'artifacts', 'review', 'r1', 'index.json'), JSON.stringify(index));
  return { dir, env: join(dir, 'env'), checkout };
}

test('review fix 2: total hashed bytes are bounded; duplicate paths and an entry count differing from the index counts are refused', async t => {
  const big = await environment(t, [{ path: 'a.txt', content: 'x'.repeat(4096) }, { path: 'b.txt', content: 'y'.repeat(4096) }]);
  assert.equal((await observeProposal(big.env, 1)).status, 'observed');
  assert.deepEqual(await observeProposal(big.env, 1, { fileBytes: 1 << 20, totalBytes: 6000 }), { status: 'refused', code: 'PROPOSAL_TOO_LARGE' });
  const duplicate = await environment(t, [{ path: 'a.txt', content: 'x' }, { path: 'a.txt', content: 'x' }]);
  assert.deepEqual(await observeProposal(duplicate.env, 1), { status: 'refused', code: 'PROPOSAL_INDEX_INVALID' });
  const counted = await environment(t, [{ path: 'a.txt', content: 'x' }], 2);
  assert.deepEqual(await observeProposal(counted.env, 1), { status: 'refused', code: 'PROPOSAL_INDEX_INVALID' });
});

test('review fix 3: a parent swapped for a symlink to a host directory is never traversed and no per-path comparison is exposed', async t => {
  const f = await environment(t, [{ path: 'dir/secret.txt', content: 'guest copy' }]);
  const host = join(f.dir, 'host'); await mkdir(host);
  await writeFile(join(host, 'secret.txt'), 'guest copy'); // same bytes as the guest-supplied hash: an oracle would report a match
  await rename(join(f.checkout, 'dir'), join(f.dir, 'moved'));
  await symlink(host, join(f.checkout, 'dir'));
  const identity = await observeProposal(f.env, 1);
  assert.ok(identity.status === 'observed');
  assert.equal(identity.consistent, false, 'the host file behind the swapped parent is not hashed');
  assert.deepEqual(Object.keys(identity).sort(), ['consistent', 'entries', 'indexSha256', 'observedAt', 'sha256', 'status']);
});
