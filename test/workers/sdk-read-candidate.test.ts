import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { remainingMs } from '../runner/budget.js';

// This is an investigation fixture, NOT the Workers implementation or an adopted SDK fork.
test('local SDK candidate preserves native read without host path probing for substituted operations', async () => {
  const base = resolve('.scratch/software-factory-mvp/sdk05-fixtures');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'candidate-'));
  try {
    const installed = await realpath('node_modules/@earendil-works/pi-coding-agent');
    assert.ok(installed.startsWith(`${await realpath('node_modules')}/`), 'SDK must be an owned local installation, not a shared symlink');
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '1.5.2');
    await cp(installed, join(root, 'sdk'), { recursive: true, dereference: false });
    const source = await readFile(join(root, 'sdk/dist/core/tools/read.js'), 'utf8');
    const sourceHash = createHash('sha256').update(source).digest('hex');
    assert.equal(sourceHash, 'e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc');
    assert.equal(source, await readFile('test/workers/fixtures/sdk-read-1.5.2-upstream.fixture', 'utf8'));
    await writeFile(join(root, 'probe.mjs'), await readFile('test/workers/fixtures/sdk-read-probe.fixture'));
    const run = () =>
      spawnSync(process.execPath, ['probe.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: remainingMs(),
        env: { PATH: process.env.PATH, TMPDIR: root, NODE_DISABLE_COMPILE_CACHE: '1', HOME: root },
      });
    const upstream = run();
    assert.equal(upstream.status, 1, `${upstream.stdout}\n${upstream.stderr}`);
    assert.match(upstream.stdout, /"hostProbes":5/);
    assert.match(upstream.stdout, /"guestPathKinds":\["requested","host-variant"\]/);
    assert.match(upstream.stderr, /substituted operations must not probe the host filesystem/);
    await rm(join(root, 'cafe\u0301.txt'));
    const patch = spawnSync('patch', ['--batch', '-p1', '-i', resolve('docs/evidence/05-sdk-read-operations-candidate.patch')], {
      cwd: join(root, 'sdk'),
      encoding: 'utf8',
      timeout: remainingMs(),
    });
    assert.equal(patch.status, 0, `${patch.stdout}\n${patch.stderr}`);
    const candidate = run();
    assert.equal(candidate.status, 0, `${candidate.stdout}\n${candidate.stderr}`);
    assert.match(candidate.stdout, /"hostProbes":0/);
    assert.match(candidate.stdout, /PASS custom operations/);
    assert.match(candidate.stdout, /PASS filtered bytes reach native SessionManager JSONL and reopened context without raw secret/);
    // This regression copy leaves installed upstream untouched. The Factory
    // development profile uses its own separately guarded private staging.
    assert.equal(source, await readFile(join(installed, 'dist/core/tools/read.js'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
