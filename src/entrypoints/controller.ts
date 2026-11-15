import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controllerPaths, prepareControllerLock, startFailureCause } from '../platform/host/index.js';

/** `upgrade <command> [...]` (ticket 33) runs the upgrade owner under the SAME canonical-storage lock instead of the controller owner. */
async function launch(root: string, upgrade: string[] | undefined): Promise<number> {
  const paths = await controllerPaths(root);
  if (Buffer.byteLength(paths.endpoint) > 103) throw new Error('SOCKET_PATH_TOO_LONG');
  await prepareControllerLock(paths.lockPath);
  const script = fileURLToPath(new URL(upgrade ? './controller/upgrade.js' : './controller/owner.js', import.meta.url));
  const owner = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '73',
    paths.lockPath, process.execPath, script, paths.root, ...(upgrade ?? [])],
  { stdio: 'inherit', env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' } });
  const interrupt = () => owner.kill('SIGINT');
  const terminate = () => owner.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      owner.once('error', reject);
      owner.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    if (code === 73) console.error(JSON.stringify({ code: 'CONTROLLER_ALREADY_RUNNING', message: 'Canonical storage already has an owner; do not remove the lock file.' }));
    return code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
try { process.exitCode = await launch(process.argv[2] ?? '.', process.argv[3] === 'upgrade' ? process.argv.slice(4) : undefined); }
catch (error) {
  console.error(JSON.stringify({ code: 'CONTROLLER_START_FAILED', ...startFailureCause(error),
    message: 'Check the named private installation path (owner, no group/other access, regular file/directory) and flock prerequisites; no takeover or repair.' }));
  process.exitCode = 3;
}
