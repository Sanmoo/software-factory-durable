import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/control/durable/store.js';
import { admitTicket, initialize, ownCycles, readWork, readWorks, recordDependencies } from '../../src/control/durable/admission.js';
import type { Session } from '../../src/control/durable/store.js';
import { heldSlots, initializeSlots } from '../../src/control/durable/execution.js';
import { createChecksTracker, checksTarget } from '../../src/control/durable/checks.js';
import { acceptReadinessAuthorization, createReadinessDesk } from '../../src/control/durable/readiness.js';
import type { PullRequestObservation } from '../../src/code-repository/index.js';
import { githubDoubles, remoteIssue, scope, ticket, type Remote } from './doubles.js';
import { observedPull, seedReady } from './readiness-seed.js';

// Ticket 16 flow level (S): real Pi Durable/SQLite commits, the real checks tracker (ticket 15) and readiness desk; GitHub is doubled at the
// CodeRepository contract. Not evidence of the real GitHub boundary (test/entrypoints/github-readiness*.test.ts and the real-run recipe).
const dependencies = (session: Session) => ({ ownCycles: (ids: number[]) => ownCycles(session, ids),
  record: (work_id: string, evaluation: Parameters<typeof recordDependencies>[2]) => recordDependencies(session, work_id, evaluation, { published: true }) });
async function world(t: { after(fn: () => Promise<void>): void }, remote: Partial<Remote> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-readiness-flow-'));
  const opened = await openStore(join(dir, 'c.sqlite'));
  t.after(async () => { await opened.close(); await rm(dir, { recursive: true, force: true }); });
  const { session } = opened;
  await initialize(session); await initializeSlots(session);
  const github = githubDoubles({ issues: [remoteIssue(3)], pulls: {}, pullRequests: { 7: observedPull() }, ...remote });
  let now = 0;
  const access = { tracker: github.tracker, repository: github.repository, repositories: [scope] };
  const clock = { monotonic: () => now };
  const tracker = createChecksTracker({ session, access, readWorks: () => readWorks(session), busy: () => false, clock, minIntervalMs: 60000 });
  let installation: 'settled' | 'reconciliation-required' = 'settled';
  const desk = createReadinessDesk({ session, access, readWorks: () => readWorks(session), installation: () => installation, clock, minIntervalMs: 60000, dependencies: dependencies(session) });
  const result = await admitTicket(session, { ticket: ticket(3), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, observedAt: new Date().toISOString(),
    label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: new Date().toISOString(), limitations: [] } });
  assert.equal(result.kind, 'admitted');
  const id = result.work_id;
  await seedReady(session, id);
  const cycle = async () => { now += 60000; await tracker.pass(new AbortController().signal); await desk.pass(new AbortController().signal); };
  const calls = (method: string) => github.calls.filter(call => call.method === method);
  const work = async () => (await readWork(session, id))!;
  /** Cycles until `done` (a stable explanation of an unchanged head is fully re-read by ticket 15 every 10 intervals; light reads in between). */
  const until = async (done: () => Promise<boolean>, max = 12) => { for (let i = 0; i < max && !(await done()); i++) await cycle(); };
  return { session, id, github, calls, work, cycle, until, desk, setInstallation: (value: typeof installation) => { installation = value; } };
}
const events = (work: Awaited<ReturnType<Awaited<ReturnType<typeof world>>['work']>>) => work.history.filter(item => item.origin === 'controller-readiness' || item.event === 'readiness-authorized')
  .map(item => item.event);

test('AC3/AC6: a complete current evaluation, a fresh recheck, intent BEFORE the one mutation, an independent observation and the confirmation', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  const before = await h.work();
  let stateAtCall: string | undefined;
  const setDraft = h.github.repository.setDraft;
  h.github.repository.setDraft = async (...args) => { stateAtCall = (await h.work()).readiness?.effect?.state; return setDraft(...args); };
  await h.cycle();
  const after = await h.work();
  assert.equal(stateAtCall, 'intended', 'the intent is durable before the remote mutation');
  assert.deepEqual(h.calls('setDraft').map(call => (call.args as { draft: boolean; pr: { nodeId: string } })).map(args => [args.pr.nodeId, args.draft]), [['PR_node7', false]]);
  assert.equal(h.calls('readPullRequest').length, 3, 'checks explanation, recheck immediately before, observation after');
  const readiness = after.readiness!;
  assert.deepEqual([readiness.internal, readiness.flag.factory, readiness.flag.origin, readiness.flag.observed, readiness.effect], ['ready', 'ready', 'readiness-effect', 'ready', null]);
  assert.deepEqual(readiness.effects.map(item => [item.action, item.state, item.attempt?.outcome, item.observation?.draft, item.reason]),
    [['mark-ready', 'confirmed', 'applied', false, 'READY_FROM_CURRENT_EVIDENCE']]);
  assert.deepEqual(readiness.stages, { internal: 'ready', flag: 'ready', humanReview: 'human-stage', delivery: 'not-delivered' }, 'distinct stages');
  assert.deepEqual(events(after), ['readiness-evaluated', 'readiness-intended', 'readiness-attempted', 'readiness-confirmed']);
  assert.deepEqual([after.queue, after.impediments, after.result, await heldSlots(h.session)], [before.queue, before.impediments, 'open', 0], 'no Slot, queue entry or delivery');
  assert.equal(checksTarget(after)!.number, 7);
  await h.cycle(); await h.cycle();
  assert.equal(h.calls('setDraft').length, 1, 'stable ready: nothing repeated');
  assert.ok(h.github.calls.every(call => ['readPullRequest', 'setDraft', 'readDependencyGraph'].includes(call.method)), 'no other GitHub operation (no review, approval or merge)');
  const methods = h.github.calls.map(call => call.method);
  assert.ok(methods.indexOf('readDependencyGraph') < methods.indexOf('setDraft'), 'dependencies read fresh before the conversion');
  assert.equal(after.dependencies.latest!.conclusion, 'satisfied');
});

test('AC3: an uncertain conversion is discovered before anything else; one that did not apply is never repeated without an operator authorization', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() }, drafts: ['unknown-applied'] };
  const h = await world(t, remote);
  await h.cycle();
  assert.deepEqual((await h.work()).readiness!.effects.map(item => [item.state, item.attempt?.outcome]), [['confirmed', 'unknown']], 'discovery showed it applied');
  const lost: Partial<Remote> = { pullRequests: { 7: observedPull() }, drafts: ['unknown-not-applied'] };
  const g = await world(t, lost);
  await g.cycle();
  assert.deepEqual((await g.work()).readiness!.effects.map(item => [item.state, item.observation?.draft]), [['not-applied', true]]);
  await g.cycle(); await g.cycle();
  assert.equal(g.calls('setDraft').length, 1, 'no implicit retry');
  assert.match((await g.work()).readiness!.nextStep, /authorize-readiness/);
  const receipt = await acceptReadinessAuthorization(g.session, { request_id: 'op-1', operation: 'authorize-readiness', work_id: g.id, reason: 'Retry once.', origin: 'local-cli' });
  assert.deepEqual(receipt.kind === 'durable' ? [receipt.outcome, receipt.purpose] : receipt, ['accepted', 'repeat-conversion']);
  await g.cycle();
  const ready = (await g.work()).readiness!;
  assert.deepEqual([g.calls('setDraft').length, ready.effects.at(-1)!.state, ready.effects.at(-1)!.authorization, ready.authorization], [2, 'confirmed', 'op-1', null], 'ONE authorized attempt');
  const again = await acceptReadinessAuthorization(g.session, { request_id: 'op-2', operation: 'authorize-readiness', work_id: g.id, reason: 'Again.', origin: 'local-cli' });
  assert.deepEqual(again.kind === 'durable' ? [again.outcome, again.reason] : again, ['not-applied', 'NOTHING_TO_AUTHORIZE']);
});

test('V-12: an intent committed before a crash is discovered from the flag after the restart, and the mutation is never resent', async t => {
  const h = await world(t, { pullRequests: { 7: observedPull() } });
  let release!: () => void;
  const hung = new Promise<void>(resolve => { release = resolve; });
  // The first owner reaches its mutation and dies there (the call never returns, nothing reached GitHub).
  h.github.repository.setDraft = async () => { await hung; throw new Error('owner died'); };
  const dying = h.cycle();
  for (let i = 0; i < 500 && (await h.work()).readiness?.effect?.state !== 'intended'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.work()).readiness!.effect!.state, 'intended');
  const sent: unknown[] = [];
  const restarted = createReadinessDesk({ session: h.session, readWorks: () => readWorks(h.session), installation: () => 'settled', clock: { monotonic: () => 1e9 }, dependencies: dependencies(h.session),
    access: { tracker: h.github.tracker, repositories: [scope], repository: { ...h.github.repository, setDraft: async (...args) => { sent.push(args); throw new Error('never'); } } } });
  await restarted.pass(new AbortController().signal);
  const settled = (await h.work()).readiness!;
  assert.deepEqual([sent.length, settled.effect, settled.effects.map(item => [item.state, item.attempt, item.observation?.draft])], [0, null, [['not-applied', null, true]]],
    'discovery first: the flag is still draft, the conversion is settled as not applied, nothing resent');
  await restarted.pass(new AbortController().signal);
  assert.equal(sent.length, 0, 'not repeated implicitly after the restart either');
  release();
  await dying;
  assert.equal((await h.work()).readiness!.effects.length, 1, 'the dead owner\'s late steps are stale');
  assert.match((await h.work()).readiness!.nextStep, /authorize-readiness/, 'it was SENT (sending marker): only an operator authorization repeats it');
});

test('AC4/AC5: confirmed loss restores draft with its reason; the Factory draft is restored after a complete evaluation; transient reads flip nothing', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  await h.cycle();
  assert.equal((await h.work()).readiness!.flag.factory, 'ready');
  remote.pullRequests![7] = observedPull({ draft: false, mergeable: false });
  await h.until(async () => (await h.work()).readiness!.effects.length === 2);
  const lost = (await h.work()).readiness!;
  assert.deepEqual(lost.effects.map(item => [item.action, item.state, item.reason]), [['mark-ready', 'confirmed', 'READY_FROM_CURRENT_EVIDENCE'],
    ['convert-to-draft', 'confirmed', 'READINESS_LOST:MERGE_CONFLICT']]);
  assert.deepEqual([lost.internal, lost.flag.factory, lost.humanDraft], ['not-ready', 'draft', null], 'its own draft is not a human draft');
  (remote.pullRequests![7] as Extract<PullRequestObservation, { kind: 'observed' }>).pullRequest.mergeable = true;
  await h.until(async () => (await h.work()).readiness!.effects.length === 3);
  const restored = (await h.work()).readiness!;
  assert.deepEqual([restored.effects.at(-1)!.action, restored.effects.at(-1)!.state, restored.internal], ['mark-ready', 'confirmed', 'ready']);
  const writes = h.calls('setDraft').length;
  remote.pullRequests![7] = { kind: 'unavailable', source: 'github-rest', observedAt: new Date().toISOString(), repository: 'acme/project', code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'x' };
  await h.cycle(); await h.cycle();
  const transient = (await h.work()).readiness!;
  assert.deepEqual([transient.internal, transient.flag.observed, h.calls('setDraft').length], ['unknown', 'ready', writes], 'confirmation withdrawn, flag kept, no write');
  h.setInstallation('reconciliation-required');
  remote.pullRequests![7] = observedPull({ draft: false });
  await h.cycle();
  assert.deepEqual([(await h.work()).readiness!.internal, h.calls('setDraft').length], ['unknown', writes], 'global reconciliation uncertainty: no conversion either way');
});

test('AC5: an unexpected human draft is respected; ONE authorized restoration after a complete evaluation; the ready flag alone certifies nothing', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  await h.cycle();
  remote.pullRequests![7] = observedPull({ draft: true });
  await h.cycle(); await h.cycle();
  const human = (await h.work()).readiness!;
  assert.deepEqual([human.humanDraft !== null, human.flag.factory, human.internal, h.calls('setDraft').length], [true, 'ready', 'ready', 1], 'respected, not reverted');
  assert.match(human.nextStep, /human converted the PR back to draft/);
  const receipt = await acceptReadinessAuthorization(h.session, { request_id: 'op-h', operation: 'authorize-readiness', work_id: h.id, reason: 'Restore ready.', origin: 'local-cli' });
  assert.deepEqual(receipt.kind === 'durable' ? [receipt.outcome, receipt.purpose] : receipt, ['accepted', 'human-draft']);
  await h.cycle();
  const restored = (await h.work()).readiness!;
  assert.deepEqual([h.calls('setDraft').length, restored.effects.at(-1)!.authorization, restored.humanDraft, restored.flag.factory], [2, 'op-h', null, 'ready']);
  assert.ok(events(await h.work()).includes('readiness-human-flag'));
  // A human ready over a Factory draft is visible, never certified and never reverted.
  const g = await world(t, { pullRequests: { 7: observedPull({ draft: false, mergeable: false }) } });
  await g.cycle();
  const ready = (await g.work()).readiness!;
  assert.deepEqual([ready.internal, ready.flag.observed, ready.humanReady !== null, g.calls('setDraft').length], ['not-ready', 'ready', true, 0]);
});

test('AC2/AC7 race: a change of requirements between the evaluation and the recheck invalidates it (recalculated next pass); a base tip advance alone does not', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  const readPullRequest = h.github.repository.readPullRequest;
  let reads = 0;
  h.github.repository.readPullRequest = async query => {
    reads++;
    // The second read of the first cycle is the recheck: a new not-check-related rule appeared meanwhile.
    if (reads === 2) remote.pullRequests![7] = observedPull({ rules: [{ type: 'pull_request', ruleset: { id: 1, sourceType: 'Repository', source: 'acme/project' } },
      { type: 'non_fast_forward', ruleset: { id: 2, sourceType: 'Repository', source: 'acme/project' } }] });
    return readPullRequest(query);
  };
  await h.cycle();
  const invalidated = (await h.work()).readiness!;
  assert.deepEqual([h.calls('setDraft').length, invalidated.latest.notes.includes('RECHECK_CHANGED_BASIS'), invalidated.effect], [0, true, null], 'nothing converted on a changed basis');
  await h.cycle();
  assert.equal(h.calls('setDraft').length, 1, 'recalculated and converted once the basis is stable');
  const g = await world(t, { pullRequests: { 7: observedPull() } });
  const base = g.github.repository.readPullRequest;
  let count = 0;
  g.github.repository.readPullRequest = async query => { count++; const result = await base(query);
    return count === 2 && result.kind === 'observed' ? { ...result, baseTip: { state: 'complete', value: 'f'.repeat(40) }, final: { ...result.final, baseTip: { state: 'complete', value: 'f'.repeat(40) } } } : result; };
  await g.cycle();
  assert.equal(g.calls('setDraft').length, 1, 'base advancing alone (loose): no invalidation, no review, no rebase');
});

test('review MED 1: a push between the recheck and the mutation: flag Factory-placed on an unverified head, internal readiness withdrawn, then back to draft', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  const setDraft = h.github.repository.setDraft;
  h.github.repository.setDraft = async (...args) => {
    // A human pushes right before the mutation lands (GitHub answers with the new headRefOid).
    remote.pullRequests![7] = observedPull({ headSha: 'e'.repeat(40) });
    return setDraft(...args);
  };
  await h.cycle();
  const placed = (await h.work()).readiness!;
  assert.deepEqual([placed.effects[0]!.state, placed.effects[0]!.headMismatch, placed.flag.factory, placed.internal],
    ['confirmed', { evaluated: 'd'.repeat(40), observed: 'e'.repeat(40) }, 'ready', 'unknown'], 'the flag is ours, readiness is not');
  h.github.repository.setDraft = setDraft;
  await h.until(async () => (await h.work()).readiness!.effects.length === 2);
  const back = (await h.work()).readiness!;
  assert.deepEqual([back.effects[1]!.action, back.effects[1]!.state, back.internal], ['convert-to-draft', 'confirmed', 'not-ready']);
  assert.match(back.effects[1]!.reason, /HEAD_NOT_VERIFIED_CONTENT/);
});

test('review MED 2: an applied mutation contradicted by a lagging read stays pending (never not-applied, never a human ready) until the flag is observed', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() } };
  const h = await world(t, remote);
  const read = h.github.repository.readPullRequest;
  let lag = true;
  h.github.repository.readPullRequest = async query => {
    const result = await read(query);
    // The observation right after the mutation still shows the old draft flag.
    if (lag && h.calls('setDraft').length === 1 && result.kind === 'observed') { lag = false; return { ...result, pullRequest: { ...result.pullRequest, draft: true } }; }
    return result;
  };
  await h.cycle();
  const lagging = (await h.work()).readiness!;
  assert.deepEqual([lagging.effect?.state, lagging.effect?.contradictions, lagging.effects.length, lagging.humanReady], ['attempted', 1, 0, null]);
  await h.cycle();
  const settled = (await h.work()).readiness!;
  assert.deepEqual([settled.effects.map(item => item.state), settled.humanReady, settled.humanDraft, settled.flag.factory, h.calls('setDraft').length],
    [['confirmed'], null, null, 'ready', 1]);
});

test('review MED 5: a dependency now pending blocks the conversion, from the fresh read before the recheck', async t => {
  const remote: Partial<Remote> = { pullRequests: { 7: observedPull() }, issues: [remoteIssue(3, { blockedBy: [9] }), remoteIssue(9)] };
  const h = await world(t, remote);
  await h.cycle();
  const blocked = (await h.work()).readiness!;
  assert.equal(h.calls('setDraft').length, 0);
  assert.ok(blocked.latest.reasons.some(item => item.code === 'DEPENDENCIES_PENDING'), JSON.stringify(blocked.latest.reasons));
});

test('review LOW: aborted after the intent and before sending: discovered as never sent, then ONE automatic re-evaluation converts it', async t => {
  const h = await world(t, { pullRequests: { 7: observedPull() } });
  const stop = new AbortController();
  const session = new Proxy(h.session, { get(target, name) {
    const value = Reflect.get(target, name) as unknown;
    if (typeof value !== 'function') return value;
    if (name !== 'commit') return (value as (...args: unknown[]) => unknown).bind(target);
    return async (...args: unknown[]) => { const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      if (result && typeof result === 'object' && (result as { state?: string }).state === 'intended' && 'effectId' in result) stop.abort(); return result; };
  } }) as Session;
  const desk = createReadinessDesk({ session, readWorks: () => readWorks(h.session), installation: () => 'settled', clock: { monotonic: () => 1e9 }, dependencies: dependencies(h.session),
    access: { tracker: h.github.tracker, repositories: [scope], repository: h.github.repository } });
  const tracker = createChecksTracker({ session: h.session, access: { tracker: h.github.tracker, repository: h.github.repository, repositories: [scope] }, readWorks: () => readWorks(h.session), busy: () => false });
  await tracker.pass(new AbortController().signal);
  await desk.pass(stop.signal);
  const intended = (await h.work()).readiness!.effect!;
  assert.deepEqual([intended.state, intended.sendingAt, h.calls('setDraft').length], ['intended', null, 0]);
  await h.desk.pass(new AbortController().signal);
  assert.deepEqual((await h.work()).readiness!.effects.map(item => [item.state, item.neverSent]), [['not-applied', true]]);
  await h.cycle();
  const done = (await h.work()).readiness!;
  assert.deepEqual([h.calls('setDraft').length, done.effects.map(item => item.state)], [1, ['not-applied', 'confirmed']], 'one automatic re-evaluation, no operator needed');
  assert.ok((await h.work()).history.some(item => item.event === 'readiness-not-applied' && /never-sent/.test(item.detail)));
});
