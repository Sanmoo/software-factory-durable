import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCheckouts } from '../../src/sandbox/checkout.js';

// Real git on temporary local fixture repositories; GitHub is substituted by a file:// upstream and a credential double.
// Proves host preparation behaviour, NOT the real GitHub fetch or guest use.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x' } }).trim();

async function upstream(dir: string, name: string) {
  const path = join(dir, name);
  await mkdir(path);
  git(path, 'init', '-q', '-b', 'main');
  await writeFile(join(path, 'README.md'), `# ${name}\n`);
  await writeFile(join(path, '.gitattributes'), '* filter=canary\n');
  await mkdir(join(path, '.githooks'));
  await writeFile(join(path, '.githooks', 'post-checkout'), `#!/bin/sh\ntouch ${join(dir, 'HOOK_RAN')}\n`, { mode: 0o755 });
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'initial');
  return { path, head: git(path, 'rev-parse', 'HEAD') };
}

async function world(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-checkout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  await mkdir(join(root, 'environments'), { recursive: true, mode: 0o700 });
  // A hostile personal profile of the host account: global config with hooks/templates/filters. Must never apply.
  const home = join(dir, 'home');
  await mkdir(join(home, 'hooks'), { recursive: true });
  await writeFile(join(home, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${join(dir, 'PERSONAL_HOOK_RAN')}\n`, { mode: 0o755 });
  await writeFile(join(home, '.gitconfig'), `[core]\n\thooksPath = ${join(home, 'hooks')}\n[init]\n\ttemplateDir = ${home}\n[filter "canary"]\n\tsmudge = touch ${join(dir, 'FILTER_RAN')}; cat\n`);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => { process.env.HOME = previousHome; });
  const environment = async (name: string) => {
    const path = join(root, 'environments', name);
    await mkdir(join(path, 'workspace'), { recursive: true, mode: 0o700 });
    await mkdir(join(path, 'artifacts'), { mode: 0o700 });
    return path;
  };
  return { dir, root, environment };
}

const request = (repository: string, repositoryId: number, branch: string) => ({ repository, repositoryId, installationId: 2, base: 'main', branch });

test('AC2/AC3: Factory-exclusive bare cache, then an independent no-hardlinks clone with a GitHub origin and its own branch; no repo or personal hooks/filters', async t => {
  const w = await world(t);
  const project = await upstream(w.dir, 'project');
  const fetches: string[] = [];
  const checkouts = createCheckouts({ root: w.root, remoteUrl: () => `file://${project.path}`,
    fetch: { async fetch(scope) { fetches.push(scope.repository); return { token: 'synthetic-fetch-token', expiresAt: new Date(Date.now() + 3600000).toISOString() }; } } });
  const env = await w.environment('env-a');
  const result = await checkouts.prepare(env, request('acme/project', 3, 'factory/work-a'));
  assert.equal(result.status, 'success', JSON.stringify(result));
  if (result.status !== 'success') return;
  assert.deepEqual({ ...result.checkout, preparedAt: 'x' }, { path: '/workspace/checkout', repository: 'acme/project', repositoryId: 3, base: 'main',
    branch: 'factory/work-a', baseCommit: project.head, origin: 'https://github.com/acme/project.git', reused: false, preparedAt: 'x' });
  const checkout = join(env, 'workspace', 'checkout');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), project.head);
  assert.equal(git(checkout, 'branch', '--show-current'), 'factory/work-a');
  assert.equal(git(checkout, 'config', '--get', 'remote.origin.url'), 'https://github.com/acme/project.git', 'origin is GitHub, never the cache or a credentialed URL');
  await assert.rejects(access(join(checkout, '.git', 'objects', 'info', 'alternates')), 'no alternates/shared/reference');
  for (const name of await readdir(join(checkout, '.git', 'objects'), { recursive: true })) {
    const info = await lstat(join(checkout, '.git', 'objects', name));
    if (info.isFile()) assert.equal(info.nlink, 1, `object ${name} is an independent copy (no hardlink)`);
  }
  assert.deepEqual((await readdir(join(checkout, '.git', 'hooks')).catch(() => [])), [], 'no hooks installed from any template');
  for (const canary of ['HOOK_RAN', 'PERSONAL_HOOK_RAN', 'FILTER_RAN']) await assert.rejects(access(join(w.dir, canary)), `${canary}: nothing executed on the host`);
  // Cache: per repository, outside every environment (never mounted into a guest), bare.
  const cache = join(w.root, 'cache', 'git', '3.git');
  assert.equal(git(cache, 'rev-parse', '--is-bare-repository'), 'true');
  assert.ok(!cache.startsWith(join(w.root, 'environments')));
  assert.equal((await lstat(join(w.root, 'cache'))).mode & 0o777, 0o700);
  assert.deepEqual(fetches, ['acme/project']);
  const metadata = JSON.parse(await readFile(join(env, 'checkout.json'), 'utf8'));
  assert.equal(metadata.baseCommit, project.head, 'host-only metadata next to (not inside) the guest-visible workspace');
  assert.doesNotMatch(JSON.stringify(metadata) + git(checkout, 'config', '--list') + git(cache, 'config', '--list'), /synthetic-fetch-token/);

  // Continuation: the same environment reuses its own branch/workspace/metadata; no fetch, no clone, no git run in the guest-writable tree.
  await writeFile(join(checkout, 'work-in-progress.txt'), 'kept');
  await mkdir(join(checkout, '.git', 'hooks'), { recursive: true });
  await writeFile(join(checkout, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${join(w.dir, 'GUEST_PLANTED_HOOK_RAN')}\n`, { mode: 0o755 });
  const again = await checkouts.prepare(env, request('acme/project', 3, 'factory/work-a'));
  assert.equal(again.status === 'success' && again.checkout.reused, true);
  assert.deepEqual(fetches, ['acme/project'], 'continuation does not fetch');
  assert.equal(await readFile(join(checkout, 'work-in-progress.txt'), 'utf8'), 'kept');
  await assert.rejects(access(join(w.dir, 'GUEST_PLANTED_HOOK_RAN')), 'a hook planted by the guest is never run by the host');
  assert.deepEqual(await checkouts.prepare(env, request('acme/project', 3, 'factory/other')), { status: 'failure', code: 'CHECKOUT_IDENTITY_MISMATCH' });
});

test('AC2/AC3: same repository is sequenced fetch -> completed clone; distinct repositories proceed in parallel; Works share no writable metadata', async t => {
  const w = await world(t);
  const repos = { 'acme/project': await upstream(w.dir, 'project'), 'acme/lib': await upstream(w.dir, 'lib') };
  const events: string[] = [];
  let releaseLib!: () => void;
  const libGate = new Promise<void>(resolve => { releaseLib = resolve; });
  const envs = { a: await w.environment('env-a'), b: await w.environment('env-b'), c: await w.environment('env-c') };
  const checkouts = createCheckouts({ root: w.root, remoteUrl: scope => `file://${repos[scope.repository as keyof typeof repos].path}`,
    fetch: { async fetch(scope) {
      events.push(`fetch:${scope.repository}:${await access(join(envs.a, 'checkout.json')).then(() => 'a-cloned', () => 'a-pending')}`);
      if (scope.repository === 'acme/lib') await libGate;
      return { token: 't', expiresAt: new Date(Date.now() + 3600000).toISOString() };
    } } });
  const lib = checkouts.prepare(envs.c, request('acme/lib', 4, 'factory/work-c'));
  await new Promise(resolve => setImmediate(resolve));
  const [a, b] = await Promise.all([checkouts.prepare(envs.a, request('acme/project', 3, 'factory/work-a')),
    checkouts.prepare(envs.b, request('acme/project', 3, 'factory/work-b'))]);
  assert.equal(a.status, 'success'); assert.equal(b.status, 'success');
  assert.deepEqual(events, ['fetch:acme/lib:a-pending', 'fetch:acme/project:a-pending', 'fetch:acme/project:a-cloned'],
    'project proceeded while lib was still fetching (no global mutex); the second project fetch waited for the first clone');
  releaseLib();
  assert.equal((await lib).status, 'success');
  const [checkoutA, checkoutB] = [join(envs.a, 'workspace', 'checkout'), join(envs.b, 'workspace', 'checkout')];
  assert.equal(git(checkoutA, 'branch', '--show-current'), 'factory/work-a');
  assert.equal(git(checkoutB, 'branch', '--show-current'), 'factory/work-b');
  const inodes = async (path: string) => new Set((await Promise.all((await readdir(join(path, '.git'), { recursive: true }))
    .map(async name => { const info = await lstat(join(path, '.git', name)); return info.isFile() ? `${info.dev}:${info.ino}` : ''; }))).filter(Boolean));
  const [first, second] = [await inodes(checkoutA), await inodes(checkoutB)];
  assert.equal([...first].filter(inode => second.has(inode)).length, 0, 'no shared writable Git metadata between Works');
});

test('a failed preparation leaves an explicit tombstone: never retried or adopted automatically', async t => {
  const w = await world(t);
  const project = await upstream(w.dir, 'project');
  let calls = 0;
  const checkouts = createCheckouts({ root: w.root, remoteUrl: () => `file://${project.path}`,
    fetch: { async fetch() { calls++; throw Object.assign(new Error('GITHUB_TOKEN_ISSUANCE_UNKNOWN'), { code: 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' }); } } });
  const env = await w.environment('env-a');
  assert.deepEqual(await checkouts.prepare(env, request('acme/project', 3, 'factory/work-a')), { status: 'failure', code: 'CHECKOUT_FETCH_CREDENTIAL_UNAVAILABLE' });
  assert.deepEqual(await checkouts.prepare(env, request('acme/project', 3, 'factory/work-a')), { status: 'indeterminate', code: 'CHECKOUT_PREPARATION_INCOMPLETE' });
  assert.equal(calls, 1);
  await assert.rejects(access(join(env, 'checkout.json')));
});

test('AC3/AC4: Sandbox.prepare composes the own checkout and seeds versioned Factory material once into /artifacts, never overwriting a version', async t => {
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createHash } = await import('node:crypto');
  const w = await world(t);
  const project = await upstream(w.dir, 'project');
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  // Fabricated already-prepared environment (the qemu-backed disk path is covered by sandbox-prepare under FACTORY_SANDBOX_TEST_ROOT).
  const assets = join(w.dir, 'assets');
  await mkdir(assets);
  for (const name of ['kernel', 'initramfs', 'rootfs']) await writeFile(join(assets, name), name);
  const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' }, assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs' },
    checksums: { kernel: sha('kernel'), initramfs: sha('initramfs'), rootfs: sha('rootfs') } });
  await writeFile(join(assets, 'manifest.json'), manifest);
  const guestAssets = { directory: assets, manifestSha256: sha(manifest) };
  const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 };
  const workId = 'work-09';
  const environment = `env-${sha(workId)}`;
  const directory = await w.environment(environment);
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ version: 1, workId, environment, configuration, guestAssets }), { mode: 0o600 });
  await writeFile(join(directory, 'ready.json'), JSON.stringify({ environment }), { mode: 0o600 });
  await writeFile(join(directory, 'root.qcow2'), '', { mode: 0o600 });
  const pack = join(w.dir, 'pack');
  await mkdir(join(pack, 'skills', 'implement'), { recursive: true });
  await writeFile(join(pack, 'skills', 'implement', 'SKILL.md'), 'implement v1');
  await writeFile(join(pack, 'manifest.json'), '{"id":"pack-v1"}');
  const sandbox = createSandbox({ root: w.root, guestAssets, remoteUrl: () => `file://${project.path}`, artifactSeeds: [{ name: 'factory/skill-pack/pack-v1', directory: pack }],
    repositoryFetch: { async fetch() { return { token: 't', expiresAt: new Date(Date.now() + 3600000).toISOString() }; } } });
  const checkout = request('acme/project', 3, 'factory/work-09');
  const first = await sandbox.prepare({ workId, configuration, checkout });
  assert.equal(first.status, 'success', JSON.stringify(first));
  if (first.status !== 'success' || !('checkout' in first)) return;
  assert.equal(first.checkout.baseCommit, project.head);
  assert.deepEqual(first.seeds, [{ name: 'factory/skill-pack/pack-v1', manifestSha256: sha('{"id":"pack-v1"}'), reused: false }]);
  assert.equal(await readFile(join(directory, 'artifacts', 'factory', 'skill-pack', 'pack-v1', 'skills', 'implement', 'SKILL.md'), 'utf8'), 'implement v1');
  const again = await sandbox.prepare({ workId, configuration, checkout });
  assert.ok(again.status === 'success' && 'checkout' in again && again.checkout.reused && again.seeds[0]!.reused);
  await writeFile(join(pack, 'manifest.json'), '{"id":"pack-v1","changed":true}');
  assert.deepEqual(await sandbox.prepare({ workId, configuration, checkout }), { status: 'failure', code: 'ARTIFACT_SEED_VERSION_CONFLICT' }, 'a version is never overwritten');
  assert.deepEqual(await createSandbox({ root: w.root, guestAssets }).prepare({ workId, configuration, checkout }), { status: 'failure', code: 'CHECKOUT_NOT_COMPOSED' });
});
