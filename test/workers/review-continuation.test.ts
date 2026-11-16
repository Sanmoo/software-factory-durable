import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';
import { createWorkerSession } from '../../src/workers/worker-session.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';
import { prepareReviewerContinuation, workerLaunchSchema } from '../../src/platform/host/index.js';
import { remainingMs } from '../runner/budget.js';

// I-local: native Pi SDK sessions (JSONL v3) and the owner launcher's continuation copy; doubled ONLY the provider HTTP boundary and the
// VM exec. Ticket 13 AC4: a later round prefers the compatible session of the same reviewer role; otherwise a replacement is recorded.
const reviewer = (round: number): ToolContext => ({ workId: 'work-13', executionId: 'execution-13', invocationId: `spec-execution-13-r${round}a1`,
  role: 'spec', environmentRef: 'environment-13', bootRef: 'boot-13', phaseId: `review-r${round}` });
const files: Record<string, string> = { '/artifacts/review/r1/index.json': '{"entries":[]}', '/artifacts/review/r2/index.json': '{"entries":[]}' };
const profile = (directory: string) => ({ id: sdkProfile.id, directory, systemPrompt: 'Factory reviewer fixture.', providerId: 'offline-fixture', modelId: 'reader',
  apiKey: 'synthetic-key', provider: { api: 'openai-completions' as const, baseUrl: 'https://offline.invalid',
    models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } });
const verdict = '{"role":"spec","conclusion":"clean","coverage":{"scope":"broad","justification":"Whole proposal.","examined":["/artifacts/review/r1/index.json"]},"findings":[],"limitations":[]}';
function provider(t: { mock: { method: typeof import('node:test').mock.method } }, steps: { tools?: object[]; text?: string }[]) {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push(input instanceof Request ? await input.text() : String(init?.body));
    const step = steps[bodies.length - 1]!;
    const choices = step.tools ? [{ index: 0, delta: { role: 'assistant', tool_calls: step.tools }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'tool_calls' }]
      : [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }];
    return new Response(choices.map(choice => 'data: ' + JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: 'reader', choices: [choice] }) + '\n\n').join('') +
      'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return bodies;
}
const read = (path: string) => ({ index: 0, id: `call-${path.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) } });
const review = (round: number, extra: object = {}) => ({ round, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [`/artifacts/review/r${round}/index.json`], missing: [], ...extra });

async function runtime(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'review13-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const worker = async (suffix: string) => {
    const directory = join(root, `w-${suffix}`, 'profile');
    await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
    await chmod(join(root, `w-${suffix}`), 0o700);
    return directory;
  };
  return { root, worker };
}

test('AC4: round 2 of the same reviewer continues its round 1 session (owner copy in the same boot); the opinion records the continuation', { timeout: remainingMs() }, async t => {
  const bodies = provider(t, [{ tools: [read('/artifacts/review/r1/index.json')] }, { text: verdict }, { tools: [read('/artifacts/review/r2/index.json')] }, { text: verdict }]);
  const f = await nativeOwner(reviewer(1), { exec(argv) {
    const content = files[argv[5]!];
    return { async *output() { if (content) yield { stream: 'stdout' as const, data: Buffer.from(content) }; }, result: Promise.resolve({ exitCode: content ? 0 : 1 }) };
  } });
  t.after(() => f.close());
  const r = await runtime(t);
  const first = await r.worker('aaaaaa');
  const one = await createWorkerSession({ profile: profile(first), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) })
    .activate({ context: reviewer(1), prompt: 'Review round 1 (FIRST-ROUND-MARKER).', signal: f.authority.signal, review: review(1) });
  assert.ok('opinion' in one && one.opinion);
  assert.deepEqual([one.opinion.session.mode, one.opinion.session.from], ['new', null]);
  const second = await r.worker('bbbbbb');
  const session = await prepareReviewerContinuation(r.root, second, one.sessionFile!);
  assert.equal(session.mode, 'continued');
  assert.ok(session.mode === 'continued' && session.file.startsWith(join(second, 'sessions')));
  const before = await readFile(one.sessionFile!, 'utf8');
  const f2 = await nativeOwner(reviewer(2), { exec(argv) {
    const content = files[argv[5]!];
    return { async *output() { if (content) yield { stream: 'stdout' as const, data: Buffer.from(content) }; }, result: Promise.resolve({ exitCode: content ? 0 : 1 }) };
  } });
  t.after(() => f2.close());
  const two = await createWorkerSession({ profile: profile(second), records: f2.records, sandbox: createSandbox({ root: f2.root, toolEndpoint: f2.owner.endpoint }) })
    .activate({ context: reviewer(2), prompt: 'Review round 2: the proposal changed.', signal: f2.authority.signal, review: review(2, { session }) });
  assert.ok('opinion' in two && two.opinion);
  assert.match(bodies[2]!, /FIRST-ROUND-MARKER/, 'the round 2 request carries the round 1 conversation: the session was continued');
  assert.match(bodies[2]!, /Review round 2: the proposal changed/);
  assert.deepEqual([two.opinion.session.mode, two.opinion.session.from, two.opinion.session.file], ['continued', one.sessionFile, two.sessionFile]);
  assert.equal(two.opinion.round, 2, 'a NEW opinion of round 2; the round 1 opinion is never reused');
  assert.equal(await readFile(one.sessionFile!, 'utf8'), before, 'the earlier session file is never written again');
});

test('AC4: a session outside this boot, linked, missing or incompatible is replaced with a recorded reason, never reused silently', { timeout: remainingMs() }, async t => {
  const r = await runtime(t);
  const target = await r.worker('cccccc');
  const old = await r.worker('dddddd');
  await writeFile(join(old, 'sessions', 's.jsonl'), '{"type":"session"}\n', { mode: 0o600 });
  await symlink(join(old, 'sessions', 's.jsonl'), join(old, 'sessions', 'l.jsonl'));
  const outside = await mkdtemp(join(tmpdir(), 'review13-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  assert.deepEqual(await prepareReviewerContinuation(r.root, target, join(outside, 'w-eeeeee', 'profile', 'sessions', 's.jsonl')), { mode: 'replaced', from: join(outside, 'w-eeeeee', 'profile', 'sessions', 's.jsonl'), code: 'SESSION_NOT_IN_BOOT' });
  assert.equal((await prepareReviewerContinuation(r.root, target, join(old, 'sessions', 'l.jsonl'))).mode, 'replaced');
  assert.deepEqual(await prepareReviewerContinuation(r.root, target, join(old, 'sessions', 'gone.jsonl')), { mode: 'replaced', from: join(old, 'sessions', 'gone.jsonl'), code: 'SESSION_UNAVAILABLE' });
  assert.equal((await prepareReviewerContinuation(r.root, target, `${r.root}/w-dddddd/profile/../profile/sessions/s.jsonl`)).mode, 'replaced');
  // A launch request can name the previous session, but never supply the resolved one.
  const launch = { context: reviewer(2), prompt: 'x', knownSecrets: [], modelBudget: 'reviewer-v1', profile: { id: sdkProfile.id, systemPrompt: 's', auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses' } };
  assert.equal(workerLaunchSchema.safeParse({ ...launch, review: review(2, { continueFrom: join(old, 'sessions', 's.jsonl') }) }).success, true);
  assert.equal(workerLaunchSchema.safeParse({ ...launch, review: review(2, { session: { mode: 'continued', from: '/x', file: '/y' } }) }).success, false);
  // An incompatible file (not a /workspace session) opens as a replacement in the worker.
  const provided = provider(t, [{ text: verdict }]);
  const f = await nativeOwner(reviewer(2), { exec() { return { async *output() { /* nothing */ }, result: Promise.resolve({ exitCode: 1 }) }; } });
  t.after(() => f.close());
  const copy = join(target, 'sessions', 's.jsonl');
  await writeFile(copy, JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: new Date().toISOString(), cwd: '/elsewhere' }) + '\n', { mode: 0o600 });
  const result = await createWorkerSession({ profile: profile(target), records: f.records, sandbox: createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }) })
    .activate({ context: reviewer(2), prompt: 'Review round 2.', signal: f.authority.signal, review: review(2, { session: { mode: 'continued', from: '/old', file: copy } }) });
  assert.ok('opinion' in result && result.opinion);
  assert.deepEqual([result.opinion.session.mode, result.opinion.session.code], ['replaced', 'SESSION_INCOMPATIBLE']);
  assert.notEqual(result.sessionFile, copy);
  assert.equal(provided.length, 1);
});
