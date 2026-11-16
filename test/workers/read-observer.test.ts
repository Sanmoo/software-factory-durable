import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadObserver } from '../../src/workers/review.js';

// Real run q21-human-v8: the Spec reviewer read every required input in full with `offset: 1, limit: 2000` (each file ended inside that window,
// so the SDK returned it whole with no truncation and no "more lines" notice); the Host counted none as fully read and downgraded a clean
// opinion to incomplete (REQUIRED_INPUT_NOT_FULLY_READ) in three rounds.
test('a limited read that reaches the end of the file is a full read; a limited read cut by the limit is not, until continued', () => {
  const observer = createReadObserver();
  const text = (value: string) => ({ details: undefined, content: [{ type: 'text', text: value }] });
  observer.observe({ path: '/artifacts/review/r7/index.json', offset: 1, limit: 2000 }, text('{\n "base": "9cf5"\n}'));
  observer.observe({ path: '/workspace/checkout/docs/A.md', offset: 1, limit: 2 }, text('line 1\nline 2\n\n[3 more lines in file. Use offset=3 to continue.]'));
  observer.observe({ path: '/workspace/checkout/docs/B.md', offset: 1, limit: 2 }, text('line 1\nline 2\n\n[3 more lines in file. Use offset=3 to continue.]'));
  observer.observe({ path: '/workspace/checkout/docs/B.md', offset: 3, limit: 2000 }, text('line 3\nline 4\nline 5'));
  observer.observe({ path: '/workspace/checkout/docs/C.md', offset: 1, limit: 2000 }, { details: { truncation: { truncated: true, outputLines: 40 } }, content: [{ type: 'text', text: 'x' }] });
  assert.deepEqual(observer.summary(['/artifacts/review/r7/index.json', '/workspace/checkout/docs/A.md', '/workspace/checkout/docs/B.md', '/workspace/checkout/docs/C.md']).requiredNotFullyRead,
    ['/workspace/checkout/docs/A.md', '/workspace/checkout/docs/C.md']);
  const skipped = createReadObserver();
  skipped.observe({ path: '/workspace/checkout/docs/D.md', offset: 5, limit: 10 }, text('tail'));
  assert.deepEqual(skipped.summary(['/workspace/checkout/docs/D.md']).requiredNotFullyRead, ['/workspace/checkout/docs/D.md'], 'reading only a later window is never full');
});
