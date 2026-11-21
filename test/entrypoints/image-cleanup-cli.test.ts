import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/entrypoints/cli.js';
import { cleanupImages, imageCleanupExitCode, imageCleanupText } from '../../src/entrypoints/image-cleanup.js';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';
import { accountClock, lambdaAccountFake } from '../sandbox/lambda-service-fake.js';

// v2 ticket 15: `factory cleanup-images`, composed in-process over the in-memory account (the CLI itself would run `aws`).
const configuration = (sandbox: string) => `schemaVersion: 1
operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: ${sandbox}
concurrency: 1
repositories:
  - repository: owner/project
    base: main
    installationId: 456
    workflows: false
`;
const lambda = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: 'd'.repeat(64), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [{ name: 'maven', version: '3.9.11-r0' }], images: [] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';

async function installed(t: { after(fn: () => unknown): void }, sandbox: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-image-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.yaml'), configuration(sandbox), { mode: 0o600 });
  return root;
}
async function captured(run: () => Promise<number>) {
  const lines: string[] = [];
  const log = console.log, error = console.error;
  console.log = (text: string) => { lines.push(text); };
  console.error = (text: string) => { lines.push(text); };
  try { return { code: await run(), output: lines.join('\n') }; } finally { console.log = log; console.error = error; }
}

test('cleanup-images shows the plan, refuses an image a Work still holds, and deletes it only with the confirmation once the Work\'s environment was removed', async t => {
  const root = await installed(t, '{adapter: lambda, schemaVersion: 1, awsProfile: factory, installation: acme}');
  const fake = lambdaAccountFake();
  const clock = accountClock(fake);
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaBootClock: clock, lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepared = await sandbox.prepare({ workId, configuration: lambda, environment: pinned });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const name = fake.account.images[0]!.name;
  const run = (options: { image?: string; confirm: boolean }) => cleanupImages(root, { ...options, lambdaService: fake.service });

  const plan = await run({ confirm: false });
  assert.deepEqual([plan.status, imageCleanupExitCode(plan), plan.images.map(image => [image.imageName, image.decision, image.works])], ['planned', 0, [[name, 'in-use', [workId]]]]);
  assert.match(imageCleanupText(plan), new RegExp(`^Plan \\(nothing was changed.*\\n${name}: in-use \\(CREATED; Works ${workId}\\)$`));
  const refused = await run({ image: name, confirm: true });
  assert.deepEqual([refused.status, refused.code, imageCleanupExitCode(refused)], ['refused', 'IMAGE_IN_USE', 1]);
  assert.equal(fake.account.images.length, 1);

  assert.equal((await sandbox.remove({ environment: (prepared as { environment: EnvironmentRef }).environment,
    cleanup: { workId, workDisposition: 'delivered', confirmed: true, evidencePreserved: true } })).status, 'success');
  assert.equal(fake.account.images.length, 1, 'removing the Work\'s environment does not delete the image');
  const cleaned = await run({ image: name, confirm: true });
  assert.deepEqual([cleaned.status, imageCleanupExitCode(cleaned), cleaned.images.map(image => image.outcome)], ['cleaned', 0, ['removed']]);
  assert.deepEqual(fake.account.images, []);
});

test('cleanup-images is refused where the installation keeps no MicroVM images, and the CLI validates its arguments before anything runs', async t => {
  const root = await installed(t, '{schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}');
  const report = await cleanupImages(root, { confirm: true, lambdaService: () => { throw new Error('no account is reached'); } });
  assert.deepEqual([report.status, report.code, imageCleanupExitCode(report)], ['refused', 'IMAGE_CLEANUP_NOT_APPLICABLE', 2]);
  const viaCli = await captured(() => main(['cleanup-images', '--yes', '--json', '--root', root]));
  assert.deepEqual([viaCli.code, (JSON.parse(viaCli.output) as { code: string }).code], [2, 'IMAGE_CLEANUP_NOT_APPLICABLE']);
  for (const args of [['cleanup-images', 'not-an-image-name'], ['cleanup-images', '--yes', '--yes'], ['cleanup-images', `factory-acme-${'a'.repeat(32)}`, 'extra']]) {
    const invalid = await captured(() => main([...args, '--root', root]));
    assert.deepEqual([invalid.code, (JSON.parse(invalid.output) as { code: string }).code], [2, 'INVALID_ARGUMENTS'], args.join(' '));
  }
});
