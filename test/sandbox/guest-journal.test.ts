import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetBuildId } from '../../src/sandbox/guest-journal.js';
import { journalState } from '../../src/sandbox/filesystem.js';
import { deriveJournaledGuestAssets } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// Ticket 47: the journaled guest asset version is DERIVED from a pinned one (Gondolin 0.14's builder hard-codes `-O ^has_journal`).
// Tiny new fixture images with the native e2fsprogs; no VM, no download, never the real assets.
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const native = () => ({ stdio: 'pipe' as const, timeout: remainingMs() });
const tools = await Promise.all(
  ['/usr/bin/mke2fs', '/usr/bin/tune2fs', '/usr/bin/e2fsck', '/usr/bin/resize2fs'].map(path =>
    access(path).then(
      () => true,
      () => false,
    ),
  ),
);

test('ticket 47: the manifest buildId is Gondolin 0.14 computeAssetBuildId (the published assets34 manifest reproduces)', () => {
  assert.equal(
    assetBuildId(
      {
        kernel: '456e0691f095285a82533cc6335280e4b4991d630c5292ddf15e6320e71971c9',
        initramfs: 'dd007247957ea2d89163083ab9a2df63921445bae0fafe45ef9f03c84d4f6bfd',
        rootfs: 'c269617f655186f224b1970b1995aeab53951a51789d80258e38d319cf970b5c',
        krunKernel: '8da419440ed6e47e33014a76810656fb2533323a7b7ff85ca2d2397640dac5ef',
        krunInitrd: 'd994915f6fa1020492aaf3e154e89c3fac9c32eed94c28aaf20f9e1c9a5d5650',
      },
      'x86_64',
    ),
    '541fc455-59d8-5358-8d26-5cc416a53a92',
  );
});

test(
  'ticket 47: a journal-less pinned asset version derives a NEW version with a journaled root; the source is untouched',
  { skip: !tools.every(Boolean) },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-guest-journal-'));
    try {
      const source = join(dir, 'assets34', 'assets');
      execFileSync('/usr/bin/mkdir', ['-p', source], native());
      const rootfs = join(source, 'rootfs.ext4');
      execFileSync('/usr/bin/truncate', ['-s', '24M', rootfs], native());
      execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-b', '4096', '-m', '0', '-O', '^has_journal', '-F', rootfs], native());
      for (const name of ['vmlinuz-virt', 'initramfs.cpio.lz4', 'krun-kernel']) await writeFile(join(source, name), name);
      const checksums = {
        kernel: hash('vmlinuz-virt'),
        initramfs: hash('initramfs.cpio.lz4'),
        rootfs: hash(await readFile(rootfs)),
        krunKernel: hash('krun-kernel'),
      };
      const manifest = JSON.stringify(
        {
          version: 1,
          buildId: 'old',
          config: { arch: 'x86_64', distro: 'alpine' },
          buildTime: '2026-11-14T00:00:00.000Z',
          assets: { kernel: 'vmlinuz-virt', initramfs: 'initramfs.cpio.lz4', rootfs: 'rootfs.ext4', krunKernel: 'krun-kernel' },
          checksums,
        },
        null,
        2,
      );
      await writeFile(join(source, 'manifest.json'), manifest);
      const before = hash(await readFile(rootfs));
      const output = join(dir, 'assets35', 'assets');
      execFileSync('/usr/bin/mkdir', [join(dir, 'assets35')], native());
      const derived = await deriveJournaledGuestAssets({
        source: { directory: source, manifestSha256: hash(manifest) },
        output,
        journalMiB: 8,
        now: new Date('2026-11-19T12:00:00Z'),
      });
      assert.equal(hash(await readFile(rootfs)), before, 'the source asset version is never modified');
      assert.deepEqual(await journalState(join(output, 'rootfs.ext4')), { journal: true, needsRecovery: false });
      const written = await readFile(join(output, 'manifest.json'), 'utf8');
      assert.equal(derived.pin.manifestSha256, hash(written));
      const parsed = JSON.parse(written);
      assert.deepEqual(Object.keys(parsed), ['version', 'buildId', 'config', 'buildTime', 'assets', 'checksums'], 'the Gondolin manifest format');
      assert.deepEqual(
        [parsed.checksums.kernel, parsed.checksums.initramfs, parsed.checksums.krunKernel],
        [checksums.kernel, checksums.initramfs, checksums.krunKernel],
      );
      assert.notEqual(parsed.checksums.rootfs, checksums.rootfs);
      assert.equal(parsed.buildId, assetBuildId(parsed.checksums, 'x86_64'));
      execFileSync('/usr/bin/e2fsck', ['-f', '-n', join(output, 'rootfs.ext4')], native());
      assert.match(execFileSync('/usr/bin/dumpe2fs', ['-h', join(output, 'rootfs.ext4')], { ...native(), encoding: 'utf8' }), /Total journal size:\s+8M/);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'assets35', 'provenance.json'), 'utf8')).previous, {
        directory: source,
        manifestSha256: hash(manifest),
      });
      await assert.rejects(deriveJournaledGuestAssets({ source: derived.pin, output: join(dir, 'assets36', 'assets') }), /SOURCE_ROOTFS_ALREADY_JOURNALED/);
      await assert.rejects(
        deriveJournaledGuestAssets({ source: { directory: source, manifestSha256: hash(manifest) }, output }),
        /EEXIST/,
        'never into an existing version',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
