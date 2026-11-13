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
/** Supplied by trusted host composition for this endpoint, never decoded from a frame. */
export type ExpectedPeer = 'local-operator' | { kind: 'host-boot' | 'worker-tool'; binding: Readonly<Record<string, string>> };
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

function channel(socket: Socket, onClosed?: (error: unknown) => void): Channel {
  // One bounded partial/candidate (including its newline), independent of the
  // decoded queue. Unread bytes stay in Node's readable buffer, then the socket.
  const buffer = Buffer.alloc(maxFrameBytes + 1);
  let bufferedBytes = 0;
  const queue: { envelope: Envelope; bytes: number }[] = [];
  let queuedBytes = 0;
  let ended = false;
  let failure: unknown;
  let notify: (() => void) | undefined;
  const wake = () => { notify?.(); notify = undefined; };
  const fail = (error: unknown) => { failure ??= error; socket.destroy(); wake(); };
  let inputEnded = false;
  let pumping = false;
  const pump = () => {
    if (pumping || failure || ended) return;
    pumping = true;
    try {
      while (true) {
        const newline = buffer.subarray(0, bufferedBytes).indexOf(10);
        if (newline >= 0) {
          // Leave the bounded candidate in place until the consumer frees space.
          if (queuedBytes + newline > maxPendingBytes) return;
          try {
            const parsed = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline))));
            queuedBytes += newline;
            if (queuedBytes > maxPendingBytes) throw new ProtocolError('FRAME_TOO_LARGE');
            queue.push({ envelope: parsed, bytes: newline });
            buffer.copyWithin(0, newline + 1, bufferedBytes);
            bufferedBytes -= newline + 1;
            wake();
          } catch (error) { fail(error instanceof ProtocolError ? error : new ProtocolError('INVALID_FRAME')); return; }
          continue;
        }
        if (bufferedBytes > maxFrameBytes) { fail(new ProtocolError('FRAME_TOO_LARGE')); return; }
        if (inputEnded && socket.readableLength === 0) {
          if (bufferedBytes) fail(new ProtocolError('INVALID_FRAME'));
          else { ended = true; wake(); }
          return;
        }
        // Reserve a whole possible frame before reading more. No data listener:
        // read(n) cannot hand us an arbitrarily large coalesced chunk.
        if (queuedBytes > maxPendingBytes - maxFrameBytes) return;
        const bytes = Math.min(maxFrameBytes, socket.readableLength, buffer.length - bufferedBytes);
        if (!bytes) { socket.read(0); return; }
        const chunk: Buffer | null = socket.read(bytes) as Buffer | null;
        if (!chunk) return;
        chunk.copy(buffer, bufferedBytes);
        bufferedBytes += chunk.length;
      }
    } finally { pumping = false; }
  };
  socket.on('readable', pump);
  socket.on('end', () => { inputEnded = true; pump(); });
  socket.on('error', error => { failure ??= error; wake(); });
  socket.on('close', () => {
    if (!inputEnded) {
      ended = true;
      if (bufferedBytes && !failure) failure = new ProtocolError('INVALID_FRAME');
    }
    wake();
    onClosed?.(failure);
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
          if (item) { queuedBytes -= item.bytes; pump(); yield item.envelope; }
          else if (ended) return;
          else await new Promise<void>(resolve => { notify = resolve; });
        }
      },
    },
    close() { socket.destroy(); },
  };
}

/** Peer association comes from host-owned endpoint composition, never a frame or
 * connect() role claim. Private same-account endpoints are the trust boundary. */
export async function listen<P extends ExpectedPeer>(endpoint: string,
  handler: {
    message(envelope: Envelope, channel: Channel, peer: P): Promise<void>;
    closed?(error: unknown, peer: P, channel: Channel): void;
  },
  expectedPeers: P) {
  await privateDirectory(endpoint);
  const channels = new Set<Channel>();
  const server = createServer(socket => {
    let failure: unknown;
    // EOF must reach the owner even while a message handler is awaiting guest
    // I/O. Decode/truncated-EOF failures are established by channel first.
    const connection = channel(socket, transportError => {
      channels.delete(connection); handler.closed?.(failure ?? transportError, expectedPeers, connection);
    });
    channels.add(connection);
    void (async () => {
      try { for await (const envelope of connection.messages) await handler.message(envelope, connection, expectedPeers); }
      catch (error) { failure = error; }
      finally { connection.close(); }
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

export async function connect(endpoint: string, _invocation: ExpectedPeer): Promise<Channel> {
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
