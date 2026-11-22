import type { IncomingMessage, ServerResponse } from 'node:http';
import { suiteCommand } from './three24-qualification.js';

// TEST ONLY. Scripted local model provider (openai-completions SSE on 127.0.0.1) for the ticket 34 R-LONG real-run recipe: it replaces the
// model so the real Builder worker runs a FIXED, bounded Bash schedule whose long part is REAL work the Factory sees as one tool call — a
// flakiness census of the repository's own test suite (the q24 v4 command: README `./gradlew --no-daemon test` in a pinned JDK image on the
// guest's Docker) with `--rerun-tasks`, so every run re-executes the tests. No sleep anywhere: the census repeats the suite WHILE less than
// `censusSeconds` have elapsed (`maxRuns` is only a safety cap). Real run v1: without --rerun-tasks Gradle skipped the suite after run 1
// (`:test UP-TO-DATE`, 16 s) and the old 12-run cap ended the census at 963 s, before the first token expired.
// No request-selected tools/commands/routes; any deviation holds the fixture.
export const port = 18734;
export const path = '/q34l-v1/chat/completions';
export const apiKey = 'q34l-dummy-key-v1';
const repository = 'Sanmoo/java-springboot-event-sourcing';
/** 75 min of real suite work: the first installation token (3600 s) expires inside this ONE command. */
export const censusSeconds = 4500;
export const maxRuns = 40;
// Fingerprint = first 12 hex of sha256(GH_TOKEN): identifies WHICH grant a command saw without exposing the value (never the token itself).
const fp = (label: string) => `printf 'q34l-${label}:%s\\n' "$(printf %s "\${GH_TOKEN-}" | sha256sum | cut -c1-12)"`;
/** A read with the command's own GH_TOKEN: `ok:<full_name>`, or `fail:HTTP-<status>` (an expired token is HTTP 401). Never prints the value. */
const read = (label: string) =>
  `{ gh api repos/${repository} --jq '"q34l-gh-${label}:ok:" + .full_name' 2>/workspace/.q34l-gh.err || ` +
  `printf 'q34l-gh-${label}:fail:%s\\n' "$(grep -o 'HTTP [0-9][0-9][0-9]' /workspace/.q34l-gh.err | head -1 | tr ' ' '-')"; }`;
/** The README suite, forced to re-execute every run (never UP-TO-DATE). */
export const rerunSuite = `${suiteCommand} --rerun-tasks`;
/** The census: real suite runs, one line per run (index, exit code, seconds), WHILE less than `censusSeconds` have elapsed (cap `maxRuns`). */
export const census =
  `start=$(date +%s); i=0; while [ "$(( $(date +%s) - start ))" -lt ${censusSeconds} ] && [ "$i" -lt ${maxRuns} ]; do i=$((i+1)); t0=$(date +%s); ` +
  `( ${rerunSuite} ) >/workspace/.q34l-run-$i.log 2>&1; rc=$?; printf 'q34l-run:%s:%s:%s\\n' "$i" "$rc" "$(( $(date +%s) - t0 ))"; done; ` +
  `printf 'q34l-census:%s:%s\\n' "$i" "$(( $(date +%s) - start ))"`;
/** c1 spans the first token's expiry (and the renewal ~50 min after issuance); c2 is the first command after it. */
export const schedule = [
  { command: `${fp('c0')}; ${read('c0')}`, timeout: 120 },
  { command: `${fp('c1a')}; ${read('c1a')}; ${census}; ${fp('c1b')}; ${read('c1b')}`, timeout: censusSeconds + 3600 },
  { command: `${fp('c2')}; ${read('c2')}`, timeout: 120 },
] as const;
const postLimit = schedule.length + 1;

/** Only fixed marker lines leave a tool result; a raw token would already be filtered by Records ([REDACTED]/█) before the SDK. */
export function extract(content: string) {
  const markers = [...content.matchAll(/q34l-(c0|c1a|c1b|c2|gh-c0|gh-c1a|gh-c1b|gh-c2|run|census):([A-Za-z0-9/_.:-]{1,80})/g)].map(
    match => `${match[1]}:${match[2]}`,
  );
  return { markers, rawTokenShape: /gh[sopu]_[A-Za-z0-9]{20,}/.test(content), filtered: content.includes('█') || content.includes('[REDACTED]') };
}

export function createFixture() {
  let attempts = 0,
    accepted = 0;
  let held = false,
    active = false;
  const results: (ReturnType<typeof extract> & { at: string })[] = [];
  // emitted[i]: when call i was handed to the worker; results[i].at: when its result came back (the command ran in between).
  const emitted: string[] = [];
  const observation = () => ({ attempts, accepted, held, results, emitted });
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
        body.model !== 'q34l-model' ||
        body.stream !== true ||
        !Array.isArray(body.messages) ||
        body.messages.length > 24 ||
        typeof text !== 'string' ||
        !text.startsWith(`/implement https://github.com/${repository}/issues/`)
      )
        throw new Error('SCHEDULE');
      const tools = body.messages.filter(message => message.role === 'tool');
      if (tools.length !== accepted) throw new Error('RESULT_SEQUENCE');
      for (const [index, tool] of tools.entries()) if (tool.tool_call_id !== `q34l-${index}` || typeof tool.content !== 'string') throw new Error('TOOL_ID');
      if (accepted > 0) results.push({ ...extract(tools.at(-1)!.content as string), at: new Date().toISOString() });
      const call = schedule[accepted];
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `q34l-${accepted}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify(call) } }],
          }
        : { role: 'assistant', content: 'Complete.' };
      const event = (value: unknown, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'q34l',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'q34l-model',
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        }) +
        '\n\n';
      accepted++;
      if (call) emitted.push(new Date().toISOString());
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

/** Real bind on 127.0.0.1 only (recipe `run` phase); never started by import, `--plan` or tests. The SSE response of c1 is sent at once:
 * the long call holds no provider connection (the worker runs the command and sends its result in the NEXT request). */
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
