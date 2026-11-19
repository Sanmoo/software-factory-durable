import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';

const workId = 'first-boot-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };

// Incomplete owned records for denial tests, never a runnable VM fixture.
async function ownedRecords(root: string) {
  const directory = join(root, 'environments', environment);
  const guestAssets = { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ version: 1, workId, environment, configuration, guestAssets }), { mode: 0o600 });
  await writeFile(join(directory, 'ready.json'), JSON.stringify({ environment }), { mode: 0o600 });
  return { directory, sandbox: createSandbox({ root, guestAssets }) };
}

test('Sandbox.start rejects invalid configuration without creating boot resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    assert.deepEqual(await createSandbox({ root }).start({ environment, configuration: {} }),
      { status: 'failure', code: 'SANDBOX_CONFIGURATION_INVALID' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start does not create or adopt an environment that was not prepared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    assert.deepEqual(await createSandbox({ root }).start({ environment, configuration }),
      { status: 'indeterminate', code: 'ENVIRONMENT_START_UNCONFIRMED' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start refuses an incompatible persistent disk configuration before boot effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory, sandbox } = await ownedRecords(root);
    assert.deepEqual(await sandbox.start({ environment, configuration: { ...configuration, diskGiB: 41 } }),
      { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: 'sandbox.diskGiB 40 -> 41' });
    assert.deepEqual((await readdir(directory)).sort(), ['owner.json', 'ready.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ticket 50: guest memory/vCPU and host admission settings never invalidate a prepared environment (boot uses the current values)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory, sandbox } = await ownedRecords(root);
    // The incomplete fixture has no disk: the start goes PAST the identity check and stops at its own missing disk (never a mismatch).
    const result = await sandbox.start({ environment, configuration: { ...configuration, memoryMiB: 4096, vcpus: 4, minFreeSpaceGiB: 8, shutdownGraceSeconds: 60, minFreeMemoryMiB: 512 } });
    assert.notEqual(result.status === 'success' ? null : result.code, 'ENVIRONMENT_CONFIGURATION_MISMATCH');
    assert.deepEqual((await readdir(directory)).sort(), ['owner.json', 'ready.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start refuses an asset pin different from trusted composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory } = await ownedRecords(root);
    const sandbox = createSandbox({ root, guestAssets: { directory: join(root, 'other'), manifestSha256: 'b'.repeat(64) } });
    assert.deepEqual(await sandbox.start({ environment, configuration }),
      { status: 'failure', code: 'GUEST_ASSET_PIN_MISMATCH', detail: `guest assets ${'a'.repeat(12)} -> ${'b'.repeat(12)}` });
    assert.deepEqual((await readdir(directory)).sort(), ['owner.json', 'ready.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start never replaces an ambiguous previous boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory, sandbox } = await ownedRecords(root);
    const boot = 'boot-11111111-2222-4333-8444-555555555555';
    const previous = JSON.stringify({ version: 1, environment, boot });
    await writeFile(join(directory, 'current.json'), previous, { mode: 0o600 });
    assert.deepEqual(await sandbox.start({ environment, configuration }),
      { status: 'indeterminate', code: 'PREVIOUS_BOOT_NOT_STOPPED', boot });
    assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), previous);
    assert.deepEqual((await readdir(directory)).sort(), ['current.json', 'owner.json', 'ready.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start preserves a pre-existing lifecycle lock rather than taking ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory, sandbox } = await ownedRecords(root);
    await mkdir(join(directory, 'lifecycle-lock'), { mode: 0o700 });
    await writeFile(join(directory, 'lifecycle-lock', 'owner-marker'), 'keep');
    assert.deepEqual(await sandbox.start({ environment, configuration }),
      { status: 'indeterminate', code: 'ENVIRONMENT_LIFECYCLE_BUSY' });
    assert.equal(await readFile(join(directory, 'lifecycle-lock', 'owner-marker'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start rejects a root disk alias without changing its target or publishing boot intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-start-'));
  try {
    const { directory, sandbox } = await ownedRecords(root);
    for (const name of ['workspace', 'artifacts']) await mkdir(join(directory, name), { mode: 0o700 });
    const target = join(root, 'keep');
    await writeFile(target, 'untouched');
    await symlink(target, join(directory, 'root.qcow2'));
    assert.deepEqual(await sandbox.start({ environment, configuration }),
      { status: 'indeterminate', code: 'ENVIRONMENT_START_UNCONFIRMED' });
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    assert.deepEqual((await readdir(directory)).sort(), ['artifacts', 'owner.json', 'ready.json', 'root.qcow2', 'workspace']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.start rejects an overlong runtime socket path before publishing intent or creating runtime resources', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'factory-start-'));
  const root = join(parent, 'long-installation-root-'.repeat(4));
  try {
    await mkdir(root, { mode: 0o700 });
    const { directory, sandbox } = await ownedRecords(root);
    for (const name of ['workspace', 'artifacts']) await mkdir(join(directory, name), { mode: 0o700 });
    // This preflight does not need to open qcow2 or construct a VM.
    await writeFile(join(directory, 'root.qcow2'), 'not-a-runnable-disk', { mode: 0o600 });
    assert.deepEqual(await sandbox.start({ environment, configuration }),
      { status: 'failure', code: 'SANDBOX_RUNTIME_PATH_TOO_LONG' });
    assert.deepEqual(await readdir(root), ['environments']);
    assert.deepEqual((await readdir(directory)).sort(), ['artifacts', 'owner.json', 'ready.json', 'root.qcow2', 'workspace']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
