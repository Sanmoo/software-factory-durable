import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type {
  SourceTriage,
  TicketSource,
  TriageDetailView,
  TriageInterventionReceipt,
  TriageRequest,
  TriagesView,
  TriageStatusView,
} from '../../src/control/index.js';
import type { TriageWrite } from '../../src/issue-tracker/index.js';
import { applyLabel, closeIssue, remoteIssue, removeLabel, type Remote, type RemoteIssue } from '../control/doubles.js';
import { card, jiraSource, relabel } from '../control/jira-doubles.js';
import { call, hang, trackerWrites, triageWorld } from '../control/triage-investigation-fixture.js';
import { until } from '../runner/budget.js';
import { operator, type CliResult } from './triage-cli-fixture.js';

// Spec #68 §10 (ticket #81): the operator's interventions on a Triage request, through the REAL CLI process over the controller socket.
// The Control is the real one (SQLite, Triager session under a scripted provider, the in-process Investigation Environment, whose
// observations the test sets); the trackers are the doubles.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const source: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
function triageIssue(number: number): RemoteIssue {
  const issue = remoteIssue(number, { labels: [], title: 'Total errado', body: 'O total ignora o cupom.' });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const conclude = () => call('concluir_triagem', { outcome: 'needs-info', category: 'bug', text: 'Observado: o total ignora o cupom.' });
type World = Awaited<ReturnType<typeof triageWorld>>;
type Receipt = TriageInterventionReceipt;
const receiptOf = (result: CliResult) => result.json as Receipt;
const summary = (result: CliResult) => {
  const { outcome, reason, state, endCode } = receiptOf(result);
  return [result.code, outcome, reason, state, endCode];
};
const names = (issue: RemoteIssue) => issue.labels.map(label => label.name).sort();
const triageWrites = (w: World) => w.github.calls.filter(item => item.method === 'writeTriage').map(item => (item.args as { write: TriageWrite }).write.kind);
const effectLines = (effects: Receipt['effects']) => ({
  published: effects!.published.map(effect => [effect.kind, effect.status]),
  discarded: effects!.discarded.map(effect => [effect.kind, effect.status, effect.attempted]),
});
const pause = (w: World, operation: 'pause' | 'unpause') => w.control().accept({ request_id: randomUUID(), operation, origin: 'local-cli' });
const listed = async (cli: Awaited<ReturnType<typeof operator>>) => (await cli('triages')).json as TriagesView;
const detailOf = async (cli: Awaited<ReturnType<typeof operator>>, id: string) => (await cli('triage', id)).json as TriageDetailView;

test('TR-48: `triage cancel` ends a queued, a suspended and an investigating request as abandoned with CANCELLED_BY_OPERATOR, writes nothing to the Ticket, and frees the capacity only once the stop is confirmed', async t => {
  const issues = [triageIssue(7), triageIssue(9), triageIssue(10)];
  const w = await triageWorld(t, { github: { issues, pulls: {} }, sources: [source], script: [() => hang, () => hang] });
  await w.start();
  await until('the first request to be investigated', async () => ((await w.requests())[0]?.state === 'investigating' ? true : undefined));
  applyLabel(issues[2]!, 'wontfix');
  await w.poll();
  const [first, second, third] = (await w.requests()) as [TriageRequest, TriageRequest, TriageRequest];
  assert.deepEqual([first.state, second.state, third.state], ['investigating', 'queued', 'suspended']);
  // TR-54 (§10 "Instalação pausada"): a paused installation still cancels.
  await pause(w, 'pause');
  const cli = await operator(t, w);

  // Queued, named by its Ticket reference; the same identity and content returns the recorded receipt, other content is a conflict.
  const queued = await cli('triage', 'cancel', 'acme/project#9', '--request-id', 'cancel-9');
  assert.deepEqual(summary(queued), [0, 'accepted', null, 'abandoned', 'CANCELLED_BY_OPERATOR'], queued.stdout + queued.stderr);
  assert.match(queued.stderr, /REQUEST_IDENTIFIED.*cancel-9/);
  assert.deepEqual(
    [receiptOf(queued).triage_request_id, receiptOf(queued).request, receiptOf(queued).effects, receiptOf(queued).attempt],
    [second.triage_request_id, 'acme/project#9', null, null],
  );
  assert.match(receiptOf(queued).nextStep, /remove and reapply/);
  const repeated = await cli('triage', 'cancel', 'acme/project#9', '--request-id', 'cancel-9');
  assert.deepEqual([repeated.code, repeated.json], [0, queued.json], 'the same identity and content: the recorded receipt');
  const conflict = await cli('triage', 'cancel', third.triage_request_id, '--request-id', 'cancel-9');
  assert.deepEqual([conflict.code, conflict.json], [2, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' }]);
  assert.equal((await w.requests())[2]!.state, 'suspended', 'a conflicting identity changes nothing');

  const suspended = await cli('triage', 'cancel', third.triage_request_id);
  assert.deepEqual(summary(suspended), [0, 'accepted', null, 'abandoned', 'CANCELLED_BY_OPERATOR']);

  // Under investigation: the intent is recorded, then the Triager is stopped. The stop is not confirmed: the unit stays held.
  w.environment.controls.withholdStopConfirmation();
  const attempt = first.attempts![0]!.attempt;
  const investigating = await cli('triage', 'cancel', first.triage_request_id);
  assert.deepEqual(summary(investigating), [0, 'accepted', null, 'abandoned', 'CANCELLED_BY_OPERATOR']);
  assert.equal(receiptOf(investigating).attempt, attempt);
  assert.match(receiptOf(investigating).nextStep, /only once the stop is confirmed/);
  const interrupted = await w.settled(0, 'abandoned');
  assert.deepEqual(
    [interrupted.attempts![0]!.end!.code, interrupted.attempts![0]!.end!.cessation.cessationConfirmed],
    ['CANCELLED_BY_OPERATOR', false],
    'the attempt ended by the cancellation, its stop unconfirmed',
  );
  const held = await listed(cli);
  assert.deepEqual(held.capacity, { configured: 1, investigating: 0, retained: 1 }, 'the capacity is not free without a confirmed stop');
  assert.deepEqual(
    held.impediments.map(item => [item.code, item.ref, item.triage_request_id]),
    [['TRIAGE_CAPACITY_RETAINED', attempt, first.triage_request_id]],
  );
  w.environment.controls.releaseStopConfirmation();
  await w.poll();
  assert.deepEqual((await listed(cli)).capacity, { configured: 1, investigating: 0, retained: 0 }, 'the confirmed stop frees it');

  // A request already over is not cancelled again.
  const again = await cli('triage', 'cancel', first.triage_request_id);
  assert.deepEqual(summary(again), [2, 'not-applied', 'TRIAGE_REQUEST_ALREADY_ENDED', 'abandoned', 'CANCELLED_BY_OPERATOR']);
  assert.deepEqual(summary(await cli('triage', 'cancel', 'acme/project#404')), [2, 'not-applied', 'TRIAGE_REQUEST_NOT_FOUND', null, null]);

  // Nothing was written to any Ticket, and needs-triage standing there requests nothing: only a new application does.
  await pause(w, 'unpause');
  removeLabel(issues[2]!, 'wontfix');
  await w.poll();
  await w.poll();
  assert.deepEqual(trackerWrites(w.github.calls.map(item => item.method)), []);
  assert.deepEqual(issues.map(names), [['needs-triage'], ['needs-triage'], ['needs-triage']]);
  assert.deepEqual(
    (await w.requests()).map(request => [request.state, request.end?.code]),
    [
      ['abandoned', 'CANCELLED_BY_OPERATOR'],
      ['abandoned', 'CANCELLED_BY_OPERATOR'],
      ['abandoned', 'CANCELLED_BY_OPERATOR'],
    ],
    'the standing label recreates no request',
  );
  const status = (await cli('status')).json as { triage: TriageStatusView };
  assert.deepEqual([status.triage.states.abandoned, status.triage.intervention.requests], [3, 0]);
  removeLabel(issues[1]!, 'needs-triage');
  await w.poll();
  applyLabel(issues[1]!, 'needs-triage');
  await w.poll();
  const requests = await w.requests();
  assert.deepEqual(
    [requests.length, requests[3]!.ticket.url, requests[3]!.previous],
    [4, second.ticket.url, [second.triage_request_id]],
    'removed and reapplied: a new request',
  );
  for (const bad of [
    ['triage', 'cancel'],
    ['triage', 'cancel', 'not a reference'],
    ['triage', 'cancel', first.triage_request_id, '--reason', 'x'],
  ])
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
});

/** A world whose first request is `publishing`, stopped by an ambiguous-authorship Impediment after the comment and the outcome label. */
async function impeded(t: Parameters<typeof triageWorld>[0], remote: Partial<Remote> = {}) {
  const issue = triageIssue(7);
  const w = await triageWorld(t, {
    // The second write (the outcome label) lands without an attributable author.
    github: { issues: [issue], pulls: {}, triageWrites: [undefined, 'anonymous'], ...remote },
    sources: [source],
    script: [() => conclude()],
  });
  await w.start();
  assert.equal((await w.investigated(0)).state, 'publishing');
  await w.poll();
  const [request] = (await w.requests()) as [TriageRequest];
  const impediment = request.publication!.impediment!;
  assert.deepEqual([impediment.code, impediment.effects, triageWrites(w)], ['TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS', [1], ['comment', 'add-label']]);
  return { w, issue, request, ref: impediment.ref, id: request.triage_request_id, cli: await operator(t, w) };
}

test('TR-48: `triage cancel` of a request in publishing writes nothing more and its receipt lists the effects published and discarded', async t => {
  const { w, issue, id, cli } = await impeded(t);
  await pause(w, 'pause');
  const cancelled = await cli('triage', 'cancel', id, '--request-id', 'cancel-publishing');
  assert.deepEqual(summary(cancelled), [0, 'accepted', null, 'abandoned', 'CANCELLED_BY_OPERATOR'], cancelled.stdout + cancelled.stderr);
  assert.deepEqual(effectLines(receiptOf(cancelled).effects), {
    published: [['comment', 'confirmed']],
    discarded: [
      ['add-label', 'ambiguous-authorship', true],
      ['remove-label', 'pending', false],
    ],
  });
  assert.equal(receiptOf(cancelled).effects!.published[0]!.reference, w.remote.comments![7]![0]!.url, 'the published Verdict stays as its link');
  assert.equal(receiptOf(cancelled).impediment, null);
  assert.deepEqual((await cli('triage', 'cancel', id, '--request-id', 'cancel-publishing')).json, cancelled.json);
  await pause(w, 'unpause');
  await w.poll();
  await w.poll();
  assert.deepEqual(triageWrites(w), ['comment', 'add-label'], 'nothing more is written');
  assert.deepEqual(names(issue), ['needs-info', 'needs-triage']);
  const detail = await detailOf(cli, id);
  assert.deepEqual([detail.request.state, detail.request.endCode, detail.impediments], ['abandoned', 'CANCELLED_BY_OPERATOR', []]);
  assert.equal(detail.request.timeline.at(-1)!.event, 'cancelled');
  assert.equal((await w.requests()).length, 1);
});

test('TR-49: `triage release` demands the exact attempt, refuses against a Triager observed alive, and with no observation possible records the attestation with author, reason and instant', async t => {
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7)], pulls: {} },
    sources: [source],
    script: [() => 'I could not decide.', () => conclude()],
  });
  // The stop of the first attempt is not confirmed: the request is back in the queue and its unit stays retained.
  w.environment.controls.withholdStopConfirmation();
  await w.start();
  const retained = await w.investigated(0);
  const id = retained.triage_request_id;
  const attempt = retained.attempts![0]!.attempt;
  assert.deepEqual([retained.state, retained.attempts![0]!.end!.cessation.cessationConfirmed], ['queued', false]);
  await pause(w, 'pause');
  const cli = await operator(t, w);
  const impediment = (await listed(cli)).impediments[0]!;
  assert.deepEqual([impediment.code, impediment.ref], ['TRIAGE_CAPACITY_RETAINED', attempt]);
  assert.ok(impediment.nextStep.includes(`factory triage release ${id} --attempt ${attempt} --reason`));
  const release = (reference: string, ...flags: string[]) => cli('triage', 'release', reference, ...flags);

  const wrong = await release(id, '--attempt', 't9-9-0badc0de', '--reason', 'the unit is gone');
  assert.deepEqual(summary(wrong), [2, 'not-applied', 'TRIAGE_ATTEMPT_NOT_FOUND', 'queued', null]);
  // Evidence of life (processes left in the attempt's group): the operator's word does not free the unit.
  const alive = await release(id, '--attempt', attempt, '--reason', 'the unit is gone');
  assert.deepEqual(summary(alive), [2, 'not-applied', 'TRIAGE_ATTEMPT_ALIVE', 'queued', null], alive.stdout + alive.stderr);
  assert.deepEqual((await listed(cli)).capacity, { configured: 1, investigating: 0, retained: 1 }, 'never released against evidence of life');
  for (const bad of [
    ['--attempt', attempt],
    ['--reason', 'no attempt'],
    ['--attempt', 'Not An Attempt', '--reason', 'x'],
  ])
    assert.equal((await release(id, ...bad)).code, 2, bad.join(' '));

  // The manager does not answer: nothing can be observed, and the attestation is taken, by Ticket reference, while paused.
  w.environment.controls.managerAnswers(false);
  const attested = await release('acme/project#7', '--attempt', attempt, '--reason', 'host rebuilt, the unit cannot exist', '--request-id', 'release-1');
  assert.deepEqual(summary(attested), [0, 'accepted', null, 'queued', null], attested.stdout + attested.stderr);
  const { release: how } = receiptOf(attested);
  assert.deepEqual(
    [receiptOf(attested).attempt, how!.basis, how!.observed, how!.author],
    [attempt, 'operator-attestation', 'INVESTIGATION_MANAGER_UNAVAILABLE', 'local-operator'],
  );
  assert.ok(!Number.isNaN(Date.parse(how!.at)), 'the instant of the attestation');
  const detail = await detailOf(cli, id);
  assert.deepEqual(detail.request.timeline.at(-1), {
    at: how!.at,
    event: 'capacity-released',
    code: 'OPERATOR_ATTESTATION',
    attempt,
    author: 'local-operator',
    reason: 'host rebuilt, the unit cannot exist',
  });
  const [record] = detail.request.attemptRecords;
  assert.deepEqual(
    [record!.capacity, record!.stop!.confirmed, record!.attestation],
    ['released', false, { author: 'local-operator', reason: 'host rebuilt, the unit cannot exist', at: how!.at }],
  );
  assert.deepEqual([detail.impediments, (await listed(cli)).capacity], [[], { configured: 1, investigating: 0, retained: 0 }]);
  assert.deepEqual(
    (await release('acme/project#7', '--attempt', attempt, '--reason', 'host rebuilt, the unit cannot exist', '--request-id', 'release-1')).json,
    attested.json,
  );
  const other = await release(id, '--attempt', attempt, '--reason', 'another reason', '--request-id', 'release-1');
  assert.deepEqual(other.json, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual(summary(await release(id, '--attempt', attempt, '--reason', 'again')), [2, 'not-applied', 'TRIAGE_CAPACITY_NOT_RETAINED', 'queued', null]);

  // The attempt counted as spent: the request, back in the queue, is investigated again in its second and last attempt.
  await pause(w, 'unpause');
  await w.poll();
  const next = await until('the second attempt to end', async () => {
    const [request] = await w.requests();
    return request!.attempts?.length === 2 && request!.attempts[1]!.end ? request : undefined;
  });
  assert.deepEqual([next!.attempts!.length, next!.attempts![1]!.end!.code], [2, 'VERDICT_RECORDED']);
});

test('TR-49: `triage release` of a request already terminal frees the unit on a confirmed stop, with no attestation and no change of state', async t => {
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7)], pulls: {} },
    sources: [source],
    script: [() => 'I could not decide.'],
    ports: { attempts: 1 },
  });
  w.environment.controls.withholdStopConfirmation();
  await w.start();
  const failed = await w.settled(0, 'failed');
  const attempt = failed.attempts![0]!.attempt;
  const cli = await operator(t, w);
  assert.deepEqual((await listed(cli)).capacity, { configured: 1, investigating: 0, retained: 1 });
  // The attempt is over now, and the Factory sees it when it observes again inside the command.
  w.environment.controls.releaseStopConfirmation();
  const released = await cli('triage', 'release', failed.triage_request_id, '--attempt', attempt, '--reason', 'checked on the host');
  assert.deepEqual(summary(released), [0, 'accepted', null, 'failed', 'TRIAGE_ATTEMPTS_EXHAUSTED'], released.stdout + released.stderr);
  assert.deepEqual(
    [receiptOf(released).release!.basis, receiptOf(released).release!.observed, receiptOf(released).release!.author],
    ['stop-confirmed', 'unit-inactive', null],
  );
  const detail = await detailOf(cli, failed.triage_request_id);
  const [record] = detail.request.attemptRecords;
  assert.deepEqual([record!.capacity, record!.stop!.confirmed, record!.attestation, detail.impediments], ['released', true, null, []]);
  assert.deepEqual(detail.request.timeline.at(-1)!.event, 'capacity-released');
  assert.equal(detail.request.timeline.at(-1)!.reason, undefined, 'an observation needs nobody’s word');
  assert.deepEqual((await listed(cli)).capacity, { configured: 1, investigating: 0, retained: 0 });
});

test('TR-50 (GitHub): `triage complete` revalidates the exact Impediment, is refused with its own code while paused, then takes the ambiguous effect as the Factory’s and concludes', async t => {
  const { w, issue, id, ref, cli } = await impeded(t);
  const complete = (...flags: string[]) => cli('triage', 'complete', id, ...flags);
  const stale = await complete('--impediment', randomUUID());
  assert.deepEqual(summary(stale), [2, 'not-applied', 'TRIAGE_IMPEDIMENT_REFERENCE_MISMATCH', 'publishing', null]);
  assert.equal(receiptOf(stale).impediment, ref, 'the receipt shows the open Impediment');

  await pause(w, 'pause');
  const paused = await complete('--impediment', ref, '--request-id', 'complete-paused');
  assert.deepEqual(summary(paused), [2, 'not-applied', 'TRIAGE_COMPLETE_INSTALLATION_PAUSED', 'publishing', null], paused.stdout + paused.stderr);
  assert.equal(receiptOf(paused).impediment, ref);
  assert.deepEqual(
    [triageWrites(w), names(issue)],
    [
      ['comment', 'add-label'],
      ['needs-info', 'needs-triage'],
    ],
    'nothing is published while paused',
  );
  await pause(w, 'unpause');

  const done = await complete('--impediment', ref, '--request-id', 'complete-1');
  assert.deepEqual(summary(done), [0, 'accepted', null, 'concluded', 'VERDICT_PUBLISHED'], done.stdout + done.stderr);
  assert.deepEqual(effectLines(receiptOf(done).effects), {
    published: [
      ['comment', 'confirmed'],
      ['add-label', 'confirmed'],
      ['remove-label', 'confirmed'],
    ],
    discarded: [],
  });
  assert.deepEqual([triageWrites(w), names(issue)], [['comment', 'add-label', 'remove-label'], ['needs-info']], 'only what was missing is written');
  assert.deepEqual((await complete('--impediment', ref, '--request-id', 'complete-1')).json, done.json, 'the recorded receipt');
  const after = await complete('--impediment', ref);
  assert.deepEqual(summary(after), [2, 'not-applied', 'TRIAGE_REQUEST_NOT_PUBLISHING', 'concluded', 'VERDICT_PUBLISHED']);
  assert.deepEqual((await detailOf(cli, id)).impediments, []);
  for (const bad of [[], ['--impediment', 'not-a-reference']]) assert.equal((await complete(...bad)).code, 2, bad.join(' '));
});

test('TR-50 (GitHub): `triage complete` on a Ticket that closed is accepted and ends abandoned with the discarded effects in the receipt', async t => {
  const { w, issue, id, ref, cli } = await impeded(t);
  closeIssue(issue);
  const done = await cli('triage', 'complete', 'acme/project#7', '--impediment', ref);
  assert.deepEqual(summary(done), [0, 'accepted', null, 'abandoned', 'TICKET_CLOSED'], done.stdout + done.stderr);
  assert.deepEqual(effectLines(receiptOf(done).effects), {
    published: [
      ['comment', 'confirmed'],
      ['add-label', 'confirmed'],
    ],
    discarded: [['remove-label', 'no-longer-allowed', false]],
  });
  assert.equal(receiptOf(done).triage_request_id, id);
  assert.deepEqual(
    [triageWrites(w), names(issue)],
    [
      ['comment', 'add-label'],
      ['needs-info', 'needs-triage'],
    ],
    'nothing is written to a closed Ticket',
  );
});

test('TR-50 (GitHub): `triage complete` on a Ticket that got a Work is accepted and ends abandoned with the discarded effect in the receipt', async t => {
  const { w, issue, id, ref, cli } = await impeded(t);
  // A person withdraws needs-triage and applies the admission label: the normal admission creates the Work.
  removeLabel(issue, 'needs-triage');
  applyLabel(issue, 'ready-for-agent');
  await w.poll();
  assert.equal(((await cli('list')).json as { works: unknown[] }).works.length, 1, 'the Ticket has a Work');
  assert.equal((await w.requests())[0]!.publication!.impediment!.ref, ref, 'the publication is still stopped by the same Impediment');
  const done = await cli('triage', 'complete', id, '--impediment', ref);
  // The end names the withdrawal of needs-triage, the change that let the Work be admitted.
  assert.deepEqual(summary(done), [0, 'accepted', null, 'abandoned', 'NEEDS_TRIAGE_REMOVED'], done.stdout + done.stderr);
  assert.deepEqual(effectLines(receiptOf(done).effects), {
    published: [
      ['comment', 'confirmed'],
      ['add-label', 'confirmed'],
    ],
    discarded: [['remove-label', 'no-longer-allowed', false]],
  });
  assert.deepEqual(
    [triageWrites(w), names(issue)],
    [
      ['comment', 'add-label'],
      ['needs-info', 'ready-for-agent'],
    ],
    'nothing more is written',
  );
});

test('TR-50 (GitHub): a state-label conflict refuses `triage complete`, writes nothing and keeps the Impediment', async t => {
  const { w, issue, id, ref, cli } = await impeded(t);
  applyLabel(issue, 'wontfix');
  const refused = await cli('triage', 'complete', id, '--impediment', ref);
  assert.deepEqual(summary(refused), [2, 'not-applied', 'TRIAGE_LABELS_CHANGED', 'publishing', null], refused.stdout + refused.stderr);
  assert.equal(receiptOf(refused).impediment, ref, 'the Impediment stays');
  assert.match(receiptOf(refused).nextStep, /factory triage cancel/);
  assert.deepEqual(
    [triageWrites(w), names(issue)],
    [
      ['comment', 'add-label'],
      ['needs-info', 'needs-triage', 'wontfix'],
    ],
  );
  const detail = await detailOf(cli, id);
  assert.deepEqual([detail.request.state, detail.request.impediments], ['publishing', [ref]]);
  assert.deepEqual(
    detail.request.effects.map(effect => effect.status),
    ['confirmed', 'ambiguous-authorship', 'pending'],
    'nothing was taken as the Factory’s',
  );
});

test('TR-50 (GitHub): a tracker that changed since the Impediment was shown refuses `triage complete` before any write; the Impediment is kept', async t => {
  const { w, issue, id, ref, cli } = await impeded(t);
  // Somebody removed the label whose author was ambiguous: the Impediment the operator read no longer describes the Ticket.
  removeLabel(issue, 'needs-info');
  const before = { writes: triageWrites(w), labels: names(issue) };
  const refused = await cli('triage', 'complete', id, '--impediment', ref);
  assert.deepEqual(summary(refused), [2, 'not-applied', 'TRIAGE_IMPEDIMENT_CHANGED', 'publishing', null], refused.stdout + refused.stderr);
  assert.deepEqual({ writes: triageWrites(w), labels: names(issue) }, before, 'the refused command wrote nothing to the Ticket');
  assert.equal(receiptOf(refused).impediment, ref, 'the Impediment stays');
  const detail = await detailOf(cli, id);
  assert.deepEqual([detail.request.state, detail.request.impediments], ['publishing', [ref]]);
  assert.deepEqual(
    detail.request.effects.map(effect => effect.status),
    ['confirmed', 'ambiguous-authorship', 'pending'],
    'nothing was taken as the Factory’s',
  );
  // The publication itself goes on from the Ticket as it is now, at its next pass and under its own rules.
  await w.poll();
  assert.ok(!(await detailOf(cli, id)).request.impediments.includes(ref), 'the pass, not the refused command, replaced the stale Impediment');
});

test('TR-50 (Jira): `triage complete` takes the edit of ambiguous authorship as the Factory’s and concludes the Card’s request; paused, it is refused', async t => {
  const item = card('81017', 'PAG-42', { labels: ['squad-pagamentos'], components: ['10022', '10099'], statusCategory: 'indeterminate' });
  relabel(item, { add: ['needs-triage'] });
  const w = await triageWorld(t, {
    // The one edit (outcome label in, needs-triage out) lands in a changelog entry that names no author.
    jira: { cards: [item], triageWrites: [undefined, 'anonymous'] },
    sources: [jiraSource({ triage })],
    script: [() => conclude()],
  });
  await w.start();
  assert.equal((await w.investigated(0)).state, 'publishing');
  await w.poll();
  const [request] = (await w.requests()) as [TriageRequest];
  const impediment = request.publication!.impediment!;
  assert.deepEqual(impediment.effects, [1, 2]);
  const writes = () => w.jira.calls.filter(call => call.method === 'writeTriage').length;
  const cli = await operator(t, w);

  await pause(w, 'pause');
  const paused = await cli('triage', 'complete', 'PAG-42', '--impediment', impediment.ref);
  assert.deepEqual(summary(paused), [2, 'not-applied', 'TRIAGE_COMPLETE_INSTALLATION_PAUSED', 'publishing', null], paused.stdout + paused.stderr);
  await pause(w, 'unpause');

  const done = await cli('triage', 'complete', 'PAG-42', '--impediment', impediment.ref);
  assert.deepEqual(summary(done), [0, 'accepted', null, 'concluded', 'VERDICT_PUBLISHED'], done.stdout + done.stderr);
  assert.deepEqual(effectLines(receiptOf(done).effects), {
    published: [
      ['comment', 'confirmed'],
      ['add-label', 'confirmed'],
      ['remove-label', 'confirmed'],
    ],
    discarded: [],
  });
  assert.equal(writes(), 2, 'the comment and the one edit: nothing is written again');
  assert.deepEqual([...item.labels].sort(), ['needs-info', 'squad-pagamentos']);
});
