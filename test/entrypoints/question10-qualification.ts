import type { ExecutionPorts, ExecutionView, ListView, QuestionView, ShowView } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';

// TEST ONLY. Ticket 10 one-shot real qualification recipe: durable Question, cessation, answer by comment while the controller is DOWN,
// and resumption through the queue. Import and `--plan` are inert. Every other phase is a REAL effect and requires an explicit operator
// grant: real GitHub (App), a real Gondolin/KVM VM and a real model. Phases are one-shot (exclusive intent tombstone before effects; a
// consumed phase never reruns); nothing is retried automatically. GitHub writes: at most ONE Question comment per phase, only on Ticket #3.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q10-question-v1`;
const revision = 'q10-question-v1';
const phases = ['preflight', 'ask', 'resume', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
/** Only these GitHub accounts' strict `/factory answer` comments on Ticket #3 can answer (case-insensitive login, human accounts). */
const operators = ['Sanmoo'];
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const phaseDeadlineMs = 45 * 60 * 1000;
const systemPrompt = 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. ' +
  'Never push, open pull requests, change GitHub state, request broader access or use another credential. When you need information or an ' +
  'approval you do not have, use the ask_user tool instead of working around it.';

export function plan() {
  return { revision, root, observations, phases, repository, expectedTicket, operators, configuration, guestAssets,
    model: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', auth: 'factory-oauth (operator first-login store under root/credentials)',
      budget: 'builder-v1', maxActivations: 2, perActivation: { maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30 }, providerRetries: 0, sdkRetries: 0, providerBillingHardCap: false },
    github: { app: githubApp, controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}',
      'question-publish {metadata:read, issues:write}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only',
      writes: 'at most ONE POST /repos/Sanmoo/java-springboot-event-sourcing/issues/3/comments per phase (ask, resume): the Question comment with its marker; no label/assignee/state change' },
    operatorStep: 'between `ask` and `resume`, with the controller STOPPED: post on issue #3, from an account in `operators`, ONE comment whose body starts exactly with `/factory answer <question-id> <answer>` (question id in ask-result.json)',
    effects: [
      'preflight: read-only GitHub: the configured label lists exactly Ticket #3; Ticket, native blocked_by and its comment listing are read',
      'ask: Control (new storage under observations) polls every 30 s; reserves ONE Execution; fetch+clone, skill pack seed, Sandbox.prepare/start (1 new VM), revalidation, Builder grant, Workers.activate (1 Builder, /implement); the Builder is expected to call ask_user; Control commits Question+impediment+intent, ACKs, waits for the end, Sandbox.stop, releases the Slot only after cessation, publishes ONE comment on #3; Control stops when the Execution is stopped and the publication settled, or at 45 min',
      'resume: same storage; refused unless the ask Execution ended with confirmed cessation; polling reads the comments of #3 (the answer posted while the controller was down), accepts it once, removes only its impediment; dispatch revalidates and starts ONE recovery Execution (prepare reuses the same environment/branch, NEW boot, explicit recovery instruction); waits for its end/stop or 45 min. A second question (insufficient answer) is published (1 comment) and ends the phase',
      'inspect: read-only: storage view (Works, Executions, Questions), comment listing of #3, confined no-follow reads of /artifacts, checkout via a Factory-owned bare copy, start receipts, secret scan of the own storage',
      'stop-environment: own boot of the current Execution when it may still run and is observed active: public Sandbox.stop of that exact boot',
    ],
    guards: ['one-shot intent tombstones', 'per phase: prepare <= 1, activate <= 1, postComment <= 1 and only for Ticket #3', 'no retry', 'no remove/cleanup', 'no push/PR (read-only Builder grant)'],
    expected: ['ask: execution.end.outcome question, end.cessation confirmed, slot released; Question recordedFrom worker-notification, publication published with a comment URL on #3; Work held by QUESTION_PENDING at its queue position',
      'resume: answer accepted from the operator comment (author id/login, comment id); QUESTION_PENDING removed; second Execution mode recovery with request.resume naming the first Execution and the answer hash; one new boot; end and Slot release after cessation',
      'no token in storage/receipts/sessions/observations; the Builder never pushes'],
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  return { fs, save, load, exists };
}

/** One Question comment per phase, only on Ticket #3; every other tracker operation is read-only and passes through. */
export function guardTracker(tracker: IssueTracker, events: unknown[]): IssueTracker {
  let posted = 0;
  return { readInputs: (ticket, cursor) => tracker.readInputs(ticket, cursor), findQuestion: (ticket, questionId) => tracker.findQuestion(ticket, questionId),
    checkAccess: scope => tracker.checkAccess(scope), listCandidates: scope => tracker.listCandidates(scope), readTicket: ticket => tracker.readTicket(ticket),
    readDependencyGraph: ticket => tracker.readDependencyGraph(ticket),
    async postComment(ticket, comment, effect) {
      events.push({ at: new Date().toISOString(), call: 'postComment', ticket: ticket.number, questionId: comment.questionId, effectId: effect.effectId });
      if (++posted !== 1 || ticket.number !== expectedTicket.number || ticket.repositoryId !== expectedTicket.repositoryId) {
        return { kind: 'failed', observedAt: new Date().toISOString(), code: 'RECIPE_ONE_SHOT_GUARD', nextStep: 'Recipe allows one Question comment per phase on #3.' };
      }
      const result = await tracker.postComment(ticket, comment, effect);
      events.push({ at: new Date().toISOString(), call: 'postComment-result', result });
      return result;
    } };
}

async function compose(events: unknown[]) {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = guardTracker(createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), events);
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

/** The recipe's own boot may still run unless the Execution was released or ended with confirmed cessation. */
export function needsStop(execution: ExecutionView): boolean {
  if (!execution.dispatch.boot || execution.state === 'released') return false;
  return !(execution.state === 'ended' && execution.end?.cessation === 'confirmed');
}

/** Phase end: the phase's Execution left reserved/started (held/released or stopped), and no Question publication is still in flight. */
export function settled(list: ListView, questions: QuestionView[], executionsBefore: number): boolean {
  const work = list.works.find(item => item.ticket.number === expectedTicket.number);
  const execution = work?.execution;
  if (!work || !execution || work.previousExecutions.length < executionsBefore) return false;
  const stopped = ['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped');
  return stopped && questions.every(question => question.state !== 'open' || !['intended', 'attempting'].includes(question.publication.state));
}

async function runControl(phase: 'ask' | 'resume', save: (name: string, data: unknown) => Promise<void>) {
  const events: unknown[] = [];
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose(events);
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, builderSkillPack } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: builderSkillPack.seedName, directory: builderSkillPack.directory }] });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', systemPrompt,
    auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses' } });
  const credentials = createBuilderCredentials({ github, repositories: [repository] });
  let prepared = 0, activated = 0;
  const holder: { control?: Awaited<ReturnType<typeof openControl>> } = {};
  const allowed = async (workId: string) => {
    const shown = await holder.control!.inspect({ kind: 'show', work_id: workId });
    return 'work' in shown && shown.work.ticket.number === expectedTicket.number && shown.work.ticket.repositoryId === expectedTicket.repositoryId;
  };
  const execution: ExecutionPorts = { configuration, capacity: 1, credentials, builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        events.push({ at: new Date().toISOString(), call: 'prepare', workId: input.workId, checkout: input.checkout });
        if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
        const result = await sandbox.prepare(input);
        events.push({ at: new Date().toISOString(), call: 'prepare-result', result });
        return result;
      },
      async start(input) { const result = await sandbox.start(input); events.push({ at: new Date().toISOString(), call: 'start', result }); return result; },
      async stop(input) { const result = await sandbox.stop(input); events.push({ at: new Date().toISOString(), call: 'stop', input, result }); return result; },
    },
    workers: { async activate(invocation, delivery, handlers) {
      events.push({ at: new Date().toISOString(), call: 'activate', context: invocation.context, prompt: invocation.prompt, credentialDelivered: delivery?.credential !== undefined });
      if (++activated !== 1) throw new Error('RECIPE_ONE_SHOT_GUARD');
      return workers.activate(invocation, delivery, { question: async question => {
        events.push({ at: new Date().toISOString(), call: 'question', questionId: question.questionId, sha256: question.sha256 });
        const ack = await handlers!.question!(question);
        events.push({ at: new Date().toISOString(), call: 'question-ack', ack });
        return ack;
      } });
    } } };
  const control = holder.control = await openControl({ storagePath: `${observations}/control.sqlite`,
    // Recipe decision: root/environments holds only earlier qualification resources (q05/q06/q09) and, for `resume`, this storage's own
    // environment whose boot ceased (checked before opening); none is running for this storage.
    runtimeInventory: 'empty',
    access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [], operators }, polling: { intervalSeconds: 30 }, execution });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + phaseDeadlineMs;
  const before = phase === 'ask' ? 0 : 1;
  // resume: without an accepted answer nothing dispatches; give up after ~5 polling minutes instead of idling for the whole deadline.
  const answerDeadline = Date.now() + 5 * 60 * 1000;
  let final: ListView | undefined;
  let questions: QuestionView[] = [];
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const list = await control.inspect({ kind: 'list' }) as ListView;
    const work = list.works.find(item => item.ticket.number === expectedTicket.number);
    questions = work ? (await control.inspect({ kind: 'show', work_id: work.work_id }) as Extract<ShowView, { kind: 'work' }>).questions : [];
    if (activated > 0 && settled(list, questions, before)) { final = list; break; }
    if (phase === 'resume' && activated === 0 && Date.now() > answerDeadline) { events.push({ at: new Date().toISOString(), call: 'answer-not-observed' }); final = list; break; }
  }
  final ??= await control.inspect({ kind: 'list' }) as ListView;
  const status = await control.inspect({ kind: 'status' });
  stop.abort();
  const outcome = await running;
  const open = questions.filter(question => question.state === 'open').map(question => ({ questionId: question.questionId, comment: question.publication.comment,
    publication: question.publication.state, answerWith: `/factory answer ${question.questionId} <answer>` }));
  await save(`${phase}-result`, { status: 'observed', outcome, final, questions, open, controlStatus: status, events, deadlineReached: Date.now() >= deadline });
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { tracker } = await compose([]);
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId) { await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD'); }
      const ticket = await tracker.readTicket(listing.candidates[0]!);
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      const inputs = await tracker.readInputs(listing.candidates[0]!, null);
      await save('preflight-result', { status: 'success', ticket, graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems },
        comments: inputs.kind === 'observed' ? { completeness: inputs.completeness, count: inputs.comments.length, cursor: inputs.cursor } : inputs });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'ask') { await runControl('ask', save); return; }
    if (phase === 'resume') {
      if (!(await exists('ask-result'))) throw new Error('ASK_REQUIRED');
      const asked = await load('ask-result');
      const work = (asked.final as ListView).works.find(item => item.ticket.number === expectedTicket.number);
      if (!work?.execution || work.execution.end?.outcome !== 'question' || needsStop(work.execution)) throw new Error('ASK_EXECUTION_NOT_CEASED_WITH_QUESTION');
      await runControl('resume', save);
      return;
    }
    // Authority is the recipe's own storage (not the phase results, which a crash could prevent): read-only inspect, then closed.
    const { openControl } = await import('../../src/control/index.js');
    const stored = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' }) as ListView;
    const work = list.works.find(item => item.execution);
    const shown = work ? await stored.inspect({ kind: 'show', work_id: work.work_id }) as Extract<ShowView, { kind: 'work' }> : undefined;
    const stop = new AbortController(); stop.abort();
    await stored.run(stop.signal);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
    if (phase === 'inspect') {
      const { inspectEnvironment } = await import('./builder09-qualification.js');
      const { tracker } = await compose([]);
      const comments = await tracker.readInputs(work.ticket, null);
      const receipts: Record<string, string | null> = {};
      for (const execution of [...work.previousExecutions, work.execution]) {
        if (execution.start) receipts[execution.executionId] = await fs.readFile(`${root}/${work.work_id}/evidence/${execution.start.receiptId}/output`, 'utf8').then(text => text.slice(0, 65536), () => null);
      }
      const storage = Buffer.concat(await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => fs.readFile(`${observations}/${name}`).catch(() => Buffer.alloc(0)))));
      await save('inspect-result', { work, questions: shown?.questions ?? [], receipts,
        comments: comments.kind === 'observed' ? comments.comments.map(item => ({ id: item.commentId, author: item.author, viaApp: item.viaApp, url: item.url, firstLine: item.body.split('\n')[0]!.slice(0, 200) })) : comments,
        secretScan: { ghs: storage.includes(Buffer.from('ghs_')), privateKey: storage.includes(Buffer.from('PRIVATE KEY')) },
        ...await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined) });
      return;
    }
    // stop-environment: only the recipe's own current boot, in any state where it may still run.
    if (!needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q10 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held; no retry.'); process.exit(1); });
}
