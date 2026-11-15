import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// I-local (ticket 33, r33-v1 diagnosis): a start refusal names its cause and the offending installation path, never only a generic code.
// The r33-v1 run created data/control.lock 0644 through a bare `flock`; every later start failed with an undiagnosable CONTROLLER_START_FAILED.
const controller = 'dist/src/entrypoints/controller.js';
async function root(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-cause-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['data', 'run', 'environments']) await mkdir(join(dir, name), { mode: 0o700 });
  return dir;
}
const last = (stderr: string) => JSON.parse(stderr.trim().split('\n').at(-1)!) as { code: string; cause?: string; path?: string };

test('a non-private lock file is reported as UNSAFE_CONTROL_PATH at data/control.lock (nothing repaired)', async t => {
  const dir = await root(t);
  await writeFile(join(dir, 'data', 'control.lock'), '', { mode: 0o644 });
  for (const args of [[dir], [dir, 'upgrade', 'status']]) {
    const result = spawnSync(process.execPath, [controller, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(last(result.stderr), { ...last(result.stderr), code: 'CONTROLLER_START_FAILED', cause: 'UNSAFE_CONTROL_PATH', path: 'data/control.lock' });
  }
});

test('a non-private installation directory is reported as PRIVATE_INSTALLATION_REQUIRED with its path', async t => {
  const dir = await root(t);
  await rm(join(dir, 'run'), { recursive: true });
  await mkdir(join(dir, 'run'), { mode: 0o755 });
  const result = spawnSync(process.execPath, [controller, dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 3);
  assert.deepEqual([last(result.stderr).cause, last(result.stderr).path], ['PRIVATE_INSTALLATION_REQUIRED', 'run']);
});
