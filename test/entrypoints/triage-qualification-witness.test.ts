import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { composeProductionAccess, composeProductionExecution, composeProductionTriage } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import type { ExecutionPorts, ListView } from '../../src/control/index.js';
import { call, triageWorld } from '../control/triage-investigation-fixture.js';
import { untilHolds } from '../runner/budget.js';
import { githubWorld, issue } from './github-world-fixture.js';
import * as recipe from './triage-qualification.js';
import { githubCorpus, precedenceText } from './triage-qualification-corpus.js';

// Spec #68 §13 (ticket #84), TR-43 and TQ-06 OFFLINE: the part of the real `triage-qualification` recipe that ends the qualification at the
// admitted Work. The recipe replaces the Sandbox and the workers of the production execution ports with a witness that records the
// first prompt the Control hands to the Builder and launches nothing; this proves that the witness works under the real Control and that
// the recipe's own judgement (`tq06`) accepts what it records.
//
// Everything here is synthetic: the gh world in place of GitHub, a scripted model provider in place of the Triager's model, the
// in-process Investigation Environment. It is NOT the qualification and approves nothing of it: the recipe was never run against a real
// model, repository or tenant.
const G1 = githubCorpus[0]!;
Object.assign(recipe.fixture, {
  repository: 'acme/project',
  repositoryId: 3,
  installationId: 2,
  appId: 1,
  commit: 'c'.repeat(40),
  operatorLogin: 'operator-one',
  issues: { measure: [11, 12, 13, 14, 15, 16, 17, 18, 19], fixed: [7, 22, 23, 24, 25, 26, 27, 28, 29] },
});
const model = `{provider: ${productionProfile.model.providerId}, model: ${productionProfile.model.modelId}}`;
const yaml = `schemaVersion: 3
operators: [operator-one]
models:
  builder: ${model}
  standards: ${model}
  spec: ${model}
  triager: ${model}
githubApp: {appId: 1, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: acme/project, base: main, installationId: 2, workflows: false, label: ready-for-agent}
ticketSources:
  - {tracker: github, repository: acme/project, discover: true, triage: {}}
`;
const verdictText = [
  'Observed: `subtotal` in src/cart.js sums `price` and never multiplies by `quantity`.',
  'Brief: the subtotal is the sum of price times quantity, a missing quantity counting as 1.',
].join('\n');

test('TR-43 / TQ-06 (offline): the witness of the recipe records the Builder first prompt of the admitted Work, with the text of a person and the Verdict, and launches nothing', async t => {
  const human = { id: 9, login: 'operator-one', type: 'User' };
  const tip = 'b'.repeat(40);
  const world = await githubWorld(t, {
    issues: [
      issue(7, {
        title: G1.title,
        body: G1.body,
        labels: [{ id: 56, name: 'needs-triage' }],
        timeline: [
          { id: 11, event: 'labeled', label: { name: 'needs-triage' }, created_at: '2026-11-20T10:00:11Z', actor: human, performed_via_github_app: null },
        ],
      }),
    ],
    comments: [{ id: 501, issue: 7, body: precedenceText, user: human, author_association: 'MEMBER' }],
    pulls: [],
    refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } },
    checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [{ type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' }] },
      checkRuns: {},
      statuses: {},
      compare: {},
    },
  });
  await writeFile(join(world.root, 'config.yaml'), yaml);
  const { configuration } = await readConfiguration(world.root, undefined, { triageHost: async () => [] });
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) return;
  const effective = configuration.effective;
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const composed = await composeProductionExecution({
    root: world.root,
    effective,
    guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) },
    github,
  });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const triage = await composeProductionTriage({ root: world.root, release: 'release-under-test', effective, github });
  assert.equal(triage.status, 'composed');
  if (triage.status !== 'composed') return;
  const { release, limits, investigationMinutes, capacity, attempts } = triage.ports;

  // As the recipe composes a pass: the production execution ports with the Sandbox and the workers replaced by the witness.
  const witness = await recipe.promptWitness();
  const execution: ExecutionPorts = { ...composed.ports, sandbox: witness.sandbox, workers: witness.workers };
  const w = await triageWorld(t, {
    sources: [],
    script: [() => call('concluir_triagem', { outcome: 'ready-for-agent', category: 'bug', text: verdictText })],
    ports: { release, limits, investigationMinutes, capacity, attempts },
    execution,
    access: () => composeProductionAccess({ root: world.root, github, effective }),
  });
  const works = async () => ((await w.control().inspect({ kind: 'list' })) as ListView).works;
  await w.start();
  await untilHolds(
    'the first prompt witnessed',
    async () => {
      if (witness.prompts.length > 0) return true;
      await w.poll();
      return false;
    },
    5,
  );
  await w.poll();
  await w.poll();

  // The witness holds the one activation: the first prompt of the Builder, with the pack it is started with. Nothing else was launched.
  assert.equal(witness.prompts.length, 1, 'one Builder activation reached the witness, and no reviewer');
  const [first] = witness.prompts;
  assert.deepEqual([first!.phaseId, first!.skillPack], ['builder-initial', 'factory-skills-v13']);
  assert.match(first!.prompt, /^\/implement https:\/\/github\.com\/acme\/project\/issues\/7 /);
  assert.ok(first!.prompt.indexOf(precedenceText) < first!.prompt.indexOf(recipe.verdictHeader), 'the person comment, then the published Verdict');
  assert.ok(first!.prompt.includes(verdictText));
  const admitted = await works();
  assert.equal(admitted.length, 1, 'one Work, still open: the stand-in Builder never ends by itself');
  assert.deepEqual(
    (await world.trace()).filter(entry => entry.method !== 'GET' && /\/(pulls|git\/refs)/.test(entry.endpoint)),
    [],
    'no branch and no pull request: nothing ran',
  );

  // The recipe judges exactly this record: the saved shape of a pass, then the evidence and the criteria TQ-06 and TR-43.
  const saved = { status: 'success', requests: await w.requests(), works: admitted, prompts: witness.prompts };
  const requests = recipe.storedEvidence('fixed', saved);
  assert.deepEqual(
    requests.map(request => [request.item, request.state, request.outcome]),
    [['G1', 'concluded', 'ready-for-agent']],
  );
  const pack = fileURLToPath(new URL(`../../../assets/skill-pack/${first!.skillPack}/skills/implement/SKILL.md`, import.meta.url));
  const evidence: recipe.PassEvidence = {
    pass: 'fixed',
    limits: { requests: 48, toolCalls: 160, investigationMinutes: 15 },
    requests,
    ...recipe.admittedEvidence('fixed', saved),
    mcp: null,
    triager: null,
    packStatesPrecedence: (await readFile(pack, 'utf8')).includes(recipe.precedenceRule),
    jiraPermissions: null,
  };
  assert.deepEqual(evidence.works, [{ item: 'G1', label: 'ready-for-agent', state: 'authorized', route: null }]);
  assert.deepEqual(recipe.tq06(evidence), { work: { status: 'approved', reasons: [] }, precedence: { status: 'approved', reasons: [] } });
  // The same record without the person's comment in the prompt would be refused: the judgement reads the prompt, not the Work.
  const withoutPerson = { ...evidence, prompts: evidence.prompts.map(prompt => ({ ...prompt, prompt: prompt.prompt.replace(precedenceText, '') })) };
  assert.deepEqual(recipe.tq06(withoutPerson).precedence.reasons, ['PERSON_TEXT_ABSENT']);
});
