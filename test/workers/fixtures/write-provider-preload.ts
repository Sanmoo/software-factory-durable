import assert from 'node:assert/strict';

// HTTP boundary only. Never forward a URL, including unexpected requests.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
assert.equal(process.versions.node.split('.')[0], '24');
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key/);
  assert.doesNotMatch(body, /"name":"(?:read|edit)"/);
  assert.match(body, /"name":"bash"/);
  assert.match(body, /"name":"write"/);
  const blocked = body.includes('blocked-write');
  assert.ok(++requests <= (blocked ? 1 : 2), 'no next model turn after critical mutation failure');
  if (requests === 2) assert.match(body, /Successfully wrote to nested\/new.txt/);
  process.send?.({ kind: 'provider-request', count: requests });
  const choices =
    requests === 1
      ? [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'write-new',
                  type: 'function',
                  function: {
                    name: 'write',
                    arguments: JSON.stringify({ path: 'nested/new.txt', content: body.includes('overwrite-empty') ? '' : 'hello π\n' }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ]
      : [
          { index: 0, delta: { role: 'assistant', content: 'Offline new-file write complete.' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ];
  const events = choices
    .map(
      choice =>
        'data: ' +
        JSON.stringify({ id: 'write-response-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) +
        '\n\n',
    )
    .join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
