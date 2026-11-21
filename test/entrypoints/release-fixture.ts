import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';
import { remainingMs } from '../runner/budget.js';

// I-local fixture (ticket 32): the REAL release builder over this development checkout (emitted JS, lockfile closure, private Node, private
// SDK profiles, skill packs) with SYNTHETIC guest assets (non-bootable bytes, pinned by hash), and real host tar extraction into a clean
// canonical root. The extracted release's own private Node runs setup/doctor/run. No VM, network, GitHub, model or credential.
export const manifestSha256 = '9bf9e4c0a3af47bc92a350509f4ddfe7de3d319b5b63ca42a2939ad73b6ef80f';
export const id = 'r32-test';
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export type Check = { id: string; status: string; message: string };
export const check = (checks: Check[], name: string) => checks.find(item => item.id === name);

type Built = { assets: string; output: string; report: Awaited<ReturnType<typeof buildRelease>> };

async function build(directory: string): Promise<Built> {
  const assets = join(directory, 'synthetic-assets');
  await mkdir(assets);
  await writeFile(join(assets, 'manifest.json'), await readFile('test/sandbox/asset-manifest.fixture.json'));
  await writeFile(join(assets, 'vmlinuz-virt'), 'kernel fixture\n');
  await writeFile(join(assets, 'initramfs.cpio.lz4'), 'initramfs fixture\n');
  await writeFile(join(assets, 'rootfs.ext4'), 'rootfs fixture\n');
  const output = join(directory, 'build');
  return { assets, output, report: await buildRelease({ release: id, output, guestAssets: { directory: assets, manifestSha256 } }) };
}

/** Resolves once `path` exists: an fs.watch event on its directory, checked again after the watch is armed (no polling). */
function appeared(path: string, directory: string, stage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory);
    const timer = setTimeout(() => {
      done();
      reject(new Error(`TEST_BUDGET_EXCEEDED waiting for ${stage}`));
    }, remainingMs());
    const done = () => {
      clearTimeout(timer);
      watcher.close();
    };
    const check = () =>
      readFile(path).then(
        () => {
          done();
          resolve();
        },
        () => {},
      );
    watcher.on('change', check);
    watcher.on('error', error => {
      done();
      reject(error);
    });
    void check();
  });
}

/**
 * Ticket 37: ONE release build per runner run, shared read-only by release-artifact/-install/-upgrade (each extracts its own copy;
 * nothing writes to the shared build). The first file to claim the run's shared directory builds; the others wait for its
 * outcome (event, not polling). Outside the runner (manual run) the build is private to the file, as before.
 */
async function sharedBuild(work: string): Promise<Built> {
  const shared = process.env.FACTORY_TEST_RUN_DIRECTORY;
  if (!shared) return build(work);
  const directory = join(shared, `release-${id}`),
    outcome = join(shared, `release-${id}.json`);
  let owner = true;
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    owner = false;
  }
  if (owner) {
    let result: { ok: true; built: Built } | { ok: false; error: string };
    try {
      result = { ok: true, built: await build(directory) };
    } catch (error) {
      result = { ok: false, error: String((error as Error).stack ?? error) };
    }
    // Published atomically (rename), so a waiter never reads a partial outcome.
    await writeFile(`${outcome}.tmp`, JSON.stringify(result));
    await rename(`${outcome}.tmp`, outcome);
  } else await appeared(outcome, shared, `the shared release build in ${directory}`);
  const result = JSON.parse(await readFile(outcome, 'utf8')) as { ok: true; built: Built } | { ok: false; error: string };
  if (!result.ok) throw new Error(`shared release build failed: ${result.error}`);
  return result.built;
}

/** The run's release build (read-only) and a private work directory of the calling file. */
export async function releaseBuild() {
  const work = await mkdtemp(join(tmpdir(), 'factory-r32-'));
  // A failed build must not leak the work directory (the caller only learns `work` on success).
  try {
    return { work, ...(await sharedBuild(work)) };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

export async function builtRelease() {
  const { work, assets, output, report } = await releaseBuild();
  const root = join(work, 'installation');
  await mkdir(root, { mode: 0o700 });
  const extracted = spawnSync('tar', ['-xpkf', join(output, report.archive), '-C', root], { encoding: 'utf8' });
  if (extracted.status !== 0) await rm(work, { recursive: true, force: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const factory = (installation: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(installation, 'factory'), args, { cwd: work, encoding: 'utf8', timeout: remainingMs(), env: { ...process.env, ...env } });
  return { work, assets, output, report, root, factory };
}

/** PATH whose installer/escalation commands only leave a canary: setup/doctor must never invoke any of them. */
export async function canaryPath(directory: string) {
  await mkdir(join(directory, 'bin'), { recursive: true });
  for (const name of [
    'sudo',
    'su',
    'doas',
    'pkexec',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'corepack',
    'node',
    'apk',
    'pacman',
    'apt-get',
    'dnf',
    'docker',
    'podman',
    'curl',
    'wget',
  ]) {
    await writeFile(join(directory, 'bin', name), `#!/bin/sh\necho ${name} >> ${join(directory, 'canary')}\nexit 1\n`, { mode: 0o755 });
  }
  return `${join(directory, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}
