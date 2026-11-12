import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, link, symlink, rename, unlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSandbox } from '../../src/sandbox/index.js';

const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', diskGiB: 1 };
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
type Projection = { configuredVirtualBytes: string; minFreeBytes: string;
  disk: { status: string; virtualBytes?: string; allocatedBytes?: string };
  workspace: { status: string; logicalBytes?: string; allocatedBytes?: string };
  artifacts: { status: string; logicalBytes?: string; allocatedBytes?: string };
  filesystem: { status: string; availableBytes?: string } };

test('Sandbox.observe exposes measured disk/workspace storage without boot or following aliases', { skip: !testRoot }, async t => {
  const root = await mkdtemp(join(testRoot!, 'storage-'));
  try {
    const assets = join(root, 'assets'); await mkdir(assets, { mode: 0o700 });
    const raw = join(assets, 'rootfs.ext4');
    execFileSync('/usr/bin/qemu-img', ['create', '-f', 'raw', raw, '32M'], { stdio: 'pipe' });
    execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-O', '^has_journal', '-F', raw], { stdio: 'pipe' });
    await writeFile(join(assets, 'kernel'), 'kernel'); await writeFile(join(assets, 'initramfs'), 'initramfs');
    const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
      assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs.ext4' },
      checksums: { kernel: hash('kernel'), initramfs: hash('initramfs'), rootfs: hash(await readFile(raw)) } });
    await writeFile(join(assets, 'manifest.json'), manifest);
    const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } });
    const prepared = await sandbox.prepare({ workId: 'storage-observation', configuration });
    assert.equal(prepared.status, 'success'); if (prepared.status !== 'success') return;
    const environment = prepared.environment, directory = join(root, 'environments', environment);
    const workspace = join(directory, 'workspace'), disk = join(directory, 'root.qcow2');
    await writeFile(join(workspace, 'owned'), 'a'.repeat(128));
    await link(join(workspace, 'owned'), join(workspace, 'same-inode'));
    const foreign = join(root, 'foreign'); await mkdir(foreign); await writeFile(join(foreign, 'data'), 'b'.repeat(65536));
    await symlink(foreign, join(workspace, 'escape'));
    const observed = await sandbox.observe({ environment });
    assert.equal(observed.cessationConfirmed, false, 'storage never manufactures no-VM or cessation proof');
    assert.ok('storage' in observed, 'public observation must expose storage, not private qualification-only metrics');
    const storage = observed.storage as Projection;
    assert.equal(storage.configuredVirtualBytes, '1073741824'); assert.equal(storage.minFreeBytes, '4294967296');
    assert.equal(storage.disk.status, 'observed'); assert.equal(storage.disk.virtualBytes, '1073741824');
    assert.ok(BigInt(storage.disk.allocatedBytes!) > 0n && BigInt(storage.disk.allocatedBytes!) < 1073741824n);
    assert.equal(storage.workspace.status, 'observed'); assert.equal(storage.workspace.logicalBytes, '128', 'unique inode once; no symlink target');
    const nativeUsage = execFileSync('/usr/bin/du', ['-s', '--block-size=1', workspace], { encoding: 'utf8' }).split(/\s+/)[0];
    assert.equal(storage.workspace.allocatedBytes, nativeUsage, 'independent native allocation observation');
    assert.equal(storage.artifacts.status, 'observed'); assert.equal(storage.artifacts.logicalBytes, '0');
    assert.equal(storage.filesystem.status, 'observed'); assert.ok(BigInt(storage.filesystem.availableBytes!) > 0n);
    assert.ok(!JSON.stringify(storage).includes(root), 'no host paths or supervisor details in storage projection');
    const held = join(directory, 'workspace-held'); await rename(workspace, held); await symlink(foreign, workspace);
    const aliased = await sandbox.observe({ environment }); assert.ok('storage' in aliased);
    assert.equal((aliased.storage as Projection).workspace.status, 'unavailable');
    assert.equal(hash(await readFile(join(foreign, 'data'))), hash('b'.repeat(65536)));
    await unlink(workspace); await rename(held, workspace);
    const saved = disk + '.saved'; await rename(disk, saved);
    execFileSync('/usr/bin/mkfifo', [disk]);
    const fifo = await sandbox.observe({ environment }); assert.ok('storage' in fifo);
    assert.equal((fifo.storage as Projection).disk.status, 'unavailable', 'FIFO cannot hang or report zero usage');
    assert.equal(fifo.cessationConfirmed, false);
    await unlink(disk); await rename(saved, disk);
    const victim = join(workspace, 'victim'), moved = join(workspace, 'victim-moved');
    await mkdir(victim); await writeFile(join(victim, 'owned'), 'owned');
    const nativeOpen = fs.open;
    let injected = false, outsideOpened = false;
    const mutation = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (!injected && typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/') &&
          args[0].endsWith('/victim') && typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY)) {
        injected = true;
        // Model the guest replacing a directory after lstat, before its open.
        await rename(victim, moved); await symlink(foreign, victim);
        const opened = await Reflect.apply(nativeOpen, fs, args);
        if (await readlink(`/proc/self/fd/${opened.fd}`) === foreign) outsideOpened = true;
        return opened;
      }
      return Reflect.apply(nativeOpen, fs, args);
    });
    syncBuiltinESMExports();
    try {
      const raced = await sandbox.observe({ environment }); assert.ok('storage' in raced);
      assert.equal(injected, true); assert.equal(outsideOpened, false, 'NOFOLLOW must prevent opening the foreign directory');
      assert.equal((raced.storage as Projection).workspace.status, 'unavailable');
    } finally {
      mutation.mock.restore(); syncBuiltinESMExports();
      if (injected) { await unlink(victim); await rename(moved, victim); }
    }
    let nested = workspace;
    for (let i = 0; i < 34; i++) { nested = join(nested, 'deep'); await mkdir(nested); }
    const bounded = await sandbox.observe({ environment }); assert.ok('storage' in bounded);
    assert.equal((bounded.storage as Projection).workspace.status, 'unavailable', 'bounded scan is not a partial total');
    assert.equal((bounded.storage as Projection).disk.status, 'observed', 'one unavailable sample does not suppress independent samples');
  } finally { await rm(root, { recursive: true, force: true }); }
});
