import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageReferenceParts, validateEnvironmentDeclaration } from '../../src/contracts/index.js';
import { environmentNotEvaluated, environmentOutcome } from '../../src/control/rules/environment.js';
import { blockedStartImpediment, refusedWithoutActivity, retriesEnvironmentBase } from '../../src/control/rules/recovery.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('ticket 44: the declaration schema is closed: exact apk versions, images by digest with an explicit registry, nothing else', () => {
  assert.deepEqual(validateEnvironmentDeclaration({ schemaVersion: 1, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }],
    images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }] }),
  { valid: true, declaration: { schemaVersion: 1, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }] } });
  assert.deepEqual(validateEnvironmentDeclaration({ schemaVersion: 1, apk: [] }), { valid: true, declaration: { schemaVersion: 1, apk: [], images: [] } });
  const paths = (value: unknown) => { const result = validateEnvironmentDeclaration(value); return result.valid ? [] : result.errors.map(error => error.path); };
  assert.deepEqual(paths(null), ['$']);
  assert.deepEqual(paths({ schemaVersion: 2, apk: [] }), ['schemaVersion']);
  assert.deepEqual(paths({ schemaVersion: 1 }), ['apk'], 'apk is required (every repository declares, even an empty list)');
  assert.deepEqual(paths({ schemaVersion: 1, apk: [], scripts: ['./setup.sh'], run: 'x' }), ['scripts', 'run'], 'no scripts or free commands');
  for (const version of ['25', '25.0.5', '~25.0', '>=25.0.5-r0', '25.0.5.1_p2', 'latest', '25.0.5.1_p2-r0 ; rm -rf /']) {
    assert.deepEqual(paths({ schemaVersion: 1, apk: [{ name: 'openjdk25-jdk', version }] }), ['apk[0].version'], `inexact version ${version}`);
  }
  assert.deepEqual(paths({ schemaVersion: 1, apk: [{ name: 'OpenJDK', version: '1-r0' }, { name: 'a', version: '1-r0', post: 'x' }] }), ['apk[0].name', 'apk[1].post']);
  assert.deepEqual(paths({ schemaVersion: 1, apk: [{ name: 'a', version: '1-r0' }, { name: 'a', version: '2-r0' }] }), ['apk[1].name'], 'duplicate package');
  for (const reference of ['eclipse-temurin:25-jdk', `eclipse-temurin@${digest}`, 'docker.io/library/eclipse-temurin:25-jdk', `docker.io/library/eclipse-temurin:25@${digest}`,
    `docker.io/library/x@sha256:${'a'.repeat(63)}`]) {
    assert.deepEqual(paths({ schemaVersion: 1, apk: [], images: [{ reference }] }), ['images[0].reference'], `not pinned by digest with a registry: ${reference}`);
  }
  assert.deepEqual(paths({ schemaVersion: 1, apk: Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, version: '1-r0' })) }), ['apk']);
  assert.deepEqual(imageReferenceParts(`ghcr.io:443/acme/tool@${digest}`), { registry: 'ghcr.io:443', path: 'acme/tool', digest });
});

test('ticket 44: environmentOutcome pins a declared file once; missing/invalid/unread keep the Work from starting with the impediment that says why', () => {
  const at = '2026-11-19T10:00:00.000Z';
  const context = { workId: 'w', repository: 'acme/project', base: 'main', at };
  const initial = environmentNotEvaluated(at);
  assert.equal(initial.impediment.code, 'ENVIRONMENT_NOT_EVALUATED');
  const declaration = { schemaVersion: 1 as const, apk: [{ name: 'openjdk25-jdk', version: '25.0.5.1_p2-r0' }], images: [] };
  const pinned = environmentOutcome(initial.environment, { kind: 'declared', observedAt: at, commit: 'a'.repeat(40), sha256: 'e'.repeat(64), declaration }, context)!;
  assert.deepEqual([pinned.environment.state, pinned.impediment, pinned.event], ['pinned', null, `environment-pinned:${'a'.repeat(40)}:${'e'.repeat(64)}`]);
  assert.equal(environmentOutcome(pinned.environment, { kind: 'missing', observedAt: at, commit: 'b'.repeat(40) }, context), null, 'a pin is never re-read');
  assert.equal(environmentOutcome(undefined, { kind: 'missing', observedAt: at, commit: 'b'.repeat(40) }, context), null, 'a Work before ticket 44 is never gated');
  const missing = environmentOutcome(initial.environment, { kind: 'missing', observedAt: at, commit: 'b'.repeat(40) }, context)!;
  assert.equal(missing.impediment?.code, 'ENVIRONMENT_NOT_DECLARED');
  assert.match(missing.impediment!.nextStep, /acme\/project \(main at bbbbbbbbbbbb\) has no \.factory\/environment\.yaml/);
  assert.equal(environmentOutcome(missing.environment, { kind: 'missing', observedAt: at, commit: 'b'.repeat(40) }, context)!.event, null, 'history only on a change');
  const invalid = environmentOutcome(initial.environment, { kind: 'invalid', observedAt: at, commit: 'b'.repeat(40), sha256: '1'.repeat(64),
    errors: [{ path: 'apk[0].version', message: 'inexact' }] }, context)!;
  assert.equal(invalid.impediment?.code, 'ENVIRONMENT_DECLARATION_INVALID');
  assert.match(invalid.impediment!.nextStep, /apk\[0\]\.version: inexact/);
  const unread = environmentOutcome(initial.environment, { kind: 'unavailable', observedAt: at, code: 'GITHUB_RATE_LIMITED', nextStep: 'wait' }, context)!;
  assert.deepEqual([unread.environment.state, unread.impediment?.code], ['not-evaluated', 'ENVIRONMENT_NOT_EVALUATED']);
});

test('ticket 44: environment base refusals settle at once and only their operator retry retries the base, with the cause shown', () => {
  for (const code of ['ENVIRONMENT_BASE_PREPARATION_FAILED', 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE', 'ENVIRONMENT_PREPARATION_VM_NOT_COMPOSED', 'ENVIRONMENT_NOT_PINNED']) {
    assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'failure', code }), true, code);
  }
  assert.equal(refusedWithoutActivity({ phase: 'prepare', status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_VM_UNCONFIRMED' }), false, 'an unconfirmed VM keeps the hold');
  assert.equal(retriesEnvironmentBase('PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED'), true);
  assert.equal(retriesEnvironmentBase('PREPARE_ARTIFACT_SEED_VERSION_CONFLICT'), false);
  const impediment = blockedStartImpediment('w', 'PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED', 'apk: unable to select packages', '2026-11-19T10:00:00.000Z');
  assert.match(impediment.nextStep, /apk: unable to select packages/);
  assert.match(impediment.nextStep, /no other version or image/);
  assert.match(impediment.nextStep, /factory resume w --retry-blocked-start PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED --request-id <id>/);
});
