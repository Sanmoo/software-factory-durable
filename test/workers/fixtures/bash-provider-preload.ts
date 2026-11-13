import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
assert.equal(process.versions.node.split('.')[0], '24');
// Test sentinel, not an alternate backend: any native local fallback is forbidden.
childProcess.spawn = () => assert.fail('HOST_DEFAULT_SPAWN_FORBIDDEN');
syncBuiltinESMExports();
let requests = 0;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key|segredo-🔒-ação/);
  assert.match(body, /"name":"bash"/); assert.match(body, /"name":"write"/);
  assert.doesNotMatch(body, /"name":"(?:read|edit)"/);
  const blocked = body.includes('blocked-bash');
  assert.ok(++requests <= (blocked ? 1 : 2), 'no next model turn after critical Bash failure');
  if (requests === 2) assert.match(body, /tail π/);
  process.send?.({ kind: 'provider-request', count: requests });
  const choices = requests === 1 ? [
    { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bash-run', type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: "printf 'syn''thetic-se''cret'; printf 'tail π' >&2" }) } }] }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ] : [
    { index: 0, delta: { role: 'assistant', content: 'Offline Bash complete.' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ];
  const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'bash-response-' + requests,
    object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
