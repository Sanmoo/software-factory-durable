import type { IncomingMessage, ServerResponse } from 'node:http';

// TEST ONLY. Scripted local model provider (openai-completions SSE on 127.0.0.1) for the ticket 26 real-run recipe. It replaces the model so
// the real Builder workers run a FIXED, bounded Bash schedule; it lives in the recipe's ORCHESTRATOR process, so it survives every SIGKILL of a
// controller child. Activation 1 must be `/implement` (a short listing, then a long command the controller crash interrupts); every later
// activation must be the Factory's explicit recovery instruction (a listing of the preserved checkout, then completion). Deviations hold it.
export const port = 18726;
export const path = '/q26-v1/chat/completions';
export const apiKey = 'q26-dummy-key-v1';
const ticket = 'https://github.com/Sanmoo/java-springboot-event-sourcing/issues/3';
const listing = (activation: number) => ({ command: `printf 'q26-a${activation}-c0:%s\\n' "$(ls /workspace/checkout | head -3 | tr '\\n' ',')"`, timeout: 60 });
export const schedules = [
  // Guest-side, durable proof of the tool cut: the start marker file exists BEFORE the long command, the end marker only after it.
  [
    listing(1),
    {
      command: `printf 'started\\n' > /workspace/.q26-a1-c1-started; printf 'q26-a1-c1-start\\n'; sleep 600; printf 'ended\\n' > /workspace/.q26-a1-c1-ended; printf 'q26-a1-c1-end\\n'`,
      timeout: 900,
    },
  ],
  [listing(2)],
  [listing(3)],
  [listing(4)],
] as const;
/** At most 4 activations x (1-2 tool rounds + 1 final) requests; anything beyond holds the fixture. */
const postLimit = 12;

export function extract(content: string) {
  return {
    markers: [...content.matchAll(/q26-(a[1-4]-c[01](?:-start|-end)?)(?::([A-Za-z0-9/_.,-]{0,128}))?/g)].map(match =>
      match[2] === undefined ? match[1]! : `${match[1]}:${match[2]}`,
    ),
    rawTokenShape: /gh[sopu]_[A-Za-z0-9]{20,}/.test(content),
  };
}

/** First prompt shape required for an activation (1: `/implement`; later: the explicit recovery instruction, never a blind replay). */
export function promptAllowed(activation: number, text: string): boolean {
  if (activation === 1) return text.startsWith(`/implement ${ticket}`);
  return (
    text.startsWith(`Factory recovery instruction for Ticket ${ticket}.`) &&
    text.includes('never repeat a tool call blindly') &&
    /previous-execution=[0-9a-f-]{36}/.test(text)
  );
}

export function createFixture() {
  let attempts = 0,
    activation = 0,
    step = 0;
  let held = false,
    active = false;
  const results: (ReturnType<typeof extract> & { at: string; activation: number })[] = [];
  const emitted: { at: string; activation: number; call: number }[] = [];
  const prompts: { at: string; activation: number; kind: 'implement' | 'recovery'; bytes: number }[] = [];
  const observation = () => ({ attempts, activations: activation, held, results, emitted, prompts });
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
      if (body.model !== 'q26-model' || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 12 || typeof text !== 'string')
        throw new Error('SCHEDULE');
      const tools = body.messages.filter(message => message.role === 'tool');
      // A fresh conversation (no tool result) is the next activation; otherwise it must continue the current one in order.
      if (tools.length === 0) {
        activation++;
        step = 0;
        if (activation > schedules.length || !promptAllowed(activation, text)) throw new Error('PROMPT');
        prompts.push({ at: new Date().toISOString(), activation, kind: activation === 1 ? 'implement' : 'recovery', bytes: Buffer.byteLength(text) });
      }
      if (activation < 1 || tools.length !== step) throw new Error('RESULT_SEQUENCE');
      for (const [index, tool] of tools.entries())
        if (tool.tool_call_id !== `q26-a${activation}-${index}` || typeof tool.content !== 'string') throw new Error('TOOL_ID');
      if (step > 0) results.push({ ...extract(tools.at(-1)!.content as string), at: new Date().toISOString(), activation });
      const call = schedules[activation - 1]![step];
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `q26-a${activation}-${step}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify(call) } }],
          }
        : { role: 'assistant', content: 'Complete.' };
      const event = (value: unknown, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'q26',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'q26-model',
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

/** Real bind on 127.0.0.1 only (recipe `run` phase, orchestrator process); never started by import, `--plan` or tests. */
export async function startProvider() {
  const { createServer } = await import('node:http');
  const fixture = createFixture();
  const sockets = new Set<IncomingMessage['socket']>();
  let connections = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void fixture.handle(req, res);
  });
  server.on('connection', socket => {
    if (socket.remoteAddress !== '127.0.0.1' || ++connections > postLimit) {
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
