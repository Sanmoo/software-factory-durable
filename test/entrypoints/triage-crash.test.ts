// Spec #68 TR-11 (ticket #76), layer R: the one real SIGKILL of a controller during an investigation. A real child controller starts a
// Triager attempt in the real Investigation Environment (transient unit of the user manager, production agent inside it) and is killed
// while the session waits for the model. A new Control over the same storage stops that attempt, confirms the stop, counts the attempt as
// spent and never reattaches to it: the request is investigated again by a new session. Without bubblewrap or the user manager this
// test FAILS; it never skips. Local process confinement only: no Factory VM.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { killTree, remainingMs, until, untilHolds } from '../runner/budget.js';
import { openCrashControl } from './triage-crash-world.js';

const run = promisify(execFile);
const activeState = async (unit: string) =>
  (await run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit], { timeout: remainingMs() })).stdout.trim();
const verdict = { outcome: 'needs-info', category: 'bug', text: 'Falta a versão em que o total ficou errado.' };

/** The model provider: the first session's request is never answered (the investigation in progress); the second session concludes. */
async function provider() {
  const bodies: string[] = [];
  let firstClosed = false;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      bodies.push(body);
      if (bodies.length === 1) {
        response.on('close', () => (firstClosed = true));
        return;
      }
      const chunk = (choice: unknown) => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [choice] })}\n\n`;
      const call = { index: 0, id: `call-${bodies.length}`, type: 'function', function: { name: 'concluir_triagem', arguments: JSON.stringify(verdict) } };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        chunk({ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }) +
          chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' }) +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    firstClosed: () => firstClosed,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
const userMessages = (body: string) => (JSON.parse(body) as { messages: { role: string }[] }).messages.filter(message => message.role === 'user').length;

test(
  'TR-11: after a real SIGKILL of the controller during an investigation, the new Control stops the attempt, confirms it and counts it as spent, never reattaching',
  { timeout: remainingMs() },
  async t => {
    const factoryRoot = await mkdtemp(join(tmpdir(), 'ftc-'));
    const storagePath = join(factoryRoot, 'control.sqlite');
    const model = await provider();
    const units: string[] = [];
    t.after(async () => {
      for (const unit of units) await run('systemctl', ['--user', 'stop', unit], { timeout: remainingMs() }).catch(() => {});
      await model.close();
      await rm(factoryRoot, { recursive: true, force: true });
    });

    // A real controller process investigates the request, then dies without any chance to stop its attempt.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./triage-crash-child.js', import.meta.url)), factoryRoot, storagePath, model.url], {
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: true,
    });
    t.after(() => killTree(child));
    const [, killed, unit] = await new Promise<string[]>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', chunk => {
        out += String(chunk);
        const line = /^INVESTIGATING (\S+) (\S+)$/m.exec(out);
        if (line) resolve([...line]);
      });
      child.once('exit', code => reject(new Error(`the child controller exited (${code}) before investigating`)));
    });
    units.push(unit!);
    await untilHolds('the Triager session of the killed controller to ask the model', () => model.bodies.length === 1);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    assert.equal(await activeState(unit!), 'active', 'the unit of the attempt outlives its controller: there is something to stop');

    // A new Control on the same storage: its first pass ends what the dead one left.
    const world = await openCrashControl({ factoryRoot, storagePath, modelUrl: model.url });
    const [before] = await world.requests();
    assert.deepEqual([before!.state, before!.attempts!.map(attempt => [attempt.attempt, attempt.end])], ['investigating', [[killed, null]]]);
    const stop = new AbortController();
    const running = world.control.run(stop.signal);
    t.after(async () => {
      stop.abort();
      await running;
    });
    await world.time.sleeping();
    const stopped = await until('the interrupted attempt to end', async () => {
      const [request] = await world.requests();
      return request?.attempts?.[0]?.end ? request : undefined;
    });
    const first = stopped.attempts![0]!;
    assert.deepEqual(
      [first.attempt, first.end?.code, first.end?.cessation],
      [killed, 'INVESTIGATION_INTERRUPTED', { cessationConfirmed: true, evidence: 'unit-inactive' }],
    );
    assert.equal(typeof first.end?.spentMs, 'number', 'the time of the interrupted attempt is counted');
    assert.notEqual(await activeState(unit!), 'active', 'the unit was really stopped');

    // Spent, with balance left: the request went back to the queue and a NEW session investigates it.
    const concluded = await until('the request to be investigated again up to its Verdict', async () => {
      const [request] = await world.requests();
      for (const attempt of request?.attempts ?? []) if (!units.includes(attempt.environment.unit)) units.push(attempt.environment.unit);
      return request?.state === 'publishing' && request.attempts?.every(attempt => attempt.end) ? request : undefined;
    });
    const events = concluded.timeline.map(entry => (entry.code && entry.event !== 'attempt-started' ? `${entry.event} ${entry.code}` : entry.event));
    assert.deepEqual(events, [
      'requested',
      'attempt-started',
      'attempt-ended INVESTIGATION_INTERRUPTED',
      'requeued',
      'attempt-started',
      'verdict-recorded',
      'attempt-ended VERDICT_RECORDED',
    ]);
    assert.equal(concluded.attempts!.length, 2, 'the interrupted attempt counts: one of the two is gone');
    const second = concluded.attempts![1]!;
    assert.notEqual(second.attempt, killed);
    assert.notEqual(second.environment.unit, unit);
    assert.deepEqual([concluded.verdict?.attempt, second.end?.cessation], [second.attempt, { cessationConfirmed: true, evidence: 'unit-inactive' }]);
    // Never reattached: the session of the killed controller died with its unit, and the Verdict came from a session of its own.
    assert.equal(model.bodies.length, 2);
    assert.equal(model.firstClosed(), true, 'the model request of the old session was dropped, not resumed');
    assert.equal(userMessages(model.bodies[1]!), 1, 'the new session starts from its first prompt');
  },
);
