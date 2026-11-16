import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { remainingMs } from '../runner/budget.js';

test('vendor skipLibCheck does not disable strict application or exact optional-property checking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-typecheck-'));
  try {
    const config = JSON.parse(await readFile('tsconfig.json', 'utf8'));
    assert.equal(config.compilerOptions.strict, true);
    assert.equal(config.compilerOptions.exactOptionalPropertyTypes, true);
    assert.equal(config.compilerOptions.skipLibCheck, true);
    config.compilerOptions.types = [];
    config.include = ['fixture.ts'];
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
    await writeFile(join(root, 'fixture.ts'), 'export const invalid: string = 42;\nexport const optional: { value?: string } = { value: undefined };\n');
    const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--noEmit'],
      { cwd: root, encoding: 'utf8', timeout: remainingMs() });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /TS2322/);
    assert.match(result.stdout, /TS2375/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
