import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { until } from '../runner/budget.js';
import { openControl, type ControlStatus, type ListView, type WorkView } from '../../src/control/index.js';
import { composeProductionAccess, composeRuntimeInventory } from '../../src/entrypoints/controller/composition.js';
import { installationTagKey, workTagKey } from '../../src/sandbox/index.js';
import { manualClock } from '../control/doubles.js';
import { lambdaAccountFake } from '../sandbox/lambda-service-fake.js';
import { githubWorld, issue } from './github-world-fixture.js';
import { composeCrashInstallation, effective, tip } from './lambda-crash-fixture.js';

// v2 ticket 15 (V2-33, V2-34), the ONE real crash scenario of the mechanism: a REAL controller child process (Control + Pi Durable/SQLite
// over the production execution composition, Lambda adapter) is SIGKILLed with a boot in progress. Its boot owner dies with it and the
// MicroVM keeps running in the account. A NEW owner on the same installation root, storage and account takes the inventory by tag and
// reconciles. Substituted: the AWS account (fake, kept in a file so it outlives the killed process), the guest, the worker process and
// GitHub (gh world fixture). No AWS call, no ssh/websocat, no VM, no model. Dublê não comprova fronteira substituída.
// The variations (unrecorded MicroVM, unconfirmed end, unreadable listing, tags listed or not) are `test/sandbox/lambda-reconciliation.test.ts`.
const pullRequestRule = { type: 'pull_request', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'acme/project' };

test('v2 ticket 15: after a SIGKILL of the controller with a boot in progress, the next owner inventories the account by tag, ends the MicroVM left without a living Execution with cessation confirmed by GetMicrovm and recorded, and never touches another installation\'s MicroVM', async t => {
  const world = await githubWorld(t, { issues: [issue(3, { title: 'Factory smoke', body: 'Add docs/FACTORY_SMOKE.md.' })], pulls: [], refs: {},
    rulesets: { 1: { enforcement: 'active', current_user_can_bypass: 'never' } }, comments: [], checks: {
      branches: { main: { sha: tip, protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } },
      rules: { main: [pullRequestRule] }, checkRuns: {}, statuses: {}, compare: {} } });
  const dir = await mkdtemp(join(tmpdir(), 'factory-lambda-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accountFile = join(dir, 'aws-account.json'), storagePath = join(dir, 'control.sqlite');

  // The controller dies with its boot in progress.
  const child = spawn(process.execPath, [fileURLToPath(new URL('./lambda-crash-child.js', import.meta.url)), world.root, world.executable, accountFile, storagePath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk; if (output.includes('CUT')) child.kill('SIGKILL'); });
    child.on('exit', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`child exited without crash: ${output}`)));
  });

  // What the dead controller left in the account: one running MicroVM, tagged with the installation and the Work, and nobody owning it.
  const left = lambdaAccountFake({ stateFile: accountFile });
  left.settle();
  assert.deepEqual(left.account.microvms.map(microvm => microvm.state), ['RUNNING']);
  const survivor = left.account.microvms[0]!;
  assert.equal(survivor.request.tags[installationTagKey], 'acme');
  const workId = survivor.request.tags[workTagKey]!;
  // Another installation runs a MicroVM in the same account and region.
  const other = left.plantOtherInstallation('acme-2');

  // The next owner: same installation root, same storage, same account; nothing in memory survived.
  const next = await composeCrashInstallation({ root: world.root, executable: world.executable, accountFile });
  const { runtimeInventory, unavailable } = await composeRuntimeInventory({ root: world.root, effective, lambda: next.lambda });
  assert.equal(unavailable, undefined);
  assert.equal(typeof runtimeInventory, 'object');
  if (typeof runtimeInventory !== 'object') return;
  // The inventory by tag found the survivor and attributed it to its Work; the other installation's MicroVM is not in it.
  assert.deepEqual(runtimeInventory.environments.map(item => item.workId), [workId]);
  assert.deepEqual(runtimeInventory.unknown, []);
  assert.equal(next.fake.account.microvms.find(microvm => microvm.microvmId === survivor.microvmId)!.state, 'RUNNING', 'the inventory lists what a boot record holds; Control decides');

  const time = manualClock();
  const control = await openControl({ storagePath, runtimeInventory, execution: next.ports, access: composeProductionAccess({ github: next.github, effective }), polling: { intervalSeconds: 60, clock: time.clock } });
  const before = await control.inspect({ kind: 'status' }) as ControlStatus;
  assert.deepEqual([before.dispatch, before.dispatchReason], ['closed', 'RECONCILIATION_REQUIRED'], 'nothing is dispatched before the reconciliation');
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { if (!stop.signal.aborted) { stop.abort(); await running; } });
  const crashedOf = (work: WorkView | undefined) => [...(work?.previousExecutions ?? []), ...(work?.execution ? [work.execution] : [])].find(execution => execution.recovery?.length);
  const work = await until('the interrupted Execution is settled', async () => {
    const value = ((await control.inspect({ kind: 'list' })) as ListView).works[0] as WorkView | undefined;
    if (crashedOf(value)) return value!;
    if (time.isSleeping()) time.advance();
    return undefined;
  }, 10);
  assert.equal(work.work_id, workId);

  // The MicroVM without a living Execution is ended, and the end is the service's own answer (GetMicrovm), not an assumption.
  const ended = next.fake.account.microvms.find(microvm => microvm.microvmId === survivor.microvmId)!;
  assert.equal(ended.state, 'TERMINATED');
  assert.deepEqual(next.fake.mutations.filter(call => call.operation === 'terminateMicrovm').map(call => call.input).slice(0, 1), [survivor.microvmId]);
  const operations = next.fake.calls.filter(call => call.input === survivor.microvmId).map(call => call.operation);
  assert.equal(operations.lastIndexOf('microvm') > operations.indexOf('terminateMicrovm'), true, 'cessation was read from the service after the request');
  // The record: Control's durable reconciliation of the Execution, the boot's own record and the inventory's.
  const crashed = crashedOf(work)!;
  const recovery = crashed.recovery![0]!;
  assert.deepEqual([recovery.trigger, recovery.cessation.result, recovery.cessation.basis, recovery.cessation.boot], ['boot', 'confirmed', 'sandbox-stop', crashed.dispatch.boot]);
  assert.deepEqual([crashed.state, crashed.end?.code, crashed.end?.cessation, crashed.slot.held], ['ended', 'CONTROLLER_CRASH', 'confirmed', false]);
  const boot = JSON.parse(await readFile(join(world.root, 'lambda', 'works', crashed.dispatch.environment!, 'boots', crashed.dispatch.boot!, 'boot.json'), 'utf8')) as {
    phase: string; microvmId: string; stop: { reason: string; detail: string }; end: { reason: string; terminatedAt: string } };
  assert.deepEqual([boot.phase, boot.microvmId, boot.end.reason, boot.end.terminatedAt], ['ended', survivor.microvmId, 'end', new Date(ended.terminatedAt!).toISOString()]);
  assert.match(boot.stop.detail, /controller recovery/);
  const inventories = await readdir(join(world.root, 'lambda', 'reconciliations'));
  assert.equal(inventories.length, 1);
  const inventory = JSON.parse(await readFile(join(world.root, 'lambda', 'reconciliations', inventories[0]!), 'utf8')) as { evidence: string; otherInstallations: number;
    microvms: { microvmId: string; workId: string; action: string }[] };
  assert.deepEqual([inventory.evidence, inventory.otherInstallations, inventory.microvms.map(item => [item.microvmId, item.workId, item.action])],
    ['GetMicrovm', 1, [[survivor.microvmId, workId, 'listed']]]);

  // The other installation's MicroVM was never touched, read or named.
  assert.equal(next.fake.account.microvms.find(microvm => microvm.microvmId === other.microvmId)!.state, 'RUNNING');
  assert.equal(next.fake.calls.some(call => call.input === other.microvmId || call.input === other.imageArn), false);
  assert.equal(JSON.stringify(inventory).includes(other.microvmId), false);

  stop.abort();
  await running;
  assert.equal(next.fake.account.microvms.find(microvm => microvm.microvmId === other.microvmId)!.state, 'RUNNING');
});
