import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareController } from './controller-configuration.js';
import { connect, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { remainingMs, until } from '../runner/budget.js';

async function exchange(endpoint: string, envelope: Envelope) {
  const channel = await connect(endpoint, 'local-operator');
  try {
    await channel.send(envelope);
    for await (const response of channel.messages) return response;
    assert.fail('missing controller response');
  } finally { channel.close(); }
}
function request(kind: string, payload: Envelope['payload'], id: string, run: string | null): Envelope {
  return { protocol_version: protocolVersion, controller_run_id: run, message_id: id, reply_to: null, kind, payload };
}

test('lost ACK is queryable and concurrent identical ingress commits only once; conflicting content is refused', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-ingress-'));
  await prepareController(root);
  const owner = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), 'run', '--root', root], { stdio: 'ignore' });
  let spawnFailed = false;
  owner.once('error', () => { spawnFailed = true; });
  const ended = new Promise(resolve => { owner.once('exit', resolve); owner.once('error', resolve); });
  t.after(async () => { owner.kill('SIGTERM'); await ended; await rm(root, { recursive: true, force: true }); });
  const endpoint = join(root, 'run/control.sock');
  let attempts = 0;
  // No fixed 5 s readiness deadline: the socket's first answer, bounded by the runner budget (the stage names the attempts).
  const status: Envelope | undefined = await until(() => `controller socket readiness; attempts=${attempts}, exit=${owner.exitCode}, signal=${owner.signalCode}`, async () => {
    assert.equal(spawnFailed, false, 'controller process could not be spawned');
    assert.equal(owner.exitCode, null, 'controller exited before socket readiness');
    assert.equal(owner.signalCode, null, 'controller was signalled before socket readiness');
    attempts++;
    try { return await exchange(endpoint, request('inspect', { kind: 'status' }, 'status', null)); } catch { return undefined; }
  }, 10);
  assert.ok(status?.controller_run_id, `controller readiness deadline exceeded; attempts=${attempts}, exit=${owner.exitCode}, signal=${owner.signalCode}`);
  const run = status.controller_run_id;
  const mutation = request('accept', { request_id: 'lost', operation: 'pause', origin: 'local-cli' }, 'lost', run);
  // Only delivery is observed here; no ACK is read or inferred from write's callback.
  const raw = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => { raw.once('error', reject); raw.once('connect', resolve); });
  await new Promise<void>((resolve, reject) => raw.write(JSON.stringify(mutation) + '\n', error => error ? reject(error) : resolve()));
  raw.destroy();
  const recovered: Envelope | undefined = await until('lost request receipt queryable', async () => {
    try {
      const view = await exchange(endpoint, request('inspect', { kind: 'request', request_id: 'lost' }, 'lookup', run));
      return view.payload.receipt ? view : undefined;
    } catch { return undefined; /* A lost connection is not evidence of rollback. */ }
  }, 10);
  assert.equal(recovered?.kind, 'view', 'owner must remain usable after ACK loss');
  assert.deepEqual(recovered.payload.receipt, { kind: 'durable', request_id: 'lost', operation: 'pause', paused: true, historySequence: 1 });
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => exchange(endpoint, mutation)));
  for (const result of duplicates) assert.deepEqual(result.payload, recovered.payload.receipt);
  const conflict = await exchange(endpoint, request('accept', { request_id: 'lost', operation: 'unpause', origin: 'local-cli' }, 'lost', run));
  assert.deepEqual(conflict.payload, { kind: 'refused', code: 'REQUEST_ID_CONFLICT' });
  const unchanged = await exchange(endpoint, request('inspect', { kind: 'status' }, 'status-2', null));
  assert.equal(unchanged.payload.paused, true);
  assert.equal(unchanged.payload.historyLength, 1);
  const stale = await exchange(endpoint, request('accept', { request_id: 'old', operation: 'unpause', origin: 'local-cli' }, 'old', 'old-controller'));
  assert.equal(stale.payload.code, 'STALE_CONTROLLER');
  const invalid = await exchange(endpoint, request('accept', { request_id: 'worker', operation: 'unpause', origin: 'worker' }, 'worker', run));
  assert.equal(invalid.payload.code, 'INVALID_COMMAND');
});
