import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareController } from './controller-configuration.js';
import { githubWorld, issue } from './github-world-fixture.js';
import { remainingMs, untilHolds } from '../runner/budget.js';
import type { ControlStatus, ListView, ShowView, WorkView } from '../../src/control/index.js';

// Composition: real CLI, controller owner under flock, protocol socket, Pi Durable/SQLite, IssueTracker/CodeRepository adapters, issuer and gh
// transport. Only gh/GitHub (and the App HTTPS endpoints) are substituted by the local world fixture: NOT evidence of the real GitHub boundary.
function invoke(root: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ['--import', join(root, 'native-fixture.mjs'), resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'],
    {
      env: { PATH: `${root}:${process.env.PATH ?? ''}`, GH_TOKEN: 'synthetic-personal-not-authorized', HOME: '/forbidden-personal-profile' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', data => {
    stdout += String(data);
  });
  child.stderr.on('data', data => {
    stderr += String(data);
  });
  return {
    child,
    result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    }),
  };
}
/** The `--json` view each CLI command prints (the Control's inspection views). */
type Views = { list: ListView; status: ControlStatus; show: ShowView };
const remote = (repository: string, id: number, number: number, overrides: Parameters<typeof issue>[1] = {}) =>
  issue(number, { repository, id, node_id: `I_${id}`, labels: [], ...overrides });

test(
  'CLI list/show/status expose native dependency gating across executable, dependency-only and unconfigured repositories',
  { timeout: remainingMs() },
  async t => {
    const world = await githubWorld(t, {
      pageSize: 1,
      pulls: [],
      repositories: [
        { name: 'acme/project', id: 3, installation: 2 },
        { name: 'acme/deps', id: 4, installation: 2 },
        { name: 'other/lib', id: 5, installation: 6 },
      ],
      issues: [
        issue(1, { blocked_by: [{ number: 2 }, { repository: 'acme/deps', number: 5 }] }),
        issue(2),
        issue(3, { blocked_by: [{ repository: 'other/lib', number: 7 }] }),
        issue(4),
        remote('acme/deps', 8005, 5, { state: 'closed', state_reason: 'completed' }),
        remote('other/lib', 9007, 7, { state: 'closed', state_reason: 'completed' }),
      ],
    });
    const root = world.root;
    await prepareController(root);
    await writeFile(
      join(root, 'config.yaml'),
      (await readFile(join(root, 'config.yaml'), 'utf8'))
        .replace('credentials/unused.pem', 'credentials/app.pem')
        .replace(
          'repositories: []',
          'repositories: [{repository: acme/project, base: main, installationId: 2, workflows: false}]\n' +
            'dependencyRepositories: [{repository: acme/deps, installationId: 2}]\npollingSeconds: 30',
        ),
    );
    const cli = async <Command extends keyof Views>(...args: [Command, ...string[]]) => {
      const result = await invoke(root, args).result;
      return { ...result, json: result.stdout ? (JSON.parse(result.stdout) as Views[Command]) : undefined };
    };
    const owner = invoke(root, ['run']);
    let stopped = false;
    t.after(async () => {
      if (!stopped) {
        owner.child.kill('SIGTERM');
        await owner.result;
      }
    });
    let status: ControlStatus | undefined;
    await untilHolds(
      'controller completed a polling round',
      async () => {
        const reply = await cli('status');
        if (reply.code === 0) status = reply.json;
        return Boolean(status && status.polling.cycles >= 1);
      },
      50,
    );
    assert.ok(status && status.polling.cycles >= 1, 'controller completed a polling round (the next one is 30 s later)');
    const view = (await cli('list')).json!;
    const works = Object.fromEntries(view.works.map(work => [work.ticket.number, work])) as Record<number, WorkView>;
    assert.deepEqual(Object.keys(works), ['1', '2', '3', '4']);
    // #1: own blocker #2 (a Factory Work, not delivered) plus a satisfied dependency-only blocker acme/deps#5 with equal-looking identity.
    assert.equal(works[1]!.dependencies.latest!.conclusion, 'pending');
    assert.deepEqual(
      works[1]!.dependencies.latest!.blockers.map(b => [b.repository, b.number, b.repositoryRole, b.classification, b.satisfied, b.reason]),
      [
        ['acme/project', 2, 'executable', 'own', false, 'OWN_CYCLE_NOT_DELIVERED'],
        ['acme/deps', 5, 'dependency-only', 'external', true, null],
      ],
    );
    // #3: the blocker lives in a repository that is not configured: inconclusive, never released, never read with another identity.
    assert.deepEqual(
      [works[3]!.dependencies.latest!.conclusion, works[3]!.dependencies.latest!.reasons.map(r => r.code)],
      ['inconclusive', ['DEPENDENCY_REPOSITORY_NOT_CONFIGURED']],
    );
    assert.deepEqual(works[1]!.dispatch.reasons, ['DEPENDENCY_PENDING', 'EXECUTION_NOT_ENABLED']);
    assert.deepEqual(works[3]!.dispatch.reasons, ['DEPENDENCY_EVALUATION_INCONCLUSIVE', 'EXECUTION_NOT_ENABLED']);
    assert.deepEqual(works[2]!.dispatch.reasons, ['EXECUTION_NOT_ENABLED']);
    assert.equal(view.selection.next, works[2]!.work_id, 'impeded #1 does not block independent #2');
    assert.deepEqual(
      works[1]!.dependencies.latest!.principals.map(p => [p.installationId, p.repository, p.repositoryId, p.role, p.purpose, p.permissions]),
      [
        [2, 'acme/project', 3, 'executable', 'dependency-read', { metadata: 'read', issues: 'read' }],
        [2, 'acme/deps', 4, 'dependency-only', 'dependency-read', { metadata: 'read', issues: 'read' }],
      ],
    );
    const shown = (await cli('show', works[3]!.work_id)).json as Extract<ShowView, { kind: 'work' }>;
    assert.match(shown.work.impediments[0]!.nextStep, /dependencyRepositories/);
    const current = (await cli('status')).json!;
    assert.deepEqual(current.dependencies, { satisfied: 2, pending: 1, inconclusive: 1, notEvaluated: 0 });
    assert.equal(current.selection.next, works[2]!.work_id);
    stopped = true;
    owner.child.kill('SIGTERM');
    assert.equal((await owner.result).code, 0);

    const trace = await world.trace();
    assert.ok(
      trace.filter(entry => entry.credential === 'installation').every(entry => entry.method === 'GET'),
      'no issue, relation, label or comment is created',
    );
    assert.ok(!trace.some(entry => /installations\/6|other\/lib|repositories\/5/.test(entry.endpoint)), 'unconfigured repository never read');
    const grants = trace
      .filter(entry => entry.method === 'POST')
      .map(entry => [(entry as { repository?: string }).repository, JSON.stringify(entry.permissions)]);
    assert.ok(
      grants.every(([, permissions]) => !permissions!.includes('write')),
      'polling and dependency grants are read-only',
    );
    assert.ok(
      grants.some(([repository]) => repository === 'acme/deps'),
      'dependency-only repository read with its own reduced token',
    );
    assert.ok(
      trace.some(entry => /\/dependencies\/blocked_by\?per_page=100&page=2/.test(entry.endpoint)),
      'Link pages followed',
    );
    const database = Buffer.concat(
      await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => readFile(join(root, 'data', name)).catch(() => Buffer.alloc(0)))),
    );
    for (const forbidden of ['SPEC-BODY', 'synthetic-installation-secret', 'PRIVATE KEY'])
      assert.equal(database.includes(Buffer.from(forbidden)), false, forbidden);
  },
);
