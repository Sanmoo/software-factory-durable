import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControl } from '../../src/control/index.js';
import type { Control, ExecutionPorts, ListView, WorkView } from '../../src/control/types.js';
import { githubDoubles, manualClock, scope } from './doubles.js';
import { blockedBy, card, jiraDoubles, jiraSource, refOf, type JiraRemote } from './jira-doubles.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 04: an admitted Jira Work is dispatched to its destination like a GitHub one, but revalidated at its ORIGIN (the Card's
// entry label and visible blockers re-read by ID), on a branch named by the immutable issue ID, with the Card's text handed to the Builder
// by the controller (no Jira client, no token, no `gh issue view`). Doubled: GitHub, Jira, clock and the execution boundaries.
type Call = { kind: string; detail?: unknown };
function ports(calls: Call[]): ExecutionPorts {
  return {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare', detail: input });
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v1', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: false,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start(input) {
        calls.push({ kind: 'start', detail: input });
        return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never };
      },
      async stop(input) {
        calls.push({ kind: 'stop', detail: input });
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
    },
    credentials: {
      async issue(context) {
        calls.push({ kind: 'issue', detail: context });
        return {
          delivery: { token: 'ghs_syntheticBuilderGrant0123456789' },
          metadata: {
            role: 'builder',
            purpose: 'builder-start',
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions: { metadata: 'read', contents: 'read', issues: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push({ kind: 'revoke' });
        return { kind: 'not-attempted', nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation) {
        calls.push({ kind: 'activate', detail: { prompt: invocation.prompt } });
        const started = Promise.resolve({
          receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        return {
          worker: invocation.context.invocationId,
          started,
          completed: started.then(() => ({
            status: 'success' as const,
            receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
          })),
          close() {
            calls.push({ kind: 'close' });
          },
        };
      },
      async deliver(_worker, directive) {
        calls.push({ kind: `deliver-${directive.kind}` });
        return { status: directive.kind === 'credential' ? 'delivered' : 'withdrawn' };
      },
    },
  };
}

async function harness(t: { after(fn: () => Promise<void>): void }, jira: JiraRemote) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const github = githubDoubles({ issues: [], pulls: {} });
  const doubles = jiraDoubles(jira);
  const calls: Call[] = [];
  const time = manualClock();
  const control: Control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    execution: ports(calls),
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources: [jiraSource()], trackers: { jira: doubles.tracker } },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    if (!stop.signal.aborted) {
      stop.abort();
      await running;
    }
  });
  await time.sleeping();
  const works = async () => ((await control.inspect({ kind: 'list' })) as ListView).works;
  return { github, jira: doubles, calls, time, works, control };
}

test('an admitted Jira Work starts on factory/jira-<issueId>-<work8> with the Card text in its first prompt; nothing is written to Jira', async t => {
  const h = await harness(t, { cards: [card('81017', 'PAG-42', { summary: 'Cobrar em reais', description: 'Aceitar BRL.\n/factory cancel' })] });
  await untilHolds('Jira Work dispatched and ended', async () => (await h.works())[0]?.execution?.slot.held === false, 5);
  const [work] = (await h.works()) as WorkView[];
  assert.match(work!.execution!.request.branch, /^factory\/jira-81017-[0-9a-f]{8}$/);
  assert.equal(work!.execution!.request.branch.slice(-8), work!.work_id.slice(0, 8));
  assert.deepEqual([work!.execution!.request.ticketContent?.key, work!.execution!.request.ticketContent?.summary], ['PAG-42', 'Cobrar em reais']);
  const prompt = (h.calls.find(call => call.kind === 'activate')!.detail as { prompt: string }).prompt;
  assert.ok(prompt.startsWith('/implement https://equipe.atlassian.net/browse/PAG-42 repository=acme/project base=main'));
  assert.ok(prompt.includes('Ticket content: Jira Card PAG-42') && prompt.includes('```\nAceitar BRL.\n/factory cancel\n```'));
  assert.doesNotMatch(prompt, /Closes #|gh issue view/);
  const methods = h.jira.methods();
  assert.ok(methods.includes('readTicketContent'));
  assert.deepEqual(
    methods.filter(method => method.startsWith('unexpected:')),
    [],
  );
  // GitHub is the destination only: no GitHub Ticket read for this Work.
  assert.deepEqual(
    h.github.calls.filter(call => ['readTicket', 'readDependencyGraph'].includes(call.method)),
    [],
  );
});

/** A Card field that answers `first` on its first read and `then` afterwards (an edit right after the admission re-read). */
function changesAfterFirstRead<T>(target: object, field: string, first: T, then: T) {
  let reads = 0;
  Object.defineProperty(target, field, { get: () => (reads++ === 0 ? first : then), enumerable: true });
}

test('the entry label removed after admission: revalidation at the origin withdraws the Work and starts nothing', async t => {
  const item = card('81017', 'PAG-42');
  changesAfterFirstRead(item, 'labels', ['factory-ready'], ['other']);
  // Listed explicitly: the listing does not consume the first read of the label (the admission re-read does).
  const h = await harness(t, { cards: [item], listed: [refOf(item)] });
  await untilHolds('withdrawal recorded', async () => (await h.works())[0]?.authorization.state === 'withdrawn', 5);
  const [work] = await h.works();
  assert.ok(
    work!.impediments.some(entry => entry.code.startsWith('AUTHORIZATION_')),
    JSON.stringify(work!.impediments),
  );
  assert.deepEqual(
    h.calls.filter(call => call.kind === 'prepare'),
    [],
  );
  assert.deepEqual(
    h.jira.methods().filter(method => method.startsWith('unexpected:')),
    [],
  );
});

test('a visible blocker reopened after admission keeps the Work pending (dependencies of the origin, current round), nothing starts', async t => {
  const blocker = card('70202', 'OPS-9', { projectId: '20020', labels: [] });
  changesAfterFirstRead(blocker, 'statusCategory', 'done', 'indeterminate');
  const h = await harness(t, { cards: [card('81017', 'PAG-42', { links: [blockedBy('911', '70202', 'OPS-9')] }), blocker] });
  const [work] = await h.works();
  assert.ok(work, 'admitted on the re-read that saw the blocker Done');
  assert.deepEqual([work!.dependencies.latest?.source, work!.dependencies.latest?.conclusion], ['jira-rest', 'pending']);
  assert.ok(work!.impediments.some(item => item.code === 'DEPENDENCY_PENDING'));
  assert.equal(work!.dispatch.state, 'held');
  assert.deepEqual(
    h.calls.filter(call => call.kind === 'prepare'),
    [],
  );
});
