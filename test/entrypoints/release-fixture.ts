import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';

// I-local fixture (ticket 32): the REAL release builder over this development checkout (emitted JS, lockfile closure, private Node, private
// SDK profiles, skill packs) with SYNTHETIC guest assets (non-bootable bytes, pinned by hash), and real host tar extraction into a clean
// canonical root. The extracted release's own private Node runs setup/doctor/run. No VM, network, GitHub, model or credential.
export const manifestSha256 = '9bf9e4c0a3af47bc92a350509f4ddfe7de3d319b5b63ca42a2939ad73b6ef80f';
export const id = 'r32-test';
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export type Check = { id: string; status: string; message: string };
export const check = (checks: Check[], name: string) => checks.find(item => item.id === name);

export async function builtRelease() {
  const work = await mkdtemp(join(tmpdir(), 'factory-r32-'));
  const assets = join(work, 'synthetic-assets');
  await mkdir(assets);
  await writeFile(join(assets, 'manifest.json'), await readFile('test/sandbox/asset-manifest.fixture.json'));
  await writeFile(join(assets, 'vmlinuz-virt'), 'kernel fixture\n');
  await writeFile(join(assets, 'initramfs.cpio.lz4'), 'initramfs fixture\n');
  await writeFile(join(assets, 'rootfs.ext4'), 'rootfs fixture\n');
  const output = join(work, 'build');
  const report = await buildRelease({ release: id, output, guestAssets: { directory: assets, manifestSha256 } });
  const root = join(work, 'installation');
  await mkdir(root, { mode: 0o700 });
  const extracted = spawnSync('tar', ['-xpkf', join(output, report.archive), '-C', root], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const factory = (installation: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(installation, 'factory'), args, { cwd: work, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  return { work, assets, output, report, root, factory };
}

/** PATH whose installer/escalation commands only leave a canary: setup/doctor must never invoke any of them. */
export async function canaryPath(directory: string) {
  await mkdir(join(directory, 'bin'), { recursive: true });
  for (const name of ['sudo', 'su', 'doas', 'pkexec', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'node', 'apk', 'pacman', 'apt-get', 'dnf', 'docker', 'podman', 'curl', 'wget']) {
    await writeFile(join(directory, 'bin', name), `#!/bin/sh\necho ${name} >> ${join(directory, 'canary')}\nexit 1\n`, { mode: 0o755 });
  }
  return `${join(directory, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}
