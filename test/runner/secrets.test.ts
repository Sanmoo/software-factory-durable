import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchSecrets, parseTolerance, readGitleaks } from '../../scripts/test-runner/secrets.ts';

const commit = 'a'.repeat(40),
  other = 'b'.repeat(40);
const finding = { commit, file: 'test/x.ts', rule: 'generic-api-key', line: 3, column: 9 };
const entry = { ...finding, decision: 'synthetic fixture' };
const all = () => true;

test('a tolerated finding at its identity passes; a finding with no entry fails at its location', () => {
  assert.deepEqual(matchSecrets([finding], [entry], all), []);
  assert.deepEqual(matchSecrets([finding, { ...finding, column: 40 }], [entry], all), [
    { rule: 'generic-api-key', location: 'test/x.ts:3:40 (commit aaaaaaaaaaaa)' },
  ]);
  assert.deepEqual(
    matchSecrets([{ ...finding, commit: 'working-tree' }], [entry], all).map(f => f.location),
    ['test/x.ts:3:9 (commit aaaaaaaaaaaa)', 'test/x.ts:3:9 (working tree)'],
    'a new occurrence elsewhere does not reuse the entry, and the entry is then stale',
  );
});

test('two findings under one entry fail, and a vanished finding leaves its entry stale only where the scan covered its commit', () => {
  assert.deepEqual(matchSecrets([finding, finding], [entry], all), [
    { rule: 'generic-api-key:several-findings-one-entry', location: 'test/x.ts:3:9 (commit aaaaaaaaaaaa)' },
  ]);
  assert.deepEqual(matchSecrets([], [entry], all), [{ rule: 'generic-api-key:stale-entry', location: 'test/x.ts:3:9 (commit aaaaaaaaaaaa)' }]);
  assert.deepEqual(
    matchSecrets([], [entry], sha => sha === other),
    [],
    'outside the analyzed history the entry is not stale',
  );
});

test('the policy requires the full commit and the explicit decision for every entry', () => {
  assert.throws(() => parseTolerance({ entries: [{ ...entry, decision: ' ' }] }), /explicit decision/);
  assert.throws(() => parseTolerance({ entries: [{ ...entry, commit: 'abc' }] }), /40-character commit/);
  assert.equal(parseTolerance({ entries: [entry] }).length, 1);
});

test('gitleaks reports: git mode carries the commit, dir mode is the working tree; anything else is refused', () => {
  const report = JSON.stringify([{ RuleID: 'jwt', File: 'a.ts', StartLine: 1, StartColumn: 2, Commit: commit }]);
  assert.deepEqual(readGitleaks(report, false), [{ commit, file: 'a.ts', rule: 'jwt', line: 1, column: 2 }]);
  assert.equal(readGitleaks(report, true)[0]!.commit, 'working-tree');
  assert.throws(() => readGitleaks('{}', false), /not a gitleaks JSON report/);
});
