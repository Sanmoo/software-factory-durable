import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, installationTagKey, selectSandboxAdapter, workTagKey, type BootRef, type EnvironmentRef, type GuestExecResult } from '../../src/sandbox/index.js';
import { accountClock, lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';

// v2 ticket 04 (V2-02 Iniciar/Observar/Parar, V2-09, V2-10, V2-20, V2-22, V2-24, V2-25, V2-28, V2-34): a whole boot under the Lambda adapter,
// without an agent, over the in-memory account and the in-process guest. No AWS call, no ssh, no socket; time is the account's fake clock.
const baseConfiguration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const ryuk = `docker.io/testcontainers/ryuk@sha256:${sha('a')}`;
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: sha('d'), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [{ name: 'maven', version: '3.9.11-r0' }], images: [{ reference: ryuk }] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const builderToken = 'ghs_builderTokenOfThisExecution';
const checkout = { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1', credential: { token: builderToken } };

async function installation(t: TestContext, profile: Record<string, unknown> = {}) {
  const configuration = { ...baseConfiguration, ...profile };
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-boot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guest = lambdaGuestFake(fake);
  guest.world.origins[remote] = { commits: [startingCommit, '2'.repeat(40)], token: builderToken };
  /** The fake clock: every wait of the adapter only moves the account's time. */
  const clock = accountClock(fake);
  /** A sandbox as ANOTHER host process would compose it: same root, nothing shared in memory. */
  const compose = () => createSandbox({ root, lambdaService: fake.service, lambdaTransport: guest.transport, lambdaBootClock: clock,
    lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const sandbox = compose();
  const prepared = await sandbox.prepare({ workId, configuration, environment: pinned });
  assert.equal(prepared.status, 'success');
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const start = (change: Partial<Parameters<typeof sandbox.start>[0]> = {}) => sandbox.start({ environment, configuration, checkout, ...change });
  const started = async () => {
    const result = await start();
    assert.equal(result.status, 'success', JSON.stringify(result));
    return (result as { boot: BootRef }).boot;
  };
  const microvm = (index = -1) => fake.account.microvms.at(index)!;
  const operations = () => fake.mutations.map(call => call.operation).filter(operation => operation === 'runMicrovm' || operation === 'terminateMicrovm');
  return { root, fake, guest, clock, compose, sandbox, environment, start, started, microvm, operations };
}
const exited = (result: GuestExecResult) => { assert.equal(result.status, 'exited', JSON.stringify(result)); return result as Extract<GuestExecResult, { status: 'exited' }>; };

test('Start runs a new MicroVM with installation and Work tags, no execution role and no idle suspension, and succeeds only with the channel up and the starting commit cloned', async t => {
  const { fake, guest, sandbox, environment, start, microvm } = await installation(t);
  const result = await start();
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(fake.account.microvms.length, 1);
  const run = microvm();
  assert.equal(run.state, 'RUNNING');
  assert.deepEqual(run.request.tags, { [installationTagKey]: 'acme', [workTagKey]: workId });
  assert.equal(run.request.maximumDurationSeconds, 3600);
  assert.equal(run.executionRole, null);
  assert.equal(run.idlePolicy, null);
  assert.deepEqual(Object.keys(run.request).sort(), ['imageArn', 'maximumDurationSeconds', 'runHookPayload', 'tags']);
  assert.match(run.egress.join(), /:INTERNET_EGRESS$/);
  assert.match(run.ingress.join(), /:HTTP_INGRESS$/);
  // The commit is the one cloned from `origin` INSIDE the guest, on the Work branch.
  assert.deepEqual(guest.guestOf(run.microvmId)?.repository, { remote, commit: startingCommit, branch: 'factory/work-1' });
  assert.equal(result.status === 'success' && (await sandbox.observe({ environment, boot: result.boot })).condition, 'active');
});

test('the run hook payload carries only the session public key; the Git credential travels as process environment, never in a script, a guest file or a host record', async t => {
  const { root, guest, started, microvm } = await installation(t);
  await started();
  const payload = JSON.parse(microvm().request.runHookPayload) as Record<string, string>;
  assert.deepEqual(Object.keys(payload), ['builder']);
  assert.match(payload.builder!, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
  const inside = guest.guestOf(microvm().microvmId)!;
  const clone = inside.executions.find(execution => execution.program === 'clone')!;
  assert.deepEqual(clone.environmentNames, ['FACTORY_GIT_TOKEN', 'GIT_TERMINAL_PROMPT']);
  assert.ok(inside.executions.every(execution => !execution.script.includes(builderToken)));
  assert.deepEqual([...inside.files.values()].filter(text => text.includes(builderToken)), []);
  // Nothing AWS and no secret of the host is in what the service or the guest received.
  assert.doesNotMatch(JSON.stringify([microvm().request, inside.executions]), /AKIA|aws_secret|factory-session|PRIVATE KEY|fake-proxy-token/);
  const files = await readdir(join(root, 'lambda'), { recursive: true });
  for (const file of files.filter(name => name.endsWith('.json') || name.endsWith('.log'))) {
    assert.doesNotMatch(await readFile(join(root, 'lambda', file), 'utf8'), new RegExp(`${builderToken}|fake-proxy-token|PRIVATE KEY`), file);
  }
});

test('a refused clone fails the start with the cause, ends the MicroVM and never shows the credential', async t => {
  const { fake, guest, sandbox, environment, start, microvm, operations } = await installation(t);
  guest.world.origins[remote]!.token = 'another-credential';
  const result = await start();
  assert.equal(result.status, 'failure');
  assert.ok(result.status === 'failure' && result.boot);
  assert.equal(result.code, 'CLONE_FAILED');
  assert.match(result.detail ?? '', /Authentication failed/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(builderToken));
  assert.deepEqual(operations(), ['runMicrovm', 'terminateMicrovm']);
  assert.equal(microvm().state, 'TERMINATED');
  const record = await sandbox.bootRecord({ environment, boot: result.boot });
  assert.equal(record?.end?.reason, 'end');
  assert.equal(record?.end?.code, 'CLONE_FAILED');
  assert.equal(fake.account.microvms.length, 1);
});

test('a commit that origin does not have, a failed run hook and a refused RunMicrovm are start failures with their own codes', async t => {
  const { fake, start, microvm } = await installation(t);
  const absent = await start({ checkout: { ...checkout, commit: '9'.repeat(40) } });
  assert.deepEqual([absent.status, absent.status !== 'success' && absent.code], ['failure', 'CLONE_FAILED']);
  assert.equal(microvm().state, 'TERMINATED');
  fake.account.runHookFails = true;
  const hook = await start();
  assert.deepEqual([hook.status, hook.status !== 'success' && hook.code], ['failure', 'MICROVM_RUN_HOOK_FAILED']);
  fake.account.runHookFails = false;
  fake.account.runRefusal = { kind: 'capacity', detail: 'InsufficientCapacityException' };
  const refused = await start();
  assert.deepEqual([refused.status, refused.status !== 'success' && refused.code], ['failure', 'SERVICE_CAPACITY_REFUSED']);
  assert.equal(fake.account.microvms.length, 2);
  // An answer that does not say whether a MicroVM was created is not a failure: the boot stays unconfirmed.
  fake.account.runRefusal = { kind: 'unknown', detail: 'Unreadable answer' };
  const unknown = await start();
  assert.deepEqual([unknown.status, unknown.status !== 'success' && unknown.code], ['indeterminate', 'MICROVM_START_UNCONFIRMED']);
});

test('a guest that reports another HEAD than the starting commit does not give a started boot', async t => {
  const { guest, start, microvm } = await installation(t);
  guest.world.programs.clone = () => ({ exitCode: 0, stdout: `HEAD ${'2'.repeat(40)}\n` });
  const result = await start();
  assert.deepEqual([result.status, result.status !== 'success' && result.code], ['failure', 'STARTING_COMMIT_MISMATCH']);
  assert.equal(microvm().state, 'TERMINATED');
});

test('Start waits for the MicroVM to run and for its sshd, and gives up with the MicroVM ended when the channel never comes up', async t => {
  const { fake, guest, clock, start, microvm } = await installation(t);
  fake.account.pendingSeconds = 20;
  guest.world.sshReadySeconds = 30;
  const before = clock.now();
  assert.equal((await start()).status, 'success');
  assert.ok(clock.now() - before >= 50_000 && clock.now() - before < 70_000);
  fake.account.terminateSeconds = 5;
  guest.world.sshReadySeconds = 100_000;
  const never = await start({ reason: 'start' });
  assert.deepEqual([never.status, never.status !== 'success' && never.code], ['failure', 'PREVIOUS_BOOT_NOT_CEASED']);
  fake.kill(microvm().microvmId);
  const unreachable = await start();
  assert.deepEqual([unreachable.status, unreachable.status !== 'success' && unreachable.code], ['failure', 'CHANNEL_UNREACHABLE']);
  assert.equal(microvm().state, 'TERMINATED');
});

test('Start without a prepared image, without a checkout or with a value the host would not place in a guest script starts no MicroVM', async t => {
  const { fake, sandbox, environment, start } = await installation(t);
  const other = `env-${sha('f')}` as EnvironmentRef;
  assert.deepEqual(await sandbox.start({ environment: other, configuration: baseConfiguration, checkout }), { status: 'failure', code: 'ENVIRONMENT_NOT_PREPARED' });
  assert.deepEqual(await sandbox.start({ environment: '../etc' as EnvironmentRef, configuration: baseConfiguration, checkout }), { status: 'failure', code: 'ENVIRONMENT_REF_INVALID' });
  assert.deepEqual(await sandbox.start({ environment, configuration: baseConfiguration }), { status: 'failure', code: 'CHECKOUT_REQUIRED' });
  assert.deepEqual(await start({ checkout: { ...checkout, commit: 'main; rm -rf /' } }), { status: 'failure', code: 'CHECKOUT_INVALID' });
  assert.deepEqual(await start({ checkout: { ...checkout, branch: '--upload-pack=x' } }), { status: 'failure', code: 'CHECKOUT_INVALID' });
  assert.deepEqual(fake.mutations.filter(call => call.operation === 'runMicrovm'), []);
});

test('every boot starts empty and pulls the declared Docker images by digest again; a failed pull fails the start', async t => {
  const { guest, sandbox, environment, started, start, microvm } = await installation(t);
  const first = await started();
  const one = guest.guestOf(microvm().microvmId)!;
  assert.deepEqual(one.dockerImages, [ryuk]);
  one.files.set('/home/builder/.m2/cache', 'left by the first boot');
  assert.equal((await sandbox.stop({ environment, boot: first, reason: 'end' })).status, 'success');
  await started();
  const two = guest.guestOf(microvm().microvmId)!;
  assert.notEqual(two.microvmId, one.microvmId);
  assert.deepEqual([...two.files.keys()], []);
  assert.deepEqual(two.dockerImages, [ryuk]);
  assert.deepEqual(two.repository, { remote, commit: startingCommit, branch: 'factory/work-1' });
  assert.equal((await sandbox.stop({ environment, boot: (await sandbox.observe({ environment })).boot!, reason: 'end' })).status, 'success');
  guest.world.pullFailures.push(ryuk);
  const failed = await start();
  assert.deepEqual([failed.status, failed.status !== 'success' && failed.code], ['failure', 'DECLARED_IMAGE_PULL_FAILED']);
  assert.equal(microvm().state, 'TERMINATED');
});

test('Start is always a new boot: a previous boot the service still reports running is never adopted nor silently replaced', async t => {
  const { fake, sandbox, environment, started, start } = await installation(t);
  const first = await started();
  const second = await start();
  assert.deepEqual(second, { status: 'failure', code: 'PREVIOUS_BOOT_NOT_CEASED', boot: first });
  assert.equal(fake.account.microvms.length, 1);
  assert.equal((await sandbox.stop({ environment, boot: first, reason: 'planned-swap' })).status, 'success');
  const swapped = await start({ reason: 'planned-swap' });
  assert.equal(swapped.status, 'success');
  assert.ok(swapped.status === 'success' && swapped.boot !== first);
  assert.equal(fake.account.microvms.length, 2);
});

test('each boot has its own session key and its own pinned host key; a guest presenting another host key is refused before anything runs', async t => {
  const { guest, sandbox, environment, started, microvm } = await installation(t);
  const first = await started();
  const firstRecord = await sandbox.bootRecord({ environment, boot: first });
  const firstPayload = microvm().request.runHookPayload;
  assert.equal(firstRecord?.hostKey, guest.guestOf(microvm().microvmId)!.hostKey);
  await sandbox.stop({ environment, boot: first, reason: 'end' });
  const second = await started();
  const secondRecord = await sandbox.bootRecord({ environment, boot: second });
  assert.notEqual(microvm().request.runHookPayload, firstPayload);
  assert.notEqual(secondRecord?.hostKey, firstRecord?.hostKey);

  const opened = await sandbox.openChannel({ environment, boot: second });
  assert.ok(opened.status === 'open');
  const inside = guest.guestOf(microvm().microvmId)!;
  guest.world.programs.whoami = () => ({ exitCode: 0, stdout: 'builder\n' });
  assert.equal(exited(await opened.channel.exec({ program: 'whoami', script: 'whoami' })).stdout, 'builder\n');
  const ran = inside.executions.length;
  // Another machine answers at the endpoint (or the guest's key changed): not the key the host pinned for this boot.
  inside.hostKey = firstRecord!.hostKey!;
  assert.deepEqual(await opened.channel.exec({ program: 'whoami', script: 'whoami' }), { status: 'refused', code: 'HOST_KEY_MISMATCH', detail: 'Host key verification failed.' });
  assert.equal(inside.executions.length, ran);
});

test('a command runs over the channel with keepalive on every connection, and a boot outlives its ingress tokens', async t => {
  const { fake, guest, clock, sandbox, environment, started } = await installation(t, { maxBootSeconds: 7200 });
  const boot = await started();
  const opened = await sandbox.openChannel({ environment, boot });
  assert.ok(opened.status === 'open');
  guest.world.programs.build = (_guest, request) => ({ exitCode: 7, stdout: `ran ${request.script}\n`, stderr: 'warning\n' });
  assert.deepEqual(await opened.channel.exec({ program: 'build', script: 'mvn -q verify' }), { status: 'exited', exitCode: 7, stdout: 'ran mvn -q verify\n', stderr: 'warning\n' });
  assert.ok(guest.connections.length > 0 && guest.connections.every(connection => connection.keepaliveSeconds === 15 && connection.user === 'builder'));

  // A connection opened with a valid token stays open after the token expires (the service only checks it when the WebSocket opens).
  let finish: (result: { exitCode: number; stdout: string }) => void = () => {};
  guest.world.programs.long = () => new Promise(resolve => { finish = resolve; });
  const long = opened.channel.exec({ program: 'long', script: 'sleep 4000' });
  await new Promise(resolve => { setImmediate(resolve); });
  await clock.sleep(61 * 60_000);
  assert.ok(fake.account.tokens.every(token => token.expiresAt <= fake.account.clock.now));
  finish({ exitCode: 0, stdout: 'done\n' });
  assert.equal(exited(await long).stdout, 'done\n');
  // The next connection needs a token again: the host issues a fresh one instead of failing.
  const issued = fake.account.tokens.length;
  assert.equal(exited(await opened.channel.exec({ program: 'build', script: 'true' })).exitCode, 7);
  assert.equal(fake.account.tokens.length, issued + 1);
});

test('withdrawing access is closing the connection: an open program is cut at once, with every token still valid, and nothing more runs', async t => {
  const { fake, guest, sandbox, environment, started } = await installation(t);
  const boot = await started();
  const opened = await sandbox.openChannel({ environment, boot });
  assert.ok(opened.status === 'open');
  guest.world.programs.long = () => new Promise(() => { /* Never ends by itself. */ });
  const long = opened.channel.exec({ program: 'long', script: 'sleep 4000' });
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(guest.connections.at(-1)?.open, true);
  opened.channel.close();
  assert.deepEqual(await long, { status: 'closed' });
  assert.equal(guest.connections.at(-1)?.open, false);
  assert.ok(fake.account.tokens.some(token => token.expiresAt > fake.account.clock.now));
  assert.deepEqual(await opened.channel.exec({ program: 'long', script: 'true' }), { status: 'closed' });
});

test('Observe gives the condition the service reports, from a process that did not create the boot', async t => {
  const { fake, compose, environment, started, microvm } = await installation(t);
  const boot = await started();
  const other = compose();
  const active = await other.observe({ environment });
  assert.deepEqual([active.condition, active.cessationConfirmed, active.boot, active.lifecycle?.state], ['active', false, boot, 'RUNNING']);
  assert.deepEqual(fake.calls.at(-1), { operation: 'microvm', awsProfile: 'factory', region: 'us-east-1', input: microvm().microvmId });
  // The service cannot be read: the condition is unknown, never assumed.
  fake.account.denied.push('lambda:GetMicrovm');
  assert.deepEqual(await other.observe({ environment, boot }), { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable' });
  fake.account.denied.length = 0;
});

test('a MicroVM that died by itself is observed as stopped and recorded as a loss, with the evidence not collected before the death declared lost', async t => {
  const { root, fake, compose, sandbox, environment, started, microvm } = await installation(t);
  const boot = await started();
  fake.account.clock.now += 3600_000;
  const observed = await compose().observe({ environment, boot });
  assert.deepEqual([observed.condition, observed.cessationConfirmed, observed.lifecycle?.stateReason], ['stopped', true, 'MicroVM exceeded maximum lifetime.']);
  const record = (await sandbox.bootRecord({ environment, boot }))!;
  assert.equal(record.end?.reason, 'loss');
  assert.equal(record.end?.terminatedAt, new Date(microvm().terminatedAt!).toISOString());
  // What the host read at the start is kept; everything after it never left the guest.
  assert.deepEqual(record.evidence.collected.map(entry => entry.label), ['start']);
  assert.match(record.evidence.lost ?? '', /guest evidence after the collection of .* is lost/);
  assert.match(await readFile(join(root, 'lambda', 'works', environment, 'boots', boot, 'evidence', 'start.log'), 'utf8'), /===== \/var\/log\/factory-done\nboot-done pull=0/);
  assert.equal((await sandbox.openChannel({ environment, boot })).status, 'unavailable');
  assert.deepEqual((await readdir(join(root, 'lambda', 'works', environment, 'boots', boot))).sort(), ['boot.json', 'evidence']);
  // Stopping a boot that is already dead confirms cessation without pretending it was a requested end.
  assert.equal((await sandbox.stop({ environment, boot, reason: 'end' })).status, 'success');
  assert.equal((await sandbox.bootRecord({ environment, boot }))?.end?.reason, 'loss');
});

test('Stop collects the guest evidence, withdraws access, terminates the MicroVM and confirms only when the service reports it terminated', async t => {
  const { root, fake, guest, compose, sandbox, environment, started, microvm } = await installation(t);
  const boot = await started();
  const stopped = await compose().stop({ environment, boot, reason: 'end' });
  assert.deepEqual(stopped, { status: 'success', cessationConfirmed: true, termination: 'forced', guestFinalization: 'unavailable' });
  assert.equal(microvm().state, 'TERMINATED');
  assert.deepEqual(fake.mutations.at(-1), { operation: 'terminateMicrovm', awsProfile: 'factory', region: 'us-east-1', input: microvm().microvmId });
  const record = (await sandbox.bootRecord({ environment, boot }))!;
  assert.deepEqual(record.evidence.collected.map(entry => entry.label), ['start', 'stop']);
  assert.equal(record.evidence.lost, null);
  // No disk, workspace or key survives on the host: only the record and the collected evidence.
  assert.deepEqual((await readdir(join(root, 'lambda', 'works', environment, 'boots', boot), { recursive: true })).sort(), ['boot.json', 'evidence', 'evidence/start.log', 'evidence/stop.log']);
  assert.deepEqual(await sandbox.openChannel({ environment, boot }), { status: 'unavailable', code: 'BOOT_NOT_ACTIVE' });
  assert.equal(guest.connections.every(connection => !connection.open), true);
  const after = await sandbox.observe({ environment });
  assert.deepEqual([after.condition, after.cessationConfirmed, after.boot], ['stopped', true, boot]);
});

test('an end the service does not confirm is indeterminate, never success, even though the terminate request was accepted', async t => {
  const { fake, sandbox, environment, started, microvm } = await installation(t);
  const boot = await started();
  fake.account.terminateSeconds = null;
  const before = fake.account.clock.now;
  assert.deepEqual(await sandbox.stop({ environment, boot, reason: 'end' }), { status: 'indeterminate', code: 'CESSATION_NOT_CONFIRMED', cessationConfirmed: false });
  assert.equal(microvm().state, 'TERMINATING');
  assert.ok(fake.account.clock.now - before >= 120_000);
  const observed = await sandbox.observe({ environment, boot });
  assert.deepEqual([observed.condition, observed.cessationConfirmed], ['indeterminate', false]);
  assert.equal((await sandbox.bootRecord({ environment, boot }))?.end, undefined);
  // Access was withdrawn all the same: it never depended on the confirmation or on a token expiring.
  assert.equal((await sandbox.openChannel({ environment, boot })).status, 'unavailable');
  // When the service finally reports the end, it is the requested end that is recorded.
  microvm().terminatesAt = fake.account.clock.now;
  assert.equal((await sandbox.stop({ environment, boot, reason: 'end' })).status, 'success');
  assert.equal((await sandbox.bootRecord({ environment, boot }))?.end?.reason, 'end');
});

test('every boot is recorded with identity, reasons, size, start and end', async t => {
  const { fake, sandbox, environment, started, start, microvm } = await installation(t);
  const first = await started();
  const firstVm = microvm();
  fake.account.clock.now += 600_000;
  await sandbox.stop({ environment, boot: first, reason: 'planned-swap' });
  const second = await start({ reason: 'planned-swap' });
  assert.ok(second.status === 'success');
  await sandbox.stop({ environment, boot: second.boot, reason: 'the Execution completed' });
  const boots = await sandbox.boots({ environment });
  assert.deepEqual(boots.map(record => [record.boot, record.begin.reason, record.end?.reason, record.stop?.detail]),
    [[first, 'start', 'planned-swap', undefined], [second.boot, 'planned-swap', 'end', 'the Execution completed']]);
  const record = boots[0]!;
  assert.deepEqual([record.workId, record.microvmId, record.imageArn, record.phase], [workId, firstVm.microvmId, firstVm.imageArn, 'ended']);
  assert.deepEqual(record.size, { baselineMemoryMiB: 1024, peakMemoryMiB: 4096, peakVcpus: 2 });
  assert.equal(record.maxBootSeconds, 3600);
  // Start and end are the service's own instants.
  assert.equal(record.startedAt, new Date(firstVm.startedAt).toISOString());
  assert.equal(record.end?.terminatedAt, new Date(firstVm.terminatedAt!).toISOString());
  assert.equal(record.end?.stateReason, 'Success.');
  assert.deepEqual(record.checkout, { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1' });
});

test('the adapter declares its egress: any public IPv4 destination by TCP without mediation, no UDP, no IPv6, no private network', () => {
  const selection = selectSandboxAdapter(baseConfiguration);
  assert.ok(selection.status === 'selected');
  assert.deepEqual(selection.capabilities.egress, { mediation: 'none', publicTcp: true, udp: false, ipv6: false, privateNetwork: false });
});

// v2 ticket 08 (Operator decision 3D): `/artifacts` across boots.
test('a new boot receives only the spec and instructions collected before the previous stop; a boot that died before its collection is declared lost and the host sends what it still holds', async t => {
  const { fake, guest, sandbox, environment, start, microvm } = await installation(t);
  // The first boot of an environment has nothing to receive and says nothing about artifacts.
  const first = await start();
  assert.ok(first.status === 'success');
  assert.equal(first.artifacts, undefined);
  const disk = guest.guestOf(microvm().microvmId)!;
  disk.files.set('/artifacts/spec/v1/sources.json', '{"sources":[{"copy":"./ticket.json"}]}');
  disk.files.set('/artifacts/spec/v1/ticket.json', '{"body":"x"}');
  disk.files.set('/artifacts/instructions/v1/AGENTS.md', '# agents\n');
  disk.files.set('/artifacts/review/r1/index.json', '{}');
  disk.files.set('/artifacts/factory-output-1.txt', 'an output copy');
  disk.files.set('/workspace/checkout/node_modules/x.js', 'ignored');
  assert.equal((await sandbox.stop({ environment, boot: first.boot, reason: 'question' })).status, 'success');

  const second = await start();
  assert.ok(second.status === 'success', JSON.stringify(second));
  assert.deepEqual(second.artifacts, { restored: ['spec/v1', 'instructions/v1'], from: first.boot, lost: [] });
  const next = guest.guestOf(microvm().microvmId)!;
  assert.notEqual(next, disk, 'nothing of the previous boot is adopted: another MicroVM, another disk');
  assert.equal(next.files.get('/artifacts/spec/v1/ticket.json'), '{"body":"x"}');
  assert.equal(next.files.get('/artifacts/instructions/v1/AGENTS.md'), '# agents\n');
  assert.deepEqual([...next.files.keys()].filter(path => path.startsWith('/artifacts/review/') || path.includes('factory-output') || path.includes('node_modules')), []);
  assert.deepEqual((await sandbox.bootRecord({ environment, boot: second.boot }))?.restored, { restored: ['spec/v1', 'instructions/v1'], from: first.boot, lost: [] });
  // The preserved source of an inherited round verifies in the new boot (end-of-Execution verification).
  assert.deepEqual(await sandbox.verifyPreservedSource({ environment, reference: '/artifacts/spec/v1/ticket.json#body' }), { status: 'verified', code: 'PRESERVED_SOURCE_VERIFIED' });

  // The second boot writes v2 and dies before any collection: its versions are lost, v1 is still what the host holds.
  next.files.set('/artifacts/spec/v2/ticket.json', '{"body":"y"}');
  microvm().terminatesAt = fake.account.clock.now;
  fake.account.clock.now += 1000;
  assert.equal((await sandbox.observe({ environment, boot: second.boot })).cessationConfirmed, true);
  const third = await start();
  assert.ok(third.status === 'success', JSON.stringify(third));
  assert.deepEqual(third.artifacts, { restored: ['spec/v1', 'instructions/v1'], from: first.boot, lost: [second.boot] });
  assert.equal(guest.guestOf(microvm().microvmId)!.files.has('/artifacts/spec/v2/ticket.json'), false);
});
