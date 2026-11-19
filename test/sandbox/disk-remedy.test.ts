import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createSandbox, type BootRef, type DiskRemedy } from '../../src/sandbox/index.js';
import { remainingMs } from '../runner/budget.js';

// Ticket 47 (real e2fsprogs/qemu-img on NEW tiny fixture disks; no VM, no manager: systemd is doubled and the boot request refused). Covers
// the journal replay of the private check copy and the operator disk remedies applied by a start. Only with FACTORY_SANDBOX_TEST_ROOT (full).
const testRoot = process.env.FACTORY_SANDBOX_TEST_ROOT;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', diskGiB: 1 };
const oldBoot = 'boot-47474747-2222-4333-8444-555555555555' as BootRef;
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const native = () => ({ stdio: 'pipe' as const, timeout: remainingMs() });
const e2fsckExit = (raw: string) => { try { execFileSync('/usr/bin/e2fsck', ['-f', '-n', raw], native()); return 0; } catch (e) { return (e as { status: number }).status; } };

async function shortRoot() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const root = join(dirname(testRoot!), randomBytes(1).toString('hex'));
    try { await mkdir(root, { mode: 0o700 }); return root; }
    catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e; }
  }
  throw new Error('NO_NEW_SHORT_FILESYSTEM_TEST_ROOT');
}

/** A prepared environment whose previous boot ended (cessation confirmed by the doubled manager), with its disk damaged by `damage`. */
async function fixture(root: string, journal: boolean, damage: (raw: string, work: string) => Promise<void> | void) {
  const assets = join(root, 'assets');
  await mkdir(assets, { mode: 0o700 });
  const template = join(assets, 'rootfs.ext4');
  execFileSync('/usr/bin/qemu-img', ['create', '-f', 'raw', template, '32M'], native());
  execFileSync('/usr/bin/mke2fs', ['-q', '-t', 'ext4', '-b', '4096', '-O', journal ? 'has_journal' : '^has_journal', '-F', template], native());
  for (const name of ['kernel', 'initramfs']) await writeFile(join(assets, name), name);
  const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' },
    assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs.ext4' },
    checksums: { kernel: hash('kernel'), initramfs: hash('initramfs'), rootfs: hash(await readFile(template)) } });
  await writeFile(join(assets, 'manifest.json'), manifest);
  const sandbox = createSandbox({ root, guestAssets: { directory: assets, manifestSha256: hash(manifest) } });
  const prepared = await sandbox.prepare({ workId: 'disk-remedy-work', configuration });
  assert.equal(prepared.status, 'success');
  if (prepared.status !== 'success') throw new Error('unprepared');
  const environment = prepared.environment;
  const directory = join(root, 'environments', environment);
  const disk = join(directory, 'root.qcow2');
  await writeFile(join(directory, 'workspace', 'unpublished.txt'), 'kept work');
  const work = join(root, 'damage');
  await mkdir(work, { mode: 0o700 });
  const raw = join(work, 'disk.ext4');
  execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', disk, raw], native());
  await damage(raw, work);
  await rm(disk);
  execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'raw', '-O', 'qcow2', raw, disk], native());
  const file = await open(disk, 'r+');
  try { await file.chmod(0o600); } finally { await file.close(); }
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
console.log('LoadState=loaded\\nActiveState=inactive\\nMainPID=0\\nInvocationID=${'a'.repeat(32)}\\nControlGroup=\\nResult=success');
`, { mode: 0o700 });
  await writeFile(join(bin, 'systemd-run'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'manager-request'))}, 'synthetic request only');
process.exit(77);
`, { mode: 0o700 });
  return { sandbox, environment, directory, disk };
}

/** The pilot 35 defect: bitmap/descriptor checksums and the allocation bitmap out of step after an abrupt stop of a journal-less root. */
function pilotDamage(raw: string) {
  execFileSync('/usr/bin/debugfs', ['-w', '-R', 'set_bg 0 block_bitmap_csum 0', raw], native());
  execFileSync('/usr/bin/debugfs', ['-w', '-R', 'freeb 100', raw], native());
  assert.equal(e2fsckExit(raw), 4);
}

async function start(root: string, f: Awaited<ReturnType<typeof fixture>>, diskRemedy?: DiskRemedy) {
  const previousPath = process.env.PATH;
  process.env.PATH = join(root, 'bin'); // All disk helpers use fixed paths; no real manager fallback.
  try { return await f.sandbox.start({ environment: f.environment, configuration, ...(diskRemedy ? { diskRemedy } : {}) }); }
  finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
}
const launched = async (root: string) => (await readdir(root)).includes('manager-request');

test('ticket 47: an abruptly stopped JOURNALED root passes the check once its journal is replayed on the private copy (preserved disk untouched)', { skip: !testRoot }, async () => {
  const root = await shortRoot();
  try {
    const f = await fixture(root, true, async (raw, work) => {
      // Unreplayed journal: the on-disk bitmap lost an allocation, the journal holds the consistent superblock/descriptors/bitmap.
      const bitmap = /Block bitmap at ([0-9]+)/.exec(execFileSync('/usr/bin/dumpe2fs', [raw], { ...native(), encoding: 'utf8' }))![1]!;
      for (const block of ['0', '1', bitmap]) execFileSync('/usr/bin/dd', [`if=${raw}`, `of=${join(work, `b${block}`)}`, 'bs=4096', `skip=${block}`, 'count=1', 'status=none'], native());
      execFileSync('/usr/bin/debugfs', ['-w', '-R', 'freeb 100', raw], native());
      await writeFile(join(work, 'journal'), `jo\njw -b 0 ${join(work, 'b0')}\njw -b 1 ${join(work, 'b1')}\njw -b ${bitmap} ${join(work, `b${bitmap}`)}\njc\n`);
      execFileSync('/usr/bin/debugfs', ['-w', '-f', join(work, 'journal'), raw], native());
      assert.equal(e2fsckExit(raw), 4, 'a read-only check of the unreplayed image refuses it');
    });
    const before = hash(await readFile(f.disk));
    await start(root, f);
    assert.equal(await launched(root), true, 'the replayed copy is consistent: the boot proceeds');
    assert.equal(hash(await readFile(f.disk)), before, 'the replay touched the private copy only');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ticket 47: repair-disk runs e2fsck -p on a copy, re-checks, swaps it in and keeps the original disk (pilot 35 damage)', { skip: !testRoot }, async () => {
  const root = await shortRoot();
  try {
    const f = await fixture(root, false, pilotDamage);
    const before = hash(await readFile(f.disk));
    const refused = await start(root, f);
    assert.deepEqual([refused.status, refused.status !== 'success' && refused.code, await launched(root)], ['failure', 'PRESERVED_DISK_CHECK_REQUIRED', false], 'never repaired without the decision');
    await start(root, f, 'repair-disk');
    assert.equal(await launched(root), true, 'the repaired disk boots');
    const names = await readdir(f.directory);
    const kept = names.find(name => name.startsWith('root.qcow2.damaged-'))!;
    assert.equal(hash(await readFile(join(f.directory, kept))), before, 'the original disk is kept unchanged (renamed)');
    const log = await readFile(join(f.directory, names.find(name => name.startsWith('disk-repair-'))!, 'e2fsck-p.log'), 'utf8');
    assert.match(log, /FIXED/);
    const check = join(root, 'check.ext4');
    execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', f.disk, check], native());
    assert.equal(e2fsckExit(check), 0);
    assert.equal(await readFile(join(f.directory, 'workspace', 'unpublished.txt'), 'utf8'), 'kept work');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ticket 47: a damage e2fsck -p will not fix is refused with the reason; the preserved disk is unchanged and nothing boots', { skip: !testRoot }, async () => {
  const root = await shortRoot();
  try {
    const f = await fixture(root, false, async raw => {
      const file = await open(raw, 'r+');
      try { await file.write(Buffer.alloc(2), 0, 2, 1024 + 0x38); } finally { await file.close(); } // superblock magic
    });
    const before = hash(await readFile(f.disk));
    const result = await start(root, f, 'repair-disk');
    if (result.status === 'success') assert.fail('a refused repair never boots');
    assert.equal(result.code, 'PRESERVED_DISK_CHECK_REQUIRED');
    assert.match(result.detail!, /^repair-disk: e2fsck -p exit 8 .*the preserved disk is unchanged.*--remedy replace-disk/);
    assert.deepEqual([hash(await readFile(f.disk)), await launched(root)], [before, false]);
    assert.equal((await readdir(f.directory)).some(name => name.startsWith('root.qcow2.')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const variant of ['damaged', 'missing'] as const) {
  test(`ticket 47: replace-disk gives the same environment a new root from the pinned template, keeping /workspace and /artifacts: ${variant}`, { skip: !testRoot }, async () => {
    const root = await shortRoot();
    try {
      const f = await fixture(root, false, pilotDamage);
      const before = hash(await readFile(f.disk));
      if (variant === 'missing') await rm(f.disk);
      await start(root, f, 'replace-disk');
      assert.equal(await launched(root), true);
      const names = await readdir(f.directory);
      const kept = names.find(name => name.startsWith('root.qcow2.replaced-'));
      if (variant === 'damaged') assert.equal(hash(await readFile(join(f.directory, kept!))), before, 'the discarded disk is kept unchanged');
      else assert.equal(kept, undefined);
      const check = join(root, 'check.ext4');
      execFileSync('/usr/bin/qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', f.disk, check], native());
      assert.equal(e2fsckExit(check), 0);
      assert.equal(await readFile(join(f.directory, 'workspace', 'unpublished.txt'), 'utf8'), 'kept work');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('ticket 47: a remedy whose disk already passes the check changes nothing', { skip: !testRoot }, async () => {
  const root = await shortRoot();
  try {
    const f = await fixture(root, false, () => {});
    const before = hash(await readFile(f.disk));
    await start(root, f, 'repair-disk');
    assert.deepEqual([await launched(root), hash(await readFile(f.disk))], [true, before]);
    assert.equal((await readdir(f.directory)).some(name => name.startsWith('root.qcow2.') || name.startsWith('disk-')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
