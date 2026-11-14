import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSandbox } from '../../src/sandbox/index.js';

// Level S (Host read only): a preserved-source authorization counts only when the file exists and is listed in that version's sources.json,
// read with confined no-follow reads of the environment's artifacts tree.
const environment = `env-${'a'.repeat(64)}` as never;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-source-13-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, 'environments', environment, 'artifacts');
  await mkdir(join(artifacts, 'spec', 'v1'), { recursive: true });
  await mkdir(join(artifacts, 'instructions', 'v1'), { recursive: true });
  await writeFile(join(artifacts, 'spec', 'v1', 'ticket.json'), '{"body":"x"}');
  await writeFile(join(artifacts, 'spec', 'v1', 'unlisted.md'), 'x');
  await writeFile(join(artifacts, 'spec', 'v1', 'sources.json'), JSON.stringify({ version: 'v1', complete: true,
    sources: [{ origin: 'https://github.com/acme/project/issues/3', copy: './ticket.json', sha256: 'a'.repeat(64) }] }));
  return { root, artifacts };
}

test('AC1 review fix 3: a listed, existing preserved file is verified; unlisted, missing, unsafe or other-version references are invalid', async t => {
  const f = await fixture(t);
  await symlink(join(f.artifacts, 'spec', 'v1', 'ticket.json'), join(f.artifacts, 'spec', 'v1', 'link.md'));
  const sandbox = createSandbox({ root: f.root });
  const check = (reference: string) => sandbox.verifyPreservedSource({ environment, reference });
  assert.equal((await check('/artifacts/spec/v1/ticket.json#body')).status, 'verified');
  assert.equal((await check('/artifacts/spec/v1/ticket.json')).status, 'verified');
  assert.deepEqual(await check('/artifacts/spec/v1/unlisted.md#body'), { status: 'invalid', code: 'PRESERVED_SOURCE_NOT_LISTED' });
  assert.deepEqual(await check('/artifacts/spec/v1/link.md#body'), { status: 'invalid', code: 'PRESERVED_SOURCE_NOT_LISTED' });
  assert.deepEqual(await check('/artifacts/spec/v2/ticket.json#body'), { status: 'invalid', code: 'PRESERVED_SOURCE_INDEX_MISSING' });
  assert.deepEqual(await check('/artifacts/instructions/v1/ticket.json#body'), { status: 'invalid', code: 'PRESERVED_SOURCE_INDEX_MISSING' });
  assert.deepEqual(await check('/artifacts/spec/v1/../v1/ticket.json'), { status: 'invalid', code: 'AUTHORIZATION_REFERENCE_INVALID' });
  assert.deepEqual(await check('/workspace/checkout/README.md'), { status: 'invalid', code: 'AUTHORIZATION_REFERENCE_INVALID' });
  assert.deepEqual(await sandbox.verifyPreservedSource({ environment: 'env-x' as never, reference: '/artifacts/spec/v1/ticket.json' }),
    { status: 'invalid', code: 'ENVIRONMENT_REF_INVALID' });
  // A listed file that no longer exists is invalid too.
  await rm(join(f.artifacts, 'spec', 'v1', 'ticket.json'));
  assert.deepEqual(await check('/artifacts/spec/v1/ticket.json'), { status: 'invalid', code: 'PRESERVED_SOURCE_MISSING' });
});
