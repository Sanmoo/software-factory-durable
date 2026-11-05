import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect, listen, maxFrameBytes, ProtocolError, protocolVersion, type Envelope } from '../../src/protocol/index.js';

const envelope: Envelope = { protocol_version: protocolVersion, controller_run_id: null, message_id: 'fragment', reply_to: null,
  kind: 'inspect', payload: { kind: 'status', text: 'ação' } };
async function raw(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve); });
  return socket;
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 80 && !check(); i++) await delay(5);
  assert.ok(check(), 'bounded wait for protocol observation');
}

test('Protocol delivers only complete JSON lines, including fragmented UTF-8 and coalesced frames', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-protocol-'));
  const endpoint = join(root, 'control.sock');
  const received: Envelope[] = [];
  const server = await listen(endpoint, { message: async value => { received.push(value); } }, 'local-operator');
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const socket = await raw(endpoint);
  t.after(() => socket.destroy());
  const bytes = Buffer.from(JSON.stringify(envelope));
  for (const byte of bytes) socket.write(Buffer.from([byte]));
  await delay(20);
  assert.equal(received.length, 0, 'bytes are not a complete message or durable acceptance');
  socket.write('\n' + JSON.stringify({ ...envelope, message_id: 'second' }) + '\n');
  await waitFor(() => received.length === 2);
  assert.deepEqual(received, [envelope, { ...envelope, message_id: 'second' }]);
});

test('Protocol reports invalid version/fields, invalid UTF-8, truncated EOF and oversized frames without delivering them', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-protocol-'));
  const endpoint = join(root, 'control.sock');
  const received: Envelope[] = [];
  const errors: unknown[] = [];
  const server = await listen(endpoint, { message: async value => { received.push(value); }, closed: error => { errors.push(error); } }, 'local-operator');
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const invalid = [
    Buffer.from(JSON.stringify({ ...envelope, protocol_version: 2 }) + '\n'),
    Buffer.from(JSON.stringify({ ...envelope, role: 'administrator' }) + '\n'),
    Buffer.from(JSON.stringify({ ...envelope, message_id: 42 }) + '\n'),
    Buffer.from('{"x":"\xff"}\n', 'latin1'),
    Buffer.from('{"truncated":'),
    Buffer.alloc(maxFrameBytes + 1, 97),
  ];
  for (const bytes of invalid) {
    const socket = await raw(endpoint);
    socket.on('error', () => {});
    socket.end(bytes);
  }
  await waitFor(() => errors.length === invalid.length);
  assert.equal(received.length, 0);
  for (const error of errors) assert.ok(error instanceof ProtocolError);
  assert.equal(errors.filter(error => (error as ProtocolError).code === 'FRAME_TOO_LARGE').length, 1);
});

test('Channel send means transport write only, never a fabricated durable ACK', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-protocol-'));
  const endpoint = join(root, 'control.sock');
  let received = false;
  const server = await listen(endpoint, { message: async () => { received = true; } }, 'local-operator');
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const channel = await connect(endpoint, 'local-operator');
  t.after(() => channel.close());
  assert.equal(await channel.send(envelope), undefined);
  await waitFor(() => received);
  await assert.rejects(channel.send({ ...envelope, payload: { large: 'x'.repeat(maxFrameBytes) } }), { code: 'FRAME_TOO_LARGE' });
});
