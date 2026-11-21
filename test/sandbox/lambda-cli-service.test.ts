import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLambdaCliService, type AwsCliRunner } from '../../src/sandbox/index.js';
import { awsCliEnvironment, createAwsCliRunner, memoryQuota } from '../../src/sandbox/lambda/cli-service.js';

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
