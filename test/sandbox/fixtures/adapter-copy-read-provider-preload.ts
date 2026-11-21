// Closed owned fixture: SDK deny-all, Unix only, no actual provider/model call.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { guardFixtureNetwork } from '../adapter-fixture-network-guard.js';
guardFixtureNetwork(resolve(process.env.TMPDIR!, '../../../..'), true);
assert.deepEqual(Object.keys(process.env).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
let attempts = 0;
let copy = '';
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  attempts++;
  process.send?.({ kind: 'provider-attempt', count: attempts });
  assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-key|segredo-🔒-ação/);
  const parsed = JSON.parse(body);
  const publish = body.includes('Task149 publish');
  const allowed = publish || body.includes('Task149 selected');
  const builder = publish || body.includes('Task149 builder');
  assert.deepEqual(parsed.tools.map((t: { function: { name: string } }) => t.function.name).sort(), builder ? ['ask_user', 'bash', 'read', 'write'] : ['read']);
  const read = parsed.tools.find((t: { function: { name: string } }) => t.function.name === 'read').function.parameters;
  assert.deepEqual(Object.keys(read.properties).sort(), ['limit', 'offset', 'path']);
  assert.ok(attempts <= (publish ? 4 : 2));
  const toolResults = parsed.messages.filter((m: { role: string }) => m.role === 'tool');
  if (publish && attempts === 2) {
    const match = body.match(/Full output: (\/artifacts\/factory-output-[0-9a-f-]{36}\.txt)/);
    assert.ok(match);
    copy = match[1]!;
  } else if (!publish) {
    const match = body.match(/\/artifacts\/factory-output-[0-9a-f-]{36}\.txt/);
    assert.ok(match);
    copy = match[0];
  }
  if (attempts > (publish ? 2 : 1)) {
    const last = JSON.stringify(toolResults.at(-1));
    if (allowed) assert.match(last, publish && attempts === 3 ? /head π █ █ █/ : /tail π/);
    else assert.match(last, /READ_PATH_DENIED/);
  }
  const call =
    publish && attempts === 1
      ? { name: 'bash', arguments: JSON.stringify({ command: "printf 'syn''thetic-se''cret'; printf 'tail π' >&2" }) }
      : attempts <= (publish ? 3 : 1)
        ? {
            name: 'read',
            arguments: JSON.stringify({ path: copy, offset: publish && attempts === 2 ? 1 : 80002, limit: 1, selectedOutputCopies: [copy], copyOutput: true }),
          }
        : undefined;
  process.send?.({ kind: 'provider-validated', count: attempts });
  const choices = call
    ? [
        { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + attempts, type: 'function', function: call }] }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ]
    : [
        { index: 0, delta: { role: 'assistant', content: 'Complete.' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ];
  const events = choices
    .map(
      choice =>
        'data: ' + JSON.stringify({ id: 'copy-read-' + attempts, object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n',
    )
    .join('');
  return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
