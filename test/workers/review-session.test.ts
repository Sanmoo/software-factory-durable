import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
type GuestOwner = Parameters<typeof nativeOwner>[1];
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import type { ProposalHandoff } from '../../src/contracts/index.js';

// I-local: native Pi SDK loop, real Records, real owner tool transport/confined read programs; doubled ONLY the provider HTTP boundary
// (scripted offline responses) and the VM exec. Not evidence of a real model, guest or VM.
const reviewer = (role: 'standards' | 'spec'): ToolContext => ({ workId: 'work-12', executionId: 'execution-12', invocationId: `${role}-r1a1`,
  role, environmentRef: 'environment-12', bootRef: 'boot-12', phaseId: 'review-r1' });
const builder: ToolContext = { workId: 'work-12', executionId: 'execution-12', invocationId: 'builder-12', role: 'builder',
  environmentRef: 'environment-12', bootRef: 'boot-12', phaseId: 'builder-initial' };
const index = '/artifacts/review/r1/index.json';
const files: Record<string, string> = {
  [index]: JSON.stringify({ entries: [{ path: 'src/a.ts', guestPath: '/workspace/checkout/src/a.ts' }] }),
  '/artifacts/spec/v1/sources.json': '{"complete":true}', '/artifacts/instructions/v1/sources.json': '{"complete":true}',
  '/workspace/checkout/src/a.ts': 'export const a = 1;\n',
};
const directories = new Set(['/artifacts/spec/v1']);
/** Paths that do not exist in the guest (ticket 14 real run v7: GLOSSARY.md and docs/adr named by the instructions); the program exits 4. */
const missing = new Set(['/workspace/checkout/GLOSSARY.md', '/workspace/checkout/docs/adr']);
type Step = { tools?: { name: string; arguments: object }[]; text?: string };
const guestReads: string[] = [];
const vm: GuestOwner = { exec(argv) {
  const path = argv[5]!;
  guestReads.push(path);
  const content = files[path];
  // The confined guest program exits 3 for a directory (ticket 13 real run: Standards read `/artifacts/spec/v1`).
  return { async *output() { if (content !== undefined) yield { stream: 'stdout' as const, data: Buffer.from(content) }; },
    result: Promise.resolve({ exitCode: directories.has(path) ? 3 : missing.has(path) ? 4 : content === undefined ? 1 : 0 }) };
} };
const profile = (directory: string) => ({ id: sdkProfile.id, directory, systemPrompt: 'Factory reviewer fixture. No personal resources.',
  providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key', provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid',
    models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } });

/** External provider HTTP boundary only: scripted steps; records every request body (tools offered, messages). */
function provider(t: { mock: { method: typeof import('node:test').mock.method } }, steps: Step[]) {
  const bodies: { tools: string[]; text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input instanceof Request ? input.url : String(input), 'https://offline.invalid/chat/completions');
    const body = input instanceof Request ? await input.text() : String(init?.body);
    const parsed = JSON.parse(body) as { tools?: { function: { name: string } }[] };
    bodies.push({ tools: (parsed.tools ?? []).map(tool => tool.function.name).sort(), text: body });
    const step = steps[bodies.length - 1];
    assert.ok(step, `unexpected provider request ${bodies.length}`);
    const choices = step.tools ? [{ index: 0, delta: { role: 'assistant', tool_calls: step.tools.map((tool, i) => ({ index: i, id: `call-${bodies.length}-${i}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'tool_calls' }]
      : [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
    const events = choices.map(choice => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('');
    return new Response(events + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return bodies;
}
const verdict = (value: object) => '```json\n' + JSON.stringify(value) + '\n```';
const clean = (role: string) => ({ role, conclusion: 'clean', coverage: { scope: 'broad', justification: 'Whole proposal and its preserved sources.', examined: ['/workspace/checkout/src/a.ts'] }, findings: [], limitations: [] });
const review = (required: string[], missing: string[] = []) => ({ round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required, missing });

async function reviewerSession(t: Parameters<typeof provider>[0] & { after(fn: () => Promise<void>): void }, role: 'standards' | 'spec') {
  guestReads.length = 0;
  const f = await nativeOwner(reviewer(role), vm, { imageSourceMaxBytes: 1048576 });
  t.after(() => f.close());
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  return { f, session: createWorkerSession({ profile: profile(directory), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) }) };
}

test('AC4/AC5: Spec reviewer gets ONLY native read (confined guest backend), reads beyond the hunks and preserves a complete durable opinion before returning', { timeout: 15000 }, async t => {
  const bodies = provider(t, [{ tools: [{ name: 'read', arguments: { path: index } }, { name: 'read', arguments: { path: '/artifacts/spec/v1/sources.json' } }] },
    { tools: [{ name: 'read', arguments: { path: 'checkout/src/a.ts' } }] }, { text: verdict(clean('spec')) }]);
  const { f, session } = await reviewerSession(t, 'spec');
  const required = [index, '/artifacts/spec/v1/sources.json'];
  const result = await session.activate({ context: reviewer('spec'), prompt: 'Review round 1.', signal: f.authority.signal, review: review(required) });
  assert.deepEqual(bodies.map(body => body.tools), [['read'], ['read'], ['read']], 'no shell, write, search/listing or other tool is ever offered');
  assert.deepEqual(guestReads, [index, '/artifacts/spec/v1/sources.json', '/workspace/checkout/src/a.ts'], 'every read went through the confined guest program');
  assert.ok('opinion' in result && result.opinion);
  const opinion = result.opinion;
  assert.deepEqual([opinion.role, opinion.round, opinion.attempt, opinion.conclusion, opinion.code], ['spec', 1, 1, 'clean', null]);
  assert.deepEqual(opinion.model, { providerId: 'offline-fixture', modelId: 'reader' });
  assert.equal(opinion.profile.id, sdkProfile.id);
  assert.deepEqual(opinion.input, { handoffIndexSha256: 'e'.repeat(64), required, missing: [] });
  assert.equal(opinion.coverage!.scope, 'broad');
  assert.deepEqual(opinion.hostChecks, { reads: 3, failedReads: [], requiredNotFullyRead: [], downgraded: [] });
  assert.equal(opinion.session.file, result.sessionFile);
  const { sessionToolCalls } = await import('../entrypoints/review12-qualification.js');
  assert.deepEqual(sessionToolCalls(await readFile(result.sessionFile!, 'utf8')), [{ name: 'read', path: index }, { name: 'read', path: '/artifacts/spec/v1/sources.json' },
    { name: 'read', path: 'checkout/src/a.ts' }], 'the recipe inspection parses the native session format');
  // Durable BEFORE the result reached any notifier: the protected record exists and is complete.
  const evidence = join(f.root, 'records', 'work-12', 'evidence', opinion.reference.id);
  await readFile(join(evidence, 'complete.json'));
  const stored = JSON.parse(await readFile(join(evidence, 'output'), 'utf8'));
  assert.deepEqual([stored.event.kind, stored.event.conclusion, stored.context.callId, stored.context.role], ['review-opinion', 'clean', 'review-opinion', 'spec']);
});

test('AC6: unreadable source, unread required input and missing context prevent a clean conclusion; Standards keeps heuristic distinct from rule', { timeout: 15000 }, async t => {
  provider(t, [{ tools: [{ name: 'read', arguments: { path: '/workspace/checkout/missing.ts' } }] },
    { text: verdict({ ...clean('standards'), conclusion: 'findings', findings: [
      { id: 'S1', basis: 'rule', reference: '/artifacts/instructions/v1/AGENTS.md#naming', location: { path: '/workspace/checkout/src/a.ts', line: 1 }, summary: 'Documented naming rule violated.' },
      { id: 'S2', basis: 'heuristic', reference: 'Mysterious Name', location: { path: '/workspace/checkout/src/a.ts' }, summary: 'Judgement call only.' }] }) }]);
  const { f, session } = await reviewerSession(t, 'standards');
  const result = await session.activate({ context: reviewer('standards'), prompt: 'Review round 1.', signal: f.authority.signal,
    review: review([index, '/artifacts/instructions/v1/sources.json'], ['spec-version']) });
  assert.ok('opinion' in result && result.opinion);
  assert.equal(result.opinion.conclusion, 'incomplete');
  assert.deepEqual(result.opinion.hostChecks.downgraded, ['SOURCE_UNREADABLE', 'REQUIRED_INPUT_NOT_FULLY_READ', 'CONTEXT_INSUFFICIENT']);
  assert.deepEqual(result.opinion.hostChecks.failedReads, [{ path: '/workspace/checkout/missing.ts', code: 'GUEST_READ_FAILED' }]);
  assert.deepEqual(result.opinion.hostChecks.requiredNotFullyRead, [index, '/artifacts/instructions/v1/sources.json']);
  assert.deepEqual(result.opinion.findings.map(item => [item.id, item.basis]), [['S1', 'rule'], ['S2', 'heuristic']], 'findings kept by rule/location even when incomplete');
});

test('AC5/AC6: a missing or invalid verdict is a durable failure, never zero findings; Spec cannot use rule/heuristic basis', { timeout: 15000 }, async t => {
  const steps: Step[] = [{ text: 'I looked around and everything seems fine.' },
    { text: verdict({ ...clean('spec'), conclusion: 'findings', findings: [{ id: 'X', basis: 'heuristic', reference: 'x', location: { path: '/workspace/checkout/src/a.ts' }, summary: 's' }] }) }];
  provider(t, steps);
  for (const expected of ['REVIEW_VERDICT_INVALID', 'REVIEW_VERDICT_BASIS_INVALID']) {
    const { f, session } = await reviewerSession(t, 'spec');
    const result = await session.activate({ context: reviewer('spec'), prompt: 'Review round 1.', signal: f.authority.signal, review: review([]) });
    assert.ok('opinion' in result && result.opinion);
    assert.deepEqual([result.opinion.conclusion, result.opinion.code, result.opinion.findings], ['failure', expected, []]);
    await readFile(join(f.root, 'records', 'work-12', 'evidence', result.opinion.reference.id, 'complete.json'));
  }
});

test('AC3: the Builder handoff suspends every Builder tool and turn until the Host delivers the results to the SAME session', { timeout: 15000 }, async t => {
  const commands: string[] = [];
  const summary: ProposalHandoff = { version: 1, round: 1, index, indexSha256: 'e'.repeat(64), head: 'b'.repeat(40), branch: 'factory/3-abcdef12', base: 'a'.repeat(40), mergeBase: 'a'.repeat(40),
    counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
    patches: { committed: { path: '/artifacts/review/r1/committed.patch', bytes: 1, sha256: 'c'.repeat(64) }, staged: { path: '/artifacts/review/r1/staged.patch', bytes: 0, sha256: 'd'.repeat(64) },
      unstaged: { path: '/artifacts/review/r1/unstaged.patch', bytes: 0, sha256: 'd'.repeat(64) } },
    spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: 'f'.repeat(64) }, instructions: null, changed: ['/workspace/checkout/src/a.ts'], changedTruncated: false };
  const f = await nativeOwner(builder, { exec(argv) {
    commands.push(argv[argv.length - 1]!);
    const capture = argv[argv.length - 1]!.startsWith(`exec /usr/bin/python3 -I -S - /workspace/checkout /artifacts 1 ${'a'.repeat(40)} `);
    return { async *output() { if (capture) yield { stream: 'stdout' as const, data: Buffer.from(JSON.stringify(summary)) }; }, result: Promise.resolve({ exitCode: capture ? 0 : 1 }) };
  } });
  t.after(() => f.close());
  const bodies = provider(t, [{ tools: [{ name: 'handoff', arguments: {} }, { name: 'bash', arguments: { command: 'touch /workspace/checkout/late' } }] },
    { tools: [{ name: 'handoff', arguments: {} }] }, { tools: [{ name: 'handoff', arguments: {} }] }, { text: 'Addressed the findings; done.' }]);
  const directory = join(f.root, 'profile'); await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const events: unknown[] = [];
  const session = createWorkerSession({ profile: profile(directory), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }),
    async onHandoff(event) {
      events.push(event);
      // While suspended: no further provider turn and no model command reached the guest.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(bodies.length, 2, 'no provider request while suspended');
      assert.equal(commands.length, 2, 'the model bash of the refused mixed batch, then only the Host capture');
      return { kind: 'review-results', round: 1, prompt: 'FACTORY REVIEW RESULTS round 1: standards clean, spec findings S1.' };
    } });
  const result = await session.activate({ context: builder, prompt: 'Implement.', signal: f.authority.signal, handoff: { baseCommit: 'a'.repeat(40) } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [{ round: 1, status: 'captured', summary }]);
  assert.deepEqual(bodies[0]!.tools, ['bash', 'handoff', 'write']);
  assert.match(bodies[1]!.text, /HANDOFF_MUST_BE_ALONE/, 'review fix 7: handoff in a mixed batch is refused, not accepted');
  assert.match(bodies[2]!.text, /FACTORY REVIEW RESULTS round 1/, 'results continue the same preserved session');
  assert.match(bodies[3]!.text, /Only one review round is available/);
  assert.equal(commands.length, 2);
  const transcript = await readFile(result.sessionFile!, 'utf8');
  assert.match(transcript, /Handoff accepted for review round 1/);
});

test('ticket 13 real-run regression: reading a DIRECTORY is a distinct READ_IS_DIRECTORY result, not a failed source read; the opinion stays clean', { timeout: 15000 }, async t => {
  const bodies = provider(t, [{ tools: [{ name: 'read', arguments: { path: '/artifacts/spec/v1' } }] },
    { tools: [{ name: 'read', arguments: { path: index } }, { name: 'read', arguments: { path: '/artifacts/spec/v1/sources.json' } }] }, { text: verdict(clean('standards')) }]);
  const { f, session } = await reviewerSession(t, 'standards');
  const result = await session.activate({ context: reviewer('standards'), prompt: 'Review round 1.', signal: f.authority.signal,
    review: review([index, '/artifacts/spec/v1/sources.json']) });
  assert.match(bodies[1]!.text, /READ_IS_DIRECTORY: [^"]*is a directory/, 'the model is told it read a directory and what to do instead');
  assert.ok('opinion' in result && result.opinion);
  assert.equal(result.opinion.conclusion, 'clean');
  assert.deepEqual(result.opinion.hostChecks, { reads: 3, failedReads: [], requiredNotFullyRead: [], downgraded: [] });
});

test('ticket 14 real-run regression: a NONEXISTENT path the instructions name (GLOSSARY.md) is READ_NOT_FOUND, not a failed read; the opinion stays clean', { timeout: 15000 }, async t => {
  const bodies = provider(t, [{ tools: [{ name: 'read', arguments: { path: '/workspace/checkout/GLOSSARY.md' } }, { name: 'read', arguments: { path: '/workspace/checkout/docs/adr' } }] },
    { tools: [{ name: 'read', arguments: { path: index } }, { name: 'read', arguments: { path: '/artifacts/spec/v1/sources.json' } }] }, { text: verdict(clean('standards')) }]);
  const { f, session } = await reviewerSession(t, 'standards');
  const result = await session.activate({ context: reviewer('standards'), prompt: 'Review round 1.', signal: f.authority.signal,
    review: review([index, '/artifacts/spec/v1/sources.json']) });
  assert.match(bodies[1]!.text, /READ_NOT_FOUND: [^"]*does not exist/, 'the model is told the path does not exist');
  assert.ok('opinion' in result && result.opinion);
  assert.equal(result.opinion.conclusion, 'clean');
  assert.deepEqual(result.opinion.hostChecks, { reads: 4, failedReads: [], requiredNotFullyRead: [], downgraded: [] });
});

test('ticket 14: an ABSENT required input still makes the opinion incomplete (absence is only harmless for optional context)', async () => {
  const { createReadObserver } = await import('../../src/workers/review.js');
  const { notFoundMessage } = await import('../../src/workers/read.js');
  const observer = createReadObserver();
  observer.observe({ path: '/workspace/checkout/GLOSSARY.md' }, { error: new Error(notFoundMessage) });
  observer.observe({ path: index }, { error: new Error(notFoundMessage) });
  assert.deepEqual(observer.summary([index]), { reads: 2, failedReads: [], requiredNotFullyRead: [index] });
});

test('review fix 10: a read surfaced as an isError result is a failed read, never a full read', async () => {
  const { createReadObserver } = await import('../../src/workers/review.js');
  const observer = createReadObserver();
  observer.observe({ path: index }, { details: undefined, isError: true });
  assert.deepEqual(observer.summary([index]), { reads: 1, failedReads: [{ path: index, code: 'READ_FAILED' }], requiredNotFullyRead: [index] });
});

test('review fix 8: the returned opinion is the REDACTED protected record, never the raw composed text', { timeout: 15000 }, async t => {
  provider(t, [{ tools: [{ name: 'read', arguments: { path: index } }] },
    { text: verdict({ ...clean('spec'), conclusion: 'findings', findings: [{ id: 'X', basis: 'requirement', reference: 'r', location: { path: '/workspace/checkout/src/a.ts' }, summary: 'leaks synthetic-secret here' }] }) }]);
  const { f, session } = await reviewerSession(t, 'spec');
  const result = await session.activate({ context: reviewer('spec'), prompt: 'Review round 1.', signal: f.authority.signal, review: review([index]) });
  assert.ok('opinion' in result && result.opinion);
  assert.doesNotMatch(JSON.stringify(result.opinion), /synthetic-secret/);
  assert.match(result.opinion.findings[0]!.summary, /█/);
});
