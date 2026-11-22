import assert from 'node:assert/strict';

// HTTP boundary only (offline provider), v2 ticket 09: the first request asks for one long Bash command. In the worker that yields for a
// boot swap there must be NO second request. In the worker that continues the preserved session, the first request must carry the
// earlier conversation (the command and its result) and the continuation message; it then ends the turn.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  const continuing = body.includes('Factory continuation of the SAME session after a planned boot swap');
  process.send?.({
    kind: 'provider-request',
    count: ++requests,
    continuing,
    earlierCommand: body.includes('make long-build'),
    earlierResult: body.includes('"role":"tool"'),
  });
  const chunk = (delta: unknown, finish: string | null) =>
    'data: ' +
    JSON.stringify({
      id: 'swap-' + requests,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'reader',
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    '\n\n';
  const events = continuing
    ? chunk({ role: 'assistant', content: 'Continued after the swap.' }, null) + chunk({}, 'stop')
    : chunk(
        {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'bash-long', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'make long-build' }) } }],
        },
        null,
      ) + chunk({}, 'tool_calls');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
