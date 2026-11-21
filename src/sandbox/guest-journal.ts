import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, truncate, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inspectGuestAssets, type GuestAssetPin } from './guest-assets.js';
import { journalState } from './filesystem.js';

const run = promisify(execFile);
const native = { timeout: 600_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };

/**
 * Ticket 47: Gondolin 0.14's image builder always formats the guest root with `mke2fs -O ^has_journal` (`createRootfsImage`, no option), so
 * an abrupt VM stop leaves real metadata damage. This derives a NEW guest asset version from a pinned one, the way earlier variants were
 * derived (host-side finalization of a new copy of the raw image, then a recomputed Gondolin manifest): the rootfs copy grows by the journal
 * size and gets an ext4 journal (`tune2fs -O has_journal -J size=<n>`); kernel/initramfs/krun files are copied byte for byte. The source
 * assets are never modified. The result is a new pin (a new environment identity: existing environments keep the old pin).
 * Build tool for the operator/supervisor; never called at runtime and never boots a VM.
 */
export async function deriveJournaledGuestAssets({
  source,
  output,
  journalMiB = 128,
  now = new Date(),
}: {
  source: GuestAssetPin;
  output: string;
  journalMiB?: number;
  now?: Date;
}) {
  if (!isAbsolute(output) || resolve(output) !== output) throw new Error('OUTPUT_NOT_ABSOLUTE');
  if (!Number.isSafeInteger(journalMiB) || journalMiB < 4 || journalMiB > 1024) throw new Error('JOURNAL_SIZE_INVALID');
  if ((await inspectGuestAssets(source)).some(check => check.status !== 'ok')) throw new Error('SOURCE_GUEST_ASSETS_INVALID');
  const manifest = JSON.parse(await readFile(join(source.directory, 'manifest.json'), 'utf8')) as {
    config: { arch: string };
    assets: Record<string, string>;
    checksums: Record<string, string>;
    buildId?: string;
    buildTime?: string;
  };
  if ((await journalState(join(source.directory, manifest.assets.rootfs!))).journal) throw new Error('SOURCE_ROOTFS_ALREADY_JOURNALED');
  await mkdir(output, { mode: 0o755 }); // a NEW directory only (EEXIST refuses): never rewrite a published asset version
  const checksums: Record<string, string> = {};
  for (const [key, name] of Object.entries(manifest.assets)) {
    if (name.includes('/') || name === 'manifest.json') throw new Error('UNSAFE_ASSET_NAME');
    await copyFile(join(source.directory, name), join(output, name), constants.COPYFILE_EXCL);
    if (key !== 'rootfs') checksums[key] = await sha256(join(output, name));
  }
  const rootfs = join(output, manifest.assets.rootfs!);
  const info = await lstat(rootfs);
  // Room for the journal, so the journal never eats the template's free space (preparation grows each environment's copy anyway).
  await truncate(rootfs, info.size + journalMiB * 1024 * 1024);
  await run('/usr/bin/e2fsck', ['-f', '-n', rootfs], native);
  await run('/usr/bin/resize2fs', [rootfs], native);
  await run('/usr/bin/tune2fs', ['-O', 'has_journal', '-J', `size=${journalMiB}`, rootfs], native);
  await run('/usr/bin/e2fsck', ['-f', '-n', rootfs], native);
  const state = await journalState(rootfs);
  if (!state.journal || state.needsRecovery) throw new Error('JOURNAL_NOT_APPLIED');
  checksums.rootfs = await sha256(rootfs);
  for (const key of Object.keys(manifest.checksums))
    if (key !== 'rootfs' && checksums[key] !== manifest.checksums[key]) throw new Error('COPIED_ASSET_CHANGED');
  const derived = { ...manifest, buildId: assetBuildId(checksums as AssetChecksums, manifest.config.arch), buildTime: now.toISOString(), checksums };
  const text = JSON.stringify(derived, null, 2);
  await writeFile(join(output, 'manifest.json'), text, { flag: 'wx', mode: 0o644 });
  const pin = { directory: output, manifestSha256: createHash('sha256').update(text).digest('hex') };
  if ((await inspectGuestAssets(pin)).some(check => check.status !== 'ok')) throw new Error('DERIVED_GUEST_ASSETS_INVALID');
  const provenance = {
    operation: 'ticket 47: guest root ext4 journal (Gondolin 0.14 builder formats ^has_journal)',
    previous: source,
    output: pin,
    changedAssetKeys: ['rootfs'],
    method: `copy; grow ${journalMiB} MiB; e2fsck -fn; resize2fs; tune2fs -O has_journal -J size=${journalMiB}; e2fsck -fn clean`,
    source: 'src/sandbox/guest-journal.ts',
    checksums,
  };
  await writeFile(join(dirname(output), 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { pin, checksums, provenance };
}

async function sha256(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const digest = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) digest.update(chunk);
    return digest.digest('hex');
  } finally {
    await file.close();
  }
}

type AssetChecksums = { kernel: string; initramfs: string; rootfs: string; krunKernel?: string; krunInitrd?: string };
/** Gondolin 0.14 `computeAssetBuildId` (UUIDv5 of the checksums and arch in its fixed namespace), reproduced so the manifest stays its format. */
export function assetBuildId(checksums: AssetChecksums, arch: string) {
  const parts = [
    'gondolin-asset-build',
    `kernel=${checksums.kernel}`,
    `initramfs=${checksums.initramfs}`,
    `rootfs=${checksums.rootfs}`,
    ...(checksums.krunKernel !== undefined ? [`krunKernel=${checksums.krunKernel}`] : []),
    ...(checksums.krunInitrd !== undefined ? [`krunInitrd=${checksums.krunInitrd}`] : []),
    `arch=${arch}`,
  ];
  const namespace = Buffer.from('7b6ed0c07e7f4c2a8b2d0bf3d5be9d52', 'hex');
  const bytes = createHash('sha1')
    .update(Buffer.concat([namespace, Buffer.from(parts.join('\n'), 'utf8')]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
