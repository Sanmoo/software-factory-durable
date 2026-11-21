import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSandbox } from '../../src/sandbox/index.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', diskGiB: 1 };
const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
test('Sandbox.prepare creates a real standalone persistent disk idempotently and refuses incompatible reuse', { skip: !testRoot }, async t => {
  const root = await mkdtemp(join(testRoot!, 'factory-prepare-'));
  try {
    const assets = join(root, 'assets');
    await mkdir(assets);
    // Real qemu-img input, deliberately not a bootable guest or isolation proof.
    execFileSync('qemu-img', ['create', '-f', 'raw', join(assets, 'rootfs.ext4'), '32M']);
    execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-O', '^has_journal', '-F', join(assets, 'rootfs.ext4')]);
    await writeFile(join(assets, 'kernel'), 'kernel');
    await writeFile(join(assets, 'initrd'), 'initrd');
    const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const manifest = JSON.stringify({
      version: 1,
      config: { arch: 'x86_64', distro: 'alpine' },
      assets: { kernel: 'kernel', initramfs: 'initrd', rootfs: 'rootfs.ext4' },
      checksums: { kernel: hash('kernel'), initramfs: hash('initrd'), rootfs: hash(await readFile(join(assets, 'rootfs.ext4'))) },
    });
    await writeFile(join(assets, 'manifest.json'), manifest);
    const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } });
    const first = await sandbox.prepare({ workId: 'work-03', configuration });
    assert.equal(first.status, 'success');
    if (first.status !== 'success') return;
    const disk = join(root, 'environments', first.environment, 'root.qcow2');
    const snapshot = join(root, 'checked.raw');
    execFileSync('qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, snapshot]);
    execFileSync('/usr/bin/e2fsck', ['-f', '-n', snapshot], { stdio: 'pipe' });
    const geometry = execFileSync('/usr/bin/dumpe2fs', ['-h', snapshot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const blocks = BigInt(geometry.match(/^Block count:\s+(\d+)$/m)![1]!);
    const blockSize = BigInt(geometry.match(/^Block size:\s+(\d+)$/m)![1]!);
    assert.equal(blocks * blockSize, 1073741824n, 'actual ext4 capacity, not only QEMU virtual capacity');
    assert.equal(hash(await readFile(join(assets, 'rootfs.ext4'))), JSON.parse(manifest).checksums.rootfs, 'pinned template unchanged');
    const repeated = await sandbox.prepare({ workId: 'work-03', configuration });
    assert.deepEqual(repeated, first);
    assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration: { ...configuration, diskGiB: 41 } }), {
      status: 'failure',
      code: 'ENVIRONMENT_CONFIGURATION_MISMATCH',
      detail: 'sandbox.diskGiB 1 -> 41',
    });
    // Ticket 50: guest resources are per boot; the prepared environment is reused as is.
    assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration: { ...configuration, memoryMiB: 4096, vcpus: 4 } }), first);
    assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration: { ...configuration, accel: 'tcg' } }), {
      status: 'failure',
      code: 'SANDBOX_CONFIGURATION_INVALID',
    });
    const statfs = fs.statfs;
    let pressured = true;
    const boundary = t.mock.method(fs, 'statfs', async () => {
      const actual = await statfs(root, { bigint: true });
      return pressured ? { ...actual, bavail: 0n } : actual;
    });
    syncBuiltinESMExports();
    try {
      const before = hash(await readFile(disk));
      assert.equal((await sandbox.validate(configuration)).checks.find(c => c.id === 'storage')?.status, 'blocked');
      assert.deepEqual(await sandbox.prepare({ workId: 'pressure-work', configuration }), { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_PREPARATION' });
      const blocked = join(root, 'environments', `env-${hash('pressure-work')}`);
      await assert.rejects(() => lstat(blocked), { code: 'ENOENT' }, 'known admission refusal must not strand an incomplete environment');
      assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration }), first, 'idempotent lookup needs no new allocation');
      pressured = false;
      assert.equal((await sandbox.prepare({ workId: 'pressure-work', configuration })).status, 'success');
      assert.equal(hash(await readFile(disk)), before, 'no cleanup or rewrite of another environment to create free space');
    } finally {
      boundary.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
