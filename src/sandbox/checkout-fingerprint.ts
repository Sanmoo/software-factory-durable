import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckoutFingerprint } from '../contracts/index.js';
import { observeConfined, readConfinedAt } from './confined.js';

/**
 * Directories of generated output and caches left out of the tree walk: a build/test run alone changes them, and they can be huge. A
 * change of the Builder's own sources there is not seen (the Git part still is). `.git` is observed through its metadata files only.
 */
export const fingerprintSkipped = Object.freeze(['.git', '.gradle', 'build', 'target', 'node_modules', '.m2', '.cache']);
export const fingerprintLimits = Object.freeze({ entries: 100_000, metadataBytes: 64 * 1024 * 1024 });

/**
 * Ticket 48: Host fingerprint of the Work's checkout (`<environment>/workspace/checkout`) WITHOUT host git or any guest command (spec §7.3):
 * the HEAD file and the branch ref it names (loose or packed), hashes of HEAD/ref/packed-refs/index, and a bounded no-follow walk of the
 * working tree (path, kind, size, mtime). Two fingerprints differ when commits were made or the checkout changed between them. It is not a
 * freeze nor proof against a hostile writer; it only decides continuation vs recovery after a budget end (both bounded by counters).
 */
export async function fingerprintCheckout(
  environmentDirectory: string,
  limits: { entries: number; metadataBytes: number } = fingerprintLimits,
): Promise<CheckoutFingerprint> {
  try {
    const checkout = join(await realpath(environmentDirectory), 'workspace', 'checkout');
    const headBytes = await readConfinedAt(checkout, '.git/HEAD', 4096);
    if (!headBytes) return { status: 'unavailable', code: 'CHECKOUT_HEAD_MISSING' };
    const head = headBytes.toString('utf8').trim();
    const branch = /^ref: (refs\/heads\/[A-Za-z0-9._/-]{1,240})$/.exec(head)?.[1] ?? null;
    if (branch?.split('/').some(part => part === '' || part === '.' || part === '..')) return { status: 'unavailable', code: 'CHECKOUT_HEAD_INVALID' };
    const git: Record<string, string> = {};
    for (const name of ['HEAD', 'index', 'packed-refs', ...(branch ? [branch] : [])]) {
      const observed = await observeConfined(checkout, `.git/${name}`, limits.metadataBytes).catch(() => ({ kind: 'unsafe' as const }));
      git[name] = 'sha256' in observed ? `${observed.kind}:${observed.sha256}` : observed.kind;
    }
    const ref = branch
      ? ((await readConfinedAt(checkout, `.git/${branch}`, 4096).catch(() => null))?.toString('utf8').trim() ??
        (await readConfinedAt(checkout, '.git/packed-refs', limits.metadataBytes).catch(() => null))
          ?.toString('utf8')
          .split('\n')
          .find(line => line.endsWith(` ${branch}`))
          ?.split(' ')[0] ??
        null)
      : /^[0-9a-f]{40,64}$/.test(head)
        ? head
        : null;
    const tree = createHash('sha256');
    let entries = 0;
    let bounded = true;
    const walk = async (relative: string): Promise<void> => {
      if (!bounded) return;
      const listed = await readdir(join(checkout, relative), { withFileTypes: true });
      listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of listed) {
        if (fingerprintSkipped.includes(entry.name) && (entry.isDirectory() || !relative)) continue;
        if (++entries > limits.entries) {
          bounded = false;
          return;
        }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        // lstat: never follows a link; the link itself (size/mtime) is what is fingerprinted.
        const info = await lstat(join(checkout, path), { bigint: true });
        const kind = info.isDirectory() ? 'd' : info.isFile() ? 'f' : info.isSymbolicLink() ? 'l' : 'o';
        tree.update(`${path}\0${kind}\0${info.isDirectory() ? 0n : info.size}\0${info.isDirectory() ? 0n : info.mtimeNs}\n`);
        if (kind === 'd') await walk(path);
      }
    };
    await walk('');
    return {
      status: 'observed',
      head,
      ref,
      git: createHash('sha256').update(JSON.stringify(git)).digest('hex'),
      tree: bounded ? tree.digest('hex') : null,
      entries: Math.min(entries, limits.entries),
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'CONFINED_PATH_UNSAFE') return { status: 'unavailable', code: 'CHECKOUT_PATH_UNSAFE' };
    return { status: 'unavailable', code: 'CHECKOUT_FINGERPRINT_UNAVAILABLE' };
  }
}
