import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type BootRef, type EnvironmentRef } from '../../src/sandbox/index.js';

const workId = 'startup-diagnostic-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
const boot = 'boot-77777777-2222-4333-8444-555555555555' as BootRef;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' };

// Previous-boot records and an external-manager double, never a running VM.
// No real systemctl fallback; public start must remain blocked on preserved disk.
async function failedBoot(diagnostic?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'factory-diagnostic-'));
  const directory = join(root, 'environments', environment);
  const path = join(directory, boot);
  const bin = join(root, 'bin');
  const guestAssets = { directory: join(root, 'assets'), manifestSha256: 'a'.repeat(64) };
  const unit = `factory-sandbox-${boot}.service`;
  const uid = process.getuid?.();
  await mkdir(path, { recursive: true, mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  const json = (name: string, value: unknown) => writeFile(name, JSON.stringify(value), { mode: 0o600 });
  await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration, guestAssets });
  await json(join(directory, 'ready.json'), { environment });
  await json(join(directory, 'current.json'), { version: 1, environment, boot });
  await json(join(path, 'identity.json'), {
    version: 1,
    environment,
    boot,
    unit,
    configuration,
    hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  });
  await json(join(path, 'started.json'), {
    version: 1,
    boot,
    unit,
    invocation: 'a'.repeat(32),
    cgroup: `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`,
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'),
    mountNamespace: await readlink('/proc/self/ns/mnt'),
  });
  if (diagnostic !== undefined) await json(join(path, 'failure.json'), diagnostic);
  const response = `LoadState=loaded\nActiveState=failed\nInvocationID=${'a'.repeat(32)}\nControlGroup=\nResult=exit-code\n`;
  await writeFile(
    join(bin, 'systemctl'),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '--user' || args[1] !== 'show' || args[2] !== ${JSON.stringify(unit)} || args.length !== 4) process.exit(77);
process.stdout.write(${JSON.stringify(response)});
`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  return {
    root,
    path,
    sandbox: createSandbox({ root, guestAssets }),
    async cleanup() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Sandbox.start reports a bounded previous-startup diagnostic without permitting disk reuse (manager double)', async () => {
  const fixture = await failedBoot({ version: 1, boot, phase: 'vm-start', code: 'GUEST_READINESS_TIMEOUT' });
  try {
    assert.deepEqual(await fixture.sandbox.start({ environment, configuration }), {
      status: 'failure',
      code: 'PRESERVED_DISK_CHECK_REQUIRED',
      boot,
      failure: { phase: 'vm-start', code: 'GUEST_READINESS_TIMEOUT' },
    });
  } finally {
    await fixture.cleanup();
  }
});

for (const [label, record] of [
  ['missing', undefined],
  ['another boot', { version: 1, boot: 'boot-88888888-2222-4333-8444-555555555555', phase: 'vm-start', code: 'GUEST_READINESS_TIMEOUT' }],
  ['unrecognized code', { version: 1, boot, phase: 'vm-start', code: 'PRIVATE_TOKEN_CANARY' }],
  ['raw error payload', { version: 1, boot, phase: 'vm-start', code: 'GUEST_READINESS_TIMEOUT', message: 'PRIVATE_TOKEN_CANARY' }],
  ['unrecognized phase', { version: 1, boot, phase: 'PRIVATE_TOKEN_CANARY', code: 'GUEST_READINESS_TIMEOUT' }],
] as const) {
  test(`Sandbox.start omits ${label} diagnostics without echoing payload or weakening restart denial (manager double)`, async () => {
    const fixture = await failedBoot(record);
    try {
      const result = await fixture.sandbox.start({ environment, configuration });
      assert.deepEqual(result, { status: 'failure', code: 'PRESERVED_DISK_CHECK_REQUIRED', boot });
      assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN_CANARY'), false);
    } finally {
      await fixture.cleanup();
    }
  });
}
