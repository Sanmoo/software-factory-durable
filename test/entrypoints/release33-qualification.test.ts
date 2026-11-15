import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the real upgrade verification recipe must be inert: no process, filesystem or network effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:fs', 'node:https']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, spawnSync: deny, spawn: deny, request: deny, open: deny, mkdir: deny,
    readFile: deny, access: deny, readdir: deny, lstat: deny, createReadStream: deny }, defaultExport: deny });
}
const recipe = await import('./release33-qualification.js');

test('upgrade recipe: import and --plan are inert; fresh exclusive base, v1 = the built r32 archive (read only), no external effect', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.equal(plan.base, '/home/sanmoo/software-factory-test/r33-v2');
  assert.ok(plan.root.startsWith(`${plan.base}/`) && plan.output.startsWith(`${plan.base}/`) && plan.observations.startsWith(`${plan.base}/`));
  assert.equal(plan.v1.build.startsWith(plan.base), false, 'v1 is only read');
  assert.deepEqual([plan.v1.release, plan.v2.release, plan.migration], ['mvp-32.1', 'mvp-33.1', 'factory-storage-1-to-2']);
  assert.deepEqual(plan.phases, ['build', 'install-v1', 'seed-v1', 'extract-v2', 'check-and-refusals', 'interrupted-migration', 'start-v2']);
  assert.deepEqual(plan.guestAssets.manifestSha256, '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807');
  assert.match(plan.bounds.network, /^none/);
  assert.deepEqual([plan.bounds.github, plan.bounds.model, plan.bounds.retries], ['none', 'none', 0]);
  for (const phase of plan.phases) {
    const tombstone = recipe.tombstonePath(phase);
    assert.equal(tombstone, `/home/sanmoo/software-factory-test/r33-v2/intent-${phase}.json`, 'inside the base, no sibling file');
  }
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main(['build', 'install-v1']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('upgrade recipe VERDICT: generic start failures (the r33-v1 run) fail every phase; only the exact expected outcomes pass', () => {
  const refused = { status: 3, stdout: '', stderr: '{"code":"CONTROLLER_START_FAILED"}', report: null };
  const generic = { status: 'observed', check: refused, whileRunning: { observed: { notReady: true }, end: { code: 3 } }, unpaused: { observed: { notReady: true }, end: { code: 3 } },
    unpausedCheck: refused, repaused: { observed: { notReady: true }, end: { code: 3 } }, notRequested: refused, before: { status: refused, launcher: 'a' }, after: { status: refused, launcher: 'a', journal: false },
    cut1: { signal: 'SIGKILL' }, afterCut1: refused, cut2: { signal: 'SIGKILL' }, afterCut2: refused, guarded: { status: 2, code: 'UPGRADE_INCOMPLETE' }, v1Refused: { codes: ['CONTROLLER_START_FAILED'] },
    afterV1: refused, rollback: refused, resume: refused, launcherSha256: 'x', v2LauncherSha256: 'y', seed: { status: 0, report: { works: [1, 2] } },
    v1run: { observed: { notReady: true }, end: { code: 3 } }, doctor: { status: 3, report: null }, run: { observed: { notReady: true }, end: { code: 2 } } };
  for (const phase of ['seed-v1', 'check-and-refusals', 'interrupted-migration', 'start-v2'] as const) {
    const evaluated = recipe.verdict(phase, generic);
    assert.equal(evaluated.ok, false, phase);
    assert.ok(evaluated.checks.length > 3 && evaluated.checks.filter(item => !item.ok).length > 1, phase);
  }
  assert.equal(recipe.verdict('build', {}).ok, false, 'an empty observation never passes');
  const extracted = { status: 'success', before: { v1: 'a', assets: 'b', launcher: 'c' }, after: { v1: 'a', assets: 'b', launcher: 'c' }, releases: ['mvp-32.1', 'mvp-33.1'] };
  assert.equal(recipe.verdict('extract-v2', extracted).ok, true);
  assert.equal(recipe.verdict('extract-v2', { ...extracted, after: { ...extracted.after, v1: 'changed' } }).ok, false);
  const interrupted = { cut1: { signal: 'SIGKILL' }, cut2: { signal: 'SIGKILL' },
    afterCut1: { report: { code: 'UPGRADE_INCOMPLETE', journal: { state: 'migrating' }, storage: { format: 1, preserved: { digest: 'p' }, stateDigest: 's1' } } },
    afterCut2: { report: { code: 'UPGRADE_INCOMPLETE', journal: { state: 'migrated' }, storage: { format: 2, preserved: { digest: 'p' }, stateDigest: 's2' } } },
    afterV1: { report: { storage: { stateDigest: 's2' } } }, guarded: { status: 2, code: 'UPGRADE_INCOMPLETE' }, v1Refused: { codes: ['RELEASE_INVALID'] },
    rollback: { report: { code: 'ROLLBACK_FORMAT_UNSUPPORTED' } }, resume: { report: { code: 'UPGRADE_COMPLETED', storage: { migrations: [{}] } } }, launcherSha256: 'l', v2LauncherSha256: 'l' };
  assert.deepEqual(recipe.verdict('interrupted-migration', interrupted).checks.filter(item => !item.ok), []);
});
