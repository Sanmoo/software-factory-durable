import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideDiscovery, liveBasisRecoverable, otherPublications, publicationMarker, publicationStep, reevaluationEligibility, reevaluationGuidance, unexpectedRefChanges,
  unpublishedBeforeStop, unpublishedBeforeStopStep, verifiedHeadOnOrigin,
  type CandidateFacts } from '../../src/control/rules/publication.js';
import type { ExecutionView, PublicationView } from '../../src/control/types.js';

// Rule level (R), ticket 61: a concurrent OWN publication of another Work of this installation (its own branch at a head Control recorded for
// that Work's publication) is not an unexpected ref change; anything else still is. No I/O: the other Works' records are plain data.
const app = { login: 'factory-app[bot]', id: 41898282 };
const protectedBase = { state: 'pull-request-required' as const, sources: ['ruleset:1'] };
const main = { 'refs/heads/main': 'b'.repeat(40) };
type Side = { workId: string; ticket: number; branch: string; head: string; pull: number };
const a: Side = { workId: '2dd8c691-0000-4000-8000-000000000124', ticket: 124, branch: 'factory/124-2dd8c691', head: '3'.repeat(40), pull: 131 };
const b: Side = { workId: 'f4f421b6-0000-4000-8000-000000000125', ticket: 125, branch: 'factory/125-f4f421b6', head: 'c'.repeat(40), pull: 130 };
const expectOf = (side: Side) => ({ workId: side.workId, ticketNumber: side.ticket, branch: side.branch, base: 'main', repositoryId: 3, head: side.head, app });
const own = (side: Side): CandidateFacts => ({ pullRequestId: 9000 + side.pull, nodeId: `PR_${side.pull}`, number: side.pull, url: `https://github.com/acme/project/pull/${side.pull}`,
  state: 'open', merged: false, draft: true, headRef: side.branch, headSha: side.head, baseRef: 'main', headRepositoryId: 3, author: { id: app.id, login: app.login, type: 'Bot' },
  body: [publicationMarker(side.workId), '## Summary', `Closes #${side.ticket}`, '## Validation', 'Gate passed.', '## Risk', 'Low.'].join('\n') });
const observed = (side: Side, refs: Record<string, string>) => ({ kind: 'observed' as const, repositoryId: 3, candidates: [own(side)], branch: { state: 'present' as const, sha: side.head },
  refs: { state: 'complete' as const, refs }, baseProtection: protectedBase });
/** A Work record as the dispatcher lists it (only the fields the rule reads). */
const record = (side: Side, publication: Partial<PublicationView> | null, repositoryId = 3) => ({ work_id: side.workId, repository: { repositoryId },
  publication: publication === null ? null : { state: 'awaiting-discovery', branch: side.branch, verified: { head: side.head }, attempts: [], linkedHeads: [], ...publication } as PublicationView });
const attempted = (side: Side) => ({ attempts: [{ executionId: `p-${side.ticket}`, head: side.head, at: 'x', expectedRemote: { state: 'absent' as const } }] });

test('ticket 61: two concurrent own publications in the same window — neither blocks the other', () => {
  // Both requested from the same snapshot (neither branch existed), both pushed their verified head before the other's discovery.
  const now = { ...main, [`refs/heads/${a.branch}`]: a.head, [`refs/heads/${b.branch}`]: b.head };
  const works = [record(a, attempted(a)), record(b, attempted(b))];
  for (const [self, other] of [[a, b], [b, a]] as const) {
    const others = otherPublications(works, { workId: self.workId, repositoryId: 3 });
    assert.deepEqual(others, [{ workId: other.workId, branch: other.branch, heads: [other.head] }], 'the other Work\'s own branch and its attempted head');
    const decision = decideDiscovery({ expect: expectOf(self), attempted: true, refsBefore: main, others, observation: observed(self, now) });
    assert.deepEqual([decision.outcome, decision.reasons], ['linked', []], `${self.ticket} is not blocked by ${other.ticket}'s own publication`);
  }
  // A head linked as the other Work's own PR head also counts (a later update of its own PR in the window).
  const moved = { ...now, [`refs/heads/${b.branch}`]: 'e'.repeat(40) };
  const linked = otherPublications([record(a, attempted(a)), record(b, { ...attempted(b), linkedHeads: ['e'.repeat(40)] })], { workId: a.workId, repositoryId: 3 });
  assert.deepEqual(unexpectedRefChanges({ ...main, [`refs/heads/${b.branch}`]: b.head }, moved, a.branch, linked), [], 'moved to a head linked for that Work');
  // The head of a REQUESTED publication (not yet attempted) is the one Control asked for.
  assert.deepEqual(otherPublications([record(b, { state: 'requested' })], { workId: a.workId, repositoryId: 3 })[0]!.heads, [b.head]);
});

test('ticket 61: anything else still blocks — unrecorded head, deletion, another Work\'s branch elsewhere, other refs and tags', () => {
  const others = otherPublications([record(a, attempted(a)), record(b, attempted(b))], { workId: a.workId, repositoryId: 3 });
  const before = { ...main, [`refs/heads/${b.branch}`]: b.head };
  const changes = (now: Record<string, string>, from: Record<string, string> = main) => unexpectedRefChanges(from, now, a.branch, others);
  assert.deepEqual(changes({ ...main, [`refs/heads/${b.branch}`]: 'e'.repeat(40) }), [`refs/heads/${b.branch}`], 'another Work\'s branch at a head Control never recorded for it');
  assert.deepEqual(changes(main, before), [`refs/heads/${b.branch}`], 'deletion of another Work\'s branch');
  assert.deepEqual(changes({ ...before, 'refs/heads/main': 'e'.repeat(40) }, before), ['refs/heads/main'], 'the base moved');
  assert.deepEqual(changes({ ...main, 'refs/heads/feature/x': b.head }), ['refs/heads/feature/x'], 'a recorded head on a branch that is not that Work\'s own');
  assert.deepEqual(changes({ ...main, [`refs/tags/${b.branch}`]: b.head }), [`refs/tags/${b.branch}`], 'a tag named like the branch is not the branch');
  // Without a recorded publication, or in another repository, nothing is attributable.
  assert.deepEqual(otherPublications([record(b, null)], { workId: a.workId, repositoryId: 3 }), []);
  assert.deepEqual(otherPublications([record(b, attempted(b), 99)], { workId: a.workId, repositoryId: 3 }), [], 'another repository');
  assert.deepEqual(otherPublications([record(b, { state: 'awaiting-discovery' })], { workId: a.workId, repositoryId: 3 }), [],
    'a verified head never requested nor attempted is not a publication expectation');
  assert.deepEqual(otherPublications([record(a, attempted(a))], { workId: a.workId, repositoryId: 3 }), [], 'the Work itself is not "another" Work');
  const decision = decideDiscovery({ expect: expectOf(a), attempted: true, refsBefore: main, others,
    observation: observed(a, { ...main, [`refs/heads/${a.branch}`]: a.head, [`refs/heads/${b.branch}`]: b.head, 'refs/tags/v9': a.head }) });
  assert.deepEqual([decision.outcome, decision.reasons], ['blocked', ['UNEXPECTED_REF_CHANGE:refs/tags/v9']], 'an accepted concurrent publication never hides a real change');
});

const execution = (): ExecutionView => ({ executionId: 'e1', state: 'ended', slot: { held: false }, request: {}, end: { outcome: 'completed', cessation: 'confirmed' } }) as unknown as ExecutionView;
const blocked = (overrides: Partial<PublicationView> = {}): PublicationView => ({ state: 'blocked', basisExecutionId: 'e1', branch: a.branch, verified: { head: a.head },
  reasons: [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`], refsBefore: main, ...attempted(a), ...overrides }) as PublicationView;

test('ticket 61: only a publication blocked ONLY by unexpected ref changes after an attempt, with its snapshot, may be re-evaluated', () => {
  assert.deepEqual(reevaluationEligibility(blocked()), { ok: true });
  assert.deepEqual(reevaluationEligibility(blocked({ state: 'published' })), { ok: false, code: 'PUBLICATION_NOT_BLOCKED' });
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`, 'PULL_REQUEST_NOT_DRAFT'] })),
    { ok: false, code: 'NOT_REEVALUABLE:PULL_REQUEST_NOT_DRAFT' }, 'a reason the corrected rule does not change');
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: ['MULTIPLE_OWN_PULL_REQUESTS:7,8'] })), { ok: false, code: 'NOT_REEVALUABLE:MULTIPLE_OWN_PULL_REQUESTS:7,8' });
  assert.deepEqual(reevaluationEligibility(blocked({ refsBefore: null })), { ok: false, code: 'REFS_SNAPSHOT_ABSENT' });
  assert.deepEqual(reevaluationEligibility(blocked({ attempts: [] })), { ok: false, code: 'PUBLICATION_NOT_ATTEMPTED' });
  // A pending re-evaluation turns the settled block into ONE discovery after the attempt; without it the block stays settled.
  const work = (publication: PublicationView) => ({ result: 'open', execution: execution(), publication });
  assert.deepEqual(publicationStep(work(blocked())), { kind: 'none' });
  assert.deepEqual(publicationStep(work(blocked({ reevaluation: { request_id: 'r1', reason: 'x', requestedAt: 'x', state: 'pending', settledAt: null, outcome: null, reasons: [] } }))),
    { kind: 'discover', trigger: 'after-publication', attempted: true });
  assert.deepEqual(publicationStep(work(blocked({ reevaluation: { request_id: 'r1', reason: 'x', requestedAt: 'x', state: 'still-blocked', settledAt: 'y', outcome: 'blocked', reasons: [] } }))),
    { kind: 'none' });
});

// Acceptance finding A13 (v2, sandbox without a persistent disk): another Work's Builder publishes work in progress on ITS OWN branch under
// a preservation gate. That push is not a publication attempt, so the ticket 61 rule did not attribute it and blocked the observer.
const preserved = (side: Side, heads: string[]) => ({ commit: heads.at(-1)!, branch: side.branch, confirmedAt: 'x', executionId: 'e', boot: 'boot', occasion: 'ci-wait', heads });
const live = { executionId: 'e-live', state: 'started', slot: { held: true } };
test('A13: a head a preservation gate confirmed on another Work\'s own branch is that Work\'s own push', () => {
  const wip = '7'.repeat(40);
  const works = [record(a, attempted(a)), { ...record(b, { state: 'not-publishable', verified: null }), preservation: preserved(b, [wip]) }];
  const others = otherPublications(works, { workId: a.workId, repositoryId: 3 });
  assert.deepEqual(others, [{ workId: b.workId, branch: b.branch, heads: [wip] }]);
  const now = { ...main, [`refs/heads/${a.branch}`]: a.head, [`refs/heads/${b.branch}`]: wip };
  const decision = decideDiscovery({ expect: expectOf(a), attempted: true, refsBefore: main, others, wipPushes: true, observation: observed(a, now) });
  assert.deepEqual([decision.outcome, decision.reasons], ['linked', []]);
  // Without any publication record the preservation names the branch.
  assert.deepEqual(otherPublications([{ ...record(b, null), preservation: preserved(b, [wip]) }], { workId: a.workId, repositoryId: 3 }), [{ workId: b.workId, branch: b.branch, heads: [wip] }]);
  // Another head on that branch, with that Work stopped, is still unexpected.
  const moved = decideDiscovery({ expect: expectOf(a), attempted: true, refsBefore: main, others, wipPushes: true,
    observation: observed(a, { ...now, [`refs/heads/${b.branch}`]: 'e'.repeat(40) }) });
  assert.deepEqual([moved.outcome, moved.reasons], ['blocked', [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`]]);
});

test('A13: a push on the own branch of a Work whose Execution is still running decides nothing until Control records it or that Execution ends', () => {
  const wip = '7'.repeat(40);
  const running = { ...record(b, null), branch: b.branch, execution: live };
  const others = otherPublications([record(a, attempted(a)), running], { workId: a.workId, repositoryId: 3 });
  assert.deepEqual(others, [{ workId: b.workId, branch: b.branch, heads: [], live: true }]);
  const now = { ...main, [`refs/heads/${a.branch}`]: a.head, [`refs/heads/${b.branch}`]: wip };
  const decide = (input: { wipPushes?: boolean; refs?: Record<string, string>; others?: typeof others }) => {
    const decision = decideDiscovery({ expect: expectOf(a), attempted: true, refsBefore: main, others: input.others ?? others,
      ...(input.wipPushes === undefined ? { wipPushes: true } : { wipPushes: input.wipPushes }), observation: observed(a, input.refs ?? now) });
    return [decision.outcome, decision.reasons];
  };
  assert.deepEqual(decide({}), ['incomplete', [`CONCURRENT_WORK_PUSH_UNSETTLED:refs/heads/${b.branch}`]], 'the gate has not confirmed it yet: read again');
  assert.deepEqual(decide({ wipPushes: false }), ['blocked', [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`]], 'with a persistent disk no Builder pushes work in progress');
  assert.deepEqual(decide({ refs: { ...now, 'refs/tags/v9': a.head } }), ['blocked', [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch},refs/tags/v9`]], 'a real change is never held back');
  assert.deepEqual(decideDiscovery({ expect: expectOf(a), attempted: true, refsBefore: { ...main, [`refs/heads/${b.branch}`]: wip }, others, wipPushes: true,
    observation: observed(a, { ...main, [`refs/heads/${a.branch}`]: a.head }) }).outcome, 'blocked', 'a deletion is not a push');
  // That Execution ended (slot released) without Control recording the head: unexpected.
  const ended = otherPublications([{ ...running, execution: { ...live, state: 'ended', slot: { held: false } } }], { workId: a.workId, repositoryId: 3 });
  assert.deepEqual(ended, []);
  assert.deepEqual(decide({ others: ended }), ['blocked', [`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`]]);
});

// Acceptance finding A14: the publish session created the Work's own PR with the correlation marker mistyped by one character. The refusal is
// right, but a human can correct the PR body: the block is re-evaluable and the SAME rule decides again from a new read (nothing is adopted).
test('A14: a block by an unknown pull request after an attempt is re-evaluable; the rule links the PR only once it classifies as own', () => {
  const now = { ...main, [`refs/heads/${a.branch}`]: a.head };
  const mistyped = { ...own(a), body: own(a).body!.replace(a.workId, `${a.workId.slice(0, -1)}0`) };
  const input = { expect: expectOf(a), attempted: true, refsBefore: main, others: [] };
  const first = decideDiscovery({ ...input, observation: { ...observed(a, now), candidates: [mistyped] } });
  assert.deepEqual([first.outcome, first.reasons, first.candidates.map(item => item.reasons)], ['blocked', [`UNKNOWN_PULL_REQUEST:${a.pull}`], [['MARKER_ABSENT']]]);
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: first.reasons })), { ok: true });
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: [...first.reasons, `UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`] })), { ok: true }, 'both re-evaluable reasons together');
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: first.reasons, attempts: [] })), { ok: false, code: 'PUBLICATION_NOT_ATTEMPTED' });
  // Marker corrected by a human: the same PR now classifies as own and everything else of the rule still applies.
  const corrected = decideDiscovery({ ...input, observation: observed(a, now) });
  assert.deepEqual([corrected.outcome, corrected.reasons], ['linked', []]);
  // A marker alone adopts nothing: another author stays unknown, and a corrected own PR at another head is blocked by the rule.
  const human = decideDiscovery({ ...input, observation: { ...observed(a, now), candidates: [{ ...own(a), author: { id: 7, login: 'someone', type: 'User' } }] } });
  assert.deepEqual([human.outcome, human.reasons], ['blocked', [`UNKNOWN_PULL_REQUEST:${a.pull}`]]);
  const moved = decideDiscovery({ ...input, known: { heads: [], pullRequestId: null, expected: null, authorized: null },
    observation: { ...observed(a, { ...main, [`refs/heads/${a.branch}`]: 'e'.repeat(40) }), branch: { state: 'present', sha: 'e'.repeat(40) }, candidates: [{ ...own(a), headSha: 'e'.repeat(40) }] } });
  assert.notEqual(moved.outcome, 'linked');
  // The operator is told exactly what to correct and which command to run.
  const marker = publicationMarker(a.workId);
  assert.equal(reevaluationGuidance(first.reasons, { workId: a.workId, marker }), ` If pull request #${a.pull} is this Work's own publication with a wrong marker, correct the ` +
    `marker line of its body to exactly \`${marker}\` and re-evaluate with \`factory reevaluate-publication ${a.workId} --reason <text>\`.`);
  assert.equal(reevaluationGuidance([`UNEXPECTED_REF_CHANGE:refs/heads/${b.branch}`], { workId: a.workId, marker }),
    ` If the changed refs are another Work's own publication, re-evaluate with \`factory reevaluate-publication ${a.workId} --reason <text>\`.`);
  assert.equal(reevaluationGuidance(['PULL_REQUEST_NOT_DRAFT', ...first.reasons], { workId: a.workId, marker }), '', 'no command where it does not apply');
});

// Acceptance finding A6 (sandbox without a persistent disk): the discovery in the boot decided nothing (e.g. the base protection read was
// denied) while Control's own evidence showed the verified commit on the Work's own branch on origin. The block was a dead end.
test('A6: a live basis whose verified commit Control knows to be on the own branch is recoverable; anything else keeps the block, worded by what is known', () => {
  const discovery = (branch: PublicationView['discoveries'][number]['branch']) => ({ at: 'x', observedAt: 'x', trigger: 'verified' as const, outcome: 'incomplete' as const,
    reasons: ['BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED'], branch, candidates: [] });
  const live = (overrides: Partial<PublicationView> = {}) => blocked({ reasons: [unpublishedBeforeStop, 'BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED'], refsBefore: null, attempts: [],
    discoveries: [discovery({ state: 'absent' })], ...overrides });
  const gate = { branch: a.branch, heads: ['9'.repeat(40), a.head] };
  // Evidence: the latest discovery read the own branch at the verified head, or a preservation gate confirmed that head on the own branch.
  assert.equal(verifiedHeadOnOrigin(live(), null), false);
  assert.equal(verifiedHeadOnOrigin(live({ discoveries: [discovery({ state: 'present', sha: a.head })] }), null), true);
  assert.equal(verifiedHeadOnOrigin(live({ discoveries: [discovery({ state: 'present', sha: a.head }), discovery({ state: 'present', sha: 'e'.repeat(40) })] }), null), false, 'only the latest read');
  assert.equal(verifiedHeadOnOrigin(live(), gate), true);
  assert.equal(verifiedHeadOnOrigin(live(), { branch: b.branch, heads: [a.head] }), false, 'a confirmation of another branch proves nothing');
  assert.equal(verifiedHeadOnOrigin(live(), { branch: a.branch, heads: ['9'.repeat(40)] }), false);
  assert.equal(liveBasisRecoverable(live(), gate), true);
  assert.equal(liveBasisRecoverable(live(), null), false);
  assert.equal(liveBasisRecoverable(live({ reasons: [unpublishedBeforeStop, 'PROMPT_TOO_LARGE'] }), gate), false, 'not an undecided read: repeating cannot decide it');
  assert.equal(liveBasisRecoverable(live({ reasons: ['BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED'] }), gate), false, 'not a live-basis block');
  assert.equal(liveBasisRecoverable(live({ ...attempted(a) }), gate), false, 'an attempted head is decided only by the discovery after it');
  assert.equal(liveBasisRecoverable(live({ state: 'awaiting-discovery' }), gate), false);
  // Works already blocked in this state: the operator command lifts the block back to the ordinary discovery.
  assert.deepEqual(reevaluationEligibility(live(), gate), { ok: true, liveBasis: true });
  assert.deepEqual(reevaluationEligibility(live({ discoveries: [discovery({ state: 'present', sha: a.head })] })), { ok: true, liveBasis: true });
  assert.deepEqual(reevaluationEligibility(live()), { ok: false, code: `NOT_REEVALUABLE:${unpublishedBeforeStop},BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED` });
  assert.deepEqual(reevaluationEligibility(blocked(), gate), { ok: true }, 'the ticket 61 path is unchanged');
  // Lifted: the ordinary (non-live) discovery reads again after the boot ended, as for a basis that was never attempted.
  assert.deepEqual(publicationStep({ result: 'open', execution: execution(), publication: live({ state: 'awaiting-discovery', reasons: ['BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED'] }) }),
    { kind: 'discover', trigger: 'verified', attempted: false });
  // The block that remains says what is known: an incomplete read never proves that the commit is gone.
  const step = unpublishedBeforeStopStep(a.head, ['REFS_UNKNOWN:GITHUB_QUERY_FAILED']);
  assert.equal(step, `The verified commit ${a.head} was not published before its boot ended (REFS_UNKNOWN:GITHUB_QUERY_FAILED) and Control has not confirmed it on the Work branch on origin; ` +
    'the sandbox keeps no disk, so the commit survives only if it was pushed there. If a preservation gate confirms it, the block lifts by itself and the ordinary discovery ' +
    'publishes it; otherwise the operator decides explicitly (a new Execution reproduces the work from the Ticket).');
});
