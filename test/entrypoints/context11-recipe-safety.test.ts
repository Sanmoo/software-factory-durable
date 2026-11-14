import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ListView } from '../../src/control/index.js';
import { precondition, sessionSummary } from './context11-qualification.js';

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
