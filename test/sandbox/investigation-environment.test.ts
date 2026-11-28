// Layer R: the real mechanisms of the Investigation Environment, one scenario each. Real bubblewrap
// inside a real transient unit of the user manager. Without bubblewrap or the user manager these tests FAIL; they never skip.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createInvestigationEnvironment,
  type InvestigationCommandResult,
  type InvestigationLimits,
  type InvestigationRecord,
} from '../../src/sandbox/index.js';
import { until, untilHolds } from '../runner/budget.js';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./investigation-agent-fixture.js', import.meta.url));
const credential = `canary-${randomBytes(8).toString('hex')}`;
const cleanups: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** One real attempt: a Factory root, the port over it, and the fixture agent running inside the attempt's unit. */
async function openAttempt(limits: InvestigationLimits) {
  const factoryRoot = await mkdtemp(join(tmpdir(), 'fie-'));
  const root = join(factoryRoot, 'investigations');
  const port = createInvestigationEnvironment({ root, factoryRoot });
  const attempt = `t${randomBytes(6).toString('hex')}-1`;
  const socket = join(factoryRoot, 'agent.sock');
  const intent = await port.plan(attempt);
  const opened = await port.open(intent, {
    limits,
    agent: { executable: process.execPath, argv: [fixture, root, factoryRoot, attempt, socket], env: { GH_TOKEN: credential, FACTORY_MCP_TOKEN: credential } },
  });
  cleanups.push(async () => {
    await port.stop(intent);
    await rm(factoryRoot, { recursive: true, force: true });
  });
  assert.equal(opened.status, 'success', JSON.stringify(opened));
  assert.ok(opened.status === 'success');
  const exec = (command: string, cwd?: string) =>
    until(`the agent of ${attempt} answering ${command}`, async () => {
      try {
        return await new Promise<InvestigationCommandResult>((resolve, reject) => {
          let answer = '';
          const connection = connect(socket);
          connection.setEncoding('utf8');
          connection.on('error', reject);
          connection.on('data', chunk => (answer += chunk));
          connection.on('end', () => resolve(JSON.parse(answer) as InvestigationCommandResult));
          connection.on('connect', () => connection.write(`${JSON.stringify({ command, cwd })}\n`));
        });
      } catch (error) {
        // Only the agent not listening yet is retried; a command is never sent twice.
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) return undefined;
        throw error;
      }
    });
  return { port, factoryRoot, root, attempt, intent, record: opened.record, clones: opened.clones, exec };
}

const completed = (result: InvestigationCommandResult) => {
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(result.status === 'completed');
  return result;
};
const cgroupProcesses = async (record: InvestigationRecord) => {
  const uid = process.getuid?.();
  const procs = await readFile(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${record.unit}/cgroup.procs`, 'utf8');
  return procs.trim().split('\n').filter(Boolean).length;
};

test('a command inside the confinement has no network, no write outside the temporary space, no /home, no Factory root and no credential variable', async () => {
  const environment = await openAttempt({ memoryGiB: 2, processes: 512, commandSeconds: 120 });
  const { exec } = environment;

  // Network: the same command reaches a server on the Host from the Host, and nothing from inside.
  let connections = 0;
  const server = createServer(connection => {
    connections++;
    connection.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const dial = `exec 3<>/dev/tcp/127.0.0.1/${(server.address() as AddressInfo).port}`;
  await run('/usr/bin/bash', ['-c', dial]);
  await untilHolds('the Host server seeing the control connection', () => connections === 1);
  const dialled = completed(await exec(dial));
  assert.notEqual(dialled.exitCode, 0, dialled.output);
  assert.deepEqual(
    completed(await exec("sed -n 's/^ *\\([^ :]*\\):.*/\\1/p' /proc/net/dev"))
      .output.trim()
      .split('\n'),
    ['lo'],
    'the network namespace has only its own loopback',
  );
  assert.equal(connections, 1, 'no connection from inside the confinement reached the Host');

  // Clone: readable, never writable.
  await mkdir(join(environment.clones, 'payments-api'));
  await writeFile(join(environment.clones, 'payments-api', 'README.md'), 'original\n');
  const clone = await environment.port.mountClone(environment.attempt, { name: 'payments-api', source: join(environment.clones, 'payments-api') });
  assert.equal(completed(await exec('cat README.md', clone.path)).output, 'original\n');
  for (const write of ['echo changed > README.md', 'touch new-file', 'rm README.md']) {
    const refused = completed(await exec(write, clone.path));
    assert.notEqual(refused.exitCode, 0, `${write}: ${refused.output}`);
  }
  assert.equal(await readFile(join(environment.clones, 'payments-api', 'README.md'), 'utf8'), 'original\n');
  assert.deepEqual(await readdir(join(environment.clones, 'payments-api')), ['README.md']);

  // Reads outside what is allowed: /home and the Factory root, which the Host itself reads.
  await writeFile(join(environment.factoryRoot, 'config.yaml'), 'factory-secret\n');
  assert.equal((await run('/usr/bin/cat', [join(environment.factoryRoot, 'config.yaml')])).stdout, 'factory-secret\n');
  for (const read of ['ls /home', `cat ${join(environment.factoryRoot, 'config.yaml')}`, `ls ${environment.factoryRoot}`, `ls ${environment.root}`]) {
    const refused = completed(await exec(read));
    assert.notEqual(refused.exitCode, 0, `${read}: ${refused.output}`);
    assert.doesNotMatch(refused.output, /factory-secret/);
  }

  // Environment: the agent holds the credential variables, the command does not.
  const variables = completed(await exec('env'));
  assert.equal(variables.exitCode, 0);
  assert.doesNotMatch(variables.output, new RegExp(credential));
  assert.doesNotMatch(variables.output, /TOKEN|SECRET|PASSWORD|KEY/i);

  // Writes: the temporary space accepts them, nothing else does, and each command is a new confinement.
  const written = completed(await exec('echo scratch > "$TMPDIR/notes" && cat /tmp/notes && export KEPT=1 && cd /usr'));
  assert.deepEqual([written.exitCode, written.output], [0, 'scratch\n']);
  assert.equal(completed(await exec('echo "${KEPT:-unset} $PWD $(cat /tmp/notes)"')).output, 'unset /tmp scratch\n');
  for (const write of ['touch /outside', 'touch /usr/outside', 'touch /etc/outside', 'touch /repos/outside']) {
    const refused = completed(await exec(write));
    assert.notEqual(refused.exitCode, 0, `${write}: ${refused.output}`);
  }

  // End: the temporary space of the attempt is removed.
  assert.deepEqual(await environment.port.stop(environment.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(await environment.port.close(environment.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(await readdir(environment.root), []);
});

test('a command past its time is killed and its error returned without ending the environment; large output is truncated with a notice', async () => {
  // The injected deadline: 1 s instead of the 120 s of the installation default.
  const environment = await openAttempt({ memoryGiB: 2, processes: 512, commandSeconds: 1, outputBytes: 1000 });
  const { exec } = environment;
  assert.equal(completed(await exec('echo ready')).output, 'ready\n');

  const endless = await exec('echo started; sleep 100000');
  assert.deepEqual(endless, { status: 'failed', code: 'INVESTIGATION_COMMAND_TIMEOUT', output: 'started\n' });
  await untilHolds('only the agent left in the unit after the kill', async () => (await cgroupProcesses(environment.record)) === 1);

  assert.deepEqual(await environment.port.observe(environment.record), { cessationConfirmed: false, code: 'INVESTIGATION_UNIT_ACTIVE' });
  assert.equal(completed(await exec('echo still open')).output, 'still open\n');

  const large = completed(await exec("head -c 300000 /dev/zero | tr '\\0' a"));
  assert.equal(large.exitCode, 0);
  assert.equal(large.output, 'a'.repeat(1000));
  assert.equal(large.notice, 'OUTPUT_TRUNCATED: kept the first 1000 of 300000 bytes');
  assert.equal(completed(await exec('echo small')).notice, undefined);
});

test('the stop of an attempt is confirmed by the inactive unit of the same invocation with an empty cgroup', async () => {
  const environment = await openAttempt({ memoryGiB: 2, processes: 512, commandSeconds: 120 });
  const { port, record, exec } = environment;
  assert.match(record.invocation ?? '', /^[0-9a-f]{32}$/);
  assert.equal(record.unit, `factory-triage-${environment.attempt}.service`);
  assert.equal(completed(await exec('echo investigating')).output, 'investigating\n');

  // Running: nothing confirms, and the directories stay.
  assert.deepEqual(await port.observe(record), { cessationConfirmed: false, code: 'INVESTIGATION_UNIT_ACTIVE' });
  assert.deepEqual(await port.close(record), { cessationConfirmed: false, code: 'INVESTIGATION_UNIT_ACTIVE' });
  assert.deepEqual(await readdir(environment.root), [environment.attempt]);

  // A divergent InvocationID neither confirms nor stops the unit that runs under the name.
  const divergent = { ...record, invocation: 'f'.repeat(32) };
  assert.deepEqual(await port.stop(divergent), { cessationConfirmed: false, code: 'INVESTIGATION_INVOCATION_MISMATCH' });
  assert.equal(completed(await exec('echo untouched')).output, 'untouched\n');

  // The recorded invocation: agent and commands are in the same unit, so one confirmation covers both.
  assert.deepEqual(await port.stop(record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  const refusal = await new Promise<Error>(resolve => connect(join(environment.factoryRoot, 'agent.sock')).once('error', resolve));
  assert.match(String('code' in refusal && refusal.code), /^(ECONNREFUSED|ENOENT)$/, 'the agent no longer answers');
  assert.deepEqual(await port.observe(record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(await port.close(record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(await readdir(environment.root), []);
});
