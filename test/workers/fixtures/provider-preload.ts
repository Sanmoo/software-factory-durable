import assert from 'node:assert/strict';

// Test-only external HTTP boundary. Never forwards fetch, regardless of URL.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
assert.equal(process.versions.node.split('.')[0], '24');
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key/);
  assert.doesNotMatch(body, /\"name\":\"(?:bash|write|edit)\"/);
  requests++;
  assert.ok(requests <= 2);
  if (requests === 2) assert.match(body, /█/);
  process.send?.({ kind: 'provider-request', count: requests });
  const choices =
    requests === 1
      ? [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"source.txt","offset":5001,"limit":2}' } },
              ],
            },
            finish_reason: null,
          },
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ]
      : [
          { index: 0, delta: { role: 'assistant', content: 'Offline review complete.' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ];
  const events = choices
    .map(
      choice =>
        'data: ' + JSON.stringify({ id: 'response-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n',
    )
    .join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
