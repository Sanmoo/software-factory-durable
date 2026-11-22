import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideDiscovery, otherPublications, publicationMarker, publicationStep, reevaluationEligibility, unexpectedRefChanges,
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
  assert.deepEqual(reevaluationEligibility(blocked({ reasons: ['UNKNOWN_PULL_REQUEST:7'] })), { ok: false, code: 'NOT_REEVALUABLE:UNKNOWN_PULL_REQUEST:7' });
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
