import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli = fileURLToPath(new URL('./rehearse.mjs', import.meta.url));

async function rehearsal(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'proof-rehearsal-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const output = join(root, 'run');
  const process = spawnSync(globalThis.process.execPath, [cli, '--scenario', scenario, '--output', output], {encoding: 'utf8'});
  assert.equal(process.status, 0, process.stderr);
  return {output, report: JSON.parse(process.stdout)};
}

test('the entire structural rehearsal distinguishes contract results from a failed auxiliary edit', async t => {
  const {output, report} = await rehearsal(t, 'auxiliary-edit-failure');
  assert.equal(report.kind, 'synthetic-structural-rehearsal');
  assert.equal(report.nativeInferences, 0);
  assert.equal(report.simulatedActivations, 1);
  assert.deepEqual(report.finalization.assessment.criteria, {counter: 'approved', wait: 'approved', edit: 'rejected'});
  assert.equal(report.finalization.cleanup.status, 'completed');
  const data = await readFile(join(output, 'preserved/evidence.json'), 'utf8');
  assert.equal(data.includes('SYNTHETIC_PRIVATE_VALUE'), false);
});

test('structural preflight failures consume no simulated activation and cannot approve the proof', async t => {
  for (const [scenario, code] of [['missing-tool', 'TOOLS_INACTIVE'], ['missing-capture', 'CAPTURE_MISSING'],
    ['empty-scan', 'EMPTY_SCAN'], ['model-drift', 'MODEL_DRIFT'], ['budget-exhausted', 'BUDGET_STOP']]) {
    const {report} = await rehearsal(t, scenario);
    assert.equal(report.preflight.code, code);
    assert.equal(report.simulatedActivations, 0);
    assert.deepEqual(report.finalization.assessment.criteria, {counter: 'inconclusive', wait: 'inconclusive', edit: 'inconclusive'});
  }
});

test('end-to-end collection, sanitization and cleanup failures preserve separate outcomes and sources', async t => {
  for (const [scenario, status, code] of [['collection-failure', 'evidence', 'COLLECT_FAILED'],
    ['sanitization-failure', 'evidence', 'SANITIZE_FAILED'], ['cleanup-failure', 'cleanup', 'REMOVE_FAILED']]) {
    const {output, report} = await rehearsal(t, scenario);
    assert.equal(report.finalization[status].code, code);
    await access(join(output, 'sources/capture.jsonl'));
    assert.equal(JSON.stringify(report).includes('PRIVATE_FAILURE'), false);
  }
  const {report} = await rehearsal(t, 'assessment-failure');
  assert.equal(report.finalization.assessment.status, 'failed');
  assert.equal(report.finalization.cleanup.status, 'completed');
});

test('success and unconfirmed cessation have different finalization and retention states', async t => {
  const success = await rehearsal(t, 'success');
  assert.deepEqual(success.report.finalization.assessment.criteria, {counter: 'approved', wait: 'approved', edit: 'approved'});
  await assert.rejects(access(join(success.output, 'sources')));
  const blocked = await rehearsal(t, 'cessation-unconfirmed');
  assert.equal(blocked.report.finalization.cessationConfirmed, false);
  assert.equal(blocked.report.finalization.assessment.status, 'skipped');
  assert.equal(blocked.report.finalization.cleanup.status, 'blocked');
  await access(join(blocked.output, 'sources/capture.jsonl'));
});

test('counter replay and contradictory cessation observations reject only their own criteria', async t => {
  const replay = await rehearsal(t, 'effect-replay');
  assert.deepEqual(replay.report.finalization.assessment.criteria, {counter: 'rejected', wait: 'approved', edit: 'approved'});
  const snapshot = JSON.parse(await readFile(join(replay.output, 'preserved/evidence.json'), 'utf8'));
  assert.equal(snapshot.observations.before, 1); assert.equal(snapshot.observations.after, 2);
  const active = await rehearsal(t, 'activity-after-stop');
  assert.deepEqual(active.report.finalization.assessment.criteria, {counter: 'approved', wait: 'rejected', edit: 'approved'});
});

test('an existing rehearsal cannot be rerun to reset its activation count', async t => {
  const {output} = await rehearsal(t, 'success');
  const before = await readFile(join(output, 'rehearsal.json'), 'utf8');
  const again = spawnSync(process.execPath, [cli, '--output', output], {encoding: 'utf8'});
  assert.equal(again.status, 1);
  assert.equal(await readFile(join(output, 'rehearsal.json'), 'utf8'), before);
});
