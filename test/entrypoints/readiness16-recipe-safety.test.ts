import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { markReadyOnly, readinessGuardScript, settledWork } from './readiness16-qualification.js';
import { draftMutations } from '../../src/platform/github/index.js';
import type { CodeRepository } from '../../src/code-repository/index.js';
import type { WorkView } from '../../src/control/index.js';

// Recipe safety on temporary fixtures only (never the real root, never a real gh).
const run = (file: string, args: string[], input?: string) => new Promise<{ code: number; stdout: string }>(resolve => {
  const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout) => resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout }));
  child.stdin?.end(input);
});
const node = 'PR_kwDOSuqsXs8AAAABPTSKww';
const mutation = (document: string, id = node) => JSON.stringify({ query: document, variables: { id, cid: '5f0c0e2e-0000-4000-8000-000000000016' } });

test('AC7 guard: GET forwarded; the exact mark-ready of PR #5 only once and only when armed; one revocation after it; anything else refused without running gh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q16-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl'), trace = join(dir, 'trace.jsonl');
  const fake = join(dir, 'gh');
  await writeFile(fake, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst piped = process.argv.includes('--input');\n` +
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), body: piped ? readFileSync(0, 'utf8') : null }) + '\\n');\nprocess.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n{}');\n`, { mode: 0o700 });
  const guard = join(dir, 'guard.mjs');
  await writeFile(guard, readinessGuardScript({ node: process.execPath, gh: fake, trace, directory: dir, nodeId: node, document: draftMutations.markPullRequestReadyForReview }), { mode: 0o700 });
  const post = ['api', '--method', 'POST', '--input', '-', '--', 'graphql'];
  assert.equal((await run(guard, ['api', '--method', 'GET', '--', '/repos/a/b/pulls/5'])).code, 0);
  assert.equal((await run(guard, post, mutation(draftMutations.markPullRequestReadyForReview))).code, 97, 'not armed (preflight/inspect)');
  assert.equal((await run(guard, ['api', '--method', 'DELETE', '--', '/installation/token'])).code, 97, 'no revocation before a mutation');
  await writeFile(join(dir, 'convert-armed'), '');
  for (const body of [mutation(draftMutations.convertPullRequestToDraft), mutation(draftMutations.markPullRequestReadyForReview, 'PR_other'),
    mutation(draftMutations.markPullRequestReadyForReview.replace('isDraft', 'isDraft merged')), 'not json']) {
    assert.equal((await run(guard, post, body)).code, 97, body.slice(0, 60));
  }
  assert.equal((await run(guard, post, mutation(draftMutations.markPullRequestReadyForReview))).code, 0, 'the one exact mutation');
  assert.equal((await run(guard, post, mutation(draftMutations.markPullRequestReadyForReview))).code, 97, 'never a second one');
  assert.equal((await run(guard, ['api', '--method', 'DELETE', '--', '/installation/token'])).code, 0);
  assert.equal((await run(guard, ['api', '--method', 'DELETE', '--', '/installation/token'])).code, 97);
  for (const args of [['api', '--method', 'POST', '--input', '-', '--', '/repos/a/b/issues/3/comments'], ['api', '--method', 'PUT', '--', '/repos/a/b/pulls/5/merge'],
    ['api', '--method', 'POST', '--input', '-', '--', '/repos/a/b/pulls/5/reviews'], ['api', '--', '/repos/a/b']]) assert.equal((await run(guard, args, '{}')).code, 97, args.join(' '));
  const forwarded = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; body: string | null });
  assert.deepEqual(forwarded.map(item => item.args.at(-1)), ['/repos/a/b/pulls/5', 'graphql', '/installation/token'], 'only GET, the mutation and its revocation reached gh');
  assert.equal(forwarded[1]!.body, mutation(draftMutations.markPullRequestReadyForReview), 'the body is forwarded unchanged');
  const traced = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; allowed: boolean });
  assert.equal(traced.length, 15, 'every request is traced');
  assert.deepEqual(traced.filter(item => item.allowed).map(item => item.kind), ['read', 'mark-ready', 'revocation']);
});

test('AC7 wrapper: setDraft only as mark-ready of PR #5 once; the copied Work must be settled with no readiness yet', async () => {
  const sent: unknown[] = [];
  const delegate = { setDraft: async (...args: unknown[]) => { sent.push(args); return { kind: 'applied', observedAt: 'x', draft: false, headSha: 'b'.repeat(40), revocation: 'revoked' }; } } as unknown as CodeRepository;
  let claimed = false;
  const events: Record<string, unknown>[] = [];
  const wrapped = markReadyOnly(delegate, entry => events.push(entry), async () => { const first = !claimed; claimed = true; return first; });
  const repo = { repository: 'a/b', installationId: 1, workflows: false };
  const effect = { effectId: '5f0c0e2e-0000-4000-8000-000000000016' };
  assert.equal((await wrapped.setDraft({ repo, number: 5, nodeId: node }, true, effect)).kind, 'known-failure', 'never to draft');
  assert.equal((await wrapped.setDraft({ repo, number: 6, nodeId: node }, false, effect)).kind, 'known-failure');
  assert.equal((await wrapped.setDraft({ repo, number: 5, nodeId: node }, false, effect)).kind, 'applied');
  assert.equal((await wrapped.setDraft({ repo, number: 5, nodeId: node }, false, effect)).kind, 'known-failure', 'once');
  assert.equal(sent.length, 1);
  const work = (extra: Record<string, unknown>) => ({ execution: { state: 'ended', slot: { held: false }, end: { cessation: 'confirmed' } }, queue: { pending: false }, ...extra }) as unknown as WorkView;
  assert.deepEqual(settledWork(work({})), { ok: true });
  assert.deepEqual(settledWork(work({ execution: { state: 'ended', slot: { held: false }, end: { cessation: 'unconfirmed' } } })), { ok: false, reason: 'EXECUTION_NOT_SETTLED' });
  assert.deepEqual(settledWork(work({ readiness: {} })), { ok: false, reason: 'READINESS_ALREADY_RECORDED' });
});
