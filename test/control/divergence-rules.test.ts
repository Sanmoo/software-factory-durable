import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptsOf, decideDiscovery, publicationMarker, publicationPrompt, publicationStep, publishableContent, type CandidateFacts, type DiscoveryObservation }
  from '../../src/control/rules/publication.js';
import { divergenceQuestion, knownRemote, reconciliationAnswer, reconciliationDuties, reconciliationNotice, reconciliationPrompt } from '../../src/control/rules/divergence.js';
import { preservationCheck } from '../../src/control/rules/publication.js';
import { questionDestination, questionLimits, validateQuestionRequest } from '../../src/control/rules/questions.js';
import type { DivergenceComparison, ExecutionView, PublicationView } from '../../src/control/types.js';

// Rule level (R): pure decisions of ticket 21 (spec §10.1). No I/O; GitHub facts are given as data.
const workId = '0b9c6a52-3d3e-4c8f-9a51-000000000001';
const branch = 'factory/3-0b9c6a52';
const factory = 'd'.repeat(40); // the head the Factory published (linked)
const local = 'e'.repeat(40); // the new verified local result (not pushed)
const human = '1'.repeat(40); // a commit pushed by a human on the Factory branch
const again = '2'.repeat(40); // a second human change after the answer
const app = { login: 'factory-app[bot]', id: 41898282 };
const expect = { workId, ticketNumber: 3, branch, base: 'main', repositoryId: 3, head: local, app };
const marker = publicationMarker(workId);
const body = [marker, '## Summary', 'Adds the note. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join('\n');
const own = (overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({ pullRequestId: 9004, nodeId: 'PR_node4', number: 4, url: 'https://github.com/acme/project/pull/4',
  state: 'open', merged: false, draft: true, headRef: branch, headSha: factory, baseRef: 'main', headRepositoryId: 3, author: { id: app.id, login: app.login, type: 'Bot' }, body, ...overrides });
const comparison = (from: string, to: string, commits: string[], extra: Partial<Extract<DivergenceComparison, { state: 'complete' }>> = {}): DivergenceComparison =>
  ({ state: 'complete', from, to, status: 'ahead', aheadBy: commits.length, behindBy: 0, files: ['docs/a.md'], truncated: false,
    commits: commits.map((sha, index) => ({ sha, author: index === 0 ? { login: 'operator-one', id: 77 } : null, authorName: 'Operator', subject: `human change ${index}` })), ...extra });
const observed = (candidates: CandidateFacts[], tip: string, extra: { comparison?: DivergenceComparison } = {}): DiscoveryObservation =>
  ({ kind: 'observed', repositoryId: 3, candidates, branch: { state: 'present', sha: tip }, refs: { state: 'complete', refs: { 'refs/heads/main': 'b'.repeat(40), [`refs/heads/${branch}`]: tip } },
    baseProtection: { state: 'pull-request-required', sources: ['ruleset:1'] }, ...extra });
const known = (overrides: Partial<NonNullable<Parameters<typeof decideDiscovery>[0]['known']>> = {}) =>
  ({ heads: [factory], pullRequestId: 9004, expected: { state: 'present' as const, sha: factory }, authorized: null, ...overrides });
const publication = (overrides: Partial<PublicationView> = {}): PublicationView => ({ state: 'awaiting-discovery', basisExecutionId: 'e2', marker, branch, base: 'main',
  verified: { executionId: 'e2', head: local, contentSha256: 'f'.repeat(64), verifiedAt: null, reviewedRound: 1, gates: [], requiredChecks: [] }, expectedRemote: null,
  requestedAt: null, pullRequest: null, description: null, discoveries: [], reasons: [], nextStep: null, updatedAt: 'x', attempts: [{ executionId: 'p1', head: factory, at: 'x',
    expectedRemote: { state: 'absent' } }], linkedHeads: [factory], ...overrides });

test('AC3: a human push on the Factory branch blocks the next write: a divergence (Question), never a request or a recapture of the tip', () => {
  const decision = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(),
    observation: observed([own({ headSha: human })], human, { comparison: comparison(factory, human, [human]) }) });
  assert.equal(decision.outcome, 'diverged');
  if (decision.outcome !== 'diverged') return;
  assert.deepEqual([decision.trigger, decision.current, decision.expected, decision.reasons], ['update', human, { state: 'present', sha: factory }, [`HUMAN_CHANGE_NOT_ATTRIBUTABLE:${human}`]]);
  assert.deepEqual(decision.uncertainties, []);
  // Without the change the same facts update the own PR with a lease on its linked head (ticket 14 MED 6, unchanged).
  const update = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(), observation: observed([own()], factory) });
  assert.ok(update.outcome === 'absent' && update.expectedRemote.state === 'present' && update.expectedRemote.sha === factory);
  // Incomplete facts are uncertainties presented to the operator, never a guess: unknown comparison, unlinked authors, PR head behind the ref.
  const unknown = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(), observation: observed([own()], human, { comparison: { state: 'unknown', code: 'GITHUB_QUERY_FAILED' } }) });
  assert.ok(unknown.outcome === 'diverged' && unknown.uncertainties.includes('DIFFERENCES_UNKNOWN:GITHUB_QUERY_FAILED') &&
    unknown.uncertainties.includes(`PULL_REQUEST_HEAD_DIFFERS_FROM_BRANCH:${factory}`));
  const twoAuthors = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(), observation: observed([own({ headSha: again })], again,
    { comparison: comparison(factory, again, [human, again], { behindBy: 1 }) }) });
  assert.ok(twoAuthors.outcome === 'diverged' && twoAuthors.uncertainties.includes('AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS') &&
    twoAuthors.uncertainties.includes('FACTORY_COMMITS_MISSING_ON_REMOTE:1'));
});

test('AC3: a failed lease is never retried with the new tip: the attempt is a divergence (lease-failed), not a new request', () => {
  const failed = decideDiscovery({ expect, attempted: true, previousHeads: [factory], known: known(), observation: observed([own({ headSha: human })], human,
    { comparison: comparison(factory, human, [human]) }) });
  assert.ok(failed.outcome === 'diverged');
  if (failed.outcome !== 'diverged') return;
  assert.deepEqual([failed.trigger, failed.reasons], ['lease-failed', [`HUMAN_CHANGE_NOT_ATTRIBUTABLE:${human}`, 'LEASE_FAILED']]);
  // Our push landed and a human pushed after it: still a divergence, not our result.
  const after = decideDiscovery({ expect, attempted: true, previousHeads: [factory], known: known(), observation: observed([own({ headSha: human })], human,
    { comparison: comparison(factory, human, [local, human]) }) });
  assert.ok(after.outcome === 'diverged' && after.trigger === 'after-publication' && !after.uncertainties.includes('LEASE_OUTCOME_UNKNOWN'));
  const unclear = decideDiscovery({ expect, attempted: true, previousHeads: [factory], known: known(), observation: observed([own({ headSha: human })], human) });
  assert.ok(unclear.outcome === 'diverged' && unclear.trigger === 'after-publication' && unclear.uncertainties.includes('LEASE_OUTCOME_UNKNOWN'));
});

test('AC1/AC2: the expectation is the recorded one (linked head, the attempt lease or the authorized tip); prompts use only an explicit lease on the own branch', () => {
  assert.deepEqual(knownRemote(publication(), false, false), { heads: [factory], pullRequestId: null, expected: { state: 'present', sha: factory }, authorized: null,
    required: [], waived: [] });
  const attempted = publication({ attempts: [{ executionId: 'p2', head: local, at: 'y', expectedRemote: { state: 'present', sha: factory } }] });
  assert.deepEqual(knownRemote(attempted, true, false).expected, { state: 'present', sha: factory }, 'the lease the attempt USED, never the tracking ref or a new read');
  const authorized = publication({ reconciliation: { divergenceId: 'v1', questionId: 'q1', answerSha256: 'a'.repeat(64), mode: 'incorporate', authorizedRemote: human,
    expected: { state: 'present', sha: factory }, authorizedAt: 'z', author: '@operator-one', state: 'authorized', executionId: null } });
  assert.deepEqual(knownRemote(authorized, false, true), { heads: [factory], pullRequestId: null, expected: { state: 'present', sha: human },
    authorized: { remote: human, mode: 'incorporate', preserved: true }, required: [], waived: [] });
  const prompt = publicationPrompt({ reason: 'PUBLISH_ONLY_SESSION', executionId: 'x', previousExecutionId: 'e2', skillDirectory: '/s', repository: 'acme/project', base: 'main',
    branch, head: local, marker, ticket: { number: 3, url: 'https://github.com/acme/project/issues/3' }, workId, checkout: '/workspace/checkout',
    expectedRemote: { state: 'present', sha: human }, pullRequest: 4, verified: { reviewedRound: 1, gates: [], requiredChecks: [] } });
  assert.ok(prompt.kind === 'prompt');
  if (prompt.kind !== 'prompt') return;
  assert.ok(prompt.prompt.includes(`--force-with-lease=refs/heads/${branch}:${human} https://github.com/acme/project.git ${local}:refs/heads/${branch}`), 'explicit ref:OID lease on the own branch only');
  assert.ok(!/--force(?!-with-lease)/.test(prompt.prompt.replace(/force-push without that explicit lease/, '')), 'never a bare --force');
  const reconcile = reconciliationPrompt({ executionId: 'r1', previousExecutionId: 'e2', skillDirectory: '/s', ticketUrl: 'https://github.com/acme/project/issues/3', workId,
    repository: 'acme/project', base: 'main', baseCommit: 'b'.repeat(40), branch, checkout: '/workspace/checkout', pullRequest: { number: 4, url: 'u' },
    expected: { state: 'present', sha: factory }, authorizedRemote: human, localHead: local, questionId: 'q1', answer: { author: '@operator-one', note: '' },
    commits: [{ sha: human, label: '@operator-one human change' }] });
  assert.ok(reconcile.kind === 'prompt');
  if (reconcile.kind !== 'prompt') return;
  assert.ok(reconcile.prompt.includes(`rebase ${human}`) && reconcile.prompt.includes('AGENTS.md documents another update strategy'), 'rebase by default unless AGENTS documents another');
  assert.ok(reconcile.prompt.includes(`git merge-base --is-ancestor ${human} HEAD`) && reconcile.prompt.includes(`rev-parse FETCH_HEAD prints exactly ${human}`));
  assert.ok(!/git[^\n]* push/.test(reconcile.prompt) && reconcile.prompt.includes('Never push'), 'the reconciliation never pushes; publication is the leased activation');
  assert.ok(reconcile.prompt.includes('never rebase onto a newer base'), 'the base is never rewritten in this activation');
});

test('AC4: the Question presents Work/repo/branch/PR, known/current/local refs, differences/authorship/uncertainties and the proposal; discard needs a specific answer', () => {
  const text = divergenceQuestion({ divergenceId: 'v1', detectedAt: 'x', trigger: 'update', repository: 'acme/project', branch, base: 'main',
    pullRequest: { number: 4, url: 'https://github.com/acme/project/pull/4' }, expected: { state: 'present', sha: factory }, current: human, local,
    comparison: comparison(factory, human, [human, again]), uncertainties: ['AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS'], proposal: 'incorporate' }, workId);
  for (const fact of [workId, 'acme/project', branch, 'pull request #4', `Known Factory tip (lease expectation): ${factory}`, `Current remote tip: ${human}`,
    `Local Factory result (verified, not pushed): ${local}`, 'incorporate and preserve every remote commit', `discard ${human}`]) assert.ok(text.question.includes(fact), fact);
  assert.ok(text.context.includes(`${human} | @operator-one (id 77)`) && text.context.includes(`${again} | account unproven`), 'authorship only when GitHub links it');
  assert.ok(text.context.includes('Uncertainties: AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS') && text.context.includes('Files: docs/a.md'));
  assert.ok(text.question.length <= questionLimits.question && text.context.length <= questionLimits.context);
  assert.ok(validateQuestionRequest({ questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000009', ...text }).valid);
  const hostile = divergenceQuestion({ divergenceId: 'v1', detectedAt: 'x', trigger: 'update', repository: 'acme/project', branch, base: 'main', pullRequest: null,
    expected: { state: 'present', sha: factory }, current: human, local: null, uncertainties: [], proposal: 'incorporate',
    comparison: comparison(factory, human, Array.from({ length: 60 }, (_v, index) => index.toString(16).padStart(40, '0')), { truncated: true }) }, workId);
  assert.ok(hostile.context.length <= questionLimits.context && validateQuestionRequest({ questionId: '0b9c6a52-3d3e-4c8f-9a51-000000000009', ...hostile }).valid);
});

test('AC5: the answer authorizes only the concrete divergence: incorporate, or discard naming exactly its tip; anything else authorizes nothing', () => {
  const divergence = { current: human };
  assert.deepEqual(reconciliationAnswer('incorporate', divergence), { decision: 'incorporate' });
  assert.deepEqual(reconciliationAnswer('  incorporate\n', divergence), { decision: 'incorporate' });
  // Review LOW: exact answers only.
  for (const text of ['Incorporate', 'incorporate.', 'incorporate, keep my wording', `discard ${human} please`, `Discard ${human}`]) {
    assert.equal(reconciliationAnswer(text, divergence).decision, 'not-authorized', text);
  }
  assert.deepEqual(reconciliationAnswer(`discard ${human}`, divergence), { decision: 'discard' });
  assert.deepEqual(reconciliationAnswer('incorporate', { current: human, kind: 'lost' }), { decision: 'not-authorized', code: 'LOST_CHANGE_NOT_INCORPORABLE' },
    'a lost change is restored by the operator or explicitly discarded');
  assert.deepEqual(reconciliationAnswer(`discard ${again}`, divergence), { decision: 'not-authorized', code: 'DISCARD_TIP_MISMATCH' }, 'another tip never authorizes discarding this one');
  assert.deepEqual(reconciliationAnswer('discard', divergence), { decision: 'not-authorized', code: 'DISCARD_TIP_MISMATCH' });
  for (const text of ['ok', 'yes', 'de acordo', 'please also add a section on rollback']) assert.equal(reconciliationAnswer(text, divergence).decision, 'not-authorized', text);
});

test('AC5: with the authorization in force the next write leases exactly the authorized tip; a NEW change asks again; preservation is required', () => {
  const authorized = { remote: human, mode: 'incorporate' as const, preserved: true };
  const lease = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known({ expected: { state: 'present', sha: human }, authorized }),
    observation: observed([own({ headSha: human })], human) });
  assert.ok(lease.outcome === 'absent' && lease.expectedRemote.state === 'present' && lease.expectedRemote.sha === human && lease.update?.number === 4);
  const newer = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known({ expected: { state: 'present', sha: human }, authorized }),
    observation: observed([own({ headSha: again })], again, { comparison: comparison(human, again, [again]) }) });
  assert.ok(newer.outcome === 'diverged' && newer.current === again && newer.expected.state === 'present' && newer.expected.sha === human,
    'a later remote change is a new divergence against the authorized tip, never a renewed lease');
  assert.deepEqual(decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known({ authorized: { ...authorized, preserved: false } }),
    observation: observed([own({ headSha: human })], human) }).reasons, ['HUMAN_CHANGE_NOT_PRESERVED']);
  assert.equal(decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known({ authorized: { remote: human, mode: 'discard', preserved: true } }),
    observation: observed([own({ headSha: human })], human) }).outcome, 'absent', 'an authorized discard leases exactly that tip');
  // The capture's ancestry check decides preservation (never the model's word).
  const reconciliation = { divergenceId: 'v1', questionId: 'q1', answerSha256: 'a'.repeat(64), expected: { state: 'present' as const, sha: factory }, authorizedRemote: human,
    localHead: local, strategy: 'rebase-unless-agents-documents-another' as const };
  const basis = (preserved: object | undefined) => ({ executionId: 'r1', invocationId: 'builder-r1', mode: 'recovery', state: 'ended', slot: { held: false },
    start: { receiptId: 'r', confirmedAt: 'x' }, request: { branch, reconciliation }, end: { at: 'z', outcome: 'completed', code: null, cessation: 'confirmed' },
    review: { rounds: [{ round: 3, handoff: { summary: { head: 'c'.repeat(40), branch, content: { sha256: 'f'.repeat(64), clean: true, headMatches: true }, ...(preserved ? { preserved } : {}) } } }],
      verification: { at: 'x', status: 'verified', reasons: [], reviewedRound: 3, contentSha256: 'f'.repeat(64), gates: [], requiredChecks: [] } } }) as unknown as ExecutionView;
  assert.ok(publishableContent(basis({ commit: human, ancestor: true })).ok);
  const reasons = (value: ReturnType<typeof publishableContent>) => value.ok ? [] : value.reasons;
  assert.deepEqual(reasons(publishableContent(basis({ commit: human, ancestor: false }))), ['HUMAN_CHANGE_NOT_PRESERVED']);
  assert.deepEqual(reasons(publishableContent(basis(undefined))), ['HUMAN_CHANGE_PRESERVATION_UNKNOWN']);
  assert.deepEqual(reasons(publishableContent(basis({ commit: again, ancestor: true }))), ['HUMAN_CHANGE_PRESERVATION_UNKNOWN'], 'another commit proves nothing');
  // Under the authorization only attempts that leased exactly the authorized tip count (a lease refused before it is not repeated blindly).
  const scoped = publication({ attempts: [{ executionId: 'p2', head: local, at: 'y', expectedRemote: { state: 'present', sha: factory } }],
    reconciliation: { divergenceId: 'v1', questionId: 'q1', answerSha256: 'a'.repeat(64), mode: 'discard', authorizedRemote: human, expected: { state: 'present', sha: factory },
      authorizedAt: 'z', author: 'local administrator', state: 'authorized', executionId: null } });
  assert.equal(attemptsOf(scoped, local).length, 0);
  assert.equal(attemptsOf({ ...scoped, attempts: [...scoped.attempts!, { executionId: 'p3', head: local, at: 'w', expectedRemote: { state: 'present', sha: human } }] }, local).length, 1);
  assert.equal(attemptsOf({ ...scoped, reconciliation: { ...scoped.reconciliation!, state: 'consumed' } }, local).length, 1, 'without an authorization every attempt counts');
});

test('AC6: a changed base of the linked own PR blocks until restored; the mere advance of the same base triggers nothing', () => {
  const changed = decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(), observation: observed([own({ baseRef: 'release' })], factory) });
  assert.deepEqual([changed.outcome, changed.reasons], ['base-changed', ['BASE_TARGET_CHANGED:main->release']]);
  assert.equal(decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known({ pullRequestId: null }), observation: observed([own({ baseRef: 'release' })], factory) }).outcome,
    'held', 'without the linked identity a PR on another base is never claimed as own');
  assert.equal(decideDiscovery({ expect, attempted: false, previousHeads: [factory], known: known(), observation: observed([own()], factory) }).outcome, 'absent', 'restored: the update proceeds');
  // A published Work with the base advancing: no publication step (no Execution, review, rebase or draft by itself).
  const published = publication({ state: 'published' });
  const ended = { executionId: 'e2', state: 'ended', slot: { held: false }, request: {}, end: { outcome: 'completed', cessation: 'confirmed', at: 'z' } } as unknown as ExecutionView;
  assert.deepEqual(publicationStep({ result: 'open', execution: ended, previousExecutions: [], publication: published }), { kind: 'none' });
  assert.deepEqual(publicationStep({ result: 'open', execution: ended, previousExecutions: [], publication: publication({ state: 'base-changed' }) }),
    { kind: 'discover', trigger: 'reconciliation', attempted: false }, 'a changed base is re-read every cycle');
  assert.deepEqual(publicationStep({ result: 'open', execution: ended, previousExecutions: [], publication: publication({ state: 'diverged', divergences: [{ divergenceId: 'v1',
    questionId: 'q1', state: 'awaiting-answer' } as never] }) }), { kind: 'resolve', divergenceId: 'v1', questionId: 'q1' });
});

const linkable = (extra: Partial<Extract<DiscoveryObservation, { kind: 'observed' }>>) => ({ ...observed([own({ headSha: local })], local), ...extra }) as Extract<DiscoveryObservation, { kind: 'observed' }>;
const ancestry = (tip: string, status: string, files: string[] = []): DivergenceComparison => ({ state: 'complete', from: tip, to: local, status, aheadBy: 1, behindBy: 0, commits: [], files, truncated: false });
const entry = (before: string, after: string, actor: { login: string; id: number } | null) => ({ before, after, type: 'push', actor, at: 'x' });

test('review HIGH: before LINKING a new own head every commit others pushed must be an ancestor with its paths untouched (Control-side, not the prompt)', () => {
  const attributable = (sha: string) => sha === factory || sha === local;
  const k = known({ required: [{ tip: human, paths: ['docs/a.md'] }] });
  const empty = { state: 'complete' as const, entries: [], truncated: false };
  assert.deepEqual(preservationCheck(local, k, linkable({ activity: empty, ancestry: { [human]: ancestry(human, 'ahead') } }), app, attributable), { kind: 'preserved' });
  assert.equal(preservationCheck(local, k, linkable({ activity: empty, ancestry: { [human]: ancestry(human, 'diverged') } }), app, attributable).kind, 'lost', 'rebased away');
  const reverted = preservationCheck(local, k, linkable({ activity: empty, ancestry: { [human]: ancestry(human, 'ahead', ['docs/a.md']) } }), app, attributable);
  assert.ok(reverted.kind === 'lost' && reverted.reason === 'HUMAN_CONTENT_CHANGED:docs/a.md', 'ancestry alone does not exclude a revert of the human file');
  assert.equal(preservationCheck(local, k, linkable({ activity: empty }), app, attributable).kind, 'incomplete', 'an unread comparison never proves preservation');
  assert.deepEqual(preservationCheck(local, k, linkable({ activity: { state: 'unknown', code: 'GITHUB_QUERY_FAILED' } }), app, attributable), { kind: 'incomplete', code: 'ACTIVITY_UNKNOWN:GITHUB_QUERY_FAILED' });
  // The recaptured-lease attack: a Factory push replaced a tip Control never saw (a human commit that landed during the publication).
  const recaptured = linkable({ activity: { state: 'complete', truncated: false, entries: [entry(human, local, app), entry(factory, human, { login: 'operator-one', id: 77 })] },
    ancestry: { [human]: ancestry(human, 'diverged') } });
  const lost = preservationCheck(local, known(), recaptured, app, attributable);
  assert.ok(lost.kind === 'lost' && lost.tip === human);
  assert.deepEqual(preservationCheck(local, known({ waived: [human] }), recaptured, app, attributable), { kind: 'preserved' }, 'only an explicit discard waives it');
  const decision = decideDiscovery({ expect, attempted: true, previousHeads: [factory], known: known(), observation: recaptured });
  assert.ok(decision.outcome === 'diverged' && decision.kind === 'lost' && decision.current === human && decision.reasons[0] === `LOST_HUMAN_CHANGE:${human}`, 'never linked');
  assert.equal(decideDiscovery({ expect, attempted: true, previousHeads: [factory], known: known(), observation: linkable({ activity: empty }) }).outcome, 'linked');
});

test('review LOW: the Question keeps the reply instruction and the uncertainties under the bounds; long lists end with "+N more"', () => {
  const many = Array.from({ length: 60 }, (_v, index) => index.toString(16).padStart(40, '0'));
  const text = divergenceQuestion({ divergenceId: 'v1', detectedAt: 'x', trigger: 'update', repository: 'acme/'.padEnd(140, 'p'), branch: `factory/3-${'x'.repeat(180)}`, base: 'b'.repeat(200),
    pullRequest: { number: 4, url: 'u' }, expected: { state: 'present', sha: factory }, current: human, local, uncertainties: ['AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS'], proposal: 'incorporate',
    comparison: { ...(comparison(factory, human, many) as Extract<DivergenceComparison, { state: 'complete' }>), files: Array.from({ length: 200 }, (_v, index) => `docs/${'deep/'.repeat(20)}file-${index}.md`) } }, workId);
  assert.ok(text.question.length <= questionLimits.question && text.question.includes(`"discard ${human}"`) && text.question.includes('"incorporate"'));
  assert.ok(text.context.length <= questionLimits.context && text.context.includes('Uncertainties: AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS') && /\(\+\d+ more commits\)/.test(text.context) && /\(\+\d+ more\)/.test(text.context));
  const lost = divergenceQuestion({ divergenceId: 'v2', detectedAt: 'x', trigger: 'after-publication', repository: 'acme/project', branch, base: 'main', pullRequest: { number: 4, url: 'u' },
    expected: { state: 'present', sha: factory }, current: human, local, uncertainties: [`OWN_HEAD_DOES_NOT_PRESERVE:${local}`], proposal: 'incorporate', kind: 'lost',
    comparison: { state: 'unknown', code: 'X' } }, workId);
  assert.ok(lost.question.includes(`does NOT preserve commit ${human}`) && lost.question.includes(`"discard ${human}"`) && !lost.question.includes('Reply exactly "incorporate"'));
});


test('real run q21-human-v3: the publish-only prompt says a local policy denial is not a publication attempt and is corrected ONCE by the exact command alone', () => {
  const prompt = publicationPrompt({ reason: 'PUBLISH_ONLY_SESSION', executionId: 'x', previousExecutionId: 'e2', skillDirectory: '/s', repository: 'acme/project', base: 'main',
    branch, head: local, marker, ticket: { number: 3, url: 'https://github.com/acme/project/issues/3' }, workId, checkout: '/workspace/checkout',
    expectedRemote: { state: 'absent' }, pullRequest: null, verified: { reviewedRound: 1, gates: [], requiredChecks: [] } });
  assert.ok(prompt.kind === 'prompt');
  if (prompt.kind !== 'prompt') return;
  assert.match(prompt.prompt, /Run the push command ALONE as its own bash call/);
  assert.match(prompt.prompt, /PUSH_POLICY_DENIED is a LOCAL refusal: nothing was sent and it is not a publication attempt; correct it ONCE/);
});

test('real run q21-human-v5: the reconciliation instructions carry the gate-declaration and findings-treatment duties (authorized remote commits, ask_user otherwise)', () => {
  const prompt = reconciliationPrompt({ executionId: 'r1', previousExecutionId: 'e2', skillDirectory: '/s', ticketUrl: 'https://github.com/acme/project/issues/3', workId,
    repository: 'acme/project', base: 'main', baseCommit: 'b'.repeat(40), branch, checkout: '/workspace/checkout', pullRequest: { number: 4, url: 'u' },
    expected: { state: 'present', sha: factory }, authorizedRemote: human, localHead: local, questionId: 'q-authorized', answer: { author: '@operator-one', note: '' }, commits: [] });
  assert.ok(prompt.kind === 'prompt');
  if (prompt.kind !== 'prompt') return;
  for (const text of [reconciliationDuties('q-authorized')[0]!, reconciliationDuties('q-authorized')[1]!]) assert.ok(prompt.prompt.includes(text), text);
  const duties = reconciliationDuties('q-authorized').join('\n');
  assert.match(duties, /declare EVERY documented Validation gate/);
  assert.match(duties, /"authorization": \{ "kind": "question", "questionId": "q-authorized" \}/);
  assert.match(duties, /ask_user/);
  assert.match(duties, /never a silent non-adoption/);
  const notice = reconciliationNotice({ authorizedRemote: human, expected: { state: 'present', sha: factory }, localHead: local, questionId: 'q-authorized' }, branch, '/workspace/checkout', 'origin');
  assert.ok(notice.includes(reconciliationDuties('q-authorized')[0]!), 'the recovery of a reconciliation keeps the same duties');
});

test('real run q21-human-v5: a Builder Question after the own PR is linked goes to the Ticket issue (the PR surface is not enabled), never refused', () => {
  const ticketRef = { number: 3 };
  assert.deepEqual(questionDestination({ ticket: ticketRef, pullRequest: { number: 4, url: 'https://github.com/acme/project/pull/4' } }), { kind: 'issue', ticket: ticketRef });
  assert.deepEqual(questionDestination({ ticket: ticketRef, pullRequest: null }), { kind: 'issue', ticket: ticketRef });
});
