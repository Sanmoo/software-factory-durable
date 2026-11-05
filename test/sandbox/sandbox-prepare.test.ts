import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSandbox } from '../../src/sandbox/index.js';

const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
test('Sandbox.prepare creates a real standalone persistent disk idempotently and refuses incompatible reuse', { skip: !testRoot }, async () => {
  const root = await mkdtemp(join(testRoot!, 'factory-prepare-'));
  try {
    const assets = join(root, 'assets');
    await mkdir(assets);
    // Real qemu-img input, deliberately not a bootable guest or isolation proof.
    execFileSync('qemu-img', ['create', '-f', 'raw', join(assets, 'rootfs.ext4'), '4M']);
    await writeFile(join(assets, 'kernel'), 'kernel');
    await writeFile(join(assets, 'initrd'), 'initrd');
    const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
      assets: { kernel: 'kernel', initramfs: 'initrd', rootfs: 'rootfs.ext4' },
      checksums: { kernel: hash('kernel'), initramfs: hash('initrd'), rootfs: hash(await readFile(join(assets, 'rootfs.ext4'))) } });
    await writeFile(join(assets, 'manifest.json'), manifest);
    const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } });
    const first = await sandbox.prepare({ workId: 'work-03', configuration });
    assert.equal(first.status, 'success');
    const repeated = await sandbox.prepare({ workId: 'work-03', configuration });
    assert.deepEqual(repeated, first);
    assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration: { ...configuration, diskGiB: 41 } }),
      { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH' });
    assert.deepEqual(await sandbox.prepare({ workId: 'work-03', configuration: { ...configuration, accel: 'tcg' } }),
      { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
