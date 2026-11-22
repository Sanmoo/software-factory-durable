import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-durable';
import { inspectStorage, migrateStorage, openControl, StorageFormatError, ticketKey, type StorageInspection } from '../../src/control/index.js';
import type { Control, ControlReceipt, ControlStatus, ForgottenWork, QuestionQueryView, ShowView } from '../../src/control/types.js';
import { comment, githubDoubles, manualClock, scope, ticket } from './doubles.js';
import { questionId, storageWithPendingQuestion, writeFormatTwo } from './upgrade-fixture.js';
import { untilHolds } from '../runner/budget.js';

// Flow level (Jira ticket 02, spec §6.2-6.3): a REAL Control + Pi Durable + SQLite storage holding a published GitHub Question, re-expressed
// as format 2 (every release before the Jira origin) through the public Pi Durable API, plus the minimal memory of a forgotten Work. The
// explicit factory-storage-2-to-3 migration runs on it; then the current Control answers the same Question twice. GitHub and Jira are doubles
// that record every call. NOT evidence of a real VM, worker, model, GitHub or Jira.
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-format3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const storage = (inspection: StorageInspection) => { assert.equal(inspection.kind, 'storage'); return inspection as Extract<StorageInspection, { kind: 'storage' }>; };
const forgottenId = '0f0f0f0f-1111-4222-8333-000000000009';
const forgottenTicket = ticket(9);
const forgotten: ForgottenWork = { work_id: forgottenId, ticket: forgottenTicket, repository: { repository: 'acme/project', repositoryId: 3, base: 'main' },
  cycle: 1, predecessor: null, sequence: 9, result: 'delivered', pullRequest: { number: 90, pullRequestId: 9090, nodeId: 'PR_node90', url: 'https://github.com/acme/project/pull/90' },
  mergeConfirmed: true, mergeConfirmedAt: '2026-11-01T00:00:00.000Z', label: { id: 55, name: 'ready-for-agent' }, questions: [], watch: null,
  forgottenAt: '2026-11-02T00:00:00.000Z', request_id: 'forget-9', planId: 'plan-9',
  scrub: { state: 'scrubbed', attempts: 1, lastAttemptAt: '2026-11-02T00:00:01.000Z', code: null, scrubbedAt: '2026-11-02T00:00:01.000Z' } };
/** The Ticket index after `forget` of #9's delivered cycle: still named by `tickets`, its cycle kept in `memory`, out of `order`. */
const withForgotten = (index: JsonObject) => ({ ...index,
  tickets: { ...(index.tickets as JsonObject), [ticketKey(forgottenTicket)]: { current: forgottenId, previous: [] } },
  memory: { ...((index.memory ?? {}) as JsonObject), [ticketKey(forgottenTicket)]: { cycles: [{ work_id: forgottenId, cycle: 1, result: 'delivered', mergeConfirmed: true }] } },
  forgotten: { ...((index.forgotten ?? {}) as JsonObject), [forgottenId]: forgotten } } as unknown as JsonObject);

/** Every call made to the Jira origin (none is expected: the storage holds GitHub Works only). */
function jiraRecorder() {
  const calls: string[] = [];
  const tracker = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => { calls.push(String(method)); void args; throw new Error('JIRA_NOT_EXPECTED'); } });
  return { calls, tracker: tracker as never };
}

test('format 2 → 3: the explicit migration is one commit that preserves everything; the published GitHub Question is answered once, twice delivered', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite'), path = join(dir, 'control.sqlite');
  const { waiting, list, remote } = await storageWithPendingQuestion(source);
  await writeFormatTwo(source, path, { patch: { 'factory.ticket-index': withForgotten } });
  const before = storage(await inspectStorage(path));
  assert.deepEqual([before.format, before.operational, before.problems], [2, 'migration-required', []]);
  assert.deepEqual(before.documents['factory.installation'], { count: 1, versions: { 2: 1 } });
  assert.deepEqual([before.preserved!.works, before.preserved!.questions], [2, { open: 1, answered: 0 }]);
  // The operational open refuses before any Session exists and writes nothing (no lazy migration).
  await assert.rejects(openControl({ storagePath: path, runtimeInventory: 'unknown' }),
    (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_MIGRATION_REQUIRED');
  assert.deepEqual(storage(await inspectStorage(path)), before);
  const migrated = await migrateStorage(path, { upgradeId: 'up-3', release: 'jira-1', previousRelease: 'mvp-44.1', expectedDigest: before.preserved!.digest });
  assert.deepEqual([migrated.kind, migrated.kind === 'migrated' && migrated.migration], ['migrated', 'factory-storage-2-to-3']);
  const after = storage(await inspectStorage(path));
  assert.deepEqual([after.format, after.operational, after.problems], [3, 'ready', []]);
  assert.deepEqual(after.documents['factory.installation'], { count: 1, versions: { 3: 1 } });
  // Counts, every preserved document (ids, GitHub keys, index and cycle memory after forget, FIFO, cursors, receipts, Questions, PRs, effects) and digest.
  assert.deepEqual(after.preserved, before.preserved);
  assert.deepEqual(Object.fromEntries(Object.entries(after.documents).map(([kind, entry]) => [kind, entry.count])),
    Object.fromEntries(Object.entries(before.documents).map(([kind, entry]) => [kind, entry.count])));
  assert.deepEqual([after.installation!.paused, after.installation!.lifecycle], [before.installation!.paused, before.installation!.lifecycle], 'lifecycle kept, nothing invented');
  assert.deepEqual((after.installation!.migrations as { upgradeId: string; migration: string; from: number; to: number }[]).map(item => [item.upgradeId, item.migration, item.from, item.to]),
    [['up-3', 'factory-storage-2-to-3', 2, 3]]);
  assert.equal((await migrateStorage(path, { upgradeId: 'up-3', release: 'jira-1', previousRelease: 'mvp-44.1', expectedDigest: before.preserved!.digest })).kind, 'already-applied');
  assert.equal((await migrateStorage(path, { upgradeId: 'up-4', release: 'jira-1', previousRelease: 'mvp-44.1' })).kind, 'not-needed');

  // Reopen with GitHub and Jira doubles (no execution: dispatch stays closed). The same answer arrives twice: one comment observed by every
  // polling round and across a restart, and the same local request repeated.
  const github = githubDoubles(remote);
  const jira = jiraRecorder();
  const operator = { id: 501, login: 'Operator-One', type: 'User' };
  remote.comments![3]!.push(comment(`/factory answer ${questionId} Use docs/factory.md`, operator));
  const start = () => {
    const time = manualClock();
    return openControl({ storagePath: path, runtimeInventory: 'unknown', polling: { intervalSeconds: 60, clock: time.clock },
      access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'], trackers: { jira: jira.tracker } } })
      .then(control => ({ control, time }));
  };
  const rounds = async (control: Control, time: ReturnType<typeof manualClock>, count: number) => {
    for (let round = 0; round < count; round++) { await time.sleeping(); time.advance(); }
    await time.sleeping();
    return control;
  };
  const questionOf = async (control: Control) => (await control.inspect({ kind: 'question', question_id: questionId }) as QuestionQueryView);
  for (const run of [1, 2]) {
    const { control, time } = await start();
    const stop = new AbortController();
    const running = control.run(stop.signal);
    await rounds(control, time, 2);
    await untilHolds(`run ${run}: answered`, async () => { const view = await questionOf(control); return view.kind === 'question' && view.question.state === 'answered'; }, 5);
    const repeated = [];
    for (const attempt of [1, 2]) repeated.push(await control.accept({ request_id: 'answer-again', operation: 'answer', question_id: questionId, text: 'Use docs/factory.md', origin: 'local-cli' }) as ControlReceipt);
    assert.deepEqual(repeated[1], repeated[0], 'the same request id returns its recorded result');
    assert.deepEqual(['outcome' in repeated[0]! && repeated[0]!.outcome, 'reason' in repeated[0]! && repeated[0]!.reason], ['not-applied', 'QUESTION_ALREADY_ANSWERED']);
    const shown = await control.inspect({ kind: 'show', work_id: waiting.work_id }) as Extract<ShowView, { kind: 'work' }>;
    assert.deepEqual([shown.work.work_id, shown.work.queue, shown.work.cycle, shown.work.ticket], [waiting.work_id, waiting.queue, waiting.cycle, waiting.ticket]);
    assert.equal(shown.work.history.filter(item => item.event === 'question-answered').length, 1, `run ${run}: one transition`);
    assert.equal(shown.questions[0]!.answer!.text, 'Use docs/factory.md');
    const status = await control.inspect({ kind: 'status' }) as ControlStatus;
    assert.deepEqual([status.storage.format, status.works.total, status.questions.answered], [3, list.works.length, 1]);
    const memory = await control.inspect({ kind: 'show', work_id: forgottenId }) as { kind: string; memory: ForgottenWork };
    assert.deepEqual([memory.kind, memory.memory], ['work-forgotten', forgotten], 'the cycle memory after forget is preserved');
    stop.abort();
    assert.deepEqual(await running, { kind: 'clean' });
  }
  assert.deepEqual(github.calls.filter(call => call.method === 'postComment'), [], 'nothing republished');
  assert.deepEqual(jira.calls, [], 'no Jira call');
  const final = storage(await inspectStorage(path));
  assert.equal(final.preserved!.works, before.preserved!.works, 'no new Work');
  assert.deepEqual(final.preserved!.questions, { open: 0, answered: 1 });
});

test('format 2 storages that are unknown, newer, mixed or not as verified are refused without any write', async t => {
  const dir = await directory(t);
  const source = join(dir, 'source.sqlite');
  await storageWithPendingQuestion(source);
  const cases = [
    { name: 'unknown', options: { extra: [{ kind: 'factory.future', version: 1, value: { anything: true } }] }, code: 'STORAGE_DOCUMENT_UNKNOWN' },
    { name: 'newer', options: { extra: [{ kind: 'factory.work', version: 7, key: '00000000-0000-4000-8000-000000000001', value: { work: null } }] },
      code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED' },
    // Installation of format 2 next to a request document converted by a newer release: no single format describes it.
    { name: 'mixed', options: { extra: [{ kind: 'factory.request', version: 2, key: 'from-a-newer-release', value: { input: null, receipt: null } }] },
      code: 'STORAGE_DOCUMENT_VERSION_UNSUPPORTED' },
  ];
  for (const item of cases) {
    const path = join(dir, `${item.name}.sqlite`);
    await writeFormatTwo(source, path, item.options);
    const before = storage(await inspectStorage(path));
    assert.equal(before.operational, 'incompatible', item.name);
    assert.ok(before.problems.some(problem => problem.code === item.code), `${item.name}: ${JSON.stringify(before.problems)}`);
    await assert.rejects(openControl({ storagePath: path, runtimeInventory: 'unknown' }),
      (error: unknown) => error instanceof StorageFormatError && error.code === 'STORAGE_INCOMPATIBLE');
    const refused = await migrateStorage(path, { upgradeId: 'up-x', release: 'r', previousRelease: null });
    assert.deepEqual([refused.kind, refused.kind === 'refused' && refused.code], ['refused', 'STORAGE_INCOMPATIBLE'], item.name);
    assert.deepEqual(storage(await inspectStorage(path)), before, `${item.name}: nothing written`);
  }
  // The preserved digest recorded by the upgrade no longer matches: verified BEFORE the commit, nothing written.
  const changed = join(dir, 'changed.sqlite');
  await writeFormatTwo(source, changed);
  const before = storage(await inspectStorage(changed));
  const refused = await migrateStorage(changed, { upgradeId: 'up-y', release: 'r', previousRelease: null, expectedDigest: 'f'.repeat(64) });
  assert.deepEqual([refused.kind, refused.kind === 'refused' && refused.code], ['refused', 'MIGRATION_VERIFICATION_FAILED']);
  assert.deepEqual(storage(await inspectStorage(changed)), before);
});
