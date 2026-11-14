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

/**
 * Descriptor-relative walk (openat-style through /proc/self/fd/<dirfd>/<name>): every component is opened O_NOFOLLOW|O_DIRECTORY from the
 * descriptor of its parent, so a guest process swapping a parent for a symlink between checks cannot redirect the walk to a host path.
 * Returns the parent directory handle (caller closes) or null when a component is absent.
 */
async function parentAt(base: string, parts: string[]) {
  if (!isAbsolute(base) || await realpath(base) !== base || !parts.length || parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\0') || part.includes('/'))) {
    throw new Error('CONFINED_PATH_UNSAFE');
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory = await open(base, flags);
  try {
    for (const part of parts.slice(0, -1)) {
      let next;
      try { next = await open(`/proc/self/fd/${directory.fd}/${part}`, flags); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { await directory.close(); return null; }
        throw new Error('CONFINED_PATH_UNSAFE');
      }
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) { await directory.close().catch(() => {}); throw error; }
}

/**
 * Hash-only observation of one guest-writable path without following it (descriptor-relative walk): a symlink leaf is described by its
 * target text (never followed); a regular single-link leaf is hashed with a size bound; anything else is `other`. Absence is explicit.
 */
export async function observeConfined(base: string, relative: string, maxBytes: number): Promise<{ kind: 'absent' } | { kind: 'file'; sha256: string; size: number } | { kind: 'symlink'; sha256: string } | { kind: 'other' }> {
  const { createHash } = await import('node:crypto');
  const { readlink } = await import('node:fs/promises');
  const parts = relative.split('/');
  const parent = await parentAt(base, parts);
  if (!parent) return { kind: 'absent' };
  try {
    const leaf = `/proc/self/fd/${parent.fd}/${parts[parts.length - 1]}`;
    let file;
    try { file = await open(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'absent' };
      if (code === 'ELOOP') return { kind: 'symlink', sha256: createHash('sha256').update(Buffer.from(await readlink(leaf, { encoding: 'buffer' }))).digest('hex') };
      return { kind: 'other' };
    }
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return { kind: 'other' };
      if (info.nlink !== 1n) throw new Error('CONFINED_PATH_UNSAFE');
      if (info.size > BigInt(maxBytes)) throw new Error('CONFINED_FILE_TOO_LARGE');
      const size = Number(info.size);
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(1024 * 1024);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!bytesRead) throw new Error('CONFINED_PATH_UNSAFE');
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return { kind: 'file', sha256: hash.digest('hex'), size };
    } finally { await file.close(); }
  } finally { await parent.close(); }
}

/** Bounded read of one regular single-link file through the descriptor-relative walk; absence is null, a symlink/other is unsafe. */
export async function readConfinedAt(base: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  const parts = relative.split('/');
  const parent = await parentAt(base, parts);
  if (!parent) return null;
  try {
    let file;
    try { file = await open(`/proc/self/fd/${parent.fd}/${parts[parts.length - 1]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('CONFINED_PATH_UNSAFE'); }
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error('CONFINED_PATH_UNSAFE');
      if (info.size > BigInt(maxBytes)) throw new Error('CONFINED_FILE_TOO_LARGE');
      const buffer = Buffer.alloc(Number(info.size) + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== Number(info.size)) throw new Error('CONFINED_FILE_TOO_LARGE');
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  } finally { await parent.close(); }
}
