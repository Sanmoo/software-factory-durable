import assert from 'node:assert/strict';
import { createConnection, createServer, Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect, listen, maxFrameBytes, ProtocolError, protocolVersion, type Envelope } from '../../src/protocol/index.js';
import { remainingMs, untilHolds } from '../runner/budget.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const envelope: Envelope = { protocol_version: protocolVersion, controller_run_id: null, message_id: 'fragment', reply_to: null,
  kind: 'inspect', payload: { kind: 'status', text: 'ação' } };
async function raw(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve); });
  return socket;
}
async function waitFor(check: () => boolean) {
  await untilHolds('protocol observation', check, 5);
  assert.ok(check(), 'bounded wait for protocol observation');
}

test('Protocol delivers only complete JSON lines, including fragmented UTF-8 and coalesced frames', { timeout: remainingMs() }, async t => {
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

test('Protocol reports invalid version/fields, invalid UTF-8, truncated EOF and oversized frames without delivering them', { timeout: remainingMs() }, async t => {
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

test('Protocol waits for a deferred consumer across a valid stream larger than the pending budget', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pf-'));
  const endpoint = join(root, 's');
  const gate = deferred();
  const closed = deferred();
  const complete = deferred();
  const received: string[] = [];
  const errors: unknown[] = [];
  const expected = Array.from({ length: 24 }, (_, i) => `${i}:π` + 'x'.repeat(16384));
  const server = await listen(endpoint, { message: async value => {
    if (!received.length) await gate.promise;
    received.push(value.payload.text as string);
    if (received.length === expected.length) complete.resolve();
  }, closed: error => { if (error) { errors.push(error); closed.resolve(); } } }, 'local-operator');
  const client = await connect(endpoint, 'local-operator');
  t.after(async () => { gate.resolve(); client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const sending = (async () => {
    for (const text of expected) await client.send({ ...envelope, payload: { text } });
  })().then(() => undefined, error => error as unknown);
  // Allow socket reads while the application deliberately cannot take its next frame.
  await setImmediate(); await setImmediate();
  assert.equal(await sending, undefined, 'valid transport must not reject a slow consumer');
  await setImmediate(); await setImmediate();
  assert.equal(received.length, 0);
  assert.deepEqual(errors, [], 'a valid stream must wait, not overflow');
  client.close(); // EOF may be behind unread data; delivery must finish on release.
  gate.resolve();
  await Promise.race([complete.promise, closed.promise]);
  assert.deepEqual(received, expected);
  assert.deepEqual(errors, []);
});

test('Protocol rejects a dequeue when its refill discovers an invalid frame behind the full pending budget', { timeout: remainingMs() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pf-'));
  const accepted = deferred();
  const fullBudgetRead = deferred();
  const malformedUnread = deferred();
  let producer: Socket | undefined;
  let receiver: Socket | undefined;
  let consumed = 0;
  const empty = { ...envelope, payload: { text: '' } };
  const maximum = { ...empty, payload: { text: 'x'.repeat(maxFrameBytes - Buffer.byteLength(JSON.stringify(empty))) } };
  const frame = Buffer.from(JSON.stringify(maximum) + '\n');
  assert.equal(frame.length, 65537);
  const fullWireBytes = 4 * frame.length;
  const server = createServer(socket => { producer = socket; accepted.resolve(); });
  const originalRead = Socket.prototype.read;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  // Scoped source-symptom observer only: count actual socket reads, not heap/RSS
  // or universal liveness. The sole protocol receiver is identified by its first
  // exact fixture prefix; the raw producer never reads. No production hooks.
  const observeUnread = () => {
    if (consumed === fullWireBytes && receiver?.readableLength === 3) malformedUnread.resolve();
  };
  const observeReceiver = (socket: Socket) => { receiver = socket; receiver.on('readable', observeUnread); };
  try {
    await new Promise<void>(resolve => { server.listen(join(root, 's'), resolve); });
    await chmod(join(root, 's'), 0o600);
    client = await connect(join(root, 's'), 'local-operator');
    await accepted.promise;
    Socket.prototype.read = function (size?: number) {
      const chunk = originalRead.call(this, size) as Buffer | null;
      if (!receiver && this !== producer && Buffer.isBuffer(chunk) && chunk.subarray(0, 32).equals(frame.subarray(0, 32))) {
        observeReceiver(this);
      }
      if (this === receiver && chunk) {
        consumed += chunk.length;
        if (consumed === fullWireBytes) fullBudgetRead.resolve();
      }
      return chunk;
    };
    producer!.write(Buffer.concat([frame, frame, frame, frame]));
    await fullBudgetRead.promise;
    // The read observer fires inside pump; this continuation runs after pump
    // queues all four 65,536-byte frames (262,144 accounted bytes).
    producer!.write('{}\n');
    await malformedUnread.promise;
    assert.equal(consumed, fullWireBytes, 'malformed tail is still unread behind the full decoded budget');
    assert.equal(receiver?.readableLength, 3);
    const iterator = client.messages[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), { code: 'INVALID_FRAME' }, 'refill failure must win over a queued envelope');
    assert.equal(consumed, fullWireBytes + 3, 'the rejecting dequeue actually read the malformed tail');
  } finally {
    Socket.prototype.read = originalRead;
    receiver?.off('readable', observeUnread);
    client?.close();
    producer?.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    await rm(root, { recursive: true, force: true });
  }
});

test('Protocol preserves the exact maximum frame boundary', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pf-'));
  const done = deferred();
  let received: Envelope | undefined;
  const server = await listen(join(root, 's'), { message: async value => { received = value; done.resolve(); } }, 'local-operator');
  const client = await connect(join(root, 's'), 'local-operator');
  t.after(async () => { client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const empty = { ...envelope, payload: { text: '' } };
  const text = 'x'.repeat(maxFrameBytes - Buffer.byteLength(JSON.stringify(empty)));
  const maximum = { ...empty, payload: { text } };
  await client.send(maximum);
  await done.promise;
  assert.deepEqual(received, maximum);
  await assert.rejects(client.send({ ...empty, payload: { text: text + 'x' } }), { code: 'FRAME_TOO_LARGE' });
});

for (const truncated of [false, true]) test(`Protocol notifies ${truncated ? 'truncated' : 'clean'} EOF while the owner handler still awaits guest I/O`, { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pf-'));
  const entered = deferred();
  const gate = deferred();
  const closed = deferred();
  let finished = false;
  let closeError: unknown;
  const server = await listen(join(root, 's'), { message: async () => {
    entered.resolve(); await gate.promise; finished = true;
  }, closed: error => { closeError = error; closed.resolve(); } }, 'local-operator');
  const client = await raw(join(root, 's'));
  t.after(async () => { gate.resolve(); client.destroy(); await server.close(); await rm(root, { recursive: true, force: true }); });
  client.write(JSON.stringify(envelope) + '\n');
  await entered.promise;
  client.end(truncated ? '{"truncated":' : '');
  await closed.promise;
  assert.equal(finished, false);
  if (truncated) assert.equal((closeError as ProtocolError).code, 'INVALID_FRAME');
  else assert.equal(closeError, undefined);
  gate.resolve();
});

test('local close wakes a sender while the reader is backpressured', { timeout: remainingMs() }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pf-'));
  const offered = deferred();
  const closed = deferred();
  let sent = 0;
  const server = await listen(join(root, 's'), { message: async (_value, channel) => {
    try {
      for (let i = 0; i < 128; i++) {
        await channel.send({ ...envelope, message_id: String(i), payload: { text: 'x'.repeat(16384) } });
        sent++;
        if (sent === 24) offered.resolve();
      }
    } finally { offered.resolve(); }
  }, closed: () => { closed.resolve(); } }, 'local-operator');
  const client = await connect(join(root, 's'), 'local-operator');
  t.after(async () => { client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await client.send(envelope);
  const iterator = client.messages[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.message_id, '0');
  await offered.promise;
  assert.ok(sent < 128, 'finite producer cannot finish while the application stops reading');
  client.close();
  await closed.promise;
  await iterator.return?.();
});

test('Channel send means transport write only, never a fabricated durable ACK', { timeout: remainingMs() }, async t => {
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
