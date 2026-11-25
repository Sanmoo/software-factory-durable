import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Module-internal seam: the same durable store and commits Control.run uses for Triage requests.
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket } from '../../src/control/durable/admission.js';
import {
  liveTriageRequests,
  readTriageRequest,
  requestTriage,
  ticketTriageRequests,
  transitionTriageRequest,
  triageQueue,
} from '../../src/control/durable/triage-requests.js';
import { ticket } from './doubles.js';

// Spec #68 §4-§5 (ticket #71): the commits of the Triage request document. Later tickets of the spec move a request only through them.
const source = { tracker: 'github' as const, repository: 'acme/project' };
const authorization = { label: 'needs-triage', observedAt: '2026-11-25T00:00:00.000Z', application: { eventId: '11' } };
async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-triage-commits-'));
  const opened = await openStore(join(dir, 'control.sqlite'));
  t.after(async () => {
    await opened.close();
    await rm(dir, { recursive: true, force: true });
  });
  return opened.session;
}

test('TR-02: concurrent requests for one Ticket commit exactly one, and a Ticket with a Work is refused inside the commit', async t => {
  const session = await store(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => requestTriage(session, { ticket: ticket(1), source, after: null, authorization })));
  assert.equal(results.filter(result => result.kind === 'requested').length, 1);
  assert.equal(results.filter(result => result.kind === 'existing').length, 19);
  const others = await Promise.all([2, 3, 4].map(number => requestTriage(session, { ticket: ticket(number), source, after: null, authorization })));
  assert.deepEqual(
    others.map(result => result.kind === 'requested' && result.request.sequence),
    [2, 3, 4],
    'one contiguous arrival sequence for the whole installation',
  );
  await admitTicket(session, {
    ticket: ticket(9),
    repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
    observedAt: '2026-11-25T00:00:00.000Z',
    label: { id: 55, name: 'ready-for-agent' },
    publication: { observedAt: '2026-11-25T00:00:00.000Z', limitations: [] },
  });
  const refused = await requestTriage(session, { ticket: ticket(9), source, after: null, authorization });
  assert.equal(refused.kind, 'work-exists');
  assert.deepEqual(await ticketTriageRequests(session, ticket(9)), []);
});

test('TR-06: a new request needs the evaluated latest request to be terminal and still the latest', async t => {
  const session = await store(t);
  const first = await requestTriage(session, { ticket: ticket(1), source, after: null, authorization });
  assert.equal(first.kind, 'requested');
  if (first.kind !== 'requested') return;
  const id = first.request.triage_request_id;
  assert.equal((await requestTriage(session, { ticket: ticket(1), source, after: id, authorization })).kind, 'existing', 'a live request is the request');
  await transitionTriageRequest(session, id, { from: ['queued'], to: 'abandoned', event: 'abandoned', code: 'NEEDS_TRIAGE_REMOVED' });
  assert.equal(
    (await requestTriage(session, { ticket: ticket(1), source, after: null, authorization })).kind,
    'existing',
    'the caller evaluated an older state',
  );
  const second = await requestTriage(session, { ticket: ticket(1), source, after: id, authorization });
  assert.deepEqual(second.kind === 'requested' && [second.request.ordinal, second.request.previous, second.request.state], [2, [id], 'queued']);
});

test('a transition is revalidated in its commit, keeps the fields it does not own, and leaves the queue and the live set consistent', async t => {
  const session = await store(t);
  const created = await requestTriage(session, { ticket: ticket(1), source, after: null, authorization });
  if (created.kind !== 'requested') return assert.fail('not requested');
  const id = created.request.triage_request_id;
  type Extended = typeof created.request & { spent?: { attempts: number } };

  // A later ticket starts an investigation and writes its own fields in the same commit.
  const started = await transitionTriageRequest(session, id, { from: ['queued'], to: 'investigating', event: 'attempt-started' }, request => {
    (request as Extended).spent = { attempts: 1 };
  });
  assert.equal(started.kind, 'applied');
  assert.deepEqual(await triageQueue(session), [], 'an investigating request left the queue');
  assert.deepEqual(
    await transitionTriageRequest(session, id, { from: ['queued'], to: 'suspended', event: 'suspended' }),
    { kind: 'not-applied', state: 'investigating' },
    'the state the caller evaluated is gone',
  );
  assert.deepEqual(
    await transitionTriageRequest(session, id, { from: ['investigating'], to: 'concluded', event: 'concluded' }),
    { kind: 'not-applied', state: 'investigating' },
    'the transition table refuses a jump',
  );
  // Back to the queue between attempts, suspended by a conflict, queued again: what was spent is still there (spec §5: saldo preservado).
  await transitionTriageRequest(session, id, { from: ['investigating'], to: 'queued', event: 'attempt-ended' });
  await transitionTriageRequest(session, id, { from: ['queued'], to: 'suspended', event: 'suspended', code: 'TRIAGE_LABEL_CONFLICT', labels: ['wontfix'] });
  await transitionTriageRequest(session, id, { from: ['suspended'], to: 'queued', event: 'requeued' });
  const queued = (await readTriageRequest(session, id)) as Extended;
  assert.deepEqual([queued.state, queued.spent, queued.suspension, queued.sequence], ['queued', { attempts: 1 }, null, 1]);
  assert.deepEqual(
    (await triageQueue(session)).map(request => request.triage_request_id),
    [id],
  );

  const ended = await transitionTriageRequest(session, id, { from: ['queued'], to: 'failed', event: 'failed', code: 'TRIAGE_ATTEMPTS_EXHAUSTED' });
  assert.deepEqual(ended.kind === 'applied' && [ended.request.state, ended.request.end?.code], ['failed', 'TRIAGE_ATTEMPTS_EXHAUSTED']);
  assert.deepEqual(await liveTriageRequests(session), []);
  assert.deepEqual(
    await transitionTriageRequest(session, id, { from: ['failed'], to: 'queued', event: 'requeued' }),
    { kind: 'not-applied', state: 'failed' },
    'a terminal request never moves: the way out of failed is a new request',
  );
  assert.deepEqual(await transitionTriageRequest(session, 'no-such-request', { from: ['queued'], to: 'abandoned', event: 'abandoned' }), {
    kind: 'not-applied',
    state: null,
  });
});
