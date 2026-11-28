import assert from 'node:assert/strict';
import { chmod, rm } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ControlReceipt, SourceTriage, TicketSource } from '../../src/control/index.js';
import { upgrade, type UpgradeReport } from '../../src/entrypoints/controller/upgrade.js';
import { applyLabel, remoteIssue, type RemoteIssue } from '../control/doubles.js';
import { call, hang, triageWorld, type ModelTurn } from '../control/triage-investigation-fixture.js';
import { untilHolds } from '../runner/budget.js';
import { installation } from './upgrade-fixture.js';

// The real upgrade logic over storages prepared by a real Control that investigated and published Triage
// requests (scripted provider, GitHub double, in-process Investigation Environment). The storage an upgrade reads is a copy of the
// world's: taken after a clean stop, or while the controller runs, which is what a killed controller leaves behind.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const source: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
const verdictText = 'Observado: o total ignora o cupom SEGREDO-DO-PARECER.\nInferido: falta a versão.\nAção: informar a versão.';
function triageIssue(number: number): RemoteIssue {
  const issue = remoteIssue(number, { labels: [], title: `Total errado ${number} TITULO-DO-TICKET`, body: 'O total ignora o cupom. CORPO-DO-TICKET' });
  applyLabel(issue, 'needs-triage');
  return issue;
}
type World = Awaited<ReturnType<typeof triageWorld>>;
const world = (t: Parameters<typeof triageWorld>[0], script: ModelTurn[], ports: Parameters<typeof triageWorld>[1]['ports'] = {}) =>
  triageWorld(t, { github: { issues: [triageIssue(7), triageIssue(9)], pulls: {} }, sources: [source], script, ports });
async function pause(w: World) {
  const receipt = (await w.control().accept({ request_id: 'pause-before-upgrade', operation: 'pause', origin: 'local-cli' })) as ControlReceipt;
  assert.equal(receipt.kind, 'durable');
}
/** An installation whose selected release operates the current format, over a copy of the world's storage as it is right now. */
async function installed(t: { after(fn: () => Promise<void>): void }, w: World) {
  const fixture = await installation({ previousStorage: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const live = new DatabaseSync(w.storagePath, { readOnly: true });
  try {
    await backup(live, fixture.context.storagePath);
  } finally {
    live.close();
  }
  await chmod(fixture.context.storagePath, 0o600);
  return fixture.context;
}
const blocked = (result: UpgradeReport) => result.checks.filter(item => item.status === 'blocked').map(item => item.id);
const triageOf = (result: UpgradeReport) => (result.storage as unknown as { triage: unknown }).triage;
const triageCheck = (result: UpgradeReport) => result.checks.find(item => item.id === 'upgrade:triage')!;
const settled = { investigating: 0, retained: 0 };
/** Nothing of a Ticket, a Verdict or a session may appear in what an upgrade reports (`check`, `apply` and `status`). */
function assertMetadataOnly(result: UpgradeReport) {
  const printed = JSON.stringify(result);
  for (const content of ['SEGREDO-DO-PARECER', 'TITULO-DO-TICKET', 'CORPO-DO-TICKET', 'Observado']) assert.ok(!printed.includes(content), content);
}

test('a queued request and a partially published Verdict do not block `upgrade apply`; check and status count them by situation', async t => {
  const w = await world(t, [() => call('concluir_triagem', { outcome: 'needs-info', category: 'bug', text: verdictText }), () => hang]);
  // The comment is written and confirmed; the label that follows it is refused: a partial publication.
  w.remote.triageWrites = [undefined, 'failed'];
  await w.start();
  assert.equal((await w.investigated(0)).state, 'publishing');
  await w.poll();
  await pause(w);
  await w.stop();
  const context = await installed(t, w);
  // (The stop reopened nothing: the storage is read as the stopped controller left it.)
  const expected = { requests: { queued: 1, suspended: 0, investigating: 0, stopUnconfirmed: 0, publishing: 1, ended: 0 }, capacity: settled, unsettled: [] };
  const checked = await upgrade(context, 'check');
  assert.deepEqual([checked.code, blocked(checked), triageOf(checked)], ['UPGRADE_COMPATIBLE', [], expected]);
  assert.equal(triageCheck(checked).status, 'ok');
  assert.match(triageCheck(checked).message, /1 queued.*1 with a recorded Verdict still to publish/);
  assert.deepEqual(triageOf(await upgrade(context, 'status')), expected);
  const applied = await upgrade(context, 'apply');
  assert.deepEqual([applied.code, triageOf(applied)], ['UPGRADE_COMPLETED', expected], JSON.stringify(applied));
  const status = await upgrade(context, 'status');
  assert.deepEqual([status.code, triageOf(status)], ['UPGRADE_COMPLETED', expected]);
  for (const result of [checked, applied, status]) assertMetadataOnly(result);
});

test('a stop the Investigation Environment did not confirm blocks `upgrade apply`, as a request back in the queue and as a terminal one', async t => {
  // With one attempt only, the interrupted request is terminal (`failed`) and its unit of Triage capacity is retained all the same.
  for (const [attempts, state] of [
    [2, 'queued'],
    [1, 'failed'],
  ] as const) {
    const w = await world(t, [() => hang], { attempts });
    w.environment.controls.withholdStopConfirmation();
    await w.start();
    await untilHolds('the session to ask the model', () => w.bodies.length === 1);
    await pause(w);
    await w.stop();
    const context = await installed(t, w);
    const checked = await upgrade(context, 'check');
    const retained = (triageOf(checked) as { unsettled: string[] }).unsettled;
    assert.deepEqual(
      [checked.code, blocked(checked), triageOf(checked)],
      [
        'UPGRADE_INCOMPATIBLE',
        ['upgrade:triage'],
        {
          requests: { queued: 1, suspended: 0, investigating: 0, stopUnconfirmed: 1, publishing: 0, ended: 0 },
          capacity: { investigating: 0, retained: 1 },
          unsettled: retained,
        },
      ],
      state,
    );
    assert.match(retained[0]!, /^t1-1-[0-9a-f]{8}$/);
    assert.match(triageCheck(checked).message, /1 with a stop not confirmed.*1 unit\(s\) of Triage capacity retained/);
    assert.match(triageCheck(checked).nextStep, /reconcil/);
    const applied = await upgrade(context, 'apply');
    assert.deepEqual([applied.code, blocked(applied), applied.journal], ['UPGRADE_INCOMPATIBLE', ['upgrade:triage'], null], 'nothing was started');
    assert.deepEqual(triageOf(await upgrade(context, 'status')), triageOf(checked));
    assertMetadataOnly(checked);
  }
});

test('an investigation under way (what a killed controller leaves) blocks `upgrade apply` until a boot reconciles it', async t => {
  const w = await world(t, [() => hang]);
  await w.start();
  await untilHolds('the session to ask the model', () => w.bodies.length === 1);
  await pause(w);
  // Copied while the attempt runs: its record is open and the run never recorded its end.
  const context = await installed(t, w);
  const checked = await upgrade(context, 'check');
  const open = (await w.requests())[0]!.attempts![0]!.attempt;
  assert.deepEqual(
    [checked.code, blocked(checked), triageOf(checked)],
    [
      'UPGRADE_INCOMPATIBLE',
      ['upgrade:stop', 'upgrade:triage'],
      {
        requests: { queued: 1, suspended: 0, investigating: 1, stopUnconfirmed: 0, publishing: 0, ended: 0 },
        capacity: { investigating: 1, retained: 0 },
        unsettled: [open],
      },
    ],
  );
  assert.match(triageCheck(checked).message, /1 under way/);
  assert.equal((await upgrade(context, 'apply')).code, 'UPGRADE_INCOMPATIBLE');
  assertMetadataOnly(checked);
});
