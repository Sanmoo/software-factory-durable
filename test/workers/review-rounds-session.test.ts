import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ProposalHandoff } from '../../src/contracts/index.js';
import type { BuilderDirective, HandoffEvent } from '../../src/workers/index.js';

// I-local: native Pi SDK loop (session JSONL), real Records and owner tool transport; doubled ONLY the provider HTTP boundary (scripted
// offline responses) and the VM exec (command -> exit code/output). Ticket 13: repeated handoffs with treatments/gates whose evidence the
// Host takes from its OWN record of the Builder's Bash results, the round limit, and the closing capture after the session ended.
const builder: ToolContext = { workId: 'work-13', executionId: 'execution-13', invocationId: 'builder-13', role: 'builder',
  environmentRef: 'environment-13', bootRef: 'boot-13', phaseId: 'builder-initial' };
const base = 'a'.repeat(40);
const summary = (round: number, content = '1'): ProposalHandoff => ({ version: 1, round, index: `/artifacts/review/r${round}/index.json`, indexSha256: String(round % 10).repeat(64),
  head: 'b'.repeat(40), branch: 'factory/3-abcdef12', base, mergeBase: base, counts: { entries: 1, committed: 0, staged: 0, unstaged: 1, untracked: 0, removed: 0 },
  patches: { committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 0, sha256: 'd'.repeat(64) },
    staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'd'.repeat(64) }, unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 9, sha256: 'c'.repeat(64) } },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: 'f'.repeat(64) }, instructions: null, changed: ['/workspace/checkout/docs/a.md'], changedTruncated: false,
  content: { sha256: content.repeat(64), clean: false, headMatches: false } });
const profile = (directory: string) => ({ id: sdkProfile.id, directory, systemPrompt: 'Factory builder fixture. No personal resources.',
  providerId: 'offline-fixture', modelId: 'builder', apiKey: 'synthetic-key', provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid',
    models: [{ id: 'builder', name: 'Builder', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } });
type Step = { tools?: { name: string; arguments: object }[]; text?: string };
function provider(t: { mock: { method: typeof import('node:test').mock.method } }, steps: Step[]) {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const body = input instanceof Request ? await input.text() : String(init?.body);
    bodies.push(body);
    const step = steps[bodies.length - 1];
    assert.ok(step, `unexpected provider request ${bodies.length}`);
    const choices = step.tools ? [{ index: 0, delta: { role: 'assistant', tool_calls: step.tools.map((tool, i) => ({ index: i, id: `call-${bodies.length}-${i}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'tool_calls' }]
      : [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
    const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'builder', choices: [choice] }) + '\n\n').join('');
    return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return bodies;
}
const gate = (id: string, command: string, extra: object = {}) => ({ id, source: '/artifacts/spec/v1/ticket.json#validation', command, cwd: '/workspace', status: 'run', ...extra });
/** The Host's own content probe (ticket 13 review fix 1): the SAME constant program in probe mode, chosen by the Host only. */
const isProbe = (command: string) => command.includes(' /artifacts probe <<');
const isCapture = (command: string) => /^exec \/usr\/bin\/python3 -I -S - \/workspace\/checkout \/artifacts ([0-9]+) [0-9a-f]{40} \/workspace\/checkout \/artifacts <<'FACTORY_HANDOFF_EOF'\n/.test(command);

test('AC1-AC3: repeated handoffs carry treatments and Host gate evidence from the real Bash results and their content snapshots; the round limit and the closing capture are enforced', { timeout: 20000 }, async t => {
  const commands: string[] = [];
  let content = '1';
  const exits: Record<string, number[]> = { 'npm test': [1, 0], 'npm run lint': [0], 'echo fix >> docs/a.md': [0], 'npm run build': [0] };
  const f = await nativeOwner(builder, { exec(argv) {
    const command = argv[argv.length - 1]!;
    commands.push(command);
    if (isProbe(command)) return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from(JSON.stringify({ sha256: content.repeat(64), clean: false, headMatches: false })) }; },
      result: Promise.resolve({ exitCode: 0 }) };
    const capture = /^exec \/usr\/bin\/python3 -I -S - \/workspace\/checkout \/artifacts ([0-9]+) [0-9a-f]{40} \/workspace\/checkout \/artifacts <<'FACTORY_HANDOFF_EOF'\n/.exec(command);
    const round = capture ? Number(capture[1]) : 0;
    if (command.includes('echo fix')) { content = '2'; return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from('') }; }, result: Promise.resolve({ exitCode: 0 }) }; }
    if (command === 'npm run build') { content = '3'; return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from('') }; }, result: Promise.resolve({ exitCode: 0 }) }; }
    const exitCode = capture ? 0 : exits[command]?.shift() ?? 127;
    return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from(capture ? JSON.stringify(summary(round, content)) : `ran ${command}\n`) }; },
      result: Promise.resolve({ exitCode }) };
  } });
  t.after(() => f.close());
  const bodies = provider(t, [
    { tools: [{ name: 'bash', arguments: { command: 'npm test' } }] }, { tools: [{ name: 'bash', arguments: { command: 'npm test' } }] },
    { tools: [{ name: 'bash', arguments: { command: 'npm run lint' } }] },
    { tools: [{ name: 'handoff', arguments: { gates: [gate('ci', 'npm run ci', { status: 'waived', reason: 'faster' })] } }] },
    { tools: [{ name: 'handoff', arguments: { gates: [gate('test', 'npm test'), gate('lint', 'npm run lint'), gate('typecheck', 'npm run typecheck')] } }] },
    { tools: [{ name: 'bash', arguments: { command: 'echo fix >> docs/a.md' } }] },
    // Real-run regression (q13-rounds-v3): a placeholder treatment for a reviewer without findings is refused, no round used.
    { tools: [{ name: 'handoff', arguments: { treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'Appended the missing line.' },
      { round: 1, role: 'standards', findingId: 'none', outcome: 'not-adopted', justification: 'Standards reported no findings.' }], gates: [gate('lint', 'npm run lint')] } }] },
    { tools: [{ name: 'handoff', arguments: { treatments: [{ round: 1, role: 'spec', findingId: 'S1', outcome: 'fixed', justification: 'Appended the missing line.' }],
      gates: [gate('lint', 'npm run lint')] } }] },
    { tools: [{ name: 'bash', arguments: { command: 'npm run build' } }] },
    { tools: [{ name: 'handoff', arguments: { gates: [gate('build', 'npm run build'), gate('build-wrong-cwd', 'npm run build', { cwd: '/workspace/checkout' }),
      gate('test', 'npm test')] } }] },
    { tools: [{ name: 'handoff', arguments: {} }] },
    { text: 'Done: S1 fixed; lint was not re-run after the fix.' }]);
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const events: HandoffEvent[] = [];
  const directives: BuilderDirective[] = [
    { kind: 'review-results', round: 1, prompt: 'FACTORY REVIEW RESULTS round 1: spec finding S1.', findings: { standards: [], spec: ['S1'] } },
    { kind: 'review-results', round: 2, prompt: 'FACTORY REVIEW RESULTS round 2: both clean.' },
    { kind: 'review-results', round: 3, prompt: 'FACTORY REVIEW RESULTS round 3: both clean.' },
    { kind: 'review-results', round: 4, prompt: 'Closing capture recorded.', end: true }];
  const session = createWorkerSession({ profile: profile(directory), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }),
    async onHandoff(event) { events.push(event); return directives.shift()!; } });
  const result = await session.activate({ context: builder, prompt: 'Implement.', signal: f.authority.signal, handoff: { baseCommit: base, rounds: { first: 1, max: 4 } } });
  assert.equal(result.status, 'completed');
  assert.equal(bodies.length, 12, 'no provider request after the closing directive ended the activation');
  assert.match(bodies[4]!, /HANDOFF_DECLARATIONS_INVALID/, 'a waiver without authorization is refused before any capture');
  assert.match(bodies[7]!, /HANDOFF_TREATMENT_UNKNOWN_FINDING[^"]*1\/standards\/none/, 'an unlisted finding is refused before any capture');
  assert.match(bodies[11]!, /HANDOFF_ROUND_LIMIT/, 'the last capture is reserved for the closing one');
  assert.deepEqual(events.map(event => [event.round, event.status, event.closing ?? false]), [[1, 'captured', false], [2, 'captured', false], [3, 'captured', false], [4, 'captured', true]]);
  const first = events[0]!.declarations!;
  assert.deepEqual(first.gates.map(item => [item.id, item.outcome, item.exitCode, item.current, item.code]),
    [['test', 'passed', 0, true, null], ['lint', 'passed', 0, true, null], ['typecheck', 'unverified', null, false, 'GATE_RESULT_NOT_FOUND']]);
  assert.ok(first.gates[0]!.output && first.gates[0]!.output.workId === 'work-13', 'evidence is the protected output reference of the real Bash result');
  const output = await f.records.read({ reference: first.gates[0]!.output!, offset: 0, limit: 4096 });
  assert.match(output.data.toString('utf8'), /ran npm test/, 'the referenced protected output is the latest run of that command');
  const second = events[1]!.declarations!;
  assert.deepEqual(second.treatments.map(item => [item.round, item.role, item.findingId, item.outcome]), [[1, 'spec', 'S1', 'fixed']]);
  assert.deepEqual(second.gates.map(item => [item.id, item.outcome, item.current, item.code]), [['lint', 'passed', false, 'GATE_NOT_CURRENT']],
    'the content changed after that lint run: a later Bash (even outside a declared gate) makes it not current');
  const third = events[2]!.declarations!;
  assert.deepEqual(third.gates.map(item => [item.id, item.outcome, item.current, item.code]),
    [['build', 'passed', false, 'GATE_MUTATED_CONTENT'], ['build-wrong-cwd', 'passed', false, 'GATE_CWD_MISMATCH'],
      ['test', 'passed', false, 'GATE_NOT_CURRENT']],
    'the mutating build is not evidence of the captured content, the wrong cwd is not evidence, and the earlier test ran on other content');
  assert.equal(events[3]!.declarations, undefined, 'the closing capture is the Host\'s own: no declarations');
  assert.equal(commands.filter(command => isCapture(command)).length, 4, 'the probes are Host content snapshots, not captures');
  assert.ok(commands.filter(command => isProbe(command)).length >= 8, 'content is probed before/after every model Bash command');
  const transcript = await readFile(result.sessionFile!, 'utf8');
  assert.match(transcript, /FACTORY REVIEW RESULTS round 2/);
  assert.doesNotMatch(transcript, /Closing capture recorded/, 'the ending directive is not sent to the model');
});

test('ticket 12 compatibility: without a rounds policy there is one round, no declarations and no closing capture', { timeout: 15000 }, async t => {
  const commands: string[] = [];
  const f = await nativeOwner(builder, { exec(argv) {
    const command = argv[argv.length - 1]!;
    commands.push(command);
    return { async *output() { yield { stream: 'stdout' as const, data: Buffer.from(JSON.stringify(summary(1))) }; }, result: Promise.resolve({ exitCode: 0 }) };
  } });
  t.after(() => f.close());
  provider(t, [{ tools: [{ name: 'handoff', arguments: {} }] }, { text: 'done' }]);
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const events: HandoffEvent[] = [];
  const session = createWorkerSession({ profile: profile(directory), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }),
    async onHandoff(event) { events.push(event); return { kind: 'review-results', round: 1, prompt: 'results' }; } });
  const result = await session.activate({ context: builder, prompt: 'Implement.', signal: f.authority.signal, handoff: { baseCommit: base } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.map(event => [event.round, event.closing ?? false, event.declarations ?? null]), [[1, false, null]]);
  assert.equal(commands.length, 1);
});
