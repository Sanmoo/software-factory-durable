// Ticket 17 fixtures. Storage-real (Pi Durable + SQLite), REAL Sandbox removal/evidence export and Records preservation over synthetic
// environments (synthetic manager identity via a systemctl double: no VM, no service, no Docker). GitHub is a CodeRepository double.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSandbox, type EnvironmentRef } from '../../src/sandbox/index.js';
import { preserveEvidence } from '../../src/records/index.js';
import type { BranchCleanupResult, BranchCleanupSelection, CodeRepository, OwnPullRequestFacts, OwnPullRequestObservation } from '../../src/code-repository/index.js';
import type { CleanupPorts, ExecutionView, PublicationView } from '../../src/control/types.js';
import { admitTicket, initialize, works } from '../../src/control/durable/admission.js';
import { acceptCancel, acceptNewCycle } from '../../src/control/durable/cycles.js';
import { planCleanup } from '../../src/control/rules/delivery.js';
import { openStore, type Session } from '../../src/control/durable/store.js';
import { ticket } from './doubles.js';

export const environmentOf = (workId: string) => `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
export const bootRef = 'boot-11111111-2222-4333-8444-555555555555';
export const headSha = 'a'.repeat(40);

/** One synthetic OWN environment of `workId` in `root` (owner record, ready/current, one stopped boot, disk, workspace, artifacts, runtime). */
export async function environment(root: string, workId: string, boot = bootRef) {
  const env = environmentOf(workId);
  const directory = join(root, 'environments', env);
  const path = join(directory, boot);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const json = (p: string, value: unknown) => writeFile(p, JSON.stringify(value), { mode: 0o600 });
  const unit = `factory-sandbox-${boot}.service`;
  const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`;
  const assets = join(root, 'assets');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const manifest = JSON.stringify({ version: 1, config: { arch: 'x86_64', distro: 'alpine' }, assets: { kernel: 'kernel', initramfs: 'initramfs', rootfs: 'rootfs' },
    checksums: { kernel: sha('kernel'), initramfs: sha('initramfs'), rootfs: sha('rootfs') } });
  try { await lstat(assets); } catch {
    await mkdir(assets, { mode: 0o700 });
    for (const name of ['kernel', 'initramfs', 'rootfs']) await writeFile(join(assets, name), name);
    await writeFile(join(assets, 'manifest.json'), manifest);
  }
  const guestAssets = { directory: assets, manifestSha256: sha(manifest) };
  await json(join(directory, 'owner.json'), { version: 1, workId, environment: env, configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, guestAssets });
  await json(join(directory, 'ready.json'), { environment: env });
  await json(join(directory, 'current.json'), { version: 1, environment: env, boot });
  await json(join(path, 'identity.json'), { version: 1, environment: env, boot, unit, hostBoot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' } });
  await json(join(path, 'started.json'), { version: 1, boot, unit, invocation: 'a'.repeat(32), cgroup: group,
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') });
  const file = async (relative: string, text: string) => { await mkdir(join(directory, relative, '..'), { recursive: true, mode: 0o700 }); await writeFile(join(directory, relative), text, { mode: 0o600 }); };
  await file('workspace/checkout/.git/HEAD', 'ref: refs/heads/factory/3-own\n');
  await file('workspace/checkout/src/a.ts', 'export {}');
  await file('artifacts/review/r1/index.json', `{"round":1,"work":"${workId}"}`);
  await file('artifacts/spec/v1/ticket.json', '{"spec":1}');
  await file('artifacts/instructions/v1/AGENTS.md', '# rules');
  await file('artifacts/factory/skill-pack/x/manifest.json', '{}');
  await writeFile(join(directory, 'root.qcow2'), 'owned test disk, never booted', { mode: 0o600 });
  const runtime = join(root, 'r', Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await json(join(runtime, 'owner.json'), { version: 1, environment: env, boot });
  await writeFile(join(runtime, 'cache'), 'own runtime temporary');
  return { env, directory, runtime, guestAssets, unit, group };
}

/** Root with the systemctl double (every Factory unit inactive unless `<root>/active-<boot>` exists). Restores PATH on cleanup. */
export async function sandboxRoot(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await mkdtemp(join(tmpdir(), 'factory-delivery-'));
  await mkdir(join(root, 'cache', 'git', '3.git'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'cache', 'git', '3.git', 'HEAD'), 'shared bare cache of the repository');
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
const unit = args[2] ?? ''; const match = /^factory-sandbox-(boot-[a-f0-9-]+)\\.service$/.exec(unit);
if (args[0] !== '--user' || args[1] !== 'show' || !match || args.length !== 4) process.exit(77);
const active = fs.existsSync(${JSON.stringify(root)} + '/active-' + match[1]);
const group = '/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/' + unit;
console.log('LoadState=loaded\\nActiveState=' + (active ? 'active' : 'inactive') + '\\nSubState=dead\\nInvocationID=${'a'.repeat(32)}\\nMainPID=0\\nControlGroup=' + (active ? group : '') + '\\nResult=success');
`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(async () => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(root, { recursive: true, force: true }); });
  return root;
}

/** Composition of the REAL Sandbox removal + REAL evidence preservation (records area = `root`, like production), with a call log. */
export function realCleanupPorts(root: string, log: string[]): CleanupPorts {
  const sandbox = createSandbox({ root });
  return {
    async remove(input) { log.push(`remove:${input.environment}`); return sandbox.remove(input); },
    async preserve(input) {
      log.push(`preserve:${input.environment}`);
      let absent = false;
      const result = await preserveEvidence({ root, workId: input.workId, label: input.environment, stage: async destination => {
        const exported = await sandbox.exportEvidence({ environment: input.environment, destination });
        if (exported.status === 'absent') absent = true;
        else if (exported.status === 'failure') throw new Error(exported.code);
      } });
      return absent && result.status === 'preserved' ? { status: 'absent' } : result;
    },
    retrySeconds: 0,
  };
}

export type RemotePull = OwnPullRequestFacts;
export function ownFacts(overrides: Partial<OwnPullRequestFacts> = {}): OwnPullRequestFacts {
  return { pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: 'https://github.com/acme/project/pull/42', state: 'open', draft: false, merged: false, mergedAt: null,
    mergeCommitSha: null, headRef: 'factory/3-own', headSha, headRepositoryId: 3, baseRef: 'main', baseRepositoryId: 3, reported: { mergeCommitSha: 'null', merged: 'value' }, ...overrides };
}
export const merged = (overrides: Partial<OwnPullRequestFacts> = {}) => ownFacts({ state: 'closed', merged: true, mergedAt: '2026-11-14T12:00:00Z', mergeCommitSha: 'b'.repeat(40),
  reported: { mergeCommitSha: 'value', merged: 'value' }, ...overrides });

/** CodeRepository double for ticket 17 (only the two delivery operations; everything else throws). */
export function deliveryRepository(state: { pull: OwnPullRequestFacts | 'unavailable'; branch: Record<string, string>; branchOutcomes?: BranchCleanupResult['outcome'][] }) {
  const calls: { method: string; args: unknown }[] = [];
  const repository: CodeRepository = {
    checkAccess() { throw new Error('not used'); },
    findPublication() { throw new Error('not used'); },
    readPullRequest() { throw new Error('not used by ticket 17 (ticket 15 checks read)'); },
    setDraft() { throw new Error('not used by ticket 17'); },
    async readOwnMerge(pr): Promise<OwnPullRequestObservation> {
      calls.push({ method: 'readOwnMerge', args: pr });
      const observedAt = new Date().toISOString();
      return state.pull === 'unavailable' ? { kind: 'unavailable', source: 'github-rest', observedAt, code: 'GITHUB_QUERY_FAILED', nextStep: 'synthetic' }
        : { kind: 'observed', source: 'github-rest', observedAt, repositoryId: 3, pullRequest: structuredClone(state.pull) };
    },
    async cleanupBranch(selection: BranchCleanupSelection, effect) {
      calls.push({ method: 'cleanupBranch', args: { selection, effect } });
      const observedAt = new Date().toISOString();
      const forced = state.branchOutcomes?.shift();
      const result = (outcome: BranchCleanupResult['outcome'], code: string, tip: string | null): BranchCleanupResult =>
        ({ outcome, code, observedAt, tip, revocation: 'revoked', nextStep: 'synthetic', effectId: effect.effectId });
      if (forced) return result(forced, `SYNTHETIC_${forced.toUpperCase()}`, null);
      const tip = state.branch[selection.branch];
      if (tip === undefined) return result('absent', 'BRANCH_ABSENT', null);
      if (tip !== selection.expectedTip) return result('refused', 'BRANCH_TIP_CHANGED', tip);
      delete state.branch[selection.branch];
      return result('removed', 'BRANCH_DELETED', tip);
    },
  };
  return { repository, calls };
}

/** Ticket 14's record of a linked own draft PR (typed PublicationView), as its discovery leaves it after `publication-linked`. */
export function ownPublication(work_id: string, options: { branch: string; pr?: number; at?: string; head?: string }): PublicationView {
  const pr = options.pr ?? 42, at = options.at ?? new Date().toISOString(), head = options.head ?? headSha;
  return { state: 'published', basisExecutionId: 'e-1', marker: `<!-- software-factory:work:${work_id} -->`, branch: options.branch, base: 'main',
    verified: { executionId: 'e-1', head, contentSha256: 'd'.repeat(64), verifiedAt: at, reviewedRound: 1, gates: [], requiredChecks: [] },
    expectedRemote: { state: 'absent' }, requestedAt: at,
    pullRequest: { pullRequestId: 9000 + pr, nodeId: `PR_own${pr}`, number: pr, url: `https://github.com/acme/project/pull/${pr}`, state: 'open', merged: false, draft: true,
      headRef: options.branch, headSha: head, base: 'main', author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' }, linkedAt: at, bodySha256: null },
    description: { conformant: true, reasons: [] }, discoveries: [], reasons: [], nextStep: null, updatedAt: at,
    attempts: [{ executionId: 'e-2', head, at }], linkedHeads: [head], refsBefore: null, update: null };
}

/** Admitted Work (real Admit-Work commit) completed by one ended Execution and linked to its own PR, like tickets 09-14 would leave it. */
export async function seedPublishedWork(session: Session, options: { cessation?: 'confirmed' | 'unconfirmed'; active?: boolean; environmentFor?: (workId: string) => string; number?: number; pr?: number } = {}) {
  const number = options.number ?? 3;
  const pr = options.pr ?? 42;
  const admitted = await admitTicket(session, { ticket: ticket(number), repository: { repository: 'acme/project', repositoryId: 3, base: 'main' }, observedAt: 'now',
    label: { id: 55, name: 'ready-for-agent' }, publication: { observedAt: 'now', limitations: [] } });
  if (admitted.kind !== 'admitted') throw new Error('NOT_ADMITTED');
  const work_id = admitted.work_id;
  await session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work!;
    const now = new Date().toISOString();
    const active = options.active === true;
    const execution: ExecutionView = {
      executionId: 'e-1', invocationId: 'i-1', mode: 'initial', state: active ? 'started' : 'ended',
      slot: { held: active, capacity: 1, reservedAt: now, releasedAt: active ? null : now },
      admission: { attemptId: 'a', evaluationId: 'v', authorizationObservedAt: now, activationAttemptId: 'a', activationEvaluationId: 'v' },
      dispatch: { intent: 'prepare-start-activate', phase: active ? 'started' : 'stopped', environment: (options.environmentFor ?? environmentOf)(work_id), boot: bootRef, updatedAt: now },
      request: { ticket: work.ticket.url, repository: 'acme/project', base: 'main', branch: 'factory/3-own', baseCommit: 'c'.repeat(40), checkout: '/workspace/checkout',
        promptSha256: null, skillPack: null, policies: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 } },
      credential: null, credentialIssuance: null, credentialRenewals: [],
      credentialLifecycle: { state: active ? 'active' : 'withdrawn', withdrawnAt: active ? null : now, reason: active ? null : 'ended', renewal: 'enabled', renewalStop: null, workerNotice: null },
      start: { receiptId: 'r-1', confirmedAt: now },
      end: active ? null : { at: now, outcome: 'completed', code: null, cessation: options.cessation ?? 'confirmed' }, held: null,
      completion: { automatic: false, reason: 'The Builder said: "merged and delivered" (agent text is never delivery evidence).' },
    };
    Object.assign(work, { execution, branch: 'factory/3-own', queue: { ...work.queue, pending: false }, impediments: [],
      pullRequest: { number: pr, url: `https://github.com/acme/project/pull/${pr}` } });
    // Ticket 14's own-PR link, in its real PublicationView shape (state published, linked head recorded in linkedHeads).
    work.publication = ownPublication(work_id, { branch: 'factory/3-own', pr, at: now });
  }, BACKGROUND_CONTEXT);
  return work_id;
}

export async function store(t: { after(fn: () => Promise<void> | void): void }, root: string) {
  const opened = await openStore(join(root, 'control.sqlite'));
  t.after(() => opened.close());
  await initialize(opened.session);
  return opened;
}

/** Ticket 30 recipe tests: the seeded Work as ticket 17 leaves a delivered one after a complete cleanup (merge confirmed at `confirmedAt`). */
export async function markDelivered(session: Session, work_id: string, confirmedAt: string) {
  await session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work!;
    work.result = 'delivered';
    work.delivery = { state: 'delivered', pullRequest: { pullRequestId: 9042, nodeId: 'PR_own42', number: 42, url: 'https://github.com/acme/project/pull/42', headRef: 'factory/3-own', base: 'main', heads: [headSha] },
      observations: [], merge: { mergedAt: confirmedAt, mergeCommitSha: 'b'.repeat(40), headSha, pullRequestId: 9042, number: 42, url: 'https://github.com/acme/project/pull/42',
        confirmedAt, observedAt: confirmedAt, duringActivity: null }, lastReadAt: confirmedAt, nextStep: '' };
    work.cleanup = { state: 'complete', eligibility: { eligible: true, reasons: [], checkedAt: confirmedAt }, evidence: [], resources: [], protected: [], sweeps: 1,
      lastSweepAt: confirmedAt, nextStep: '' };
  }, BACKGROUND_CONTEXT);
}

/** Ticket 31 recipe tests: every own resource ticket 17 would plan for the Work recorded as removed (a delivered Work after a complete cleanup). */
export async function markCleaned(session: Session, work_id: string) {
  await session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work!;
    work.cleanup!.resources = planCleanup(work, { repositoryConfigured: true }).resources.map(item => ({ ...item, state: 'removed' as const, attempts: [] }));
  }, BACKGROUND_CONTEXT);
}

/** Ticket 31 recipe tests: the seeded Work cancelled (no own PR, ceased at once) and an explicit `new` cycle 2 open after it, like q25-cancel-v1. */
export async function cancelWithSuccessor(session: Session, work_id: string, number: number) {
  await session.commit(async tx => { const work = (await tx.doc(works, work_id, null)).work!; work.publication = null; work.pullRequest = null; }, BACKGROUND_CONTEXT);
  const cancelled = await acceptCancel(session, { request_id: `fixture-cancel-${number}`, operation: 'cancel', work_id, origin: 'local-cli' });
  if (cancelled.kind !== 'durable' || cancelled.outcome !== 'accepted') throw new Error('NOT_CANCELLED');
  const tracker = { readTicket: async () => ({ kind: 'observed' as const, source: 'github-rest' as const, observedAt: new Date().toISOString(), completeness: 'complete' as const,
    ticket: ticket(number), state: 'open' as const, stateReason: null, labels: [{ id: 55, name: 'ready-for-agent' }], pullRequest: false }) };
  const created = await acceptNewCycle(session, { request_id: `fixture-new-${number}`, operation: 'new', ticket: { repository: 'acme/project', number }, keepPredecessorPullRequest: false,
    origin: 'local-cli' }, { configured: () => ({ repository: 'acme/project', installationId: 2, workflows: false, label: 'ready-for-agent', base: 'main' }), tracker: tracker as never });
  if (created.kind !== 'durable' || !created.created) throw new Error(`NO_SUCCESSOR:${JSON.stringify(created)}`);
  return created.created;
}
