import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';
import { remainingMs } from '../runner/budget.js';
import { assetlessId, builtRelease, check, type Check } from './release-fixture.js';

// I-local (#62): the REAL release builder without guest assets (a Lambda-only installation), real tar extraction and the extracted release's
// private Node running setup/doctor/run. The Lambda account is never reached: its checks fail on this host, and only the absence of any
// guest asset requirement is asserted. No VM, network, GitHub, model or credential.
let work: string, root: string, output: string, report: Awaited<ReturnType<typeof buildRelease>>, factory: Awaited<ReturnType<typeof builtRelease>>['factory'];
// `setup` writes the installation's config.yaml, which every test below reads: it runs here so no test depends on another having run first.
let prepared: ReturnType<typeof factory>;
before(async () => {
  ({ work, root, output, report, factory } = await builtRelease(assetlessId));
  prepared = factory(root, ['setup', '--json'], { XDG_CONFIG_HOME: join(work, 'xdg') });
});
after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

const completed = (configuration: string) =>
  configuration
    .replace('operators: []', 'operators: [operador]')
    .replaceAll('{ provider: null, model: null }', '{ provider: openai, model: gpt-6-luna }')
    .replace('appId: null', 'appId: 123');
const lambda = 'sandbox:\n  schemaVersion: 1\n  adapter: lambda\n  awsProfile: factory\n  installation: acme\n';
const gondolinSandbox = 'sandbox:\n  schemaVersion: 1\n  profile: gondolin-qemu-alpine-dev-v1\n';

test('#62: a release built without guest assets distributes none and is verified without them', async () => {
  assert.equal(report.guestAssets, null);
  const manifest = JSON.parse(await readFile(join(output, 'release-manifest.json'), 'utf8'));
  assert.equal('guestAssets' in manifest, false);
  assert.equal(manifest.metadata.guestAssets, null);
  assert.deepEqual(await readdir(join(root, 'assets')), []);
  assert.equal(prepared.status, 0, prepared.stderr);
  const checks: Check[] = JSON.parse(prepared.stdout).diagnostics.checks;
  for (const name of ['release:integrity', 'release:location', 'release:selected', 'release:node', 'release:assets', 'permissions:assets'])
    assert.equal(check(checks, name)?.status, 'ok', name);
  assert.match(check(checks, 'release:assets')!.message, /no guest assets/);
  assert.equal(JSON.parse(prepared.stdout).diagnostics.release.guestAssets, null);
});

test('#62: with the Lambda adapter nothing requires guest assets; with Gondolin doctor blocks and run refuses before the storage opens', async () => {
  const configuration = completed(await readFile(join(root, 'config.yaml'), 'utf8'));
  assert.match(configuration, new RegExp(gondolinSandbox));
  await writeFile(join(root, 'credentials', 'github-app.pem'), 'synthetic-never-read', { mode: 0o600 });
  await writeFile(join(root, 'config.yaml'), configuration.replace(gondolinSandbox, lambda));
  const onLambda = factory(root, ['doctor', '--json']);
  const lambdaChecks: Check[] = JSON.parse(onLambda.stdout).checks;
  assert.equal(JSON.parse(onLambda.stdout).configuration.valid, true, onLambda.stdout);
  assert.deepEqual(
    lambdaChecks.filter(item => /guest-assets|RELEASE_GUEST_ASSETS_ABSENT/.test(item.id + item.message)).map(item => item.id),
    [],
  );
  assert.equal(check(lambdaChecks, 'release:assets')?.status, 'ok');

  await writeFile(join(root, 'config.yaml'), configuration);
  const onGondolin = factory(root, ['doctor', '--json']);
  assert.equal(onGondolin.status, 3, onGondolin.stdout);
  const required = check(JSON.parse(onGondolin.stdout).checks, 'release:assets-required');
  assert.equal(required?.status, 'blocked');
  assert.match(required!.message, /^RELEASE_GUEST_ASSETS_ABSENT/);
  const run = factory(root, ['run']);
  assert.equal(run.status, 2, run.stderr);
  const refused = JSON.parse(run.stderr.trim().split('\n').at(-1)!);
  assert.deepEqual([refused.code, refused.reason], ['CONFIGURATION_UNSUPPORTED', 'RELEASE_GUEST_ASSETS_ABSENT']);
  await assert.rejects(stat(join(root, 'data', 'control.sqlite')), { code: 'ENOENT' }, 'storage was not opened');
});

test('#62: the build takes the guest asset pin whole or not at all', async () => {
  for (const partial of [
    ['--guest-assets', join(work, 'assets')],
    ['--guest-manifest-sha256', 'a'.repeat(64)],
  ]) {
    const built = spawnSync(
      process.execPath,
      ['dist/src/entrypoints/release-build.js', '--release', 'r62-partial', '--output', join(work, 'partial'), ...partial],
      {
        encoding: 'utf8',
        timeout: remainingMs(),
      },
    );
    assert.notEqual(built.status, 0);
    assert.match(built.stderr, /INVALID_ARGUMENTS/);
    await assert.rejects(stat(join(work, 'partial')), { code: 'ENOENT' });
  }
});
