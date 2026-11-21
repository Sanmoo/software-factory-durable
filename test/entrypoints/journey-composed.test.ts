import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { until } from '../runner/budget.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { openControl, type ExecutionPorts, type ListView, type ShowView, type WorkView } from '../../src/control/index.js';
import { composeProductionAccess, composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionBuilderPrompt, productionProfile } from '../../src/entrypoints/release.js';
import type { ReviewOpinion } from '../../src/contracts/index.js';
import { builderToolNames, type BuilderDirective, type HandoffEvent, type Invocation, type WorkerQuestion } from '../../src/workers/index.js';
import { manualClock } from '../control/doubles.js';
import { gate, sessionRef, summary } from '../control/publication-doubles.js';
import { githubWorld, issue, worldScope } from './github-world-fixture.js';

// Ticket 18 composed level (I with substituted VM/model boundaries): ONE owner run of the PRODUCTION composition — `composeProductionAccess`
// (the owner's IssueTracker/CodeRepository/operators/App identity) and `composeProductionExecution` (release profile, derived skill pack,
// multi-round reviews with partial recovery, the REAL Builder credentials, cleanup with the real Records preservation) — over the gh world
// fixture, with only the Sandbox lifecycle/removal and the Workers (Builder + two reviewers) doubled. It carries ONE Ticket from admission
// to delivery and owned cleanup: question → cessation/Slot release → operator answer by comment → recovery through the queue → findings
// treated → verified content → Builder's direct draft publication with ITS grant → required checks → Factory ready conversion → human merge
// (the test edits the fixture as a human would) → delivery → cleanup of the own remote branch. Dublê não comprova fronteira substituída.
const head = 'd'.repeat(40), tip = 'b'.repeat(40);
const qid = '0b9c6a52-3d3e-4c8f-9a51-000000000018';
const pullRequestRule = { type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };
const updateRule = { type: 'update', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };
const model = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
const repository = { ...worldScope, correctionLimit: 3, recoveryLimit: 3 };
const effective = { models: { builder: model, standards: model, spec: model }, repositories: [repository], dependencyRepositories: [], operators: ['operator-one'],
  concurrency: 1, sandbox: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' } };

function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

/** Scripted Builder (three activations) and reviewers; Sandbox lifecycle and own-environment removal. Never a VM, worker process or model. */
function journeyDoubles(executable: string) {
  const calls: { kind: string; detail?: unknown }[] = [];
  const builders: Invocation[] = [];
  const captures = new Map<number, HandoffEvent>();
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  let branchOf: string | undefined;
  const receipt = (invocation: Invocation) => ({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId } });
  const sandbox: ExecutionPorts['sandbox'] = {
    async prepare(input) {
      calls.push({ kind: 'prepare' });
      return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [{ name: 'factory/skill-pack/factory-skills-v6', manifestSha256: 'f'.repeat(64), reused: false }],
        checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
          baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: calls.filter(call => call.kind === 'prepare').length > 1, preparedAt: new Date().toISOString() } };
    },
    async start() { calls.push({ kind: 'start' }); return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never }; },
    async stop() { calls.push({ kind: 'stop' }); return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }; },
    async observeProposal(input) {
      const event = captures.get(input.round);
      return { status: 'observed', sha256: event?.status === 'captured' ? event.summary.content!.sha256 : 'x', indexSha256: event?.status === 'captured' ? event.summary.indexSha256 : '',
        entries: 1, consistent: true, observedAt: new Date().toISOString() };
    },
    async observe() { return { condition: 'stopped', cessationConfirmed: true }; },
  };
  const opinion = (invocation: Invocation): ReviewOpinion => {
    // Spec keeps finding S1 (a Rollback section the Ticket does not ask for); Standards is clean.
    const findings = invocation.context.role === 'spec' ? [{ id: 'S1', basis: 'requirement' as const, reference: '/artifacts/spec/v1/ticket.json#body',
      location: { path: '/workspace/checkout/docs/a.md' }, summary: 'Missing Rollback section?' }] : [];
    return { version: 1, role: invocation.context.role as 'spec', round: invocation.review!.round, attempt: 1, invocationId: invocation.context.invocationId,
      reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' }, session: { file: `/run/w-${invocation.context.role}/s.jsonl`, mode: 'new', from: null, code: null },
      model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
      input: { handoffIndexSha256: invocation.review!.handoffIndexSha256, required: [...invocation.review!.required], missing: [...invocation.review!.missing] },
      conclusion: findings.length ? 'findings' : 'clean', code: null, coverage: { scope: 'broad', justification: 'all', examined: [] }, findings, limitations: [],
      hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: new Date().toISOString() };
  };
  const workers: ExecutionPorts['workers'] = {
    async activate(invocation, delivery, events) {
      const role = invocation.context.role;
      if (role !== 'builder') {
        calls.push({ kind: `review-${role}`, detail: invocation.review!.round });
        return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)),
          completed: Promise.resolve({ status: 'success' as const, receipt: receipt(invocation).receipt, opinion: opinion(invocation) }), close() {} };
      }
      builders.push(invocation);
      calls.push({ kind: 'builder', detail: { phaseId: invocation.context.phaseId, purpose: delivery?.credential ? 'credential' : null } });
      const session = sessionRef(builders.length);
      if (invocation.context.phaseId === 'builder-publication') {
        // The Builder publishes DIRECTLY with ITS builder-publish grant: own branch at the verified commit, then one draft PR.
        const workId = /Work ([0-9a-f-]{36})/.exec(invocation.prompt)![1]!;
        const branch = /your branch (\S+);/.exec(invocation.prompt)![1]!;
        const verified = /verified commit ([0-9a-f]{40})/.exec(invocation.prompt)![1]!;
        const token = delivery?.credential?.token ?? '';
        const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the smoke page. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
        const completed = (async () => {
          calls.push({ kind: 'push', detail: await builderGh(executable, token, '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: verified }) });
          calls.push({ kind: 'pr', detail: await builderGh(executable, token, '/repos/acme/project/pulls', { title: 'Factory smoke', head: branch, base: 'main', body, draft: true }) });
          return { status: 'success' as const, receipt: receipt(invocation).receipt, session };
        })();
        return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)), completed, close() {} };
      }
      // The initial prompt names the Work branch; a recovery prompt keeps the same Work branch.
      const branch = branchOf ??= /branch=(\S+)/.exec(invocation.prompt)![1]!;
      const first = invocation.handoff && 'rounds' in invocation.handoff && invocation.handoff.rounds ? invocation.handoff.rounds.first : 1;
      const ask = builders.length === 1;
      // Activation 1: round 1 (gate passed) is reviewed (Spec S1), then the Builder asks whether S1 is a requirement.
      // Activation 2 (recovery after the answer): a new review round, then S1 not adopted under the answered Question's authorization, then closing.
      const queue: HandoffEvent[] = ask ? [{ round: first, status: 'captured', summary: summary(first, head, branch, true), declarations: { treatments: [], gates: [gate('passed')] } }]
        : [{ round: first, status: 'captured', summary: summary(first, head, branch, true), declarations: { treatments: [], gates: [gate('passed')] } },
          { round: first + 1, status: 'captured', summary: summary(first + 1, head, branch, true), declarations: { gates: [gate('passed')], treatments: [{ round: first, role: 'spec',
            findingId: 'S1', outcome: 'not-adopted', justification: 'The operator answered that the Ticket does not require it.', evidence: null,
            authorization: { kind: 'question', questionId: qid } }] } },
          { round: first + 2, status: 'captured', summary: summary(first + 2, head, branch, true), closing: true }];
      for (const event of queue) captures.set(event.round, event);
      let finish!: (value: 'done' | 'ask') => void;
      const done = new Promise<'done' | 'ask'>(resolve => { finish = resolve; });
      let waiting: Promise<BuilderDirective> | null = null;
      const completed = done.then(async outcome => {
        if (outcome === 'done') return { status: 'success' as const, receipt: receipt(invocation).receipt, session };
        const text = 'Spec finding S1 asks for a Rollback section; is it a requirement of the Ticket?';
        const question: WorkerQuestion = { questionId: qid, question: text, context: '', sha256: createHash('sha256').update(JSON.stringify({ question: text, context: '' })).digest('hex'),
          reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' } };
        const ack = await events!.question!(question);
        calls.push({ kind: 'question', detail: ack.status });
        return { status: 'question' as const, receipt: receipt(invocation).receipt, question: { ...question, acknowledged: ack.status === 'recorded' }, session };
      });
      return { worker: invocation.context.invocationId, started: Promise.resolve(receipt(invocation)), completed, close() {},
        handoffs: { async next() {
          if (waiting) { const directive = await waiting; if (directive.end) { finish('done'); return null; } }
          const event = queue.shift();
          if (!event) { finish(ask ? 'ask' : 'done'); return null; }
          waiting = new Promise(resolve => { delivered = resolve; });
          return event;
        } } };
    },
    async deliver(_worker, directive) {
      calls.push({ kind: `deliver-${directive.kind}` });
      if (directive.kind === 'review-results') { delivered?.(directive); return { status: 'delivered' as const }; }
      return { status: directive.kind === 'credential' ? 'delivered' as const : 'withdrawn' as const };
    },
    async observe(input) { return { session: { state: 'compatible' as const, session: input.session }, limitations: [] }; },
  };
  const remove: NonNullable<ExecutionPorts['cleanup']>['remove'] = async input => {
    calls.push({ kind: 'remove', detail: input.environment });
    return { status: 'success', resources: (['disk', 'workspace', 'artifacts', 'runtime'] as const).map(resource => ({ resource, status: 'removed' as const })) };
  };
  return { sandbox, workers, remove, calls, builders };
}

test('production Builder prompt is per session mode and names ONLY the tools that session has (no handoff in a publish-only session)', () => {
  const policies = { skillPack: 'factory-skills-v6', copyOutput: true, editSourceMaxBytes: 8192 };
  const sessions = { implementation: { phaseId: 'builder-initial', tools: builderToolNames({ ...policies, handoff: true }) },
    // Ticket 14 publish-only policies: no edit tool, never a handoff (dispatch.ts publicationPolicies).
    publication: { phaseId: 'builder-publication', tools: builderToolNames({ skillPack: policies.skillPack, copyOutput: true, handoff: false }) },
    // v2 ticket 07: the session a preservation gate refusal is returned to (full Builder tools, never a handoff).
    preservation: { phaseId: 'builder-preservation', tools: builderToolNames({ ...policies, handoff: false }) },
    // v2 ticket 09: the swap notice continues the working session without the handoff tool.
    swapNotice: { phaseId: 'builder-swap-notice', tools: builderToolNames({ ...policies, handoff: false }) } };
  const named = (prompt: string) => ['write', 'bash', 'read', 'edit', 'ask_user', 'handoff'].filter(tool =>
    new RegExp(`\\b${tool}\\b|the ${tool} tool`).test(prompt) || (tool === 'handoff' && /hand ?off/i.test(prompt)));
  for (const [mode, session] of Object.entries(sessions)) {
    const prompt = productionBuilderPrompt(session);
    assert.deepEqual(named(prompt).filter(tool => !session.tools.includes(tool)), [], `${mode} prompt names a tool its session lacks`);
  }
  assert.equal(productionBuilderPrompt(sessions.implementation), productionProfile.prompts.builder);
  assert.equal(productionBuilderPrompt(sessions.publication), productionProfile.prompts.builderPublication);
  assert.equal(productionBuilderPrompt(sessions.preservation), productionProfile.prompts.builderPreservation);
  assert.match(productionProfile.prompts.builderPreservation, /Never commit secrets[\s\S]*report the impediment/);
  assert.equal(productionBuilderPrompt(sessions.swapNotice), productionProfile.prompts.builderSwapNotice);
  assert.match(productionProfile.prompts.builderSwapNotice, /planned boot swap[\s\S]*Never commit secrets[\s\S]*you continue the work afterwards/);
  assert.match(productionProfile.prompts.builderPublication, /publish-only session the Factory requested/);
  assert.match(productionProfile.prompts.builderPublication, /Never merge, approve, mark ready/);
  assert.match(productionProfile.prompts.builder, /Never push, open pull requests/);
  assert.doesNotMatch(productionProfile.prompts.builder, /EXCEPT|publication/, 'the implementation session never publishes');
  // The mode is the activation phase Control sets, never message text; any other combination has no production prompt (refused before launch).
  assert.throws(() => productionBuilderPrompt({ phaseId: 'builder-publication', tools: sessions.implementation.tools }), /BUILDER_SESSION_MODE_UNSUPPORTED/);
  assert.throws(() => productionBuilderPrompt({ phaseId: 'builder-initial', tools: sessions.publication.tools }), /BUILDER_SESSION_MODE_UNSUPPORTED/);
  assert.throws(() => productionBuilderPrompt({ phaseId: 'builder-reconciliation', tools: sessions.implementation.tools }), /BUILDER_SESSION_MODE_UNSUPPORTED/, 'no prompt for a mode not yet defined');
  for (const phaseId of ['builder-recovery', 'builder-continuation']) assert.equal(productionBuilderPrompt({ phaseId, tools: sessions.implementation.tools }), productionProfile.prompts.builder);
});

test('ticket 18 AC2-AC5/AC7 composed: one owner run of the production composition carries ONE Ticket from admission to delivery and owned cleanup', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md. Validation: test -f docs/FACTORY_SMOKE.md' })], pulls: [], refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      // As on the real test repository today: `update` (Restrict updates) is active on main, so a merge needs a bypass (ticket 39).
      rules: { main: [pullRequestRule, updateRule] },
      checkRuns: { [head]: [] }, statuses: { [head]: [] }, compare: { [`${tip}...${head}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const composed = await composeProductionExecution({ root: world.root, effective, guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const doubles = journeyDoubles(world.executable);
  // Substituted boundaries ONLY: VM lifecycle and agents. Credentials, reviews policy, builder policy, capacity and evidence preservation stay production.
  const ports: ExecutionPorts = { ...composed.ports, sandbox: doubles.sandbox, workers: doubles.workers, cleanup: { ...composed.ports.cleanup!, remove: doubles.remove } };
  const dir = await mkdtemp(join(tmpdir(), 'factory-journey-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: ports,
    access: composeProductionAccess({ github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const describe = async () => { const last = await work(); return JSON.stringify({ held: last?.execution?.held, end: last?.execution?.end, phase: last?.execution?.dispatch.phase,
    impediments: last?.impediments, publication: last?.publication, readiness: last?.readiness, cleanup: last?.cleanup, result: last?.result, calls: doubles.calls.map(call => call.kind) }); };
  // Bounded by the runner budget (ticket 37), never an iteration count; the manual polling clock advances whenever the owner sleeps.
  let lastSeen = '';
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => until(() => `${label} ${lastSeen}`, async () => {
    const value = await work();
    if (predicate(value)) return value!;
    lastSeen = await describe();
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);

  // AC2: admission, queue, start receipt, preserved request; the question ends the activation, the Slot is released after cessation.
  const asked = await settle('question', value => value?.execution?.end?.outcome === 'question' && !value.execution.slot.held);
  assert.equal(asked.execution!.end!.cessation, 'confirmed');
  assert.ok(asked.execution!.start?.receiptId, 'start receipt consumed');
  assert.deepEqual(asked.impediments.map(item => item.code), ['QUESTION_PENDING']);
  const published = await until('question published', async () => {
    const shown = await control.inspect({ kind: 'show', work_id: asked.work_id }) as Extract<ShowView, { kind: 'work' }>;
    if (shown.questions[0]?.publication.state === 'published') return shown.questions[0];
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);
  assert.equal(published.questionId, qid);
  // The operator answers on the Ticket (a configured operator's strict /factory comment), never the agent.
  await world.update(state => { state.comments = [...(state.comments ?? []), { id: 70001, issue: 3, body: `/factory answer ${qid} Not required: keep the Rollback section out.`,
    user: { id: 9, login: 'operator-one', type: 'User' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]; });

  // AC2/AC3: recovery through the queue; reviews; S1 not adopted under the answer; verified content; direct draft publication; checks.
  // AC7 / ticket 39: with `update` active the journey STOPS at an explained, confirmed impediment: never ready, nothing converted, no bypass.
  const blocked = await settle('merge-blocked', value => value?.readiness?.latest?.reasons.some(item => item.code === 'MERGE_BLOCKED_UPDATE_RESTRICTED'));
  assert.equal(blocked.publication?.state, 'published', JSON.stringify(blocked.publication?.reasons));
  assert.deepEqual([blocked.readiness!.internal, blocked.readiness!.flag.factory, blocked.readiness!.effects.length], ['not-ready', 'draft', 0]);
  assert.match(blocked.readiness!.nextStep, /\(UPDATE_RESTRICTED\)\. Operator: adjust the base protection/);
  assert.equal((await world.trace()).filter(entry => entry.endpoint === 'graphql').length, 0, 'no conversion while the merge needs a bypass');
  // The operator adjusts the protection (removes Restrict updates); the next readiness evaluation is a new basis and converts.
  await world.update(state => { state.checks!.rules = { main: [pullRequestRule] }; });
  const ready = await settle('ready', value => Boolean(value?.readiness?.effects.some(item => item.action === 'mark-ready' && item.state === 'confirmed')));
  assert.equal(ready.publication?.state, 'published', JSON.stringify(ready.publication?.reasons));
  assert.equal(ready.pullRequest?.number, 4);
  assert.deepEqual([ready.readiness!.internal, ready.readiness!.flag.observed], ['ready', 'ready']);
  assert.deepEqual(ready.impediments, []);
  const executions = [...ready.previousExecutions, ready.execution!];
  assert.deepEqual(executions.map(item => [item.mode, item.end?.outcome, item.end?.cessation, item.request.resume?.reason ?? null]),
    [['initial', 'question', 'confirmed', null], ['recovery', 'completed', 'confirmed', 'QUESTION_ANSWERED'], ['recovery', 'completed', 'confirmed', 'PUBLICATION_REQUESTED']]);
  const implementation = executions[1]!;
  assert.deepEqual([implementation.review!.verification!.status, implementation.review!.verification!.treatments],
    ['verified', [{ round: 2, role: 'spec', findingId: 'S1', outcome: 'not-adopted' }]]);
  assert.equal(executions[2]!.credential?.purpose, 'builder-publish');
  // Ticket 18 real run q18-v3: the publish-only activation never relies on the guest-writable checkout's `origin` (it had none there):
  // Control's instruction names the CONFIGURED repository URL, authenticated by the delivered builder-publish grant only.
  const publishing = doubles.builders.find(item => item.context.phaseId === 'builder-publication')!;
  assert.ok(publishing.prompt.includes(`push --force-with-lease=refs/heads/${ready.branch}: https://github.com/acme/project.git ${head}:refs/heads/${ready.branch}`));
  assert.match(publishing.prompt, /git ls-remote https:\/\/github\.com\/acme\/project\.git/);
  assert.doesNotMatch(publishing.prompt, /\borigin\b/);
  assert.deepEqual(doubles.calls.filter(call => call.kind === 'builder').map(call => (call.detail as { phaseId: string }).phaseId),
    ['builder-initial', 'builder-continuation', 'builder-publication']);
  const shownReady = await control.inspect({ kind: 'show', work_id: ready.work_id }) as Extract<ShowView, { kind: 'work' }>;
  assert.equal(shownReady.questions[0]!.state, 'answered');
  assert.equal(ready.result, 'open', 'ready is not delivery');

  // AC4: a HUMAN merges (the fixture changes as GitHub would); the controller observes, records the delivery and cleans up only its own resources.
  await world.update(state => { const own = state.pulls.find(item => item.number === 4)!; own.state = 'closed'; own.merged_at = '2026-11-15T12:00:00Z'; });
  const delivered = await settle('cleanup complete', value => value?.result === 'delivered' && value.cleanup?.state === 'complete');
  assert.deepEqual(delivered.cleanup!.resources.map(item => [item.kind, item.state]).sort(), 
    [['checkout', 'removed'], ['environment', 'removed'], ['local-branch', 'removed'], ['remote-branch', 'removed'], ['temporaries', 'removed']]);
  assert.equal(doubles.calls.filter(call => call.kind === 'remove').length, 1, 'only the own environment');
  const status = await control.inspect({ kind: 'status' }) as { delivery: unknown };
  assert.deepEqual(status.delivery, { delivered: 1, cleanup: { waiting: 0, pending: 0, complete: 1 } });

  // AC5 (CLI/history link): the Work view links Ticket, Executions/roles, Question/answer, opinions, PR, delivery and cleanup.
  const shown = await control.inspect({ kind: 'show', work_id: delivered.work_id }) as Extract<ShowView, { kind: 'work' }>;
  assert.equal(shown.work.ticket.number, 3);
  assert.equal(shown.work.pullRequest?.number, 4);
  assert.ok(shown.work.history.length > 0);

  // The only GitHub writes: the Question comment, the Builder's push + draft PR, ONE controller ready conversion, ONE own-branch atomic deletion.
  const trace = await world.trace();
  const writes = trace.filter(entry => entry.method !== 'GET' && !entry.endpoint.includes('access_tokens') && entry.endpoint !== '/installation/token');
  assert.deepEqual(writes.map(entry => entry.endpoint), ['/repos/acme/project/issues/3/comments', '/repos/acme/project/git/refs', '/repos/acme/project/pulls', 'graphql', '/graphql']);
  assert.match(writes[3]!.body!, /markPullRequestReadyForReview/);
  assert.match(writes[4]!.body!, /updateRefs/);
  assert.doesNotMatch(JSON.stringify(trace), /merge"|\/merge|approve|addPullRequestReview/i, 'the Factory never merges or approves');
  const finalWorld = JSON.parse(JSON.stringify(await (async () => { let snapshot: unknown; await world.update(state => { snapshot = state; }); return snapshot; })())) as { refs: Record<string, string> };
  assert.deepEqual(Object.keys(finalWorld.refs), [], 'own branch deleted, nothing else');
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
