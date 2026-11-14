import assert from 'node:assert/strict';

// HTTP boundary only (offline provider) for a CONTINUED Builder session: reports to the parent whether the request carried the earlier
// conversation of the preserved session (the ask_user call and its recorded result) and the `continue` message, then ends the turn.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  process.send?.({ kind: 'provider-request', count: ++requests, earlierQuestion: body.includes('Which file name should the smoke doc use?'),
    earlierAck: body.includes('recorded durably by the Factory'), continueMessage: body.includes('continue\\nFactory continuation of the SAME session'),
    answer: body.includes('Use docs/factory-question.md'), implementRestarted: body.includes('/implement ') });
  const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'continue-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader',
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
  return new Response(chunk({ role: 'assistant', content: 'Continued with docs/factory-question.md.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
};
