import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Host reads of guest-writable trees (workspace/artifacts). Every component below `base` is lstat-ed (no symlink, directories only),
 * the leaf is opened O_NOFOLLOW, must be a single-link regular file whose identity matches the lstat, and is size-bounded. Absence is
 * null; anything unsafe throws CONFINED_PATH_UNSAFE. Not protection against a concurrently running hostile guest beyond these checks.
 */
async function components(base: string, relative: string): Promise<string | null> {
  const parts = relative.split('/');
  if (!isAbsolute(base) || await realpath(base) !== base || !parts.length || parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('CONFINED_PATH_UNSAFE');
  }
  let path = base;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error('CONFINED_PATH_UNSAFE');
  }
  return path;
}

async function openLeaf(path: string, maxBytes: number) {
  const before = await lstat(path, { bigint: true });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.dev !== before.dev || info.ino !== before.ino) throw new Error('CONFINED_PATH_UNSAFE');
    if (info.size > BigInt(maxBytes)) throw new Error('CONFINED_FILE_TOO_LARGE');
    return { file, size: Number(info.size) };
  } catch (error) { await file.close(); throw error; }
}

export async function readConfined(base: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  const path = await components(base, relative);
  if (!path) return null;
  const { file, size } = await openLeaf(path, maxBytes);
  try {
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(buffer, 0, size + 1, 0);
    if (bytesRead > maxBytes || bytesRead !== size) throw new Error('CONFINED_FILE_TOO_LARGE');
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Copies a confined tree (regular files/directories only) into a Factory-owned destination; bounded by files and bytes. */
export async function copyConfinedTree(base: string, relative: string, destination: string, budget: { files: number; bytes: number }): Promise<void> {
  const root = await components(base, relative);
  if (!root) return;
  const walk = async (rel: string) => {
    const source = join(base, rel);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error('CONFINED_PATH_UNSAFE');
    const target = join(destination, rel.slice(relative.length));
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(source)).sort()) await walk(`${rel}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error('CONFINED_PATH_UNSAFE');
    if (--budget.files < 0) throw new Error('CONFINED_TREE_TOO_LARGE');
    const { file, size } = await openLeaf(source, budget.bytes);
    budget.bytes -= size;
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const out = await open(target, 'wx', 0o600);
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
          if (!bytesRead) throw new Error('CONFINED_PATH_UNSAFE');
          await out.write(chunk.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally { await out.close(); }
    } finally { await file.close(); }
  };
  await walk(relative);
}
