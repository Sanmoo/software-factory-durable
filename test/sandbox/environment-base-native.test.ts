import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSandbox, type PreparationVmInput, type PreparationVmResult } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// Ticket 44 (real e2fsprogs/qemu-img on NEW tiny fixture disks; no VM: the preparation VM double writes a marker file into the candidate base
// disk with debugfs, standing for the packages the guest would install). Proves that the base disk is built from the release template, checked,
// kept standalone, and that each Work environment's root disk is an independent standalone COPY of the base (no backing file). Only with
// FACTORY_SANDBOX_TEST_ROOT (full).
const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', diskGiB: 1 };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const native = () => ({ stdio: 'pipe' as const, timeout: remainingMs(), env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
const declaration = { schemaVersion: 1 as const, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [] };

/** The file `path` inside the ext4 of a qcow2 disk (read-only, through a private raw copy). */
function readInside(disk: string, path: string, work: string): string {
  const raw = join(work, `read-${hash(disk + path).slice(0, 8)}.raw`);
  execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, raw], native());
  try {
    return execFileSync('/usr/bin/debugfs', ['-R', `cat ${path}`, raw], { ...native(), encoding: 'utf8' });
  } finally {
    execFileSync('/usr/bin/rm', ['-f', raw], native());
  }
}

test(
  'real disks: the base is prepared once from the release template, environments are standalone copies of it, replace-disk copies it again',
  { skip: !testRoot },
  async () => {
    const root = await mkdtemp(join(testRoot!, 'factory-env-base-'));
    try {
      const assets = join(root, 'assets');
      await mkdir(assets);
      const template = join(assets, 'rootfs.ext4');
      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'raw', template, '32M'], native());
      execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-O', '^has_journal', '-F', template], native());
      for (const name of ['kernel', 'initrd']) await writeFile(join(assets, name), name);
      const manifest = JSON.stringify({
        version: 1,
        config: { arch: 'x86_64', distro: 'alpine' },
        assets: { kernel: 'kernel', initramfs: 'initrd', rootfs: 'rootfs.ext4' },
        checksums: { kernel: hash('kernel'), initramfs: hash('initrd'), rootfs: hash(await readFile(template)) },
      });
      await writeFile(join(assets, 'manifest.json'), manifest);
      const runs: PreparationVmInput[] = [];
      const preparationVm = {
        async run(input: PreparationVmInput): Promise<PreparationVmResult> {
          runs.push(input);
          // The "guest" installs: a marker file written into the candidate's ext4 (qcow2 → raw → debugfs write → qcow2).
          const raw = join(input.directory, 'vm-double.raw');
          execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', input.disk, raw], native());
          const marker = join(input.directory, 'marker');
          await writeFile(marker, 'openjdk25-jdk-25.0.5.1_p2-r0\n');
          execFileSync('/usr/bin/debugfs', ['-w', '-R', `write ${marker} factory-environment-marker`, raw], native());
          execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, input.disk], native());
          execFileSync('/usr/bin/rm', ['-f', raw, marker], native());
          return {
            status: 'completed',
            exitCode: 0,
            cessation: 'confirmed',
            output: '@@factory-environment:installed\nmusl-1.2.5-r10\nopenjdk25-jdk-25.0.5.1_p2-r0\n@@factory-environment:end\n',
          };
        },
      };
      const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) }, preparationVm });
      const environment = {
        path: '.factory/environment.yaml',
        commit: 'a'.repeat(40),
        sha256: '9'.repeat(64),
        declaration,
        repository: 'acme/project',
        repositoryId: 3,
      };
      const first = await sandbox.prepare({ workId: 'native-1', configuration, environment });
      assert.equal(first.status, 'success', JSON.stringify(first));
      const second = await sandbox.prepare({ workId: 'native-2', configuration, environment });
      assert.ok(first.status === 'success' && second.status === 'success' && first.base && second.base);
      if (first.status !== 'success' || second.status !== 'success' || !first.base) return;
      assert.equal(runs.length, 1);
      assert.equal(second.base?.manifestSha256, first.base.manifestSha256);
      const base = join(root, 'environment-bases', `base-${first.base.base}`, 'base.qcow2');
      for (const env of [first.environment, second.environment]) {
        const disk = join(root, 'environments', env, 'root.qcow2');
        const info = JSON.parse(execFileSync('/usr/bin/qemu-img', ['info', '-f', 'qcow2', '--output=json', disk], { ...native(), encoding: 'utf8' }));
        assert.deepEqual(
          [info.format, info['backing-filename'] ?? null, info['virtual-size']],
          ['qcow2', null, 1073741824],
          'standalone copy of the configured size',
        );
        assert.equal(
          readInside(disk, 'factory-environment-marker', root),
          'openjdk25-jdk-25.0.5.1_p2-r0\n',
          'the environment carries what the preparation installed',
        );
      }
      const raw = join(root, 'check.raw');
      execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', join(root, 'environments', first.environment, 'root.qcow2'), raw], native());
      execFileSync('/usr/bin/e2fsck', ['-f', '-n', raw], native());
      assert.equal(hash(await readFile(template)), JSON.parse(manifest).checksums.rootfs, 'release template unchanged');
      // replace-disk (ticket 47) of an environment created from a base: a new copy of THAT base, not of the generic template.
      const { replacePreservedDisk } = await import('../../src/sandbox/filesystem.js');
      const directory = join(root, 'environments', first.environment);
      const replaced = await replacePreservedDisk(directory, join(directory, 'root.qcow2'), { base }, 1073741824n);
      assert.equal(replaced.status, 'applied', replaced.detail);
      assert.match(replaced.detail, /environment base/);
      assert.equal(readInside(join(directory, 'root.qcow2'), 'factory-environment-marker', root), 'openjdk25-jdk-25.0.5.1_p2-r0\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
