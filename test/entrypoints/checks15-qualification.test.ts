import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real-run recipe must be inert: no process, socket, filesystem or SDK effect.
let forbidden = 0;
const deny = () => {
  forbidden++;
  throw new Error('FORBIDDEN_EFFECT');
};
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, {
    namedExports: {
      connect: deny,
      createServer: deny,
      execFile: deny,
      execFileSync: deny,
      request: deny,
      open: deny,
      mkdir: deny,
      readFile: deny,
      access: deny,
      readdir: deny,
      copyFile: deny,
    },
    defaultExport: deny,
  });
}
const recipe = await import('./checks15-qualification.js');

test("AC7 recipe: import and --plan are inert and declare a read-only one-shot run against ticket 14's linked own PR", async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => {
    logged.push(text);
  });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q15-checks-v2');
  assert.match(plan.source, /q14-publication-v8\/control\.sqlite \(copied, never opened in place\)/);
  assert.deepEqual(plan.phases, ['preflight', 'evaluate', 'inspect']);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.deepEqual(plan.expectedPullRequest, { number: 5, headRef: 'factory/3-99fe871b', linkedHeadPrefix: 'bfdd439', base: 'main' });
  assert.equal(plan.model, 'none');
  assert.deepEqual(plan.github.writes, [
    'App: access_tokens issuance POSTs only (reduced read grants, cached per purpose; native HTTPS, not gh); no other non-GET request',
  ]);
  for (const never of ['GitHub write of any kind', 'merge', 'approval', 'ready-for-review conversion']) assert.ok(plan.github.never.includes(never), never);
  assert.ok(plan.requires.some((item: string) => /ticket 14 integrated/.test(item)));
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['evaluate', 'again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('AC7 recipe guards: only the linked own PR of Ticket #3 qualifies; the plan declares dispatch disabled, a read-only tracker and the GET-only gh guard', async () => {
  const work = (publication: unknown, extra: Record<string, unknown> = {}) => ({
    kind: 'list',
    works: [{ ticket: { number: 3, repositoryId: 1256893534 }, result: 'open', publication, ...extra }],
  });
  assert.deepEqual(recipe.linkedWork({ kind: 'list', works: [] }), { ok: false, reason: 'WORK_NOT_FOUND' });
  assert.deepEqual(recipe.linkedWork(work({ state: 'requested', pullRequest: null })), { ok: false, reason: 'OWN_PULL_REQUEST_NOT_LINKED' });
  assert.deepEqual(recipe.linkedWork(work({ state: 'published', pullRequest: { number: 4 } }, { result: 'delivered' })), {
    ok: false,
    reason: 'WORK_NOT_OPEN',
  });
  const linked = recipe.linkedWork(work({ state: 'published', pullRequest: { number: 4 } }));
  assert.deepEqual(linked.ok && linked.pullRequest, { number: 4, headRef: null });
  const plan = recipe.plan();
  assert.match(plan.dispatch, /no execution ports/);
  assert.match(plan.github.guard, /refuses \(exit 97, nothing sent\) any method other than GET/);
  assert.match(plan.github.guard, /read-only \(postComment refused locally\)/);
  assert.equal(forbidden, 0);
});
