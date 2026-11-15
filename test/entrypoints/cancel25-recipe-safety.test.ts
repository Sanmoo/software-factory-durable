import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghAllowed, ghGuardScript, keySource, phaseGuard, requireKeySource, runVerdict, syntheticTicket, ticketMatches } from './cancel25-qualification.js';
import type { WorkView } from '../../src/control/index.js';

// Recipe safety on controlled data only (never the real root, never a real gh, never a real issue).
test('phase guard: pinned ticket required; each phase once; run after a successful preflight; new only after a ceased cancellation', () => {
  const none = new Set<string>();
  assert.equal(phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('inspect', {}, none, false), 'PREFLIGHT_SUCCESS_REQUIRED', 'inspect needs no pin but a successful preflight');
  assert.equal(phaseGuard('preflight', {}, none, true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('run', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('run', { preflight: { status: 'success' } }, none, true), null);
  assert.equal(phaseGuard('new', { preflight: { status: 'success' }, run: { cancellation: 'stopping' } }, none, true), 'RUN_CANCELLATION_NOT_CEASED');
  assert.equal(phaseGuard('new', { preflight: { status: 'success' }, run: { cancellation: 'ceased' } }, none, true), null);
  assert.equal(phaseGuard('new', { preflight: { status: 'success' }, run: { cancellation: 'ceased' } }, new Set(['new-intent']), true), 'PHASE_ALREADY_RAN');
});

test('gh guard: only GET without input and the token self-revocation pass; the wrapper embeds that exact decision', () => {
  assert.equal(ghAllowed('GET', '/repos/a/b/issues/9', false), true);
  assert.equal(ghAllowed('GET', '/graphql', true), false);
  assert.equal(ghAllowed('DELETE', '/installation/token', false), true);
  for (const [method, endpoint] of [['DELETE', '/repos/a/b/git/refs/heads/x'], ['POST', 'graphql'], ['POST', '/repos/a/b/issues/9/comments'], ['PATCH', '/repos/a/b/pulls/1'], ['PUT', '/repos/a/b/pulls/1/merge'], [null, '/x']] as const) {
    assert.equal(ghAllowed(method, endpoint, false), false, `${method} ${endpoint}`);
  }
  const script = ghGuardScript({ node: '/n', gh: '/g', trace: '/t' });
  assert.ok(script.includes(ghAllowed.toString()));
  assert.match(script, /process\.exit\(97\)/);
});

test('ticket match: identity, open, label, exact title and body (CRLF tolerated)', () => {
  const ok = { number: syntheticTicket.number, repositoryId: 1256893534, state: 'open', title: syntheticTicket.title, body: syntheticTicket.body.replaceAll('\n', '\r\n'), labels: [{ name: 'ready-for-agent' }] };
  assert.deepEqual(ticketMatches(ok), []);
  assert.deepEqual(ticketMatches({ ...ok, number: 999, state: 'closed', labels: [], title: 'x', body: null }), ['TICKET_IDENTITY', 'TICKET_NOT_OPEN', 'LABEL_ABSENT', 'TITLE_MISMATCH', 'BODY_MISMATCH']);
});

test('run verdict: success only with withdrawal and cancel during the activity, credentials withdrawn before the stop and Slot after confirmed cessation', () => {
  const work = { result: 'cancelled', cancellation: { state: 'ceased' }, history: [{ event: 'authorization-withdrawn' }, { event: 'authorization-restored-observed' }],
    execution: { credentialLifecycle: { reason: 'cancelled' }, end: { outcome: 'stopped', code: 'WORK_CANCELLED', cessation: 'confirmed' }, slot: { held: false } } } as unknown as WorkView;
  const events = [{ call: 'activate' }, { call: 'withdrawal-observed', executionState: 'started' }, { call: 'cancel-accepted', executionState: 'started' },
    { call: 'deliver-withdraw-credential' }, { call: 'activity-aborted' }, { call: 'stop' }];
  assert.deepEqual(runVerdict(work, events), { status: 'success', reasons: [] });
  assert.deepEqual(runVerdict(undefined, events), { status: 'held', reasons: ['WORK_NOT_FOUND'] });
  const late = [{ call: 'activate' }, { call: 'withdrawal-observed', executionState: 'ended' }, { call: 'cancel-accepted', executionState: 'ended' }, { call: 'stop' }, { call: 'deliver-withdraw-credential' }];
  assert.deepEqual(runVerdict({ ...work, execution: { ...work.execution!, slot: { held: true } } } as WorkView, late).reasons,
    ['WITHDRAWAL_NOT_DURING_ACTIVITY', 'CANCEL_NOT_DURING_ACTIVITY', 'SLOT_NOT_RELEASED_AFTER_CESSATION', 'WITHDRAWAL_NOT_BEFORE_STOP']);
});

test('a missing App key source fails loudly with its path before any effect', async () => {
  const asked: string[] = [];
  await assert.rejects(requireKeySource(async path => { asked.push(path); throw new Error('ENOENT'); }),
    (error: Error) => error.message.startsWith('APP_KEY_SOURCE_MISSING: /home/sanmoo/software-factory-test/y5/credentials/app.pem is absent') && /nothing was created/.test(error.message));
  assert.deepEqual(asked, [keySource]);
});
