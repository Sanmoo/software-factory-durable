import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../runner/budget.js';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { openControl, type ExecutionPorts, type ListView, type UsageView, type WorkView } from '../../src/control/index.js';
import { composeProductionAccess, composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import type { ReviewOpinion } from '../../src/contracts/index.js';
import { createSandbox, type LambdaWorkerLauncher, type ReadResult, type ToolCall } from '../../src/sandbox/index.js';
import { manualClock } from '../control/doubles.js';
import { gate, summary } from '../control/publication-doubles.js';
import { accountClock, accountImageWait, lambdaAccountFake } from '../sandbox/lambda-service-fake.js';
import { lambdaGuestFake, type FakeGuest } from '../sandbox/lambda-guest-fake.js';
import { githubWorld, issue, worldScope } from './github-world-fixture.js';

// v2 ticket 06, composed level: ONE owner run of the PRODUCTION composition with the Lambda adapter selected, over the in-memory AWS account
// (`lambda-service-fake.ts`), the in-process guest behind the channel seam (`lambda-guest-fake.ts`) and the gh world fixture. Real:
// Control, Pi Durable, SQLite, the Lambda adapter (image, boot, channel, boot owner, role-bound tools, channel observations, evidence
// collection, Remove), the Workers facade and the Builder credentials. Substituted: the AWS account, the guest, and the WORKER PROCESS
// (agent SDK + model), scripted here through the same owner endpoint, tool endpoint and notifications a real worker uses.
// No AWS call, no ssh/websocat, no VM, no model. Dublê não comprova fronteira substituída.
const tip = 'b'.repeat(40), first = 'c'.repeat(40), head = 'd'.repeat(40);
const remoteUrl = 'https://github.com/acme/project.git';
const pullRequestRule = { type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };
const model = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
const repository = { ...worldScope, correctionLimit: 3, recoveryLimit: 3 };
const effective = { models: { builder: model, standards: model, spec: model }, repositories: [repository], dependencyRepositories: [], operators: ['operator-one'],
  concurrency: 1, sandbox: { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' } };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** What the Builder's `gh`/`git` do at GitHub with the token of their process environment (the gh world fixture answers). */
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

/**
 * The scripted worker processes of the journey. Each one is what the boot owner launches for an invocation: it reports its start, uses
 * ONLY the tool endpoint the owner bound for it (so every effect goes owner -> channel -> guest as its role), notifies handoffs and ends.
 * The guest's shell commands are handlers on the fake guest, registered by exact text.
 */
function scriptedWorkers(input: { root: string; executable: string; guests: ReturnType<typeof lambdaGuestFake> }) {
  const launched: { role: string; phaseId: string; prompt: string; pushPolicy: unknown; handoff: boolean; boot: string }[] = [];
  const effects: { kind: string; detail?: unknown }[] = [];
  const commands = input.guests.world.commands;
  const launcher: LambdaWorkerLauncher = async (request, endpoint, signal, _secrets, _relay, onHandoff = () => {}) => {
    const context = request.context;
    launched.push({ role: context.role, phaseId: context.phaseId, prompt: request.prompt, pushPolicy: request.pushPolicy ?? null, handoff: request.handoff !== undefined, boot: context.bootRef });
    const receipt = { workId: context.workId, id: randomUUID() };
    const tools = createSandbox({ root: input.root, toolEndpoint: endpoint });
    let calls = 0;
    const call = (tool: Record<string, unknown>): Promise<ReadResult> => tools.executeTool(context, { callId: `call-${calls += 1}`, ...tool } as ToolCall, () => {}, signal);
    const bash = async (command: string, handler: (guest: FakeGuest, environment: Record<string, string>) => number | Promise<number>) => {
      commands[command] = (guest, run) => handler(guest, run.environment);
      const result = await call({ name: 'bash', command });
      effects.push({ kind: `bash:${context.role}:${command.split(' ').slice(0, 3).join(' ')}`, detail: result.status });
      return result;
    };
    const read = async (path: string) => {
      const capture = await call({ name: 'read', operation: 'capture', path });
      effects.push({ kind: `read:${context.role}`, detail: capture.status === 'success' ? path : capture.code });
      return capture.status === 'success';
    };
    const started = Promise.resolve({ receipt, invocation: { executionId: context.executionId, invocationId: context.invocationId } });
    if (context.role !== 'builder') {
      const review = request.review!;
      const completed = (async () => {
        // A reviewer reads the proposal with its own read-only binding (the `reviewer` user of the guest); it has no other tool.
        const readable = await read('/workspace/checkout/docs/FACTORY_SMOKE.md');
        const denied = await call({ name: 'bash', command: 'git status' });
        effects.push({ kind: `reviewer-bash:${context.role}`, detail: denied.status === 'failure' ? denied.code : denied.status });
        // Round 1: Spec finds the page lacks its Validation line; round 2 (the fix) is clean for both.
        const findings = context.role === 'spec' && review.round === 1 && readable ? [{ id: 'S1', basis: 'requirement' as const, reference: '/artifacts/spec/v1/ticket.json#body',
          location: { path: '/workspace/checkout/docs/FACTORY_SMOKE.md' }, summary: 'The page does not state its validation.' }] : [];
        const opinion: ReviewOpinion = { version: 1, role: context.role as 'spec', round: review.round, attempt: 1, invocationId: context.invocationId,
          reference: { workId: context.workId, id: randomUUID() }, session: { file: `/run/w-${context.role}/s.jsonl`, mode: 'new', from: null, code: null },
          model: { providerId: 'openai', modelId: 'gpt-6-luna' }, profile: { id: 'p', modelBudget: 'reviewer-v1' },
          input: { handoffIndexSha256: review.handoffIndexSha256, required: [...review.required], missing: [...review.missing] },
          conclusion: findings.length ? 'findings' : 'clean', code: null, coverage: { scope: 'broad', justification: 'all', examined: [] }, findings, limitations: [],
          hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] }, finalMessageSha256: null, recordedAt: new Date().toISOString() };
        return { status: 'success' as const, receipt, opinion: opinion as unknown as Record<string, never> };
      })();
      return { started, completed, deliver: async () => false };
    }
    if (context.phaseId === 'builder-publication') {
      // The publish-only Builder runs the ONE leased push of its instruction and then `gh pr create`, each as its own command; the
      // token is the one of its process environment in the guest (never an argument, never a guest file).
      const workId = /Work ([0-9a-f-]{36})/.exec(request.prompt)![1]!;
      const branch = /your branch (\S+);/.exec(request.prompt)![1]!;
      const verified = /verified commit ([0-9a-f]{40})/.exec(request.prompt)![1]!;
      const push = /^(git -C \/workspace\/checkout push --force-with-lease=\S+ \S+ \S+)$/m.exec(request.prompt)![1]!;
      const body = [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the smoke page. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
      const completed = (async () => {
        await bash(push, async (guest, environment) => {
          effects.push({ kind: 'push', detail: { head: guest.repository?.commit, status: await builderGh(input.executable, environment.GH_TOKEN ?? '', '/repos/acme/project/git/refs', { ref: `refs/heads/${branch}`, sha: verified }) } });
          return 0;
        });
        await bash(`gh pr create --repo acme/project --draft --base main --head ${branch} --title "Factory smoke" --body-file /artifacts/publication/pr-body.md`, async (guest, environment) => {
          // v2 ticket 07: the publication leaves a scratch file in the checkout (untracked, not ignored): the preservation gate must see it.
          guest.worktree.untracked = 1;
          effects.push({ kind: 'pr', detail: await builderGh(input.executable, environment.GH_TOKEN ?? '', '/repos/acme/project/pulls', { title: 'Factory smoke', head: branch, base: 'main', body, draft: true }) });
          return 0;
        });
        return { status: 'success' as const, receipt };
      })();
      return { started, completed, deliver: async () => false };
    }
    if (context.phaseId === 'builder-preservation') {
      // v2 ticket 07: the Builder the preservation gate returned a refusal to: it removes the leftover and ends its turn.
      const completed = (async () => {
        await bash('rm -f /workspace/checkout/pr-body.tmp', guest => { guest.worktree.untracked = 0; return 0; });
        return { status: 'success' as const, receipt };
      })();
      return { started, completed, deliver: async () => false };
    }
    // The implementation Builder: implements, hands off (round 1), treats Spec's finding with a fix (round 2), then the closing capture.
    const branch = /branch=(\S+)/.exec(request.prompt)![1]!;
    const firstRound = request.handoff?.rounds?.first ?? 1;
    let delivered: ((directive: Record<string, unknown>) => void) | undefined;
    const directive = () => new Promise<Record<string, unknown>>(resolve => { delivered = resolve; });
    /** The Host's handoff capture, as a Builder-bound command in the guest: it writes the round index and reports its summary. */
    const capture = async (round: number, commit: string, page: string, extra: object) => {
      let indexSha256 = '';
      await bash(`factory-handoff-capture ${round}`, guest => {
        guest.repository = { ...guest.repository!, commit };
        guest.files.set('/workspace/checkout/docs/FACTORY_SMOKE.md', page);
        guest.files.set('/artifacts/spec/v1/sources.json', JSON.stringify({ sources: [{ copy: './ticket.json' }] }));
        guest.files.set('/artifacts/spec/v1/ticket.json', '{"body":"Add docs/FACTORY_SMOKE.md"}');
        const index = JSON.stringify({ round, head: commit, branch, counts: { entries: 1 }, entries: [{ path: 'docs/FACTORY_SMOKE.md', present: true, kind: 'file', sha256: sha(page) }] });
        guest.files.set(`/artifacts/review/r${round}/index.json`, index);
        indexSha256 = sha(index);
        return 0;
      });
      const wait = directive();
      onHandoff({ round, status: 'captured', summary: { ...summary(round, commit, branch, true), indexSha256, base: request.handoff!.baseCommit, mergeBase: request.handoff!.baseCommit }, ...extra });
      return wait;
    };
    const completed = (async () => {
      const one = await capture(firstRound, first, '# Factory smoke\n', { declarations: { treatments: [], gates: [gate('passed')] } });
      if (!one.end) {
        const two = await capture(firstRound + 1, head, '# Factory smoke\n\nValidation: test -f docs/FACTORY_SMOKE.md\n', { declarations: { gates: [gate('passed')], treatments: [{ round: firstRound, role: 'spec',
          findingId: 'S1', outcome: 'fixed', justification: 'Added the validation line.', evidence: null, authorization: null }] } });
        if (!two.end) await capture(firstRound + 2, head, '# Factory smoke\n\nValidation: test -f docs/FACTORY_SMOKE.md\n', { closing: true });
      }
      return { status: 'success' as const, receipt };
    })();
    return { started, completed, deliver: async next => { const resolve = delivered; delivered = undefined; resolve?.(next); return resolve !== undefined; } };
  };
  return { launcher, launched, effects };
}

test('v2 ticket 06: with the Lambda adapter, a Work without external waits goes from the Ticket to its draft PR in ONE boot of the production composition, then Stop and Remove', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md. Validation: test -f docs/FACTORY_SMOKE.md' })], pulls: [],
    refs: {}, rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [pullRequestRule] },
      checkRuns: { [head]: [] }, statuses: { [head]: [] }, compare: { [`${tip}...${head}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } } } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  // `origin` accepts the reduced installation token the host mints for the clone (one per start), never a fixed secret of the guest.
  const cloneTokens: string[] = [];
  guests.world.origins[remoteUrl] = { commits: [tip], token: token => { cloneTokens.push(token); return token.startsWith('synthetic-installation-secret-'); },
    // v2 ticket 07: `ls-remote` from the guest answers what the gh world holds for the branch at that instant.
    tip: async branch => { let sha: string | null = null; await world.update(state => { sha = state.refs?.[branch] ?? null; }); return sha; } };
  const clock = accountClock(fake);
  const workers = scriptedWorkers({ root: world.root, executable: world.executable, guests });
  const composed = await composeProductionExecution({ root: world.root, effective, guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github,
    lambda: { service: fake.service, transport: guests.transport, clock, imageWait: accountImageWait(clock), workerLauncher: workers.launcher } });
  assert.equal(composed.status, 'composed', JSON.stringify(composed));
  if (composed.status !== 'composed') return;
  const ports: ExecutionPorts = composed.ports;
  // Control decides from the declared capabilities only; the adapter's profile never reaches it.
  assert.deepEqual([ports.sandbox.capabilities?.persistentDisk, ports.sandbox.capabilities?.docker, ports.configuration], [false, true, null]);
  const dir = await mkdtemp(join(tmpdir(), 'factory-lambda-journey-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: ports,
    access: composeProductionAccess({ github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  let lastSeen = '';
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => until(() => `${label} ${lastSeen}`, async () => {
    const value = await work();
    if (predicate(value)) return value!;
    lastSeen = JSON.stringify({ held: value?.execution?.held, end: value?.execution?.end, phase: value?.execution?.dispatch.phase, impediments: value?.impediments,
      publication: value?.publication && { state: value.publication.state, reasons: value.publication.reasons }, verification: value?.execution?.review?.verification,
      launched: workers.launched.map(item => `${item.role}:${item.phaseId}`), effects: workers.effects });
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);

  const published = await settle('published', value => value?.publication?.state === 'published');
  const executions = [...published.previousExecutions, published.execution!];
  assert.equal(executions.length, 1, 'Builder, reviews, treatment of the finding and the push are ONE Execution');
  const execution = executions[0]!;
  // Stop confirmed cessation BEFORE the Slot was released.
  assert.deepEqual([execution.end?.outcome, execution.end?.cessation, execution.slot.held], ['completed', 'confirmed', false]);
  assert.deepEqual(fake.account.microvms.map(microvm => microvm.state), ['TERMINATED'], 'one MicroVM for the whole journey, ended by the service');
  // Everything ran in the SAME boot, with no checkpoint between the Builder and the reviewers.
  assert.deepEqual(workers.launched.filter(item => item.role === 'builder').map(item => item.phaseId), ['builder-initial', 'builder-publication', 'builder-preservation']);
  assert.equal(new Set(workers.launched.map(item => item.boot)).size, 1);
  assert.deepEqual(workers.launched.filter(item => item.role !== 'builder').map(item => item.role).sort(), ['spec', 'spec', 'standards', 'standards'], 'two review rounds: the proposal, then the fix');
  // Reviews of standards and spec, the finding and its treatment, verified by Control.
  assert.deepEqual([execution.review!.verification!.status, execution.review!.verification!.treatments], ['verified', [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed' }]]);
  // Decision 1A: the review identity was computed in the guest by the fixed host-run program, before and after each round.
  const guest = guests.guestOf(fake.account.microvms[0]!.microvmId)!;
  const programs = guest.executions.map(item => item.program);
  assert.equal(programs.filter(name => name === 'proposal-identity').length >= 4, true, programs.join(','));
  assert.deepEqual([...new Set(guest.executions.filter(item => item.program === 'proposal-identity').map(item => item.user))], ['builder']);
  // The reviewers ran as the read-only user and had no other tool.
  assert.deepEqual(workers.effects.filter(effect => effect.kind.startsWith('reviewer-bash')).map(effect => effect.detail), ['BASH_ROLE_DENIED', 'BASH_ROLE_DENIED', 'BASH_ROLE_DENIED', 'BASH_ROLE_DENIED']);
  assert.equal(workers.effects.filter(effect => effect.kind.startsWith('read:')).every(effect => effect.detail === '/workspace/checkout/docs/FACTORY_SMOKE.md'), true);
  // The clone happened IN the guest, from `origin`, at the commit Control read there, with a reduced credential that never stayed anywhere.
  assert.deepEqual([execution.request.baseCommit, execution.origin?.startCommit, execution.origin?.atStart], [tip, tip, { state: 'absent' }]);
  // One reduced credential for the clone and one for each `ls-remote` of the preservation gate (two checks), each revoked after its use.
  assert.equal(cloneTokens.length, 3);
  assert.deepEqual(guest.executions.filter(item => item.program === 'clone').map(item => item.environmentNames), [['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']]);
  assert.equal([...guest.files].some(([, content]) => cloneTokens.some(token => content.includes(token))), false, 'no credential in a guest file');
  // v2 ticket 07 (V2-05..V2-09): before the boot ended for the waits on GitHub, the gate ran IN the guest (fixed program, as the Builder user,
  // credential only in its environment, never in its text). It refused the leftover file, the refusal went back to the Builder in the same
  // boot with the one fast-forward push allowed, and only the accepted gate let the MicroVM be terminated. The confirmed commit is on the Work.
  const gates = guest.executions.filter(item => item.program === 'preservation-gate');
  assert.deepEqual(gates.map(item => [item.user, item.environmentNames]), [['builder', ['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']], ['builder', ['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']]]);
  assert.equal(gates.some(item => cloneTokens.some(token => item.script.includes(token))), false);
  assert.deepEqual(execution.preservationGate?.attempts.map(item => [item.outcome, item.code, item.commit ?? null, item.correction?.status ?? null]),
    [['refused', 'WORKSPACE_UNTRACKED', null, 'completed'], ['accepted', null, head, null]]);
  assert.deepEqual([published.preservation?.commit, published.preservation?.occasion, published.preservation?.boot], [head, 'ci-wait', execution.dispatch.boot]);
  const preserving = workers.launched.find(item => item.phaseId === 'builder-preservation')!;
  assert.deepEqual(preserving.pushPolicy, { branch: published.branch, head, expected: null, remote: remoteUrl, wip: true });
  assert.match(preserving.prompt, /does not authorize committing secrets/);
  assert.equal(programs.lastIndexOf('preservation-gate') < programs.indexOf('collect-artifacts'), true, 'the gate precedes the stop');
  // The skill pack reached the guest of this boot.
  assert.equal([...guest.files.keys()].some(path => path.startsWith(`/artifacts/${execution.request.skillPack!.name}/`) && path.endsWith('/manifest.json')), true);
  // The same-boot publication: the Builder pushed exactly the verified commit and opened ONE draft PR, with the Execution's own write grant.
  assert.deepEqual(workers.effects.filter(effect => effect.kind === 'push' || effect.kind === 'pr').map(effect => effect.detail), [{ head, status: 201 }, 201]);
  assert.equal(execution.credential?.purpose, 'builder-publish');
  const publishing = workers.launched.find(item => item.phaseId === 'builder-publication')!;
  assert.deepEqual(publishing.pushPolicy, { branch: published.branch, head, remote: remoteUrl, expected: null });
  // Final review, must-fix 2 (V2-07): the working Builder may publish work in progress at any time, with the one unforced push of HEAD.
  assert.deepEqual(workers.launched.find(item => item.phaseId === 'builder-initial')!.pushPolicy, { branch: published.branch, head: tip, expected: null, remote: remoteUrl, wip: true });
  assert.deepEqual([published.publication!.verified!.head, published.publication!.pullRequest?.headSha, published.publication!.pullRequest?.draft], [head, head, true]);
  assert.deepEqual(published.publication!.attempts!.map(item => item.executionId), [execution.executionId]);
  // No workspace on the host and no mounted bare cache; no checkpoint other than the Git remote.
  const entries = await readdir(world.root);
  assert.equal(entries.includes('environments') || entries.includes('cache'), false, entries.join(','));
  // v2 ticket 12: the loss marker holder follows the Builder's grant: armed at each delivery, ended at each withdrawal.
  assert.deepEqual([...new Set(programs)].sort(), ['artifact-seed', 'boot-ready', 'clone', 'collect-artifacts', 'evidence', 'loss-marker-arm', 'loss-marker-disarm', 'preservation-gate', 'proposal-identity', 'tool']);
  // The boot ended by a requested Stop with no holder left: its terminate hook has nothing to trigger, so a normal end leaves no marker ref.
  assert.equal(guest.lossMarker, null);
  assert.deepEqual([...new Set(guest.executions.filter(item => item.program.startsWith('loss-marker-')).map(item => item.user))], ['builder']);
  assert.equal(guest.executions.filter(item => item.program === 'loss-marker-arm').every(item => item.environmentNames.includes('FACTORY_GIT_TOKEN')), true);
  assert.deepEqual([...new Set(fake.mutations.map(mutation => mutation.operation))].sort(), ['createImage', 'putBuildArtifact', 'runMicrovm', 'terminateMicrovm']);
  // Decision 2c: the evidence was collected over the channel BEFORE the stop, into the protected Records of the Work.
  const environment = execution.dispatch.environment!, boot = execution.dispatch.boot!;
  const record = JSON.parse(await readFile(join(world.root, 'lambda', 'works', environment, 'boots', boot, 'boot.json'), 'utf8')) as { phase: string; end: { reason: string };
    artifacts: { status: string; reference: { id: string; files: number } } };
  assert.deepEqual([record.phase, record.end.reason, record.artifacts.status, record.artifacts.reference.files], ['ended', 'end', 'preserved', 5]);
  const evidence = join(world.root, published.work_id, 'evidence', record.artifacts.reference.id, 'files');
  assert.deepEqual((await readdir(evidence)).sort(), ['review', 'spec']);
  assert.equal(await readFile(join(evidence, 'spec', 'v1', 'ticket.json'), 'utf8'), '{"body":"Add docs/FACTORY_SMOKE.md"}');

  // Remove (V2-02, partial): nothing is left running; the host runtime of the boot goes, the removal is recorded, branch and PR are untouched.
  const before = await world.trace();
  const cleanup = { workId: published.work_id, workDisposition: 'delivered' as const, confirmed: true as const, evidencePreserved: true as const };
  assert.deepEqual(await ports.cleanup!.preserve({ workId: published.work_id, environment: environment as never }), { status: 'absent' });
  assert.deepEqual(await ports.cleanup!.remove({ environment: environment as never, cleanup }),
    { status: 'success', resources: [{ resource: 'disk', status: 'absent' }, { resource: 'workspace', status: 'absent' }, { resource: 'artifacts', status: 'absent' }, { resource: 'runtime', status: 'removed' }] });
  const removal = JSON.parse(await readFile(join(world.root, 'lambda', 'works', environment, 'removal.json'), 'utf8')) as { workId: string; boots: string[] };
  assert.deepEqual([removal.workId, removal.boots], [published.work_id, [boot]]);
  assert.deepEqual((await world.trace()).length, before.length, 'Remove made no GitHub request');
  let refs: Record<string, string> = {};
  await world.update(state => { refs = { ...state.refs }; });
  assert.deepEqual(refs, { [published.branch!]: head }, 'the Work branch stays where the Builder pushed it');
  // v2 ticket 14 (V2-32): the Work's consumption is the service's own seconds of its boot, still shown after Remove, next to tokens and budgets.
  const microvm = fake.account.microvms[0]!;
  const usage = await control.inspect({ kind: 'usage' }) as UsageView;
  const consumed = usage.works[0]!.boots!;
  assert.deepEqual([consumed.unit, consumed.seconds, consumed.measured, consumed.unknown, consumed.lowerBound, consumed.measurement],
    ['microvm-seconds', (microvm.terminatedAt! - microvm.startedAt) / 1000, 1, 0, false, 'complete']);
  assert.deepEqual(consumed.items.map(item => [item.boot, item.begin, item.end, item.size, item.startedAt, item.endedAt]),
    [[boot, 'start', 'end', '4096 MiB / 2 vCPU (baseline 1024 MiB)', new Date(microvm.startedAt).toISOString(), new Date(microvm.terminatedAt!).toISOString()]]);
  // Remove deleted the environment's `image.json` (v2 ticket 15): the build of the key stays in the ledger, and no Work holds the key any more.
  const imageKey = (JSON.parse((await readFile(join(world.root, 'lambda', 'image-builds.jsonl'), 'utf8')).split('\n')[0]!) as { key: string }).key;
  assert.ok(usage.environmentBuilds?.status === 'reported');
  assert.deepEqual(usage.environmentBuilds.keys.map(entry => [entry.key, entry.builds, entry.works, entry.last.outcome]), [[imageKey, 1, 0, 'created']]);
  assert.doesNotMatch(JSON.stringify(usage.works[0]!.boots) + JSON.stringify(usage.environmentBuilds), /usd|dollar|price|cost/i);
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
