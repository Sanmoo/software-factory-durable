import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import { metadata, privateDirectory } from './lifecycle.js';

async function syncParent(path: string) {
  await privateDirectory(dirname(path));
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// Recover only our exact two-link publication interrupted between link and unlink.
// A malformed, foreign or arbitrarily multi-linked final record is never replaced.
async function recoverLinkedPublication(path: string, text: string): Promise<boolean> {
  const final = await lstat(path, { bigint: true });
  if (
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.nlink !== 2n ||
    final.uid !== BigInt(process.getuid?.() ?? -1) ||
    final.mode & 0o077n ||
    final.size > 65536n
  )
    return false;
  await privateDirectory(dirname(path));
  const prefix = `${basename(path)}.pending-`;
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(name.slice(prefix.length))) continue;
    const temporary = join(dirname(path), name);
    const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.dev !== final.dev || before.ino !== final.ino || before.nlink !== 2n) continue;
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat({ bigint: true });
      if (
        BigInt(bytesRead) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        buffer.subarray(0, bytesRead).toString('utf8') !== text
      )
        return false;
      await file.sync();
      await unlink(temporary);
      await syncParent(path);
      return true;
    } finally {
      await file.close();
    }
  }
  return false;
}

/** Fully write+sync privately, exclusively link the finished record, then sync its directory. */
export async function publishCleanupRecord<T>(path: string, value: T, schema: z.ZodType<T>): Promise<void> {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) throw new Error('CLEANUP_RECORD_TOO_LARGE');
  const existing = async () => {
    if (JSON.stringify(await metadata(path, schema, { durable: true })) !== text) throw new Error('CLEANUP_RECORD_MISMATCH');
  };
  try {
    await existing();
    return;
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) {
      if (!(await recoverLinkedPublication(path, text))) throw e;
      await existing();
      return;
    }
  }
  const temporary = `${path}.pending-${randomUUID()}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    await unlink(temporary);
    await existing();
    return;
  }
  await unlink(temporary);
  await syncParent(path);
}
