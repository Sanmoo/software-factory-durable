import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSync, closeSync, writeSync, constants } from 'node:fs';
import { isatty } from 'node:tty';
import { createRecords } from '../records/index.js';
import { firstFactoryOAuthLogin } from '../workers/index.js';

const directories = ['releases', 'assets', 'credentials', 'data', 'environments', 'run'];
const initialConfiguration = `# Complete explicit operators, models and GitHub App references before operation.
# No repositories are authorized by setup. Never put secret values in this file.
schemaVersion: 1
operators: []
models:
  builder: { provider: null, model: null }
  standards: { provider: null, model: null }
  spec: { provider: null, model: null }
githubApp:
  appId: null
  privateKeyFile: credentials/github-app.pem
sandbox:
  schemaVersion: 1
  profile: gondolin-qemu-alpine-dev-v1
repositories: []
`;

export async function setup(root: string): Promise<{ root: string; created: string[] }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  // Preflight every known path before creating children; never follow/repair unknown content.
  for (const name of [...directories, 'config.yaml']) {
    try {
      const info = await lstat(join(canonicalRoot, name));
      if (info.isSymbolicLink() || (name === 'config.yaml' ? !info.isFile() : !info.isDirectory())) {
        throw new Error(`Unsafe installation path: ${name}`);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const created: string[] = [];
  for (const name of directories) {
    try {
      await mkdir(join(canonicalRoot, name), { mode: 0o700 });
      created.push(name);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await lstat(join(canonicalRoot, name));
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Unsafe installation path: ${name}`);
    }
  }
  try {
    await writeFile(join(canonicalRoot, 'config.yaml'), initialConfiguration, { flag: 'wx', mode: 0o600 });
    created.push('config.yaml');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { root: canonicalRoot, created };
}

/** Human-only terminal adapter. No authorization URLs go through process stdio,
 * Records, JSONL or sessions; no browser opener and no input/code capture. */
export async function firstHumanLogin(root: string): Promise<number> {
  let terminal: number | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  try {
    if (process.stdin.isTTY !== true) throw new Error('TTY_REQUIRED');
    terminal = openSync('/dev/tty', constants.O_WRONLY | constants.O_NOCTTY);
    if (!isatty(terminal)) throw new Error('TTY_REQUIRED');
    const fd = terminal;
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const records = await createRecords({ root }); // Register-only: no events/session/output capture.
    await firstFactoryOAuthLogin({ factoryRoot: root, records, signal: controller.signal,
      tty: { isTTY: true, authorizationURL(url) {
        writeSync(fd, `Open this authorization URL in your browser on this host. Do not paste codes or URLs here.\n${url}\n`);
      } } });
    writeSync(fd, 'Factory OAuth credential created. Model access and runtime operation are not qualified.\n');
    return 0;
  } catch {
    // Never serialize any native error, cause, stack, URL or response body.
    if (terminal !== undefined) {
      try { writeSync(terminal, 'Factory OAuth login unavailable. No automatic repair or retry.\n'); } catch { /* Closed. */ }
    }
    return 2;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (terminal !== undefined) { try { closeSync(terminal); } catch { /* Never expose raw terminal errors. */ } }
  }
}
