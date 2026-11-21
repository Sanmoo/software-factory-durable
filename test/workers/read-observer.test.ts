import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeOpinion, createReadObserver } from '../../src/workers/review.js';

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
  observer.observe(
    { path: '/workspace/checkout/docs/C.md', offset: 1, limit: 2000 },
    { details: { truncation: { truncated: true, outputLines: 40 } }, content: [{ type: 'text', text: 'x' }] },
  );
  assert.deepEqual(
    observer.summary(['/artifacts/review/r7/index.json', '/workspace/checkout/docs/A.md', '/workspace/checkout/docs/B.md', '/workspace/checkout/docs/C.md'])
      .requiredNotFullyRead,
    ['/workspace/checkout/docs/A.md', '/workspace/checkout/docs/C.md'],
  );
  const skipped = createReadObserver();
  skipped.observe({ path: '/workspace/checkout/docs/D.md', offset: 5, limit: 10 }, text('tail'));
  assert.deepEqual(
    skipped.summary(['/workspace/checkout/docs/D.md']).requiredNotFullyRead,
    ['/workspace/checkout/docs/D.md'],
    'reading only a later window is never full',
  );
});

// Ticket 51 (pilot 35, #124 rounds 1 and 4): the Spec reviewer read the index, the patch and every changed file IN FULL, then asked for windows
// past their end; the SDK answered "Offset 401 is beyond end of file (259 lines total)" and the Host counted each as an unreadable source
// (SOURCE_UNREADABLE), downgrading a clean opinion to incomplete.
const beyond = (offset: number, lines: number) => ({ error: new Error(`Offset ${offset} is beyond end of file (${lines} lines total)`) });
const text = (value: string) => ({ details: undefined, content: [{ type: 'text', text: value }] });

test('ticket 51: a read past the end of a file already read to its last line is not a failed read', () => {
  const observer = createReadObserver();
  observer.observe({ path: '/workspace/checkout/src/Account.java' }, text('class Account {}'));
  observer.observe({ path: '/workspace/checkout/src/Account.java', offset: 401, limit: 200 }, beyond(401, 259));
  observer.observe({ path: '/artifacts/review/r1/committed.patch', offset: 1, limit: 2000 }, text('diff --git a/x b/x'));
  observer.observe({ path: '/artifacts/review/r1/committed.patch', offset: 2001 }, beyond(2001, 1712));
  // The order does not matter: the full read may come after the probe past the end.
  observer.observe({ path: '/workspace/checkout/src/Lock.java', offset: 300 }, beyond(300, 120));
  observer.observe({ path: '/workspace/checkout/src/Lock.java' }, text('class Lock {}'));
  const summary = observer.summary(['/workspace/checkout/src/Account.java', '/artifacts/review/r1/committed.patch']);
  assert.deepEqual([summary.reads, summary.failedReads, summary.requiredNotFullyRead], [6, [], []]);
});

test('ticket 51: a read past the end of a file NOT read to its end, and any other failed read, stay failed reads naming path and offset', () => {
  const observer = createReadObserver();
  // Only a window was read (truncated output): the file was not read to its last line.
  observer.observe(
    { path: '/workspace/checkout/src/Big.java' },
    { details: { truncation: { truncated: true, outputLines: 2000 } }, content: [{ type: 'text', text: 'x' }] },
  );
  observer.observe({ path: '/workspace/checkout/src/Big.java', offset: 2600 }, beyond(2600, 2400));
  // Never read at all.
  observer.observe({ path: 'src/Other.java', offset: 401 }, beyond(401, 259));
  // A genuinely failed read (guest failure code), with and without an offset.
  observer.observe({ path: '/workspace/checkout/src/Gone.java', offset: 10 }, { error: new Error('GUEST_READ_FAILED') });
  observer.observe({ path: '/workspace/checkout/src/Denied.java' }, { error: new Error('READ_PATH_DENIED') });
  assert.deepEqual(observer.summary([]).failedReads, [
    { path: '/workspace/checkout/src/Gone.java', code: 'GUEST_READ_FAILED', offset: 10 },
    { path: '/workspace/checkout/src/Denied.java', code: 'READ_PATH_DENIED' },
    { path: '/workspace/checkout/src/Big.java', code: 'READ_BEYOND_END', offset: 2600 },
    { path: '/workspace/src/Other.java', code: 'READ_BEYOND_END', offset: 401 },
  ]);
});

test('ticket 51: the pilot case concludes clean; a genuinely failed read still downgrades it, and the opinion names the path and offset', () => {
  const opinion = (observer: ReturnType<typeof createReadObserver>) =>
    composeOpinion({
      role: 'spec',
      invocationId: 'spec-x',
      status: 'completed',
      sessionFile: null,
      finalText: JSON.stringify({
        role: 'spec',
        conclusion: 'clean',
        coverage: { scope: 'broad', justification: 'all read', examined: ['/workspace/checkout/src/Account.java'] },
        findings: [],
        limitations: [],
      }),
      review: { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: ['/workspace/checkout/src/Account.java'], missing: [] },
      model: { providerId: 'openai', modelId: 'gpt-6-luna' },
      profile: { id: 'p', modelBudget: 'reviewer-v1' },
      host: observer.summary(['/workspace/checkout/src/Account.java']),
    });
  const pilot = createReadObserver();
  pilot.observe({ path: '/workspace/checkout/src/Account.java', offset: 1, limit: 2000 }, text('class Account {}'));
  pilot.observe({ path: '/workspace/checkout/src/Account.java', offset: 401 }, beyond(401, 259));
  const clean = opinion(pilot);
  assert.deepEqual([clean.conclusion, clean.hostChecks.downgraded, clean.hostChecks.failedReads], ['clean', [], []]);
  const failing = createReadObserver();
  failing.observe({ path: '/workspace/checkout/src/Account.java', offset: 1, limit: 2000 }, text('class Account {}'));
  failing.observe({ path: '/workspace/checkout/src/Lock.java', offset: 401 }, { error: new Error('GUEST_READ_FAILED') });
  const downgraded = opinion(failing);
  assert.deepEqual(
    [downgraded.conclusion, downgraded.hostChecks.downgraded, downgraded.hostChecks.failedReads],
    ['incomplete', ['SOURCE_UNREADABLE'], [{ path: '/workspace/checkout/src/Lock.java', code: 'GUEST_READ_FAILED', offset: 401 }]],
  );
});
