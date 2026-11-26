// Spec #68 §10 (tickets #80 and #81): the operator of a Triage world, through the REAL CLI process over the controller socket.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serveControl } from '../../src/entrypoints/controller/serve.js';
import type { triageWorld } from '../control/triage-investigation-fixture.js';
import { ended } from '../runner/budget.js';

type World = Awaited<ReturnType<typeof triageWorld>>;
export type CliResult = { code: number | null; stdout: string; stderr: string; json: unknown };

/** Serves the world's Control on the installation's operator socket and runs the built CLI against it, one process per command. */
export async function operator(t: { after(fn: () => Promise<void> | void): void }, w: World) {
  await mkdir(join(w.root, 'run'), { mode: 0o700 });
  const status = (await w.control().inspect({ kind: 'status' })) as { controller_run_id: string };
  const server = await serveControl(join(w.root, 'run', 'control.sock'), w.control(), status.controller_run_id, () => {});
  t.after(() => server.close());
  return async (...args: string[]): Promise<CliResult> => {
    const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', w.root, '--json'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/forbidden-personal-profile' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', data => (stdout += String(data)));
    child.stderr.on('data', data => (stderr += String(data)));
    const { code } = await ended(child, () => `factory ${args.join(' ')}`);
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
  };
}
