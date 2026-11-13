// Guard before SDK/application imports. No real SDK VM, TCP/DNS or OS commands.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { guardFixtureNetwork } from '../adapter-fixture-network-guard.js';
guardFixtureNetwork(resolve(process.env.TMPDIR!, '../../../..'), true);
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let attempts = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  // Count/notify ALL attempts before any assertion; SDK may swallow fetch errors.
  attempts++; process.send?.({ kind: 'provider-attempt', count: attempts });
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key|segredo-🔒-ação/);
  const failure = body.includes('Task145 fail');
  const enabled = body.includes('Task145 ok');
  assert.ok(attempts <= (failure ? 1 : 2));
  assert.match(body, /"name":"bash"/); assert.match(body, /"name":"write"/);
  if (enabled || failure) assert.match(body, /"name":"read"/);
  else assert.doesNotMatch(body, /"name":"read"/);
  assert.doesNotMatch(body, /"name":"edit"/);
  const parsed = JSON.parse(body);
  const schema = parsed.tools.find((tool: { function: { name: string } }) => tool.function.name === 'bash').function.parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['command', 'timeout']);
  if (attempts === 2) {
    assert.match(body, /tail π/);
    if (enabled) assert.match(body, /Full output: \/artifacts\/factory-output-[0-9a-f-]{36}\.txt/);
    else assert.doesNotMatch(body, /Full output: \/artifacts\//);
  }
  process.send?.({ kind: 'provider-validated', count: attempts });
  const calls = [{ index: 0, id: 'bash-run', type: 'function', function: { name: 'bash', arguments: JSON.stringify({
    command: "printf 'syn''thetic-se''cret'; printf 'tail π' >&2", copyOutput: !enabled,
  }) } }, ...(failure ? [{ index: 1, id: 'queued-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'never.txt', content: 'no' }) } }] : [])];
  const choices = attempts === 1 ? [
    { index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ] : [{ index: 0, delta: { role: 'assistant', content: 'Complete.' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
  const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'copy-response-' + attempts,
    object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
