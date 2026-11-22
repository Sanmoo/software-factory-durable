import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verdictOf } from './repair22-qualification.js';

// The ticket 22 real-run verdict, computed from the SAVED results of q22-repair-v1 (docs/evidence copies; read-only, no GitHub), and its
// sensitivity: each expectation fails when its observation is altered.
const load = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/evidence/22-real-repair-${name}-2026-11-16.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const saved = () => ({ advance: load('advance-result'), conflict: load('conflict-result'), inspect: load('inspect-result'), human2: load('human-step-2-observed') });
type Inspect = { work: { corrections: unknown[]; publication: { divergences: unknown[] } };
  executions: { request: { publication?: { expectedRemote?: unknown } } }[] };
const failing = (input: ReturnType<typeof saved>) => verdictOf(input).checks.filter(item => !item.met).map(item => item.id);

test('q22-repair-v1: every plan expectation is met by the saved results', () => {
  const verdict = verdictOf(saved());
  assert.deepEqual(failing(saved()), []);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.checks.length, 9);
});

test('the verdict fails on a second correction, a re-trigger, a rebase over human commits, a wrong lease and a base advance that triggered', () => {
  let input = saved();
  const inspect = input.inspect as Inspect;
  inspect.work.corrections = [...inspect.work.corrections, inspect.work.corrections[0]];
  assert.ok(failing(input).includes('conflict.one-correction'));
  input = saved();
  (input.conflict as { events: unknown[] }).events.push({ call: 'activate', at: '2099-01-01T00:00:00.000Z', context: { role: 'builder', phaseId: 'builder-continuation', executionId: 'x' } });
  assert.ok(failing(input).includes('no-retrigger'));
  input = saved();
  (input.inspect as Inspect).work.publication.divergences = [{ current: '1'.repeat(40) }];
  assert.ok(failing(input).includes('conflict.strategy'), 'with a human commit on the branch a rebase (no merge commit) is a failure');
  input = saved();
  const publication = (input.inspect as Inspect).executions.filter(item => item.request.publication).at(-1)!;
  publication.request.publication!.expectedRemote = { state: 'present', sha: '2'.repeat(40) };
  assert.ok(failing(input).includes('conflict.same-pr-leased'));
  input = saved();
  (input.advance as { final: { works: { correction?: unknown }[] } }).final.works[0]!.correction = { correctionId: 'c' };
  assert.ok(failing(input).includes('advance.no-correction'));
});
