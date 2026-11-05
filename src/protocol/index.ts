import { createConnection, createServer, type Socket } from 'node:net';
import { chmod, lstat, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const protocolVersion = 1;
export const maxFrameBytes = 64 * 1024;
const maxPendingBytes = 4 * maxFrameBytes;
const envelopeSchema = z.strictObject({
  protocol_version: z.literal(protocolVersion),
  controller_run_id: z.string().min(1).max(128).nullable(),
  message_id: z.string().min(1).max(128),
  reply_to: z.string().min(1).max(128).nullable(),
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.json()),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export interface Channel {
  send(envelope: Envelope): Promise<void>;
  readonly messages: AsyncIterable<Envelope>;
  close(): void;
}
export class ProtocolError extends Error {
  constructor(readonly code: 'INVALID_FRAME' | 'FRAME_TOO_LARGE' | 'PEER_CLOSED' | 'PRIVATE_ENDPOINT_REQUIRED') { super(code); }
}

async function privateDirectory(endpoint: string): Promise<void> {
  const directory = await stat(dirname(endpoint));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new ProtocolError('PRIVATE_ENDPOINT_REQUIRED');
  }
}

function channel(socket: Socket): Channel {
  let buffer = Buffer.alloc(0);
  const queue: { envelope: Envelope; bytes: number }[] = [];
  let queuedBytes = 0;
  let ended = false;
  let failure: unknown;
  let notify: (() => void) | undefined;
  const wake = () => { notify?.(); notify = undefined; };
  const fail = (error: unknown) => { failure = error; socket.destroy(); wake(); };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > maxFrameBytes) { fail(new ProtocolError('FRAME_TOO_LARGE')); return; }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const parsed = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)));
        queuedBytes += frame.length;
        if (queuedBytes > maxPendingBytes) throw new ProtocolError('FRAME_TOO_LARGE');
        queue.push({ envelope: parsed, bytes: frame.length });
        wake();
      } catch (error) { fail(error instanceof ProtocolError ? error : new ProtocolError('INVALID_FRAME')); return; }
    }
    if (buffer.length > maxFrameBytes) fail(new ProtocolError('FRAME_TOO_LARGE'));
  });
  socket.on('error', error => { failure = error; wake(); });
  socket.on('close', () => {
    ended = true;
    if (buffer.length && !failure) failure = new ProtocolError('INVALID_FRAME');
    wake();
  });
  return {
    async send(envelope) {
      const frame = Buffer.from(JSON.stringify(envelopeSchema.parse(envelope)) + '\n');
      if (frame.length - 1 > maxFrameBytes) throw new ProtocolError('FRAME_TOO_LARGE');
      if (ended || socket.destroyed) throw new ProtocolError('PEER_CLOSED');
      await new Promise<void>((resolve, reject) => socket.write(frame, error => error ? reject(error) : resolve()));
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (failure) throw failure;
          const item = queue.shift();
          if (item) { queuedBytes -= item.bytes; yield item.envelope; }
          else if (ended) return;
          else await new Promise<void>(resolve => { notify = resolve; });
        }
      },
    },
    close() { socket.destroy(); },
  };
}

/** This endpoint is the trusted local operator projection, not a worker handshake granting authority. */
export async function listen(endpoint: string,
  handler: {
    message(envelope: Envelope, channel: Channel, peer: 'local-operator'): Promise<void>;
    closed?(error: unknown, peer: 'local-operator'): void;
  },
  expectedPeers: 'local-operator') {
  await privateDirectory(endpoint);
  const channels = new Set<Channel>();
  const server = createServer(socket => {
    const connection = channel(socket);
    channels.add(connection);
    void (async () => {
      let failure: unknown;
      try { for await (const envelope of connection.messages) await handler.message(envelope, connection, expectedPeers); }
      catch (error) { failure = error; }
      finally { connection.close(); channels.delete(connection); handler.closed?.(failure, expectedPeers); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(); });
  });
  try { await chmod(endpoint, 0o600); }
  catch (error) { server.close(); throw error; }
  return {
    async close() {
      for (const connection of channels) connection.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export async function connect(endpoint: string, _invocation: 'local-operator'): Promise<Channel> {
  await privateDirectory(endpoint);
  const info = await lstat(endpoint);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new ProtocolError('PRIVATE_ENDPOINT_REQUIRED');
  }
  const socket = createConnection(endpoint);
  const connection = channel(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => { socket.off('error', reject); resolve(); });
  });
  return connection;
}
