import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryTree, parseReleaseManifest, productionProfile, releaseLauncher } from '../../src/entrypoints/release.js';
import type { UpgradeContext } from '../../src/entrypoints/controller/upgrade.js';

// I-local fixture (ticket 33): an installation root with SMALL synthetic release trees whose manifests are real (schema + exact inventory,
// verified by the real verifyReleaseTree) and real launchers pinned by them; synthetic guest assets pinned by hash. The trees carry no
// runnable code: the upgrade logic runs in this process as the target. Not evidence of a built release (see release33-qualification).
export const assetsSha256 = '9bf9e4c0a3af47bc92a350509f4ddfe7de3d319b5b63ca42a2939ad73b6ef80f';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const configuration = `schemaVersion: 1
operators: [operador]
models:
  builder: { provider: openai, model: gpt-6-luna }
  standards: { provider: openai, model: gpt-6-luna }
  spec: { provider: openai, model: gpt-6-luna }
githubApp: { appId: 123, privateKeyFile: credentials/github-app.pem }
sandbox: { schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1 }
repositories: []
`;

/** A release tree `releases/<id>` with a valid manifest; `storage` false omits the ticket-33 declaration (a pre-33 release: format 1 only). */
export async function fakeRelease(root: string, id: string, options: { storage?: boolean; skillPack?: string; configurationSchema?: number | null } = {}) {
  const directory = join(root, 'releases', id);
  await mkdir(join(directory, 'dist'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'dist', 'marker.txt'), `release ${id}\n`, { mode: 0o644 });
  const assets = join(root, 'assets', 'guest', assetsSha256);
  const launcher = releaseLauncher(id);
  const manifest = { schemaVersion: 1, kind: 'software-factory-release', release: id, builtAt: '2026-11-14T00:00:00.000Z',
    node: { version: '24.21.0', path: 'node/bin/node', sha256: 'a'.repeat(64), license: 'node/LICENSE' }, launcher: { path: 'factory', sha256: sha(launcher) },
    guestAssets: { path: `assets/guest/${assetsSha256}`, manifestSha256: assetsSha256, files: await inventoryTree(assets) },
    production: { id: productionProfile.id, sdkProfileId: productionProfile.sdkProfileId, builder: { skillPack: options.skillPack ?? 'factory-skills-v5' } },
    qualification: { status: 'unqualified', statement: 'synthetic' },
    metadata: { protocol: { version: 1 }, ...(options.configurationSchema === null ? {} : { formats: { configuration: options.configurationSchema ?? 1 } }),
      ...(options.storage === false ? {} : { storage: { format: 2, migratesFrom: [1] } }) },
    files: await inventoryTree(directory) };
  const bytes = JSON.stringify(manifest) + '\n';
  await writeFile(join(directory, 'release-manifest.json'), bytes, { mode: 0o644 });
  const parsed = parseReleaseManifest(bytes);
  if (!parsed) throw new Error('FIXTURE_MANIFEST_INVALID');
  return { directory, launcher, ...parsed };
}

/** Root with `previous` selected by its launcher and `target` extracted next to it (not selected). */
export async function installation(options: { previousStorage?: boolean; previousConfigurationSchema?: number | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-upgrade-'));
  for (const name of ['releases', 'assets', 'credentials', 'data', 'environments', 'run']) await mkdir(join(root, name), { mode: 0o700 });
  const assets = join(root, 'assets', 'guest', assetsSha256);
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await writeFile(join(assets, 'manifest.json'), await readFile('test/sandbox/asset-manifest.fixture.json'), { mode: 0o644 });
  for (const [name, text] of [['vmlinuz-virt', 'kernel fixture\n'], ['initramfs.cpio.lz4', 'initramfs fixture\n'], ['rootfs.ext4', 'rootfs fixture\n']] as const) {
    await writeFile(join(assets, name), text, { mode: 0o644 });
  }
  await writeFile(join(root, 'config.yaml'), configuration, { mode: 0o600 });
  const previous = await fakeRelease(root, 'mvp-32.1', { storage: options.previousStorage ?? false, skillPack: 'factory-skills-v4',
    ...(options.previousConfigurationSchema !== undefined ? { configurationSchema: options.previousConfigurationSchema } : {}) });
  await writeFile(join(root, 'factory'), previous.launcher, { mode: 0o755 });
  const target = await fakeRelease(root, 'mvp-33.1');
  const context: UpgradeContext = { root, storagePath: join(root, 'data', 'control.sqlite'),
    target: { directory: target.directory, manifest: target.manifest, manifestSha256: target.manifestSha256, checks: [],
      guestAssets: { directory: assets, manifestSha256: assetsSha256 } } };
  return { root, previous, target, context, assets };
}
