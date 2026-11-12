import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../../src/sandbox/index.js';

const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };
// Synthetic bytes, not bootable assets. Hash fixed independently using sha256sum.
const manifestSha256 = '9bf9e4c0a3af47bc92a350509f4ddfe7de3d319b5b63ca42a2939ad73b6ef80f';
async function assetFixture(root: string) {
  await writeFile(join(root, 'manifest.json'), await readFile('test/sandbox/asset-manifest.fixture.json'));
  await writeFile(join(root, 'vmlinuz-virt'), 'kernel fixture\n');
  await writeFile(join(root, 'initramfs.cpio.lz4'), 'initramfs fixture\n');
  await writeFile(join(root, 'rootfs.ext4'), 'rootfs fixture\n');
}

test('Sandbox.validate keeps configuration validity separate from missing explicitly pinned assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-sandbox-'));
  try {
    const report = await createSandbox({ root }).validate(configuration);
    assert.equal(report.configuration.valid, true);
    assert.deepEqual(report.checks.find(check => check.id === 'guest-assets'), {
      id: 'guest-assets', status: 'blocked',
      message: 'Explicit guest asset directory and trusted manifest SHA256 are required; no discovery or download was attempted.',
      nextStep: 'Supply pinned assets through trusted composition; integrity checks do not qualify a release or prove boot.',
    });
    assert.equal(report.checks.find(check => check.id === 'sandbox-release')?.status, 'unverified');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.validate verifies explicitly pinned bytes without claiming release or boot qualification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-assets-'));
  try {
    await assetFixture(root);
    const before = await readdir(root);
    const report = await createSandbox({ root, guestAssets: { directory: root, manifestSha256 } }).validate(configuration);
    assert.equal(report.configuration.valid, true);
    for (const id of ['guest-assets:manifest', 'guest-assets:kernel', 'guest-assets:initramfs', 'guest-assets:rootfs']) {
      assert.equal(report.checks.find(check => check.id === id)?.status, 'ok', id);
    }
    for (const id of ['sandbox-release', 'kvm-functional', 'docker-runtime']) {
      assert.equal(report.checks.find(check => check.id === id)?.status, 'unverified', id);
    }
    assert.deepEqual(await readdir(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.validate exposes Docker qualification blockers without creating resources or claiming runtime proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-docker-diagnostic-'));
  try {
    const report = await createSandbox({ root }).validate(configuration);
    assert.deepEqual(report.checks.find(check => check.id === 'sandbox-tool-channel'), {
      id: 'sandbox-tool-channel', status: 'blocked',
      message: 'The approved boot/invocation/role-bound executeTool channel is not implemented; fixed readiness commands are not a Builder tool interface.',
      nextStep: 'Implement the approved confined tool projection and adapter transport before Docker qualification; do not expose arbitrary guestExec or the Gondolin SDK.',
    });
    assert.deepEqual(report.checks.find(check => check.id === 'sandbox-network-policy'), {
      id: 'sandbox-network-policy', status: 'blocked',
      message: 'The current adapter disables guest networking; mediated public HTTPS and container trust paths are not implemented or qualified.',
      nextStep: 'Implement the approved network policy and layered TLS trust before requesting a separately authorized Docker/Testcontainers/Ryuk qualification; do not enable unrestricted networking or insecure TLS.',
    });
    assert.equal(report.checks.find(check => check.id === 'docker-runtime')?.status, 'unverified');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.validate distinguishes malformed, incomplete and incompatible pinned manifest metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-manifest-'));
  try {
    const { createHash } = await import('node:crypto');
    const baseline = await readFile('test/sandbox/asset-manifest.fixture.json', 'utf8');
    for (const [bytes, expected] of [
      ['{', 'MALFORMED_MANIFEST'],
      ['{"version":1}', 'INCOMPLETE_MANIFEST'],
      [baseline.replace('"arch":"x86_64",', ''), 'INCOMPLETE_MANIFEST'],
      [baseline.replace('x86_64', 'aarch64'), 'INCOMPATIBLE_PROFILE'],
      [baseline.replace('"alpine"', '"nixos"'), 'INCOMPATIBLE_PROFILE'],
      [baseline.replace('"version":1', '"version":2'), 'INCOMPATIBLE_MANIFEST_VERSION'],
    ]) {
      await writeFile(join(root, 'manifest.json'), bytes!);
      // Authentication is deliberately satisfied here to exercise metadata diagnostics,
      // not to prove checksum correctness (the positive fixture uses fixed hashes).
      const pin = createHash('sha256').update(bytes!).digest('hex');
      const report = await createSandbox({ root, guestAssets: { directory: root, manifestSha256: pin } }).validate(configuration);
      assert.equal(report.checks.find(check => check.id === 'guest-assets:manifest')?.message, expected);
      assert.equal(report.configuration.valid, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.validate reports missing and mismatched bytes independently, without repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-corrupt-assets-'));
  try {
    await assetFixture(root);
    await writeFile(join(root, 'vmlinuz-virt'), 'corrupted kernel');
    await rm(join(root, 'rootfs.ext4'));
    const report = await createSandbox({ root, guestAssets: { directory: root, manifestSha256 } }).validate(configuration);
    assert.equal(report.checks.find(check => check.id === 'guest-assets:kernel')?.message, 'CHECKSUM_MISMATCH');
    assert.equal(report.checks.find(check => check.id === 'guest-assets:rootfs')?.message, 'MISSING');
    assert.equal(report.checks.find(check => check.id === 'guest-assets:initramfs')?.status, 'ok');
    assert.equal(await readFile(join(root, 'vmlinuz-virt'), 'utf8'), 'corrupted kernel');
    assert.ok(!(await readdir(root)).includes('rootfs.ext4'));
    const untrusted = await createSandbox({ root, guestAssets: { directory: root, manifestSha256: '0'.repeat(64) } }).validate(configuration);
    assert.equal(untrusted.checks.find(check => check.id === 'guest-assets:manifest')?.message, 'CHECKSUM_MISMATCH');
    assert.ok(!untrusted.checks.some(check => check.id === 'guest-assets:kernel'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sandbox.validate rejects path traversal, symlink and hardlink aliases with real local files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-assets-paths-'));
  const outside = await mkdtemp(join(tmpdir(), 'factory-assets-outside-'));
  try {
    const { createHash } = await import('node:crypto');
    const { symlink, link, mkdir } = await import('node:fs/promises');
    const baseline = await readFile('test/sandbox/asset-manifest.fixture.json', 'utf8');
    await writeFile(join(outside, 'host-secret'), 'synthetic-private-data');
    await assetFixture(root);
    await symlink(outside, join(root, 'linked-parent'));
    await symlink(join(outside, 'host-secret'), join(root, 'linked-file'));
    await link(join(outside, 'host-secret'), join(root, 'hardlink'));
    await mkdir(join(root, 'directory'));
    for (const [path, expected] of [
      ['../host-secret', 'UNSAFE_PATH'], [join(outside, 'host-secret'), 'UNSAFE_PATH'],
      ['linked-parent/host-secret', 'UNSAFE_PATH'], ['linked-file', 'UNSAFE_PATH'],
      ['hardlink', 'NOT_REGULAR_OR_ALIASED'], ['directory', 'NOT_REGULAR_OR_ALIASED'],
      ['manifest.json', 'ALIASED_ASSET'],
    ]) {
      const bytes = baseline.replace('"kernel":"vmlinuz-virt"', `"kernel":${JSON.stringify(path)}`);
      await writeFile(join(root, 'manifest.json'), bytes);
      const pin = createHash('sha256').update(bytes).digest('hex');
      const report = await createSandbox({ root, guestAssets: { directory: root, manifestSha256: pin } }).validate(configuration);
      assert.equal(report.checks.find(check => check.id === 'guest-assets:kernel')?.message, expected, path);
      assert.doesNotMatch(JSON.stringify(report), /synthetic-private-data/);
    }
    await symlink(root, join(outside, 'directory-alias'));
    const alias = await createSandbox({ root, guestAssets: { directory: join(outside, 'directory-alias'), manifestSha256 } }).validate(configuration);
    assert.equal(alias.checks.find(check => check.id === 'guest-assets:manifest')?.message, 'UNSAFE_PATH');
    assert.equal(await readFile(join(outside, 'host-secret'), 'utf8'), 'synthetic-private-data');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Sandbox.validate rejects missing, symlinked, oversized manifests and invalid explicit pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-assets-manifest-'));
  try {
    const { symlink } = await import('node:fs/promises');
    const diagnose = async (directory = root, pin = manifestSha256) => {
      const report = await createSandbox({ root, guestAssets: { directory, manifestSha256: pin } }).validate(configuration);
      return report.checks.find(check => check.id === 'guest-assets:manifest')?.message;
    };
    assert.equal(await diagnose(), 'MISSING');
    assert.equal(await diagnose('relative-assets'), 'INVALID_PIN');
    assert.equal(await diagnose(root, 'not-a-hash'), 'INVALID_PIN');
    await writeFile(join(root, 'manifest.json'), ' '.repeat(1024 * 1024 + 1));
    assert.equal(await diagnose(), 'MANIFEST_TOO_LARGE');
    await rm(join(root, 'manifest.json'));
    await writeFile(join(root, 'other.json'), '{}');
    await symlink(join(root, 'other.json'), join(root, 'manifest.json'));
    assert.equal(await diagnose(), 'UNSAFE_PATH');
  } finally { await rm(root, { recursive: true, force: true }); }
});
