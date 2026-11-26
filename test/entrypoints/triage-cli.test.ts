import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  SourceTriage,
  TicketSource,
  TriageDetailView,
  TriageRequest,
  TriagesView,
  TriageStatusView,
  TriageTranscriptView,
  TriageUsageView,
  UsageView,
} from '../../src/control/index.js';
import { serveControl } from '../../src/entrypoints/controller/serve.js';
import { applyLabel, remoteIssue, removeLabel, type RemoteIssue } from '../control/doubles.js';
import { call, hang, investigationClock, triageWorld, turnTokens } from '../control/triage-investigation-fixture.js';
import { ended, until } from '../runner/budget.js';

// Spec #68 §10 (ticket #80): what the operator sees of the Triage requests, through the REAL CLI process over the controller socket.
// The Control is the real one (SQLite, Triager session under a scripted provider, real session files); the trackers are the doubles.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const source: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
const bodyCanary = 'CANARY-ticket-body-7c1f';
const verdictCanary = 'CANARY-verdict-text-93ab';
const argumentCanary = 'CANARY-tool-argument-5e20';
const canaries = [bodyCanary, verdictCanary, argumentCanary];
function triageIssue(number: number, overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  const issue = remoteIssue(number, { labels: [], title: 'Total errado', body: `O total ignora o cupom. ${bodyCanary}`, ...overrides });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const conclude = (text = `Observado: o total ignora o cupom. ${verdictCanary}`) => call('concluir_triagem', { outcome: 'needs-info', category: 'bug', text });
type World = Awaited<ReturnType<typeof triageWorld>>;
type Result = { code: number | null; stdout: string; stderr: string; json: unknown };

/** Serves the world's Control on the installation's operator socket and runs the built CLI against it, one process per command. */
async function operator(t: { after(fn: () => Promise<void> | void): void }, w: World) {
  await mkdir(join(w.root, 'run'), { mode: 0o700 });
  const status = (await w.control().inspect({ kind: 'status' })) as { controller_run_id: string };
  const server = await serveControl(join(w.root, 'run', 'control.sock'), w.control(), status.controller_run_id, () => {});
  t.after(() => server.close());
  return async (...args: string[]): Promise<Result> => {
    const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', w.root, '--json'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/forbidden-personal-profile' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', data => (stdout += String(data)));
    child.stderr.on('data', data => (stderr += String(data)));
    const { code } = await ended(child, () => `factory ${args.join(' ')}`);
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
  };
}
const events = (timeline: { event: string; code?: string }[]) => timeline.map(entry => entry.event);

test('TR-44 and TR-45: `triages`, `triage` and `status` show each request by metadata only; the canaries of the Ticket, the Verdict and the tool arguments stay out', async t => {
  const conflicting = triageIssue(8);
  applyLabel(conflicting, 'wontfix');
  const w = await triageWorld(t, {
    // The second write (the outcome label) lands without an attributable author: the publication stops with an Impediment.
    github: { issues: [triageIssue(7), conflicting, triageIssue(9)], pulls: {}, triageWrites: [undefined, 'anonymous'] },
    sources: [source],
    script: [() => call('request_clone', { repository: `acme/${argumentCanary}` }), () => conclude(), () => hang],
  });
  await w.start();
  assert.equal((await w.investigated(0)).state, 'publishing');
  await w.poll();
  await until('the second request to be investigated', async () => ((await w.requests())[1]?.state === 'investigating' ? true : undefined));
  const [first, second] = (await w.requests()) as [TriageRequest, TriageRequest];
  const cli = await operator(t, w);

  const listed = await cli('triages');
  const list = listed.json as TriagesView;
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    list.requests.map(item => [item.ticket, item.state, item.outcome, item.verdict.state, item.capacity, item.attempts]),
    [
      ['acme/project#7', 'publishing', 'needs-info', 'published', 'none', { used: 1, total: 2 }],
      ['acme/project#9', 'investigating', null, 'none', 'investigating', { used: 1, total: 2 }],
    ],
  );
  assert.deepEqual(
    Object.keys(list.states),
    ['queued', 'investigating', 'suspended', 'publishing', 'concluded', 'abandoned', 'failed'],
    'seven states, no retry state',
  );
  assert.deepEqual(list.capacity, { configured: 1, investigating: 1, retained: 0 });
  assert.equal(list.requests[0]!.verdict.link, w.remote.comments![7]![0]!.url, 'a published Verdict is a link to its comment');
  assert.ok(list.requests[0]!.investigation.remainingMs! <= 15 * 60_000);
  // TR-03: the state-label conflict that keeps a Ticket without a request is visible in the CLI.
  assert.deepEqual(
    list.held.map(item => [item.ticket, item.holds.map(hold => [hold.code, hold.labels])]),
    [['acme/project#8', [['TRIAGE_LABEL_CONFLICT', ['wontfix']]]]],
  );
  const impediment = first.publication!.impediment!;
  assert.deepEqual(
    list.impediments.map(item => [item.code, item.ref, item.triage_request_id]),
    [['TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS', impediment.ref, first.triage_request_id]],
  );
  assert.deepEqual(list.requests[0]!.impediments, [impediment.ref]);
  assert.equal(list.requests[0]!.nextStep, impediment.nextStep, 'an Impediment shows its next step');

  const shown = await cli('triage', first.triage_request_id);
  const detail = shown.json as TriageDetailView;
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(
    detail.request.effects.map(effect => [effect.kind, effect.status]),
    [
      ['comment', 'confirmed'],
      ['add-label', 'ambiguous-authorship'],
      ['remove-label', 'pending'],
    ],
    'in `publishing` every intended effect shows its situation',
  );
  assert.deepEqual(events(detail.request.timeline).slice(0, 4), ['requested', 'attempt-started', 'verdict-recorded', 'attempt-ended']);
  assert.ok(detail.request.timeline.every(entry => typeof entry.at === 'string'));
  const [attempt] = detail.request.attemptRecords;
  assert.deepEqual(
    [attempt!.code, attempt!.capacity, attempt!.skillPack?.id, attempt!.toolCalls, attempt!.transcript, attempt!.mcp],
    ['VERDICT_RECORDED', 'released', 'factory-skills-v13', { request_clone: 1, concluir_triagem: 1 }, 'recorded', { active: [], calls: {} }],
  );
  assert.deepEqual([detail.latest, detail.previous, detail.request.details.state], [true, [], 'protected']);
  const byTicket = await cli('triage', 'acme/project#7');
  assert.deepEqual(byTicket.json, detail, 'a Ticket reference names its most recent request');
  assert.equal((await cli('triage', 'acme/project#404')).code, 2);

  const status = await cli('status');
  const section = (status.json as { triage: TriageStatusView }).triage;
  assert.deepEqual(
    [section.capacity, section.queued, section.held, section.intervention],
    [
      { configured: 1, investigating: 1, retained: 0 },
      0,
      1,
      { requests: 1, impediments: [{ ref: impediment.ref, code: 'TRIAGE_EFFECT_AUTHORSHIP_AMBIGUOUS', triage_request_id: first.triage_request_id }] },
    ],
  );

  // TR-45: no surface carries the content, in `--json` either; only the explicit transcript command does.
  const usage = await cli('usage');
  const surfaces = [listed, shown, byTicket, status, usage, await cli('triage', second.triage_request_id), await cli('list')];
  for (const surface of surfaces) for (const canary of canaries) assert.ok(!(surface.stdout + surface.stderr).includes(canary), `${canary} leaked`);
  const transcript = await cli('triage', 'transcript', first.triage_request_id);
  const page = transcript.json as TriageTranscriptView;
  assert.equal(transcript.code, 0, transcript.stderr);
  assert.deepEqual([page.part, page.attempt, page.trust], ['transcript', attempt!.attempt, 'untrusted-triage-content']);
  let text = page.text!;
  for (let next = page.nextOffset; next !== null;) {
    const more = (await cli('triage', 'transcript', first.triage_request_id, '--attempt', attempt!.attempt, '--offset', String(next)))
      .json as TriageTranscriptView;
    text += more.text!;
    next = more.nextOffset;
  }
  assert.equal(text, await w.transcript(first), 'the pages are the session file, whole');
  for (const canary of canaries) assert.ok(text.includes(canary), `the transcript holds ${canary}`);
  const verdict = (await cli('triage', 'transcript', first.triage_request_id, '--verdict')).json as TriageTranscriptView;
  assert.deepEqual([verdict.part, verdict.state, verdict.text?.includes(verdictCanary)], ['verdict', 'complete', true]);

  // TR-47: the Triages have their own line, per request and in total, and are not added to the Works.
  const view = usage.json as UsageView & { triage: TriageUsageView };
  const [measured, open] = view.triage.requests;
  assert.deepEqual([measured!.ticket, measured!.attempts.length, measured!.total.measurement], ['acme/project#7', 1, 'complete']);
  assert.deepEqual(
    [measured!.total.tokens?.input, measured!.total.tokens?.output],
    [2 * turnTokens.input, 2 * turnTokens.output],
    'two model requests: the clone request and the Verdict',
  );
  assert.equal(open!.ticket, 'acme/project#9');
  assert.equal(view.triage.total.tokens!.total, measured!.total.tokens!.total + (open!.total.tokens?.total ?? 0));
  assert.deepEqual([view.works, view.total.tokens, view.total.activities], [[], null, 0], 'nothing of a Triage is counted as a Work');
  for (const bad of [
    ['triage'],
    ['triage', 'not a reference'],
    ['triages', '--limit', '0'],
    ['triage', 'transcript', 'acme/project#7'],
    ['triages', '--request-id', 'x'],
  ])
    assert.equal((await cli(...bad)).code, 2, bad.join(' '));
});

test('TR-44: a failed request is not an Impediment and says to remove and reapply the label; a new request shows the earlier ones of its Ticket', async t => {
  const issue = triageIssue(7);
  const w = await triageWorld(t, {
    github: { issues: [issue], pulls: {} },
    sources: [source],
    script: [() => 'I could not decide.', () => 'Still undecided.', () => conclude()],
  });
  await w.start();
  await w.investigated(0);
  await w.poll();
  const failed = await w.settled(0, 'failed');
  const cli = await operator(t, w);
  const first = (await cli('triage', 'acme/project#7')).json as TriageDetailView;
  assert.deepEqual(
    [first.request.state, first.request.endCode, first.request.attempts, first.impediments],
    ['failed', 'TRIAGE_ATTEMPTS_EXHAUSTED', { used: 2, total: 2 }, []],
  );
  assert.match(first.request.nextStep, /not an Impediment.*remove and reapply needs-triage/);
  assert.deepEqual(events(first.request.timeline), ['requested', 'attempt-started', 'attempt-ended', 'requeued', 'attempt-started', 'attempt-ended', 'failed']);
  assert.deepEqual(
    first.request.attemptRecords.map(attempt => attempt.code),
    ['TRIAGER_ENDED_WITHOUT_VERDICT', 'TRIAGER_ENDED_WITHOUT_VERDICT'],
  );
  const status = (await cli('status')).json as { triage: TriageStatusView };
  assert.deepEqual([status.triage.states.failed, status.triage.intervention], [1, { requests: 0, impediments: [] }]);

  removeLabel(issue, 'needs-triage');
  await w.poll();
  applyLabel(issue, 'needs-triage');
  await w.poll();
  await w.investigated(1);
  await w.poll();
  await w.settled(1, 'concluded');
  const latest = (await cli('triage', 'acme/project#7')).json as TriageDetailView;
  assert.deepEqual([latest.request.ordinal, latest.request.state, latest.request.outcome, latest.latest], [2, 'concluded', 'needs-info', true]);
  assert.deepEqual(
    latest.previous.map(item => [item.triage_request_id, item.state]),
    [[failed.triage_request_id, 'failed']],
  );
  const earlier = (await cli('triage', failed.triage_request_id)).json as TriageDetailView;
  assert.deepEqual([earlier.latest, earlier.later.map(item => item.triage_request_id)], [false, [latest.request.triage_request_id]]);
});

test('TR-46: a transcript is read only by its command; 30 days after the terminal state it and the Verdict text go, metadata and link stay; an Impediment protects it; early removal needs a plan and its confirmation', async t => {
  const time = investigationClock(Date.now());
  const w = await triageWorld(t, {
    github: { issues: [triageIssue(7), triageIssue(9)], pulls: {} },
    sources: [source],
    script: [() => conclude(), () => 'I could not decide.'],
    ports: { clock: time.clock, attempts: 1 },
  });
  await w.start();
  await w.investigated(0);
  // The stop of the second request's only attempt is not confirmed: it ends `failed` with its unit retained, an Impediment.
  w.environment.controls.withholdStopConfirmation();
  await w.poll();
  const retained = await w.settled(1, 'failed');
  await w.poll();
  const concluded = await w.settled(0, 'concluded');
  const cli = await operator(t, w);
  const detailOf = async (id: string) => (await cli('triage', id)).json as TriageDetailView;
  const transcriptOf = async (id: string, ...flags: string[]) => {
    const result = await cli('triage', 'transcript', id, ...flags);
    return { code: result.code, view: result.json as TriageTranscriptView };
  };
  const link = (await detailOf(concluded.triage_request_id)).request.verdict.link;
  assert.equal((await transcriptOf(concluded.triage_request_id)).code, 0);
  assert.deepEqual((await detailOf(concluded.triage_request_id)).request.details.state, 'retained');
  assert.deepEqual((await detailOf(retained.triage_request_id)).request.details.protections, ['TRIAGE_IMPEDIMENT_OPEN']);

  // A day short of the term nothing is removed.
  time.advance(29 * 86_400_000);
  await w.poll();
  assert.equal((await transcriptOf(concluded.triage_request_id)).view.state === 'expired', false);
  time.advance(2 * 86_400_000);
  await w.poll();
  const expired = await transcriptOf(concluded.triage_request_id);
  assert.deepEqual([expired.code, expired.view.state, expired.view.text, expired.view.code], [2, 'expired', null, 'RETENTION_EXPIRED']);
  const expiredVerdict = await transcriptOf(concluded.triage_request_id, '--verdict');
  assert.deepEqual([expiredVerdict.code, expiredVerdict.view.state, expiredVerdict.view.text], [2, 'expired', null]);
  const kept = await detailOf(concluded.triage_request_id);
  assert.deepEqual(
    [kept.request.state, kept.request.outcome, kept.request.verdict, kept.request.details.state, kept.request.attemptRecords.length],
    ['concluded', 'needs-info', { state: 'published', link }, 'expired', 1],
    'metadata and the link of the published Verdict stay',
  );
  assert.deepEqual(events(kept.request.timeline).slice(-2), ['details-removal-intended', 'details-removed']);
  const files = Object.keys(await w.attemptFiles());
  assert.ok(!files.some(file => file.includes(concluded.attempts![0]!.attempt)), 'the attempt directory (prompt, session) is gone');
  // The tokens measured before the removal are still in `usage`.
  const usage = (await cli('usage')).json as { triage: TriageUsageView };
  assert.equal(usage.triage.requests[0]!.total.tokens?.input, turnTokens.input);

  // The request with an open Impediment kept everything, although its term is over too; an early removal is refused.
  const still = await transcriptOf(retained.triage_request_id);
  assert.deepEqual([still.code, still.view.state === 'complete' || still.view.state === 'truncated'], [0, true]);
  const refused = await cli('triage', 'cleanup', retained.triage_request_id, '--yes', '--request-id', 'early-1');
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /REQUEST_IDENTIFIED.*early-1/);
  assert.deepEqual(refused.json, {
    kind: 'durable',
    request_id: 'early-1',
    operation: 'triage-cleanup-plan',
    triage_request_id: retained.triage_request_id,
    outcome: 'not-applied',
    reason: 'TRIAGE_IMPEDIMENT_OPEN',
    plan: null,
  });
  assert.equal((await transcriptOf(retained.triage_request_id)).code, 0, 'nothing was removed');

  // Once the stop is confirmed the Impediment is over: the plan lists the losses and removes nothing; the confirmation removes.
  w.environment.controls.releaseStopConfirmation();
  await w.poll();
  const planned = await cli('triage', 'cleanup', retained.triage_request_id, '--request-id', 'early-2');
  const plan = (planned.json as { outcome: string; plan: { planId: string; state: string; items: { kind: string; attempt?: string }[] } }).plan;
  assert.deepEqual(
    [planned.code, (planned.json as { outcome: string }).outcome, plan.state, plan.items.map(item => [item.kind, item.attempt])],
    [0, 'accepted', 'planned', [['transcript', retained.attempts![0]!.attempt]]],
  );
  assert.equal((await transcriptOf(retained.triage_request_id)).code, 0, 'a plan removes nothing');
  assert.deepEqual(
    ((await cli('triage', 'cleanup', retained.triage_request_id, '--request-id', 'early-2')).json as { plan: unknown }).plan,
    plan,
    'same identity, same receipt',
  );
  assert.equal(
    (await cli('triage', 'cleanup-confirm', retained.triage_request_id, concluded.triage_request_id, '--request-id', 'early-3')).code,
    2,
    'an unknown plan',
  );
  const confirmed = await cli('triage', 'cleanup-confirm', retained.triage_request_id, plan.planId, '--request-id', 'early-4');
  assert.deepEqual([confirmed.code, (confirmed.json as { outcome: string }).outcome], [0, 'accepted']);
  const removed = await transcriptOf(retained.triage_request_id);
  assert.deepEqual([removed.code, removed.view.state, removed.view.code], [2, 'removed', 'EXPLICIT_CLEANUP']);
  const after = await detailOf(retained.triage_request_id);
  assert.deepEqual([after.request.state, after.request.endCode, after.request.details.state], ['failed', 'TRIAGE_ATTEMPTS_EXHAUSTED', 'removed']);
  assert.deepEqual(Object.keys(await w.attemptFiles()), []);
});
