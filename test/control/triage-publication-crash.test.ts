import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openControl } from '../../src/control/index.js';
import type { SourceTriage, TicketSource, TriageRequest, TriageRequestsView } from '../../src/control/types.js';
import { openStore } from '../../src/control/durable/store.js';
import { readTriageRequest, requestTriage, transitionTriageRequest, triageVerdicts } from '../../src/control/durable/triage-requests.js';
import { intendedChanges } from '../../src/control/rules/triage-verdict.js';
import type { TriageWrite } from '../../src/issue-tracker/index.js';
import { ended, until } from '../runner/budget.js';
import { applyLabel, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';

// Spec #68 TR-22 (ticket #77): the REAL crash between a tracker write and the recording of its result. A real controller child (Control +
// Pi Durable/SQLite) is SIGKILLed after the Verdict comment reached the doubled GitHub and before anything of it was recorded; a NEW
// Control on the same storage reads the Ticket, recognises its own comment and completes only what is missing. One scenario for the
// mechanism; the variations (lost answers, retained writes, authorship) are in triage-publication-{rules,flow}.test.ts.
// Doubled: GitHub (its state survives the kill through a file). No Triager is composed: the publication can call no model.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const sources: TicketSource[] = [{ tracker: 'github', repository: 'acme/project', discover: true, triage }];
const roles = { ...triage, admission: scope.label };
const text = 'Observado: falta a versão.\nInferido: não dá para reproduzir.\nAção: informar a versão afetada.';

/** A storage whose only request has its Verdict recorded, by the same commits the investigation makes, and nothing published. */
async function recordedVerdict(dir: string, remote: Remote) {
  // The installation's storage is created by a Control that runs nothing, then seeded while no controller owns it.
  const adopting = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty' });
  const stopped = new AbortController();
  const run = adopting.run(stopped.signal);
  stopped.abort();
  await run;
  const store = await openStore(join(dir, 'control.sqlite'));
  const created = await requestTriage(store.session, {
    ticket: remote.issues[0]!.ref,
    source: { tracker: 'github', repository: 'acme/project' },
    after: null,
    authorization: { label: 'needs-triage', observedAt: new Date().toISOString(), application: null },
  });
  assert.equal(created.kind, 'requested');
  const id = created.request.triage_request_id;
  await transitionTriageRequest(store.session, id, { from: ['queued'], to: 'investigating', event: 'attempt-started' });
  const verdict = { outcome: 'needs-info' as const, category: 'bug' as const, component: null };
  const moved = await transitionTriageRequest(
    store.session,
    id,
    { from: ['investigating'], to: 'publishing', event: 'verdict-recorded' },
    async (request, tx) => {
      request.verdict = {
        ...verdict,
        attempt: 't1-1-00000000',
        recordedAt: new Date().toISOString(),
        textSha256: createHash('sha256').update(text).digest('hex'),
        textBytes: Buffer.byteLength(text),
      };
      request.intended = intendedChanges({ ...verdict, text }, roles, 'github');
      (await tx.doc(triageVerdicts, id, null)).verdict = { triage_request_id: id, text };
    },
  );
  assert.equal(moved.kind, 'applied');
  await store.close();
  return id;
}

test('TR-22: a controller killed between the comment write and the recording of its result; the new Control completes the publication with one comment and no model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'factory-triage-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const issue = remoteIssue(7, { labels: [{ id: 91, name: 'bug' }] });
  applyLabel(issue, 'needs-triage');
  await writeFile(join(dir, 'github.json'), JSON.stringify({ issues: [issue], pulls: {} } satisfies Remote));
  await writeFile(join(dir, 'sources.json'), JSON.stringify(sources));
  const id = await recordedVerdict(dir, { issues: [issue], pulls: {} });

  const child = spawn(process.execPath, [fileURLToPath(new URL('./triage-publication-crash-child.js', import.meta.url)), dir], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk;
    if (output.includes('CUT')) child.kill('SIGKILL');
  });
  const exit = await ended(child, () => `child controller up to the comment write (${output.trim() || 'no output'})`);
  assert.equal(exit.signal, 'SIGKILL', 'the child was killed at the cut, it did not exit by itself');

  // What the kill left: the comment is on (doubled) GitHub; the storage only knows the write was attempted.
  const remote = JSON.parse(await readFile(join(dir, 'github.json'), 'utf8')) as Remote;
  assert.equal(remote.comments![7]!.length, 1);
  const store = await openStore(join(dir, 'control.sqlite'));
  const left = (await readTriageRequest(store.session, id))!;
  await store.close();
  assert.deepEqual(
    [left.state, left.intended!.map(effect => [effect.status, effect.attempts ?? 0])],
    [
      'publishing',
      [
        ['pending', 1],
        ['pending', 0],
        ['pending', 0],
      ],
    ],
    'the result of the write was never recorded',
  );

  let providerRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerRequests++;
    throw new Error('no provider in this test');
  };
  t.after(() => void (globalThis.fetch = originalFetch));
  const github = githubDoubles(remote);
  const time = manualClock();
  const control = await openControl({
    storagePath: join(dir, 'control.sqlite'),
    runtimeInventory: 'empty',
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources },
    polling: { intervalSeconds: 60, clock: time.clock },
  });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => {
    stop.abort();
    await running;
  });
  const request = await until('the new Control to conclude the publication', async (): Promise<TriageRequest | undefined> => {
    const [found] = ((await control.inspect({ kind: 'triage-requests' })) as TriageRequestsView).requests;
    if (found?.state === 'concluded') return found;
    if (time.isSleeping()) time.advance();
    return undefined;
  });
  assert.deepEqual([request.triage_request_id, request.end?.code], [id, 'VERDICT_PUBLISHED']);
  assert.equal(remote.comments![7]!.length, 1, 'no duplicated comment');
  assert.equal(request.intended![0]!.reference, remote.comments![7]![0]!.url, 'the comment the dead controller wrote is recognised as this request’s');
  assert.deepEqual(
    request.intended!.map(effect => [effect.status, effect.attempts]),
    [
      ['confirmed', 1],
      ['confirmed', 1],
      ['confirmed', 1],
    ],
  );
  const written = github.calls.filter(call => call.method === 'writeTriage').map(call => (call.args as { write: TriageWrite }).write.kind);
  assert.deepEqual(written, ['add-label', 'remove-label'], 'only what was missing is written');
  assert.deepEqual(remote.issues[0]!.labels.map(label => label.name).sort(), ['bug', 'needs-info']);
  assert.deepEqual([providerRequests, request.attempts ?? []], [0, []], 'no model request and no Triager activation');
});
