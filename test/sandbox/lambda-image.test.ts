import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, installationTagKey, workTagKey } from '../../src/sandbox/index.js';
import { buildFailureCause, readWorkImage } from '../../src/sandbox/lambda/image.js';
import { lambdaAccountFake } from './lambda-service-fake.js';

// v2 ticket 03 (V2-27, V2-02 Preparar, V2-33): Prepare under the Lambda adapter, over the in-memory account. No AWS call, no MicroVM.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const pinned = (change: { sha256?: string; repositoryId?: number; apk?: { name: string; version: string }[] } = {}) => ({
  path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: change.sha256 ?? sha('d'), repository: 'acme/shop', repositoryId: change.repositoryId ?? 42,
  declaration: { schemaVersion: 1 as const, apk: change.apk ?? [{ name: 'maven', version: '3.9.11-r0' }], images: [{ reference: `docker.io/testcontainers/ryuk@sha256:${sha('a')}` }] } });
const works = { first: '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01', second: '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a02', third: '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a03' };
/** The real tail of a failed Alpine build (Alpine proof, evidence `neg-build-log.json`). */
const failedBuildLog = [
  "#7 [3/5] RUN apk add --no-cache 'openjdk21-jdk=21.0.13.1_p2-r0' 'maven=3.9.11-r99'\n",
  '#7 0.304 ERROR: unable to select packages:\n', '#7 0.305   maven-3.9.11-r0:\n', '#7 0.305     breaks: world[maven=3.9.11-r99]\n',
  '#7 ERROR: process "/bin/sh -c apk add --no-cache \'openjdk21-jdk=21.0.13.1_p2-r0\' \'maven=3.9.11-r99\'" did not complete successfully: exit code: 1\n',
  '------\n', " > [3/5] RUN apk add --no-cache 'openjdk21-jdk=21.0.13.1_p2-r0' 'maven=3.9.11-r99':\n",
  '0.304 ERROR: unable to select packages:\n', '0.305   maven-3.9.11-r0:\n', '0.305     breaks: world[maven=3.9.11-r99]\n', '------\n',
  'Dockerfile:3\n', '--------------------\n', '   3 | >>> RUN apk add --no-cache \'maven=3.9.11-r99\'\n', '--------------------\n',
  'error: failed to solve: process "/bin/sh -c apk add --no-cache \'maven=3.9.11-r99\'" did not complete successfully: exit code: 1\n'];

async function installation(t: TestContext, wait: { maxSeconds?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  /** The fake clock: waiting for a build only moves the account's time (never a real sleep). */
  const sleep = async (milliseconds: number) => { fake.account.clock.now += milliseconds; };
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaImageWait: { intervalSeconds: 10, maxSeconds: wait.maxSeconds ?? 900, sleep } });
  const prepare = (workId: string, environment: ReturnType<typeof pinned> | null = pinned(), extra: { retryEnvironmentBase?: boolean; configuration?: unknown } = {}) =>
    sandbox.prepare({ workId, configuration: extra.configuration ?? configuration, ...(environment ? { environment } : {}), ...(extra.retryEnvironmentBase ? { retryEnvironmentBase: true } : {}) });
  const operations = () => fake.mutations.map(call => call.operation);
  return { root, fake, sandbox, prepare, operations };
}

test('Prepare builds the image of the environment key once; a second Work with the same key reuses it without a new build', async t => {
  const { fake, prepare, operations } = await installation(t);
  const first = await prepare(works.first);
  assert.equal(first.status, 'success');
  assert.ok(first.status === 'success' && first.base);
  assert.equal(first.base.reused, false);
  assert.equal(first.base.declarationSha256, sha('d'));
  assert.deepEqual(first.base.packages, { maven: '3.9.11-r0' });
  assert.deepEqual(first.base.images, [{ reference: `docker.io/testcontainers/ryuk@sha256:${sha('a')}`, digest: `sha256:${sha('a')}` }]);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
  assert.deepEqual(fake.account.images.map(image => [image.name.startsWith('factory-acme-'), image.state]), [[true, 'CREATED']]);

  const second = await prepare(works.second);
  assert.ok(second.status === 'success' && second.base);
  assert.equal(second.base.reused, true);
  assert.equal(second.base.base, first.base.base);
  assert.notEqual(second.environment, first.environment);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage'], 'no second build');

  // Repeating Prepare for the same Work is recognised as well.
  const again = await prepare(works.first);
  assert.ok(again.status === 'success' && again.base?.reused);
  assert.equal(again.environment, first.environment);
  assert.equal(fake.account.images.length, 1);
});

test('the image request is the adapter profile and the release pin; nothing of it comes from the repository except validated packages', async t => {
  const { fake, prepare } = await installation(t);
  await prepare(works.first);
  const request = fake.mutations.find(call => call.operation === 'createImage')!.input as Record<string, unknown>;
  const name = fake.account.images[0]!.name;
  assert.deepEqual(request, { name, description: request.description, baseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1', baseImageVersion: '3',
    buildRoleArn: 'arn:aws:iam::123456789012:role/factory-acme-build', artifactUri: `s3://factory-acme-build-123456789012-us-east-1/${name}.zip`,
    architecture: 'arm64', minimumMemoryMiB: 1024, additionalOsCapabilities: ['ALL'],
    hooks: { port: 9000, runTimeoutSeconds: 60, terminateTimeoutSeconds: 60, readyTimeoutSeconds: 120 },
    tags: { [installationTagKey]: 'acme', [workTagKey]: works.first } });
  const artifact = Buffer.from(fake.account.objects['factory-acme-build-123456789012-us-east-1']![`${name}.zip`]!.body).toString('latin1');
  assert.match(artifact, /'maven=3\.9\.11-r0'/);
  assert.match(artifact, /adduser -D -s \/bin\/bash builder/);
});

test('the image and its build artifact carry the installation tag and the Work tag', async t => {
  const { fake, prepare } = await installation(t);
  await prepare(works.first);
  const tags = { 'software-factory-installation': 'acme', 'software-factory-work': works.first };
  assert.deepEqual(fake.account.images[0]!.tags, tags);
  assert.deepEqual(Object.values(fake.account.objects['factory-acme-build-123456789012-us-east-1']!).map(object => object.tags), [tags]);
});

test('a changed declaration, repository or release pin is a new key and a new image', async t => {
  const { fake, prepare } = await installation(t);
  const base = await prepare(works.first);
  const changed = await prepare(works.second, pinned({ sha256: sha('e'), apk: [{ name: 'maven', version: '3.9.12-r0' }] }));
  const other = await prepare(works.third, pinned({ repositoryId: 43 }));
  assert.ok(base.status === 'success' && changed.status === 'success' && other.status === 'success');
  assert.equal(new Set([base.base!.base, changed.base!.base, other.base!.base]).size, 3);
  assert.equal(fake.account.images.length, 3);
  assert.equal(changed.base!.reused, false);
});

test('a Work keeps the image it started with when the declaration it is prepared with or the release pin changes later', async t => {
  const { root, fake, prepare, operations } = await installation(t);
  const first = await prepare(works.first);
  assert.ok(first.status === 'success');
  const recorded = await readWorkImage(root, first.environment);
  assert.equal(recorded?.imageArn, fake.account.images[0]!.imageArn);
  // The same Work prepared again with another declaration hash (as after an upgrade that changed the key): still its own image, no build.
  const later = await prepare(works.first, pinned({ sha256: sha('e') }));
  assert.ok(later.status === 'success');
  assert.equal(later.base!.base, first.base!.base);
  assert.equal(later.base!.declarationSha256, sha('d'));
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
  assert.deepEqual(await readWorkImage(root, first.environment), recorded);
});

test('a Work whose image no longer exists is refused: no other image takes its place', async t => {
  const { fake, prepare, operations } = await installation(t);
  await prepare(works.first);
  fake.account.images.length = 0;
  const result = await prepare(works.first);
  assert.equal(result.status, 'failure');
  assert.ok(result.status === 'failure' && result.code === 'ENVIRONMENT_BASE_PREPARATION_FAILED');
  assert.match(result.detail ?? '', /no longer exists/);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
});

test('a failed build is a visible impediment whose cause is read from the build log; nothing else is built or tried', async t => {
  const { fake, prepare, operations } = await installation(t);
  fake.account.buildFailure = failedBuildLog;
  const result = await prepare(works.first, pinned({ apk: [{ name: 'maven', version: '3.9.11-r99' }] }));
  assert.deepEqual({ status: result.status, code: 'code' in result ? result.code : null }, { status: 'failure', code: 'ENVIRONMENT_BASE_PREPARATION_FAILED' });
  assert.ok(result.status === 'failure');
  assert.match(result.detail!, /unable to select packages/);
  assert.match(result.detail!, /maven=3\.9\.11-r99/);
  assert.ok(result.detail!.length <= 400);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
  assert.deepEqual(fake.account.images.map(image => image.state), ['CREATE_FAILED']);

  // Repeating Prepare (same Work or another with the same key) reports the same failure: no implicit retry, no other version.
  fake.account.buildFailure = null;
  const repeated = await prepare(works.second, pinned({ apk: [{ name: 'maven', version: '3.9.11-r99' }] }));
  assert.ok(repeated.status === 'failure' && repeated.code === 'ENVIRONMENT_BASE_PREPARATION_FAILED');
  assert.match(repeated.detail!, /maven=3\.9\.11-r99/);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
});

test('when the build log cannot be read the failure says so, with the generic reason of the service', async t => {
  const { fake, prepare } = await installation(t);
  fake.account.buildFailure = failedBuildLog;
  fake.account.denied.push('logs:FilterLogEvents');
  const result = await prepare(works.first);
  assert.ok(result.status === 'failure' && result.code === 'ENVIRONMENT_BASE_PREPARATION_FAILED');
  assert.match(result.detail!, /The container image build failed\./);
  assert.match(result.detail!, /build log .*not .*read.*logs:FilterLogEvents/);
});

test("only the Operator's explicit retry rebuilds a failed image, replacing it under the same key", async t => {
  const { fake, prepare, operations } = await installation(t);
  fake.account.buildFailure = failedBuildLog;
  await prepare(works.first);
  fake.account.buildFailure = null;
  const retried = await prepare(works.first, pinned(), { retryEnvironmentBase: true });
  assert.ok(retried.status === 'success' && retried.base && !retried.base.reused);
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage', 'deleteImage', 'putBuildArtifact', 'createImage']);
  assert.deepEqual(fake.account.images.map(image => image.state), ['CREATED']);
  // A retry never rebuilds an image that is fine.
  await prepare(works.second, pinned(), { retryEnvironmentBase: true });
  assert.equal(operations().length, 5);
});

test('a build that is still running when the wait ends is incomplete, and the next Prepare recognises it instead of building again', async t => {
  const { fake, prepare, operations } = await installation(t, { maxSeconds: 60 });
  fake.account.buildSeconds = 100;
  const waiting = await prepare(works.first);
  assert.ok(waiting.status === 'failure' && waiting.code === 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE');
  assert.match(waiting.detail!, /still being built/);
  assert.deepEqual(fake.account.images.map(image => image.state), ['CREATING']);
  const next = await prepare(works.second);
  assert.ok(next.status === 'success' && next.base?.reused, 'the build another Prepare started is reused');
  assert.deepEqual(operations(), ['putBuildArtifact', 'createImage']);
});

test('Prepare refuses, before touching the account, a Work without a pinned declaration and a declaration outside the closed schema', async t => {
  const { fake, prepare } = await installation(t);
  assert.deepEqual(await prepare(works.first, null), { status: 'failure', code: 'ENVIRONMENT_NOT_PINNED', detail: 'The Lambda adapter builds the MicroVM image from the pinned .factory/environment.yaml; this Work has none.' });
  const hostile = pinned();
  hostile.declaration.apk = [{ name: 'curl && rm -rf /', version: '8.23.0-r0' }];
  const refused = await prepare(works.first, hostile);
  assert.ok(refused.status === 'failure' && refused.code === 'ENVIRONMENT_DECLARATION_INVALID');
  assert.equal(fake.calls.length, 0);
});

test('an account that cannot be reached or refuses a permission leaves Prepare incomplete with the cause, and nothing recorded for the Work', async t => {
  const { root, fake, prepare } = await installation(t);
  fake.account.denied.push('lambda:CreateMicrovmImage');
  const denied = await prepare(works.first);
  assert.ok(denied.status === 'failure' && denied.code === 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE');
  assert.match(denied.detail!, /lambda:CreateMicrovmImage/);
  fake.account.profiles.factory = { expired: true };
  const expired = await prepare(works.first);
  assert.ok(expired.status === 'failure' && expired.code === 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE');
  assert.match(expired.detail!, /identity/);
  assert.equal(fake.account.images.length, 0);
  await assert.rejects(readdir(join(root, 'lambda')), { code: 'ENOENT' });
});

test('the cause of a build failure is the failing step of the BuildKit log, bounded to one line', () => {
  assert.equal(buildFailureCause(failedBuildLog),
    "[3/5] RUN apk add --no-cache 'openjdk21-jdk=21.0.13.1_p2-r0' 'maven=3.9.11-r99': ERROR: unable to select packages: maven-3.9.11-r0: breaks: world[maven=3.9.11-r99]");
  assert.equal(buildFailureCause(['#1 [internal] load build definition\n', 'error: failed to solve: failed to read dockerfile\n']), 'error: failed to solve: failed to read dockerfile');
  assert.equal(buildFailureCause(['#1 DONE 0.0s\n', '\n']), null);
  assert.equal(buildFailureCause([]), null);
  assert.ok(buildFailureCause([' > [2/5] RUN apk add:\n', `0.1 ERROR: ${'x'.repeat(2000)}\n`, '------\n'])!.length <= 400);
});
