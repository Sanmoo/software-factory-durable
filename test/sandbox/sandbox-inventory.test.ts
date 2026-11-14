import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, inventoryRuntime, type EnvironmentRef } from '../../src/sandbox/index.js';

// Ticket 26: read-only host inventory and the `not-booted` observation over temporary private trees (no VM, no systemd, no command).
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
const envOf = (workId: string) => `env-${createHash('sha256').update(workId).digest('hex')}`;
async function owned(root: string, workId: string, ready = true) {
  const environment = envOf(workId);
  const directory = join(root, 'environments', environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration, guestAssets: { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) } });
  if (ready) await json(join(directory, 'ready.json'), { environment });
  return environment as EnvironmentRef;
}

test('inventoryRuntime attributes own environments from their metadata, reports cache states and every unclassified entry, and changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-inventory-'));
  try {
    for (const name of ['environments', 'run', 'data']) await mkdir(join(root, name), { mode: 0o700 });
    const environment = await owned(root, 'work-a');
    await mkdir(join(root, 'environments', `env-${'0'.repeat(64)}`), { mode: 0o700 });
    await mkdir(join(root, 'environments', 'stray'), { mode: 0o700 });
    await writeFile(join(root, 'run', 'control.sock'), '');
    await writeFile(join(root, 'run', 'leftover'), '');
    await mkdir(join(root, 'cache', 'git'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'cache', 'git', '3.state.json'), JSON.stringify({ version: 1, state: 'mutating' }), { mode: 0o600 });
    await writeFile(join(root, 'cache', 'git', '4.state.json'), JSON.stringify({ version: 1, state: 'idle' }), { mode: 0o600 });
    await writeFile(join(root, 'cache', 'git', '5.state.json'), 'garbage', { mode: 0o600 });
    const before = await readdir(join(root, 'environments'));
    const listed = await inventoryRuntime(root);
    assert.deepEqual(listed.environments, [{ environment: `env-${'0'.repeat(64)}`, workId: null }, { environment, workId: 'work-a' }].sort((a, b) => a.environment.localeCompare(b.environment)));
    assert.deepEqual(listed.cache, [{ repositoryId: 3, state: 'preparing' }, { repositoryId: 4, state: 'idle' }, { repositoryId: 5, state: 'unknown' }]);
    assert.deepEqual(listed.unknown, ['environments/stray', 'run/leftover']);
    assert.deepEqual(await readdir(join(root, 'environments')), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.observe without a boot: an owned prepared environment that never published a boot is not-booted; an incomplete one stays indeterminate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-inventory-'));
  try {
    const sandbox = createSandbox({ root });
    const prepared = await owned(root, 'work-b');
    const { storage: _s, ...lifecycle } = await sandbox.observe({ environment: prepared });
    assert.deepEqual(lifecycle, { condition: 'not-booted', cessationConfirmed: true, consumption: 'unavailable', boot: null });
    const incomplete = await owned(root, 'work-c', false);
    const { storage: _t, ...unknown } = await sandbox.observe({ environment: incomplete });
    assert.deepEqual(unknown, { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
