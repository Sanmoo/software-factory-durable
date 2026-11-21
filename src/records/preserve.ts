import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Protected reference of preserved evidence: what Control records before any removal (never the content itself). */
export type PreservedEvidence = { workId: string; id: string; manifestSha256: string; files: number; bytes: number };
export type Preservation = { status: 'preserved'; reference: PreservedEvidence } | { status: 'failed'; code: string };

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('EVIDENCE_AREA_UNSAFE');
}
async function sync(path: string, directory: boolean) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Q8 `preserve` (ticket 17): evidence that must survive the cleanup of an environment. A NEW private directory
 * `<root>/<work>/evidence/<id>/files/` receives exactly what `stage` writes (e.g. the Sandbox's confined export); every regular file is
 * hashed and synced, `manifest.json` lists them and is synced with its directories; only then is the reference returned. A failed stage
 * removes its own incomplete directory and returns no reference. Not a documentary collector or a sanitizer of arbitrary files.
 */
export async function preserveEvidence(input: {
  root: string;
  workId: string;
  label: string;
  stage(destination: string): Promise<void>;
}): Promise<Preservation> {
  if (!identifier.test(input.workId) || input.label.length > 256) return { status: 'failed', code: 'EVIDENCE_REFERENCE_INVALID' };
  let directory: string | undefined;
  try {
    const root = await realpath(input.root);
    await privateDirectory(join(root, input.workId));
    await privateDirectory(join(root, input.workId, 'evidence'));
    const id = randomUUID();
    directory = join(root, input.workId, 'evidence', id);
    await mkdir(directory, { mode: 0o700 });
    const files = join(directory, 'files');
    await mkdir(files, { mode: 0o700 });
    await input.stage(files);
    const entries: { path: string; bytes: number; sha256: string }[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const name of (await readdir(join(directory!, relative))).sort()) {
        const path = `${relative}/${name}`;
        const info = await lstat(join(directory!, path));
        if (info.isSymbolicLink()) throw new Error('EVIDENCE_UNSAFE');
        if (info.isDirectory()) {
          await walk(path);
          await sync(join(directory!, path), true);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1) throw new Error('EVIDENCE_UNSAFE');
        const handle = await open(join(directory!, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const hash = createHash('sha256');
          for await (const chunk of handle.readableWebStream()) hash.update(chunk as Uint8Array);
          await handle.sync();
          entries.push({ path, bytes: info.size, sha256: hash.digest('hex') });
        } finally {
          await handle.close();
        }
      }
    };
    await walk('files');
    await sync(files, true);
    const manifest = JSON.stringify({
      version: 1,
      kind: 'environment-evidence',
      label: input.label,
      files: entries,
      totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    });
    await writeFile(join(directory, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
    await sync(join(directory, 'manifest.json'), false);
    await sync(directory, true);
    await sync(join(root, input.workId, 'evidence'), true);
    return {
      status: 'preserved',
      reference: {
        workId: input.workId,
        id,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
        files: entries.length,
        bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
      },
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'EVIDENCE_PRESERVATION_FAILED';
    return { status: 'failed', code };
  }
}
