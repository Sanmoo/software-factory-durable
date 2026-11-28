import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SourceTriage, TicketSource } from '../../src/control/types.js';
import type { McpRegistration } from '../../src/workers/index.js';
import { applyLabel, remoteIssue } from './doubles.js';
import { hostileInstruction, mcpSource } from './mcp-source-fixture.js';
import { call, toolNames, toolResults, trackerWrites, triageWorld } from './triage-investigation-fixture.js';

// The Triager session gets the tools of the active MCP Profiles through a client in its own process. The
// Triager is the real worker under a scripted provider; the external source is a local MCP server.
const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const githubSource: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };
function triageIssue(number: number) {
  const issue = remoteIssue(number, { labels: [], title: 'Total errado', body: 'Detalhes.' });
  applyLabel(issue, 'needs-triage');
  return issue;
}
const verdict = { outcome: 'needs-info', category: 'bug', text: 'Falta dizer em que versão o total ficou errado.' };
const sourceToken = 'mcp_' + 'TRIAGEsourceCANARY';
const registration = (url: string, overrides: Partial<McpRegistration> = {}): McpRegistration => ({
  servers: [{ id: 'fonte', url, tokenFile: 'credentials/fonte-token' }],
  profiles: [
    { id: 'investigar-erros', server: 'fonte', tools: ['buscar_erros', 'consultar_trace'] },
    { id: 'inativo', server: 'fonte', tools: 'all' },
  ],
  active: ['investigar-erros'],
  ...overrides,
});
const world = (t: Parameters<typeof triageWorld>[0], mcp: McpRegistration, script: Parameters<typeof triageWorld>[1]['script']) =>
  triageWorld(t, { github: { issues: [triageIssue(7)], pulls: {} }, sources: [githubSource], script, mcp, credentials: { 'fonte-token': `${sourceToken}\n` } });
const sessionTools = ['bash', 'concluir_triagem', 'mcp__fonte__buscar_erros', 'mcp__fonte__consultar_trace', 'read', 'request_clone'];

test('only the tools of the active MCP Profile exist in the session; a tool outside it is refused at the call, directly, by codemode and by tool_search, and the server never sees it; no MCP of the operator is inherited', async t => {
  const source = await mcpSource(t, { token: sourceToken });
  // The operator's own agent directory, with a personal MCP server: where an SDK session would look by default.
  const personal = await mcpSource(t, { tools: ['pessoal'] });
  const home = await mkdtemp(join(tmpdir(), 'factory-triage-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { pessoal: { url: personal.url, exposure: 'direct' } } }));
  const before = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') });
  t.after(() => {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const w = await world(t, registration(source.url), [
    () => call('mcp__fonte__buscar_erros', { consulta: 'cart' }),
    () => call('mcp__fonte__apagar_dados', { consulta: 'tudo' }),
    () => call('codemode', { code: 'return await tools.mcp__fonte__apagar_dados({ consulta: "tudo" });' }),
    () => call('tool_search', { query: 'apagar_dados' }),
    () => call('mcp__pessoal__pessoal', { consulta: 'x' }),
    () => call('concluir_triagem', verdict),
  ]);
  await w.start();
  const request = await w.investigated();
  assert.equal(request.state, 'publishing');
  // The catalogue the model sees: the profile's two tools, never the third tool of the server nor the operator's server.
  for (const body of w.bodies) assert.deepEqual(toolNames(body), sessionTools);
  assert.match(toolResults(w.bodies[1]!).at(-1)!, /3 erros para buscar_erros/);
  // Each call outside the profile is refused where it is made.
  for (const index of [2, 3, 4, 5]) assert.match(toolResults(w.bodies[index]!).at(-1)!, /not found/i, `call ${index}`);
  assert.deepEqual(source.calls, [{ name: 'buscar_erros', arguments: { consulta: 'cart' } }], 'the server registered the allowed call only');
  assert.deepEqual(personal.methods, [], 'the personal MCP server of the operator was never contacted');
  // The credential reached the server and nothing else: no prompt, no bootstrap, no transcript.
  assert.deepEqual([...source.authorizations], [`Bearer ${sourceToken}`]);
  assert.ok(!w.bodies.join('\n').includes(sourceToken), 'the token is in no model request');
  for (const [path, content] of Object.entries(await w.attemptFiles())) assert.ok(!content.includes(sourceToken), `${path} carries the token`);
  // Operator metadata of the attempt: the active profiles and how many times each tool ran.
  const attempt = request.attempts![0]!;
  assert.deepEqual(attempt.mcpProfiles, ['investigar-erros']);
  assert.deepEqual(attempt.end?.toolCalls, { concluir_triagem: 1, mcp__fonte__buscar_erros: 1 });
  assert.deepEqual(trackerWrites(w.github.calls.map(item => item.method)), []);
});

test('`tools: all` gives the whole catalogue of the server; two active profiles of one server add up; without active profiles the session has no MCP tool', async t => {
  const source = await mcpSource(t, { token: sourceToken });
  const all = await world(t, registration(source.url, { active: ['inativo'] }), [() => call('concluir_triagem', verdict)]);
  await all.start();
  await all.investigated();
  assert.deepEqual(toolNames(all.bodies[0]!), [...sessionTools, 'mcp__fonte__apagar_dados'].sort());
  await all.stop();
  const profiles = [
    { id: 'a', server: 'fonte', tools: ['buscar_erros'] },
    { id: 'b', server: 'fonte', tools: ['consultar_trace', 'ausente_do_servidor'] },
  ];
  const both = await world(t, registration(source.url, { profiles, active: ['a', 'b'] }), [() => call('concluir_triagem', verdict)]);
  await both.start();
  assert.deepEqual((await both.investigated()).attempts![0]!.mcpProfiles, ['a', 'b']);
  assert.deepEqual(toolNames(both.bodies[0]!), sessionTools, 'a tool the server does not offer is not declared');
  await both.stop();
  const methods = source.methods.length;
  const none = await world(t, registration(source.url, { active: [] }), [() => call('concluir_triagem', verdict)]);
  await none.start();
  const request = await none.investigated();
  assert.equal(request.state, 'publishing');
  assert.deepEqual(toolNames(none.bodies[0]!), ['bash', 'concluir_triagem', 'read', 'request_clone']);
  assert.deepEqual(request.attempts![0]!.mcpProfiles, []);
  assert.equal(source.methods.length, methods, 'registering activates nothing: the server is not contacted');
});

test('an unavailable, a slow and a giant source reach the Triager as an error or a cut of that call, and the request goes on to its Verdict', async t => {
  const source = await mcpSource(t, { token: sourceToken });
  const w = await world(t, registration(source.url, { requestTimeoutMs: 300 }), [
    () => (source.mode('unavailable'), call('mcp__fonte__buscar_erros', { consulta: 'a' })),
    () => (source.mode('slow'), call('mcp__fonte__buscar_erros', { consulta: 'b' })),
    () => (source.mode('giant'), call('mcp__fonte__buscar_erros', { consulta: 'c' })),
    () => (source.mode('ok'), call('mcp__fonte__consultar_trace', { consulta: 'd' })),
    () => call('concluir_triagem', verdict),
  ]);
  await w.start();
  const request = await w.investigated();
  assert.equal(request.state, 'publishing', 'the request went on');
  const result = (index: number) => toolResults(w.bodies[index]!).at(-1)!;
  assert.match(result(1), /MCP_SOURCE_UNAVAILABLE/);
  assert.match(result(2), /MCP_SOURCE_TIMEOUT/);
  assert.match(result(3), /truncated/);
  assert.match(result(3), /INICIO /);
  assert.match(result(3), / FIM/);
  assert.ok(Buffer.byteLength(result(3)) < 24_000, 'the giant answer was cut');
  assert.match(result(4), /3 erros para consultar_trace/, 'the source is used again after its failures');
  // One request to the source per call of the model: nothing is retried behind it.
  assert.deepEqual(
    source.calls.map(item => item.name),
    ['buscar_erros', 'buscar_erros', 'buscar_erros', 'consultar_trace'],
  );
  assert.deepEqual(request.attempts![0]!.end?.toolCalls, { concluir_triagem: 1, mcp__fonte__buscar_erros: 3, mcp__fonte__consultar_trace: 1 });
});

test('a source that is down when the session starts, or an answer over the size the client accepts, is an error of the call; the Triage is not failed', async t => {
  const source = await mcpSource(t, { token: sourceToken, giantBytes: 6 * 1024 * 1024 });
  source.mode('unavailable');
  const w = await world(t, registration(source.url, { requestTimeoutMs: 300 }), [
    () => call('mcp__fonte__buscar_erros', { consulta: 'a' }),
    () => (source.mode('giant'), call('mcp__fonte__buscar_erros', { consulta: 'b' })),
    () => call('concluir_triagem', verdict),
  ]);
  await w.start();
  const request = await w.investigated();
  assert.equal(request.state, 'publishing');
  // The named tools of the profile stay declared, so the failure is told to the Triager when it asks.
  assert.deepEqual(toolNames(w.bodies[0]!), sessionTools);
  assert.match(toolResults(w.bodies[1]!).at(-1)!, /MCP_SOURCE_UNAVAILABLE/);
  assert.match(toolResults(w.bodies[2]!).at(-1)!, /MCP_RESULT_TOO_LARGE/);
  assert.ok(Buffer.byteLength(w.bodies[2]!) < 200_000, 'nothing of the oversized answer travels to the model');
});

test('an instruction embedded in the answer of a source is delivered as data; the session has no tracker write, and a malformed Verdict is refused', async t => {
  const source = await mcpSource(t, { token: sourceToken });
  source.mode('hostile');
  const w = await world(t, registration(source.url), [
    () => call('mcp__fonte__buscar_erros', { consulta: 'cart' }),
    // A model that obeys the embedded instruction: it looks for the tracker tools and concludes with an outcome that does not exist.
    () => call('close_issue', { number: 7 }),
    () => call('add_label', { label: 'approved' }),
    () => call('concluir_triagem', { ...verdict, outcome: 'merged' }),
    () => call('concluir_triagem', verdict),
  ]);
  await w.start();
  const request = await w.investigated();
  // The content arrived as the result of the tool call, word for word, and changed nothing by itself.
  assert.ok(toolResults(w.bodies[1]!).at(-1)!.includes(hostileInstruction));
  for (const body of w.bodies) assert.deepEqual(toolNames(body), sessionTools, 'no tracker write tool, no ask_user');
  for (const index of [2, 3]) assert.match(toolResults(w.bodies[index]!).at(-1)!, /not found/i);
  assert.match(toolResults(w.bodies[4]!).at(-1)!, /VERDICT_OUTCOME_INVALID/);
  // The only effect is one of the four outcomes, recorded; nothing was written to the tracker.
  assert.deepEqual([request.state, request.verdict?.outcome], ['publishing', 'needs-info']);
  assert.deepEqual(trackerWrites(w.github.calls.map(item => item.method)), []);
});

test('MCP: an answer of the source that carries its own token is withheld from the model', async t => {
  const source = await mcpSource(t, { token: sourceToken, echo: sourceToken });
  const w = await world(t, registration(source.url), [() => call('mcp__fonte__buscar_erros', { consulta: 'cart' }), () => call('concluir_triagem', verdict)]);
  await w.start();
  const request = await w.investigated();
  assert.equal(request.state, 'publishing');
  assert.match(toolResults(w.bodies[1]!).at(-1)!, /TOOL_OUTPUT_WITHHELD/);
  assert.ok(!w.bodies.join('\n').includes(sourceToken));
  assert.ok(!(await w.transcript(request)).includes(sourceToken));
});
