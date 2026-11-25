// Spec #68 §13: the in-process Investigation Environment port the Control and worker tests compose. It keeps the port's contract
// (bounds per command, stop confirmation, directories removed at the end) without the real mechanisms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInProcessInvestigationEnvironment } from './investigation-in-process.js';

const limits = { memoryGiB: 2, processes: 512, commandSeconds: 120 };
const agent = { executable: '/bin/sh', argv: ['-c', 'exec sleep 100000'], env: {} };

async function withRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'fip-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('in-process port: commands read a mounted clone, write the temporary space, and the directories go at close', () =>
  withRoot(async root => {
    const port = createInProcessInvestigationEnvironment({ root });
    const opened = await port.open(await port.plan('request-1-1'), { limits, agent });
    assert.ok(opened.status === 'success');
    await mkdir(join(opened.clones, 'api'));
    await writeFile(join(opened.clones, 'api', 'README.md'), 'hello\n');
    const clone = await port.mountClone('request-1-1', { name: 'api', source: join(opened.clones, 'api') });
    const shell = await port.shell('request-1-1');
    assert.deepEqual(await shell.exec({ command: 'cat README.md', cwd: clone.path }), { status: 'completed', exitCode: 0, signal: null, output: 'hello\n' });
    assert.deepEqual(await shell.exec({ command: 'echo note > "$TMPDIR/n" && pwd' }), {
      status: 'completed',
      exitCode: 0,
      signal: null,
      output: `${shell.temporary}\n`,
    });
    assert.deepEqual(port.controls.active(), ['request-1-1']);

    assert.deepEqual(await port.close(opened.record), { cessationConfirmed: false, code: 'INVESTIGATION_UNIT_ACTIVE' });
    assert.deepEqual(await port.stop(opened.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
    assert.deepEqual(await shell.exec({ command: 'echo late' }), { status: 'failed', code: 'INVESTIGATION_COMMAND_UNAVAILABLE', output: '' });
    assert.deepEqual(await port.close(opened.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(port.controls.calls(), ['open request-1-1', 'stop request-1-1']);
  }));

test('in-process port: a command past its time fails alone and large output is cut with a notice', () =>
  withRoot(async root => {
    const port = createInProcessInvestigationEnvironment({ root });
    const opened = await port.open(await port.plan('request-2-1'), { limits: { ...limits, commandSeconds: 0.2, outputBytes: 10 }, agent });
    assert.ok(opened.status === 'success');
    const shell = await port.shell('request-2-1');
    assert.deepEqual(await shell.exec({ command: 'echo started; exec sleep 100000' }), {
      status: 'failed',
      code: 'INVESTIGATION_COMMAND_TIMEOUT',
      output: 'started\n',
    });
    assert.deepEqual(await shell.exec({ command: 'printf %s 0123456789abcdef' }), {
      status: 'completed',
      exitCode: 0,
      signal: null,
      output: '0123456789',
      notice: 'OUTPUT_TRUNCATED: kept the first 10 of 16 bytes',
    });
    assert.deepEqual(await port.stop(opened.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  }));

test('in-process port: a withheld stop, a silent manager and a divergent invocation never confirm; a Host reboot does', () =>
  withRoot(async root => {
    const port = createInProcessInvestigationEnvironment({ root });
    const opened = await port.open(await port.plan('request-3-1'), { limits, agent });
    assert.ok(opened.status === 'success');
    const { record } = opened;

    assert.deepEqual(await port.stop({ ...record, invocation: 'f'.repeat(32) }), { cessationConfirmed: false, code: 'INVESTIGATION_INVOCATION_MISMATCH' });
    port.controls.managerAnswers(false);
    assert.deepEqual(await port.stop(record), { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' });
    assert.deepEqual(port.controls.active(), ['request-3-1'], 'nothing was stopped without the manager');
    port.controls.managerAnswers(true);

    port.controls.withholdStopConfirmation();
    assert.deepEqual(await port.stop(record), { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' });
    assert.deepEqual(await port.observe(record), { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' });
    assert.deepEqual(await port.close(record), { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' });
    assert.deepEqual(await readdir(root), ['request-3-1']);
    port.controls.releaseStopConfirmation();
    assert.deepEqual(await port.observe(record), { cessationConfirmed: true, evidence: 'unit-inactive' });

    const second = await port.open(await port.plan('request-3-2'), { limits, agent });
    assert.ok(second.status === 'success');
    port.controls.withholdStopConfirmation();
    port.controls.rebootHost();
    assert.deepEqual(await port.observe(second.record), { cessationConfirmed: true, evidence: 'host-rebooted' });
    assert.deepEqual(port.controls.active(), []);
  }));
