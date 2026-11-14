import assert from 'node:assert/strict';

// HTTP boundary only (offline provider). First request: the model calls ask_user (optionally followed by write in the SAME batch).
// Any second request would mean the activation continued after the question: reported to the parent, which fails the test.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.match(body, /"name":"ask_user"/);
  process.send?.({ kind: 'provider-request', count: ++requests });
  const write = body.includes('ask-then-write');
  const secret = body.includes('ask-secret');
  const calls = [{ index: 0, id: 'ask-1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({
    question: secret ? 'Is synthetic-secret the key?' : 'Which file name should the smoke doc use?', context: 'The Ticket names no file.' }) } },
  ...(write ? [{ index: 1, id: 'write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'x.txt', content: 'after question' }) } }] : [])];
  const choices = requests === 1 ? [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'tool_calls' }]
    : [{ index: 0, delta: { role: 'assistant', content: 'continued after the question (must not happen)' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
  const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'ask-response-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
