import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PreservationObservation } from '../../src/contracts/index.js';
import { gateCorrectionPrompt, gateDecision, gateHold, gateRefusalLimit, preservedHeads, recordPreserved } from '../../src/control/rules/preservation.js';
import { knownRemote } from '../../src/control/rules/divergence.js';
import { decideDiscovery } from '../../src/control/rules/publication.js';
import type { PublicationView } from '../../src/control/types.js';

// v2 ticket 07 (V2-05..V2-07, pure rules): what the preservation gate accepts, the six refusals of proof G1 each under its own reason, the
// instruction that returns a refusal to the Builder and the block after three refusals in a row.

const head = 'a'.repeat(40), other = 'b'.repeat(40);
const guest = (patch: Partial<Extract<PreservationObservation, { status: 'observed' }>> = {}): PreservationObservation =>
  ({ status: 'observed', head, modified: 0, untracked: 0, stashes: 0, remote: { state: 'present', sha: head }, ...patch });
const origin = { state: 'present' as const, sha: head };

test('the gate accepts only a clean workspace without stash whose HEAD is the Work branch tip on `origin`, and names that commit', () => {
  assert.deepEqual(gateDecision({ observation: guest(), origin }), { outcome: 'accepted', commit: head });
});

test('the six dirty cases of G1 are refused, each with its own reason', () => {
  const refusal = (observation: PreservationObservation, control: Parameters<typeof gateDecision>[0]['origin'] = origin) => {
    const decision = gateDecision({ observation, origin: control });
    assert.equal(decision.outcome, 'refused');
    return decision.outcome === 'refused' ? decision.code : '';
  };
  const codes = [
    refusal(guest({ modified: 2 })),
    refusal(guest({ untracked: 1 })),
    refusal(guest({ stashes: 1 })),
    refusal(guest({ remote: { state: 'present', sha: other } })),
    refusal(guest({ remote: { state: 'unavailable' } })),
    // The guest says "published", Control's own read of `origin` does not show that commit.
    refusal(guest(), { state: 'present', sha: other }),
  ];
  assert.deepEqual(codes, ['WORKSPACE_MODIFIED', 'WORKSPACE_UNTRACKED', 'STASH_PRESENT', 'HEAD_NOT_PUBLISHED', 'REMOTE_UNAVAILABLE', 'REMOTE_UNCONFIRMED']);
  assert.equal(new Set(codes).size, 6);
  // A branch that does not exist on `origin` yet is an unpublished commit; a read Control could not make confirms nothing.
  assert.equal(refusal(guest({ remote: { state: 'absent' } })), 'HEAD_NOT_PUBLISHED');
  assert.equal(refusal(guest(), { state: 'unknown', code: 'ORIGIN_NOT_READ' }), 'REMOTE_UNCONFIRMED');
  assert.equal(refusal(guest(), { state: 'absent' }), 'REMOTE_UNCONFIRMED');
  // No observation is never preservation.
  assert.equal(refusal({ status: 'unavailable', code: 'CHANNEL_CLOSED' }), 'GATE_OBSERVATION_UNAVAILABLE');
  // The local state is reported before the remote one: it is what the Builder corrects first.
  assert.equal(refusal(guest({ modified: 1, untracked: 1, stashes: 1, remote: { state: 'unavailable' } })), 'WORKSPACE_MODIFIED');
});

test('the refusal diagnostic carries the facts the Builder needs', () => {
  const decision = gateDecision({ observation: guest({ remote: { state: 'present', sha: other } }), origin });
  assert.deepEqual(decision, { outcome: 'refused', code: 'HEAD_NOT_PUBLISHED', detail: `HEAD ${head} is not the tip of the Work branch on origin (${other})` });
});

test('the instruction returned to the Builder names the reason, the one push allowed and forbids versioning secrets', () => {
  const prompt = gateCorrectionPrompt({ occasion: 'question', refusal: { code: 'WORKSPACE_UNTRACKED', detail: '1 untracked file(s) not ignored' }, attempt: 1,
    branch: 'factory/3-0123abcd', push: 'git -C /workspace/checkout push https://github.com/acme/project.git HEAD:refs/heads/factory/3-0123abcd', pullRequest: false });
  assert.match(prompt, /WORKSPACE_UNTRACKED: 1 untracked file\(s\) not ignored/);
  assert.ok(prompt.includes('git -C /workspace/checkout push https://github.com/acme/project.git HEAD:refs/heads/factory/3-0123abcd'));
  assert.match(prompt, /refusal 1 of 3/);
  assert.match(prompt, /work in progress/i);
  assert.match(prompt, /no pull request is needed/i);
  assert.match(prompt, /does not authorize committing secrets/i);
  assert.match(prompt, /report the impediment instead of forcing the commit/i);
});

test('three refusals in a row block with the diagnostic of the last one', () => {
  assert.equal(gateRefusalLimit, 3);
  const hold = gateHold({ occasion: 'ci-wait', refusal: { code: 'STASH_PRESENT', detail: '2 stash entr(ies)' } });
  assert.equal(hold.code, 'PRESERVATION_GATE_REFUSED');
  assert.match(hold.detail, /STASH_PRESENT: 2 stash entr\(ies\)/);
  assert.match(hold.nextStep, /3 times in a row/);
});

test('commits confirmed by the gate are the Factory\'s own on `origin`: a WIP tip is never taken for a human change', () => {
  const first = recordPreserved(null, { commit: head, branch: 'factory/3-x', confirmedAt: 't1', executionId: 'e1', boot: 'b1', occasion: 'question' });
  const second = recordPreserved(first, { commit: other, branch: 'factory/3-x', confirmedAt: 't2', executionId: 'e2', boot: 'b2', occasion: 'ci-wait' });
  assert.deepEqual([second.commit, second.occasion, second.heads], [other, 'ci-wait', [head, other]]);
  assert.deepEqual(preservedHeads({ preservation: second }), [head, other]);
  assert.deepEqual(preservedHeads({}), []);
  const publication = { linkedHeads: [], attempts: [], discoveries: [], divergences: [], verified: { head: 'c'.repeat(40) } } as unknown as PublicationView;
  assert.deepEqual(knownRemote(publication, false, false, [head]).heads, [head]);
  // No PR yet, the Work branch holds a gate-confirmed WIP commit: the verified head is published over exactly that tip (lease), not blocked.
  const expect = { workId: 'w', ticketNumber: 3, branch: 'factory/3-x', base: 'main', repositoryId: 3, head: 'c'.repeat(40), app: { login: 'factory-app[bot]', id: 1 } };
  const observation = { kind: 'observed' as const, repositoryId: 3, candidates: [], branch: { state: 'present' as const, sha: head },
    refs: { state: 'complete' as const, refs: {} }, baseProtection: { state: 'pull-request-required' as const } };
  const decide = (heads: string[]) => decideDiscovery({ expect: expect as never, attempted: false, known: knownRemote(publication, false, false, heads), observation: observation as never });
  assert.deepEqual(decide([]).reasons, ['REMOTE_BRANCH_UNKNOWN_CHANGE']);
  const decision = decide([head]);
  assert.equal(decision.outcome, 'absent');
  assert.deepEqual(decision.outcome === 'absent' ? decision.expectedRemote : null, { state: 'present', sha: head });
});

test('the push the instruction names is exactly the one the Builder Host allows', async () => {
  const { gateCorrectionPush } = await import('../../src/control/rules/preservation.js');
  const { allowedWipPush } = await import('../../src/workers/push-policy.js');
  const remote = 'https://github.com/acme/project.git', branch = 'factory/3-0123abcd';
  assert.equal(gateCorrectionPush(branch, remote), allowedWipPush({ branch, remote }));
});
