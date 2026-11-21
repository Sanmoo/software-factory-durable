import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSandbox } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

const root = process.env.FACTORY_SANDBOX_TEST_ROOT;
const assets = process.env.FACTORY_SANDBOX_REAL_ASSETS;
const manifestSha256 = process.env.FACTORY_SANDBOX_MANIFEST_SHA256;

// External SDK seam probe, deliberately not acceptance of unimplemented Sandbox.start/stop.
// VM qualification stays quarantined during the local-tooling restart. Environment
// variables alone must not enable it; the local timeout policy does not cover VMs.
test(
  'pinned Gondolin KVM preserves disk and RealFS workspace across two distinct boots',
  {
    skip: true,
    timeout: remainingMs(),
  },
  async () => {
    for (const name of ['TMPDIR', 'XDG_CACHE_HOME', 'GONDOLIN_SESSIONS_DIR']) {
      assert.ok(process.env[name]?.startsWith(`${root}/`), `${name} must be confined to the explicit test root`);
    }
    const report = await createSandbox({ root: root!, guestAssets: { directory: assets!, manifestSha256: manifestSha256! } }).validate({
      schemaVersion: 1,
      profile: 'gondolin-qemu-alpine-dev-v1',
    });
    assert.equal(report.checks.filter(check => check.id.startsWith('guest-assets:') && check.status === 'ok').length, 4);
    const { VM, RealFSProvider } = await import('@earendil-works/gondolin');
    const directory = await mkdtemp(join(root!, 'gondolin-persistence-'));
    await mkdir(join(directory, 'workspace'), { mode: 0o700 });
    const disk = join(directory, 'root.qcow2');
    const manifest = JSON.parse(await readFile(join(assets!, 'manifest.json'), 'utf8'));
    execFileSync('qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', join(assets!, manifest.assets.rootfs), disk]);
    const marker = randomUUID();
    const create = () =>
      VM.create({
        sandbox: {
          vmm: 'qemu',
          qemuPath: '/usr/bin/qemu-system-x86_64',
          imagePath: {
            kernelPath: join(assets!, manifest.assets.kernel),
            initrdPath: join(assets!, manifest.assets.initramfs),
            rootfsPath: join(assets!, manifest.assets.rootfs),
          },
          rootDiskPath: disk,
          rootDiskFormat: 'qcow2',
          rootDiskDeleteOnClose: false,
          accel: 'kvm',
          netEnabled: false,
          autoRestart: false,
        },
        memory: '2048M',
        cpus: 2,
        tmpfs: {},
        rootfs: { size: '40G' },
        startTimeoutMs: 60_000,
        vfs: { mounts: { '/workspace': new RealFSProvider(join(directory, 'workspace')) } },
      });
    let vm: InstanceType<typeof VM> | undefined;
    let completed = false;
    try {
      vm = await create();
      await vm.start();
      const first = vm.id;
      const pid = vm.getHostPid();
      assert.ok(pid);
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      assert.ok(command.includes('\0-accel\0kvm\0'));
      const written = await vm.exec(
        `printf '%s' '${marker}' > /root/persist; printf '%s' '${marker}' > /tmp/persist; printf '%s' '${marker}' > /workspace/persist; sync`,
      );
      assert.equal(written.exitCode, 0, written.stderr);
      await vm.close();
      vm = undefined;
      execFileSync('qemu-img', ['check', '-f', 'qcow2', disk]);
      vm = await create();
      await vm.start();
      assert.notEqual(vm.id, first);
      const result = await vm.exec('cat /root/persist; echo; cat /tmp/persist; echo; cat /workspace/persist');
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${marker}\n${marker}\n${marker}`);
      await vm.exec('sync');
      await vm.close();
      vm = undefined;
      execFileSync('qemu-img', ['check', '-f', 'qcow2', disk]);
      completed = true;
    } finally {
      if (vm) await vm.close();
      // Preserve incomplete resources for host reconciliation instead of deleting on an uncertain stop.
      if (completed) await rm(directory, { recursive: true });
    }
  },
);
