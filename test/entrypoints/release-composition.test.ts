import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import { createGitHubAccess } from '../../src/platform/github/index.js';

// R/S boundary of the production composition (ticket 32): only object composition is exercised; nothing is prepared, booted, launched,
// fetched or issued (no GitHub, VM, model or credential). The ports themselves are the public implementations tested by tickets 03-20.
const model = { provider: 'openai', model: 'gpt-6-luna' };
const repository = { repository: 'owner/repo', base: 'main', installationId: 456, workflows: false, label: 'ready-for-agent', correctionLimit: 3, recoveryLimit: 3 };
const effective = {
  models: { builder: model, standards: model, spec: model }, githubApp: { appId: 123, privateKeyFile: 'credentials/github-app.pem' },
  repositories: [repository], concurrency: 2,
  sandbox: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 },
};
const guestAssets = { directory: '/installation/assets/guest/' + 'a'.repeat(64), manifestSha256: 'a'.repeat(64) };
const github = createGitHubAccess({ root: '/installation', appId: 123, privateKeyFile: 'credentials/github-app.pem' });

test('production composition: the release profile for all three roles, skill pack v3 with reviews, configured capacity/sandbox and the release asset pin', () => {
  const composed = composeProductionExecution({ root: '/installation', effective, guestAssets, github });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const { ports, summary } = composed;
  assert.equal(ports.capacity, 2);
  assert.equal(ports.configuration, effective.sandbox);
  assert.deepEqual(ports.builder, { skillPack: 'factory-skills-v3', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 });
  assert.deepEqual(ports.reviews, { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5 * 1024 * 1024 } });
  for (const name of ['prepare', 'start', 'stop', 'observeProposal'] as const) assert.equal(typeof ports.sandbox[name], 'function', name);
  assert.equal(typeof ports.workers.activate, 'function');
  assert.equal(typeof ports.workers.deliver, 'function');
  assert.equal(typeof ports.credentials.issue, 'function');
  assert.deepEqual(summary.guestAssets, guestAssets);
  assert.deepEqual(summary.artifactSeeds, ['factory/skill-pack/factory-skills-v3']);
  for (const role of ['builder', 'standards', 'spec'] as const) {
    assert.deepEqual({ ...summary.profiles[role], systemPromptSha256: undefined }, { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
      auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses', systemPromptSha256: undefined });
    assert.match(summary.profiles[role].systemPromptSha256, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(summary.profiles.builder.systemPromptSha256, summary.profiles.spec.systemPromptSha256);
  // Spec §4.4: production composes NO worker clock deadline; only the optional configured per-repository timeout applies.
  assert.equal('deadlineMs' in ports.builder, false);
  assert.equal('deadlineSeconds' in ports.builder, false);
  assert.equal('timeoutSeconds' in ports.builder, false);
  assert.match(productionProfile.limits.deadline, /^not set by production composition; only the optional configured per-repository timeoutSeconds applies$/);
  assert.doesNotMatch(JSON.stringify(productionProfile.limits), /deadlineMinutes|deadlineMs/);
});

test('production composition refuses any role whose configured provider/model is not the release profile; no fallback, no partial ports', () => {
  for (const role of ['builder', 'standards', 'spec'] as const) {
    const models = { ...effective.models, [role]: { provider: 'openai', model: 'other-model' } };
    const refused = composeProductionExecution({ root: '/installation', effective: { ...effective, models }, guestAssets, github });
    assert.deepEqual(refused.status === 'refused' ? { status: refused.status, code: refused.code, roles: refused.roles } : refused,
      { status: 'refused', code: 'WORKER_PROFILE_UNSUPPORTED', roles: [role] });
    assert.equal('ports' in refused, false);
  }
});
