import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker } from '../../src/issue-tracker/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';
import { openControl, type ExecutionPorts, type ListView, type ShowView } from '../../src/control/index.js';
import { manualClock } from '../control/doubles.js';
import { ownHead, seedPublishedStorage } from '../control/checks-seed.js';
import { checkRun, commitStatus, githubWorld, issue, pull, worldScope } from './github-world-fixture.js';

// Ticket 15 composed level (I with a substituted boundary): public Control (owner loop, polling, dispatcher tick, Pi Durable/SQLite) + the
// real IssueTracker/CodeRepository adapters, GitHub access and gh transport; only gh/GitHub is the local world fixture. The linked own PR
// is SEEDED in ticket 14's record shape (14 not yet integrated in this branch). Not evidence of real GitHub.
const tip = 'b'.repeat(40);
const own = pull(7, { head: { ref: 'factory/3-abcdef12', repo: { id: 3 } }, user: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } });

test('AC1-AC7 composed: after a polling cycle the tick explains the own PR checks from real GitHub reads, durably, without any execution effect', async t => {
  const fixture = await githubWorld(t, { issues: [issue(3)], pulls: [own], pageSize: 1, checks: {
    details: { 7: { head_sha: ownHead, mergeable: null, mergeable_state: 'unknown' } },
    branches: { main: { sha: tip, protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['build'] } } } },
    requiredStatusChecks: { main: { strict: false, contexts: ['build'], checks: [{ context: 'build', app_id: 15368 }] } },
    rules: { main: [{ type: 'required_status_checks', ruleset_source_type: 'Organization', ruleset_source: 'acme', ruleset_id: 11,
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci/external' }] } }] },
    checkRuns: { [ownHead]: [checkRun(1, 'build', { conclusion: 'failure' }), checkRun(2, 'build', { status: 'in_progress', conclusion: null }), checkRun(3, 'docs', { conclusion: 'failure' })] },
    statuses: { [ownHead]: [commitStatus(10, 'ci/external', 'success')] },
    compare: { [`${tip}...${ownHead}`]: { status: 'ahead', ahead_by: 1, behind_by: 0 } } } });
  const github = createGitHubAccess({ root: fixture.root, executable: fixture.executable, appId: 1, privateKeyFile: 'credentials/app.pem' });
  const access = { tracker: createIssueTracker({ github, scopes: [worldScope] }), repository: createCodeRepository({ github }), repositories: [worldScope] };
  const storagePath = join(fixture.root, 'c.sqlite');
  const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 600; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition not reached'); };
  // 1. Admission only (no execution composed): the Ticket becomes a Work.
  const admitting = await openControl({ storagePath, runtimeInventory: 'empty', access, polling: { intervalSeconds: 60, clock: manualClock().clock } });
  const stopAdmission = new AbortController();
  const admissionRun = admitting.run(stopAdmission.signal);
  await until(async () => ((await admitting.inspect({ kind: 'list' })) as ListView).works.length === 1);
  stopAdmission.abort();
  assert.deepEqual(await admissionRun, { kind: 'clean' });
  // 2. Ticket 14's record of the linked own draft PR #7 (seeded), then an owner with execution composed: the tick runs the checks pass.
  const workId = await seedPublishedStorage(storagePath, { requiredChecks: ['build', 'local-only'] });
  const effects: string[] = [];
  const refuse = (name: string) => async () => { effects.push(name); throw new Error('UNEXPECTED_EXECUTION_EFFECT'); };
  const ports: ExecutionPorts = { configuration: { schemaVersion: 1 }, capacity: 1, builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true },
    sandbox: { prepare: refuse('prepare'), start: refuse('start'), stop: refuse('stop') }, workers: { activate: refuse('activate'), deliver: refuse('deliver') },
    credentials: { issue: refuse('issue'), revoke: refuse('revoke') } };
  const time = manualClock();
  const control = await openControl({ storagePath, runtimeInventory: 'empty', access, execution: ports, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const show = async () => (await control.inspect({ kind: 'show', work_id: workId })) as Extract<ShowView, { kind: 'work' }>;
  await until(async () => Boolean((await show()).work.checks));
  const view = (await show()).work;
  const latest = view.checks!.latest;
  assert.equal(latest.outcome, 'waiting');
  assert.deepEqual(latest.requirements.map(item => [item.context, item.integrationId, item.sources, item.state, item.results.map(result => result.id)]), [
    ['build', 15368, ['classic'], 'waiting', [2]], ['ci/external', null, ['ruleset:11:Organization:acme'], 'satisfied', [10]]],
    'the in-progress rerun is current: the older failure neither repairs nor borrows');
  assert.deepEqual(latest.reasons, [{ category: 'wait', code: 'REQUIRED_CHECK_PENDING', subject: 'build' }]);
  assert.deepEqual(latest.optional.map(item => [item.name, item.classification]), [['docs', 'failed']], 'an optional failure is only visible');
  assert.deepEqual([latest.conflict, latest.requiredSet, latest.strict.state], ['unknown', 'non-empty', 'not-required']);
  assert.deepEqual(latest.localGates, { declared: ['build', 'local-only'], requiredByGitHub: ['build'], notRequiredByGitHub: ['local-only'] });
  assert.ok(Object.values(latest.completeness).every(value => value === 'complete'));
  assert.ok(latest.observedAt && latest.completedAt && latest.observedAt <= latest.completedAt);
  assert.deepEqual([effects, view.queue.pending, view.impediments.map(item => item.code)], [[], false, []], 'tracking only: no prepare/start/activate/grant, no impediment');
  const trace = await fixture.trace();
  assert.ok(trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'), 'every GitHub request of the run is a read');
  assert.ok(trace.some(entry => entry.endpoint.endsWith('/access_tokens') && JSON.stringify(entry.permissions) ===
    JSON.stringify({ metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', administration: 'read' })));
  stop.abort();
  assert.deepEqual(await running, { kind: 'clean' });
});
