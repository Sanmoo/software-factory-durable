import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('dist/src/entrypoints/cli.js');

test('setup is repeatable, starts with no repositories, and preserves existing private material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-setup-'));
  try {
    const first = spawnSync(process.execPath, [cli, 'setup', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(
      (JSON.parse(first.stdout) as { created: string[] }).created.sort(),
      ['assets', 'config.yaml', 'credentials', 'data', 'environments', 'releases', 'run'].sort(),
    );
    assert.match(await readFile(join(root, 'config.yaml'), 'utf8'), /repositories: \[\]/);
    for (const name of ['credentials', 'data', 'run']) {
      assert.equal((await stat(join(root, name))).mode & 0o777, 0o700);
    }
    await writeFile(join(root, 'config.yaml'), '# existing configuration\n');
    await writeFile(join(root, 'credentials', 'key.pem'), 'synthetic-existing-key');
    await mkdir(join(root, 'data', 'unknown'), { mode: 0o755 });
    const second = spawnSync(process.execPath, [cli, 'setup', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).created, []);
    assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), '# existing configuration\n');
    assert.equal(await readFile(join(root, 'credentials', 'key.pem'), 'utf8'), 'synthetic-existing-key');
    assert.equal((await stat(join(root, 'data', 'unknown'))).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(join(root, 'environments')), []);
    assert.deepEqual(await readdir(join(root, 'run')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup refuses preexisting symlinks and incompatible paths before creating installation children', async () => {
  const { symlink } = await import('node:fs/promises');
  const parent = await mkdtemp(join(tmpdir(), 'factory-unsafe-'));
  const outside = join(parent, 'outside');
  const root = join(parent, 'installation');
  try {
    await mkdir(outside);
    await mkdir(root);
    await writeFile(join(outside, 'sentinel'), 'preserve');
    await symlink(outside, join(root, 'credentials'));
    const result = spawnSync(process.execPath, [cli, 'setup', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.deepEqual(await readdir(root), ['credentials']);
    assert.deepEqual(await readdir(outside), ['sentinel']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('setup includes prerequisite diagnostics without treating its incomplete initial example as operational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-prepared-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'setup', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.code, 'SETUP_PREPARED');
    assert.equal(report.diagnostics.configuration.valid, false);
    assert.ok(report.diagnostics.checks.find((check: { id: string }) => check.id === 'kvm-access'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects unknown commands and malformed arguments without filesystem changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-arguments-'));
  try {
    for (const args of [['unknown'], ['setup', '--unknown'], ['setup', '--root'], ['doctor', '--root', '--json'], ['setup', 'extra']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, /INVALID_ARGUMENTS/);
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
