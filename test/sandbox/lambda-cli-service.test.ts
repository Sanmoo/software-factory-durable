import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLambdaCliService, type AwsCliRunner } from '../../src/sandbox/index.js';
import { awsCliEnvironment, buildLogCommand, buildLogLines, createAwsCliRunner, imageBuildsCommand, memoryQuota, runMicrovmCommand } from '../../src/sandbox/lambda/cli-service.js';

// v2 ticket 02: the CLI-backed LambdaService against a scripted runner. The real `aws` is never executed by any test.
function scripted(answers: Record<string, { exitCode?: number; stdout?: unknown; stderr?: string } | 'unavailable'>) {
  const invocations: string[][] = [];
  const run: AwsCliRunner = async argv => {
    invocations.push([...argv]);
    const answer = answers[`${argv[7]} ${argv[8]}`];
    if (!answer) throw new Error(`unscripted aws ${argv.join(' ')}`);
    if (answer === 'unavailable') return { status: 'unavailable' };
    return { status: 'exited', exitCode: answer.exitCode ?? 0, stdout: answer.stdout === undefined ? '' : JSON.stringify(answer.stdout), stderr: answer.stderr ?? '' };
  };
  return { invocations, service: createLambdaCliService({ awsProfile: 'factory', region: 'us-east-1' }, run) };
}
const prefix = ['--profile', 'factory', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'];

test('every call names the configured profile and region and reads plain JSON', async () => {
  const { service, invocations } = scripted({
    'sts get-caller-identity': { stdout: { UserId: 'AROAEXAMPLE:s', Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/factory-acme-operation/s' } },
    'iam get-role': { stdout: { Role: { RoleName: 'factory-acme-build', Arn: 'arn:aws:iam::123456789012:role/factory-acme-build' } } },
    's3api get-bucket-location': { stdout: { LocationConstraint: null } },
    'lambda-microvms list-microvm-images': { stdout: { items: [{ name: 'factory-acme-a', state: 'CREATED', imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:factory-acme-a' }] } },
  });
  assert.deepEqual(await service.callerIdentity(), { ok: true, value: { account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/factory-acme-operation/s' } });
  assert.deepEqual(await service.role('factory-acme-build'), { ok: true, value: { arn: 'arn:aws:iam::123456789012:role/factory-acme-build' } });
  assert.deepEqual(await service.bucketRegion('bucket-a'), { ok: true, value: { region: 'us-east-1' } });
  assert.deepEqual(await service.listImages(), { ok: true, value: [{ name: 'factory-acme-a', state: 'CREATED', imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:factory-acme-a' }] });
  assert.deepEqual(invocations, [[...prefix, 'sts', 'get-caller-identity'], [...prefix, 'iam', 'get-role', '--role-name', 'factory-acme-build'],
    [...prefix, 's3api', 'get-bucket-location', '--bucket', 'bucket-a'], [...prefix, 'lambda-microvms', 'list-microvm-images']]);
});

test('a policy simulation names the principal, actions, resources and request context; an action is allowed only when every resource allows it', async () => {
  const { service, invocations } = scripted({ 'iam simulate-principal-policy': { stdout: { EvaluationResults: [
    { EvalActionName: 'lambda:TagResource', EvalDecision: 'allowed' },
    { EvalActionName: 's3:PutObject', EvalResourceName: 'a', EvalDecision: 'allowed' }, { EvalActionName: 's3:PutObject', EvalResourceName: 'b', EvalDecision: 'implicitDeny' },
    { EvalActionName: 's3:GetObject', EvalDecision: 'explicitDeny' }] } } });
  const result = await service.simulatePermissions({ principalArn: 'arn:aws:iam::1:role/r', actions: ['lambda:TagResource', 's3:PutObject', 's3:GetObject', 's3:DeleteObject'],
    resources: ['a', 'b'], context: [{ key: 'aws:RequestTag/software-factory-installation', value: 'acme' }] });
  assert.deepEqual(result, { ok: true, value: [{ action: 'lambda:TagResource', allowed: true }, { action: 's3:PutObject', allowed: false },
    { action: 's3:GetObject', allowed: false }, { action: 's3:DeleteObject', allowed: false }] });
  assert.deepEqual(invocations[0], [...prefix, 'iam', 'simulate-principal-policy', '--policy-source-arn', 'arn:aws:iam::1:role/r',
    '--action-names', 'lambda:TagResource', 's3:PutObject', 's3:GetObject', 's3:DeleteObject', '--resource-arns', 'a', 'b',
    '--context-entries', 'ContextKeyName=aws:RequestTag/software-factory-installation,ContextKeyValues=acme,ContextKeyType=string']);
});

test('CLI failures become the port\'s causes: missing CLI, missing profile, no identity, denied action, missing resource, region without endpoint', async () => {
  const failing = async (stderr: string) => (await scripted({ 'sts get-caller-identity': { exitCode: 254, stderr } }).service.callerIdentity());
  const kind = async (stderr: string) => { const result = await failing(stderr); return result.ok ? 'ok' : result.failure.kind; };
  assert.deepEqual(await scripted({ 'sts get-caller-identity': 'unavailable' }).service.callerIdentity(), { ok: false, failure: { kind: 'cli-unavailable' } });
  assert.equal(await kind('\nThe config profile (factory) could not be found\n'), 'profile-not-found');
  assert.equal(await kind('Unable to locate credentials. You can configure credentials by running "aws configure".'), 'no-identity');
  assert.equal(await kind('An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired'), 'no-identity');
  assert.equal(await kind('Error loading SSO Token: Token for factory does not exist'), 'no-identity');
  assert.deepEqual(await failing('An error occurred (AccessDenied) when calling the GetRole operation: User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: iam:GetRole on resource: role x'),
    { ok: false, failure: { kind: 'access-denied', action: 'iam:GetRole',
      detail: 'An error occurred (AccessDenied) when calling the GetRole operation: User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: iam:GetRole on resource: role x' } });
  assert.equal(await kind('An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name x cannot be found.'), 'not-found');
  assert.equal(await kind('An error occurred (NoSuchBucket) when calling the GetBucketLocation operation: The specified bucket does not exist'), 'not-found');
  assert.equal(await kind('Could not connect to the endpoint URL: "https://lambda-microvms.eu-west-9.amazonaws.com/"'), 'region-unavailable');
  assert.equal(await kind("aws: error: argument command: Invalid choice, valid choices are:\n\naccessanalyzer"), 'cli-unavailable');
  assert.equal(await kind('something new'), 'unknown');
  // A success whose answer is not the expected JSON is unknown, never a guessed value.
  assert.equal((await scripted({ 'sts get-caller-identity': { stdout: { Account: 7 } } }).service.callerIdentity()).ok, false);
});

test('the quota read (unproven shape) finds one MicroVM memory quota by name, read as GiB; anything ambiguous is unreadable', async () => {
  const quotas = (names: [string, unknown][]) => ({ Quotas: names.map(([QuotaName, Value]) => ({ QuotaName, QuotaCode: 'L-X', Value })) });
  assert.deepEqual(memoryQuota(quotas([['Concurrent executions', 1000], ['MicroVM allocated memory (ARM)', 8], ['MicroVM allocated memory (x86)', 16]]), 'arm64'), { mebibytes: 8192 });
  assert.deepEqual(memoryQuota(quotas([['MicroVM allocated memory (ARM)', 8], ['MicroVM allocated memory (x86)', 16]]), 'x86_64'), { mebibytes: 16384 });
  assert.deepEqual(memoryQuota(quotas([['MicroVMs allocated memory', 8]]), 'arm64'), { mebibytes: 8192 });
  assert.equal(memoryQuota(quotas([['Concurrent executions', 1000]]), 'arm64'), undefined);
  assert.equal(memoryQuota(quotas([['MicroVM memory A', 8], ['MicroVM memory B', 16]]), 'arm64'), undefined);
  assert.equal(memoryQuota(quotas([['MicroVM allocated memory (ARM)', '8']]), 'arm64'), undefined);
  const { service, invocations } = scripted({ 'service-quotas list-service-quotas': { stdout: quotas([['MicroVM allocated memory (ARM)', 8]]) } });
  assert.deepEqual(await service.allocatedMemoryQuota('arm64'), { ok: true, value: { mebibytes: 8192 } });
  assert.deepEqual(invocations[0], [...prefix, 'service-quotas', 'list-service-quotas', '--service-code', 'lambda']);
});

test('the aws process inherits no credential, profile or region from the environment, and the runner adds none', async t => {
  assert.deepEqual(awsCliEnvironment({ HOME: '/home/x', PATH: '/bin', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c', AWS_SECURITY_TOKEN: 'd',
    AWS_PROFILE: 'other', AWS_DEFAULT_PROFILE: 'other', AWS_REGION: 'r', AWS_DEFAULT_REGION: 'r', AWS_CONFIG_FILE: '/cfg' }),
  { HOME: '/home/x', PATH: '/bin', AWS_CONFIG_FILE: '/cfg', AWS_PAGER: '' });
  // The runner against a stand-in executable (never the real CLI): argv is passed without a shell, exit code and streams come back.
  const directory = await mkdtemp(join(tmpdir(), 'factory-aws-standin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const standin = join(directory, 'aws-standin');
  await writeFile(standin, '#!/bin/sh\nprintf \'%s|\' "$@"\nprintf \'%s\' "${AWS_ACCESS_KEY_ID:-none}" >&2\nexit 3\n');
  await chmod(standin, 0o700);
  assert.deepEqual(await createAwsCliRunner({ executable: standin, environment: { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: 'leak' } })(['a b', '$(c)']),
    { status: 'exited', exitCode: 3, stdout: 'a b|$(c)|', stderr: 'none' });
  assert.deepEqual(await createAwsCliRunner({ executable: join(directory, 'absent') })(['x']), { status: 'unavailable' });
});

// v2 ticket 03: the image operations. Shapes proven by the Alpine proof unless a test says otherwise.
const imageArn = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:factory-acme-0123';
const tags = { 'software-factory-installation': 'acme', 'software-factory-work': 'w-1' };

test('an image build is requested with the profile, the hooks and the tags; the artifact is uploaded with its tags from a private temporary file', async () => {
  const uploads: { body: string; argv: string[] }[] = [];
  const run: AwsCliRunner = async argv => {
    if (argv[8] === 'put-object') {
      uploads.push({ body: await readFile(argv[argv.indexOf('--body') + 1]!, 'utf8'), argv: [...argv] });
      return { status: 'exited', exitCode: 0, stdout: JSON.stringify({ ETag: '"x"' }), stderr: '' };
    }
    uploads.push({ body: '', argv: [...argv] });
    return { status: 'exited', exitCode: 0, stdout: JSON.stringify({ imageArn, name: 'factory-acme-0123', state: 'CREATING', imageVersion: '1.0' }), stderr: '' };
  };
  const service = createLambdaCliService({ awsProfile: 'factory', region: 'us-east-1' }, run);
  assert.deepEqual(await service.putBuildArtifact({ bucket: 'bucket-a', key: 'factory-acme-0123.zip', body: Buffer.from('zip-bytes'), tags }),
    { ok: true, value: { uri: 's3://bucket-a/factory-acme-0123.zip' } });
  const file = uploads[0]!.argv[uploads[0]!.argv.indexOf('--body') + 1]!;
  assert.equal(uploads[0]!.body, 'zip-bytes');
  assert.deepEqual(uploads[0]!.argv, [...prefix, 's3api', 'put-object', '--bucket', 'bucket-a', '--key', 'factory-acme-0123.zip', '--body', file,
    '--tagging', 'software-factory-installation=acme&software-factory-work=w-1']);
  await assert.rejects(readFile(file), { code: 'ENOENT' }, 'the temporary copy is removed');

  assert.deepEqual(await service.createImage({ name: 'factory-acme-0123', description: 'd', baseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1', baseImageVersion: '3',
    buildRoleArn: 'arn:aws:iam::123456789012:role/factory-acme-build', artifactUri: 's3://bucket-a/factory-acme-0123.zip', architecture: 'arm64', minimumMemoryMiB: 1024,
    additionalOsCapabilities: ['ALL'], hooks: { port: 9000, runTimeoutSeconds: 60, terminateTimeoutSeconds: 60, readyTimeoutSeconds: 120 }, tags }),
  { ok: true, value: { imageArn, state: 'CREATING' } });
  assert.deepEqual(uploads[1]!.argv, [...prefix, 'lambda-microvms', 'create-microvm-image', '--name', 'factory-acme-0123', '--description', 'd',
    '--base-image-arn', 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1', '--base-image-version', '3', '--build-role-arn', 'arn:aws:iam::123456789012:role/factory-acme-build',
    '--code-artifact', 'uri=s3://bucket-a/factory-acme-0123.zip', '--cpu-configurations', 'architecture=ARM_64', '--resources', 'minimumMemoryInMiB=1024',
    '--additional-os-capabilities', 'ALL',
    '--hooks', '{"port":9000,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"terminate":"ENABLED","terminateTimeoutInSeconds":60},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":120}}',
    '--tags', '{"software-factory-installation":"acme","software-factory-work":"w-1"}']);
});

test('an image is read by ARN with its state, tags and versions; deleting prints nothing; an existing name is a conflict', async () => {
  const { service, invocations } = scripted({
    // The answers of the Alpine proof (evidence `image-pos.json`), with the account redacted.
    'lambda-microvms get-microvm-image': { stdout: { imageArn, name: 'factory-acme-0123', state: 'CREATED', latestActiveImageVersion: '1.0', createdAt: '2026-11-21T06:44:22.648000-03:00', tags } },
    'lambda-microvms delete-microvm-image-version': {}, 'lambda-microvms delete-microvm-image': {},
    'lambda-microvms create-microvm-image': { exitCode: 254, stderr: 'An error occurred (ConflictException) when calling the CreateMicrovmImage operation: exists' },
  });
  assert.deepEqual(await service.image(imageArn), { ok: true, value: { name: 'factory-acme-0123', imageArn, state: 'CREATED', tags, latestActiveImageVersion: '1.0' } });
  assert.deepEqual(await service.deleteImageVersion({ imageArn, version: '1.0' }), { ok: true, value: null });
  assert.deepEqual(await service.deleteImage(imageArn), { ok: true, value: null });
  assert.deepEqual(invocations, [[...prefix, 'lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn],
    [...prefix, 'lambda-microvms', 'delete-microvm-image-version', '--image-identifier', imageArn, '--image-version', '1.0'],
    [...prefix, 'lambda-microvms', 'delete-microvm-image', '--image-identifier', imageArn]]);
  const conflict = await service.createImage({ name: 'n', description: 'd', baseImageArn: 'b', baseImageVersion: '3', buildRoleArn: 'r', artifactUri: 's3://b/k', architecture: 'x86_64',
    minimumMemoryMiB: 1024, additionalOsCapabilities: ['ALL'], hooks: { port: 9000, runTimeoutSeconds: 60, terminateTimeoutSeconds: 60, readyTimeoutSeconds: 120 }, tags });
  assert.equal(!conflict.ok && conflict.failure.kind, 'conflict');
  assert.ok(invocations.at(-1)!.includes('architecture=X86_64'));
});

test('the build records and the build log (unproven command shapes, isolated in one place) are read as observed answers', async () => {
  assert.deepEqual(imageBuildsCommand(imageArn), ['lambda-microvms', 'list-microvm-image-builds', '--image-identifier', imageArn]);
  assert.deepEqual(buildLogCommand('/aws/lambda-microvms/factory-acme-0123'), ['logs', 'filter-log-events', '--log-group-name', '/aws/lambda-microvms/factory-acme-0123']);
  assert.deepEqual(buildLogLines({ events: [{ message: '#7 0.304 ERROR: unable to select packages:\n', timestamp: 1 }, { timestamp: 2 }, { message: 'Dockerfile:3\n' }] }),
    ['#7 0.304 ERROR: unable to select packages:\n', 'Dockerfile:3\n']);
  assert.equal(buildLogLines({ nextToken: 'x' }), undefined);
  const { service, invocations } = scripted({
    // Evidence `image-neg-builds.json`: one request, two build records.
    'lambda-microvms list-microvm-image-builds': { stdout: { items: [
      { imageArn, imageVersion: '1.0', buildId: '67b57745', buildState: 'FAILED', architecture: 'ARM_64', chipset: 'GRAVITON', chipsetGeneration: '4', stateReason: 'The container image build failed.' },
      { imageArn, imageVersion: '1.0', buildId: '90ab745b', buildState: 'FAILED', architecture: 'ARM_64', chipset: 'GRAVITON', chipsetGeneration: '3', stateReason: 'The container image build failed.' }] } },
    'logs filter-log-events': { stdout: { events: [{ message: 'error: failed to solve\n' }] } },
  });
  assert.deepEqual(await service.imageBuilds(imageArn), { ok: true, value: [
    { buildId: '67b57745', imageVersion: '1.0', state: 'FAILED', stateReason: 'The container image build failed.' },
    { buildId: '90ab745b', imageVersion: '1.0', state: 'FAILED', stateReason: 'The container image build failed.' }] });
  assert.deepEqual(await service.buildLog('/aws/lambda-microvms/factory-acme-0123'), { ok: true, value: ['error: failed to solve\n'] });
  assert.deepEqual(invocations.map(argv => argv.slice(7)), [imageBuildsCommand(imageArn), buildLogCommand('/aws/lambda-microvms/factory-acme-0123')]);
});

// v2 ticket 04: the MicroVM operations.
test('RunMicrovm names the image, both managed connectors, the maximum duration, the hook payload and the tags, and never a role or an idle policy', async () => {
  const input = { imageArn, maximumDurationSeconds: 3600, runHookPayload: '{"builder":"ssh-ed25519 AAAA"}', tags: { 'software-factory-installation': 'acme', 'software-factory-work': 'w1' } };
  // Proven shape (`bin/up`), plus `--tags` (NOT proven, isolated in `runMicrovmCommand`).
  assert.deepEqual(runMicrovmCommand(input, 'us-east-1'), ['lambda-microvms', 'run-microvm', '--image-identifier', imageArn,
    '--ingress-network-connectors', 'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS',
    '--egress-network-connectors', 'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS',
    '--maximum-duration-in-seconds', '3600', '--run-hook-payload', '{"builder":"ssh-ed25519 AAAA"}',
    '--tags', '{"software-factory-installation":"acme","software-factory-work":"w1"}']);
  assert.doesNotMatch(runMicrovmCommand(input, 'us-east-1').join(' '), /execution-role|idle-policy|SHELL_INGRESS|vpc/i);
  const { service, invocations } = scripted({ 'lambda-microvms run-microvm': { stdout: { microvmId: 'microvm-1', endpoint: 'microvm-1.lambda-microvm.us-east-1.on.aws', state: 'PENDING' } } });
  assert.deepEqual(await service.runMicrovm(input), { ok: true, value: { microvmId: 'microvm-1', endpoint: 'microvm-1.lambda-microvm.us-east-1.on.aws' } });
  assert.deepEqual(invocations[0]!.slice(7), runMicrovmCommand(input, 'us-east-1'));
  const refused = scripted({ 'lambda-microvms run-microvm': { exitCode: 254, stderr: 'An error occurred (InsufficientCapacityException) when calling the RunMicrovm operation: no capacity' } });
  assert.equal((await refused.service.runMicrovm(input) as { failure: { kind: string } }).failure.kind, 'capacity');
});

test('GetMicrovm, TerminateMicrovm and CreateMicrovmAuthToken are read as the proofs observed them', async () => {
  const { service, invocations } = scripted({
    // Evidence `l1-final.json`: the CLI prints instants with the local offset.
    'lambda-microvms get-microvm': { stdout: { microvmId: 'microvm-1', state: 'TERMINATED', endpoint: 'microvm-1.lambda-microvm.us-east-1.on.aws', imageArn, imageVersion: '1.0',
      maximumDurationInSeconds: 3600, startedAt: '2026-11-20T16:13:52.716000-03:00', terminatedAt: '2026-11-20T16:15:24.100000-03:00', stateReason: 'Success.',
      ingressNetworkConnectors: [], egressNetworkConnectors: [] } },
    'lambda-microvms terminate-microvm': { stdout: undefined },
    'lambda-microvms create-microvm-auth-token': { stdout: { authToken: { 'X-aws-proxy-auth': 'eyJsecret' } } },
  });
  assert.deepEqual(await service.microvm('microvm-1'), { ok: true, value: { microvmId: 'microvm-1', state: 'TERMINATED', endpoint: 'microvm-1.lambda-microvm.us-east-1.on.aws', imageArn,
    imageVersion: '1.0', stateReason: 'Success.', startedAt: '2026-11-20T16:13:52.716000-03:00', terminatedAt: '2026-11-20T16:15:24.100000-03:00' } });
  // The terminate answer is empty: it says nothing about cessation.
  assert.deepEqual(await service.terminateMicrovm('microvm-1'), { ok: true, value: null });
  assert.deepEqual(await service.createAuthToken({ microvmId: 'microvm-1', port: 8022, expirationMinutes: 60 }), { ok: true, value: { token: 'eyJsecret' } });
  assert.deepEqual(invocations.map(argv => argv.slice(7)), [['lambda-microvms', 'get-microvm', '--microvm-identifier', 'microvm-1'],
    ['lambda-microvms', 'terminate-microvm', '--microvm-identifier', 'microvm-1'],
    ['lambda-microvms', 'create-microvm-auth-token', '--microvm-identifier', 'microvm-1', '--expiration-in-minutes', '60', '--allowed-ports', '[{"port":8022}]']]);
  const gone = scripted({ 'lambda-microvms get-microvm': { exitCode: 254, stderr: 'An error occurred (ResourceNotFoundException) when calling the GetMicrovm operation' },
    'lambda-microvms create-microvm-auth-token': { stdout: { authToken: {} } } });
  assert.equal((await gone.service.microvm('microvm-9') as { failure: { kind: string } }).failure.kind, 'not-found');
  assert.equal((await gone.service.createAuthToken({ microvmId: 'microvm-9', port: 8022, expirationMinutes: 60 })).ok, false);
});

test('ticket 15: ListMicrovms is read as observed (no tags on an item), tags are read if the service ever lists them, and a malformed item makes the whole listing unreadable', async () => {
  const observed = { microvmId: 'microvm-1', state: 'RUNNING', imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:factory-acme-a', imageVersion: '1.0', startedAt: '2026-11-21T00:00:00+00:00' };
  const { service, invocations } = scripted({ 'lambda-microvms list-microvms': { stdout: { items: [observed, { microvmId: 'microvm-2', state: 'TERMINATED',
    tags: { 'software-factory-installation': 'acme' } }] } } });
  assert.deepEqual(await service.listMicrovms(), { ok: true, value: [
    { microvmId: 'microvm-1', state: 'RUNNING', imageArn: observed.imageArn, startedAt: observed.startedAt },
    { microvmId: 'microvm-2', state: 'TERMINATED', tags: { 'software-factory-installation': 'acme' } }] });
  assert.deepEqual(invocations, [[...prefix, 'lambda-microvms', 'list-microvms']]);
  const partial = scripted({ 'lambda-microvms list-microvms': { stdout: { items: [observed, { state: 'RUNNING' }] } } });
  assert.deepEqual((await partial.service.listMicrovms()).ok, false, 'an inventory is never silently partial');
  const denied = scripted({ 'lambda-microvms list-microvms': { exitCode: 254, stderr: 'An error occurred (AccessDeniedException): not authorized to perform: lambda:ListMicrovms' } });
  assert.deepEqual(await denied.service.listMicrovms().then(result => !result.ok && [result.failure.kind, result.failure.action]), ['access-denied', 'lambda:ListMicrovms']);
});

test('ticket 15: the explicit image cleanup deletes the build artifact and the build log group with the long-standing S3 and Logs commands', async () => {
  const { service, invocations } = scripted({ 's3api delete-object': {}, 'logs delete-log-group': {} });
  assert.deepEqual(await service.deleteBuildArtifact({ bucket: 'factory-acme-build-123456789012-us-east-1', key: 'factory-acme-a.zip' }), { ok: true, value: null });
  assert.deepEqual(await service.deleteBuildLog('/aws/lambda-microvms/factory-acme-a'), { ok: true, value: null });
  assert.deepEqual(invocations, [[...prefix, 's3api', 'delete-object', '--bucket', 'factory-acme-build-123456789012-us-east-1', '--key', 'factory-acme-a.zip'],
    [...prefix, 'logs', 'delete-log-group', '--log-group-name', '/aws/lambda-microvms/factory-acme-a']]);
});
