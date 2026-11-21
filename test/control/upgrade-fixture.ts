import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSession, defineDoc, defineDocFamily, type Cursor, type DocumentRecord, type JsonObject } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openControl } from '../../src/control/index.js';
import { openStore } from '../../src/control/durable/store.js';
import { recordRunStart } from '../../src/control/durable/migration.js';
import type { Control, ControlReceipt, ExecutionPorts, ListView, ShowView } from '../../src/control/types.js';
import type { WorkerQuestion } from '../../src/workers/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { untilHolds } from '../runner/budget.js';

// Flow-level fixture (ticket 33): a REAL Control + Pi Durable + SQLite storage holding a Work whose Builder asked a Question (open, published),
// produced through the public Control boundaries with doubled GitHub/Sandbox/Workers/credentials, paused and stopped cleanly. `writeFormatOne`
// re-expresses that exact state as a pre-ticket-33 (format 1) storage: every document value is copied unchanged through the public Pi Durable
// API with version-1 definitions; the installation keeps only its format-1 fields. NOT evidence of a real VM, worker, model or GitHub.
export const questionId = '0b9c6a52-3d3e-4c8f-9a51-000000000033';
const sha = (question: string, context: string) => createHash('sha256').update(JSON.stringify({ question, context })).digest('hex');

function ports(cessation: boolean, live = false): ExecutionPorts {
  let asked = false;
  return {
    configuration: { schemaVersion: 1 },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v2', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    sandbox: {
      async prepare(input) {
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v2', manifestSha256: 'f'.repeat(64), reused: false }],
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
      async start() {
        return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never };
      },
      async stop() {
        return cessation
          ? { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' }
          : { status: 'indeterminate', code: 'STOP_UNCONFIRMED', cessationConfirmed: false };
      },
    },
    credentials: {
      async issue() {
        return {
          delivery: { token: 'synthetic-grant' },
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
        return { kind: 'not-attempted', nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation, _delivery, events) {
        const receipt = { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' };
        const started = Promise.resolve({
          receipt,
          invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
        });
        // `live`: the activation never ends by itself (a Builder still running when the owner stops).
        let end: (value: { status: 'failure'; code: string }) => void = () => {};
        const completed = live
          ? new Promise<{ status: 'failure'; code: string }>(resolve => {
              end = resolve;
            })
          : started.then(async () => {
              if (asked) return { status: 'success' as const, receipt };
              asked = true;
              const question: WorkerQuestion = {
                questionId,
                question: 'Which file name should the doc use?',
                context: 'Ticket names none.',
                sha256: sha('Which file name should the doc use?', 'Ticket names none.'),
                reference: { workId: invocation.context.workId, id: '77777777-2222-4333-8444-555555555555' },
              };
              const ack = await events!.question!(question);
              return { status: 'question' as const, receipt, question: { ...question, acknowledged: ack.status === 'recorded' } };
            });
        return {
          worker: invocation.context.invocationId,
          started,
          completed,
          close() {
            end({ status: 'failure', code: 'WORKER_EXECUTION_UNCERTAIN' });
          },
        };
      },
      async deliver(_worker, directive) {
        return { status: directive.kind === 'credential' ? ('delivered' as const) : ('withdrawn' as const) };
      },
    },
  };
}

/** A storage with one Work waiting on a published open Question and a second Work queued behind it; installation paused; clean stop. */
/** `cessation: false`: the boot of the asking Execution is never confirmed ceased (its Slot stays held: an unsettled activity). */
export async function storageWithPendingQuestion(storagePath: string, options: { cessation?: boolean } = {}) {
  const cessation = options.cessation ?? true;
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3), remoteIssue(4)] };
  const github = githubDoubles(remote);
  const time = manualClock();
  const control: Control = await openControl({
    storagePath,
    runtimeInventory: 'empty',
    execution: ports(cessation),
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const show = async () => ((await control.inspect({ kind: 'list' })) as ListView).works.find(work => work.ticket.number === 3);
  await untilHolds(
    'Question published (and the second Work admitted)',
    async () => {
      const work = await show();
      const question = work
        ? ((await control.inspect({ kind: 'show', work_id: work.work_id })) as Extract<ShowView, { kind: 'work' }>).questions[0]
        : undefined;
      if (question?.publication.state === 'published' && (!cessation || ((await control.inspect({ kind: 'list' })) as ListView).works.length === 2))
        return true;
      if (time.isSleeping()) time.advance();
      return false;
    },
    5,
  );
  const pause = (await control.accept({ request_id: 'pause-before-upgrade', operation: 'pause', origin: 'local-cli' })) as ControlReceipt;
  assert.equal(pause.kind, 'durable');
  const list = (await control.inspect({ kind: 'list' })) as ListView;
  stop.abort();
  // Ticket 26: an earlier Execution ended with unconfirmed cessation is not a live activity of THIS stop (its next boot reconciles it).
  assert.deepEqual(await running, { kind: 'clean' });
  const waiting = list.works.find(work => work.ticket.number === 3)!;
  assert.ok(!cessation || waiting.impediments.some(item => item.code === 'QUESTION_PENDING'), 'the fixture holds a pending Question');
  return { list, waiting, remote };
}

const singletons = ['factory.installation', 'factory.ticket-index', 'factory.slots'];
async function documentsOf(storage: SqliteStorage) {
  const result: { kind: string; key?: string; value: JsonObject; version: number }[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 200, cursor, BACKGROUND_CONTEXT);
    for (const record of page.items as DocumentRecord[]) {
      const stored = (await storage.document(record.id, 'current', BACKGROUND_CONTEXT))!;
      result.push({ kind: record.kind, ...(record.key !== undefined ? { key: record.key } : {}), value: stored.value, version: stored.version });
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return result;
}

/**
 * Copies `source` (any format) into a NEW storage at `target` as format 1, through the public Pi Durable API with version-1 definitions.
 * `extra` adds documents of the given kind/version (used to build incompatible storages). Test fixture only; never a production path.
 */
export async function writeFormatOne(
  source: string,
  target: string,
  extra: { kind: string; version: number; key?: string; value: JsonObject }[] = [],
  omit: string[] = [],
) {
  const from = await SqliteStorage.open(await openNodeSqliteDatabase(source));
  const documents = await documentsOf(from);
  await from.close(BACKGROUND_CONTEXT);
  const session = createSession(await SqliteStorage.open(await openNodeSqliteDatabase(target)));
  const all = [
    ...documents
      .filter(item => !omit.includes(item.kind))
      .map(item => ({
        ...item,
        version: item.kind === 'factory.installation' ? 1 : item.version,
        value: item.kind === 'factory.installation' ? ({ paused: item.value.paused, history: item.value.history } as JsonObject) : item.value,
      })),
    ...extra,
  ];
  for (const item of all) {
    await session.commit(async tx => {
      if (item.key === undefined && (singletons.includes(item.kind) || !item.kind.startsWith('factory.') || item.kind === 'factory.future')) {
        const doc = await tx.doc(
          defineDoc<JsonObject>({ kind: item.kind, version: item.version, scope: 'session', initial: () => ({}), checkpointWhen: () => true }),
        );
        Object.assign(doc, item.value);
      } else {
        const doc = await tx.doc(
          defineDocFamily<JsonObject, null>({
            kind: item.kind,
            version: item.version,
            scope: 'session',
            family: true,
            initial: () => ({}),
            checkpointWhen: () => true,
          }),
          item.key!,
          null,
        );
        Object.assign(doc, item.value);
      }
    }, BACKGROUND_CONTEXT);
  }
  await session.close(BACKGROUND_CONTEXT);
}

/** Ticket 33 + 26: the owner is stopped while its Builder still runs and the boot stop cannot be confirmed: the run ends `uncertain`. */
export async function storageStoppedWithLiveActivity(storagePath: string) {
  const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
  const github = githubDoubles(remote);
  const time = manualClock();
  const control: Control = await openControl({
    storagePath,
    runtimeInventory: 'empty',
    execution: ports(false, true),
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await untilHolds(
    'Builder Execution started',
    async () => {
      const work = ((await control.inspect({ kind: 'list' })) as ListView).works[0];
      if (work?.execution?.state === 'started') return true;
      if (time.isSleeping()) time.advance();
      return false;
    },
    5,
  );
  stop.abort();
  return running;
}

/** One owner run with the execution boundaries composed and a listed (empty) inventory: ticket 26's boot reconciliation runs; clean stop. */
export async function reconcilingRun(storagePath: string) {
  const remote: Remote = { pulls: {}, issues: [] };
  const github = githubDoubles(remote);
  const time = manualClock();
  const control: Control = await openControl({
    storagePath,
    runtimeInventory: 'empty',
    execution: ports(true),
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await time.sleeping();
  const status = (await control.inspect({ kind: 'status' })) as { recovery: unknown };
  stop.abort();
  return { end: await running, recovery: status.recovery };
}

/** The durable state a controller killed right after its start commit leaves behind (no end is ever recorded). */
export async function crashAfterStart(storagePath: string, runId: string) {
  const store = await openStore(storagePath);
  await recordRunStart(store.session, runId);
  await store.close();
}
