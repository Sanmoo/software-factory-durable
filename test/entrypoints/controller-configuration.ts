import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../../src/entrypoints/setup.js';

/** Complete synthetic configuration; no repositories, credentials, models or sandbox are used by these tests. */
export async function prepareController(root: string): Promise<void> {
  await setup(root);
  await writeFile(join(root, 'config.yaml'), `schemaVersion: 1
operators: []
models:
  builder: {provider: synthetic, model: unused}
  standards: {provider: synthetic, model: unused}
  spec: {provider: synthetic, model: unused}
githubApp: {appId: 1, privateKeyFile: credentials/unused.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories: []
`, { mode: 0o600 });
}
