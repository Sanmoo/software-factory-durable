import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avoidedTerms, findAvoided, words } from '../../scripts/test-runner/avoided-terms.ts';

test('the avoided terms are read from GLOSSARY.md _Avoid_ lines', () => {
  assert.deepEqual(avoidedTerms('**Work**:\nx\n_Avoid_: job\n\n**Slot**:\ny\n_Avoid_: Seat, lane\n'), ['job', 'lane', 'seat']);
});

test('identifiers split on camelCase, snake_case and kebab-case boundaries', () => {
  assert.deepEqual(words('pendingJobQueue'), ['pending', 'job', 'queue']);
  assert.deepEqual(words('MAX_JOB_COUNT'), ['max', 'job', 'count']);
  assert.deepEqual(words('HTTPJob'), ['http', 'job']);
});

test('only identifiers count: comments and strings may say the word; a word merely containing it is not a match', () => {
  const text = "// queues a job\nconst label = 'job';\nconst jobber = 1;\nfunction nextJob() {}\nclass X { #seatCount = 0 }\n";
  assert.deepEqual(findAvoided('src/a.ts', text, ['job', 'seat']), [
    { rule: 'avoided:job', location: 'src/a.ts:4 nextJob' },
    { rule: 'avoided:seat', location: 'src/a.ts:5 #seatCount' },
  ]);
});
