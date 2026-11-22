import assert from 'node:assert/strict';
import { png, jpeg, gif, webp, withMetadata } from './images.js';

// External HTTP boundary ONLY. No real fetch/DNS/model; never forwards any URL.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
assert.equal(process.versions.node.split('.')[0], '24');
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key|segredo|ação/);
  assert.doesNotMatch(body, /\"name\":\"(?:bash|write|edit)\"/);
  const blocked = body.includes('blocked-image');
  const user = JSON.parse(body).messages.find((message: { role: string }) => message.role === 'user');
  const description = JSON.stringify(user);
  const [source, mime] = description.includes('JPEG')
    ? [jpeg, 'jpeg']
    : description.includes('GIF')
      ? [gif, 'gif']
      : description.includes('WebP')
        ? [webp, 'webp']
        : [png, 'png'];
  const expected = withMetadata(source, Buffer.from('clean-local-metadata-'.repeat(2600)));
  assert.ok(++requests <= (blocked ? 1 : 2), 'no model next turn after image protection failure');
  if (requests === 2) assert.ok(body.includes(`data:image/${mime};base64,${expected.toString('base64')}`));
  process.send?.({ kind: 'provider-request', count: requests });
  const choices =
    requests === 1
      ? [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'read-image', type: 'function', function: { name: 'read', arguments: '{"path":"renamed.txt"}' } }],
            },
            finish_reason: null,
          },
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ]
      : [
          { index: 0, delta: { role: 'assistant', content: 'Offline image review complete.' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ];
  const events = choices
    .map(
      choice =>
        'data: ' +
        JSON.stringify({ id: 'image-response-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) +
        '\n\n',
    )
    .join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
