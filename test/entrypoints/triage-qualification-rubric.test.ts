import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as recipe from './triage-qualification.js';

// Spec #68 §13 (ticket #84): the rubric of the real qualification and the recipe that judges by it stay in agreement. Pure checks over
// files of the checkout: every oracle TQ-01..TQ-06 is planned, each one names criteria the rubric has and phases the recipe has, what
// earlier tickets deferred lands on a criterion of an oracle, and the rubric has the format docs/agents/experiment-proofs.md asks for.
// It runs nothing real and judges no evidence; the observed status of each oracle lives in the tracker, never in the repository.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const rubricBytes = readFileSync(join(repository, recipe.rubric.path));
const rubric = JSON.parse(rubricBytes.toString('utf8')) as {
  schemaVersion: number;
  id: string;
  version: number;
  scope: string;
  criteria: { id: string; kind: string; requirement: string; witness: string; fixtures: string[]; excludes: string[] }[];
};
const rubricIds = rubric.criteria.map(criterion => criterion.id);

test('TQ-01 to TQ-06: the recipe plans every oracle of spec §13 over criteria of the rubric and phases it has, and TR-43 is observed with TQ-06', () => {
  const plan = recipe.plan();
  assert.deepEqual(Object.keys(plan.obligations), ['TQ-01', 'TQ-02', 'TQ-03', 'TQ-04', 'TQ-05', 'TQ-06']);
  assert.deepEqual([...rubricIds].sort(), [...recipe.criterionIds].sort(), 'the recipe assesses exactly the criteria of the rubric');
  const used = new Set<string>();
  for (const [id, obligation] of Object.entries(plan.obligations)) {
    assert.ok(obligation.phases.length > 0, `${id}: no phase observes it`);
    for (const phase of obligation.phases) assert.ok((recipe.phases as readonly string[]).includes(phase), `${id}: phase ${phase}`);
    for (const criterion of obligation.criteria) {
      assert.ok(rubricIds.includes(criterion), `${id}: criterion ${criterion} is not in the rubric`);
      used.add(criterion);
    }
  }
  assert.deepEqual([...used].sort(), [...rubricIds].sort(), 'no criterion of the rubric is left without an oracle');
  assert.ok((plan.obligations['TQ-06'].criteria as readonly string[]).includes('TR-43'));
});

test('TQ rubric: the format docs/agents/experiment-proofs.md asks for; an approval record, when present, is of these exact bytes', () => {
  assert.deepEqual([rubric.schemaVersion, rubric.id, Number.isInteger(rubric.version) && rubric.version >= 1], [1, 'triage-qualification', true]);
  assert.ok(rubric.scope.trim() !== '' && rubricBytes.length <= 65536);
  for (const criterion of rubric.criteria) {
    assert.match(criterion.id, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    assert.ok(['contract', 'auxiliary'].includes(criterion.kind), criterion.id);
    for (const text of [criterion.requirement, criterion.witness, ...criterion.fixtures, ...criterion.excludes]) assert.ok(text.trim() !== '', criterion.id);
    assert.ok(criterion.fixtures.length > 0 && criterion.excludes.length > 0, `${criterion.id}: names its fixtures and what it does not prove`);
  }
  assert.deepEqual(
    rubric.criteria.filter(criterion => criterion.kind === 'auxiliary').map(criterion => criterion.id),
    ['oauth-profile', 'mcp-in-unit', 'jira-comment-limit'],
    'the spec oracles are contractual; what earlier tickets deferred is auxiliary',
  );
  assert.match(rubric.criteria.find(criterion => criterion.id === 'TQ-05-jira')!.excludes.join(' '), /inconclusive, never approved/);
  const approval = join(repository, recipe.rubric.approval);
  if (existsSync(approval)) {
    const record = JSON.parse(readFileSync(approval, 'utf8')) as { rubricSha256: string; approvedBy: string };
    assert.equal(record.rubricSha256, createHash('sha256').update(rubricBytes).digest('hex'), 'the rubric changed after its review');
    assert.ok(record.approvedBy.trim() !== '');
  }
});

test('TQ recipe: what earlier tickets deferred to the real qualification lands on a criterion some oracle judges', () => {
  const plan = recipe.plan();
  assert.deepEqual(Object.keys(plan.deferred), ['#78', '#77', '#75', '#79', '#72/#76']);
  const judged = new Set<string>(Object.values(plan.obligations).flatMap(obligation => [...obligation.criteria]));
  for (const [from, item] of Object.entries(plan.deferred)) {
    assert.ok(item.criteria.length > 0 && item.where.trim() !== '', from);
    for (const criterion of item.criteria) assert.ok(judged.has(criterion), `${from}: ${criterion} is judged under no oracle`);
  }
});
