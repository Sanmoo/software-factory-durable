import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkInstalledDependencies } from '../../scripts/test-runner/deps.ts';

async function project(installed: Record<string, string>, extra: { optional?: string[]; packageJson?: object } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tr-deps-'));
  const packages: Record<string, object> = { '': { name: 'p', dependencies: { a: '1.0.0' }, devDependencies: { '@s/b': '2.0.0' } },
    'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0', dev: true },
    'node_modules/a/node_modules/c': { version: '3.0.0' } };
  for (const name of extra.optional ?? []) packages[`node_modules/${name}`] = { version: '9.0.0', optional: true, os: ['darwin'] };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  await writeFile(join(root, 'package.json'), JSON.stringify(extra.packageJson ?? { dependencies: { a: '1.0.0' }, devDependencies: { '@s/b': '2.0.0' } }));
  for (const [path, version] of Object.entries(installed)) {
    const file = join(root, path, 'package.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version }));
  }
  return root;
}

const complete = { 'node_modules/a': '1.0.0', 'node_modules/@s/b': '2.0.0', 'node_modules/a/node_modules/c': '3.0.0' };

test('installed tree matching the lockfile passes; an absent optional platform package is fine', async () => {
  const root = await project(complete, { optional: ['@s/darwin-only'] });
  try { assert.deepEqual(await checkInstalledDependencies(root), []); } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing (including dev) and drifted packages are named, nested ones too', async () => {
  const root = await project({ 'node_modules/a': '1.0.1', 'node_modules/a/node_modules/c': '3.0.0' });
  try {
    assert.deepEqual(await checkInstalledDependencies(root), [
      'node_modules/a: installed 1.0.1, lockfile 1.0.0',
      'node_modules/@s/b: missing (lockfile 2.0.0)',
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('package.json drifting from the lockfile root is refused', async () => {
  const root = await project(complete, { packageJson: { dependencies: { a: '1.0.0', zod: '4.0.0' }, devDependencies: { '@s/b': '2.0.0' } } });
  try {
    assert.deepEqual(await checkInstalledDependencies(root), ['package.json dependencies.zod=4.0.0 is not in package-lock.json (lockfile: absent)']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
