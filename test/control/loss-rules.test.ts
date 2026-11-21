import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedAt, lossDetail, lossLimit, markerOf, recordLossOn } from '../../src/control/rules/loss.js';
import { planCleanup } from '../../src/control/rules/delivery.js';
import { sessionDecision } from '../../src/control/rules/continuation.js';
import { gateDecision } from '../../src/control/rules/preservation.js';
import type { ExecutionView, LossRecord } from '../../src/control/types.js';

// v2 ticket 12 (V2-16, V2-17, V2-02 Remover): pure rules of the visible loss and of the loss marker ref.
const workId = '0b0f6c0e-5d0e-4c53-9d53-0a4f6f1f3c11', boot = 'boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10', otherBoot = 'boot-7a3d2b63-1e7c-4b65-9b46-4e2a1a1d0b21';
const ref = `refs/factory/lost/${workId}/${boot}`;
const published = 'a'.repeat(40), lost = 'c'.repeat(40), at = '2026-11-21T10:00:00.000Z';

test('the marker of a boot is what a COMPLETE read of origin lists under its exact ref: present with its commit, absent, or unknown', () => {
  assert.deepEqual(markerOf({ workId, boot, read: { state: 'complete', observedAt: at, markers: [{ ref, boot, sha: lost }] } }), { ref, state: 'present', commit: lost, observedAt: at });
  // The marker of ANOTHER boot of the Work is not this boot's marker.
  assert.deepEqual(markerOf({ workId, boot, read: { state: 'complete', observedAt: at, markers: [{ ref: `refs/factory/lost/${workId}/${otherBoot}`, boot: otherBoot, sha: lost }] } }),
    { ref, state: 'absent', observedAt: at });
  assert.deepEqual(markerOf({ workId, boot, read: { state: 'unknown', code: 'GITHUB_QUERY_FAILED' } }), { ref, state: 'unknown', code: 'GITHUB_QUERY_FAILED' });
  assert.deepEqual(markerOf({ workId, boot: 'main', read: { state: 'complete', observedAt: at, markers: [] } }), { ref: null, state: 'unknown', code: 'LOST_MARKER_REF_INVALID' });
});

test('the last confirmed commit is the Work branch on origin, else the last gate acceptance, never the marker', () => {
  const preservation = { commit: published, branch: 'factory/3-x' };
  assert.deepEqual(confirmedAt({ branch: 'factory/3-x', origin: { state: 'present', sha: published }, preservation: null }),
    { commit: published, source: 'origin-read', branch: 'factory/3-x', origin: { state: 'present', sha: published } });
  assert.deepEqual(confirmedAt({ branch: 'factory/3-x', origin: { state: 'unknown', code: 'ORIGIN_NOT_READ' }, preservation }).source, 'preservation-gate');
  // A complete read that finds no branch means nothing was ever published: an older acceptance does not resurrect it.
  assert.deepEqual([confirmedAt({ branch: 'factory/3-x', origin: { state: 'absent' }, preservation }).commit, confirmedAt({ branch: 'factory/3-x', origin: { state: 'absent' }, preservation }).source], [null, 'none']);
  assert.equal(confirmedAt({ branch: 'factory/3-x', origin: { state: 'unknown', code: 'X' }, preservation: { commit: published, branch: 'another' } }).commit, null);
});

const loss = (overrides: Partial<LossRecord> = {}): LossRecord => ({ at, executionId: 'e-1', boot, environment: `env-${'c'.repeat(64)}`, reason: 'MicroVM exceeded maximum lifetime.', terminatedAt: at,
  confirmed: { commit: published, source: 'origin-read', branch: 'factory/3-x', origin: { state: 'present', sha: published } }, consumption: { executionMs: 1200 },
  session: { invocationId: 'builder-e-1', disposition: 'conserved-as-evidence' }, marker: { ref, state: 'present', commit: lost, observedAt: at }, ...overrides });

test('a loss is recorded once per Execution and boot, bounded, and its one line says what is lost and that the marker is not preservation', () => {
  const twice = recordLossOn(recordLossOn(undefined, loss()), loss({ reason: 'again' }));
  assert.deepEqual(twice.map(item => item.reason), ['again']);
  const many = Array.from({ length: lossLimit + 3 }, (_unused, index) => loss({ executionId: `e-${index}` })).reduce<LossRecord[]>((all, item) => recordLossOn(all, item), []);
  assert.deepEqual([many.length, many[0]!.executionId, many.at(-1)!.executionId], [lossLimit, 'e-3', `e-${lossLimit + 2}`]);
  assert.equal(lossDetail(loss()), `${boot}: local work after ${published} is lost; marker ${ref} at ${lost} (not preservation)`);
  assert.match(lossDetail(loss({ marker: { ref, state: 'absent', observedAt: at }, confirmed: { commit: null, source: 'none', branch: 'b', origin: { state: 'absent' } } })), /after the start \(nothing confirmed on origin\) is lost; no marker ref$/);
});

test('NEGATIVE (V2-16): a marker ref holding the guest HEAD never satisfies the gate: only the Work BRANCH on origin does', () => {
  // The guest's own `ls-remote` of the Work branch and Control's own read both show the older tip, although the marker ref holds HEAD.
  const observation = { status: 'observed' as const, head: lost, modified: 0, untracked: 0, stashes: 0, remote: { state: 'present' as const, sha: published } };
  assert.deepEqual(gateDecision({ observation, origin: { state: 'present', sha: published } }).outcome, 'refused');
  assert.equal((gateDecision({ observation, origin: { state: 'present', sha: published } }) as { code: string }).code, 'HEAD_NOT_PUBLISHED');
  // Even a guest that CLAIMS the branch is at HEAD is refused while Control's read of the branch does not confirm it.
  const claimed = gateDecision({ observation: { ...observation, remote: { state: 'present', sha: lost } }, origin: { state: 'present', sha: published } });
  assert.deepEqual([claimed.outcome, (claimed as { code: string }).code], ['refused', 'REMOTE_UNCONFIRMED']);
  // And the confirmed commit of a loss with a marker is the branch tip, not the marker's commit.
  assert.equal(loss().confirmed.commit, published);
});

test('the session of an Execution whose environment was lost is never continued, whatever else is compatible', () => {
  const session = { ref: 'sessions/s1.jsonl', sha256: 'f'.repeat(64) } as never;
  const facts = { skillPack: null, policies: { skillPack: 'p', modelBudget: 'builder-v1' } } as never as { skillPack: null; policies: never };
  const observation = { state: 'compatible', session } as never;
  assert.deepEqual(sessionDecision({ previous: { ...facts, session }, next: facts, observation }), { mode: 'continue', reason: 'SESSION_COMPATIBLE' });
  assert.deepEqual(sessionDecision({ previous: { ...facts, session, environmentLost: true }, next: facts, observation }), { mode: 'replace', reason: 'ENVIRONMENT_LOST' });
});

test('Remove plans the loss marker refs of a Work that ran without a persistent disk, delivered or not, and never its branch for them', () => {
  const execution = (origin: boolean) => ({ executionId: 'e-1', dispatch: { environment: `env-${'c'.repeat(64)}` }, ...(origin ? { origin: { atStart: { state: 'absent' }, startCommit: published } } : {}) }) as never as ExecutionView;
  const work = (result: string, origin: boolean) => ({ work_id: workId, result, branch: 'factory/3-x', repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, execution: null, previousExecutions: [execution(origin)] });
  const markers = (result: string, origin: boolean, repositoryConfigured = true) => planCleanup(work(result, origin), { repositoryConfigured }).resources.filter(item => item.kind === 'lost-markers');
  assert.deepEqual(markers('delivered', true), [{ id: `lost-markers:${workId}`, kind: 'lost-markers', target: `acme/project:refs/factory/lost/${workId}/*`, environment: null,
    ownership: 'Loss marker refs named after this Work in the Factory\'s own ref namespace; each deleted only at the tip a complete read listed' }]);
  assert.equal(markers('cancelled', true).length, 1);
  assert.deepEqual(planCleanup(work('cancelled', true), { repositoryConfigured: true }).resources.filter(item => item.kind === 'remote-branch'), [], 'a cancelled Work keeps its branch');
  // A sandbox that keeps its disk never arms a marker; an unconfigured repository cannot be reached.
  assert.deepEqual([markers('delivered', false), markers('delivered', true, false)], [[], []]);
});
