import assert from 'node:assert/strict';

// Synthetic HTTP only; never delegates to a network implementation.
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
assert.equal(process.versions.node.split('.')[0], '24');
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  // Count entry BEFORE assertions: SDK may turn provider errors into messages.
  // An unexpected attempted turn must remain observable even if checks throw.
  process.send?.({ kind: 'provider-request', count: ++requests });
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key/);
  const content = JSON.parse(body).messages.find((m: { role: string }) => m.role === 'user').content;
  const mode: string = typeof content === 'string' ? content : content.map((c: { text: string }) => c.text).join('');
  const disabled = ['absent', 'standards', 'spec'].includes(mode);
  const tools = JSON.parse(body).tools.map((t: { function: { name: string } }) => t.function.name).sort();
  assert.deepEqual(tools, mode === 'standards' || mode === 'spec' ? ['read'] : disabled ? ['bash', 'write'] : ['bash', 'edit', 'write']);
  const critical = ['uncertain', 'persist', 'cancel', 'eof', 'budget', 'secret'].includes(mode);
  assert.ok(requests <= (critical || disabled ? 1 : mode === 'mismatch' || mode === 'no-match' ? 3 : 2), 'no provider continuation after critical Edit');
  process.send?.({ kind: 'provider-validated', count: requests });
  const edit = (id: string, oldText: string) => ({ id, type: 'function', function: { name: 'edit', arguments: JSON.stringify({ path: 'source', edits: [{ oldText, newText: 'new' }], editSourceMaxBytes: 8192 }) } });
  const retry = mode === 'mismatch' || mode === 'no-match';
  const calls = disabled || requests > (retry ? 2 : 1) ? [] : requests === 2 ? [edit('fresh', 'old')] : [edit('first', mode === 'no-match' ? 'missing' : 'old'),
    { id: 'following', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'following', content: 'ok' }) } }];
  const choices = calls.length ? [
    { index: 0, delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ] : [{ index: 0, delta: { role: 'assistant', content: 'Offline done.' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
  return new Response(choices.map(choice => 'data: ' + JSON.stringify({ id: 'edit-' + requests, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
