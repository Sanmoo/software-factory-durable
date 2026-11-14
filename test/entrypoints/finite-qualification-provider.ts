import type { IncomingMessage, ServerResponse } from 'node:http';

export const largeBytes = 1114130;
export const bodyLimit = 2 * 1024 * 1024;
export const copyPattern = /^\/artifacts\/factory-output-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/;
export type Case = 'w1' | 'w2' | 'w3' | 'w4';
const largeCommand = "printf 'Q05-BEGIN\\n'; for ((i=0;i<65536;i++)); do printf '0123456789abcdef\\n'; done; printf 'Q05-END\\n'";
const smallCommand = "printf 'q05-'; printf 'secret-v1\\n'";
export function schedule(which: Case, path = '') {
  if (which !== 'w1' && !copyPattern.test(path)) throw new Error('COPY_IDENTITY_REQUIRED');
  const read = (offset?: number, limit?: number) => ({ name: 'read', args: { path, ...(offset ? { offset, limit } : {}) } });
  return which === 'w1' ? [
    { name: 'write', args: { path: '/workspace/q05-new.txt', content: 'alpha\n' } },
    { name: 'edit', args: { path: '/workspace/q05-new.txt', oldText: 'alpha', newText: 'beta' } },
    { name: 'read', args: { path: '/workspace/q05-new.txt' } },
    { name: 'bash', args: { command: smallCommand, timeout: 10 } },
    { name: 'bash', args: { command: largeCommand, timeout: 10 } },
    read(1, 1), read(65538, 1), read(2, 2),
  ] : [read(which === 'w4' ? 1 : undefined, which === 'w4' ? 1 : undefined)];
}

// Exact fixture assertions only; no request-selected tools, commands or routes.
export function createFixture(which: Case, selectedPath = '') {
  let path = selectedPath;
  let attempts = 0, accepted = 0, emitted = 0, results = 0;
  let held = false, active = false;
  let socket: IncomingMessage['socket'] | undefined;
  function observation() { return { attempts, accepted, emitted, results, held, path }; }
  function checkResult(content: string, slot: number) {
    if (which === 'w2' || which === 'w3' || (which === 'w1' && slot === 2)) {
      if (!content.includes('READ_PATH_DENIED')) throw new Error('DENIAL_EXPECTED');
    } else if (content.includes('READ_PATH_DENIED') || content.includes('q05-secret-v1') || content.includes('q05-dummy-key-v1')) throw new Error('UNPROTECTED_RESULT');
    if (which === 'w1' && slot === 0 && !content.includes('Successfully wrote 6 bytes')) throw new Error('WRITE_EXPECTED');
    if (which === 'w1' && slot === 1 && !content.includes('Successfully replaced')) throw new Error('EDIT_EXPECTED');
    if (which === 'w1' && slot === 3 && !content.includes('█')) throw new Error('FILTER_EXPECTED');
    if (which === 'w1' && slot === 4) {
      const paths = [...new Set(content.match(/\/artifacts\/factory-output-[0-9a-f-]{36}\.txt/g))];
      if (paths.length !== 1 || !copyPattern.test(paths[0]!)) throw new Error('COPY_AMBIGUOUS');
      path = paths[0]!;
    }
    if ((which === 'w4' || (which === 'w1' && slot === 5)) && !content.includes('Q05-BEGIN')) throw new Error('HEAD_EXPECTED');
    if (which === 'w1' && slot === 6 && !content.includes('Q05-END')) throw new Error('TAIL_EXPECTED');
    if (which === 'w1' && slot === 7 && !content.includes('0123456789abcdef')) throw new Error('PAGE_EXPECTED');
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    attempts++; // Includes invalid, extra, concurrent, and previously frozen attempts.
    let acquired = false;
    try {
      if (held || active || attempts > (which === 'w1' ? 9 : 2)) throw new Error('ATTEMPT_LIMIT');
      active = true; acquired = true;
      if (socket && socket !== req.socket) throw new Error('SOCKET_OWNER');
      socket = req.socket;
      if (req.method !== 'POST' || req.url !== '/q05-qual-v1/chat/completions' || req.socket.remoteAddress !== '127.0.0.1' ||
          req.headers.host !== '127.0.0.1:18705' || req.headers.authorization !== 'Bearer q05-dummy-key-v1' ||
          req.headers['content-type'] !== 'application/json') throw new Error('REQUEST_BOUNDARY');
      const allowed = new Set(['host', 'authorization', 'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language',
        'connection', 'user-agent', 'sec-fetch-mode', 'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
        'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout']);
      if (Object.keys(req.headers).some(key => !allowed.has(key)) || Buffer.byteLength(JSON.stringify(req.headers)) > 8192 ||
          req.rawHeaders.length > 64 || new Set(req.rawHeaders.filter((_, i) => i % 2 === 0).map(h => h.toLowerCase())).size * 2 !== req.rawHeaders.length ||
          (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > bodyLimit))) throw new Error('HEADERS');
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > bodyLimit) throw new Error('BODY_LIMIT'); chunks.push(data); }
      if (held) throw new Error('CONCURRENT_FREEZE');
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as { model?: unknown; stream?: unknown; messages?: { role: string; content: unknown; tool_call_id?: string }[] };
      if (body.model !== 'qual-model' || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 24 ||
          !body.messages.some(m => m.role === 'user' && m.content === `q05-${which}`)) throw new Error('SCHEDULE');
      const tools = body.messages.filter(m => m.role === 'tool');
      if (tools.length !== accepted) throw new Error('RESULT_SEQUENCE');
      for (const [index, tool] of tools.entries()) if (tool.tool_call_id !== `q05-${which}-${index}` || typeof tool.content !== 'string') throw new Error('TOOL_ID');
      if (accepted > 0) { checkResult(tools.at(-1)!.content as string, accepted - 1); results++; }
      const calls = schedule(which, path);
      const call = calls[accepted];
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `q05-${which}-${accepted}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'Complete.' };
      const event = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: `q05-${which}`, object: 'chat.completion.chunk', created: 1, model: 'qual-model', choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
      const output = event(delta, null) + event({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n';
      if (Buffer.byteLength(output) > 65536) throw new Error('SSE_LIMIT');
      accepted++; if (call) emitted++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.end(output);
    } catch {
      held = true; res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }); res.end('Qualification held.');
    } finally { if (acquired) active = false; }
  }
  return { handle, observation, freeze() { held = true; } };
}

/** Future-only real bind. No forwarding, alternate port, retry or worker injection. */
export async function startProvider(which: Case, path = '') {
  const { createServer } = await import('node:http');
  const fixture = createFixture(which, path);
  const sockets = new Set<IncomingMessage['socket']>();
  let connections = 0, rejectedTransport = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void fixture.handle(req, res).then(() => { if (fixture.observation().held) void close(); }, () => { fixture.freeze(); void close(); });
  });
  let closing: Promise<void> | undefined;
  function close() {
    if (!closing) {
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>(resolve => server.close(() => resolve()));
    }
    return closing;
  }
  server.maxRequestsPerSocket = which === 'w1' ? 9 : 2;
  server.keepAliveTimeout = 15000;
  server.on('connection', socket => {
    connections++;
    if (connections > 1 || socket.remoteAddress !== '127.0.0.1') { fixture.freeze(); socket.destroy(); void close(); return; }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => { rejectedTransport++; fixture.freeze(); socket.destroy(); void close(); });
  server.on('upgrade', (_req, socket) => { rejectedTransport++; fixture.freeze(); socket.destroy(); void close(); });
  server.on('connect', (_req, socket) => { rejectedTransport++; fixture.freeze(); socket.destroy(); void close(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(18705, '127.0.0.1', resolve); });
  return { observation: () => ({ ...fixture.observation(), connections, rejectedTransport }), close };
}
