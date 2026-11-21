import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  answerCommand,
  answerIngested,
  bounds,
  deliverPrecondition,
  guardAccess,
  guardPorts,
  journeyGuardScript,
  journeyOutcome,
  keySource,
  ownInventory,
  phaseGuard,
  pinnedAnswer,
  pinnedText,
  pins,
  requireKeySource,
  ticketBody,
} from './journey18-qualification.js';
import { draftMutations } from '../../src/platform/github/index.js';
import type { AccessDependencies, ExecutionPorts, QuestionView, WorkView } from '../../src/control/index.js';

// Recipe safety on controlled data and temporary fixtures only (never the real root, never a real gh, VM or model).
const intents = (...names: string[]) => new Set(names.map(name => `${name}-intent`));
const ok = { status: 'success' };

test('phase guard: pinned issue first; each phase once, after the previous success; resume after question-published; ready after merge-blocked; deliver after ready', () => {
  assert.equal(phaseGuard('preflight', {}, intents(), null), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, intents(), 7), null);
  assert.equal(phaseGuard('preflight', {}, intents('preflight'), 7), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('run', { preflight: { status: 'held' } }, intents('preflight'), 7), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('run', { preflight: ok }, intents('preflight'), 7), null);
  assert.equal(phaseGuard('run', { preflight: ok }, intents('preflight', 'run'), 7), 'PHASE_ALREADY_RAN', 'no implicit retry');
  assert.equal(phaseGuard('resume', { preflight: ok, run: { outcome: 'held' } }, intents('preflight', 'run'), 7), 'QUESTION_PUBLISHED_RUN_REQUIRED');
  assert.equal(phaseGuard('resume', { preflight: ok, run: { outcome: 'question-published' } }, intents('preflight', 'run'), 7), null);
  assert.equal(
    phaseGuard('ready', { preflight: ok, run: { outcome: 'question-published' }, resume: { outcome: 'ready' } }, intents('preflight', 'run', 'resume'), 7),
    'MERGE_BLOCKED_RUN_REQUIRED',
  );
  assert.equal(
    phaseGuard(
      'ready',
      { preflight: ok, run: { outcome: 'question-published' }, resume: { outcome: 'merge-blocked' } },
      intents('preflight', 'run', 'resume'),
      7,
    ),
    null,
  );
  assert.equal(
    phaseGuard('deliver', { preflight: ok, resume: { outcome: 'merge-blocked' } }, intents('preflight', 'run', 'resume'), 7),
    'CONFIRMED_READY_REQUIRED',
    'no merge over a blocking rule',
  );
  assert.equal(
    phaseGuard(
      'deliver',
      { preflight: ok, resume: { outcome: 'merge-blocked' }, ready: { outcome: 'ready' } },
      intents('preflight', 'run', 'resume', 'ready'),
      7,
    ),
    null,
  );
  assert.equal(phaseGuard('deliver', { preflight: ok, run: { outcome: 'ready' } }, intents('preflight', 'run'), 7), null, 'a run without a question');
  assert.equal(phaseGuard('inspect', {}, intents(), 7), 'PREFLIGHT_REQUIRED');
  assert.equal(phaseGuard('inspect', { preflight: { status: 'held' } }, intents('preflight'), 7), null, 'inspect works after a held preflight');
  assert.equal(phaseGuard('inspect', { preflight: ok, run: null }, intents('preflight', 'run'), 7), null, 'and after a held run');
});

const work = (overrides: Record<string, unknown> = {}) =>
  ({
    result: 'open',
    impediments: [],
    execution: { state: 'ended', slot: { held: false }, end: { outcome: 'completed', cessation: 'confirmed' } },
    publication: { state: 'published' },
    readiness: null,
    ...overrides,
  }) as unknown as WorkView;
const asked = (overrides: Record<string, unknown> = {}) =>
  work({ execution: { state: 'ended', slot: { held: false }, end: { outcome: 'question', cessation: 'confirmed' } }, publication: null, ...overrides });
const question = (state: 'open' | 'answered', publication: string, questionId = 'q1') =>
  ({ questionId, state, publication: { state: publication } }) as unknown as QuestionView;

test('journey outcome: run stops at the published Question after cessation; resume settles at ready/merge-blocked/other explained stops', () => {
  assert.deepEqual(journeyOutcome('run', undefined, [], null), { settled: false });
  assert.deepEqual(journeyOutcome('run', asked(), [question('open', 'intended')], null), { settled: false }, 'not before the operator can see it');
  assert.deepEqual(
    journeyOutcome(
      'run',
      asked({ execution: { state: 'ended', slot: { held: true }, end: { outcome: 'question', cessation: 'confirmed' } } }),
      [question('open', 'published')],
      null,
    ),
    { settled: false },
    'Slot still held',
  );
  assert.deepEqual(
    journeyOutcome(
      'run',
      asked({ execution: { state: 'ended', slot: { held: false }, end: { outcome: 'question', cessation: 'unconfirmed' } } }),
      [question('open', 'published')],
      null,
    ),
    { settled: false },
    'cessation not confirmed',
  );
  assert.deepEqual(journeyOutcome('run', asked(), [question('open', 'published')], null), { settled: true, outcome: 'question-published' });
  assert.deepEqual(journeyOutcome('resume', asked(), [question('answered', 'published')], 'q1'), { settled: false }, 'the answered Question is not a stop');
  assert.deepEqual(
    journeyOutcome('resume', asked(), [question('answered', 'published'), question('open', 'published', 'q2')], 'q1'),
    { settled: true, outcome: 'question-unanswered' },
    'a second question is never answered by the recipe',
  );
  assert.deepEqual(
    journeyOutcome('resume', work({ readiness: { effects: [{ action: 'mark-ready', state: 'confirmed' }], latest: { reasons: [] } } }), [], 'q1'),
    { settled: true, outcome: 'ready' },
  );
  assert.deepEqual(
    journeyOutcome('resume', work({ readiness: { effects: [{ action: 'mark-ready', state: 'intended' }], latest: { reasons: [] } } }), [], 'q1'),
    { settled: false },
  );
  assert.deepEqual(
    journeyOutcome(
      'resume',
      work({ readiness: { effects: [], latest: { reasons: [{ area: 'merge', certainty: 'confirmed', code: 'MERGE_BLOCKED_UPDATE_RESTRICTED' }] } } }),
      [],
      'q1',
    ),
    { settled: true, outcome: 'merge-blocked' },
  );
  assert.deepEqual(
    journeyOutcome(
      'resume',
      work({ readiness: { effects: [], latest: { reasons: [{ area: 'merge', certainty: 'indeterminate', code: 'MERGE_BLOCKED_X' }] } } }),
      [],
      'q1',
    ),
    { settled: false },
  );
  assert.deepEqual(journeyOutcome('resume', work({ impediments: [{ code: 'GUEST_EFFECT_OUT_OF_SCOPE' }], publication: { state: 'blocked' } }), [], 'q1'), {
    settled: true,
    outcome: 'guest-effect-out-of-scope',
  });
  assert.deepEqual(journeyOutcome('resume', work({ execution: { state: 'held', slot: { held: true } } }), [], 'q1'), { settled: true, outcome: 'held' });
  assert.deepEqual(journeyOutcome('resume', work({ publication: { state: 'not-publishable' } }), [], 'q1'), { settled: true, outcome: 'not-publishable' });
  assert.deepEqual(journeyOutcome('resume', work({ publication: { state: 'blocked' } }), [], 'q1'), { settled: true, outcome: 'publication-blocked' });
  assert.deepEqual(journeyOutcome('resume', work({ result: 'delivered' }), [], 'q1'), { settled: true, outcome: 'unexpected' });
});

test('answer: the exact /factory answer command is recorded; only a REAL comment of the pinned operator counts as ingested (never a local answer)', () => {
  assert.deepEqual(answerCommand(7, 'q1'), {
    body: `/factory answer q1 ${pinnedAnswer}`,
    command: `gh issue comment 7 --repo Sanmoo/java-springboot-event-sourcing --body ${JSON.stringify(`/factory answer q1 ${pinnedAnswer}`)}`,
    account: "the operator's own gh account (Sanmoo, pinned operator id from preflight-result.operator)",
  });
  const answered = (author: unknown, origin: unknown) => [{ questionId: 'q1', state: 'answered', answer: { author, origin } }] as unknown as QuestionView[];
  assert.equal(answerIngested([{ questionId: 'q1', state: 'open', answer: null }] as unknown as QuestionView[], 'q1', 42), 'waiting');
  assert.equal(answerIngested(answered({ kind: 'github', id: 42, login: 'Sanmoo' }, { kind: 'github-comment', commentId: 1, url: 'u' }), 'q1', 42), 'ingested');
  assert.equal(answerIngested(answered({ kind: 'local-administrator' }, { kind: 'local-cli', request_id: 'r' }), 'q1', 42), 'not-the-real-comment');
  assert.equal(
    answerIngested(answered({ kind: 'github', id: 7, login: 'other' }, { kind: 'github-comment', commentId: 1, url: 'u' }), 'q1', 42),
    'not-the-real-comment',
  );
});

test("own inventory: only environments of THIS storage's Works; unattributed environments, unknown entries and caches in preparation hold", () => {
  const listing = {
    environments: [
      { environment: 'env-own', workId: 'w1' },
      { environment: 'env-other', workId: 'w9' },
    ],
    cache: [{ repositoryId: 1, state: 'idle' as const }],
    unknown: [] as string[],
  };
  const own = ownInventory(listing, new Set(['w1']));
  assert.deepEqual([own.inventory.environments, own.excluded, own.holds], [[{ environment: 'env-own', workId: 'w1' }], ['env-other'], []]);
  assert.deepEqual(
    ownInventory({ environments: [{ environment: 'env-x', workId: null }], unknown: ['stray'], cache: [{ repositoryId: 1, state: 'preparing' }] }, new Set())
      .holds,
    ['UNKNOWN_RESOURCE:stray', 'ENVIRONMENT_UNATTRIBUTED:env-x', 'CACHE_NOT_IDLE:1'],
    'never silently excluded',
  );
});

test('deliver precondition: own PR merged by a HUMAN, at the linked head, into main; else held before anything', () => {
  const facts = { merged: true, state: 'closed', headSha: 'a'.repeat(40), baseRef: 'main' };
  const linked = { number: 9, headSha: 'a'.repeat(40) };
  const human = { login: 'Sanmoo', type: 'User' };
  assert.equal(deliverPrecondition(linked, facts, human), null);
  assert.equal(deliverPrecondition(null, facts, human), 'OWN_PULL_REQUEST_NOT_LINKED');
  assert.equal(deliverPrecondition(linked, null, human), 'OWN_PULL_REQUEST_UNREADABLE');
  assert.equal(deliverPrecondition(linked, { ...facts, merged: false, state: 'open' }, human), 'NOT_MERGED');
  assert.equal(deliverPrecondition(linked, { ...facts, merged: false }, human), 'NOT_MERGED', 'closed without merge is not delivery');
  assert.equal(deliverPrecondition(linked, { ...facts, headSha: 'b'.repeat(40) }, human), 'HEAD_NOT_LINKED_HEAD');
  assert.equal(deliverPrecondition(linked, { ...facts, baseRef: 'dev' }, human), 'BASE_MISMATCH');
  assert.equal(deliverPrecondition(linked, facts, null), 'MERGER_UNKNOWN');
  assert.equal(deliverPrecondition(linked, facts, { login: 'sanmoo-factory[bot]', type: 'Bot' }), 'NOT_MERGED_BY_A_HUMAN', 'the agent never merges');
});

test('pinned text: exactly the pinned title/body (CRLF tolerated), hashes only', () => {
  const title = 'Factory journey: document the integrated delivery';
  assert.equal(pinnedText({ title, body: ticketBody.replace(/\n/g, '\r\n') }).matches, true);
  assert.equal(pinnedText({ title, body: `${ticketBody}\nmore` }).matches, false);
  assert.equal(pinnedText({ title: 'other', body: ticketBody }).matches, false);
  assert.match(pinnedText({ title, body: ticketBody }).bodySha256!, /^[0-9a-f]{64}$/);
});

const run = (file: string, args: string[], input?: string) =>
  new Promise<number>(resolve => {
    const child = execFile(file, args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GH_TOKEN: 'journey-token-A' } }, error =>
      resolve(error && typeof error.code === 'number' ? error.code : 0),
    );
    child.stdin?.end(input);
  });
const refDeletion = (name: string, beforeOid = 'a'.repeat(40), repositoryId = 'R_own') =>
  JSON.stringify({
    query:
      'mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }',
    variables: { repositoryId, refUpdates: [{ name, beforeOid, afterOid: '0'.repeat(40), force: false }] },
  });

test('gh guard: GET; the App token issuance for this installation/repository; comments on the pinned issue; draft mutations only on the pinned own PR node; ONE pinned atomic deletion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'q18-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl'),
    trace = join(dir, 'trace.jsonl'),
    fake = join(dir, 'gh');
  await writeFile(
    fake,
    `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst piped = process.argv.includes('--input');\n` +
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), body: piped ? readFileSync(0, 'utf8') : null }) + '\\n');\nprocess.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n{}');\n`,
    { mode: 0o700 },
  );
  const guard = join(dir, 'guard.mjs');
  await writeFile(
    guard,
    journeyGuardScript({
      node: process.execPath,
      gh: fake,
      trace,
      directory: dir,
      repository: 'o/r',
      installationId: 177,
      issue: 7,
      documents: [draftMutations.markPullRequestReadyForReview, draftMutations.convertPullRequestToDraft],
      maxComments: 2,
      maxDraftMutations: 2,
    }),
    { mode: 0o700 },
  );
  const post = (endpoint: string) => ['api', '--method', 'POST', '--input', '-', '--', endpoint];
  const issuance = (repositories: string[]) => JSON.stringify({ repositories, permissions: { metadata: 'read' } });
  const comment = JSON.stringify({ body: '<!-- software-factory:question:x -->\nQ' });
  const draft = (document: string, id = 'PR_own') => JSON.stringify({ query: document, variables: { id, cid: 'c' } });
  const expect = async (args: string[], input: string | undefined, code: number, label: string) => assert.equal(await run(guard, args, input), code, label);
  await expect(['api', '--method', 'GET', '--', '/repos/o/r/pulls/9'], undefined, 0, 'GET');
  // The App's installation token issuance (as the fixture trace shows it going through gh): only this installation and repository.
  await expect(post('/app/installations/177/access_tokens'), issuance(['r']), 0, 'token issuance');
  await expect(post('/app/installations/178/access_tokens'), issuance(['r']), 97, 'another installation');
  await expect(post('/app/installations/177/access_tokens'), issuance(['other']), 97, 'another repository');
  await expect(post('/app/installations/177/access_tokens'), issuance(['r', 'other']), 97, 'several repositories');
  await expect(post('/repos/o/r/issues/8/comments'), comment, 97, 'another issue');
  await expect(post('/repos/o/r/issues/7/comments'), comment, 0, 'comment 1');
  await expect(post('/repos/o/r/issues/7/comments'), comment, 0, 'comment 2');
  await expect(post('/repos/o/r/issues/7/comments'), comment, 97, 'comments bounded');
  await expect(post('graphql'), draft(draftMutations.markPullRequestReadyForReview), 97, 'no own PR pinned yet');
  await writeFile(join(dir, pins.ownPullRequest), JSON.stringify({ number: 9, nodeId: 'PR_own', headSha: 'a'.repeat(40) }));
  await expect(post('graphql'), draft(draftMutations.markPullRequestReadyForReview, 'PR_other'), 97, 'another PR node');
  await expect(post('graphql'), draft(draftMutations.markPullRequestReadyForReview.replace('isDraft', 'isDraft merged')), 97, 'another document');
  await expect(post('graphql'), draft(draftMutations.markPullRequestReadyForReview), 0, 'mark-ready of the own PR');
  await expect(post('graphql'), draft(draftMutations.convertPullRequestToDraft), 0, 'back to draft of the own PR');
  await expect(post('graphql'), draft(draftMutations.markPullRequestReadyForReview), 97, 'draft mutations bounded');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-abcdef12'), 97, 'not armed outside deliver');
  await writeFile(join(dir, pins.cleanup), JSON.stringify({ repositoryNodeId: 'R_own', ref: 'refs/heads/factory/7-abcdef12', beforeOid: 'a'.repeat(40) }));
  await expect(post('/graphql'), refDeletion('refs/heads/main'), 97, 'never the base');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-zzzzzzzz'), 97, 'another branch');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-abcdef12', 'b'.repeat(40)), 97, 'not at the merged linked head');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-abcdef12', 'a'.repeat(40), 'R_other'), 97, 'another repository node');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-abcdef12'), 0, 'the pinned deletion');
  await expect(post('/graphql'), refDeletion('refs/heads/factory/7-abcdef12'), 97, 'once');
  await expect(['api', '--method', 'DELETE', '--', '/installation/token'], undefined, 0, 'self-revocation');
  for (const args of [
    ['api', '--method', 'PUT', '--input', '-', '--', '/repos/o/r/pulls/9/merge'],
    post('/repos/o/r/pulls/9/reviews'),
    post('/repos/o/r/git/refs'),
    ['api', '--method', 'PATCH', '--input', '-', '--', '/repos/o/r/rulesets/1'],
    ['api', '--method', 'DELETE', '--', '/repos/o/r/git/refs/heads/factory/7-x'],
    ['api', '--', '/repos/o/r'],
  ]) {
    await expect(args, '{}', 97, args.join(' '));
  }
  const forwarded = (await readFile(calls, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { args: string[] }).args.at(-1));
  assert.deepEqual(forwarded, [
    '/repos/o/r/pulls/9',
    '/app/installations/177/access_tokens',
    '/repos/o/r/issues/7/comments',
    '/repos/o/r/issues/7/comments',
    'graphql',
    'graphql',
    '/graphql',
    '/installation/token',
  ]);
  const traced = await readFile(trace, 'utf8');
  assert.equal(traced.trim().split('\n').length, 29, 'every request is traced');
  assert.doesNotMatch(traced, /journey-token-A/, 'tokens are never logged');
});

const portsDouble = (sent: string[]) =>
  ({
    capacity: 1,
    configuration: {},
    builder: {} as never,
    sandbox: {
      prepare: async () => {
        sent.push('prepare');
        return { status: 'failure', code: 'X' };
      },
      start: async () => ({}) as never,
      stop: async () => ({}) as never,
    },
    workers: {
      activate: async () => {
        sent.push('activate');
        return { worker: 'w', started: new Promise(() => {}), completed: new Promise(() => {}), close() {} };
      },
      deliver: async () => ({}) as never,
    },
    credentials: {
      issue: async () => {
        sent.push('issue');
        return { delivery: { token: 't' }, metadata: {} as never };
      },
      revoke: async () => ({ kind: 'revoked' }) as never,
    },
    cleanup: {
      remove: async () => {
        sent.push('remove');
        return { status: 'success', resources: [] };
      },
      preserve: async () => {
        sent.push('preserve');
        return { status: 'absent' };
      },
    },
  }) as unknown as ExecutionPorts;

test("port guards: run/resume bound activities to the pinned Ticket's Work; ready/deliver start no agent; cleanup only in deliver", async () => {
  const sent: string[] = [];
  const ports = portsDouble(sent);
  const log = () => {};
  const invocation = (role: string, workId = 'own') => ({ context: { role, workId, phaseId: 'p', executionId: 'e' } }) as never;
  for (const phase of ['run', 'resume'] as const) {
    const guarded = guardPorts(ports, phase, async id => id === 'own', log);
    assert.deepEqual(await guarded.sandbox.prepare({ workId: 'foreign' } as never), { status: 'failure', code: 'RECIPE_PREPARE_GUARD' });
    for (let i = 0; i < bounds.prepares; i++) await guarded.sandbox.prepare({ workId: 'own' } as never);
    assert.deepEqual(await guarded.sandbox.prepare({ workId: 'own' } as never), { status: 'failure', code: 'RECIPE_PREPARE_GUARD' }, 'bounded');
    for (let i = 0; i < bounds.builders; i++) await guarded.workers.activate(invocation('builder'));
    await assert.rejects(guarded.workers.activate(invocation('builder')), /RECIPE_ACTIVATION_GUARD/);
    await assert.rejects(guarded.workers.activate(invocation('spec', 'foreign')), /RECIPE_ACTIVATION_GUARD/);
    for (let i = 0; i < bounds.builderPublish; i++) await guarded.credentials.issue({ purpose: 'builder-publish' } as never);
    await assert.rejects(guarded.credentials.issue({ purpose: 'builder-publish' } as never), /RECIPE_GRANT_GUARD/);
    await assert.rejects(guarded.credentials.issue({ purpose: 'other' } as never), /RECIPE_GRANT_GUARD/);
    assert.deepEqual(await guarded.cleanup!.remove({ environment: 'env' } as never), { status: 'failure', code: 'RECIPE_CLEANUP_GUARD', resources: [] });
  }
  const before = sent.length;
  for (const phase of ['ready', 'deliver'] as const) {
    const guarded = guardPorts(ports, phase, async () => true, log);
    assert.deepEqual(await guarded.sandbox.prepare({ workId: 'own' } as never), { status: 'failure', code: 'RECIPE_PREPARE_GUARD' });
    await assert.rejects(guarded.workers.activate(invocation('builder')), /RECIPE_ACTIVATION_GUARD/);
    await assert.rejects(guarded.credentials.issue({ purpose: 'builder-start' } as never), /RECIPE_GRANT_GUARD/);
  }
  assert.equal(sent.length, before, 'nothing reached the production ports in ready/deliver');
  const deliver = guardPorts(ports, 'deliver', async () => true, log);
  await deliver.cleanup!.preserve({ workId: 'own', environment: 'env' } as never);
  await deliver.cleanup!.remove({ environment: 'env' } as never);
  assert.deepEqual(sent.slice(before), ['preserve', 'remove']);
});

test('access guards: every method wrapped explicitly; comments only on the pinned issue in run/resume; no draft mutation in deliver; the branch deletion only in deliver', async () => {
  const sent: string[] = [];
  const access = {
    repositories: [],
    tracker: {
      postComment: async () => {
        sent.push('comment');
        return { kind: 'published' };
      },
    },
    repository: {
      setDraft: async () => {
        sent.push('draft');
        return { kind: 'applied' };
      },
      cleanupBranch: async () => {
        sent.push('cleanup');
        return { outcome: 'removed' };
      },
      unknownWrite: async () => {
        sent.push('unknown');
      },
    },
  } as unknown as AccessDependencies;
  const ref = (number: number) => ({ number, repositoryId: 1256893534 }) as never;
  const effect = { effectId: 'e' } as never;
  const runGuard = guardAccess(access, 'run', 7, () => {});
  assert.equal('unknownWrite' in runGuard.repository, false, 'a method added later is never passed through');
  assert.equal((await runGuard.tracker.postComment(ref(8), { questionId: 'q' } as never, effect)).kind, 'failed');
  assert.equal((await runGuard.tracker.postComment(ref(7), { questionId: 'q' } as never, effect)).kind, 'published');
  assert.equal((await runGuard.repository.cleanupBranch!({ branch: 'factory/7-x' } as never, effect)).outcome, 'failed', 'not in run');
  const deliver = guardAccess(access, 'deliver', 7, () => {});
  assert.equal((await deliver.tracker.postComment(ref(7), { questionId: 'q' } as never, effect)).kind, 'failed');
  assert.equal((await deliver.repository.setDraft({ number: 9 } as never, false, effect)).kind, 'known-failure');
  assert.equal((await deliver.repository.cleanupBranch!({ branch: 'factory/8-x' } as never, effect)).outcome, 'failed');
  assert.equal((await deliver.repository.cleanupBranch!({ branch: 'factory/7-x' } as never, effect)).outcome, 'removed');
  assert.equal((await deliver.repository.cleanupBranch!({ branch: 'factory/7-x' } as never, effect)).outcome, 'failed', 'one attempt per phase');
  assert.deepEqual(sent, ['comment', 'cleanup']);
});

test('a missing App key source fails loudly with its path before any effect', async () => {
  const asked: string[] = [];
  await assert.rejects(
    requireKeySource(async path => {
      asked.push(path);
      throw new Error('ENOENT');
    }),
    (error: Error) =>
      error.message.startsWith('APP_KEY_SOURCE_MISSING: /home/sanmoo/software-factory-test/y5/credentials/app.pem is absent') &&
      /nothing was created/.test(error.message),
  );
  assert.deepEqual(asked, [keySource]);
});
