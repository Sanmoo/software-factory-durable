import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeProductionExecution, latestContinuationPack, productionSkillPack } from '../../src/entrypoints/controller/composition.js';
import { factorySkillPackIds } from '../../src/contracts/index.js';
import { readFile } from 'node:fs/promises';
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

test('production skill pack is DERIVED: the latest registered pack whose manifest declares continuation (no hardcoded version)', async () => {
  assert.equal(await latestContinuationPack(['p1', 'p2', 'p3'], async id => id !== 'p1'), 'p3');
  assert.equal(await latestContinuationPack(['p1', 'p2', 'p3'], async id => id === 'p2'), 'p2');
  await assert.rejects(latestContinuationPack(['p1'], async () => false), /PRODUCTION_SKILL_PACK_UNAVAILABLE/);
  // Against the real registry: the last id whose manifest capability says continuation (a later pack supersedes it by registration).
  const continues = async (id: string) => (JSON.parse(await readFile(`assets/skill-pack/${id}/manifest.json`, 'utf8')) as
    { capabilities?: { continuation?: boolean } }).capabilities?.continuation === true;
  const expected = [...factorySkillPackIds].reverse();
  let latest: string | undefined;
  for (const id of expected) if (await continues(id)) { latest = id; break; }
  assert.equal(await productionSkillPack(), latest);
  assert.ok(latest);
  // Ticket 13: the newest registered pack (multi-round reviews) declares continuation, so production derives it with no composition edit.
  assert.equal(latest, factorySkillPackIds.at(-1), 'the newest registered pack is the production pack');
});

test('production composition: the release profile for all three roles, the derived continuation pack with reviews and session observation, configured capacity/sandbox and the release asset pin', async () => {
  const pack = await productionSkillPack();
  const composed = await composeProductionExecution({ root: '/installation', effective, guestAssets, github });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const { ports, summary } = composed;
  assert.equal(ports.capacity, 2);
  assert.equal(ports.configuration, effective.sandbox);
  // v2 ticket 01 (V2-03): Control receives the capabilities the configured adapter declares (Gondolin: Docker, persistent disk, no boot
  // limit, mediated egress), never the adapter itself.
  assert.deepEqual(ports.sandbox.capabilities, { docker: true, persistentDisk: true, bootDuration: null, egress: { mediation: 'http', publicTcp: false } });
  assert.deepEqual(ports.builder, { skillPack: pack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 });
  // Ticket 13: production repeats review rounds inside the Execution (treatments/gates/verification), bounded by the release profile.
  // Ticket 28: and recovers partial reviews (only the failed reviewer; lost notifications from Records; carried opinions after recovery).
  assert.deepEqual(ports.reviews, { reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5 * 1024 * 1024 }, rounds: { max: 4 }, partialRecovery: true });
  assert.deepEqual(productionProfile.reviewRounds, { max: 4 });
  assert.match(productionProfile.prompts.builder, /treat ONLY the findings the results list/);
  assert.doesNotMatch(productionProfile.prompts.builder, /call the handoff tool once/, 'the multi-round pack hands off again');
  for (const name of ['prepare', 'start', 'stop', 'observeProposal', 'verifyPreservedSource'] as const) assert.equal(typeof ports.sandbox[name], 'function', name);
  assert.equal(typeof ports.workers.activate, 'function');
  assert.equal(typeof ports.workers.deliver, 'function');
  // Ticket 11: the planned next Builder may continue a preserved session only through the Workers observation port.
  assert.equal(typeof ports.workers.observe, 'function');
  // Ticket 26: boot reconciliation observes/stops own boots through the host path and discovers start receipts without notification.
  assert.equal(typeof ports.sandbox.observe, 'function');
  assert.equal(typeof ports.workers.observeStart, 'function');
  // Ticket 28: a reviewer's complete opinion record is located through the Workers opinion facet (never by rerunning it).
  assert.equal(typeof ports.workers.observeOpinion, 'function');
  assert.equal(typeof ports.credentials.issue, 'function');
  assert.deepEqual(summary.guestAssets, guestAssets);
  assert.deepEqual(summary.artifactSeeds, [`factory/skill-pack/${pack}`]);
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

test('production composition refuses any role whose configured provider/model is not the release profile; no fallback, no partial ports', async () => {
  for (const role of ['builder', 'standards', 'spec'] as const) {
    const models = { ...effective.models, [role]: { provider: 'openai', model: 'other-model' } };
    const refused = await composeProductionExecution({ root: '/installation', effective: { ...effective, models }, guestAssets, github });
    assert.deepEqual(refused.status === 'refused' ? { status: refused.status, code: refused.code, roles: refused.roles } : refused,
      { status: 'refused', code: 'WORKER_PROFILE_UNSUPPORTED', roles: [role] });
    assert.equal('ports' in refused, false);
  }
});

test('v2 ticket 01: a sandbox adapter this release cannot run refuses the whole composition (no fallback to another sandbox)', async () => {
  const refused = await composeProductionExecution({ root: '/installation', effective: { ...effective, sandbox: { adapter: 'lambda', schemaVersion: 1 } }, guestAssets, github });
  assert.deepEqual(refused, { status: 'refused', code: 'SANDBOX_ADAPTER_UNAVAILABLE', roles: [] });
});
