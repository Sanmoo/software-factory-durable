// Ticket 29: inspection flows over the REAL public Control (Pi Durable/SQLite), REAL protected Records captures and REAL preserved Pi
// session files read through the REAL Workers usage facet (`createWorkers().observeUsage`). GitHub, Sandbox and model are not used.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControl } from '../../src/control/index.js';
import type { ExecutionPorts, HistoryView, LogPageView, LogsView, ShowView, UsageView, ControlStatus } from '../../src/control/types.js';
import { createRecords } from '../../src/records/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { boot, seedInspectedWork } from './inspection-fixture.js';

function ports(root: string, overrides: Partial<ExecutionPorts> = {}): ExecutionPorts {
  const fail = async () => {
    throw new Error('not used by inspection');
  };
  const workers = createWorkers({
    root,
    knownSecrets: [],
    profile: { id: 'p', systemPrompt: 'x', auth: 'oauth', providerId: 'openai-codex', modelId: 'gpt-5.5', api: 'x' } as never,
  });
  return {
    sandbox: { prepare: fail, start: fail, stop: fail },
    workers: { activate: fail, deliver: fail, observeUsage: input => workers.observeUsage(input) },
    credentials: {} as never,
    configuration: {},
    capacity: 2,
    builder: {},
    records: {
      async find(selection) {
        return (await createRecords({ root })).find(selection);
      },
      async read(input) {
        return (await createRecords({ root })).read(input);
      },
    },
    ...overrides,
  };
}

async function seeded(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-inspect29-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'control.sqlite');
  return { root, path, work_id: await seedInspectedWork(path, root) };
}

test('AC2/AC3 history is paginated and filtered by Execution/role through the public Control; unknown Work is a stable not-found', async t => {
  const { work_id, path, root } = await seeded(t);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const all = (await control.inspect({ kind: 'history', work_id, limit: 2 })) as HistoryView;
  assert.equal(all.kind, 'history');
  assert.deepEqual([all.entries.length, all.page.nextCursor, all.page.total], [2, 2, all.page.filtered]);
  const next = (await control.inspect({ kind: 'history', work_id, cursor: all.page.nextCursor!, limit: 200 })) as HistoryView;
  assert.equal(next.entries[0]!.sequence, 2, 'the cursor continues exactly after the previous page');
  const e2 = (await control.inspect({ kind: 'history', work_id, execution: 'e-2' })) as HistoryView;
  assert.deepEqual(
    e2.entries.map(item => [item.entry.event, item.role]),
    [
      ['execution-started', 'builder'],
      ['reviewer-started', 'standards'],
    ],
  );
  const reviewers = (await control.inspect({ kind: 'history', work_id, role: 'standards' })) as HistoryView;
  assert.deepEqual(
    reviewers.entries.map(item => item.links),
    [{ executionId: 'e-2' }],
  );
  assert.deepEqual(await control.inspect({ kind: 'history', work_id: '00000000-0000-4000-8000-000000000000' }), {
    kind: 'work-not-found',
    work_id: '00000000-0000-4000-8000-000000000000',
    nextStep: 'No Work with this identity in the controller authority; use `factory list`.',
  });
  await assert.rejects(control.inspect({ kind: 'history', work_id: 'not-a-uuid' }), /INVALID_WORK_ID/);
  const stopped = new AbortController();
  stopped.abort();
  await control.run(stopped.signal);
});

test('AC6/AC7 usage per role/Execution/Work/installation from real sessions: continued session counted once, aborts included, unavailable never zero', async t => {
  const { work_id, path, root } = await seeded(t);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const view = (await control.inspect({ kind: 'usage', work_id })) as UsageView;
  const work = view.works[0]!;
  assert.deepEqual(
    work.activities.map(item => [item.executionId, item.measurement, item.entries, item.carriedEntries, item.code]),
    [
      ['e-1', 'complete', 2, 0, null],
      ['e-2', 'complete', 1, 2, null],
      ['e-3', 'unavailable', 0, 0, 'NOT_STARTED'],
      ['e-4', 'unavailable', 0, 0, 'SESSION_NOT_RECORDED'],
    ],
  );
  assert.equal(work.activities[1]!.failedOrAborted, 1);
  assert.deepEqual(work.total.tokens, { input: 170, output: 15, cacheRead: 0, cacheWrite: 0, total: 185 });
  assert.deepEqual(work.total.cost, { total: 0.4375, unit: 'sdk-catalog-estimate', currency: null });
  assert.equal(work.total.measurement, 'partial', 'two activities are not measurable: partial, never complete');
  assert.deepEqual(work.byRole.standards, { measurement: 'unavailable', activities: 0, measured: 0, unavailable: 0, tokens: null, cost: null });
  assert.deepEqual(work.activities[0]!.models, [{ provider: 'openai-codex', model: 'gpt-5.5' }]);
  assert.deepEqual(work.time, { executions: 4, measuredMs: 1500, lowerBoundMs: 700, unknown: 1, measurement: 'partial' });
  assert.deepEqual([work.budget.corrections?.consumed, work.budget.corrections?.limit], [0, 3]);
  assert.equal(view.resources.state, 'unavailable', 'adapter RAM/CPU/disk are not tokens and are not observed');
  const installation = (await control.inspect({ kind: 'usage' })) as UsageView;
  assert.deepEqual([installation.scope, installation.total.tokens?.total, installation.slots], ['installation', 185, { capacity: 2, held: 0 }]);
  assert.deepEqual([installation.page.returned, installation.page.nextCursor], [1, null], 'installation usage is a bounded page of Works');
  assert.deepEqual(
    ((await control.inspect({ kind: 'usage', cursor: 1, limit: 1 })) as UsageView).works,
    [],
    'past the last Work: an empty page, no more cursor',
  );
  const status = (await control.inspect({ kind: 'status' })) as ControlStatus;
  assert.deepEqual(status.impediments, { works: 1, codes: { RECOVERY_BLOCKED: 1 } });
  assert.deepEqual(status.consumption.time, { measuredMs: 1500, lowerBoundMs: 700, unknown: 1, measurement: 'partial' });
  // An altered session file is not measured (hash mismatch), a lost one is absent; neither is a zero.
  await writeFile(
    join(root, 'r', boot, 'w-a', 'profile', 'sessions', 'sess-1.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'sess-1', timestamp: 'now', cwd: '/workspace' }) + '\n{"tampered":true}\n',
    { mode: 0o600 },
  );
  await rm(join(root, 'r', boot, 'w-b'), { recursive: true });
  const after = ((await control.inspect({ kind: 'usage', work_id })) as UsageView).works[0]!;
  assert.deepEqual(
    after.activities.slice(0, 2).map(item => [item.measurement, item.code, item.session.state]),
    [
      ['unavailable', 'SESSION_HASH_MISMATCH', 'unknown'],
      ['unavailable', 'SESSION_FILE_MISSING', 'absent'],
    ],
  );
  assert.equal(after.total.tokens, null);
  const none = await openControl({ storagePath: join(root, 'other.sqlite'), runtimeInventory: 'unknown' });
  assert.match(((await none.inspect({ kind: 'usage' })) as UsageView).limitations.join(' '), /not composed/);
  for (const item of [control, none]) {
    const stopped = new AbortController();
    stopped.abort();
    await item.run(stopped.signal);
  }
});

test('AC2/AC4/AC5 logs list real protected captures by Execution/role with their state; a page is truncated with the rest available; raw is never shown', async t => {
  const { work_id, path, root } = await seeded(t);
  const records = await createRecords({ root });
  const context = (executionId: string, role: 'builder' | 'standards', callId: string) => ({
    workId: work_id,
    executionId,
    invocationId: `${executionId}-${role}`,
    role,
    environmentRef: 'env',
    bootRef: boot,
    callId,
  });
  const big = await records.openOutput(context('e-1', 'builder', 'call-1'));
  await big.write(Buffer.from('é'.repeat(20000))); // 40000 bytes, a two-byte character on every page boundary
  const bigRef = (await big.finish()).reference;
  const partial = await records.openOutput(context('e-2', 'standards', 'call-2'));
  await partial.write(Buffer.from('half'));
  const raw = await records.openOutput(context('e-2', 'builder', 'call-3'), { format: 'raw', maxBytes: 100 });
  await raw.write(Buffer.from([0, 1, 2]));
  const rawRef = (await raw.finish()).reference;
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const listed = (await control.inspect({ kind: 'logs', work_id })) as LogsView;
  assert.equal(listed.listing.state, 'complete');
  assert.deepEqual(listed.captures.map(item => [item.executionId, item.role, item.state, item.format]).sort(), [
    ['e-1', 'builder', 'complete', 'text'],
    ['e-2', 'builder', 'complete', 'raw'],
    ['e-2', 'standards', 'partial', 'text'],
  ]);
  assert.deepEqual(
    ((await control.inspect({ kind: 'logs', work_id, execution: 'e-2', role: 'standards' })) as LogsView).captures.map(item => item.callId),
    ['call-2'],
  );
  // Records-level paging by capture id: every capture reachable by following `next`.
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const view = (await control.inspect({ kind: 'logs', work_id, limit: 1, ...(after ? { after } : {}) })) as LogsView;
    seen.push(...view.captures.map(item => item.capture));
    after = view.page.next ?? undefined;
  } while (after);
  assert.deepEqual(seen.sort(), listed.captures.map(item => item.capture).sort());
  const first = (await control.inspect({ kind: 'log', work_id, capture: bigRef.id })) as LogPageView;
  assert.equal(first.trust, 'untrusted-captured-output');
  const tiny = (await control.inspect({ kind: 'log', work_id, capture: bigRef.id, limit: 1 })) as LogPageView;
  assert.deepEqual([tiny.text, tiny.nextOffset], ['éé', 4], 'a limit below one character still makes progress (at least one whole character)');
  const beyond = (await control.inspect({ kind: 'log', work_id, capture: bigRef.id, offset: 40000 })) as LogPageView;
  assert.deepEqual(
    [beyond.state, beyond.code, beyond.text],
    ['absent', 'OFFSET_OUT_OF_RANGE', null],
    'an offset at/after the end is a refusal, never an empty complete page',
  );
  assert.equal(first.state, 'truncated');
  assert.equal(first.bytes, 40000);
  assert.ok(!first.text!.includes('�'), 'a page never splits a character');
  let text = first.text!,
    offset = first.nextOffset;
  while (offset !== null) {
    const page = (await control.inspect({ kind: 'log', work_id, capture: bigRef.id, offset })) as LogPageView;
    text += page.text!;
    offset = page.nextOffset;
  }
  assert.equal(text, 'é'.repeat(20000), 'the full output is available by reference, page by page');
  const shown = (await control.inspect({ kind: 'log', work_id, capture: rawRef.id })) as LogPageView;
  assert.deepEqual([shown.code, shown.text], ['RAW_CAPTURE_NOT_DISPLAYED', null]);
  const missing = (await control.inspect({ kind: 'log', work_id, capture: '00000000-0000-4000-8000-000000000000' })) as LogPageView;
  assert.deepEqual([missing.state, missing.code], ['absent', 'CAPTURE_NOT_FOUND']);
  const closing = new AbortController();
  closing.abort();
  await control.run(closing.signal);
  const noRecords = await openControl({ storagePath: path, runtimeInventory: 'unknown' });
  const view = (await noRecords.inspect({ kind: 'logs', work_id })) as LogsView;
  assert.deepEqual(
    [view.listing.state, view.listing.code, view.captures],
    ['unavailable', 'RECORDS_NOT_COMPOSED', []],
    'not composed is unavailable, never an empty listing',
  );
  await partial.abort();
  const stopped = new AbortController();
  stopped.abort();
  await noRecords.run(stopped.signal);
});

test('AC1 show carries the correlated chain: identities, executions, phase/next step, publication, models and observation freshness', async t => {
  const { work_id, path, root } = await seeded(t);
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  const shown = (await control.inspect({ kind: 'show', work_id })) as Extract<ShowView, { kind: 'work' }>;
  const chain = shown.chain;
  assert.deepEqual(chain.ticket, { repository: 'acme/project', number: 3, url: shown.work.ticket.url });
  assert.deepEqual(
    chain.executions.map(item => [item.executionId, item.purpose]),
    [
      ['e-1', 'implementation'],
      ['e-2', 'recovery'],
      ['e-3', 'implementation'],
      ['e-4', 'implementation'],
    ],
  );
  assert.deepEqual(chain.phase, {
    code: 'blocked',
    waitingFor: 'impediment:RECOVERY_BLOCKED',
    nextStep: 'Inspect the Execution evidence and decide explicitly.',
  });
  assert.equal(chain.publication?.pullRequest?.number, 42);
  assert.deepEqual(chain.models, [{ role: 'builder', provider: 'openai-codex', model: 'gpt-5.5', source: 'builder-session' }]);
  assert.ok(chain.references.some(item => item.kind === 'builder-session' && item.executionId === 'e-2'));
  assert.equal(chain.observations.find(item => item.source === 'polling')?.completeness, 'not-observed-this-run');
  assert.equal(chain.lastActivity?.event, 'reviewer-started');
  assert.deepEqual(chain.configuration.builder, shown.work.execution!.request.policies);
  const stopped = new AbortController();
  stopped.abort();
  await control.run(stopped.signal);
});

test('AC1 a big Work stays inspectable: show is compacted with the paged commands, its Executions paged by cursor', async t => {
  const { work_id, path, root } = await seeded(t);
  const opened = await import('../../src/control/durable/store.js').then(module => module.openStore(path));
  const { works } = await import('../../src/control/durable/admission.js');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  await opened.session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    for (let i = 0; i < 400; i++) document.work!.history.push({ at: 'now', event: 'checks-evaluated', origin: 'controller-checks', detail: 'y'.repeat(200) });
  }, BACKGROUND_CONTEXT);
  await opened.close();
  const control = await openControl({ storagePath: path, runtimeInventory: 'unknown', execution: ports(root) });
  assert.equal(
    ((await control.inspect({ kind: 'show', work_id })) as Extract<ShowView, { kind: 'work' }>).work.history.length > 400,
    true,
    'in-process: the full view',
  );
  // As the socket asks (always paged): compacted only because it does not fit.
  const shown = (await control.inspect({ kind: 'show', work_id, limit: 200 })) as Extract<ShowView, { kind: 'work' }>;
  assert.ok(Buffer.byteLength(JSON.stringify(shown)) < 63 * 1024, 'fits one frame');
  assert.equal(shown.work.history.length, 0);
  assert.ok((shown.work.compacted?.history ?? 0) >= 400, 'the left-out history is counted');
  assert.ok(shown.omitted && shown.omitted.nextSteps.some(step => step.startsWith(`factory history ${work_id}`)), 'names a paged command, not the same one');
  assert.equal(shown.chain.executions.length, 4);
  const paged = (await control.inspect({ kind: 'show', work_id, cursor: 1, limit: 2 })) as Extract<ShowView, { kind: 'work' }>;
  assert.deepEqual([paged.chain.executions.map(item => item.executionId), paged.omitted?.executions.nextCursor], [['e-2', 'e-3'], 3]);
  const history = (await control.inspect({ kind: 'history', work_id, limit: 200 })) as HistoryView;
  assert.ok(history.page.fitted && history.page.nextCursor !== null, 'history pages are cut to one frame with a cursor');
  const stopped = new AbortController();
  stopped.abort();
  await control.run(stopped.signal);
});
