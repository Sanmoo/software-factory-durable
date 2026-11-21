import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Diagnostic } from '../contracts/index.js';

// Trusted composition data, not operator YAML or an asset-discovered checksum.
export interface GuestAssetPin {
  directory: string;
  manifestSha256: string;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// Inspect only the Gondolin 0.14.0 AssetManifest fields needed for integrity.
// This is not validation of its full BuildConfig or a Factory release manifest.
const manifestSchema = z.object({
  version: z.number().int(),
  config: z.object({ arch: z.string(), distro: z.string() }),
  assets: z.object({ kernel: z.string(), initramfs: z.string(), rootfs: z.string() }),
  checksums: z.object({ kernel: sha256, initramfs: sha256, rootfs: sha256 }),
});
const nextStep = 'Supply pinned assets through trusted composition; integrity checks do not qualify a release or prove boot.';
class AssetFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function readAsset(directory: string, name: string, expected: string, manifest = false) {
  // Reject aliases rather than following them, including intermediate symlinks.
  const parts = name.split('/');
  if (isAbsolute(name) || name.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new AssetFailure('UNSAFE_PATH');
  }
  let path = directory;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new AssetFailure('UNSAFE_PATH');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new AssetFailure('NOT_REGULAR_OR_ALIASED');
    if (manifest && before.size > 1024 * 1024) throw new AssetFailure('MANIFEST_TOO_LARGE');
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      total += chunk.length;
      if (manifest && total > 1024 * 1024) throw new AssetFailure('MANIFEST_TOO_LARGE');
      digest.update(chunk);
      if (manifest) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new AssetFailure('CHANGED_DURING_READ');
    }
    if (digest.digest('hex') !== expected) throw new AssetFailure('CHECKSUM_MISMATCH');
    return manifest ? Buffer.concat(chunks).toString('utf8') : '';
  } finally {
    await handle.close();
  }
}

function failure(id: string, error: unknown): Diagnostic {
  const fsCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = error instanceof AssetFailure ? error.code : fsCode === 'ENOENT' ? 'MISSING' : fsCode === 'ELOOP' ? 'UNSAFE_PATH' : 'UNREADABLE';
  return { id, status: 'blocked', message: code, nextStep };
}

export async function inspectGuestAssets(pin?: GuestAssetPin): Promise<Diagnostic[]> {
  if (!pin)
    return [
      {
        id: 'guest-assets',
        status: 'blocked',
        message: 'Explicit guest asset directory and trusted manifest SHA256 are required; no discovery or download was attempted.',
        nextStep,
      },
    ];
  const checks: Diagnostic[] = [];
  let manifest;
  try {
    if (!isAbsolute(pin.directory) || !sha256.safeParse(pin.manifestSha256).success) throw new AssetFailure('INVALID_PIN');
    const directory = resolve(pin.directory);
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory()) throw new AssetFailure('UNSAFE_PATH');
    const content = await readAsset(directory, 'manifest.json', pin.manifestSha256, true);
    let input: unknown;
    try {
      input = JSON.parse(content);
    } catch {
      throw new AssetFailure('MALFORMED_MANIFEST');
    }
    const parsed = manifestSchema.safeParse(input);
    if (!parsed.success) throw new AssetFailure('INCOMPLETE_MANIFEST');
    manifest = parsed.data;
    if (manifest.version !== 1) throw new AssetFailure('INCOMPATIBLE_MANIFEST_VERSION');
    if (manifest.config.arch !== 'x86_64' || manifest.config.distro !== 'alpine') throw new AssetFailure('INCOMPATIBLE_PROFILE');
    checks.push({
      id: 'guest-assets:manifest',
      status: 'ok',
      message: 'Manifest SHA256 matches the explicit pin; x86_64/Alpine integrity metadata present. No authenticity or build qualification asserted.',
      nextStep,
    });
    const names = new Set<string>();
    for (const asset of ['kernel', 'initramfs', 'rootfs'] as const) {
      const id = `guest-assets:${asset}`;
      try {
        const name = manifest.assets[asset];
        if (names.has(name) || name === 'manifest.json') throw new AssetFailure('ALIASED_ASSET');
        names.add(name);
        await readAsset(directory, name, manifest.checksums[asset]);
        checks.push({ id, status: 'ok', message: 'SHA256 matches pinned manifest; regular non-aliased file inspected without boot.', nextStep });
      } catch (error) {
        checks.push(failure(id, error));
      }
    }
  } catch (error) {
    checks.push(failure('guest-assets:manifest', error));
  }
  return checks;
}
