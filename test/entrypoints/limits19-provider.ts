import type { IncomingMessage, ServerResponse } from 'node:http';

// TEST ONLY. Scripted local model provider (openai-completions SSE on 127.0.0.1) for the ticket 19 real-run recipe: it replaces the model
// so the real Builder worker runs a FIXED, bounded Bash schedule per activation. No request-selected tools/commands/routes; any deviation
// holds it. ONE activation: a short command, then a long command that the configured Factory timeout must interrupt (its end marker
// must never appear and no further model request may follow).
export const port = 18719;
export const path = '/q19-v1/chat/completions';
export const apiKey = 'q19-dummy-key-v1';
export const schedules = [
  [
    { command: `printf 'q19-a1-c0:%s\\n' "$(ls /workspace/checkout | head -3 | tr '\\n' ',')"`, timeout: 60 },
    { command: `printf 'q19-a1-c1-start\\n'; sleep 600; printf 'q19-a1-c1-end\\n'`, timeout: 900 },
  ],
] as const;
/** c0, then c1 (never answered: interrupted by the Factory timeout). One spare request would still be refused by the schedule. */
const postLimit = 3;

export function extract(content: string) {
  return {
    markers: [...content.matchAll(/q19-(a1-c[01](?:-start|-end)?)(?::([A-Za-z0-9/_.,-]{0,128}))?/g)].map(match =>
      match[2] === undefined ? match[1]! : `${match[1]}:${match[2]}`,
    ),
    rawTokenShape: /gh[sopu]_[A-Za-z0-9]{20,}/.test(content),
  };
}

export function createFixture() {
  let attempts = 0,
    activation = 0,
    step = 0;
  let held = false,
    active = false;
  const results: (ReturnType<typeof extract> & { at: string; activation: number })[] = [];
  const emitted: { at: string; activation: number; call: number }[] = [];
  const observation = () => ({ attempts, activations: activation, held, results, emitted });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    attempts++;
    let acquired = false;
    try {
      if (held || active || attempts > postLimit) throw new Error('ATTEMPT_LIMIT');
      active = true;
      acquired = true;
      if (
        req.method !== 'POST' ||
        req.url !== path ||
        req.socket.remoteAddress !== '127.0.0.1' ||
        req.headers.host !== `127.0.0.1:${port}` ||
        req.headers.authorization !== `Bearer ${apiKey}` ||
        req.headers['content-type'] !== 'application/json'
      )
        throw new Error('REQUEST_BOUNDARY');
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('BODY_LIMIT');
        chunks.push(data);
      }
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as {
        model?: unknown;
        stream?: unknown;
        messages?: { role: string; content: unknown; tool_call_id?: string }[];
      };
      const prompt = body.messages?.find(message => message.role === 'user')?.content;
      const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) && prompt.length === 1 ? (prompt[0] as { text?: unknown }).text : undefined;
      if (
        body.model !== 'q19-model' ||
        body.stream !== true ||
        !Array.isArray(body.messages) ||
        body.messages.length > 12 ||
        typeof text !== 'string' ||
        !text.startsWith('/implement https://github.com/Sanmoo/java-springboot-event-sourcing/issues/')
      )
        throw new Error('SCHEDULE');
      const tools = body.messages.filter(message => message.role === 'tool');
      // A fresh conversation (no tool result) is the next activation; otherwise it must continue the current one in order.
      if (tools.length === 0) {
        activation++;
        step = 0;
      }
      if (activation < 1 || activation > schedules.length || tools.length !== step) throw new Error('RESULT_SEQUENCE');
      for (const [index, tool] of tools.entries())
        if (tool.tool_call_id !== `q19-a${activation}-${index}` || typeof tool.content !== 'string') throw new Error('TOOL_ID');
      if (step > 0) results.push({ ...extract(tools.at(-1)!.content as string), at: new Date().toISOString(), activation });
      const call = schedules[activation - 1]![step];
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `q19-a${activation}-${step}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify(call) } }],
          }
        : { role: 'assistant', content: 'Complete.' };
      const event = (value: unknown, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'q19',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'q19-model',
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        }) +
        '\n\n';
      if (call) emitted.push({ at: new Date().toISOString(), activation, call: step });
      step++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(event(delta, null) + event({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch {
      held = true;
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Qualification held.');
    } finally {
      if (acquired) active = false;
    }
  }
  return {
    handle,
    observation,
    freeze() {
      held = true;
    },
  };
}

/** Real bind on 127.0.0.1 only (recipe `run` phase); never started by import, `--plan` or tests. */
export async function startProvider() {
  const { createServer } = await import('node:http');
  const fixture = createFixture();
  const sockets = new Set<IncomingMessage['socket']>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void fixture.handle(req, res);
  });
  server.on('connection', socket => {
    if (socket.remoteAddress !== '127.0.0.1' || sockets.size >= postLimit) {
      fixture.freeze();
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  for (const event of ['clientError', 'upgrade', 'connect'] as const)
    server.on(event, (...args: unknown[]) => {
      fixture.freeze();
      (args[1] as { destroy?(): void } | undefined)?.destroy?.();
    });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    observation: fixture.observation,
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
