import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { lostMarkerRef } from '../../src/contracts/index.js';
import { githubWorld, worldScope, type World } from './github-world-fixture.js';

// v2 ticket 12 (V2-16, V2-02 Remover) adapter evidence over the synthetic GitHub executable: the loss marker refs of ONE Work are read
// by a complete listing and deleted one by one, atomically, under a single-use Contents W grant each. Not proof of the real GitHub
// boundary: `updateRefs` on a ref outside `refs/heads/` never ran against GitHub.
const workId = '0b0f6c0e-5d0e-4c53-9d53-0a4f6f1f3c11',
  otherWork = '1c1f6c0e-5d0e-4c53-9d53-0a4f6f1f3c22';
const boots = ['boot-6f2c1a52-0d6b-4a54-8a35-3d1f0f0c9a10', 'boot-7a3d2b63-1e7c-4b65-9b46-4e2a1a1d0b21'];
const refs = boots.map(boot => lostMarkerRef(workId, boot)!);
const foreign = lostMarkerRef(otherWork, boots[0]!)!;
const adapter = (root: string, executable: string) =>
  createCodeRepository({ github: createGitHubAccess({ root, appId: 1, privateKeyFile: 'credentials/app.pem', executable }) });
const base = { issues: [], pulls: [], refs: { 'factory/3-abcdef12': 'a'.repeat(40) } };
const selection = { repo: worldScope, repositoryId: 3, workId };
const stateOf = async (world: { update(change: (world: World) => void): Promise<void> }) => {
  let seen!: World;
  await world.update(value => {
    seen = structuredClone(value);
  });
  return seen;
};

test('readLostMarkers lists the marker refs of one Work only, from a complete read under a read-only grant', async t => {
  const world = await githubWorld(t, { ...base, factoryRefs: { [refs[0]!]: 'c'.repeat(40), [foreign]: 'd'.repeat(40) } });
  const read = await adapter(world.root, world.executable).readLostMarkers!(selection);
  assert.equal(read.state, 'complete');
  assert.deepEqual(read.state === 'complete' && read.markers, [{ ref: refs[0], boot: boots[0], sha: 'c'.repeat(40) }]);
  assert.deepEqual(
    (await world.trace()).filter(entry => entry.permissions).map(entry => entry.permissions?.contents),
    ['read'],
  );
  const none = await githubWorld(t, base, 'none');
  assert.deepEqual(await adapter(none.root, none.executable).readLostMarkers!(selection).then(result => result.state === 'complete' && result.markers), []);
});

test('an unreadable listing is unknown, never "no marker"; an id that is not a Work id reads nothing', async t => {
  const world = await githubWorld(t, {
    ...base,
    factoryRefs: { [refs[0]!]: 'c'.repeat(40) },
    faults: { [`/git/matching-refs/factory/lost/${workId}/`]: { status: 502 } },
  });
  const read = await adapter(world.root, world.executable).readLostMarkers!(selection);
  assert.equal(read.state, 'unknown');
  assert.deepEqual(await adapter(world.root, world.executable).readLostMarkers!({ ...selection, workId: '../heads' }), {
    state: 'unknown',
    code: 'LOST_MARKER_SELECTION_INVALID',
  });
});

test('cleanupLostMarkers deletes every marker ref of the Work atomically and touches no branch and no other Work', async t => {
  const world = await githubWorld(t, { ...base, factoryRefs: { [refs[0]!]: 'c'.repeat(40), [refs[1]!]: 'e'.repeat(40), [foreign]: 'd'.repeat(40) } });
  const result = await adapter(world.root, world.executable).cleanupLostMarkers!(selection, { effectId: 'effect-1' });
  assert.deepEqual([result.outcome, result.code, result.removed, result.remaining], ['removed', 'LOST_MARKERS_DELETED', refs, []]);
  const after = await stateOf(world);
  assert.deepEqual([after.factoryRefs, after.refs], [{ [foreign]: 'd'.repeat(40) }, base.refs]);
  const trace = await world.trace();
  assert.deepEqual(
    trace.filter(entry => entry.method === 'DELETE' && entry.endpoint.includes('/git/refs/')),
    [],
    'never a plain DELETE',
  );
  const sent = trace.filter(entry => entry.method === 'POST' && entry.endpoint === '/graphql').map(entry => JSON.parse(entry.body!).variables.refUpdates[0]);
  assert.deepEqual(
    sent.map(update => [update.name, update.beforeOid, update.force]),
    [
      [refs[0], 'c'.repeat(40), false],
      [refs[1], 'e'.repeat(40), false],
    ],
  );
  // Nothing left: a second attempt proves absence from a complete read and sends nothing.
  const again = await adapter(world.root, world.executable).cleanupLostMarkers!(selection, { effectId: 'effect-2' });
  assert.deepEqual([again.outcome, again.code, again.removed], ['absent', 'LOST_MARKERS_ABSENT', []]);
  assert.equal((await world.trace()).filter(entry => entry.method === 'POST' && entry.endpoint === '/graphql').length, 2);
});

test('cleanupLostMarkers that cannot read the listing deletes nothing and says the outcome is not known', async t => {
  const world = await githubWorld(t, {
    ...base,
    factoryRefs: { [refs[0]!]: 'c'.repeat(40) },
    faults: { [`/git/matching-refs/factory/lost/${workId}/`]: { status: 502 } },
  });
  const result = await adapter(world.root, world.executable).cleanupLostMarkers!(selection, { effectId: 'effect-3' });
  assert.deepEqual([result.outcome, result.removed], ['indeterminate', []]);
  assert.deepEqual((await stateOf(world)).factoryRefs, { [refs[0]!]: 'c'.repeat(40) });
});
