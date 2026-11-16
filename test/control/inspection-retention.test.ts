// Ticket 29 on top of tickets 30/31: usage reads the Work's Records session copy once the environment is gone; a copy or log removed by a
// retention sweep is `expired` (an explicit cleanup's is `removed`), never absent/zero; a forgotten Work answers with its minimal memory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openControl } from '../../src/control/index.js';
import type { ExecutionPorts, LogPageView, UsageView, WorkView } from '../../src/control/types.js';
import { ticketIndex, works } from '../../src/control/durable/admission.js';
import { openStore } from '../../src/control/durable/store.js';
import { createRecords } from '../../src/records/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { boot, seedInspectedWork } from './inspection-fixture.js';

function ports(root: string): ExecutionPorts {
  const fail = async () => { throw new Error('not used by inspection'); };
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: 'p' } as never });
  return { sandbox: { prepare: fail, start: fail, stop: fail }, workers: { activate: fail, deliver: fail, observeUsage: input => workers.observeUsage(input) },
    credentials: {} as never, configuration: {}, capacity: 1, builder: {},
    records: { async find(selection) { return (await createRecords({ root })).find(selection); }, async read(input) { return (await createRecords({ root })).read(input); } } };
}
const at = '2026-11-16T10:00:00.000Z';

async function retained(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-inspect29-30-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'control.sqlite');
  const work_id = await seedInspectedWork(path, root);
  // Ticket 30 preserved e-1's Builder session into Records (same bytes, same hash), then the environment's runtime tree went away.
  const source = join(root, 'r', boot, 'w-a', 'profile', 'sessions', 'sess-1.jsonl');
  const data = await readFile(source);
  const sha256 = createHash('sha256').update(data).digest('hex');
  await mkdir(join(root, work_id, 'sessions'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, work_id, 'sessions', 'e-1.jsonl'), data, { mode: 0o600 });
  await rm(join(root, 'r'), { recursive: true });
  const records = await createRecords({ root });
  const log = await records.openOutput({ workId: work_id, executionId: 'e-1', invocationId: 'i-1', role: 'builder', environmentRef: 'env', bootRef: 'b', callId: 'c' });
  await log.write(Buffer.from('kept')); const kept = (await log.finish()).reference.id;
  const opened = await openStore(path);
  await opened.session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const session = (id: string, executionId: string) => ({ id, role: 'builder' as const, executionId, sourceRef: `r/${boot}/w-${executionId}/profile/sessions/sess-1.jsonl`, sha256: id === 'session:e-1' ? sha256 : 'x',
      bytes: data.length, at, state: 'preserved' as const, code: null });
    const removal = (id: string, kind: 'log' | 'session', origin: 'retention' | 'explicit') => ({ effectId: id, id, kind, executionId: 'e-2', bytes: 1, origin, request_id: null,
      planId: null, intentAt: at, resultAt: at, outcome: 'removed' as const, code: null });
    document.work!.retention = { class: 'delivered', days: 30, dueAt: at, protections: [], state: 'expired', inventory: null,
      sessions: [session('session:e-1', 'e-1'), { ...session('session:e-2', 'e-2'), sha256: (document.work!.previousExecutions[1]!.end!.session!.sha256) }],
      removals: [removal('session:e-2', 'session', 'retention'), removal('log:00000000-0000-4000-8000-0000000000aa', 'log', 'retention'),
        removal('log:00000000-0000-4000-8000-0000000000bb', 'log', 'explicit')],
      removed: { logs: 2, sessions: 1, bytes: 3 }, plans: [], sweeps: 1, lastSweepAt: at, nextStep: 'none' } as NonNullable<WorkView['retention']>;
  }, BACKGROUND_CONTEXT);
  await opened.session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    index.forgotten = { ...(index.forgotten ?? {}), ['00000000-0000-4000-8000-0000000000ff']: { work_id: '00000000-0000-4000-8000-0000000000ff',
      ticket: { tracker: 'github', repository: 'acme/project', repositoryId: 3, issueId: 99, nodeId: 'I_99', number: 99, url: 'https://github.com/acme/project/issues/99' },
      repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, cycle: 1, predecessor: null, sequence: 99, result: 'delivered', pullRequest: null,
      mergeConfirmed: true, mergeConfirmedAt: at, label: null, questions: [], watch: null, forgottenAt: at, request_id: 'forget-1', planId: '00000000-0000-4000-8000-0000000000ee' } };
  }, BACKGROUND_CONTEXT);
  await opened.close();
  return { root, path, work_id, kept };
}

test('usage reads the hash-verified Records copy after the runtime tree is gone; a copy a retention sweep removed is `expired`', async t => {
  const { root, path, work_id } = await retained(t);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const usage = (await control.inspect({ kind: 'usage', work_id }) as UsageView).works[0]!;
  assert.deepEqual(usage.activities.slice(0, 2).map(item => [item.executionId, item.measurement, item.session.state, item.code]),
    [['e-1', 'complete', 'complete', null], ['e-2', 'unavailable', 'expired', 'SESSION_EXPIRED_BY_RETENTION']]);
  assert.equal(usage.activities[0]!.tokens?.total, 165, 'measured from the Records copy');
  const stopped = new AbortController(); stopped.abort(); await control.run(stopped.signal);
});

test('a log removed by retention reads `expired`, by explicit cleanup `removed`, a kept one still reads; a forgotten Work is never "not found"', async t => {
  const { root, path, work_id, kept } = await retained(t);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const read = async (capture: string) => await control.inspect({ kind: 'log', work_id, capture }) as LogPageView;
  assert.deepEqual([(await read('00000000-0000-4000-8000-0000000000aa')).state, (await read('00000000-0000-4000-8000-0000000000aa')).code], ['expired', 'CAPTURE_EXPIRED_BY_RETENTION']);
  assert.deepEqual([(await read('00000000-0000-4000-8000-0000000000bb')).state], ['removed']);
  assert.deepEqual([(await read(kept)).state, (await read(kept)).text], ['complete', 'kept']);
  for (const kind of ['history', 'logs', 'usage'] as const) {
    const view = await control.inspect({ kind, work_id: '00000000-0000-4000-8000-0000000000ff' }) as { kind: string };
    assert.equal(view.kind, 'work-forgotten', kind);
  }
  const stopped = new AbortController(); stopped.abort(); await control.run(stopped.signal);
});
