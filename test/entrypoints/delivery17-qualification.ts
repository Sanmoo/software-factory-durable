import type { BranchCleanupResult, CodeRepository } from '../../src/code-repository/index.js';
import { snapshotStorage } from './review12-qualification.js';

// TEST ONLY. Ticket 17 one-shot real delivery/cleanup qualification recipe. Import and `--plan` are inert. Every other phase is a REAL
// effect and requires an explicit operator grant (real GitHub App, real host filesystem of the qualification root). It builds on the
// ticket 14 run v8 (q14-publication-v8, draft PR #5): its storage is COPIED (never written) into this recipe's own authority. Phases are one-shot: an
// exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// The HUMAN MERGE of the own pull request is an OPERATOR step between `preflight` and `deliver`; the Factory never merges or marks ready.
// GitHub WRITES by the Factory: at most ONE atomic conditional deletion of `refs/heads/<own branch>` (GraphQL updateRefs with beforeOid, retry
// phase), under its own single-use `branch-cleanup` grant, plus token issuance/self-revocation; never a plain REST DELETE. No VM is booted, no model or Builder runs (every activation is refused).

const root = '/home/sanmoo/software-factory-test/y5';
const source = `${root}/q14-publication-v8`;
const observations = `${root}/q17-delivery-v2`;
const revision = 'q17-delivery-v2';
/** The own draft PR ticket 14's v8 run published and linked (the only PR this recipe may observe as delivered). */
const expectedPullRequest = { number: 5, headRef: 'factory/3-99fe871b', headSha: 'bfdd439ceba20a424538647f41e55d5ab2d03217', base: 'main' } as const;
const phases = ['preflight', 'deliver', 'retry', 'inspect'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const pollingSeconds = 30;
const phaseDeadlineMs = 10 * 60 * 1000;

export function plan() {
  return { revision, root, source, observations, phases, repository, expectedTicket, guestAssets,
    requires: 'ticket 14 integrated; q14-publication-v8 storage with publication.state published linking PR #5 (factory/3-99fe871b @ bfdd439, base main); ticket 17 on top',
    expectedPullRequest,
    operatorStep: { between: ['preflight', 'deliver'], who: 'human operator with their own GitHub account (never the Factory/App, never an admin bypass)',
      steps: [
        'Only after `preflight` succeeded. Open https://github.com/Sanmoo/java-springboot-event-sourcing/pull/5 and check: head factory/3-99fe871b at bfdd439ceba20a424538647f41e55d5ab2d03217, base main, still draft and open.',
        'Repository Settings > General: "Automatically delete head branches" must be OFF (if it is ON the branch disappears with the merge and the expected remote-branch outcome becomes absent instead of removed).',
        'Click "Ready for review" on PR #5 (or `gh pr ready 5` authenticated as yourself).',
        'If the main ruleset (ruleset 26435808, "pull request required, no App bypass") requires an approving review, approve PR #5 yourself (the author is the App bot, so a human approval is allowed); satisfy any required checks it lists. Never use "bypass rules"/admin merge.',
        'Merge PR #5 with ANY method the ruleset allows: merge commit, squash or rebase are all acceptable to the Factory, because delivery reads merged/merged_at/merge_commit_sha and the PR head (bfdd439…), which no merge method changes; pick the one the ruleset enables (if several, prefer "Create a merge commit").',
        'Do NOT click "Delete branch" after merging, do NOT push to factory/3-99fe871b afterwards (a moved tip makes the Factory keep it: refused BRANCH_TIP_CHANGED), and do not reopen the PR or edit issue #3 (its "Closes #3" closure by the merge is expected and is not what delivers).',
        'Then run `deliver`.' ],
      acceptableMergeMethods: ['merge', 'squash', 'rebase'], requires: 'whatever ruleset 26435808 enables (allowed methods, approvals, checks); the Factory itself never merges' },
    github: { app: githubApp,
      controllerPurposes: ['delivery-read {metadata:read, contents:read, pull_requests:read} (own PR facts; refs inventory)', 'tracker-read/association-read/dependency-read (polling only)',
        'branch-cleanup {metadata:read, contents:write, pull_requests:read}: ONE fresh grant per branch cleanup attempt, revoked right after'],
      reads: ['GET /repos/<repo>/pulls/<own PR>', 'GET /repos/<repo>/pulls?state=open&base=<own branch> (stacked PRs)', 'GET /repos/<repo>/git/matching-refs/heads and /tags (inventory before/after)', 'GET /repos/<repo>',
        'GET /repos/<repo>/pulls?state=open&head=<owner>:<own branch>', 'polling: label listing, issue #3, its timeline and native blocked_by'],
      writes: ['retry phase only: at most ONE atomic conditional deletion (GraphQL updateRefs, beforeOid = merged own head, afterOid 0, force false) of refs/heads/<own branch> after ' +
        'revalidation (own PR merged from that head, no open PR with it as head OR base, not base/default); without updateRefs for the App token the branch is KEPT (kept: atomic delete unavailable)',
        'App: access_tokens issuance POSTs and DELETE /installation/token self-revocations'],
      never: ['merge', 'ready conversion', 'approval', 'push', 'deleting any other branch or tag', 'closing/reopening issue or PR', 'labels/assignees/comments'] },
    effects: [
      'preflight (read-only): exclusive COPY of the q14 storage into q17 authority; inspection of that copy: own PR linked (number/id/node/head/branch/base), Work open, every ' +
        'Execution ended with confirmed cessation; GitHub: own PR open and not merged, every branch/tag tip; host inventory: environments (owner workId), boot runtime dirs, shared cache',
      'OPERATOR: human ready + merge of the own PR (no branch auto-deletion)',
      'deliver (real): owner on the q17 authority with the real adapters; dispatch composed but EVERY prepare/start/activate/credential refused; the desk confirms the merge ' +
        '(Work delivered, minimal memory delivered+mergeConfirmed) and sweeps cleanup: preserves the own environment\'s review/spec/instructions evidence into ' +
        `${root}/<work>/evidence/<id>/ and then REMOVES, via the public Sandbox.remove of the own environment only: root.qcow2, workspace/ (checkout + local branch), artifacts/ and ` +
        'the per-boot runtime directories r/<boot> of that environment. The remote branch cleanup is PROVOKED to fail (every call in deliver returns failed WITHOUT calling GitHub): ' +
        'cleanup ends pending with only remote-branch pending; delivery stands',
      'retry (real): a NEW owner process on the same authority (boot sweep): only the pending remote branch is revalidated and deleted (one atomic deletion); environments are not touched again',
      'inspect (read-only): Control view on a copy; GitHub own PR merged, refs diff vs preflight (only the own branch disappeared); host: own environment data absent with owner.json/' +
        'removed.json kept, own runtime dirs absent, every other environment/runtime dir and the shared cache unchanged, evidence manifest present',
    ],
    execution: { capacity: 0, note: 'deliver/retry compose cleanup ports only through ExecutionPorts; capacity 0 means no reservation, hold or activation of any Work' },
    guards: ['one-shot intent tombstones', 'every branch deletion guarded: none real in deliver, at most one real in retry', 'source storage only copied, never opened for writing', 'no prepare/start/activate/credential issuance (refused)',
      'no retry inside a phase', 'no Docker/global cleanup (none composed)'],
    expected: ['retry with updateRefs unavailable to the App token: remote-branch kept (ATOMIC_DELETE_UNAVAILABLE), branch still on GitHub, never retried automatically',
      'deliver: work.result delivered; delivery.merge {number = own PR, mergeCommitSha, headSha = linked head, duringActivity null}; cleanup.evidence[0].state preserved; ' +
        'resources environment/checkout/local-branch/temporaries removed; remote-branch failed (RECIPE_PROVOKED_FAILURE); cleanup.state pending; status.delivery {delivered:1, cleanup.pending:1}',
      'retry: remote-branch removed (BRANCH_DELETED, one atomic deletion), other resources keep one attempt; cleanup.state complete',
      'inspect: own branch absent on GitHub, every other ref unchanged, own PR merged; foreign environments and the shared cache unchanged; no token in storage/observations',
      'if GitHub auto-deleted the head branch: remote-branch absent (BRANCH_ABSENT) instead of removed, still complete'],
  };
}

/**
 * Recipe guard of EVERY branch deletion: in `deliver` each call returns a provoked known failure WITHOUT calling GitHub; in `retry` only the
 * first call is real and any further call is refused locally. At most one real atomic deletion per recipe.
 */
export function branchGuard(cleanupBranch: NonNullable<CodeRepository['cleanupBranch']>, phase: 'deliver' | 'retry') {
  let real = 0;
  const calls: { real: boolean; at: string }[] = [];
  const local = (code: string, effectId: string): BranchCleanupResult => ({ outcome: 'failed', code, observedAt: new Date().toISOString(), tip: null, revocation: 'not-issued',
    effectId, nextStep: 'Recipe guard; nothing was sent.' });
  const wrapped: NonNullable<CodeRepository['cleanupBranch']> = async (selection, effect): Promise<BranchCleanupResult> => {
    if (phase === 'deliver') { calls.push({ real: false, at: new Date().toISOString() }); return local('RECIPE_PROVOKED_FAILURE', effect.effectId); }
    if (real++ > 0) { calls.push({ real: false, at: new Date().toISOString() }); return local('RECIPE_ONE_DELETE_GUARD', effect.effectId); }
    calls.push({ real: true, at: new Date().toISOString() });
    return cleanupBranch(selection, effect);
  };
  return { cleanupBranch: wrapped, calls };
}

/** Differences of two ref inventories: what disappeared, appeared or moved. Only the own branch may disappear. */
export function refsDiff(before: Record<string, string>, after: Record<string, string>) {
  return { removed: Object.keys(before).filter(ref => !(ref in after)).sort(), added: Object.keys(after).filter(ref => !(ref in before)).sort(),
    moved: Object.keys(before).filter(ref => ref in after && after[ref] !== before[ref]).sort() };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const load = async (name: string) => JSON.parse(await fs.readFile(`${observations}/${name}.json`, 'utf8')) as Record<string, unknown>;
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  return { fs, save, load, exists };
}

async function inventory() {
  const { fs } = await io();
  const environments: Record<string, unknown> = {};
  for (const name of (await fs.readdir(`${root}/environments`).catch(() => [])).sort()) {
    const owner = await fs.readFile(`${root}/environments/${name}/owner.json`, 'utf8').then(text => (JSON.parse(text) as { workId?: string }).workId ?? null, () => null);
    environments[name] = { owner, entries: (await fs.readdir(`${root}/environments/${name}`).catch(() => [])).sort() };
  }
  return { environments, runtime: (await fs.readdir(`${root}/r`).catch(() => [])).sort(), cache: (await fs.readdir(`${root}/cache/git`).catch(() => [])).sort() };
}

async function compose() {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const refs = async () => {
    const read = await github.read(repository, 'delivery-read', async session => {
      const result: Record<string, string> = {};
      for (const kind of ['heads', 'tags']) for (const item of await session.list(`/repos/${repository.repository}/git/matching-refs/${kind}`, { maxPages: 10 }) as { ref: string; object: { sha: string } }[]) result[item.ref] = item.object.sha;
      return result;
    });
    if (!read.ok) throw new Error(`REFS_UNAVAILABLE_${read.code}`);
    return read.value;
  };
  return { github, refs, tracker: createIssueTracker({ github, scopes: [repository], dependencyScopes: [] }), codeRepository: createCodeRepository({ github }) };
}

async function view(storagePath: string) {
  const { openControl } = await import('../../src/control/index.js');
  const stored = await openControl({ storagePath, runtimeInventory: 'unknown' });
  const list = await stored.inspect({ kind: 'list' });
  const status = await stored.inspect({ kind: 'status' });
  const stopped = new AbortController(); stopped.abort();
  await stored.run(stopped.signal);
  const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.ticket.number === expectedTicket.number && item.ticket.repositoryId === expectedTicket.repositoryId) : undefined;
  return { list, status, work };
}

async function owner(phase: 'deliver' | 'retry') {
  const { save } = await io();
  const { tracker, codeRepository } = await compose();
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { preserveEvidence } = await import('../../src/records/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), ...entry }); };
  const branch = branchGuard(codeRepository.cleanupBranch!, phase);
  const refused = (call: string) => async () => { log({ call, refused: true }); throw new Error('RECIPE_NO_ACTIVATION'); };
  const control = await openControl({ storagePath: `${observations}/authority/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repository: { ...codeRepository, cleanupBranch: async (selection, effect) => { const result = await branch.cleanupBranch(selection, effect); log({ call: 'cleanup-branch', selection, result }); return result; } },
      repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: pollingSeconds },
    // Capacity 0: the dispatcher never reserves a Slot or holds any Work in these phases (only the delivery desk acts).
    execution: { configuration, capacity: 0, builder: { skillPack: 'factory-skills-v6' as never, modelBudget: 'builder-v1', copyOutput: true },
      credentials: { issue: refused('issue'), revoke: async () => ({ kind: 'not-attempted', nextStep: 'nothing issued' }) },
      sandbox: { prepare: refused('prepare'), start: refused('start'), async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; } },
      workers: { activate: refused('activate'), deliver: async () => ({ status: 'failure', code: 'RECIPE_NO_ACTIVATION' }) },
      cleanup: {
        async remove(input) { const result = await sandbox.remove(input); log({ call: 'remove', environment: input.environment, result }); return result; },
        async preserve({ workId, environment }) {
          let absent = false;
          const result = await preserveEvidence({ root, workId, label: environment, stage: async destination => {
            const exported = await sandbox.exportEvidence({ environment, destination });
            if (exported.status === 'absent') absent = true; else if (exported.status === 'failure') throw new Error(exported.code);
          } });
          log({ call: 'preserve', environment, result });
          return absent && result.status === 'preserved' ? { status: 'absent' } : result;
        },
        retrySeconds: 86400,
      } } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + phaseDeadlineMs;
  let final: unknown;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const list = await control.inspect({ kind: 'list' });
    const work = 'kind' in list && list.kind === 'list' ? list.works.find(item => item.ticket.number === expectedTicket.number) : undefined;
    const settled = phase === 'deliver' ? work?.cleanup?.state === 'pending' && work.cleanup.resources.filter(item => item.state !== 'removed' && item.state !== 'absent').every(item => item.kind === 'remote-branch')
      : work?.cleanup?.state === 'complete' || (work?.cleanup?.resources.find(item => item.kind === 'remote-branch')?.attempts.length ?? 0) >= 3;
    if (settled || work?.cleanup?.evidence.some(item => item.state === 'failed')) { final = list; break; }
  }
  final ??= await control.inspect({ kind: 'list' });
  const status = await control.inspect({ kind: 'status' });
  stop.abort();
  await save(`${phase}-result`, { status: 'observed', outcome: await running, final, controlStatus: status, branchCalls: branch.calls, events, deadlineReached: Date.now() >= deadline });
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, load, exists } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      await snapshotStorage(source, `${observations}/authority`);
      const { work } = await view(await snapshotStorage(`${observations}/authority`, `${observations}/preflight-storage-copy`));
      const own = work?.publication;
      const executions = work ? [...work.previousExecutions, ...(work.execution ? [work.execution] : [])] : [];
      const linked = own?.pullRequest;
      if (!work || work.result !== 'open' || own?.state !== 'published' || !linked || linked.number !== expectedPullRequest.number || linked.headRef !== expectedPullRequest.headRef ||
        linked.headSha !== expectedPullRequest.headSha || linked.base !== expectedPullRequest.base || work.branch !== expectedPullRequest.headRef || executions.some(item => item.slot.held || (item.dispatch.boot && item.end?.cessation !== 'confirmed'))) {
        await save('preflight-held', { work: work ?? null }); throw new Error('PRECONDITION_HELD');
      }
      const { codeRepository, refs } = await compose();
      const pull = await codeRepository.readPullRequest!({ repo: repository, repositoryId: expectedTicket.repositoryId, number: linked.number,
        pullRequestId: linked.pullRequestId, nodeId: linked.nodeId });
      if (pull.kind !== 'observed' || pull.pullRequest.merged || pull.pullRequest.state !== 'open' || pull.pullRequest.headSha !== expectedPullRequest.headSha) { await save('preflight-held', { pull }); throw new Error('PRECONDITION_HELD'); }
      await save('preflight-result', { status: 'success', workId: work.work_id, ownPullRequest: linked, linkedHeads: own.linkedHeads ?? [], branch: work.branch, pull, refs: await refs(), inventory: await inventory(),
        operator: plan().operatorStep });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'deliver') { await owner('deliver'); return; }
    if (phase === 'retry') { if (!(await exists('deliver-result'))) throw new Error('DELIVER_REQUIRED'); await owner('retry'); return; }
    const preflight = await load('preflight-result');
    const { list, status, work } = await view(await snapshotStorage(`${observations}/authority`, `${observations}/inspect-storage-copy`));
    const { codeRepository, refs } = await compose();
    const own = preflight.ownPullRequest as { number: number; pullRequestId: number; nodeId: string };
    const pull = await codeRepository.readPullRequest!({ repo: repository, repositoryId: expectedTicket.repositoryId, number: own.number, pullRequestId: own.pullRequestId, nodeId: own.nodeId });
    const after = await refs();
    await save('inspect-result', { work, status, listLimitations: 'kind' in list && list.kind === 'list' ? list.limitations : null, pull,
      refsDiff: refsDiff(preflight.refs as Record<string, string>, after), inventoryBefore: preflight.inventory, inventoryAfter: await inventory(),
      evidence: work ? await fs.readdir(`${root}/${work.work_id}/evidence`).catch(() => []) : [] });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held; no retry.'); process.exit(1); });
}
