import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { installationResources, operationPolicy } from '../../src/sandbox/index.js';

// v2 ticket 02 (V2-31): the account template the release ships. Static reading only; it is never applied by a test.
const sample = { Installation: 'acme', 'AWS::AccountId': '123456789012', 'AWS::Region': 'us-east-1' } as Record<string, string>;
/** Resolves the intrinsics the template uses (`Fn::Sub`, `Ref`) with the sample parameters. */
function resolve(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolve);
  if (!node || typeof node !== 'object') return node;
  const entries = Object.entries(node);
  if (entries.length === 1 && entries[0]![0] === 'Fn::Sub') return String(entries[0]![1]).replace(/\$\{([^}]+)\}/g, (_, name: string) => sample[name] ?? `\${${name}}`);
  if (entries.length === 1 && entries[0]![0] === 'Ref' && sample[String(entries[0]![1])]) return sample[String(entries[0]![1])];
  return Object.fromEntries(entries.map(([key, value]) => [key, resolve(value)]));
}
type Statement = { Sid: string; Effect: string; Action: string[]; Resource: string[]; Condition?: { StringEquals: Record<string, string> } };
async function template() {
  const resources = (resolve(parse(await readFile('assets/lambda/account-template.yaml', 'utf8'))) as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> }).Resources;
  const statements = (role: string) => (resources[role]!.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[]).flatMap(policy => policy.PolicyDocument.Statement);
  return { resources, statements };
}

test('the template creates exactly the operation role, the build role and the build bucket, named as validate looks for them', async () => {
  const { resources } = await template();
  const expected = installationResources({ installation: 'acme', region: 'us-east-1' }, '123456789012');
  assert.deepEqual(Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, resource.Type])),
    { ArtifactBucket: 'AWS::S3::Bucket', BuildRole: 'AWS::IAM::Role', OperationRole: 'AWS::IAM::Role' });
  assert.equal(resources.OperationRole!.Properties.RoleName, expected.operationRole);
  assert.equal(resources.BuildRole!.Properties.RoleName, expected.buildRole);
  assert.equal(resources.ArtifactBucket!.Properties.BucketName, expected.artifactBucket);
  assert.deepEqual(resources.ArtifactBucket!.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  for (const resource of Object.values(resources)) assert.deepEqual(resource.Properties.Tags, [{ Key: 'software-factory-installation', Value: 'acme' }]);
});

test('CreateMicrovmImage and TagResource sit on *, the second only with the installation tag; nothing else of the service is on * except listing', async () => {
  const { statements } = await template();
  const operation = statements('OperationRole');
  const on = (action: string) => operation.filter(statement => statement.Action.includes(action));
  assert.deepEqual(on('lambda:CreateMicrovmImage').map(statement => [statement.Resource, statement.Condition]), [[['*'], undefined]]);
  assert.deepEqual(on('lambda:TagResource').map(statement => [statement.Resource, statement.Condition]),
    [[['*'], { StringEquals: { 'aws:RequestTag/software-factory-installation': 'acme' } }]]);
  const wildcard = operation.filter(statement => statement.Resource.includes('*')).flatMap(statement => statement.Action).sort();
  assert.deepEqual(wildcard, ['lambda:CreateMicrovmImage', 'lambda:ListMicrovmImages', 'lambda:ListMicrovms', 'lambda:TagResource', 'servicequotas:ListServiceQuotas']);
  assert.deepEqual(on('lambda:RunMicrovm')[0]!.Resource, ['arn:aws:lambda:us-east-1:123456789012:microvm-image:factory-acme-*']);
  assert.ok(operation.every(statement => statement.Effect === 'Allow'));
});

test('the operation role cannot create or change IAM, and the build role only reads the artifact and writes its log', async () => {
  const { statements } = await template();
  const iam = statements('OperationRole').flatMap(statement => statement.Action).filter(action => action.startsWith('iam:')).sort();
  assert.deepEqual(iam, ['iam:GetRole', 'iam:PassRole', 'iam:SimulatePrincipalPolicy']);
  assert.deepEqual(statements('BuildRole').map(statement => [statement.Action, statement.Resource[0]]), [
    [['s3:GetObject'], 'arn:aws:s3:::factory-acme-build-123456789012-us-east-1/*'],
    [['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda-microvms/factory-acme-*']]);
});

test('the template grants exactly the policy validate simulates (one list, no drift)', async () => {
  const { statements } = await template();
  assert.deepEqual(statements('OperationRole'), operationPolicy({ installation: 'acme', region: 'us-east-1' }, '123456789012').map(statement => ({
    Sid: statement.sid, Effect: 'Allow', Action: statement.actions, Resource: statement.resources,
    ...(statement.condition ? { Condition: { StringEquals: { [statement.condition.key]: statement.condition.value } } } : {}) })));
});
