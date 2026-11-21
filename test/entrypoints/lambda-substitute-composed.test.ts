import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../runner/budget.js';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { openControl, type ExecutionPorts, type ListView, type WorkView } from '../../src/control/index.js';
import { composeProductionAccess, composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { productionProfile } from '../../src/entrypoints/release.js';
import { createSandbox, type LambdaWorkerLauncher, type ToolCall } from '../../src/sandbox/index.js';
import { manualClock } from '../control/doubles.js';
import { accountClock, accountImageWait, lambdaAccountFake } from '../sandbox/lambda-service-fake.js';
import { lambdaGuestFake, type FakeGuest } from '../sandbox/lambda-guest-fake.js';
import { manualObservationTimer } from '../sandbox/lambda-observation-timer.js';
import { githubWorld, issue, worldScope } from './github-world-fixture.js';

// v2 ticket 13 (V2-17 to V2-19, MANDATORY gate of the spec: the continuity proof failed the absence of the conduct, P2), composed level: ONE
// owner run of the PRODUCTION composition with the Lambda adapter, over the in-memory AWS account, the in-process guest and the gh world
// fixture. Real: Control, Pi Durable, SQLite, the Lambda adapter (boots, channel, boot owner, tools, the watch of the environment, the
// channel report, the usage report, the preservation program's contract, the loss marker holder), the Workers facade, the Question relay
// and the Builder credentials. Substituted: the AWS account, the guest and the WORKER PROCESS, a scripted agent here.
//
// What it shows is the MECHANISM around the substitute session: a loss with a tool call in flight; the Work back through the queue on one
// operational recovery; the package Control hands to the new session (from its own records); the gate before the end of that session's
// activation returning unpublished work to the Builder; the ordinary Question; the answer moving the Work forward. The scripted agent
// does what the conduct says. That a real model follows the conduct (never repeats the effect, concludes, asks) is NOT shown here: it is
// the acceptance campaign's question (ticket 16). Dublê não comprova fronteira substituída.
const tip = 'b'.repeat(40), unpublished = 'd'.repeat(40), concluded = 'e'.repeat(40);
const remoteUrl = 'https://github.com/acme/project.git';
const pullRequestRule = { type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };
const model = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
const repository = { ...worldScope, correctionLimit: 3, recoveryLimit: 3 };
const effective = { models: { builder: model, standards: model, spec: model }, repositories: [repository], dependencyRepositories: [], operators: ['operator-one'],
  concurrency: 1, sandbox: { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme', observationIntervalSeconds: 20 } };
const questionId = '11111111-2222-4333-8444-000000000013';

/** What the Builder's `git push` does at GitHub with the token of its process environment (the gh world fixture answers). */
function builderGh(executable: string, token: string, endpoint: string, body: object): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', endpoint], { env: { PATH: process.env.PATH ?? '', GH_TOKEN: token }, encoding: 'utf8' },
    (_error, stdout) => resolve(Number(/^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1] ?? 0)));
    child.stdin?.end(JSON.stringify(body));
  });
}

test('MANDATORY (V2-17..V2-19): a loss with a tool call in flight; the substitute session gets the package, concludes, is made to publish by the gate and asks about the uncertain effect; the answer moves the Work forward', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md and deploy it.' })], pulls: [], refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [pullRequestRule] }, checkRuns: {}, statuses: {}, compare: {} } });
  const github = createGitHubAccess({ root: world.root, executable: world.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  const pushes: Promise<void>[] = [];
  const origin = guests.world.origins[remoteUrl] = { commits: [tip], token: (token: string) => token.startsWith('synthetic-installation-secret-'),
    push: (ref: string, sha: string) => { pushes.push(world.update(state => { state.factoryRefs = { ...state.factoryRefs, [ref]: sha }; })); },
    tip: async (branch: string) => { let sha: string | null = null; await world.update(state => { sha = state.refs?.[branch] ?? null; }); return sha; } };
  const clock = accountClock(fake);
  const watch = manualObservationTimer(milliseconds => { fake.account.clock.now += milliseconds; });

  const launched: { phaseId: string; boot: string; executionId: string; prompt: string }[] = [];
  const effects: string[] = [];
  let longRunning!: () => void;
  const inLongCommand = new Promise<void>(resolve => { longRunning = resolve; });
  const commands = guests.world.commands;
  commands['git status'] = () => 0;
  // The effect whose result will never arrive: the environment dies under it.
  commands['mvn deploy -DskipTests'] = async (_guest, run) => { effects.push('deploy-started'); longRunning(); await run.disconnected; return 0; };
  const launcher: LambdaWorkerLauncher = async (request, endpoint, signal, _secrets, relay) => {
    const context = request.context;
    const turn = launched.push({ phaseId: context.phaseId, boot: context.bootRef, executionId: context.executionId, prompt: request.prompt });
    const tools = createSandbox({ root: world.root, toolEndpoint: endpoint });
    let calls = 0;
    const bash = async (command: string, handler?: (guest: FakeGuest, environment: Record<string, string>) => number | Promise<number>) => {
      if (handler) commands[command] = (guest, run) => handler(guest, run.environment);
      const result = await tools.executeTool(context, { callId: `call-${turn}-${calls += 1}`, name: 'bash', command } as ToolCall, () => {}, new AbortController().signal);
      effects.push(`${context.phaseId}:${command.split(' ').slice(0, 2).join(' ')}:${result.status === 'success' ? 'success' : result.code}`);
      return result;
    };
    const receipt = { workId: context.workId, id: randomUUID() };
    const started = Promise.resolve({ receipt, invocation: { executionId: context.executionId, invocationId: context.invocationId } });
    const done = (completed: Promise<Awaited<ReturnType<LambdaWorkerLauncher>>['completed'] extends Promise<infer R> ? R : never>) => ({ started, completed, deliver: async () => false });
    if (turn === 1) return done((async () => {
      // The first Builder: it commits work it never pushes and starts a deploy; the environment dies under the deploy.
      await bash('git commit -m note', guest => { guest.repository = { ...guest.repository!, commit: unpublished }; return 0; });
      if (!signal.aborted) await bash('mvn deploy -DskipTests');
      return { status: 'failure' as const, code: 'WORKER_INTERRUPTED' };
    })());
    if (context.phaseId === 'builder-preservation') return done((async () => {
      // The Builder the gate returned the refusal to: the ONE push its instruction names, with the token of its process environment.
      const push = /^- Then publish with exactly this command, ALONE as its own bash call \(any other push is refused\): (git -C \/workspace\/checkout push \S+ HEAD:refs\/heads\/(\S+))$/m.exec(request.prompt)!;
      await bash(push[1]!, async (guest, environment) => {
        origin.commits.push(guest.repository!.commit);
        return await builderGh(world.executable, environment.GH_TOKEN ?? '', '/repos/acme/project/git/refs', { ref: `refs/heads/${push[2]}`, sha: guest.repository!.commit }) === 201 ? 0 : 1;
      });
      return { status: 'success' as const, receipt };
    })());
    if (turn === 2) return done((async () => {
      // The SUBSTITUTE, doing what the conduct says: it does not run the deploy again, concludes the page (a commit), and asks.
      await bash('git status');
      await bash('git commit -m page', guest => { guest.repository = { ...guest.repository!, commit: concluded }; return 0; });
      const question = 'The Factory recorded bash call call-1-2 (mvn deploy -DskipTests) as environment-ended. Was the page deployed? May I repeat the deploy, or take it as done?';
      const asked = { questionId, question, context: '', sha256: createHash('sha256').update(JSON.stringify({ question, context: '' })).digest('hex'), reference: { workId: context.workId, id: randomUUID() } };
      const ack = await relay!.question(asked);
      effects.push(`question:${ack.status}`);
      return { status: 'question' as const, receipt, question: { ...asked, acknowledged: ack.status === 'recorded' } };
    })());
    // After the answer: a new session ends its turn (nothing left that this scenario follows).
    return done((async () => { await bash('git status'); return { status: 'success' as const, receipt }; })());
  };

  const composed = await composeProductionExecution({ root: world.root, effective, guestAssets: { directory: join(world.root, 'guest'), manifestSha256: 'a'.repeat(64) }, github,
    lambda: { service: fake.service, transport: guests.transport, clock, imageWait: accountImageWait(clock), workerLauncher: launcher, observationTimer: watch.timer } });
  assert.equal(composed.status, 'composed', JSON.stringify(composed));
  if (composed.status !== 'composed') return;
  // The persisted recovery wait runs on the calendar: jumped by the test, never slept.
  let calendar = 0;
  const ports: ExecutionPorts = { ...composed.ports, calendar: { now: () => Date.now() + calendar } };
  const dir = await mkdtemp(join(tmpdir(), 'factory-lambda-substitute-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = manualClock();
  const control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty', execution: ports,
    access: composeProductionAccess({ github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const work = async () => ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
  const executions = (value: WorkView | undefined) => [...(value?.previousExecutions ?? []), ...(value?.execution ? [value.execution] : [])];
  let lastSeen = '';
  const settle = (label: string, predicate: (value: WorkView | undefined) => boolean | undefined) => until(() => `${label} ${lastSeen}`, async () => {
    const value = await work();
    if (predicate(value)) return value!;
    lastSeen = JSON.stringify({ state: value?.execution?.state, end: value?.execution?.end, held: value?.execution?.held, phase: value?.execution?.dispatch.phase, impediments: value?.impediments,
      gate: value?.execution?.preservationGate, pending: value?.pendingRecovery, launched: launched.map(item => item.phaseId), effects });
    if (time.isSleeping()) { calendar += 60000; time.advance(); }
    return undefined;
  }, 10);

  // 1. The loss: the Builder is inside the deploy, with an unpushed commit, when the MicroVM dies.
  await settle('started', value => value?.execution?.state === 'started');
  await inLongCommand;
  const first = (await work())!.execution!;
  const workId = (await work())!.work_id;
  const guest = guests.guestOf(fake.account.microvms[0]!.microvmId)!;
  assert.equal(guests.terminateHook(guest.microvmId), true);
  await Promise.all(pushes);
  fake.kill(guest.microvmId, 'MicroVM exceeded maximum lifetime.');
  await watch.expire();
  const lost = await settle('loss recorded', value => value?.losses?.length === 1);
  const markerRef = `refs/factory/lost/${workId}/${first.dispatch.boot}`;
  assert.deepEqual([lost.losses![0]!.boot, lost.losses![0]!.marker.state, lost.losses![0]!.confirmed.commit], [first.dispatch.boot, 'present', null]);

  // 2. The substitute: back through the queue, a new boot, and its activation ends only after the gate accepted what it published.
  const asked = await settle('substitute asked', value => value?.execution?.executionId !== first.executionId && value?.execution?.end?.outcome === 'question' && !value.execution.slot.held);
  const substitute = asked.execution!;
  assert.deepEqual([substitute.interruption?.reason, substitute.interruption?.code, substitute.charge?.kind, substitute.charge?.state], ['OPERATIONAL_RECOVERY', 'SANDBOX_ENVIRONMENT_ENDED', 'recovery', 'consumed']);
  assert.notEqual(substitute.dispatch.boot, first.dispatch.boot);
  assert.equal(fake.account.microvms.length, 2);
  // V2-18: the package, from Control's records. The notice first; then the loss, the boots with their reasons, the uncertain effect the
  // SANDBOX reported for the lost boot, the marker Control read on origin, the consumption, and the conduct.
  const package_ = launched[1]!;
  assert.deepEqual([package_.phaseId, package_.executionId, package_.boot], ['builder-recovery', substitute.executionId, substitute.dispatch.boot]);
  assert.ok(package_.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'), package_.prompt.slice(0, 200));
  assert.ok(package_.prompt.includes('Factory substitute-session package (recovery after a LOSS) for Ticket https://github.com/acme/project/issues/3.'));
  assert.ok(package_.prompt.includes(`LOSS declared by the Factory: the environment of boot ${first.dispatch.boot} (Execution ${first.executionId}) ended on its own at `));
  assert.ok(package_.prompt.includes('(reported: MicroVM exceeded maximum lifetime.)'));
  assert.ok(package_.prompt.includes('Last confirmed commit: none.'));
  assert.match(package_.prompt, new RegExp(`- ${first.dispatch.boot}: began as start, ended as loss \\(\\d+(\\.\\d+)? \\S+\\)`));
  assert.ok(package_.prompt.includes(`- ${substitute.dispatch.boot}: began as start, not ended (this environment)`));
  assert.ok(package_.prompt.includes(`Loss marker ref: ${markerRef} at ${unpublished}`));
  assert.ok(package_.prompt.includes(`- bash (call call-1-2, boot ${first.dispatch.boot}, environment-ended, Execution ${first.executionId}): mvn deploy -DskipTests`), package_.prompt);
  assert.match(package_.prompt, /Accumulated consumption of this Work \(it does not restart with a loss\): 2 Execution\(s\), .* operational recoveries consumed 1 of 3/);
  assert.match(package_.prompt, /1\. NEVER repeat an effect of uncertain result listed above/);
  assert.match(package_.prompt, /No transcript and no summary of the previous session is part of this package/);
  // V2-19.1/.2 as the scripted agent did them: the deploy started exactly once, in the lost boot; the page was concluded.
  assert.equal(effects.filter(entry => entry === 'deploy-started').length, 1);
  // V2-19.4 by mechanism: the gate refused the unpublished commit, returned it to the Builder in the same boot, and only then let the
  // activation end. The Work branch on origin holds what the substitute concluded.
  assert.equal(substitute.preservationGate?.occasion, 'substitute-end');
  assert.deepEqual(substitute.preservationGate?.attempts.map(item => [item.outcome, item.code, item.commit ?? null]), [['refused', 'HEAD_NOT_PUBLISHED', null], ['accepted', null, concluded]]);
  assert.deepEqual(launched.slice(1, 3).map(item => [item.phaseId, item.boot]), [['builder-recovery', substitute.dispatch.boot], ['builder-preservation', substitute.dispatch.boot]]);
  let published: string | undefined;
  await world.update(state => { published = state.refs?.[asked.branch!]; });
  assert.deepEqual([published, asked.preservation?.commit, asked.preservation?.occasion], [concluded, concluded, 'substitute-end']);
  // V2-19.3: an ordinary Question, recorded through the relay; and the MicroVM of the substitute was ended before the wait.
  assert.ok(effects.includes('question:recorded'));
  assert.deepEqual(asked.impediments.map(item => item.code), ['QUESTION_PENDING']);
  assert.deepEqual(fake.account.microvms.map(item => item.state), ['TERMINATED', 'TERMINATED']);

  // 3. The answer moves the Work forward: a new boot from the published commit, with the answer in its first prompt.
  const receipt = await control.accept({ request_id: 'answer-13', operation: 'answer', question_id: questionId, text: 'It was deployed: take it as done.', origin: 'local-cli' });
  assert.equal('outcome' in receipt && receipt.outcome, 'accepted', JSON.stringify(receipt));
  const finished = await settle('resumed and ended', value => value?.execution?.executionId !== substitute.executionId && value?.execution?.end?.outcome === 'completed' && !value.execution.slot.held);
  const resumed = launched.at(-1)!;
  assert.equal(resumed.executionId, finished.execution!.executionId);
  assert.ok(resumed.prompt.startsWith('Factory notice (new boot): this environment was RECREATED'));
  assert.ok(resumed.prompt.includes(`Starting commit: ${concluded}`));
  assert.ok(resumed.prompt.includes('It was deployed: take it as done.'));
  assert.equal(effects.filter(entry => entry === 'deploy-started').length, 1, 'the uncertain effect was never repeated');
  assert.equal(executions(finished).length, 3);
  const shown = await control.inspect({ kind: 'show', work_id: workId });
  assert.equal('work' in shown && shown.work.budget?.recoveries.consumed, 1, 'one operational recovery for the loss; none for the resume after the answer');
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
