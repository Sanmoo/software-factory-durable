import assert from 'node:assert/strict';

// Test-only external provider HTTP boundary for the Builder handoff child. Never forwards fetch.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.match(body, /"name":"handoff"/);
  requests++;
  assert.ok(requests <= 2, 'no model turn while suspended and no retry');
  if (requests === 2) assert.match(body, /FACTORY REVIEW RESULTS/);
  process.send?.({ kind: 'provider-request', count: requests });
  const choices = requests === 1 ? [
    { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'handoff-1', type: 'function', function: { name: 'handoff', arguments: '{}' } }] }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ] : [
    { index: 0, delta: { role: 'assistant', content: 'Findings addressed.' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ];
  const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'h-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
