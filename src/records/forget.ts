import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Ticket 31 (spec §12.4 `forget`): the explicit deletion of a Work's WHOLE host-only Records area `<root>/<work>/` (captures of every class,
// session copies and ticket 17's preserved evidence). It is the only Records operation that removes what retention keeps. Fail-closed: the tree
// is inspected first and anything that is not a directory or regular file of this uid (symlink, device, socket, foreign owner) refuses the
// whole deletion before anything is touched; nothing is followed. The directory is first renamed atomically to `<root>/.forget-<work>` (from
// then on it is no longer the Work's Records area), then removed; an interrupted removal leaves only that tombstone, which the next confirmed
// `forget` of the same Work removes. Copies elsewhere (backups, exports, GitHub) are never reached.

export type RecordsTree = {
  completeness: 'complete' | 'incomplete';
  observedAt: string;
  present: boolean;
  leftover: boolean;
  files: number;
  directories: number;
  bytes: number;
  /** Relative paths that refuse the deletion (never followed or removed). */ unsafe: string[];
};
export type RecordsForget = { outcome: 'removed' | 'absent' | 'refused' | 'failed'; code: string | null; files: number; bytes: number };

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const entryLimit = 200_000;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
class Unsafe extends Error {}

async function privateRoot(root: string) {
  const canonical = await realpath(root);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Unsafe();
  return canonical;
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Depth-first walk without following anything; `null` when the path does not exist. */
async function scan(
  path: string,
  label: string,
  result: { files: number; directories: number; bytes: number; unsafe: string[]; entries: number },
): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  const own = info.uid === process.getuid?.();
  if (info.isDirectory() && !info.isSymbolicLink() && own) {
    result.directories++;
    for (const name of (await readdir(path)).sort()) {
      if (++result.entries > entryLimit) {
        result.unsafe.push(`${label}/…(over ${entryLimit} entries)`);
        return true;
      }
      await scan(join(path, name), `${label}/${name}`, result);
    }
    return true;
  }
  if (info.isFile() && !info.isSymbolicLink() && own) {
    result.files++;
    result.bytes += info.size;
    return true;
  }
  result.unsafe.push(label);
  return true;
}
async function removeTree(path: string, removed: { files: number; bytes: number }) {
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(path)) await removeTree(join(path, name), removed);
    await rmdir(path);
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Unsafe();
  await unlink(path);
  removed.files++;
  removed.bytes += info.size;
}

/** Read-only inspection of what `forget` would delete for this Work (the Records area and an earlier interrupted deletion's tombstone). */
export async function inspectWorkRecords(root: string, workId: string): Promise<RecordsTree> {
  const observedAt = new Date().toISOString();
  const empty: RecordsTree = { completeness: 'incomplete', observedAt, present: false, leftover: false, files: 0, directories: 0, bytes: 0, unsafe: [] };
  if (!identifier.test(workId)) return { ...empty, unsafe: ['<invalid work id>'] };
  try {
    const canonical = await privateRoot(root);
    const result = { files: 0, directories: 0, bytes: 0, unsafe: [] as string[], entries: 0 };
    const present = await scan(join(canonical, workId), workId, result);
    const leftover = await scan(join(canonical, `.forget-${workId}`), `.forget-${workId}`, result);
    return {
      completeness: result.unsafe.length ? 'incomplete' : 'complete',
      observedAt,
      present,
      leftover,
      files: result.files,
      directories: result.directories,
      bytes: result.bytes,
      unsafe: result.unsafe.slice(0, 50),
    };
  } catch {
    return empty;
  }
}

/**
 * Deletes the Work's whole Records area (and a tombstone left by an interrupted earlier deletion). Refused, with nothing touched, when the
 * tree holds anything unsafe. `absent` only when neither exists under the intact private root. A removal cut half-way is `failed` (what is
 * left is only the tombstone, visible to the next inspection).
 */
export async function forgetWorkRecords(
  root: string,
  workId: string,
  /** Test seam only: runs right after the atomic rename (e.g. to place an entry that appears mid-removal). */
  hooks: { afterRename?(tombstone: string): Promise<void> } = {},
): Promise<RecordsForget> {
  const none = { files: 0, bytes: 0 };
  if (!identifier.test(workId)) return { outcome: 'refused', code: 'WORK_ID_INVALID', ...none };
  let canonical: string;
  try {
    canonical = await privateRoot(root);
  } catch {
    return { outcome: 'failed', code: 'RECORDS_AREA_UNAVAILABLE', ...none };
  }
  const area = join(canonical, workId),
    tombstone = join(canonical, `.forget-${workId}`);
  const tree = await inspectWorkRecords(canonical, workId);
  if (tree.completeness !== 'complete')
    return { outcome: tree.unsafe.length ? 'refused' : 'failed', code: tree.unsafe.length ? 'RECORDS_TREE_UNSAFE' : 'RECORDS_AREA_UNAVAILABLE', ...none };
  if (!tree.present && !tree.leftover) return { outcome: 'absent', code: null, ...none };
  const removed = { files: 0, bytes: 0 };
  let renamed = false;
  try {
    if (tree.present) {
      if (tree.leftover) await removeTree(tombstone, removed);
      await rename(area, tombstone);
      renamed = true;
      await syncDirectory(canonical);
      await hooks.afterRename?.(tombstone);
    }
    await removeTree(tombstone, removed);
    await syncDirectory(canonical);
    return { outcome: 'removed', code: null, ...removed };
  } catch (error) {
    // Review LOW: once anything changed (renamed or unlinked), the result is a PARTIAL deletion with its counts, never a clean refusal: what is
    // left is the tombstone, shown by the next inspection. An unsafe entry found before any change is a refusal.
    if (renamed || removed.files)
      return { outcome: 'failed', code: error instanceof Unsafe ? 'RECORDS_FORGET_PARTIAL_UNSAFE' : 'RECORDS_FORGET_PARTIAL', ...removed };
    return {
      outcome: error instanceof Unsafe ? 'refused' : 'failed',
      code: error instanceof Unsafe ? 'RECORDS_TREE_UNSAFE' : 'RECORDS_FORGET_FAILED',
      ...removed,
    };
  }
}
