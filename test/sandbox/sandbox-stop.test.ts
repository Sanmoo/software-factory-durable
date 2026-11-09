import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, open, readFile, readdir, readlink, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type BootRef, type EnvironmentRef } from '../../src/sandbox/index.js';

const workId = 'stop-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const boot = 'boot-11111111-2222-4333-8444-555555555555' as BootRef;
const unknown = { status: 'indeterminate', code: 'ENVIRONMENT_STOP_UNCONFIRMED', cessationConfirmed: false };

async function refusalRecords(root: string, mismatch: 'host' | 'group' | 'namespace' | 'none') {
  const directory = join(root, 'environments', environment);
  const path = join(directory, boot);
  const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
  const unit = `factory-sandbox-${boot}.service`;
  const host = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const otherHost = host === '00000000-0000-4000-8000-000000000000'
    ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000000';
  await mkdir(path, { recursive: true, mode: 0o700 });
  const json = (name: string, value: unknown) => writeFile(name, JSON.stringify(value), { mode: 0o600 });
  await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration,
    guestAssets: { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) } });
  await json(join(directory, 'ready.json'), { environment });
  await json(join(path, 'identity.json'), { version: 1, environment, boot, unit, configuration,
    hostBoot: mismatch === 'host' ? otherHost : host });
  const uid = process.getuid?.();
  await json(join(path, 'started.json'), { version: 1, boot, unit, invocation: 'a'.repeat(32),
    cgroup: mismatch === 'group' ? '/foreign' : `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`,
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'),
    mountNamespace: mismatch === 'namespace' ? 'mnt:[0]' : await readlink('/proc/self/ns/mnt') });
  return path;
}

// External-manager double only. PATH contains no real systemctl fallback; no unit
// or VM is created. Its synthetic inactive result is not physical cessation proof.
async function managerDouble() {
  const root = await mkdtemp(join(tmpdir(), 'factory-stop-sync-'));
  const path = await refusalRecords(root, 'none');
  const bin = join(root, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const unit = `factory-sandbox-${boot}.service`;
  const uid = process.getuid?.();
  const group = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
import fs from 'node:fs';
const root = ${JSON.stringify(root)}, unit = ${JSON.stringify(unit)}, group = ${JSON.stringify(group)};
const args = process.argv.slice(2);
if (args[0] === '--user' && args[1] === 'show' && args[2] === unit && args.length === 4) {
  const active = !fs.existsSync(root + '/stopped');
  console.log('LoadState=loaded\\nActiveState=' + (active ? 'active' : 'inactive') + '\\nInvocationID=${'a'.repeat(32)}\\nControlGroup=' + (active ? group : '') + '\\nMainPID=0\\nResult=success');
} else if (JSON.stringify(args) === JSON.stringify(['--user', '--no-block', 'stop', unit])) {
  fs.appendFileSync(root + '/audit', 'stop\\n');
  fs.writeFileSync(root + '/stopped', 'synthetic');
} else { process.exitCode = 2; }
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  return { root, path, sandbox: createSandbox({ root }),
    async audit() { try { return (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n'); } catch { return []; } },
    async cleanup() {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    } };
}

// Failure injection at Node's filesystem boundary, not a product/private-module mock.
async function syncBoundary(t: TestContext, root: string, path: string, beforeSync: (kind: 'file' | 'directory') => Promise<void>) {
  const probe = await open(join(root, 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.sync;
  await probe.close();
  t.mock.method(prototype, 'sync', async function(this: FileHandle) {
    const target = await readlink(`/proc/self/fd/${this.fd}`);
    const kind = target === join(path, 'stop-request.json') ? 'file' : target === path ? 'directory' : undefined;
    if (kind) await beforeSync(kind);
    await original.call(this);
    if (kind) await appendFile(join(root, 'audit'), `${kind}-synced\n`);
  });
}

for (const failedSync of ['file', 'directory'] as const) {
  test(`Sandbox.stop retry re-establishes file and directory durability after ${failedSync} sync failure (manager double)`, { timeout: 5000 }, async t => {
    const fixture = await managerDouble();
    try {
      let fail = true;
      await syncBoundary(t, fixture.root, fixture.path, async kind => {
        if (kind === failedSync && fail) { fail = false; throw new Error('INJECTED_SYNC_FAILURE'); }
      });
      assert.deepEqual(await fixture.sandbox.stop({ environment, boot, reason: 'pause' }), unknown);
      assert.equal((await fixture.audit()).includes('stop'), false);
      assert.equal(JSON.parse(await readFile(join(fixture.path, 'stop-request.json'), 'utf8')).boot, boot);
      const retried = await fixture.sandbox.stop({ environment, boot, reason: 'pause' });
      assert.equal(retried.status, 'success'); // Success against a double, not a VM.
      assert.deepEqual((await fixture.audit()).slice(-3), ['file-synced', 'directory-synced', 'stop']);
    } finally { await fixture.cleanup(); }
  });
}

for (const failedSync of ['file', 'directory'] as const) {
  test(`Sandbox.stop does not act when an existing request cannot complete ${failedSync} sync (manager double)`, { timeout: 5000 }, async t => {
    const fixture = await managerDouble();
    try {
      await writeFile(join(fixture.path, 'stop-request.json'), JSON.stringify({ version: 1, boot, reason: 'pause' }), { mode: 0o600 });
      await syncBoundary(t, fixture.root, fixture.path, async kind => {
        if (kind === failedSync) throw new Error('INJECTED_SYNC_FAILURE');
      });
      assert.deepEqual(await fixture.sandbox.stop({ environment, boot, reason: 'pause' }), unknown);
      assert.equal((await fixture.audit()).includes('stop'), false);
    } finally { await fixture.cleanup(); }
  });
}

test('Sandbox.stop concurrent retry independently syncs a still-publishing request before effect (manager double)', { timeout: 5000 }, async t => {
  const fixture = await managerDouble();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const atSync = new Promise<void>(resolve => { entered = resolve; });
  let first: ReturnType<typeof fixture.sandbox.stop> | undefined;
  try {
    let fileSyncs = 0;
    await syncBoundary(t, fixture.root, fixture.path, async kind => {
      if (kind === 'file' && fileSyncs++ === 0) { entered(); await blocked; }
    });
    first = fixture.sandbox.stop({ environment, boot, reason: 'pause' });
    await atSync;
    const concurrent = await fixture.sandbox.stop({ environment, boot, reason: 'pause' });
    assert.equal(concurrent.status, 'success');
    assert.deepEqual(await fixture.audit(), ['file-synced', 'directory-synced', 'stop']);
  } finally {
    release();
    if (first) await first;
    await fixture.cleanup();
  }
});

test('Sandbox.stop leaves an unknown environment untouched and never confirms cessation from missing records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-stop-'));
  try {
    assert.deepEqual(await createSandbox({ root }).stop({ environment, boot, reason: 'pause' }),
      { status: 'indeterminate', code: 'ENVIRONMENT_STOP_UNCONFIRMED', cessationConfirmed: false });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.stop rejects an invalid reason before effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-stop-'));
  try {
    assert.deepEqual(await createSandbox({ root }).stop({ environment, boot, reason: '' }),
      { status: 'failure', code: 'STOP_REASON_INVALID', cessationConfirmed: false });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.stop refuses an invalid boot reference without traversing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-stop-'));
  try {
    assert.deepEqual(await createSandbox({ root }).stop({ environment, boot: '../foreign' as BootRef, reason: 'pause' }), unknown);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mismatch of ['host', 'group', 'namespace'] as const) {
  test(`Sandbox.stop refuses ${mismatch} mismatch before writing a request or signaling a service`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-stop-'));
    try {
      const path = await refusalRecords(root, mismatch);
      const before = await readFile(join(path, 'started.json'), 'utf8');
      assert.deepEqual(await createSandbox({ root }).stop({ environment, boot, reason: 'pause' }), unknown);
      assert.equal(await readFile(join(path, 'started.json'), 'utf8'), before);
      assert.deepEqual((await readdir(path)).sort(), ['identity.json', 'started.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
