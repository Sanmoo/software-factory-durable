// TEST ONLY: closed transport installed before native SDK evaluation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { guardFixtureNetwork } from '../adapter-fixture-network-guard.js';
const root = resolve(process.env.TMPDIR!, '../../../..');
guardFixtureNetwork(root, true);
for (const name of ['readFileSync', 'writeFileSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync'] as const) {
  const original = fs[name];
  Object.assign(fs, {
    [name]: (...args: unknown[]) => {
      const path = String(args[0]);
      if (/(?:auth\.json|chatgpt\.json)$|\/credentials(?:\/|$)/.test(path)) assert.ok(path.startsWith(root + '/'), 'only synthetic credential paths');
      return Reflect.apply(original, fs, args);
    },
  });
}
const { syncBuiltinESMExports } = await import('node:module');
syncBuiltinESMExports();
const mode = JSON.parse(fs.readFileSync(root + '/oauth-mode', 'utf8')) as string;
const counts: { auth: number; http: number; model: number; token: number; thirdRequestDenied?: boolean } = { auth: 0, http: 0, model: 0, token: 0 };
const save = () => fs.writeFileSync(root + '/oauth-counts', JSON.stringify(counts), { mode: 0o600 });
save();
if (mode === 'start-failure') {
  const open = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    if (String(args[0]).startsWith(root + '/') && String(args[0]).includes('/evidence/') && args[1] === 'wx') throw new Error('unknown-start-secret');
    return open(...args);
  }) as typeof open;
  syncBuiltinESMExports();
}
// Close HTTP even during selected SDK evaluation; never retain a real fallback.
globalThis.fetch = async () => {
  counts.http++;
  save();
  throw new Error('CLOSED_EVALUATION_HTTP');
};
// Narrow public method observation only; no replacement auth/runtime/client.
const { ModelRuntime } = await import('#factory-pi-model-runtime');
const getAuth = ModelRuntime.prototype.getAuth;
ModelRuntime.prototype.getAuth = function (this: typeof ModelRuntime.prototype, ...args: Parameters<typeof getAuth>) {
  counts.auth++;
  save();
  const work = root + '/producer-ordering-work/evidence';
  assert.ok(
    fs.readdirSync(work).some(id => {
      try {
        return fs.existsSync(`${work}/${id}/complete.json`) && JSON.parse(fs.readFileSync(`${work}/${id}/output`, 'utf8')).event?.kind === 'worker-start';
      } catch {
        return false;
      }
    }),
    'protected start before native auth',
  );
  assert.match(fs.readFileSync(root + '/audit', 'utf8'), /secret-ack-attempt/, 'owner ACK precedes native auth');
  return Reflect.apply(getAuth, this, args);
} as typeof getAuth;
// Capture the actual SAME native session runtime at its public stream boundary.
// Request three is forced there during HTTP two; no second client/runtime.
const nativeStream = ModelRuntime.prototype.streamSimple;
let activeRuntime: typeof ModelRuntime.prototype;
let activeRequest: Parameters<typeof nativeStream>;
const captureActive = (runtime: typeof ModelRuntime.prototype, request: Parameters<typeof nativeStream>) => {
  activeRuntime = runtime;
  activeRequest = request;
};
ModelRuntime.prototype.streamSimple = function (...args: Parameters<typeof nativeStream>) {
  captureActive(this, args);
  return Reflect.apply(nativeStream, this, args);
};
globalThis.fetch = async (input, init) => {
  counts.http++;
  save(); // BEFORE URL/assertions; there is no real fallback.
  if (String(input) === 'https://auth.openai.com/api/accounts/oauth/token') {
    counts.token++;
    save();
    assert.equal(mode, 'rotation-ack-fail');
    return new Response(
      JSON.stringify({ access_token: 'oauth-access-rotated', refresh_token: 'oauth-refresh-rotated', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }),
    );
  }
  const count = ++counts.model;
  save();
  process.send?.({ kind: 'provider-request', count });
  assert.equal(String(input), 'https://api.openai.com/v1/responses');
  assert.equal(init?.method, 'POST');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer oauth-access-canary');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.stream, true);
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false, 'native non-sk OAuth intentionally omits provider cap');
  assert.ok(count <= 2);
  if (mode === 'third-request' && count === 2) {
    counts.thirdRequestDenied = false;
    save(); // BEFORE assertion/third attempt
    assert.throws(() => activeRuntime.streamSimple(...activeRequest), /WORKER_QUALIFICATION_CLOSED/);
    counts.thirdRequestDenied = true;
    save();
  }
  if (mode === 'http429' || mode === 'http500')
    return new Response(JSON.stringify({ error: { message: 'unknown-http-secret-body', type: 'synthetic' } }), { status: mode === 'http429' ? 429 : 500 });
  if (mode === 'deadline' || mode === 'abort')
    return new Promise<Response>((_resolve, reject) => {
      const timer = setInterval(() => {}, 100);
      init!.signal!.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          reject(new Error('unknown-abort-secret'));
        },
        { once: true },
      );
    });
  const item = {
    id: 'fc_synthetic',
    type: 'function_call',
    call_id: 'read-source',
    name: 'read',
    arguments: JSON.stringify({
      path: mode === 'tool-args-overflow' ? 'x'.repeat(8200) : '/workspace/source.txt',
      limit: mode === 'tool-result-overflow' ? 2000 : 5,
    }),
  };
  if (count === 2) {
    const context = JSON.stringify(body.input);
    assert.match(context, /tool|function_call_output/);
    assert.doesNotMatch(context, /oauth-access-canary|oauth-refresh-canary|synthetic-secret|synthetic-key/);
  }
  const message = {
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'oauth vertical complete', annotations: [] }],
  };
  const events =
    count === 1
      ? [
          { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
          { type: 'response.output_item.done', output_index: 0, item },
        ]
      : [
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
          {
            type: 'response.content_part.added',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'oauth vertical complete' },
          { type: 'response.output_item.done', output_index: 0, item: message },
        ];
  if (mode === 'context-bytes') {
    events.unshift(
      { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } } as never,
      {
        type: 'response.content_part.added',
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      } as never,
      { type: 'response.output_text.delta', item_id: message.id, output_index: 1, content_index: 0, delta: 'x'.repeat(33000) } as never,
    );
  }
  if (mode === 'second-tool' && count === 1) {
    const second = { ...item, id: 'fc_second', call_id: 'second-read' };
    events.push({ type: 'response.output_item.added', output_index: 1, item: { ...second, arguments: '' } } as never);
    events.push({ type: 'response.function_call_arguments.delta', item_id: second.id, output_index: 1, delta: second.arguments } as never);
    events.push({ type: 'response.output_item.done', output_index: 1, item: second } as never);
  }
  if (mode === 'provider-bytes') events.unshift({ type: 'qualification.unknown', data: 'x'.repeat(66000) } as never);
  if (mode === 'mutable-error') {
    events.splice(
      0,
      events.length,
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } } as never,
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'unknown-http-secret-body' } } } as never,
    );
  } else
    events.push({
      type: 'response.completed',
      response: {
        id: 'resp_synthetic',
        status: 'completed',
        output: count === 1 ? [item] : [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    } as never);
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
