import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
