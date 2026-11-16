import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configurationEntry, dependencyChecks, effectCalls, forgetChecks, humanSteps, installationUrl, membership, phaseGuard, pinned, probeVerdict, q25, repositoryB, repositoryC,
  writeSetupSteps } from './ghdep34-qualification.js';

// R-GH-DEP recipe safety on controlled data only (never the real root, a real gh, GitHub, the q25 storage or its environment).
test('phase guard: pinned issues, one shot, each phase after the previous one succeeded', () => {
  const none = new Set<string>();
  const ok = { status: 'success' };
  assert.equal(phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, none, true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('cleanup-forget', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('unconfigured', { preflight: ok, 'cleanup-forget': { status: 'held' } }, none, true), 'CLEANUP_FORGET_SUCCESS_REQUIRED',
    'the forgotten own blocker must exist before GitHub is read');
  assert.equal(phaseGuard('configured', { preflight: ok, unconfigured: ok }, none, true), null);
  assert.equal(phaseGuard('inspect', { preflight: ok }, none, true), null);
});

const B = repositoryB.repository, A = 'Sanmoo/java-springboot-event-sourcing';
const blocker = (repository: string, extra: Record<string, unknown>) => ({ repository, number: 1, state: 'open', stateReason: null, ...extra });
const work = (latest: Record<string, unknown>) => ({ dependencies: { latest }, execution: null, previousExecutions: [] });
const hidden = work({ conclusion: 'inconclusive', completeness: 'incomplete', reasons: [{ code: 'DEPENDENCY_COUNT_MISMATCH', repository: A }], blockers: [],
  principals: [{ repository: A, role: 'executable', installationId: 177599217 }] });
const forgotten = (state = 'open') => work({ conclusion: 'pending', completeness: 'complete', reasons: [], principals: [],
  blockers: [blocker(A, { number: q25.number, state, stateReason: state === 'closed' ? 'completed' : null, repositoryRole: 'executable', classification: 'own', satisfied: false,
    reason: 'OWN_CYCLE_CANCELLED', work_id: q25.cycle2 })] });
test('dependency checks: B refused when not configured, read with ITS installation when configured; the hidden blocker never released; the forgotten own Ticket stays own', () => {
  const unconfigured = { a1: work({ conclusion: 'inconclusive', completeness: 'incomplete', reasons: [{ code: 'DEPENDENCY_REPOSITORY_NOT_CONFIGURED', repository: B }],
    blockers: [blocker(B, { repositoryRole: 'not-configured', classification: 'external', satisfied: false })], principals: [{ repository: A, role: 'executable', installationId: 177599217 }] }),
  a2: hidden, a3: forgotten() };
  assert.deepEqual(dependencyChecks('unconfigured', unconfigured).filter(item => !item.met).map(item => item.id), []);
  const leaked = { ...unconfigured, a1: work({ ...(unconfigured.a1.dependencies.latest), principals: [{ repository: B, role: 'dependency-only', installationId: 1 }] }) };
  assert.deepEqual(dependencyChecks('unconfigured', leaked).filter(item => !item.met).map(item => item.id), ['unconfigured.a1-not-configured'], 'B read without configuration fails');
  const principal = [{ repository: B, role: 'dependency-only', installationId: 177599217 }];
  const open = { a1: work({ conclusion: 'pending', completeness: 'complete', reasons: [], principals: principal,
    blockers: [blocker(B, { repositoryRole: 'dependency-only', classification: 'external', satisfied: false, reason: 'EXTERNAL_BLOCKER_OPEN' })] }), a2: hidden, a3: forgotten() };
  assert.deepEqual(dependencyChecks('configured-open', open).filter(item => !item.met).map(item => item.id), []);
  const closed = { a1: work({ conclusion: 'satisfied', completeness: 'complete', reasons: [], principals: principal,
    blockers: [blocker(B, { state: 'closed', stateReason: 'completed', repositoryRole: 'dependency-only', classification: 'external', satisfied: true, reason: null })] }),
  a2: hidden, a3: forgotten('closed') };
  assert.deepEqual(dependencyChecks('configured-closed', closed).filter(item => !item.met).map(item => item.id), []);
  assert.ok(dependencyChecks('configured-closed', { ...closed, a3: forgotten('open') }).some(item => item.id === 'configured-closed.a3-forgotten-own' && !item.met),
    'the own blocker must be proven while its issue is closed/completed');
  const external = work({ ...forgotten('closed').dependencies.latest, conclusion: 'satisfied',
    blockers: [blocker(A, { number: q25.number, state: 'closed', stateReason: 'completed', classification: 'external', satisfied: true, reason: null })] });
  assert.ok(dependencyChecks('configured-closed', { ...closed, a3: external }).some(item => item.id === 'configured-closed.a3-forgotten-own' && !item.met), 'never external');
  const released = { ...closed, a2: work({ conclusion: 'satisfied', completeness: 'complete', reasons: [], blockers: [], principals: [] }) };
  assert.ok(dependencyChecks('configured-closed', released).some(item => item.id === 'configured-closed.a2-omission-detected' && !item.met), 'an omission never releases');
  const dispatched = { ...closed, a1: { ...closed.a1, execution: { executionId: 'e' } } };
  assert.ok(dependencyChecks('configured-closed', dispatched).some(item => item.id === 'configured-closed.nothing-dispatched' && !item.met));
});

test('forget checks (V-14.f): refused before the cleanup, environment removed with its marker, both cycles forgotten with a minimal memory, no remote effect', () => {
  const memory = { work_id: q25.cycle1, cycle: 1, result: 'cancelled', forgottenAt: 't' };
  const result = { firstPlan: { outcome: 'not-applied', plan: { refusals: [{ code: 'RESOURCES_PENDING' }] } }, cleanupConfirm: { outcome: 'accepted' },
    removals: [{ environment: q25.environment, status: 'success' }], secondPlan: { plan: { state: 'planned' } }, shown1: { kind: 'work-forgotten', memory },
    recordsAfter: { present: false }, cancel2: { outcome: 'accepted' }, shown2: { kind: 'work-forgotten', memory: { ...memory, work_id: q25.cycle2 } }, remoteCalls: 0 };
  const environment = { removedMarker: true, leftovers: [] };
  assert.deepEqual(forgetChecks(result, environment).filter(item => !item.met).map(item => item.id), []);
  assert.deepEqual(forgetChecks(result, { removedMarker: true, leftovers: ['root.qcow2'] }).filter(item => !item.met).map(item => item.id), ['forget.environment-removed-in-place']);
  assert.deepEqual(forgetChecks({ ...result, shown1: { kind: 'work-forgotten', memory: { ...memory, body: 'x' } } }, environment).filter(item => !item.met).map(item => item.id),
    ['forget.cycle1-forgotten'], 'a memory key outside the allowed shape fails');
  assert.deepEqual(forgetChecks({ ...result, remoteCalls: 1 }, environment).filter(item => !item.met).map(item => item.id), ['forget.no-remote-call']);
  assert.ok(forgetChecks(null, null).every(item => !item.met), 'a no-op meets nothing');
  assert.ok(effectCalls.includes('workers.activate') && effectCalls.includes('postComment') && !effectCalls.includes('listCandidates'));
});

test('setup steps are written into a NEW local directory only (no GitHub): repositories with installation, issues with native relations, the configuration entry', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'q34-dep-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = await writeSetupSteps(join(parent, 'setup'));
  assert.deepEqual((await readdir(directory)).sort(), ['configuration-entry.yaml', 'human-step-installation-requested.json', 'human-step-issues-requested.json',
    'human-step-repositories-requested.json']);
  assert.equal(await readFile(join(directory, 'configuration-entry.yaml'), 'utf8'), configurationEntry);
  const issues = JSON.parse(await readFile(join(directory, 'human-step-issues-requested.json'), 'utf8')) as { apply: string[] };
  assert.ok(issues.apply.at(-1)!.includes('pin in ghdep34-qualification.ts'));
  await assert.rejects(writeSetupSteps(join(parent, 'setup')), /EEXIST/, 'never adopts an existing directory');
  const steps = humanSteps({ b1: 4, c1: 2, a: [40, 41, 42] });
  assert.ok(steps['close-blockers'].apply[0]!.startsWith(`gh issue close 4 --repo ${B} --reason completed`));
  assert.ok(steps.teardown.apply.filter(line => line.includes('--remove-label ready-for-agent')).length === 3);
  assert.deepEqual(Object.values(pinned), [0, 0, 0, 0, 0], 'pinned only in a reviewed commit after the setup');
});

test('setup with the tokens we have: no /user/installations call (needs a GitHub App user token); B joins in the browser; the App key verifies B in and C out', () => {
  const steps = humanSteps();
  const all = Object.values(steps).flatMap(step => [...step.apply, ...step.restore]);
  assert.ok(!all.some(line => line.includes('/user/installations')), 'the operator\'s classic OAuth gh token gets 403 on the /user/installations family');
  assert.equal(installationUrl, 'https://github.com/settings/installations/177599217');
  const installation = steps.installation;
  assert.ok(installation.apply.some(line => line.includes(installationUrl) && line.includes(repositoryB.repository) && line.includes('Only select repositories')),
    'the exact browser action is written for the operator');
  assert.ok(installation.apply.at(-1)!.includes('ghdep34-qualification.js --probe-installation'), 'verified afterwards with the App key');
  assert.ok(steps.repositories.apply.some(line => line.startsWith(`gh repo create ${repositoryB.repository} --public`)));
  assert.ok(steps.repositories.apply.some(line => line.startsWith(`gh repo create ${repositoryC.repository} --private`)));
  assert.ok(!steps.repositories.apply.some(line => /installation/.test(line.split('#')[0]!)), 'creating the repositories touches no installation');
  assert.ok(steps.teardown.apply.some(line => line.startsWith(`gh repo delete ${repositoryB.repository}`)), 'deleting B also removes it from the installation');
});

test('installation probe: membership only from the App\'s own issuance (a 422 for a repository outside the installation); anything else is unknown, never a pass', () => {
  assert.equal(membership({ ok: true }), 'installed');
  assert.equal(membership({ ok: false, code: 'GITHUB_QUERY_FAILED' }), 'not-installed');
  assert.equal(membership({ ok: false, code: 'GITHUB_TRANSPORT_UNAVAILABLE' }), 'unknown:GITHUB_TRANSPORT_UNAVAILABLE');
  assert.equal(membership({ ok: false, code: 'GITHUB_TOKEN_ISSUANCE_UNKNOWN' }), 'unknown:GITHUB_TOKEN_ISSUANCE_UNKNOWN');
  assert.deepEqual(probeVerdict('installed', 'not-installed'), { ok: true, reasons: [] });
  assert.deepEqual(probeVerdict('not-installed', 'not-installed').reasons, [`${repositoryB.repository}: not in installation 177599217 (do the browser step)`]);
  assert.deepEqual(probeVerdict('installed', 'installed').reasons, [`${repositoryC.repository}: in installation 177599217 (remove it there; it must stay hidden)`]);
  assert.equal(probeVerdict('installed', 'unknown:GITHUB_TRANSPORT_UNAVAILABLE').ok, false);
});
