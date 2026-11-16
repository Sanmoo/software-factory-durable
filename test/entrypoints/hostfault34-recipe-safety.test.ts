import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess, btrfsMagic, confinementProblems, deletedFiles, fillBytes, imageBytes, imageCommands, nocowAttribute, maxDisposableBytes, parseMountinfo, phaseGuard, rewrittenFiles,
  type HostFaultResults, type MountFacts } from './hostfault34-qualification.js';

// Recipe safety of the R-HOSTFAULT real run, on controlled data only (never a real mount, the real home or root filesystem).

test('phase guard: each phase once, in order, only after the previous one succeeded', () => {
  assert.equal(phaseGuard('image', {}, new Set()), null);
  assert.equal(phaseGuard('image', {}, new Set(['image-intent'])), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('preflight', {}, new Set(['image-intent'])), 'IMAGE_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('floor', { image: { status: 'success' }, preflight: { status: 'held' } }, new Set()), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('full', { floor: { status: 'success' } }, new Set()), null);
  assert.equal(phaseGuard('inspect', { release: { status: 'held' } }, new Set()), 'RELEASE_SUCCESS_REQUIRED');
});

test('mountinfo parsing decodes escaped mount points and keeps source/fstype', () => {
  const text = '36 25 0:32 / /home rw,relatime shared:1 - ext4 /dev/mapper/root rw\n' +
    '98 30 7:3 / /run/media/sanmoo/qhf34v1 rw,nosuid,nodev,relatime shared:50 - ext4 /dev/loop3 rw\n' +
    '99 30 0:50 / /tmp/with\\040space rw - tmpfs tmpfs rw\n';
  const entries = parseMountinfo(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], { majorMinor: '7:3', mountPoint: '/run/media/sanmoo/qhf34v1', options: 'rw,nosuid,nodev,relatime', fstype: 'ext4', source: '/dev/loop3' });
  assert.equal(entries[2]!.mountPoint, '/tmp/with space');
});

const image = '/home/sanmoo/software-factory-test/y5/q34-hostfault-v2/disk.img';
const good: MountFacts = { candidate: '/run/media/sanmoo/qhf34v1', imagePath: image, backingFile: image, homeDev: 64768, rootDev: 64768, mountDev: 1795, uid: 1000,
  entry: { majorMinor: '7:3', mountPoint: '/run/media/sanmoo/qhf34v1', options: 'rw', fstype: 'ext4', source: '/dev/loop3' },
  statfs: { type: '0xef53', totalBytes: 6 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, owner: { uid: 1000, mode: 0o755 }, entries: ['lost+found'], imageAllocatedBytes: imageBytes,
  homeFs: btrfsMagic, imageNocow: true };

test('confinement: only a loop mount of EXACTLY the recipe image, ext4, small, on a device distinct from $HOME and / may ever be written', () => {
  assert.deepEqual(confinementProblems(good, { requireEmpty: true }), []);
  const cases: [Partial<MountFacts>, string][] = [
    [{ entry: undefined }, 'NOT_A_MOUNT_POINT'],
    [{ entry: { ...good.entry!, source: '/dev/mapper/root' } }, 'MOUNT_SOURCE_NOT_A_LOOP_DEVICE'],
    [{ entry: { ...good.entry!, fstype: 'tmpfs' } }, 'MOUNT_NOT_EXT4'],
    [{ backingFile: '/home/sanmoo/other.img' }, 'LOOP_NOT_BACKED_BY_THE_RECIPE_IMAGE'],
    [{ backingFile: `${image} (deleted)` }, 'LOOP_NOT_BACKED_BY_THE_RECIPE_IMAGE'],
    [{ statfs: { ...good.statfs!, type: '0x1021994' } }, 'STATFS_NOT_EXT4'],
    [{ statfs: { ...good.statfs!, totalBytes: maxDisposableBytes + 1 } }, 'DISPOSABLE_FILESYSTEM_TOO_LARGE'],
    [{ mountDev: 64768 }, 'MOUNT_DEVICE_NOT_DISTINCT'],
    [{ mountDev: null }, 'MOUNT_DEVICE_NOT_DISTINCT'],
    [{ owner: { uid: 0, mode: 0o755 } }, 'MOUNT_ROOT_NOT_OWNED_BY_OPERATOR'],
    [{ imageAllocatedBytes: 4096 }, 'IMAGE_NOT_PREALLOCATED'],
    [{ entries: ['lost+found', 'root'] }, 'MOUNT_NOT_EMPTY'],
    [{ imageNocow: false }, 'IMAGE_NOT_NOCOW_ON_BTRFS'],
    [{ imageNocow: null }, 'IMAGE_NOT_NOCOW_ON_BTRFS'],
  ];
  for (const [change, problem] of cases) assert.ok(confinementProblems({ ...good, ...change }, { requireEmpty: true }).includes(problem), problem);
  assert.deepEqual(confinementProblems({ ...good, entries: ['lost+found', 'root', 'filler'] }, { requireEmpty: false }), [], 'later phases accept the recipe directories');
});

test('real run v1 (btrfs /home): mkfs discarded the fallocated image (72 MB of 6 GiB left); the image is NOCOW, preallocated and formatted WITHOUT discard', () => {
  const commands = imageCommands(image, 1000, 1000);
  assert.deepEqual(commands.map(argv => argv[0]), ['/usr/bin/chattr', '/usr/bin/fallocate', '/usr/bin/mkfs.ext4'], 'NOCOW is set on the EMPTY file, before any allocation');
  assert.deepEqual(commands[0], ['/usr/bin/chattr', '+C', image]);
  assert.deepEqual(commands[1], ['/usr/bin/fallocate', '-l', String(imageBytes), image]);
  const extended = commands[2]![commands[2]!.indexOf('-E') + 1]!;
  assert.ok(extended.split(',').includes('nodiscard'), 'mkfs must not punch holes into the preallocated image');
  assert.ok(extended.split(',').includes('root_owner=1000:1000'));
  assert.equal(nocowAttribute(`---------------C------ ${image}\n`), true);
  assert.equal(nocowAttribute(`---------------------- ${image}\n`), false);
  assert.equal(nocowAttribute(''), null);
  // The observed v1 image: allocated far below its size -> refused; on a non-btrfs home NOCOW is not required.
  assert.ok(confinementProblems({ ...good, imageAllocatedBytes: 140696 * 512, imageNocow: false }, { requireEmpty: true }).includes('IMAGE_NOT_PREALLOCATED'));
  assert.deepEqual(confinementProblems({ ...good, homeFs: '0xef53', imageNocow: null }, { requireEmpty: true }), []);
});

test('fill target: never negative, block aligned, null when already below the target', () => {
  assert.equal(fillBytes(10 * 4096 + 100, 4096), 9 * 4096);
  assert.equal(fillBytes(4096, 4096), null);
  assert.equal(fillBytes(100, 4096), null);
});

test('manifest diff: a vanished Factory file is a deletion, a changed immutable file is a rewrite; the recipe filler is ignored', () => {
  const before = { 'environments/e/owner.json': { size: 10, sha256: 'a' }, 'control.sqlite-wal': { size: 5, sha256: null }, 'filler/f-x': { size: 9, sha256: null } };
  assert.deepEqual(deletedFiles(before, { 'environments/e/owner.json': { size: 10, sha256: 'a' }, 'control.sqlite-wal': { size: 999, sha256: null } }), []);
  assert.deepEqual(deletedFiles(before, { 'control.sqlite-wal': { size: 5, sha256: null } }), ['environments/e/owner.json']);
  assert.deepEqual(rewrittenFiles(before, { 'environments/e/owner.json': { size: 10, sha256: 'b' } }), ['environments/e/owner.json']);
});

const incomplete = { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE' };
function world(change: (results: HostFaultResults) => void = () => {}) {
  const results: HostFaultResults = {
    floor: { validateStorage: 'blocked', prepare: { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_PREPARATION' }, environmentsCreated: 0, capacity: 'blocked',
      pause: { receipt: 'durable', error: null }, availableBytes: 768 * 1024 ** 2 },
    full: { availableBytes: 0, enospcObserved: true, prepare: { status: 'failure', code: 'INSUFFICIENT_STORAGE_FOR_PREPARATION' }, environmentsCreated: 0,
      unpause: { receipt: null, error: 'SQLITE_FULL' }, deleted: [] },
    native: { cutReached: true, prepare: incomplete, ownerKept: true, deleted: [] },
    release: { again: incomplete, fresh: { status: 'success' }, deleted: [], rewritten: [], controlReadable: true, paused: true, lastAckedPaused: true },
  };
  change(results);
  return assess(results);
}

test('V-14.c verdict: passed only with every check; deletion, adoption or an ACK without durability FAIL; a missed native cut is INCONCLUSIVE', () => {
  assert.equal(world().status, 'passed', JSON.stringify(world().checks));
  assert.deepEqual(world(r => { r.full!.unpause = { receipt: 'durable', error: null }; r.release!.lastAckedPaused = false; r.release!.paused = false; }).failures, ['noAckWithoutDurability'],
    'a durable receipt on a full disk would have to be a real commit; the recipe treats it as a finding');
  assert.deepEqual(world(r => { r.release!.deleted = ['environments/e/owner.json']; }).failures, ['nothingDeleted']);
  assert.deepEqual(world(r => { r.release!.again = { status: 'success' }; }).failures, ['incompleteNeverAdopted'], 'an incomplete preparation adopted');
  assert.deepEqual(world(r => { r.floor!.environmentsCreated = 1; }).failures, ['floorRefusedBeforeEffect'], 'an irrecoverable intent created by a known refusal');
  assert.deepEqual(world(r => { r.release!.paused = false; }).failures, ['controlConsistent']);
  const missed = world(r => { r.native!.cutReached = false; r.native!.prepare = { status: 'success' }; r.release!.again = { status: 'success' }; });
  assert.deepEqual([missed.status, missed.inconclusive], ['inconclusive', ['NATIVE_CUT_NOT_REACHED']], 'nothing proven either way');
  assert.deepEqual(world(r => { r.full!.enospcObserved = false; }).inconclusive, ['ENOSPC_NOT_REACHED']);
  assert.equal(world(r => { r.release = null; }).status, 'failed');
});
