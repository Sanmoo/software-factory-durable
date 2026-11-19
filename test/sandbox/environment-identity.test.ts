import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentIdentityDiagnostic } from '../../src/sandbox/index.js';

// Ticket 50: doctor's read-only warning before a restart — which retained prepared environments the new configuration would invalidate.
// Synthetic owner records only (no disk, VM or controller).
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 3072, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 };
const pin = { directory: '/release/assets/guest/a', manifestSha256: 'a'.repeat(64) };

async function environment(root: string, workId: string, options: { cleanup?: boolean } = {}) {
  const name = `env-${createHash('sha256').update(workId).digest('hex')}`;
  const directory = join(root, 'environments', name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ version: 1, workId, environment: name, configuration, guestAssets: pin }), { mode: 0o600 });
  if (options.cleanup) await writeFile(join(directory, 'cleanup-request.json'), '{}', { mode: 0o600 });
  return name;
}

test('ticket 50: memory/vCPU changes keep every environment; disk size, profile or assets changes are named per Work before the restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'environments'), { mode: 0o700 });
  assert.equal((await environmentIdentityDiagnostic(root, configuration as never, pin)).status, 'ok', 'no environment: nothing to warn');
  await environment(root, 'work-open-125');
  await environment(root, 'work-cleaned', { cleanup: true });

  const memory = await environmentIdentityDiagnostic(root, { ...configuration, memoryMiB: 4096, vcpus: 4 } as never, pin);
  assert.equal(memory.status, 'ok', 'the pilot #125 change (3072 -> 4096 MiB) keeps the environment');
  assert.match(memory.message, /^1 retained prepared environment/);

  const disk = await environmentIdentityDiagnostic(root, { ...configuration, diskGiB: 60 } as never, pin);
  assert.equal(disk.status, 'unverified');
  assert.match(disk.message, /WARNING: .* 1 of 1 retained .*work work-open-125 .*sandbox\.diskGiB 40 -> 60/);
  assert.doesNotMatch(disk.message, /work-cleaned/, 'an environment with a cleanup request is not retained');
  assert.match(disk.nextStep, /factory cancel <work>/);

  const assets = await environmentIdentityDiagnostic(root, configuration as never, { ...pin, manifestSha256: 'b'.repeat(64) });
  assert.match(assets.message, /guest assets aaaaaaaaaaaa -> bbbbbbbbbbbb/);
});
