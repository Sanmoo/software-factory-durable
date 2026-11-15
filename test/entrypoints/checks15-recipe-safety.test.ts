import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ghGuardScript, readOnlyTracker } from './checks15-qualification.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';

// Recipe safety on temporary fixtures only (never the real root, never a real gh): the GET-only guard and the read-only tracker.
const run = (file: string, args: string[]) => new Promise<{ code: number; stdout: string }>(resolve =>
  execFile(file, args, { encoding: 'utf8' }, (error, stdout) => resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout })));

test('review MED 1: the gh guard records every request, forwards an explicit GET and refuses any other method without running gh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q15-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl'), trace = join(dir, 'trace.jsonl');
  const fake = join(dir, 'gh');
  await writeFile(fake, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n{}');\n`, { mode: 0o700 });
  const guard = join(dir, 'guard.mjs');
  await writeFile(guard, ghGuardScript({ node: process.execPath, gh: fake, trace }), { mode: 0o700 });
  const get = await run(guard, ['api', '--method', 'GET', '--', '/repos/a/b/pulls/7']);
  assert.deepEqual([get.code, get.stdout], [0, 'HTTP/1.1 200 OK\r\n\r\n{}']);
  for (const args of [['api', '--method', 'POST', '--input', '-', '--', '/repos/a/b/issues/3/comments'], ['api', '--method', 'DELETE', '--', '/installation/token'],
    ['api', '--method', 'GET', '--input', '-', '--', '/repos/a/b'], ['api', '--', '/repos/a/b']]) {
    assert.equal((await run(guard, args)).code, 97, args.join(' '));
  }
  const forwarded = (await readFile(calls, 'utf8')).split('\n').filter(Boolean);
  assert.equal(forwarded.length, 1, 'only the GET reached gh');
  const traced = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string | null; allowed: boolean });
  assert.deepEqual(traced.map(item => [item.method, item.allowed]), [['GET', true], ['POST', false], ['DELETE', false], ['GET', false], [null, false]]);
});

test('review MED 1: the read-only tracker delegates reads and never forwards a comment', async () => {
  const calls: string[] = [];
  const delegate = new Proxy({}, { get: (_target, name) => async () => { calls.push(String(name)); return { kind: 'observed' }; } }) as IssueTracker;
  const events: Record<string, unknown>[] = [];
  const tracker = readOnlyTracker(delegate, entry => events.push(entry));
  await tracker.listCandidates({ repository: 'a/b', installationId: 1, workflows: false, label: 'x' });
  const posted = await tracker.postComment({ number: 3 } as never, {} as never, {} as never);
  assert.deepEqual([calls, posted.kind, posted.kind === 'failed' && posted.code, events], [['listCandidates'], 'failed', 'RECIPE_READ_ONLY', [{ call: 'post-comment', refused: true, ticket: 3 }]]);
});
