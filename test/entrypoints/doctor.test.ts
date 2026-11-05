import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('dist/src/entrypoints/cli.js');

test('offline doctor reports paths, versions, permissions, KVM/systemd/storage/socket without changing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-doctor-'));
  try {
    assert.equal(spawnSync(process.execPath, [cli, 'setup', '--root', root, '--json']).status, 0);
    await writeFile(join(root, 'data', 'operational.sqlite'), 'not a database; must not be opened');
    await writeFile(join(root, 'credentials', 'do-not-read.pem'), 'synthetic-private-material');
    const before = await readdir(root, { recursive: true });
    const result = spawnSync(process.execPath, [cli, 'doctor', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2); // The generated example is deliberately incomplete.
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope, 'offline');
    assert.equal(report.configuration.valid, false);
    assert.equal(report.versions.node, '24.21.0');
    assert.equal(report.paths.root, root);
    for (const id of ['permissions:credentials', 'permissions:run', 'socket-path', 'storage', 'storage-lock-durability',
      'kvm-access', 'kvm-functional', 'systemd', 'qemu-system-x86_64', 'qemu-img', 'docker-runtime']) {
      const check = report.checks.find((item: { id: string }) => item.id === id);
      assert.ok(check, id);
      assert.ok(['ok', 'blocked', 'unverified'].includes(check.status), id);
      assert.ok(check.nextStep, id);
    }
    assert.equal(report.checks.find((item: { id: string }) => item.id === 'docker-runtime').status, 'unverified');
    assert.equal(report.checks.find((item: { id: string }) => item.id === 'storage-lock-durability').status, 'unverified');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-material/);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
    assert.equal(await readFile(join(root, 'data', 'operational.sqlite'), 'utf8'), 'not a database; must not be opened');
    assert.equal((await stat(join(root, 'run'))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor rejects a socket pathname that cannot fit Linux sockaddr_un without creating a socket', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'factory-long-'));
  const root = join(parent, 'x'.repeat(100));
  try {
    await mkdir(root);
    const result = spawnSync(process.execPath, [cli, 'doctor', '--root', root, '--json'], { encoding: 'utf8' });
    const check = JSON.parse(result.stdout).checks.find((item: { id: string }) => item.id === 'socket-path');
    assert.equal(check.status, 'blocked');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('importing public modules cannot write, spawn probes, or read a personal profile', async () => {
  const { pathToFileURL } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'factory-import-'));
  try {
    const script = `await import(${JSON.stringify(pathToFileURL(cli).href)});\n` +
      `await import(${JSON.stringify(pathToFileURL(resolve('dist/src/sandbox/index.js')).href)});\n` +
      `await import(${JSON.stringify(pathToFileURL(resolve('dist/src/control/index.js')).href)});\n` +
      `await import(${JSON.stringify(pathToFileURL(resolve('dist/src/protocol/index.js')).href)});`;
    const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${resolve('.')}`, '--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', env: { HOME: join(root, 'forbidden-profile'), GH_TOKEN: 'synthetic-not-to-inherit' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor refuses a symlinked configuration and reports permission issues without repairing them', async () => {
  const { symlink, chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'factory-private-'));
  try {
    await writeFile(join(root, 'external.yaml'), 'unknown: synthetic-do-not-read');
    await symlink(join(root, 'external.yaml'), join(root, 'config.yaml'));
    await mkdir(join(root, 'run'), { mode: 0o755 });
    await chmod(join(root, 'run'), 0o755);
    const result = spawnSync(process.execPath, [cli, 'doctor', '--root', root, '--json'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(report.configuration.errors[0].code, 'CONFIGURATION_UNREADABLE');
    assert.equal(report.checks.find((check: { id: string }) => check.id === 'permissions:run').status, 'blocked');
    assert.equal((await stat(join(root, 'run'))).mode & 0o777, 0o755);
    assert.doesNotMatch(result.stdout, /synthetic-do-not-read/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline version probes accept integer systemd versions and do not inherit personal credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-probes-'));
  try {
    await mkdir(join(root, 'bin'));
    const probe = `#!${process.execPath}\n` +
      `if (process.argv.slice(2).join(' ') !== '--version' || process.env.GH_TOKEN || process.env.HOME) process.exit(1);\n` +
      `console.log('systemd 777');\n`;
    for (const command of ['systemctl', 'qemu-system-x86_64', 'qemu-img']) {
      await writeFile(join(root, 'bin', command), probe, { mode: 0o700 });
    }
    const result = spawnSync(process.execPath, [cli, 'doctor', '--root', root, '--json'], {
      encoding: 'utf8', env: { PATH: join(root, 'bin'), HOME: '/synthetic-personal-home', GH_TOKEN: 'synthetic-not-to-forward' },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.versions.systemctl, '777');
    assert.equal(report.versions['qemu-system-x86_64'], '777');
    assert.equal(report.versions['qemu-img'], '777');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-not-to-forward/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
