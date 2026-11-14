import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import { openStore } from '../../src/control/durable/store.js';
import { works } from '../../src/control/durable/admission.js';
import type { Control, ExecutionPorts, ExecutionView, ListView, WorkView } from '../../src/control/types.js';
import type { PullRequestCandidate } from '../../src/code-repository/index.js';
import type { WorkerSessionRef } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Flow level (S): real Control + Pi Durable + temporary SQLite. Doubled: GitHub (IssueTracker/CodeRepository), clock and the execution
// boundaries (Sandbox lifecycle, Workers, credentials). The ticket 13 end-of-Execution verification is SEEDED into the real storage between
// two owner runs (this branch is not yet rebased on ticket 13): the seed is the record shape ticket 13 writes, not a proof of its rounds.
const head = 'd'.repeat(40);
const sessionRef = (n: number): WorkerSessionRef => ({ ref: `r/boot${n}/w-abc/profile/sessions/s${n}.jsonl`, sessionId: `5e55a0b0-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sha256: String(n).repeat(64).slice(0, 64), bytes: 100 + n, format: 'pi-session-jsonl-v3',
  profile: { sdkProfile: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', providerId: 'openai', modelId: 'gpt-6-luna', skillPack: 'factory-skills-v6',
    tools: ['ask_user', 'bash', 'edit', 'handoff', 'read', 'write'] } });
type Activation = { prompt: string; phaseId: string; executionId: string; continuation: unknown; handoff: unknown };
/** What one Builder activation does: the implementation completes; a publication may publish directly (refs/PR on the remote) and end. */
type Script = { kind: 'complete' } | { kind: 'publish'; publish: (remote: Remote, activation: Activation) => void; end: 'success' | 'failure' };

const ownPull = (workId: string, branch: string, overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate => ({ pullRequestId: 9004, nodeId: 'PR_node4', number: 4,
  url: 'https://github.com/acme/project/pull/4', state: 'open', merged: false, headRef: branch, headRepositoryId: 3, headSha: head, baseRef: 'main', draft: true,
  author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, association: ['closing-reference', 'known-branch'],
  body: [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n'), ...overrides });
/** The Builder's direct publication as the remote sees it: its own branch at the verified commit and its own draft PR. */
const publishOwn = (overrides: Partial<PullRequestCandidate> = {}) => (remote: Remote, activation: Activation) => {
  const workId = /Work ([0-9a-f-]{36})/.exec(activation.prompt)![1]!;
  const branch = /your branch (\S+);/.exec(activation.prompt)![1]!;
  (remote.refs ??= {})[branch] = head;
  remote.pulls[3] = [...(remote.pulls[3] ?? []), ownPull(workId, branch, overrides)];
};

function executionDoubles(remote: Remote, scripts: Script[]) {
  const calls: { kind: string; detail?: unknown }[] = [];
  let sessions = 0;
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 }, capacity: 1,
    builder: { skillPack: 'factory-skills-v6', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare' });
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v6', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: calls.filter(call => call.kind === 'prepare').length > 1, preparedAt: new Date().toISOString() } };
      },
      async start() { calls.push({ kind: 'start' }); return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never }; },
      async stop() { calls.push({ kind: 'stop' }); return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
    },
    credentials: {
      async issue(input) {
        const purpose = input.purpose ?? 'builder-start';
        calls.push({ kind: 'issue', detail: purpose });
        return { delivery: { token: `ghs_synthetic${purpose === 'builder-publish' ? 'Publish' : 'Start'}0123` }, metadata: { role: 'builder', purpose, repository: 'acme/project',
          repositoryId: 3, installationId: 2, permissions: purpose === 'builder-publish' ? { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read' }
            : { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
      },
      async revoke() { calls.push({ kind: 'revoke' }); return { kind: 'revoked', nextStep: 'synthetic' }; },
    },
    workers: {
      async activate(invocation, delivery) {
        const script = scripts.shift() ?? { kind: 'complete' };
        const activation: Activation = { prompt: invocation.prompt, phaseId: invocation.context.phaseId, executionId: invocation.context.executionId,
          continuation: invocation.continuation ?? null, handoff: invocation.handoff ?? null };
        calls.push({ kind: 'activate', detail: { ...activation, token: delivery?.credential?.token } });
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({ receipt, invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
        const session = invocation.continuation ? { ...invocation.continuation.session, ref: `${invocation.continuation.session.ref}.c`, sha256: 'e'.repeat(64) } : sessionRef(++sessions);
        const completed = started.then(() => {
          if (script.kind === 'publish') {
            script.publish(remote, activation);
            if (script.end === 'failure') return { status: 'failure' as const, code: 'WORKER_CHANNEL_LOST' };
          }
          return { status: 'success' as const, receipt, session };
        });
        return { worker: invocation.context.invocationId, started, completed, close() {} };
      },
      async deliver(_worker, directive) { calls.push({ kind: `deliver-${directive.kind}` }); return { status: directive.kind === 'credential' ? 'delivered' as const : 'withdrawn' as const }; },
      async observe(input) { calls.push({ kind: 'observe' }); return { session: { state: 'compatible' as const, session: input.session }, limitations: [] }; },
    },
  };
  return { ports, calls };
}

/** Ticket 13's record on a completed Execution: its final capture (content identity) and the end-of-Execution verification. */
async function seedVerification(storagePath: string, work_id: string, verification: { status: 'verified' | 'not-verified'; reasons: readonly string[] } = { status: 'verified', reasons: [] },
  content: { clean: boolean; headMatches: boolean } = { clean: true, headMatches: true }) {
  const store = await openStore(storagePath);
  try {
    await store.session.commit(async tx => {
      const document = await tx.doc(works, work_id, null);
      const execution = document.work!.execution!;
      const summary = { version: 1, round: 2, index: '/artifacts/review/r2/index.json', indexSha256: 'a'.repeat(64), head, branch: execution.request.branch, base: 'a'.repeat(40),
        mergeBase: 'a'.repeat(40), counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 }, patches: {}, spec: null, instructions: null,
        changed: [], changedTruncated: false, content: { sha256: 'f'.repeat(64), ...content } };
      (execution as { review?: unknown }).review = { rounds: [{ round: 2, attempt: 1, state: 'delivered', kind: 'exemption', closing: true, handoff: { at: 'x', invocationId: execution.invocationId,
        status: 'captured', code: null, detail: null, summary } }], verification: { at: new Date().toISOString(), ...verification, reviewedRound: 1, finalRound: 2,
        contentSha256: 'f'.repeat(64), applicability: { kind: 'identical-commit', head, reviewedHead: 'e'.repeat(40) },
        gates: [{ id: 't1', outcome: 'passed', current: true, boundToFinalContent: true, requiredCheck: null }], treatments: [], requiredChecks: [] } };
    }, BACKGROUND_CONTEXT);
  } finally { await store.close(); }
}

async function harness(t: { after(fn: () => Promise<void>): void }, remote: Remote, scripts: Script[]) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-publication-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles(remote);
  const storagePath = join(dir, 'control.sqlite');
  const execution = executionDoubles(remote, scripts);
  let current: { control: Control; stop: AbortController; running: Promise<{ kind: string }>; time: ReturnType<typeof manualClock> } | undefined;
  async function start() {
    const time = manualClock();
    const control = await openControl({ storagePath, runtimeInventory: 'empty', execution: execution.ports,
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
    const stop = new AbortController();
    current = { control, stop, running: control.run(stop.signal), time };
    await time.sleeping();
  }
  async function stop() { current!.stop.abort(); assert.deepEqual(await current!.running, { kind: 'clean' }); }
  t.after(async () => { if (current && !current.stop.signal.aborted) await stop(); });
  const work = async () => ((await current!.control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView;
  /** Waits WITHOUT advancing the clock (no new cycle/tick happens meanwhile). */
  const until = async (predicate: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`${label} not reached`);
  };
  /** Advances polling cycles (each followed by the dispatcher tick) until the predicate holds. */
  const settle = async (predicate: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return;
      if (current!.time.isSleeping()) current!.time.advance();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`${label} not reached`);
  };
  const cycles = async (n: number) => { for (let i = 0; i < n; i++) { current!.time.advance(); await current!.time.sleeping(); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const activations = () => execution.calls.filter(call => call.kind === 'activate').map(call => call.detail as Activation & { token: string });
  /** Runs the implementation Execution to its confirmed end, then (owner stopped) seeds ticket 13's record and restarts the owner. */
  async function implemented(verification?: Parameters<typeof seedVerification>[2], content?: Parameters<typeof seedVerification>[3], options: { restart?: boolean } = {}) {
    await start();
    await until(async () => (await work())?.execution?.end?.cessation === 'confirmed' && (await work()).execution!.slot.held === false, 'implementation ended');
    const { work_id, branch } = await work();
    await stop();
    await seedVerification(storagePath, work_id, verification, content);
    if (options.restart !== false) await start();
    return { work_id, branch: branch! };
  }
  return { github, execution, start, stop, work, settle, cycles, activations, implemented, storagePath };
}
const publicationOf = (work: WorkView) => work.publication!;
const executionsOf = (work: WorkView): ExecutionView[] => [...work.previousExecutions, ...(work.execution ? [work.execution] : [])];

test('AC1/AC2/AC4/AC5: absence of an own PR requests publication from the Builder with a publish grant; the own draft PR is then discovered and linked', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'complete' }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  const { work_id: workId } = await h.implemented();
  await h.settle(async () => publicationOf(await h.work())?.state === 'published', 'published');
  const work = await h.work();
  const publication = publicationOf(work);
  const [implementation, publish] = h.activations();
  // The implementation never held a write grant; only the publication activation did, and it was Control's choice.
  assert.deepEqual(h.execution.calls.filter(call => call.kind === 'issue').map(call => call.detail), ['builder-start', 'builder-publish']);
  assert.match(implementation!.token, /Start/);
  assert.match(publish!.token, /Publish/);
  assert.equal(publish!.phaseId, 'builder-publication');
  assert.match(publish!.prompt, /^publish\n/, 'the compatible session is continued with a publication request');
  assert.ok(publish!.continuation, 'same session');
  assert.ok(publish!.prompt.includes(`--force-with-lease=refs/heads/${work.branch}: origin ${head}:refs/heads/${work.branch}`), 'explicit lease: the branch must not exist yet');
  // Association Work/Ticket/repository/branch/base/PR is unambiguous and preserved.
  assert.equal(publication.basisExecutionId, executionsOf(work)[0]!.executionId);
  assert.deepEqual([publication.branch, publication.base, publication.marker, publication.verified!.head], [work.branch, 'main', `<!-- software-factory:work:${workId} -->`, head]);
  assert.deepEqual(publication.expectedRemote, { state: 'absent' }, 'the lease expectation observed BEFORE the activation is preserved');
  assert.deepEqual(executionsOf(work)[1]!.request.publication, { basisExecutionId: publication.basisExecutionId, head, branch: work.branch, base: 'main',
    marker: publication.marker, expectedRemote: { state: 'absent' } }, 'the normal Execution record keeps exactly what the publication carried');
  assert.equal(executionsOf(work)[1]!.request.resume!.reason, 'PUBLICATION_REQUESTED');
  assert.deepEqual([publication.pullRequest!.number, publication.pullRequest!.draft, publication.pullRequest!.headSha, publication.pullRequest!.headRef, publication.pullRequest!.base],
    [4, true, head, work.branch, 'main']);
  assert.deepEqual(work.pullRequest, { number: 4, url: 'https://github.com/acme/project/pull/4' });
  assert.deepEqual(publication.description, { conformant: true, reasons: [] });
  // Opening the draft never ends the Ticket or the Work; the tracker is never written; nothing else runs.
  assert.equal(work.result, 'open');
  assert.equal(h.github.calls.filter(call => call.method === 'postComment').length, 0);
  await h.cycles(3);
  assert.equal(h.activations().length, 2, 'no further activation after the link');
  assert.deepEqual(publicationOf(await h.work()).discoveries.map(item => [item.trigger, item.outcome]), [['verified', 'absent'], ['after-publication', 'linked']]);
  // Discovery reads (admission's own reads name no branch) correlate the Ticket and the Work's own branch.
  const reads = h.github.calls.filter(call => call.method === 'findPublication').map(call => call.args as { knownBranches: string[]; issueNumbers: number[] })
    .filter(read => read.knownBranches.length);
  assert.ok(reads.length >= 2 && reads.every(read => JSON.stringify(read.knownBranches) === JSON.stringify([work.branch]) && read.issueNumbers[0] === 3));
});

test('AC2: a completed Execution without a verified content is never published; nothing is requested and no write grant is issued', async t => {
  for (const [verification, content, reason] of [[undefined, { clean: false, headMatches: false }, 'VERIFIED_CONTENT_NOT_COMMITTED'],
    [{ status: 'not-verified' as const, reasons: ['GATE_FAILED:t1'] }, undefined, 'REVIEW_NOT_VERIFIED']] as const) {
    const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'complete' }]);
    await h.implemented(verification, content);
    await h.settle(async () => publicationOf(await h.work())?.state === 'not-publishable', 'not publishable');
    await h.cycles(3);
    assert.ok(publicationOf(await h.work()).reasons.includes(reason));
    assert.equal(h.activations().length, 1);
    assert.equal(h.github.calls.filter(call => call.method === 'findPublication' && (call.args as { knownBranches: string[] }).knownBranches.length).length, 0, 'not even discovered');
    assert.ok(!h.execution.calls.some(call => call.kind === 'issue' && call.detail === 'builder-publish'));
    await h.stop();
  }
  // Without any review record at all (reviews not composed): never success by itself.
  const h = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'complete' }]);
  await h.start();
  await h.settle(async () => publicationOf(await h.work())?.state === 'not-publishable', 'not publishable');
  assert.deepEqual(publicationOf(await h.work()).reasons, ['REVIEWS_NOT_RECORDED']);
});

test('AC6: after cessation with a LOST result (worker failure + owner restart) the own publication is discovered and linked, never repeated', async t => {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const h = await harness(t, remote, [{ kind: 'complete' }, { kind: 'publish', publish: publishOwn(), end: 'failure' }]);
  await h.implemented();
  await h.settle(async () => (await h.work()).execution?.request.publication !== undefined && (await h.work()).execution!.end?.cessation === 'confirmed', 'publication ended');
  assert.equal((await h.work()).execution!.end!.outcome, 'failure');
  assert.equal(publicationOf(await h.work()).state, 'awaiting-discovery', 'an attempt is never requested again; only a discovery decides');
  // Owner restart between the effect and its recording: the next owner discovers before anything else.
  await h.stop();
  await h.start();
  await h.settle(async () => publicationOf(await h.work()).state === 'published', 'linked after restart');
  await h.cycles(2);
  assert.equal(h.activations().length, 2, 'the push/PR were never repeated');
  assert.deepEqual(publicationOf(await h.work()).discoveries.at(-1)!.trigger, 'after-publication');
});

test('AC6: an attempt whose effect is not found, several own candidates or an incomplete read never repeat the publication', async t => {
  // (a) the publication activation published nothing visible: a first empty read never proves absence.
  const nothing = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'complete' }, { kind: 'publish', publish: () => {}, end: 'success' }]);
  await nothing.implemented();
  await nothing.settle(async () => publicationOf(await nothing.work()).state === 'blocked', 'blocked');
  await nothing.cycles(3);
  const blocked = await nothing.work();
  assert.deepEqual(publicationOf(blocked).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_ABSENT']);
  assert.ok(blocked.impediments.some(item => item.code === 'PUBLICATION_BLOCKED'));
  assert.equal(nothing.activations().length, 2);
  await nothing.stop();
  // (b) two own candidates: blocked, none adopted.
  const twice = await harness(t, { pulls: {}, issues: [remoteIssue(3)] }, [{ kind: 'complete' },
    { kind: 'publish', publish: (remote, activation) => { publishOwn()(remote, activation); publishOwn({ number: 5, pullRequestId: 9005, url: 'https://github.com/acme/project/pull/5' })(remote, activation); }, end: 'success' }]);
  await twice.implemented();
  await twice.settle(async () => publicationOf(await twice.work()).state === 'blocked', 'blocked');
  assert.deepEqual(publicationOf(await twice.work()).reasons, ['MULTIPLE_OWN_PULL_REQUESTS:4,5']);
  assert.equal((await twice.work()).pullRequest, null);
  await twice.stop();
  // (c) incomplete reads decide nothing: no request, no activation, until a complete read.
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const partial = await harness(t, remote, [{ kind: 'complete' }, { kind: 'publish', publish: publishOwn(), end: 'success' }]);
  await partial.implemented(undefined, undefined, { restart: false });
  remote.publicationFailure = { code: 'GITHUB_QUERY_FAILED' };
  await partial.start();
  await partial.settle(async () => (publicationOf(await partial.work())?.discoveries.length ?? 0) > 0, 'discovered');
  await partial.cycles(3);
  assert.equal(publicationOf(await partial.work()).state, 'awaiting-discovery');
  assert.deepEqual(publicationOf(await partial.work()).discoveries.map(item => item.outcome), ['incomplete'], 'identical incomplete reads are recorded once');
  assert.equal(partial.activations().length, 1);
  delete remote.publicationFailure;
  await partial.settle(async () => publicationOf(await partial.work()).state === 'published', 'published after a complete read');
});

test('AC4: the expected branch name does not prove authorship; an unknown PR or an unknown change of the branch blocks, nothing is adopted or requested', async t => {
  const humanPull = (workId: string, branch: string) => ownPull(workId, branch, { number: 7, pullRequestId: 9007, url: 'https://github.com/acme/project/pull/7', body: 'my take',
    author: { id: 10, login: 'someone', type: 'User' }, association: ['known-branch'] });
  for (const [label, act, reasons] of [
    ['unknown PR on the expected branch', (remote: Remote, work: WorkView) => { remote.pulls[3] = [humanPull(work.work_id, work.branch!)]; remote.refs = { [work.branch!]: 'e'.repeat(40) }; },
      ['UNKNOWN_PULL_REQUEST:7']],
    ['expected branch at an unknown commit, no PR', (remote: Remote, work: WorkView) => { remote.refs = { [work.branch!]: 'e'.repeat(40) }; }, ['REMOTE_BRANCH_UNKNOWN_CHANGE']],
  ] as const) {
    const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
    const h = await harness(t, remote, [{ kind: 'complete' }]);
    // A human acts on the Work's expected branch before the discovery, while the owner is stopped.
    const implemented = await h.implemented(undefined, undefined, { restart: false });
    act(remote, { work_id: implemented.work_id, branch: implemented.branch } as WorkView);
    await h.start();
    await h.settle(async () => publicationOf(await h.work())?.state === 'blocked', label);
    assert.deepEqual(publicationOf(await h.work()).reasons, reasons, label);
    assert.equal((await h.work()).pullRequest, null, `${label}: nothing is adopted`);
    await h.cycles(2);
    assert.equal(h.activations().length, 1, `${label}: no publication is requested`);
    assert.ok(!h.execution.calls.some(call => call.kind === 'issue' && call.detail === 'builder-publish'));
    await h.stop();
  }
});
