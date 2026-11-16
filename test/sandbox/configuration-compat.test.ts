import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';
import { validateConfiguration } from '../../src/sandbox/configuration.js';

// Backward-compatible reading of the optional `minFreeMemoryMiB` sandbox configuration field (written by ticket 24 environments, e.g. the
// real q24 v1 run). Reading only: no admission/ledger logic. Synthetic manager identity (systemctl double); no real manager, VM or signal.
const workId = 'configuration-compat-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const boot = 'boot-11111111-2222-4333-8444-555555555555';
const withFloor = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4,
  minFreeMemoryMiB: 1024 };

test('schema: minFreeMemoryMiB is accepted when present (positive integer) and absent from the effective configuration when not set', () => {
  const present = validateConfiguration(withFloor);
  assert.ok(present.valid);
  assert.equal(present.effective.minFreeMemoryMiB, 1024);
  const absent = validateConfiguration({ schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' });
  assert.ok(absent.valid);
  assert.equal('minFreeMemoryMiB' in absent.effective, false, 'no default: the identity of environments prepared without it is unchanged');
  for (const bad of [0, -1, 1.5, '1024']) assert.equal(validateConfiguration({ ...withFloor, minFreeMemoryMiB: bad }).valid, false, String(bad));
});

test('an environment whose owner/identity configuration carries minFreeMemoryMiB observes stopped with confirmed cessation (manager double)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-config-compat-'));
  const previousPath = process.env.PATH;
  t.after(async () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'environments', environment);
  const path = join(directory, boot);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const json = (p: string, value: unknown) => writeFile(p, JSON.stringify(value), { mode: 0o600 });
  const unit = `factory-sandbox-${boot}.service`;
  const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`;
  await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration: withFloor,
    guestAssets: { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) } });
  await json(join(directory, 'ready.json'), { environment });
  await json(join(directory, 'current.json'), { version: 1, environment, boot });
  await json(join(path, 'identity.json'), { version: 1, environment, boot, unit, hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    configuration: withFloor });
  await json(join(path, 'started.json'), { version: 1, boot, unit, invocation: 'a'.repeat(32), cgroup: group,
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') });
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '--user' || args[1] !== 'show' || args[2] !== ${JSON.stringify(unit)} || args.length !== 4) process.exit(77);
console.log('LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nInvocationID=${'a'.repeat(32)}\\nMainPID=0\\nControlGroup=\\nResult=success');
`, { mode: 0o700 });
  process.env.PATH = bin;
  const { storage: _storage, ...lifecycle } = await createSandbox({ root }).observe({ environment });
  assert.deepEqual(lifecycle, { condition: 'stopped', cessationConfirmed: true, consumption: 'unavailable', boot });
});
