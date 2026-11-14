import type { IncomingMessage, ServerResponse } from 'node:http';

// TEST ONLY. Scripted local model provider (openai-completions SSE on 127.0.0.1) for the ticket 20 real-run recipe: it replaces the model
// so the real Builder worker runs a FIXED, bounded Bash schedule. No request-selected tools/commands/routes; any deviation holds it.
export const port = 18720;
export const path = '/q20-v1/chat/completions';
export const apiKey = 'q20-dummy-key-v1';
const repository = 'Sanmoo/java-springboot-event-sourcing';
// Fingerprint = first 12 hex of sha256(GH_TOKEN): identifies WHICH grant a command saw without exposing the value (never the token itself).
const fp = (label: string) => `printf 'q20-${label}:%s\\n' "$(printf %s "\${GH_TOKEN-}" | sha256sum | cut -c1-12)"`;
const read = `gh api repos/${repository} --jq '"q20-gh:" + .full_name'`;
/** c1 and c3 span a renewal (every ~90 s): the running command keeps its value; the following command sees the renewed one. */
export const schedule = [
  { command: `${fp('c0')}; ${read}; git ls-remote https://github.com/${repository}.git refs/heads/main | cut -c1-12 | sed 's/^/q20-git:/'`, timeout: 60 },
  { command: `${fp('c1a')}; sleep 150; ${fp('c1b')}; ${read}`, timeout: 240 },
  { command: `${fp('c2')}; ${read}`, timeout: 60 },
  { command: `sleep 60; ${fp('c3')}; ${read}`, timeout: 120 },
  { command: `${fp('c4')}; ${read}`, timeout: 60 },
] as const;
const postLimit = schedule.length + 1;

/** Only fixed marker lines leave a tool result; a raw token would already be filtered by Records ([REDACTED]/█) before the SDK. */
export function extract(content: string) {
  const markers = [...content.matchAll(/q20-(c[0-4][ab]?|gh|git):([A-Za-z0-9/_.-]{1,64})/g)].map(match => `${match[1]}:${match[2]}`);
  return { markers, rawTokenShape: /gh[sopu]_[A-Za-z0-9]{20,}/.test(content), filtered: content.includes('█') || content.includes('[REDACTED]') };
}

export function createFixture() {
  let attempts = 0, accepted = 0;
  let held = false, active = false;
  const results: (ReturnType<typeof extract> & { at: string })[] = [];
  // emitted[i]: when call i was handed to the worker; results[i].at: when its result came back (the command ran in between).
  const emitted: string[] = [];
  const observation = () => ({ attempts, accepted, held, results, emitted });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    attempts++;
    let acquired = false;
    try {
      if (held || active || attempts > postLimit) throw new Error('ATTEMPT_LIMIT');
      active = true; acquired = true;
      if (req.method !== 'POST' || req.url !== path || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}` ||
          req.headers.authorization !== `Bearer ${apiKey}` || req.headers['content-type'] !== 'application/json') throw new Error('REQUEST_BOUNDARY');
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 2 * 1024 * 1024) throw new Error('BODY_LIMIT'); chunks.push(data); }
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as { model?: unknown; stream?: unknown; messages?: { role: string; content: unknown; tool_call_id?: string }[] };
      const prompt = body.messages?.find(message => message.role === 'user')?.content;
      const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) && prompt.length === 1 ? (prompt[0] as { text?: unknown }).text : undefined;
      if (body.model !== 'q20-model' || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 24 ||
          typeof text !== 'string' || !text.startsWith(`/implement https://github.com/${repository}/issues/`)) throw new Error('SCHEDULE');
      const tools = body.messages.filter(message => message.role === 'tool');
      if (tools.length !== accepted) throw new Error('RESULT_SEQUENCE');
      for (const [index, tool] of tools.entries()) if (tool.tool_call_id !== `q20-${index}` || typeof tool.content !== 'string') throw new Error('TOOL_ID');
      if (accepted > 0) results.push({ ...extract(tools.at(-1)!.content as string), at: new Date().toISOString() });
      const call = schedule[accepted];
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `q20-${accepted}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify(call) } }] }
        : { role: 'assistant', content: 'Complete.' };
      const event = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'q20', object: 'chat.completion.chunk', created: 1, model: 'q20-model', choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
      accepted++;
      if (call) emitted.push(new Date().toISOString());
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(event(delta, null) + event({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch {
      held = true; res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }); res.end('Qualification held.');
    } finally { if (acquired) active = false; }
  }
  return { handle, observation, freeze() { held = true; } };
}

/** Real bind on 127.0.0.1 only (recipe `run` phase); never started by import, `--plan` or tests. */
export async function startProvider() {
  const { createServer } = await import('node:http');
  const fixture = createFixture();
  const sockets = new Set<IncomingMessage['socket']>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => { void fixture.handle(req, res); });
  server.on('connection', socket => {
    if (socket.remoteAddress !== '127.0.0.1' || sockets.size >= postLimit) { fixture.freeze(); socket.destroy(); return; }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  for (const event of ['clientError', 'upgrade', 'connect'] as const) server.on(event, (...args: unknown[]) => { fixture.freeze(); (args[1] as { destroy?(): void } | undefined)?.destroy?.(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { observation: fixture.observation, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}
