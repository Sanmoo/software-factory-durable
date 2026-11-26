// Spec #68 §6-§7 (ticket #75), layer R: the production Triager agent in the real Investigation Environment, one scenario. The fixed
// `triager` entrypoint is started by a real transient unit of the user manager, reads its private bootstrap, runs a real session against
// a scripted model provider (a local HTTP server: the agent stays outside the confinement) and runs its commands through real bubblewrap.
// Without bubblewrap or the user manager this test FAILS; it never skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { triagerAgentStart } from '../../src/entrypoints/controller/composition.js';
import { createInvestigationClones, createInvestigationEnvironment, investigationEnvironmentRoot } from '../../src/sandbox/index.js';
import { createTriager, type TriagerCompletion } from '../../src/workers/index.js';
import { remainingMs } from '../runner/budget.js';

const canary = 'ghs_' + 'TRIAGERagentCANARY';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x',
    },
  }).trim();
type Turn = (results: string[]) => { name: string; arguments: unknown } | string;
const toolResults = (body: string) =>
  (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages
    .filter(message => message.role === 'tool')
    .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));

/** The model provider of the scenario: one scripted turn per request, as an OpenAI-compatible event stream. */
async function provider(turns: Turn[]) {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      bodies.push(body);
      const turn = turns.shift()?.(toolResults(body)) ?? 'No further turn.';
      const delta =
        typeof turn === 'string'
          ? { role: 'assistant', content: turn }
          : {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: `call-${bodies.length}`, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.arguments) } },
              ],
            };
      const chunk = (choice: unknown) => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [choice] })}\n\n`;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        chunk({ index: 0, delta, finish_reason: null }) +
          chunk({ index: 0, delta: {}, finish_reason: typeof turn === 'string' ? 'stop' : 'tool_calls' }) +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test(
  'the production Triager agent runs one session inside the attempt unit: a clone read through the confinement, then the Verdict',
  { timeout: remainingMs() },
  async t => {
    // TR-35 through the real unit: the process that starts the attempt (the Control's, here the test's) holds a tracker token and an
    // MCP token in its environment, as a Host does. Neither may reach the agent's start, the confined shell, the model or the transcript.
    const held = {
      GH_TOKEN: 'ghs_' + 'TRIAGERtrackerCANARY',
      JIRA_API_TOKEN: 'jira-' + 'TRIAGERtrackerCANARY',
      FACTORY_MCP_TOKEN: 'mcp-' + 'TRIAGERsourceCANARY',
    };
    Object.assign(process.env, held);
    t.after(() => {
      for (const name of Object.keys(held)) delete process.env[name];
    });
    const secrets = [canary, ...Object.values(held)];
    const factoryRoot = await mkdtemp(join(tmpdir(), 'ftr-'));
    const upstream = join(factoryRoot, 'upstream');
    await mkdir(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    await writeFile(join(upstream, 'cart.js'), 'export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'cart: sum the prices');
    const verdict = { outcome: 'needs-info', category: 'bug', text: 'Falta a versão em que o total ficou errado.' };
    const model = await provider([
      () => ({ name: 'request_clone', arguments: { repository: 'acme/project' } }),
      results => {
        const path = /Read it at (\S+) \(read-only\)/.exec(results.at(-1)!)![1]!;
        return {
          name: 'bash',
          arguments: {
            command: `cat ${path}/cart.js; git -C ${path} log --format=%s; env; tr '\\0' '\\n' < /proc/self/environ; touch ${path}/new; echo rc=$?`,
          },
        };
      },
      () => ({ name: 'concluir_triagem', arguments: verdict }),
    ]);
    const environment = createInvestigationEnvironment({ root: investigationEnvironmentRoot(factoryRoot), factoryRoot });
    const clones = createInvestigationClones({
      root: factoryRoot,
      fetch: {
        fetch: async () => ({ token: canary, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        revoke: async () => ({ kind: 'revoked' }),
      } as unknown as Parameters<typeof createInvestigationClones>[0]['fetch'],
      remoteUrl: () => `file://${upstream}`,
    });
    const triager = createTriager({
      root: factoryRoot,
      skillPack: 'factory-skills-v13',
      profile: {
        id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
        systemPrompt: 'Factory Triager policy.',
        providerId: 'fixture',
        modelId: 'm',
        apiKey: 'synthetic-key',
        provider: {
          api: 'openai-completions',
          baseUrl: model.url,
          models: [
            {
              id: 'm',
              name: 'm',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 1000,
            },
          ],
        },
      },
      // The agent start of the production composition: the fixed entrypoint with its closed environment.
      agent: triagerAgentStart,
    });
    const attempt = `t${randomBytes(4).toString('hex')}-1`;
    const intent = await environment.plan(attempt);
    const recorded: unknown[] = [];
    let directory = '';
    const activation = await triager.activate({
      attempt,
      activation: {
        ticket: 'acme/project#7\nTitle: Total errado',
        origin: 'GitHub issue acme/project#7',
        candidateRepositories: '- acme/project (default branch `main`)',
        openBlockers: 'None observed.',
        builderReach: 'The repository and its issues.',
        remainingInvestigationTime: '15 minutes',
      },
      host: {
        async requestClone(repository) {
          const created = await clones.create({ directory, name: 'acme__project', repository, repositoryId: 7, installationId: 2, base: 'main' });
          if (created.status !== 'success') return { status: 'refused', code: created.code, message: 'clone failed' };
          const mounted = await environment.mountClone(attempt, { name: 'acme__project', source: created.path });
          return { status: 'cloned', repository, path: mounted.path, commit: created.commit };
        },
        async conclude(input) {
          recorded.push(input);
          return { status: 'recorded' };
        },
      },
    });
    t.after(async () => {
      await environment.stop(intent);
      await activation.close();
      await model.close();
      await rm(factoryRoot, { recursive: true, force: true });
    });
    assert.deepEqual(activation.agent.argv.length, 2, 'the entrypoint and the bootstrap file: nothing else on the command line');
    assert.ok(!JSON.stringify(activation.agent).includes('synthetic-key'), 'no credential on the command line of the unit');
    const opened = await environment.open(intent, { limits: { memoryGiB: 2, processes: 512, commandSeconds: 120 }, agent: activation.agent });
    assert.equal(opened.status, 'success', JSON.stringify(opened));
    assert.ok(opened.status === 'success');
    directory = opened.clones;

    const completion: TriagerCompletion = await activation.completed;
    assert.deepEqual(
      [completion.status, 'concluded' in completion && completion.concluded, 'sessionTools' in completion && completion.sessionTools],
      ['completed', true, ['bash', 'concluir_triagem', 'read', 'request_clone']],
      JSON.stringify(completion),
    );
    assert.deepEqual(recorded, [verdict]);
    assert.equal(model.bodies.length, 3, 'the accepted Verdict ended the session');
    const [cloned, shell] = toolResults(model.bodies[2]!);
    assert.match(cloned!, /^Cloned acme\/project at commit [0-9a-f]{40}\. Read it at \/repos\/acme__project \(read-only\)\./);
    assert.match(shell!, /items\.reduce/, 'the clone is read inside the confinement');
    assert.match(shell!, /cart: sum the prices/);
    assert.match(shell!, /Read-only file system[\s\S]*rc=1/, 'and cannot be written');
    assert.match(shell!, /^PATH=/m, 'the shell really printed its environment');
    assert.doesNotMatch(shell!, /TOKEN|CANARY|synthetic-key/, 'no credential variable in the shell');
    for (const secret of secrets) {
      assert.ok(!JSON.stringify(activation.agent).includes(secret), 'TR-35: the start of the agent carries no token');
      assert.ok(!model.bodies.join('\n').includes(secret), 'TR-35: no model request carries a token');
    }
    // The transcript stays in the attempt's private directory of the installation, and the stop of the unit is confirmed.
    assert.ok('transcript' in completion && completion.transcript);
    const transcript = await readFile(join(factoryRoot, completion.transcript), 'utf8');
    assert.match(transcript, /concluir_triagem/);
    for (const secret of secrets) assert.ok(!transcript.includes(secret), 'TR-35: the transcript carries no token');
    assert.deepEqual(await environment.stop(opened.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
    assert.deepEqual(await environment.close(opened.record), { cessationConfirmed: true, evidence: 'unit-inactive' });
  },
);
