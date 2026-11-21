import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const configuration = `schemaVersion: 1
operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - repository: owner/project
    base: main
    installationId: 456
    workflows: false
`;

async function diagnose(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-config-'));
  try {
    await writeFile(join(root, 'config.yaml'), yaml);
    const result = spawnSync(process.execPath, [resolve('dist/src/entrypoints/cli.js'), 'doctor', '--root', root, '--json'], { encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr);
    return { ...result, report: JSON.parse(result.stdout) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('doctor validates complete YAML and reports only approved defaults and explicit role models', async () => {
  const { report } = await diagnose(configuration);
  assert.equal(report.configuration.valid, true);
  const effective = report.configuration.effective;
  assert.equal(effective.concurrency, 1);
  assert.equal(effective.pollingSeconds, 60);
  assert.equal(effective.retentionDays, 30);
  assert.deepEqual(effective.recoveryBackoffSeconds, [5, 15, 45]);
  assert.deepEqual(effective.models, {
    builder: { provider: 'example', model: 'builder-model' },
    standards: { provider: 'example', model: 'standards-model' },
    spec: { provider: 'example', model: 'spec-model' },
  });
  assert.deepEqual(effective.repositories, [{ repository: 'owner/project', base: 'main', installationId: 456,
    workflows: false, label: 'ready-for-agent', correctionLimit: 3, recoveryLimit: 3 }]);
  assert.deepEqual(effective.sandbox, { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048,
    vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 });
});

test('invalid configuration is rejected as a whole without echoing secrets or exposing partial effective settings', async () => {
  const invalid = [
    ['schema version', configuration.replace('schemaVersion: 1', 'schemaVersion: 2')],
    ['operator omitted', configuration.replace('operators: [operator-one]\n', '')],
    ['model omitted', configuration.replace('  spec: {provider: example, model: spec-model}\n', '')],
    ['workflow choice omitted', configuration.replace('    workflows: false\n', '')],
    ['base omitted', configuration.replace('    base: main\n', '')],
    ['invalid ref', configuration.replace('base: main', 'base: topic/.hidden')],
    ['installation omitted', configuration.replace('    installationId: 456\n', '')],
    ['implicit model fallback', configuration.replace('provider: example', 'provider: null')],
    ['unknown overrides', configuration + 'overrides: {work: arbitrary}\n'],
    ['secret key value', configuration.replace('privateKeyFile: credentials/app.pem', 'privateKeyFile: ghp_SYNTHETIC_SECRET')],
    ['inline secret', configuration + 'token: ghp_SYNTHETIC_SECRET\n'],
    ['invalid YAML containing secret', configuration + 'bad: [ghp_SYNTHETIC_SECRET\n'],
    ['duplicate YAML key', configuration + 'operators: [other]\n'],
    ['string instead of integer', configuration + 'concurrency: "2"\n'],
    ['duplicate repository', configuration + '  - {repository: OWNER/PROJECT, base: main, installationId: 456, workflows: true}\n'],
    ['arbitrary sandbox flags', configuration.replace('profile: gondolin-qemu-alpine-dev-v1}', 'profile: gondolin-qemu-alpine-dev-v1, qemuArgs: [-enable-kvm]}')],
    ['zero sandbox resource', configuration.replace('profile: gondolin-qemu-alpine-dev-v1}', 'profile: gondolin-qemu-alpine-dev-v1, memoryMiB: 0}')],
    ['unknown sandbox profile', configuration.replace('gondolin-qemu-alpine-dev-v1', 'tcg-fallback')],
    // v2 ticket 01 (V2-01): one adapter for the whole installation, chosen statically (unknown/several adapters: test/sandbox/adapter-selection.test.ts).
    ['sandbox chosen per repository', configuration.replace('    workflows: false\n', '    workflows: false\n    sandbox: {adapter: gondolin}\n')],
  ];
  for (const [name, yaml] of invalid) {
    assert.ok(yaml);
    const { status, stdout, stderr, report } = await diagnose(yaml);
    assert.equal(status, 2, name);
    assert.equal(report.configuration.valid, false, name);
    assert.equal('effective' in report.configuration, false, name);
    assert.ok(report.configuration.errors.length > 0, name);
    assert.doesNotMatch(stdout + stderr, /ghp_SYNTHETIC_SECRET/, name);
  }
});

test('doctor accepts explicit overrides including Workflows permission, limits, timeout and adapter resources', async () => {
  const yaml = configuration.replace('workflows: false', `workflows: true
    label: implement-approved
    correctionLimit: 0
    recoveryLimit: 4
    timeoutSeconds: 300`)
    .replace('profile: gondolin-qemu-alpine-dev-v1}', 'profile: gondolin-qemu-alpine-dev-v1, memoryMiB: 4096, vcpus: 4, diskGiB: 80, shutdownGraceSeconds: 60, minFreeSpaceGiB: 8}')
    + 'concurrency: 3\npollingSeconds: 90\nretentionDays: 10\n';
  const { report } = await diagnose(yaml);
  assert.equal(report.configuration.valid, true);
  const effective = report.configuration.effective;
  assert.equal(effective.concurrency, 3);
  assert.equal(effective.pollingSeconds, 90);
  assert.equal(effective.retentionDays, 10);
  assert.deepEqual(effective.repositories[0], { repository: 'owner/project', base: 'main', installationId: 456,
    workflows: true, label: 'implement-approved', correctionLimit: 0, recoveryLimit: 4, timeoutSeconds: 300 });
  assert.deepEqual(effective.sandbox, { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096,
    vcpus: 4, diskGiB: 80, shutdownGraceSeconds: 60, minFreeSpaceGiB: 8 });
});

test('model credentials are installation file references, never inline values or personal paths', async () => {
  const referenced = configuration.replace('provider: example, model: builder-model', 'provider: example, model: builder-model, credentialFile: credentials/model.json');
  const { report } = await diagnose(referenced);
  assert.equal(report.configuration.valid, true);
  assert.equal(report.configuration.effective.models.builder.credentialFile, 'credentials/model.json');
  assert.equal(report.checks.find((check: { id: string }) => check.id === 'credential-file:models.builder').status, 'blocked');
  for (const path of ['/home/operator/.pi/auth.json', '../personal.json', 'ghp_SYNTHETIC_SECRET']) {
    const invalid = await diagnose(referenced.replace('credentials/model.json', path));
    assert.equal(invalid.report.configuration.valid, false);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /ghp_SYNTHETIC_SECRET/);
  }
});

test('explicitly empty operators authorizes no remote operator rather than inheriting an identity', async () => {
  const { report } = await diagnose(configuration.replace('operators: [operator-one]', 'operators: []'));
  assert.equal(report.configuration.valid, true);
  assert.deepEqual(report.configuration.effective.operators, []);
});

test('dependency-only repositories are explicit, read-only and distinct from executable repositories', async () => {
  const base = await diagnose(configuration);
  assert.deepEqual(base.report.configuration.effective.dependencyRepositories, [], 'none by default: no repository is discovered or inherited');
  const withDependencies = configuration + 'dependencyRepositories:\n  - {repository: owner/library, installationId: 456}\n  - {repository: other-owner/shared, installationId: 789}\n';
  const { report } = await diagnose(withDependencies);
  assert.equal(report.configuration.valid, true);
  assert.deepEqual(report.configuration.effective.dependencyRepositories,
    [{ repository: 'owner/library', installationId: 456 }, { repository: 'other-owner/shared', installationId: 789 }]);
  for (const [name, yaml] of [
    ['executable repository repeated as dependency-only', configuration + 'dependencyRepositories: [{repository: Owner/Project, installationId: 456}]\n'],
    ['duplicate dependency-only repository', configuration + 'dependencyRepositories: [{repository: a/b, installationId: 1}, {repository: A/B, installationId: 1}]\n'],
    ['executable fields on a dependency-only repository', configuration + 'dependencyRepositories: [{repository: a/b, installationId: 1, base: main}]\n'],
    ['installation omitted', configuration + 'dependencyRepositories: [{repository: a/b}]\n'],
  ]) assert.equal((await diagnose(yaml!)).report.configuration.valid, false, name);
});

test('review 3: an operator can be pinned by immutable GitHub user id next to the login; duplicate ids/logins and invalid ids are rejected', async () => {
  const pinned = await diagnose(configuration.replace('operators: [operator-one]', 'operators: [operator-one, {login: Sanmoo, id: 4242}]'));
  assert.equal(pinned.report.configuration.valid, true, pinned.stdout);
  assert.deepEqual(pinned.report.configuration.effective.operators, ['operator-one', { login: 'Sanmoo', id: 4242 }]);
  for (const bad of ['operators: [{login: Sanmoo, id: 0}]', 'operators: [{login: Sanmoo, id: 1}, {login: other, id: 1}]', 'operators: [sanmoo, {login: Sanmoo, id: 3}]',
    'operators: [{login: Sanmoo, id: 3, extra: 1}]']) {
    assert.equal((await diagnose(configuration.replace('operators: [operator-one]', bad))).report.configuration.valid, false, bad);
  }
});

test('ticket 48: a repository adjusts the Builder budget up to 2x of 150 requests / 300 tool calls / 60 minutes; above it the configuration is refused', async () => {
  const adjusted = configuration.replace('workflows: false', 'workflows: false\n    builderBudget: {requests: 300, toolCalls: 450, requestTimeoutMinutes: 120}');
  const { report } = await diagnose(adjusted);
  assert.equal(report.configuration.valid, true);
  assert.deepEqual(report.configuration.effective.repositories[0].builderBudget, { requests: 300, toolCalls: 450, requestTimeoutMinutes: 120 });
  const partial = await diagnose(configuration.replace('workflows: false', 'workflows: false\n    builderBudget: {requests: 200}'));
  assert.deepEqual(partial.report.configuration.effective.repositories[0].builderBudget, { requests: 200 }, 'absent values keep the release values');
  for (const [field, value] of [['requests', 301], ['toolCalls', 601], ['requestTimeoutMinutes', 121]] as const) {
    const { status, report: refused } = await diagnose(configuration.replace('workflows: false', `workflows: false\n    builderBudget: {${field}: ${value}}`));
    assert.equal(status, 2, field);
    assert.equal(refused.configuration.valid, false, 'no silent fallback to the release value');
    assert.equal('effective' in refused.configuration, false);
    assert.deepEqual(refused.configuration.errors, [{ code: 'BUILDER_BUDGET_ABOVE_MAXIMUM', path: `repositories.0.builderBudget.${field}` }]);
  }
  for (const yaml of ['builderBudget: {requests: 0}', 'builderBudget: {requests: 1.5}', 'builderBudget: {deadlineMs: 1000}']) {
    const { report: invalid } = await diagnose(configuration.replace('workflows: false', `workflows: false\n    ${yaml}`));
    assert.equal(invalid.configuration.valid, false, yaml);
    assert.equal(invalid.configuration.errors[0].code, 'CONFIGURATION_INVALID', yaml);
  }
});

test('v2 ticket 01: sandbox.adapter selects the installation adapter; Gondolin named explicitly is the existing profile, a Lambda selection without its profile is invalid', async () => {
  const explicit = await diagnose(configuration.replace('sandbox: {', 'sandbox: {adapter: gondolin, '));
  assert.equal(explicit.report.configuration.valid, true);
  assert.deepEqual(explicit.report.configuration.effective.sandbox, { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048,
    vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 }, 'identical to an installation that never named an adapter');
  const lambda = await diagnose(configuration.replace('sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}', 'sandbox: {adapter: lambda, schemaVersion: 1}'));
  assert.equal(lambda.status, 2);
  // v2 ticket 02: the Lambda adapter has its own profile; without the AWS profile name and the installation name no account is contacted.
  assert.deepEqual(lambda.report.configuration, { valid: false, errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.awsProfile' },
    { code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.installation' }] });
  const check = lambda.report.checks.find((item: { id: string }) => item.id === 'sandbox-adapter');
  assert.equal(check.status, 'blocked');
  assert.match(check.message, /lambda/);
});
