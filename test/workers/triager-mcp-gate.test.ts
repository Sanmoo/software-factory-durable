import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceClient } from '../../src/workers/triager-mcp.js';
import { mcpSource } from '../control/mcp-source-fixture.js';

// The selection of tools holds at the call. The session declares only the selected tools, so no
// call of the model reaches a tool outside the profile (triage-mcp-profiles.test.ts: such a name is "not found"). This file drives the
// second barrier itself, the gate of the one client every call to a server goes through, against a real local MCP server.
test('a call for a tool outside the active profile is refused by the client at the call (MCP_TOOL_NOT_IN_PROFILE) and never reaches the server', async t => {
  const source = await mcpSource(t);
  const stop = new AbortController();
  const client = sourceClient(
    { server: 'fonte', url: source.url, tokenFile: null, tools: ['buscar_erros'] },
    null,
    { requestTimeoutMs: 5000, startupTimeoutMs: 5000 },
    stop.signal,
  );
  t.after(() => client.close());
  // The server does offer the tool: only the profile keeps it out.
  assert.ok((await client.catalogue())?.some(tool => tool.name === 'apagar_dados'));
  const before = source.methods.length;
  await assert.rejects(client.call('apagar_dados', { consulta: 'tudo' }, stop.signal), /^Error: MCP_TOOL_NOT_IN_PROFILE$/);
  assert.deepEqual([source.calls, source.methods.length], [[], before], 'nothing of the refused call was sent to the server');
  const allowed = await client.call('buscar_erros', { consulta: 'cart' }, stop.signal);
  assert.match(allowed.content[0]!.text, /3 erros para buscar_erros/);
  assert.deepEqual(source.calls, [{ name: 'buscar_erros', arguments: { consulta: 'cart' } }]);
});

test('with `tools: all` the same gate lets every tool of the server through', async t => {
  const source = await mcpSource(t);
  const stop = new AbortController();
  const client = sourceClient(
    { server: 'fonte', url: source.url, tokenFile: null, tools: 'all' },
    null,
    { requestTimeoutMs: 5000, startupTimeoutMs: 5000 },
    stop.signal,
  );
  t.after(() => client.close());
  await client.call('apagar_dados', { consulta: 'tudo' }, stop.signal);
  assert.deepEqual(
    source.calls.map(item => item.name),
    ['apagar_dados'],
  );
});
