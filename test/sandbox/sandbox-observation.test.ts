import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

const unknown = { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' };
const workId = 'observation-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const boot = 'boot-11111111-2222-4333-8444-555555555555';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };

async function ownedMetadata(root: string, hostBoot: string) {
  const directory = join(root, 'environments', environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, boot), { mode: 0o700 });
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration,
    guestAssets: { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) } });
  await json(join(directory, 'ready.json'), { environment });
  await json(join(directory, 'current.json'), { version: 1, environment, boot });
  await json(join(directory, boot, 'identity.json'), { version: 1, environment, boot,
    unit: `factory-sandbox-${boot}.service`, hostBoot, configuration });
  return directory;
}

test('Sandbox.observe treats an unknown environment as indeterminate without creating resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-observe-'));
  try {
    assert.deepEqual(await createSandbox({ root }).observe({ environment }), unknown);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.observe rejects an environment-directory alias without reading or changing the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-observe-'));
  const outside = await mkdtemp(join(tmpdir(), 'factory-observe-outside-'));
  try {
    await writeFile(join(outside, 'marker'), 'untouched');
    await mkdir(join(root, 'environments'), { mode: 0o700 });
    await symlink(outside, join(root, 'environments', environment));
    assert.deepEqual(await createSandbox({ root }).observe({ environment }), unknown);
    assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'untouched');
    assert.deepEqual(await readdir(outside), ['marker']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Sandbox.observe does not adopt boot records from a different host boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-observe-'));
  try {
    const current = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const other = current === '00000000-0000-4000-8000-000000000000'
      ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000000';
    const directory = await ownedMetadata(root, other);
    const before = await readFile(join(directory, boot, 'identity.json'), 'utf8');
    const { storage, ...lifecycle } = await createSandbox({ root }).observe({ environment });
    assert.deepEqual(lifecycle, unknown);
    assert.deepEqual(storage?.disk, { status: 'unavailable' });
    assert.equal(await readFile(join(directory, boot, 'identity.json'), 'utf8'), before);
    assert.deepEqual(await readdir(join(directory, boot)), ['identity.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.observe rejects a FIFO metadata file without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-observe-fifo-'));
  try {
    const directory = join(root, 'environments', environment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', ['-m', '600', join(directory, 'owner.json')]);
    // The timeout affects only this newly-created local regression child, never a VM.
    const child = spawnSync(process.execPath,
      [fileURLToPath(new URL('./observation-fifo-child.js', import.meta.url)), root, environment],
      { encoding: 'utf8', timeout: remainingMs(), maxBuffer: 4096 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), unknown);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.observe does not turn incomplete boot evidence into active or confirmed stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-observe-'));
  try {
    const hostBoot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const directory = await ownedMetadata(root, hostBoot);
    const { storage, ...lifecycle } = await createSandbox({ root }).observe({ environment });
    assert.deepEqual(lifecycle, unknown);
    assert.deepEqual(storage?.workspace, { status: 'unavailable' });
    assert.deepEqual(await readdir(join(directory, boot)), ['identity.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
