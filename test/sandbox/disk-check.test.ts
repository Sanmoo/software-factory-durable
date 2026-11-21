import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDiskFilesystem, type NativeRun } from '../../src/sandbox/filesystem.js';

// Ticket 55 (fast, offline): the preserved-disk check with the native tools doubled. In pilot 2 every refusal was a `qemu-img convert`
// of a 13-17 GiB root disk killed by the 30 s bound of the small metadata calls: the truncated copy then showed exactly the "damage"
// read from the kept snapshots (root entries `data`/`workspace` -> unused inodes, bitmap checksums), while the disks themselves were
// clean. The double models execFile's expiry: a step that needs longer than the `timeout` it is given is killed midway (SIGTERM,
// `killed: true`) and leaves a partial output. Durations are simulated, never waited for.
const size = 40n * 1073741824n;

/** A raw "copy" holding only an ext4 superblock of `size` (all the check reads natively; e2fsck is doubled). */
function superblockImage(): Buffer {
  const image = Buffer.alloc(2048);
  image.writeUInt32LE(Number(size / 4096n), 1024 + 4);
  image.writeUInt32LE(2, 1024 + 0x18); // 4 KiB blocks
  image.writeUInt16LE(0xef53, 1024 + 0x38);
  return image;
}

type Durations = { convertMs: number; e2fsckMs?: number; e2fsck?: { code: number; stdout: string } };

function tools(durations: Durations) {
  const calls: { tool: string; boundMs: number }[] = [];
  const runner: NativeRun = async (file, args, options) => {
    const tool = `${file.split('/').pop()} ${args[0]}`;
    calls.push({ tool, boundMs: options.timeout });
    const expire = (partial?: () => Promise<void>) => async () => {
      await partial?.();
      throw Object.assign(new Error(`Command failed: ${file}`), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' });
    };
    if (file === '/usr/bin/qemu-img' && args[0] === 'info') return { stdout: JSON.stringify({ format: 'qcow2', 'virtual-size': Number(size) }), stderr: '' };
    if (file === '/usr/bin/qemu-img' && args[0] === 'check') return { stdout: 'No errors were found on the image.\n', stderr: '' };
    if (file === '/usr/bin/qemu-img' && args[0] === 'convert') {
      const raw = args[args.length - 1]!;
      // Killed midway: the copy exists but stops short (here: no superblock content at all past the first bytes).
      if (durations.convertMs > options.timeout) await expire(() => writeFile(raw, Buffer.alloc(512)))();
      await writeFile(raw, superblockImage());
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/e2fsck') {
      if ((durations.e2fsckMs ?? 2000) > options.timeout) await expire()();
      if (durations.e2fsck)
        throw Object.assign(new Error(`Command failed: ${file}`), {
          killed: false,
          signal: null,
          code: durations.e2fsck.code,
          stdout: durations.e2fsck.stdout,
          stderr: '',
        });
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected native call ${file} ${args.join(' ')}`);
  };
  return { runner, calls };
}

async function environment() {
  const directory = await mkdtemp(join(tmpdir(), 'disk-check-'));
  const disk = join(directory, 'root.qcow2');
  await writeFile(disk, 'qcow2', { mode: 0o600 });
  return {
    directory,
    disk,
    async snapshots() {
      return (await readdir(directory)).filter(name => name.startsWith('filesystem-check-'));
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const [label, convertMs] of [
  ['35 s (pilot 2: 13-17 GiB disk, three checks at once)', 35_000],
  ['10 min (40 GiB fully allocated)', 600_000],
] as const) {
  test(`ticket 55: a healthy preserved disk whose whole-image copy takes ${label} passes the check`, async () => {
    const env = await environment();
    try {
      const { runner, calls } = tools({ convertMs });
      assert.deepEqual(await checkDiskFilesystem(env.directory, env.disk, size, runner), { ok: true });
      assert.deepEqual(await env.snapshots(), [], 'the private copy of a passed check is removed');
      // Whole-image steps get the image bound, not the 30 s bound of the metadata calls.
      for (const call of calls.filter(call => call.tool !== 'qemu-img info')) assert.ok(call.boundMs >= 1_800_000, `${call.tool} bound ${call.boundMs}`);
    } finally {
      await env.cleanup();
    }
  });
}

test('ticket 55: a copy killed by its bound refuses with the step and the expiry, and the kept snapshot says it is incomplete', async () => {
  const env = await environment();
  try {
    const { runner } = tools({ convertMs: Number.POSITIVE_INFINITY });
    const result = await checkDiskFilesystem(env.directory, env.disk, size, runner);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /^qemu-img convert: timed out after 1800 s and was killed \(its output is incomplete\)$/);
    const [kept] = await env.snapshots();
    assert.ok(kept, 'the failed snapshot is kept for inspection');
    assert.equal(await readFile(join(env.directory, kept, 'refusal.txt'), 'utf8'), `${result.reason}\n`);
  } finally {
    await env.cleanup();
  }
});

test('ticket 55: a damaged filesystem refuses with the e2fsck exit and its first findings (semantics unchanged: never repaired)', async () => {
  const env = await environment();
  try {
    const stdout =
      'e2fsck 1.47.4 (6-Mar-2025)\nPass 1: Checking inodes, blocks, and sizes\nPass 2: Checking directory structure\n' +
      "Entry 'data' in / (2) has deleted/unused inode 2068993.  Clear? no\n\nInode 2 ref count is 23, should be 21.  Fix? no\n";
    const { runner } = tools({ convertMs: 1000, e2fsck: { code: 4, stdout } });
    const result = await checkDiskFilesystem(env.directory, env.disk, size, runner);
    assert.deepEqual(result, {
      ok: false,
      reason: "e2fsck -f -n: exit 4 (Entry 'data' in / (2) has deleted/unused inode 2068993.  Clear? no | Inode 2 ref count is 23, should be 21.  Fix? no)",
    });
    const [kept] = await env.snapshots();
    assert.ok(kept);
    assert.deepEqual((await readdir(join(env.directory, kept))).sort(), ['refusal.txt', 'snapshot.ext4']);
  } finally {
    await env.cleanup();
  }
});

test('ticket 55: an unsafe root disk refuses with its reason before any native call', async () => {
  const env = await environment();
  try {
    await rm(env.disk);
    await writeFile(env.disk, 'qcow2', { mode: 0o644 });
    const { runner, calls } = tools({ convertMs: 1000 });
    assert.deepEqual(await checkDiskFilesystem(env.directory, env.disk, size, runner), {
      ok: false,
      reason: 'root disk: not a private regular file of this user',
    });
    assert.deepEqual(calls, []);
  } finally {
    await env.cleanup();
  }
});
