// TEST ONLY. Ticket 06 physical qualification recipe (operator grant 2026-11-14).
// Every non-`plan` invocation is a REAL effect on one new owned 06 Work. Steps are
// one-shot: an intent tombstone precedes effects and a consumed step never reruns.
// Guest commands go only through the product Builder executeTool channel bound to
// the exact current boot; no direct VM.exec, host Docker, host networking or cleanup.
import type { BootRef, EnvironmentRef } from '../../src/sandbox/index.js';

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q06-qualification-v3`;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
const configuration = {
  schemaVersion: 1,
  profile: 'gondolin-qemu-alpine-dev-v1',
  memoryMiB: 4096,
  vcpus: 2,
  diskGiB: 40,
  shutdownGraceSeconds: 30,
  minFreeSpaceGiB: 4,
} as const;
const stepName = /^[a-z0-9][a-z0-9-]{0,47}$/;

type Identity = { workId: string; executionId: string; environment: string };

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8'));
  const exists = async (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  return { fs, save, load, exists };
}

export async function main(args: string[]) {
  const [command, name, commandFile, timeoutText] = args;
  const { fs, save, load, exists } = await io();
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  if (command === 'prepare') {
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    const { randomUUID, createHash } = await import('node:crypto');
    const workId = `q06-${randomUUID()}`;
    const identity: Identity = { workId, executionId: `q06-${randomUUID()}`, environment: 'env-' + createHash('sha256').update(workId).digest('hex') };
    await save('prepare-intent', { identity, configuration });
    const result = await sandbox.prepare({ workId, configuration });
    await save('prepare-result', { identity, result });
    if (result.status !== 'success' || result.environment !== identity.environment) throw new Error('PREPARATION_HELD');
    return result;
  }
  const { identity } = (await load('prepare-result')) as { identity: Identity };
  const environment = identity.environment as EnvironmentRef;
  if (command === 'start') {
    if (!name || !/^boot[12]$/.test(name)) throw new Error('START_NAME');
    await save(`${name}-start-intent`, { identity });
    const result = await sandbox.start({ environment, configuration });
    await save(`${name}-start-result`, { identity, result });
    if (result.status !== 'success') throw new Error('START_HELD');
    return result;
  }
  const currentBoot = async () => {
    for (const boot of ['boot2', 'boot1'])
      if ((await exists(`${boot}-start-result`)) && !(await exists(`${boot}-stop-intent`))) {
        const { result } = (await load(`${boot}-start-result`)) as { result: { status: string; boot: string } };
        return { label: boot, boot: result.boot as BootRef };
      }
    throw new Error('NO_ACTIVE_OWNED_BOOT');
  };
  if (command === 'observe') {
    const { label, boot } = await currentBoot();
    return sandbox.observe({ environment, boot }).then(observed => ({ label, observed }));
  }
  if (command === 'stop') {
    const { label, boot } = await currentBoot();
    await save(`${label}-stop-intent`, { identity, boot });
    const observed = await sandbox.observe({ environment, boot });
    const result = await sandbox.stop({ environment, boot, reason: 'q06 qualification explicit stop' });
    await save(`${label}-stop-result`, { identity, boot, before: observed, result });
    return result;
  }
  if (command === 'bash') {
    if (!name || !stepName.test(name) || !commandFile) throw new Error('STEP_ARGUMENTS');
    const timeout = Number(timeoutText ?? '600');
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw new Error('STEP_TIMEOUT');
    const script = await fs.readFile(commandFile, 'utf8');
    const { boot, label } = await currentBoot();
    const context = {
      workId: identity.workId,
      executionId: identity.executionId,
      invocationId: `q06-${name}`,
      role: 'builder' as const,
      environmentRef: identity.environment,
      bootRef: boot,
      phaseId: `q06-${name}`,
    };
    await save(`step-${name}-intent`, { context, boot: label, timeout, script });
    let progress = 0;
    const result = await sandbox.executeTool(context, { name: 'bash', command: script, timeout, callId: `q06-${name}` }, data => {
      progress += data.length;
    });
    // Filtered protected capture of this Work only (Records), bounded; never raw guest output.
    let text: string | undefined;
    if (result.status === 'success') {
      const output = `${root}/${identity.workId}/evidence/${result.reference.id}/output`;
      const info = await fs.lstat(output);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('CAPTURE_HELD');
      const handle = await fs.open(output, 'r');
      try {
        const size = Math.min(info.size, 262144);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, info.size - size);
        text = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    }
    await save(`step-${name}-result`, {
      boot: label,
      status: result.status,
      ...(result.status === 'success'
        ? { exitCode: 'exitCode' in result ? result.exitCode : undefined, reference: result.reference, bytes: result.bytes }
        : { code: result.code }),
      progress,
      text,
    });
    return {
      status: result.status,
      ...(result.status === 'success' ? { exitCode: 'exitCode' in result ? result.exitCode : undefined } : { code: result.code }),
      text,
    };
  }
  throw new Error('EXACT_COMMAND_REQUIRED');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Explicit exit: the bound tool projection keeps its channel open by design.
  main(process.argv.slice(2)).then(
    value => {
      process.stdout.write(JSON.stringify(value, null, 1) + '\n', () => process.exit(0));
    },
    error => {
      console.error('Qualification step held; no retry:', error instanceof Error ? error.message : 'UNKNOWN');
      process.exit(1);
    },
  );
}
