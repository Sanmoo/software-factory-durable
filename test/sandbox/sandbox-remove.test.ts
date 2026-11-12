import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, readFile, readlink, writeFile, lstat, symlink, link, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';

const workId = 'remove-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const boot = 'boot-11111111-2222-4333-8444-555555555555';
const cleanup = { workId, workDisposition: 'cancelled', confirmed: true, evidencePreserved: true };

// Synthetic manager identity only. No real manager fallback, signal, service or VM.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-remove-'));
  const directory = join(root, 'environments', environment);
  const path = join(directory, boot);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const json = (p: string, value: unknown) => writeFile(p, JSON.stringify(value), { mode: 0o600 });
  const unit = `factory-sandbox-${boot}.service`;
  const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`;
  const assets = join(root, 'assets'); await mkdir(assets, { mode: 0o700 });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const name of ['kernel', 'initramfs', 'rootfs']) await writeFile(join(assets, name), name);
  const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
    assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs' },
    checksums: { kernel: sha('kernel'), initramfs: sha('initramfs'), rootfs: sha('rootfs') } });
  await writeFile(join(assets, 'manifest.json'), manifest);
  const guestAssets = { directory: assets, manifestSha256: sha(manifest) };
  await json(join(directory, 'owner.json'), { version: 1, workId, environment,
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, guestAssets });
  await json(join(directory, 'ready.json'), { environment });
  await json(join(directory, 'current.json'), { version: 1, environment, boot });
  await json(join(path, 'identity.json'), { version: 1, environment, boot, unit,
    hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' } });
  await json(join(path, 'started.json'), { version: 1, boot, unit, invocation: 'a'.repeat(32), cgroup: group,
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') });
  for (const name of ['workspace', 'artifacts']) { await mkdir(join(directory, name), { mode: 0o700 }); await writeFile(join(directory, name, 'content'), name); }
  await writeFile(join(directory, 'root.qcow2'), 'owned test disk, never booted', { mode: 0o600 });
  const runtime = join(root, 'r', 'ERERESIiQzOERFVVVVVVVQ');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await json(join(runtime, 'owner.json'), { version: 1, environment, boot });
  await writeFile(join(runtime, 'cache'), 'own cache');
  await mkdir(join(directory, 'filesystem-check-evidence'), { mode: 0o700 });
  await writeFile(join(directory, 'filesystem-check-evidence', 'preserved'), 'do not delete evidence');
  await mkdir(join(root, 'records'), { mode: 0o700 });
  await writeFile(join(root, 'records', 'review'), 'evidence already preserved outside removable data');
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] !== '--user' || args[1] !== 'show' || args[2] !== ${JSON.stringify(unit)} || args.length !== 4) process.exit(77);
const active = fs.existsSync(${JSON.stringify(join(root, 'active'))});
console.log('LoadState=loaded\\nActiveState=' + (active ? 'active' : 'inactive') + '\\nSubState=dead\\nInvocationID=${'a'.repeat(32)}\\nMainPID=0\\nControlGroup=' + (active ? ${JSON.stringify(group)} : '') + '\\nResult=success');
`, { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = bin;
  return { root, directory, path, runtime, guestAssets, sandbox: createSandbox({ root, guestAssets }),
    async close() { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); } };
}

async function absent(path: string) {
  try { await lstat(path); return false; } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return true; throw e; }
}

test('Sandbox.remove deletes only stopped owned operational resources and preserves history (manager double)', async () => {
  const f = await fixture();
  try {
    const result = await f.sandbox.remove({ environment, cleanup });
    assert.equal(result.status, 'success');
    for (const name of ['root.qcow2', 'workspace', 'artifacts']) assert.equal(await absent(join(f.directory, name)), true, name);
    assert.equal(await absent(f.runtime), true);
    assert.equal(await readFile(join(f.directory, 'filesystem-check-evidence', 'preserved'), 'utf8'), 'do not delete evidence');
    assert.equal(await readFile(join(f.root, 'records', 'review'), 'utf8'), 'evidence already preserved outside removable data');
    assert.equal(JSON.parse(await readFile(join(f.path, 'started.json'), 'utf8')).boot, boot);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'owner.json'), 'utf8')).workId, workId);
  } finally { await f.close(); }
});

test('Sandbox.observe confirms removed resources and cleanup is repeatable without losing boot evidence (manager double)', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    const { storage, ...lifecycle } = await f.sandbox.observe({ environment });
    assert.deepEqual(lifecycle, { condition: 'removed', cessationConfirmed: true, consumption: 'unavailable' });
    assert.deepEqual(storage?.disk, { status: 'absent' });
    assert.deepEqual(storage?.workspace, { status: 'absent' });
    assert.deepEqual(storage?.artifacts, { status: 'absent' });
    const repeated = await f.sandbox.remove({ environment, cleanup });
    assert.equal(repeated.status, 'success');
    assert.deepEqual(repeated.resources.map(r => r.status), ['absent', 'absent', 'absent', 'absent']);
    assert.equal(JSON.parse(await readFile(join(f.path, 'identity.json'), 'utf8')).boot, boot);
  } finally { await f.close(); }
});

test('Sandbox.remove never calls a present runtime absent when its ownership record is missing', async () => {
  const f = await fixture();
  try {
    await rm(join(f.runtime, 'owner.json'));
    const result = await f.sandbox.remove({ environment, cleanup });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.resources.find(r => r.resource === 'runtime'), { resource: 'runtime', status: 'failed' });
    assert.equal(await absent(f.runtime), false);
    assert.equal(await absent(join(f.directory, 'removed.json')), true);
  } finally { await f.close(); }
});

test('Sandbox.start and prepare cannot resurrect an environment after cleanup begins', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
    assert.deepEqual(await f.sandbox.start({ environment, configuration }), { status: 'failure', code: 'ENVIRONMENT_CLEANUP_PENDING' });
    assert.deepEqual(await f.sandbox.prepare({ workId, configuration }), { status: 'failure', code: 'ENVIRONMENT_CLEANUP_PENDING' });
    assert.equal(await absent(join(f.directory, 'root.qcow2')), true);
  } finally { await f.close(); }
});

for (const invalid of [
  { ...cleanup, confirmed: false }, { ...cleanup, evidencePreserved: false },
  { ...cleanup, workDisposition: 'open' }, { ...cleanup, script: 'PRIVATE_CANARY' },
]) {
  test('Sandbox.remove rejects invalid host cleanup assertions without deleting data', async () => {
    const f = await fixture();
    try {
      assert.deepEqual(await f.sandbox.remove({ environment, cleanup: invalid }),
        { status: 'failure', code: 'CLEANUP_AUTHORIZATION_INVALID', resources: [] });
      assert.equal(await absent(join(f.directory, 'root.qcow2')), false);
      assert.equal(await absent(join(f.directory, 'cleanup-request.json')), true);
    } finally { await f.close(); }
  });
}

for (const mode of ['wrong-work', 'uncertain-manager', 'unknown-boot'] as const) {
  test(`Sandbox.remove refuses ${mode} before destructive effects`, async () => {
    const f = await fixture();
    try {
      if (mode === 'uncertain-manager') await writeFile(join(f.root, 'active'), 'synthetic');
      if (mode === 'unknown-boot') await mkdir(join(f.directory, 'boot-99999999-2222-4333-8444-555555555555'), { mode: 0o700 });
      const result = await f.sandbox.remove({ environment, cleanup: mode === 'wrong-work' ? { ...cleanup, workId: 'foreign' } : cleanup });
      assert.equal(result.status, mode === 'wrong-work' ? 'failure' : 'indeterminate');
      assert.deepEqual(result.resources, []);
      assert.equal(await absent(join(f.directory, 'root.qcow2')), false);
      assert.equal(await absent(join(f.directory, 'cleanup-request.json')), true);
    } finally { await f.close(); }
  });
}

test('Sandbox.remove reports alias refusal and completes only pending resources on retry', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'foreign'); await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'valuable'), 'foreign data');
    await rm(join(f.directory, 'workspace'), { recursive: true });
    await symlink(outside, join(f.directory, 'workspace'));
    const first = await f.sandbox.remove({ environment, cleanup });
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.resources.find(r => r.resource === 'workspace'), { resource: 'workspace', status: 'refused' });
    assert.equal(await readFile(join(outside, 'valuable'), 'utf8'), 'foreign data');
    assert.equal(await absent(join(f.directory, 'removed.json')), true);
    await rm(join(f.directory, 'workspace')); await mkdir(join(f.directory, 'workspace'), { mode: 0o700 });
    const second = await f.sandbox.remove({ environment, cleanup });
    assert.equal(second.status, 'success');
    assert.deepEqual(second.resources.map(r => r.status), ['absent', 'removed', 'absent', 'absent']);
    assert.equal(await readFile(join(outside, 'valuable'), 'utf8'), 'foreign data');
  } finally { await f.close(); }
});

test('Sandbox.remove unlinks child symlinks without following them but refuses shared hardlinks', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'valuable'); await writeFile(outside, 'not owned by the workspace');
    await symlink(outside, join(f.directory, 'workspace', 'alias'));
    await link(outside, join(f.directory, 'artifacts', 'shared'));
    const before = await lstat(outside, { bigint: true });
    const result = await f.sandbox.remove({ environment, cleanup });
    assert.equal(result.status, 'partial');
    assert.equal(result.resources.find(r => r.resource === 'workspace')?.status, 'removed');
    assert.equal(result.resources.find(r => r.resource === 'artifacts')?.status, 'refused');
    assert.equal(await readFile(outside, 'utf8'), 'not owned by the workspace');
    const after = await lstat(outside, { bigint: true });
    assert.equal(after.nlink, before.nlink); assert.equal(after.ctimeNs, before.ctimeNs);
  } finally { await f.close(); }
});

for (const failedSync of ['file', 'directory'] as const) {
  test(`Sandbox.remove retries only after a fresh durable barrier following ${failedSync} sync failure`, async t => {
    const f = await fixture();
    try {
      const probe = await open(join(f.root, 'probe'), 'wx', 0o600);
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const sync = prototype.sync; await probe.close();
      let fail = true, successfulBarrier = false;
      t.mock.method(prototype, 'sync', async function(this: FileHandle) {
        const target = await readlink(`/proc/self/fd/${this.fd}`);
        if (fail && (failedSync === 'file'
          ? target === join(f.directory, 'cleanup-request.json') || target.startsWith(join(f.directory, 'cleanup-request.json.pending-'))
          : target === f.directory)) {
          fail = false; throw new Error('INJECTED_CLEANUP_SYNC_FAILURE');
        }
        await sync.call(this);
        if (!successfulBarrier && target === f.directory) {
          assert.equal(await absent(join(f.directory, 'root.qcow2')), false, 'data must still exist at request durability barrier');
          successfulBarrier = true;
        }
      });
      assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'indeterminate');
      assert.equal(await absent(join(f.directory, 'root.qcow2')), false);
      assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
      assert.equal(successfulBarrier, true);
    } finally { await f.close(); }
  });
}

test('Sandbox.remove stops destructive work when cessation becomes unavailable between resources', async t => {
  const f = await fixture();
  try {
    const probe = await open(join(f.root, 'probe'), 'wx', 0o600);
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const sync = prototype.sync; await probe.close();
    t.mock.method(prototype, 'sync', async function(this: FileHandle) {
      await sync.call(this);
      if (await readlink(`/proc/self/fd/${this.fd}`) === f.directory && await absent(join(f.directory, 'root.qcow2'))) {
        await writeFile(join(f.root, 'active'), 'synthetic loss of cessation evidence');
      }
    });
    const result = await f.sandbox.remove({ environment, cleanup });
    assert.equal(result.status, 'indeterminate');
    assert.deepEqual(result.resources, [{ resource: 'disk', status: 'removed' }]);
    assert.equal(await absent(join(f.directory, 'workspace', 'content')), false);
    assert.equal(await absent(join(f.directory, 'removed.json')), true);
  } finally { await f.close(); }
});

test('Sandbox.observe never trusts removal marker alone after resources or a boot reappear', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    await writeFile(join(f.directory, 'root.qcow2'), 'unexpected resource', { mode: 0o600 });
    assert.equal((await f.sandbox.observe({ environment })).cessationConfirmed, false);
    await rm(join(f.directory, 'root.qcow2'));
    await mkdir(join(f.directory, 'boot-99999999-2222-4333-8444-555555555555'), { mode: 0o700 });
    assert.equal((await f.sandbox.observe({ environment })).condition, 'indeterminate');
  } finally { await f.close(); }
});

test('Sandbox.remove recovers a partially removed runtime using retained identity, not an ownerless replacement', async t => {
  const f = await fixture();
  const original = fs.rm;
  const injected = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === f.runtime) {
      await original(join(f.runtime, 'owner.json'));
      await writeFile(join(f.runtime, 'remaining'), 'incomplete deletion');
      throw new Error('INJECTED_PARTIAL_RUNTIME_DELETE');
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'partial');
    assert.equal(await absent(join(f.runtime, 'owner.json')), true);
    injected.mock.restore(); syncBuiltinESMExports();
    const residual = join(f.root, 'original-runtime');
    await fs.rename(f.runtime, residual);
    await mkdir(f.runtime, { mode: 0o700 }); await writeFile(join(f.runtime, 'foreign'), 'recreated ownerless directory');
    const refused = await f.sandbox.remove({ environment, cleanup });
    assert.notEqual(refused.status, 'success');
    assert.equal(await readFile(join(f.runtime, 'foreign'), 'utf8'), 'recreated ownerless directory');
    await original(f.runtime, { recursive: true }); await fs.rename(residual, f.runtime);
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    assert.equal(await absent(f.runtime), true);
  } finally { injected.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('Sandbox.remove can complete after an interrupted completion write without publishing a malformed final marker', async t => {
  const f = await fixture();
  try {
    const probe = await open(join(f.root, 'probe'), 'wx', 0o600);
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const write = prototype.writeFile; await probe.close();
    let fail = true;
    t.mock.method(prototype, 'writeFile', async function(this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      const target = await readlink(`/proc/self/fd/${this.fd}`);
      if (fail && (target === join(f.directory, 'removed.json') || target.startsWith(join(f.directory, 'removed.json.pending-')))) {
        fail = false; await write.call(this, '{"ver'); throw new Error('INJECTED_PARTIAL_COMPLETION_WRITE');
      }
      return write.apply(this, args);
    });
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'indeterminate');
    assert.equal(await absent(join(f.directory, 'removed.json')), true, 'partial bytes must stay at a private temporary name');
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    assert.equal((await f.sandbox.observe({ environment })).condition, 'removed');
  } finally { await f.close(); }
});

test('Sandbox.remove recovers an exclusive publication interrupted after linking the final record', async t => {
  const f = await fixture();
  const original = fs.unlink;
  let fail = true;
  const injected = t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
    if (fail && typeof args[0] === 'string' && args[0].startsWith(join(f.directory, 'removed.json.pending-'))) {
      fail = false; throw new Error('INJECTED_PUBLICATION_LINK_WINDOW');
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'indeterminate');
    assert.equal((await lstat(join(f.directory, 'removed.json'))).nlink, 2);
    injected.mock.restore(); syncBuiltinESMExports();
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'success');
    assert.equal((await lstat(join(f.directory, 'removed.json'))).nlink, 1);
    assert.equal((await f.sandbox.observe({ environment })).condition, 'removed');
  } finally { injected.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('Sandbox.remove refuses a genuinely malformed existing final record rather than overwriting it', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'removed.json'), '{"foreign-prefix', { mode: 0o600 });
    assert.equal((await f.sandbox.remove({ environment, cleanup })).status, 'indeterminate');
    assert.equal(await readFile(join(f.directory, 'removed.json'), 'utf8'), '{"foreign-prefix');
    assert.equal((await f.sandbox.observe({ environment })).condition, 'indeterminate');
  } finally { await f.close(); }
});

test('Sandbox.remove rejects missing cleanup authorization before any resource effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-remove-'));
  try {
    const sandbox = createSandbox({ root });
    assert.ok('remove' in sandbox && typeof sandbox.remove === 'function');
    assert.deepEqual(await sandbox.remove({ environment, cleanup: { confirmed: false } }),
      { status: 'failure', code: 'CLEANUP_AUTHORIZATION_INVALID', resources: [] });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
