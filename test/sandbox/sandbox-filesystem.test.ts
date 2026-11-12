import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createSandbox, type BootRef } from '../../src/sandbox/index.js';

const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', diskGiB: 1 };
const oldBoot = 'boot-cccccccc-2222-4333-8444-555555555555' as BootRef;
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const native = { stdio: 'pipe' as const, timeout: 10000 };

async function shortRoot() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const root = join(dirname(testRoot!), randomBytes(1).toString('hex'));
    try { await mkdir(root, { mode: 0o700 }); return root; }
    catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e; }
  }
  throw new Error('NO_NEW_SHORT_FILESYSTEM_TEST_ROOT');
}

for (const variant of ['valid', 'corrupt', 'short-filesystem', 'backing-file', 'prior-unknown'] as const) {
  test(`Sandbox.start validates preserved ext4 before manager actuation: ${variant} (real disks, no VM)`, { skip: !testRoot }, async () => {
    const root = await shortRoot();
    const previousPath = process.env.PATH;
    try {
      const assets = join(root, 'assets');
      await mkdir(assets, { mode: 0o700 });
      const raw = join(assets, 'rootfs.ext4');
      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'raw', raw, '32M'], native);
      execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-O', '^has_journal', '-F', raw], native);
      for (const name of ['kernel', 'initramfs']) await writeFile(join(assets, name), name);
      const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
        assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs.ext4' },
        checksums: { kernel: hash('kernel'), initramfs: hash('initramfs'), rootfs: hash(await readFile(raw)) } });
      await writeFile(join(assets, 'manifest.json'), manifest);
      const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } });
      const prepared = await sandbox.prepare({ workId: 'filesystem-check-work', configuration });
      assert.equal(prepared.status, 'success');
      if (prepared.status !== 'success') return;
      const environment = prepared.environment;
      const directory = join(root, 'environments', environment);
      const disk = join(directory, 'root.qcow2');
      if (variant === 'short-filesystem') {
        execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, disk], native);
        execFileSync('/usr/bin/qemu-img', ['resize', '-f', 'qcow2', disk, '1G'], native);
      } else if (variant === 'corrupt') {
        const damaged = join(root, 'damaged.ext4');
        execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, damaged], native);
        const file = await open(damaged, 'r+');
        try { await file.write(Buffer.alloc(2), 0, 2, 1024 + 0x38); } finally { await file.close(); }
        execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', damaged, disk], native);
      } else if (variant === 'backing-file') {
        await rm(disk);
        execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-F', 'raw', '-b', raw, disk, '1G'], native);
      }
      const file = await open(disk, 'r+');
      try { await file.chmod(0o600); } finally { await file.close(); }
      const before = hash(await readFile(disk));
      const old = join(directory, oldBoot);
      const unit = `factory-sandbox-${oldBoot}.service`;
      const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`;
      await mkdir(old, { mode: 0o700 });
      const json = (name: string, value: unknown) => writeFile(name, JSON.stringify(value), { mode: 0o600 });
      await json(join(directory, 'current.json'), { version: 1, environment, boot: oldBoot });
      await json(join(old, 'identity.json'), { version: 1, environment, boot: oldBoot, unit, configuration,
        hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() });
      await json(join(old, 'started.json'), { version: 1, boot: oldBoot, unit, invocation: 'a'.repeat(32), cgroup: group,
        cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') });
      const bin = join(root, 'bin');
      await mkdir(bin, { mode: 0o700 });
      await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const active = ${JSON.stringify(variant === 'prior-unknown')};
console.log('LoadState=loaded\\nActiveState=' + (active ? 'active' : 'inactive') + '\\nMainPID=0\\nInvocationID=${'a'.repeat(32)}\\nControlGroup=' + (active ? ${JSON.stringify(group)} : '') + '\\nResult=success');
`, { mode: 0o700 });
      await writeFile(join(bin, 'systemd-run'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'manager-request'))}, 'synthetic request only');
process.exit(77);
`, { mode: 0o700 });
      process.env.PATH = bin; // All disk helpers fixed paths; no real manager fallback.
      const result = await sandbox.start({ environment, configuration });
      assert.equal(hash(await readFile(disk)), before, 'checking must never repair or rewrite preserved data');
      if (variant === 'valid') {
        assert.equal(result.status, 'indeterminate'); // Deliberately refused manager double; not an operational boot.
        assert.equal((await readdir(root)).includes('manager-request'), true);
        assert.notEqual((JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'))).boot, oldBoot);
      } else {
        assert.equal((await readdir(root)).includes('manager-request'), false);
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')), { version: 1, environment, boot: oldBoot });
        if (result.status === 'success') assert.fail('unverified filesystem must not start');
        assert.equal(result.code, variant === 'prior-unknown' ? 'PREVIOUS_BOOT_NOT_STOPPED' : 'PRESERVED_DISK_CHECK_REQUIRED');
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
}
