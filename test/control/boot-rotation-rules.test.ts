import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootLoopDecision,
  bootSchedule,
  noProgressCode,
  noProgressImpediment,
  rememberBoot,
  swapNoticePrompt,
  type BootLedgerEntry,
} from '../../src/control/rules/boot-rotation.js';

// v2 ticket 09 (V2-10, V2-12, V2-13, V2-14): pure rules of the planned boot swap and of the limit against loops. The boot clock comes
// from the declared capability only; "published" is the Work branch tip as Control itself read it on `origin`.
const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  c = 'c'.repeat(40);
const tip = (sha: string) => ({ state: 'present' as const, sha });
const boot = (
  n: number,
  end: BootLedgerEntry['end'],
  from: BootLedgerEntry['startTip'],
  to: BootLedgerEntry['endTip'],
  begin: BootLedgerEntry['begin'] = 'start',
): BootLedgerEntry => ({ boot: `boot-${n}`, executionId: `exec-${n}`, begin, end, startTip: from, endTip: to, at: `2026-11-21T10:0${n}:00.000Z` });

test('the boot clock comes from the declared capability: the margin starts at max minus margin, the interruption at half the margin, and the boot ends at max', () => {
  assert.deepEqual(bootSchedule({ maxSeconds: 3600, rotationMarginSeconds: 600 }), { marginAtMs: 3000000, interruptAtMs: 3300000, endAtMs: 3600000 });
  assert.deepEqual(bootSchedule({ maxSeconds: 7200, rotationMarginSeconds: 900 }), { marginAtMs: 6300000, interruptAtMs: 6750000, endAtMs: 7200000 });
});

test('a sandbox that declares no boot duration never rotates', () => {
  assert.equal(bootSchedule(null), null);
  assert.equal(bootSchedule(undefined), null);
});

test('two consecutive boots ended by a swap or a loss with no new commit published during either block the third boot', () => {
  for (const ends of [
    ['planned-swap', 'planned-swap'],
    ['loss', 'loss'],
    ['planned-swap', 'loss'],
    ['loss', 'planned-swap'],
  ] as const) {
    assert.deepEqual(bootLoopDecision([boot(1, ends[0], tip(a), tip(a)), boot(2, ends[1], tip(a), tip(a), 'planned-swap')]), {
      outcome: 'blocked',
      code: noProgressCode,
      boots: ['boot-1', 'boot-2'],
      tip: a,
    });
  }
  // A branch that never existed on origin is no publication either.
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', { state: 'absent' }, { state: 'absent' }), boot(2, 'loss', { state: 'absent' }, { state: 'absent' })]), {
    outcome: 'blocked',
    code: noProgressCode,
    boots: ['boot-1', 'boot-2'],
    tip: null,
  });
});

test('a new commit published during either of the two boots lets the next boot start', () => {
  assert.deepEqual(bootLoopDecision([boot(1, 'planned-swap', tip(a), tip(b)), boot(2, 'planned-swap', tip(b), tip(b), 'planned-swap')]), {
    outcome: 'proceed',
  });
  assert.deepEqual(bootLoopDecision([boot(1, 'planned-swap', tip(a), tip(a)), boot(2, 'loss', tip(a), tip(b), 'planned-swap')]), { outcome: 'proceed' });
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', { state: 'absent' }, { state: 'absent' }), boot(2, 'loss', { state: 'absent' }, tip(a))]), {
    outcome: 'proceed',
  });
  // Only the LAST two count: an older pair without progress is history once a boot published.
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', tip(a), tip(a)), boot(2, 'loss', tip(a), tip(a)), boot(3, 'planned-swap', tip(a), tip(b))]), {
    outcome: 'proceed',
  });
});

test('one boot without progress is not a loop, and neither is none', () => {
  assert.deepEqual(bootLoopDecision([]), { outcome: 'proceed' });
  assert.deepEqual(bootLoopDecision([boot(1, 'planned-swap', tip(a), tip(a))]), { outcome: 'proceed' });
});

test('a boot ended by an ordinary return of control (external wait with the gate accepted, completion, failure) is not counted and breaks the sequence', () => {
  assert.deepEqual(bootLoopDecision([boot(1, 'end', tip(a), tip(a)), boot(2, 'end', tip(a), tip(a))]), { outcome: 'proceed' });
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', tip(a), tip(a)), boot(2, 'end', tip(a), tip(a)), boot(3, 'loss', tip(a), tip(a))]), {
    outcome: 'proceed',
  });
});

test('an origin that could not be read proves nothing: the boot is not counted as one without progress', () => {
  const unknown = { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED' };
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', tip(a), unknown), boot(2, 'loss', tip(a), tip(a))]), { outcome: 'proceed' });
  assert.deepEqual(bootLoopDecision([boot(1, 'loss', tip(a), tip(a)), boot(2, 'loss', unknown, tip(a))]), { outcome: 'proceed' });
});

test('the ledger keeps the boots of the Work in order, one entry per boot, bounded', () => {
  let ledger: BootLedgerEntry[] = [];
  for (let n = 1; n <= 20; n += 1) ledger = rememberBoot(ledger, boot(n, 'end', tip(a), tip(a)));
  assert.equal(ledger.length, 16);
  assert.equal(ledger.at(-1)!.boot, 'boot-20');
  // The same boot recorded again (a retried commit) replaces its entry.
  const again = rememberBoot(ledger, { ...boot(20, 'loss', tip(a), tip(c)) });
  assert.equal(again.length, 16);
  assert.deepEqual([again.at(-1)!.end, again.at(-1)!.endTip], ['loss', tip(c)]);
});

test('the block names the diagnostic, the two boots and the commit that did not move', () => {
  const impediment = noProgressImpediment({ boots: ['boot-1', 'boot-2'], tip: a, branch: 'factory/3-note' }, '2026-11-21T10:00:00.000Z');
  assert.deepEqual([impediment.code, impediment.scope, impediment.since], ['NO_PROGRESS_BETWEEN_BOOTS', 'work', '2026-11-21T10:00:00.000Z']);
  assert.match(impediment.nextStep, /^No progress between boots \(sem progresso entre boots\)/);
  assert.ok(
    impediment.nextStep.includes('boot-1') &&
      impediment.nextStep.includes('boot-2') &&
      impediment.nextStep.includes(a) &&
      impediment.nextStep.includes('factory/3-note'),
  );
  assert.match(impediment.nextStep, /no third boot was started/);
});

test('the swap notice asks the SAME session for the work in progress, names the one push and the time left, and forbids everything else', () => {
  const prompt = swapNoticePrompt({
    branch: 'factory/3-note',
    push: 'git -C /workspace/checkout push https://github.com/acme/project.git HEAD:refs/heads/factory/3-note',
    secondsLeft: 540,
    interrupted: false,
    pullRequest: false,
  });
  assert.match(prompt, /^Factory notice \(planned boot swap\)/);
  assert.ok(prompt.includes('about 540 seconds'));
  assert.ok(prompt.includes('git -C /workspace/checkout push https://github.com/acme/project.git HEAD:refs/heads/factory/3-note'));
  assert.match(prompt, /same session/i);
  assert.match(prompt, /does not authorize committing secrets/);
  assert.match(prompt, /No pull request is needed/);
  assert.doesNotMatch(prompt, /was interrupted/);
});

test('a call the sandbox interrupted at half the margin is told to the session, with the shorter time left', () => {
  const prompt = swapNoticePrompt({ branch: 'factory/3-note', push: 'git push', secondsLeft: 280, interrupted: true, pullRequest: true });
  assert.match(prompt, /The call that was running was interrupted/);
  assert.ok(prompt.includes('about 280 seconds'));
  assert.match(prompt, /Do not open, close or edit pull requests/);
});
