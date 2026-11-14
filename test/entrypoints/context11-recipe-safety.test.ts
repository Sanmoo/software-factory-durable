import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListView } from '../../src/control/index.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lateErrorDecision, newPhaseState, phaseExitCode, precondition, sessionSummary, withTeardown } from './context11-qualification.js';

// Local, effect-free checks of the ticket 11 recipe's fail-closed phase preconditions and its session evidence (delivery vs later turns).
const result = (execution: Record<string, unknown> | null) => ({ final: { works: [{ ticket: { number: 3 }, execution }] } as unknown as ListView });

test('recipe: continue needs a ceased Question end; scope needs a ceased COMPLETED end; anything else is refused before any effect', () => {
  const ended = (outcome: string, cessation = 'confirmed') => ({ state: 'ended', end: { outcome, cessation } });
  assert.equal(precondition('continue', result(ended('question'))), null);
  assert.equal(precondition('continue', result(ended('completed'))), 'CONTINUE_REQUIRES_QUESTION');
  assert.equal(precondition('continue', result(ended('question', 'unconfirmed'))), 'CONTINUE_PREVIOUS_NOT_CEASED');
  assert.equal(precondition('continue', null), 'CONTINUE_PREVIOUS_EXECUTION_MISSING');
  assert.equal(precondition('scope', result(ended('completed'))), null);
  assert.equal(precondition('scope', result(ended('question'))), 'SCOPE_REQUIRES_COMPLETED');
  assert.equal(precondition('scope', result({ state: 'held', end: null })), 'SCOPE_PREVIOUS_NOT_CEASED');
});

test('recipe: the session summary separates the delivered resume message from later model turns and tool calls', () => {
  const line = (value: unknown) => JSON.stringify(value);
  const jsonl = [line({ type: 'session', version: 3, id: 's', cwd: '/workspace' }),
    line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '/implement https://github.com/x/y/issues/3' }] } }),
    line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'ask_user' }] } }),
    line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'continue\nFactory continuation of the SAME session' }] } }),
    line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }, { type: 'toolCall', name: 'write' }] } }),
    line({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }), 'not json'].join('\n');
  const summary = sessionSummary(jsonl);
  assert.deepEqual([summary.messages, summary.resumeMessageIndex, summary.assistantTurnsAfterResume, summary.toolCallsAfterResume, summary.toolCalls],
    [5, 2, 2, ['bash', 'write'], ['ask_user', 'bash', 'write']]);
  const delivered = sessionSummary(jsonl.split('\n').slice(0, 4).join('\n'));
  assert.deepEqual([delivered.resumeMessageIndex, delivered.assistantTurnsAfterResume], [2, 0], 'delivered but not (yet) consumed by any later turn');
  assert.equal(sessionSummary(jsonl.split('\n').slice(0, 3).join('\n')).resumeMessageIndex, -1);
});

test('harness fix: once the phase result is durably saved, a failing teardown is recorded and never fails the phase', async () => {
  const saved = newPhaseState('inspect');
  await withTeardown(saved, async () => { saved.resultSaved = true; }, async () => { throw new Error('STORAGE_COPY_CLOSE_FAILED'); });
  assert.deepEqual(saved.teardown.map(item => [item.stage, item.code]), [['teardown', 'STORAGE_COPY_CLOSE_FAILED']]);
  // Without a saved result the same teardown failure holds the phase.
  const unsaved = newPhaseState('inspect');
  await assert.rejects(withTeardown(unsaved, async () => {}, async () => { throw new Error('LOCK_RELEASE_FAILED'); }), /LOCK_RELEASE_FAILED/);
  // A body failure always propagates (the teardown still runs and is recorded).
  const failing = newPhaseState('scope');
  let tornDown = false;
  await assert.rejects(withTeardown(failing, async () => { throw new Error('PHASE_FAILED'); }, async () => { tornDown = true; }), /PHASE_FAILED/);
  assert.equal(tornDown, true);
  // Exit and late-error decisions depend only on the durable result.
  assert.deepEqual([phaseExitCode(saved, new Error('x')), phaseExitCode(unsaved, new Error('x')), phaseExitCode(unsaved, undefined), phaseExitCode(null, new Error('x'))], [0, 1, 0, 1]);
  assert.deepEqual([lateErrorDecision(saved), lateErrorDecision(unsaved), lateErrorDecision(null)], ['record', 'fail', 'fail']);
});

test('harness fix (process): inspect exits 0 after a complete save despite a failing teardown or a late rejection; 1 before it', () => {
  const fixture = fileURLToPath(new URL('./context11-exit-fixture.js', import.meta.url));
  const run = (mode: string) => spawnSync(process.execPath, [fixture, 'inspect'], { encoding: 'utf8', timeout: 20000,
    env: { PATH: '', LANG: 'C', NODE_DISABLE_COMPILE_CACHE: '1', CONTEXT11_EXIT_MODE: mode } });
  const teardown = run('saved-then-failing-teardown');
  assert.equal(teardown.status, 0, teardown.stderr);
  const late = run('saved-then-late-rejection');
  assert.equal(late.status, 0, late.stderr);
  assert.deepEqual(late.stdout.trim().split('\n').map(line => JSON.parse(line)), [{ late: 'LATE_SESSION_REJECTION', phase: 'inspect' }], 'the late error is recorded');
  const failed = run('error-before-save');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Qualification held; no retry\./);
  const early = run('late-rejection-before-save');
  assert.equal(early.status, 1, 'a late error before the result is saved fails closed at once');
  assert.equal(early.stdout, '');
});
