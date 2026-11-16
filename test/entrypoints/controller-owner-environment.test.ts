import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remainingMs } from '../runner/budget.js';

// I-local (real run qcand34-v1, R-CAND on the installed release): the controller launcher started the owner with ONLY PATH/LANG/LC_ALL, so
// `systemd-run --user` (and `systemctl --user`) in the owner could not reach the user manager: no factory-sandbox unit was ever created and
// the Execution was held START_ENVIRONMENT_START_UNCONFIRMED. In-process recipes kept the full environment and never saw it.
// A fake `flock` first on PATH records the environment the launcher gives the owner (no lock, owner or VM is started).
const controller = 'dist/src/entrypoints/controller.js';

async function launch(t: { after(fn: () => Promise<void>): void }, env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-owner-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  await mkdir(root, { mode: 0o700 });
  for (const name of ['data', 'run', 'environments']) await mkdir(join(root, name), { mode: 0o700 });
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const dump = join(dir, 'owner-env');
  await writeFile(join(bin, 'flock'), `#!/bin/sh\n/usr/bin/env > '${dump}'\nexit 0\n`);
  await chmod(join(bin, 'flock'), 0o755);
  const result = spawnSync(process.execPath, [controller, root], { encoding: 'utf8', timeout: remainingMs(), env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries((await readFile(dump, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('the owner receives the user-manager bus (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS) and nothing else from the caller', async t => {
  const env = await launch(t, { XDG_RUNTIME_DIR: '/run/user/4242', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/4242/bus', GH_TOKEN: 'never-forwarded', HOME: '/h' });
  assert.equal(env.XDG_RUNTIME_DIR, '/run/user/4242');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/4242/bus');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.LANG, 'C');
});

test('without them in the caller (a stripped environment), the owner still gets the account\'s standard user bus', async t => {
  const env = await launch(t, {});
  const uid = process.getuid?.();
  assert.equal(env.XDG_RUNTIME_DIR, `/run/user/${uid}`);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`);
});
