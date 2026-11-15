import type { ExecutionView, WorkView } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';

// TEST ONLY. Ticket 21 one-shot real qualification recipe: human commits on the Factory branch are PRESERVED. Import and `--plan` are inert.
// Every other phase is a REAL effect and needs an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and the real model.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// GitHub WRITES by the Factory side: the Builder (guest, direct, its own `builder-publish` grant) pushes ONLY its own branch, ALWAYS with
// `--force-with-lease=refs/heads/<branch>:<exact expected oid>` (empty only at creation), and creates/edits ONE draft PR; the controller posts
// Question comments on the pinned issue. The HUMAN steps (commits on the Factory branch, answers) are made by the operator with the
// operator's own account — never the App, never this recipe. Never a merge, approval, ready conversion, bare --force or base rewrite.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q21-human-v7`;
const revision = 'q21-human-v7';
const phases = ['preflight', 'run', 'race', 'reconcile', 'finish', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
/**
 * The NEW synthetic issue the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no other
 * open issue with that label). `number` MUST be pinned in a reviewed commit before preflight: 0 refuses every phase (TICKET_NOT_PINNED).
 */
export const ticket = { number: 25, repositoryId: 1256893534, title: 'Factory qualification: preserve human commits on the Factory branch' } as const;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
/** The only operator: preflight pins the immutable user id GitHub reports for this login (repository owner, type User). */
const operatorLogin = 'Sanmoo';
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const deadlines = { run: 80, race: 150, reconcile: 150, finish: 90 } as const;
/** How long a phase waits for a HUMAN step (push) once it asked for it; then the phase is held (consumed, no retry). */
const humanStepMinutes = 60;
const rounds = { max: 4 } as const;
const pollingSeconds = 120;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit lease, ONE draft pull ' +
    'request) and never merge, approve, mark ready or touch anything else. Never rewrite or drop commits you did not make. Report blockers instead of working around them.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v6' as const;
/** Proposed body of the NEW issue (documentation only; one documented gate). */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_HUMAN_CHANGES.md`. This exact upper-case file name was decided by the operator.',
  '', 'Required content:',
  '1. A `# Factory human changes` title and one paragraph explaining that this file exists only to exercise how the Software Factory preserves human commits on its branch.',
  '2. A `## Steps` section with a numbered list of exactly three steps: publish, human edit, reconcile.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_HUMAN_CHANGES.md && grep -q \'^## Steps\' docs/FACTORY_HUMAN_CHANGES.md`',
  '', 'This Validation command is the only gate of this Ticket: no typecheck, lint or other gate applies, so do not declare any other gate.'].join('\n');
/** The concrete scope update of the `race` phase (fixed identity and content): it makes a NEW verified basis, i.e. an update of the branch. */
export const scopeUpdate = { request_id: 'q21-human-v7-scope-1',
  reason: 'Also add a `## Rollback` section to docs/FACTORY_HUMAN_CHANGES.md saying the file can be deleted at any time without other changes (only that).' };
/** The human commits (operator's own account; plain fast-forward pushes, never --force). Separate files: no textual conflict is provoked. */
export const humanSteps = {
  1: { phase: 'race', file: 'docs/FACTORY_HUMAN_NOTE.md', line: 'Added by the operator directly on the Factory branch (ticket 21 qualification, step 1).',
    when: 'the race phase saved human-step-1-requested.json: it HOLDS the publication activation (its lease expectation is already recorded) until this push is observed' },
  2: { phase: 'reconcile', file: 'docs/FACTORY_HUMAN_NOTE_2.md', line: 'Added by the operator on the Factory branch after authorizing the first reconciliation (step 2).',
    when: 'the reconcile phase saved human-step-2-requested.json: it HOLDS the discovery that follows the reconciliation Execution until this push is observed' },
} as const;
/** ONE script (review): aborts on any failure and when the branch tip is not exactly the expected one; a plain fast-forward push. */
export const humanCommands = (step: 1 | 2, branch: string, expectedTip: string) => [
  'set -euo pipefail',
  `work=$(mktemp -d /tmp/q21-human-${step}-XXXXXX)`,
  `git clone --quiet --branch ${branch} https://github.com/${repository.repository}.git "$work"`,
  'cd "$work"',
  `if [ "$(git rev-parse HEAD)" != "${expectedTip}" ]; then echo "tip differs from ${expectedTip}: nothing pushed" >&2; exit 1; fi`,
  `printf '%s\\n' '# Human note ${step}' '' '${humanSteps[step].line}' > ${humanSteps[step].file}`,
  `git add ${humanSteps[step].file}`,
  `git commit --quiet -m 'docs: human note ${step} on the Factory branch (q21)'`,
  `git push origin HEAD:refs/heads/${branch}`].join('\n');

export function plan() {
  return { revision, root, observations, phases, repository, ticket: { ...ticket, body: ticketBody, label: repository.label, pinned: ticket.number > 0 }, operators: [operatorLogin],
    configuration, guestAssets, skillPack, scopeUpdate,
    requires: ['ticket 21 integrated in the composed revision', `${root}/${githubApp.privateKeyFile} present`, 'the supervisor created the NEW issue (title/body above, label ready-for-agent) and pinned its number in a reviewed commit',
      'no other open issue carries the label', 'main protected with NO bypass for the App (as in tickets 14/16/17)', 'operator first-login store under root/credentials (model OAuth)'],
    model: { provider: 'openai', model: 'gpt-6-luna', auth: 'factory-oauth', providerRetries: 0, sdkRetries: 0,
      builderActivations: { run: ['implementation', 'publication'], race: ['implementation (scope update)', 'publication (lease FAILS)'], reconcile: ['reconciliation'],
        finish: ['reconciliation', 'publication'] }, reviewersPerImplementation: `standards + spec, at most ${rounds.max} rounds each` },
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ copy of ${root}/${githubApp.privateKeyFile}, run/); never y5/run`,
      writes: ['Builder (guest, direct, builder-publish): run — 1 push creating refs/heads/factory/<n>-<work8> with --force-with-lease=<ref>: (absent) and 1 draft PR (marker, Closes #<n>)',
        'Builder: race — 1 push attempt with --force-with-lease=<ref>:<published head> that GitHub REJECTS (the human commit landed after the expectation was captured) and possibly a refused PR edit',
        'Builder: finish — 1 push with --force-with-lease=<ref>:<second human commit> (the authorized tip) of a head that contains both human commits, and 1 PR description edit',
        'controller: Question comments on the pinned issue — one per divergence (race: lease failed; reconcile: new change after the answer)',
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations'],
      human: ['step 1 (during race): the operator pushes ONE commit (new file docs/FACTORY_HUMAN_NOTE.md) on top of the published head, with the operator\'s own credentials',
        'answer 1 (after race, controller stopped): on the issue, `/factory answer <question-1> incorporate` from the operator account',
        'step 2 (during reconcile): the operator pushes ONE commit (docs/FACTORY_HUMAN_NOTE_2.md) on top of the FIRST human commit (the authorized tip)',
        'answer 2 (after reconcile, controller stopped): on the issue, `/factory answer <question-2> incorporate` from the operator account'],
      humanCommands: 'ONE `set -euo pipefail` script written into human-step-<k>-requested.json with the exact branch and expected tip: it aborts (nothing pushed) unless the tip is exactly the expected one, then adds the file, commits and pushes plainly',
      controllerWriteGuard: 'the tracker is wrapped: only Question comments on the pinned issue are posted; anything else refused before sending',
      never: ['merge', 'approval', 'ready-for-review conversion', 'bare --force or a lease without an explicit oid', 'push to main or any other branch', 'rewrite of the base',
        'labels/assignees', 'closing the issue or the PR', 'branch deletion/cleanup', 'any write by this recipe itself'] },
    effects: [
      'preflight: key source check BEFORE any effect; exclusive namespace with its own GitHub access root; read-only: operator id pinned, label lists exactly the pinned issue, no associated PR, ' +
        'no factory/<n>- branch, main requires PRs without App bypass, App bot identity, every branch/tag tip',
      'run: new storage; implementation (reviews, verification) -> discovery absent -> ONE publication activation -> own draft PR linked (published head H1)',
      'race: same storage, new owner; update-scope (fixed id/reason) -> implementation H2 (reviews, verification) -> discovery: update with lease H1 -> publication activation HELD until human step 1 ' +
        'is observed (tip C1 on top of H1) -> the Builder\'s leased push is REJECTED -> discovery after the attempt: diverged (lease-failed), Question 1 published; stop',
      'reconcile: after answer 1 (incorporate): resolve -> reconciliation Execution (fetch C1, rebase onto it, gates, reviews; capture preserve=C1 must be an ancestor) -> the next discovery is ' +
        'HELD until human step 2 (C2 on top of C1) -> diverged again against the AUTHORIZED tip C1 (a new change needs a new answer), Question 2 published; NO publication; stop',
      'finish: after answer 2: reconciliation Execution (preserve=C2) -> discovery: lease on exactly C2 -> publication of H4 (contains C1 and C2) -> linked; stop',
      'inspect (after any ended phase, held or not, once nothing still runs): storage copy; read-only GitHub: own PR, branch tip, compare C1...head and C2...head (ahead/identical), contents of both human files at the head; session bash push commands',
      'stop-environment: own boot of the last recorded Execution when it may still run'],
    guards: ['one-shot intent tombstones and phase order', 'per-phase Builder sequence (phaseIds) and reviewers only for the implementation/reconciliation Execution of that phase',
      'builder-publish only while Control requested the publication (<= 2 per publication activation); refused in reconcile', 'prepare <= Builder activations of the phase', 'no retry, no remove/cleanup',
      `human steps wait at most ${humanStepMinutes} min, then the phase is held`],
    expected: [
      'run: published, head H1 = verified head; attempts [{H1, expectedRemote absent}]',
      'race: publication.attempts[-1] = {H2, expectedRemote {present, H1}} (the expectation used, preserved); divergence {trigger lease-failed, expected H1, current C1, local H2, comparison commits [C1] with the operator account}; ' +
        'reasons include LEASE_FAILED; Question 1 recordedFrom controller-divergence, published on the issue; no second publication activation; branch tip C1 (human commit kept)',
      'reconcile: reconciliation Execution request.reconciliation {authorizedRemote C1, expected H1, localHead H2}, phaseId builder-reconciliation, builder-start only, handoff.preserve C1, ' +
        'final capture preserved {C1, ancestor true}; then divergence 2 {expected C1, current C2}, reconciliation 1 superseded, Question 2 published; NO push in this phase; tip C2',
      'finish: reconciliation 2 (preserve C2, ancestor true); publication prompt --force-with-lease=refs/heads/<branch>:C2; linked head H4; compare C1...H4 and C2...H4 ahead (both human commits ancestors); ' +
        'both human files present at H4; reconciliation consumed; budget unchanged by the answers; issue open; main unchanged',
      'no bare --force in any session; every Factory push names its exact lease; no token in storage/receipts/sessions/observations'],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, pinned = ticket.number > 0,
  /** Phases that ended (a result or a held record). Real run q21-human-v7: inspect runs after ANY held phase, once nothing is still running. */
  ended: ReadonlySet<string> = new Set()): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const before: Partial<Record<Phase, Phase>> = { run: 'preflight', race: 'run', reconcile: 'race', finish: 'reconcile' };
  const previous = before[phase];
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  if (phase === 'inspect') {
    if (results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
    const running = (['run', 'race', 'reconcile', 'finish'] as const).filter(item => intents.has(`${item}-intent`) && !ended.has(item));
    if (running.length) return `PHASE_NOT_ENDED:${running.join(',')}`;
  }
  if (phase === 'stop-environment' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

type BuilderKind = 'implementation' | 'publication';
const implementationPhases: Record<'run' | 'race' | 'reconcile' | 'finish', readonly string[]> = { run: ['builder-initial'], race: ['builder-continuation', 'builder-recovery'],
  reconcile: ['builder-reconciliation'], finish: ['builder-reconciliation'] };
export const builderSequence: Record<'run' | 'race' | 'reconcile' | 'finish', readonly BuilderKind[]> = { run: ['implementation', 'publication'], race: ['implementation', 'publication'],
  reconcile: ['implementation'], finish: ['implementation', 'publication'] };
/**
 * Activation guard of one phase: the Builder activations in the phase's exact sequence (implementation phaseIds per phase, then the
 * publication of ANOTHER Execution of the same Work), and reviewers only for that phase's implementation Execution (distinct rounds,
 * at most `maxRounds` per role). Anything else is refused before it starts.
 */
export function activationGuard(phase: keyof typeof builderSequence, maxRounds: number = rounds.max) {
  const sequence = builderSequence[phase];
  let next = 0;
  let implementation: { workId: string; executionId: string } | undefined;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  let recovered = false;
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review?: { round: number }) => {
    if (context.role === 'builder') {
      // Real run q21-human-v4: ONE operational recovery (ticket 26) of the phase's implementation, another Execution of the same Work.
      if (!recovered && sequence[next - 1] === 'implementation' && implementation && implementationPhases[phase].includes(context.phaseId) &&
          context.workId === implementation.workId && context.executionId !== implementation.executionId) {
        recovered = true;
        implementation = { workId: context.workId, executionId: context.executionId };
        for (const used of Object.values(seen)) used.clear();
        return true;
      }
      const kind = sequence[next];
      if (!kind) return false;
      if (kind === 'implementation') {
        if (!implementationPhases[phase].includes(context.phaseId)) return false;
        implementation = { workId: context.workId, executionId: context.executionId };
      } else if (context.phaseId !== 'builder-publication' || !implementation || context.workId !== implementation.workId || context.executionId === implementation.executionId) return false;
      next++;
      return true;
    }
    const used = seen[context.role];
    // Reviewers only while the implementation is the latest Builder activation of the phase, for its own Execution and distinct rounds.
    if (!used || !implementation || sequence[next - 1] !== 'implementation' || context.executionId !== implementation.executionId || !review || used.has(review.round) ||
      used.size >= maxRounds) return false;
    used.add(review.round);
    return true;
  };
}

/** Grant guard: builder-start for the implementation; builder-publish only in phases with a publication, while Control requested it. */
export function grantGuard(phase: keyof typeof builderSequence, max = 2) {
  let publish = 0;
  return (purpose: string | undefined, lifecycle: { publicationState: string | null; publicationActivation: boolean }) => {
    if ((purpose ?? 'builder-start') === 'builder-start') return true;
    if (purpose !== 'builder-publish' || !builderSequence[phase].includes('publication')) return false;
    const own = lifecycle.publicationState === 'requested' || (lifecycle.publicationState === 'awaiting-discovery' && lifecycle.publicationActivation);
    if (!own || publish >= max) return false;
    publish++;
    return true;
  };
}

/** The human push the phase waits for: the own branch moved from `expected` to a commit whose comparison is exactly one commit ahead. */
export function humanPushObserved(expected: string, tip: { state: string; sha?: string } | undefined, comparison: { state: string; status?: string; aheadBy?: number; behindBy?: number } | undefined):
  { kind: 'waiting' } | { kind: 'observed'; sha: string } | { kind: 'unexpected'; reason: string } {
  if (!tip || tip.state !== 'present' || !tip.sha || tip.sha === expected) return { kind: 'waiting' };
  if (!comparison || comparison.state !== 'complete') return { kind: 'unexpected', reason: 'COMPARISON_UNKNOWN' };
  if (comparison.status !== 'ahead' || comparison.aheadBy !== 1 || comparison.behindBy !== 0) return { kind: 'unexpected', reason: `NOT_ONE_FAST_FORWARD_COMMIT:${comparison.status}` };
  return { kind: 'observed', sha: tip.sha };
}

/**
 * Every push-like command of the sessions (git push, gh api/curl on git refs) must be EXACTLY the leased push Control derived for one of
 * its recorded publication attempts (branch, expected oid as recorded, verified head) — never another oid, a bare/`-f`/`+`/`-u` push or an
 * API ref write.
 */
export function pushViolations(commands: string[], expectations: { branch: string; expected: string | null; head: string }[]): string[] {
  const allowed = new Set(expectations.map(item => `git -C /workspace/checkout push --force-with-lease=refs/heads/${item.branch}:${item.expected ?? ''} origin ${item.head}:refs/heads/${item.branch}`));
  return commands.filter(command => /\bgit\b[\s\S]*\bpush\b|\bsend-pack\b/.test(command) || /\b(gh\b[\s\S]*\bapi|curl|wget)\b[\s\S]*(git\/refs|\/git\/ref\b|graphql)/i.test(command))
    .filter(command => !allowed.has(command.trim())).map(command => `UNEXPECTED_PUSH:${command.slice(0, 200)}`);
}
/** Review: the controller's only GitHub write is a Question comment on the pinned issue; anything else is refused (nothing sent). */
export function guardTracker(tracker: IssueTracker, log: (entry: Record<string, unknown>) => void): IssueTracker {
  return { ...tracker, async postComment(ticketRef, comment, effect) {
    const allowed = ticketRef.number === ticket_.number && comment.kind === 'question';
    log({ call: 'post-comment', ticket: ticketRef.number, kind: comment.kind, allowed });
    if (!allowed) throw new Error('RECIPE_WRITE_GUARD');
    return tracker.postComment(ticketRef, comment, effect);
  } };
}
const ticket_ = { get number() { return ticket.number; } };

export const keySource = `${root}/${githubApp.privateKeyFile}`;
/** Fails loudly, with the path and what to do, when the App key the preflight copies is missing (nothing has been created yet). */
export async function requireKeySource(access: (path: string) => Promise<unknown>) {
  await access(keySource).catch(() => {
    throw new Error(`APP_KEY_SOURCE_MISSING: ${keySource} is absent; restore the App private key there before preflight (nothing was created, no intent, no GitHub call).`);
  });
}
export function resolveOperator(body: unknown, login: string): { login: string; id: number } {
  const owner = body && typeof body === 'object' && 'owner' in body ? (body as { owner: { login?: unknown; id?: unknown; type?: unknown } }).owner : undefined;
  if (!owner || typeof owner.login !== 'string' || owner.login.toLowerCase() !== login.toLowerCase() || owner.type !== 'User' ||
      typeof owner.id !== 'number' || !Number.isSafeInteger(owner.id) || owner.id <= 0) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
  return { login: owner.login, id: owner.id };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>, () => null);
  return { fs, save, exists, load };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  // The recipe's OWN namespace is the GitHub access root (its run/ holds the transient gh dirs; never y5/run).
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

const workOf = (list: unknown): WorkView | undefined => (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works[0] : undefined;
const ended = (execution: ExecutionView | null | undefined) => Boolean(execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped')));
const divergences = (work: WorkView | undefined) => work?.publication?.divergences ?? [];

type ControlPhase = 'run' | 'race' | 'reconcile' | 'finish';
/** Whether a Control phase reached its end (or a state that ends it early); `success` says whether it is the expected end. */
/** `startBasis`: the publication basis when the phase started (real run q21-human-v1: a race that begins PUBLISHED must wait for the update). */
export function settled(phase: ControlPhase, work: WorkView | undefined, questionsPublished: (id: string) => boolean, startBasis: string | null): { done: boolean; success: boolean } {
  const publication = work?.publication;
  const state = publication?.state ?? '';
  const stuck = ['blocked', 'not-publishable', 'base-changed'].includes(state) || work?.execution?.state === 'held';
  const last = divergences(work).at(-1);
  if (phase === 'run') return state === 'published' ? { done: true, success: true } : { done: stuck || state === 'diverged', success: false };
  if (phase === 'race' || phase === 'reconcile') {
    const expected = phase === 'race' ? 1 : 2;
    if (state === 'diverged' && divergences(work).length === expected && last && questionsPublished(last.questionId)) {
      return { done: true, success: phase === 'race' ? last.trigger === 'lease-failed' : last.trigger === 'update' };
    }
    // Still published at the starting basis = the scope update was accepted but not dispatched yet (not an end of the phase).
    const updatedWithoutDivergence = state === 'published' && publication?.basisExecutionId !== startBasis;
    return { done: stuck || updatedWithoutDivergence || divergences(work).length > expected, success: false };
  }
  const reconciled = publication?.reconciliation?.state === 'consumed' && divergences(work).length === 2;
  return state === 'published' && reconciled ? { done: true, success: true } : { done: stuck || (state === 'diverged' && divergences(work).length > 2), success: false };
}

/**
 * v2 review: after the owner stopped, every boot this phase started that is still active is stopped through the public Sandbox (never
 * PID/abort), and its cessation is confirmed by the Sandbox's own observation; anything else is reported unconfirmed.
 */
export async function ceaseStartedBoots(sandbox: { observe(input: { environment: never; boot: never }): Promise<{ condition: string }>;
  stop(input: { environment: never; boot: never; reason: string }): Promise<{ status: string; cessationConfirmed?: boolean }> },
  started: { environment: string; boot: string }[], log: (entry: Record<string, unknown>) => void) {
  const results: { boot: string; before: string; stopped: boolean; confirmed: boolean; code?: string }[] = [];
  for (const item of started) {
    const ref = { environment: item.environment as never, boot: item.boot as never };
    try {
      const before = (await sandbox.observe(ref)).condition;
      if (before !== 'active') { results.push({ boot: item.boot, before, stopped: false, confirmed: true }); continue; }
      const stopped = await sandbox.stop({ ...ref, reason: 'q21 phase end: stop the boot this phase started' });
      const after = (await sandbox.observe(ref)).condition;
      results.push({ boot: item.boot, before, stopped: true, confirmed: stopped.status === 'success' && stopped.cessationConfirmed === true && after !== 'active' });
    } catch (error) { results.push({ boot: item.boot, before: 'unknown', stopped: false, confirmed: false, code: error instanceof Error ? error.message.slice(0, 64) : 'UNKNOWN' }); }
  }
  log({ call: 'cease-started-boots', results });
  return results;
}

async function runControl(phase: ControlPhase, save: (name: string, data: unknown) => Promise<void>, operators: { login: string; id: number }[]) {
  const { github, tracker: rawTracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = builderSkillPacks[skillPack];
  const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
  const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
    profiles: { builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model }, standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
      spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model } } });
  const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
  const tracker = guardTracker(rawTracker, log);
  const guard = activationGuard(phase);
  const grants = grantGuard(phase);
  let prepared = 0;
  let control!: Awaited<ReturnType<typeof openControl>>;
  const shown = async () => workOf(await control.inspect({ kind: 'list' }));
  /** HUMAN step k: save the exact commands, then poll the own branch read-only until the operator's push is observed (or time out). */
  const waitHuman = async (step: 1 | 2, branch: string, expectedTip: string) => {
    await save(`human-step-${step}-requested`, { step, branch, expectedTip, file: humanSteps[step].file, script: humanCommands(step, branch, expectedTip), at: new Date().toISOString(),
      note: 'Operator: run these with YOUR OWN credentials now; the phase is waiting. Never the App, never --force.' });
    const until = Date.now() + humanStepMinutes * 60 * 1000;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      const read = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [branch], compareFrom: expectedTip });
      const seen = read.kind === 'observed' ? humanPushObserved(expectedTip, read.branches[branch], read.comparison) : { kind: 'waiting' as const };
      if (seen.kind === 'waiting') continue;
      await save(`human-step-${step}-observed`, { seen, comparison: read.kind === 'observed' ? read.comparison : null, at: new Date().toISOString() });
      if (seen.kind === 'unexpected') throw new Error(`RECIPE_HUMAN_STEP_UNEXPECTED:${seen.reason}`);
      return seen.sha;
    }
    throw new Error('RECIPE_HUMAN_STEP_TIMEOUT');
  };
  let humanTwoDone = false;
  const started: { environment: string; boot: string }[] = [];
  control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: 'empty',
    access: { tracker, repositories: [repository], dependencyRepositories: [], operators, factoryApp: () => github.appIdentity(repository),
      repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base), readPullRequest: query => codeRepository.readPullRequest(query),
        setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }),
        async findPublication(correlation) {
          // reconcile: the discovery right after the reconciliation Execution waits for human step 2 (a NEW change after the answer).
          const work = await shown();
          const authorized = work?.publication?.reconciliation;
          if (phase === 'reconcile' && !humanTwoDone && correlation.knownBranches.length && work?.execution?.request.reconciliation && work.execution.end && authorized) {
            await waitHuman(2, correlation.knownBranches[0]!, authorized.authorizedRemote);
            humanTwoDone = true;
          }
          const result = await codeRepository.findPublication(correlation);
          log({ call: 'find-publication', knownBranches: correlation.knownBranches, compareFrom: correlation.compareFrom ?? null, kind: result.kind,
            ...(result.kind === 'observed' ? { branches: result.branches, comparison: result.comparison ?? null } : { code: result.code }) });
          return result;
        } } }, polling: { intervalSeconds: pollingSeconds },
    execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviews: { reviewer, rounds },
      credentials: { async issue(context) {
        const work = await shown();
        const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
        const allowed = work?.ticket.number === ticket.number && grants(context.purpose, { publicationState: work.publication?.state ?? null, publicationActivation: running });
        log({ call: 'issue', purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        const grant = await builderCredentials.issue(context);
        log({ call: 'issued', metadata: grant.metadata });
        return grant;
      }, async revoke(grant) { const result = await builderCredentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
      sandbox: {
        async prepare(input) {
          log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
          const work = await shown();
          if (work?.work_id !== input.workId || work.ticket.number !== ticket.number || ++prepared > builderSequence[phase].length + 1) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
          const result = await sandbox.prepare(input);
          log({ call: 'prepare-result', result });
          return result;
        },
        async start(input) {
          const result = await sandbox.start(input);
          log({ call: 'start', result });
          if (result.status === 'success') started.push({ environment: input.environment, boot: result.boot });
          return result;
        },
        async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
        async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
      },
      workers: { async deliver(worker, directive) { const result = await workers.deliver(worker, directive); log({ call: 'deliver', kind: directive.kind, result }); return result; },
        async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
        async activate(invocation, delivery, activationEvents) {
          log({ call: 'activate', context: invocation.context, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), review: invocation.review ?? null, handoff: invocation.handoff ?? null });
          if (!guard(invocation.context, invocation.review)) throw new Error('RECIPE_ONE_SHOT_GUARD');
          // race: the publication's lease expectation is already recorded; human step 1 lands BEFORE the Builder pushes (the lease must fail).
          if (phase === 'race' && invocation.context.phaseId === 'builder-publication') {
            const request = (await shown())?.execution?.request.publication;
            if (!request || request.expectedRemote.state !== 'present') throw new Error('RECIPE_UPDATE_EXPECTED');
            await waitHuman(1, request.branch, request.expectedRemote.sha);
          }
          const handle = await workers.activate(invocation, delivery, activationEvents);
          const role = invocation.context.role;
          void handle.completed.then(done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
            () => log({ call: 'completion-uncertain', role }));
          return handle;
        } } } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  let scopeReceipt: unknown = null;
  let outcome = { done: false, success: false };
  let final: unknown = null;
  const questions: unknown[] = [];
  let deadline = 0;
  let result: unknown = null;
  // v2 review: EVERY end of the phase (success, held, timeout, throw) stops the owner and then the boots this phase started, and the
  // cessation is recorded; an unconfirmed one holds the phase.
  let cessation: Awaited<ReturnType<typeof ceaseStartedBoots>> = [];
  try {
    if (phase === 'race') {
      const work = await shown();
      if (!work || work.publication?.state !== 'published') throw new Error('RECIPE_PUBLISHED_WORK_REQUIRED');
      scopeReceipt = await control.accept({ request_id: scopeUpdate.request_id, operation: 'update-scope', work_id: work.work_id, reason: scopeUpdate.reason, origin: 'local-cli' });
      log({ call: 'update-scope', receipt: scopeReceipt });
    }
    const published = new Set<string>();
    const startBasis = (await shown())?.publication?.basisExecutionId ?? null;
    deadline = Date.now() + deadlines[phase] * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const work = await shown();
      for (const item of divergences(work)) {
        const shownQuestion = await control.inspect({ kind: 'question', question_id: item.questionId }) as { kind: string; question?: { publication: { state: string } } };
        if (shownQuestion.kind === 'question' && shownQuestion.question?.publication.state === 'published') published.add(item.questionId);
      }
      outcome = settled(phase, work, id => published.has(id), startBasis);
      if (outcome.done) break;
    }
    final = await control.inspect({ kind: 'list' });
    for (const item of divergences(workOf(final))) questions.push(await control.inspect({ kind: 'question', question_id: item.questionId }));
  } finally {
    stop.abort();
    result = await running.catch((error: unknown) => ({ kind: 'failed', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN' }));
    cessation = await ceaseStartedBoots(sandbox, started, log);
    await save(`${phase}-cessation`, { started, cessation, at: new Date().toISOString() });
  }
  const ceased = cessation.every(item => item.confirmed);
  await save(`${phase}-result`, { status: outcome.success && ceased ? 'success' : 'held', outcome: result, final, questions, scopeReceipt, events, cessation, deadlineReached: Date.now() >= deadline,
    ...(phase === 'race' || phase === 'reconcile' ? { operatorNext: 'Answer the latest Question on the issue from the operator account: `/factory answer <question-id> incorporate` (controller stopped).' } : {}) });
  if (!ceased) throw new Error('BOOT_CESSATION_UNCONFIRMED');
  if (!outcome.success) throw new Error('PHASE_NOT_AS_EXPECTED');
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  if (phase === 'preflight') {
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification (it holds the intent tombstone)
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const ended = new Set((await Promise.all(phases.map(async item => await exists(`${item}-result`) || await exists(`${item}-held`) ? item : null))).filter((item): item is Phase => item !== null));
  const refused = phaseGuard(phase, results, intents, ticket.number > 0, ended);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      // After the tombstone: the namespace's GitHub access root (key copy, run/).
      const { constants } = await import('node:fs');
      await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 });
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
      const { github, tracker, codeRepository } = await compose();
      const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
      if (!owner.ok) { await save('preflight-held', { owner }); throw new Error('PRECONDITION_HELD'); }
      const operator = resolveOperator(owner.value, operatorLogin);
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== ticket.number || listing.repositoryId !== ticket.repositoryId) {
        await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD');
      }
      const issue = await tracker.readTicket(listing.candidates[0]!);
      const raw = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${ticket.number}`));
      const title = raw.ok && raw.value && typeof raw.value === 'object' ? (raw.value as { title?: unknown }).title : undefined;
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [], refs: true, base: repository.base });
      const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const factoryBranches = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${ticket.number}-`)) : null;
      const app = await github.appIdentity(repository);
      // Review HIGH: linking requires the branch push activity; it must be readable by the App (GET only).
      const activity = await github.read(repository, 'publication-read', session => session.list(`/repos/${repository.repository}/activity?ref=refs%2Fheads%2F${repository.base}`, { maxPages: 1 }));
      if (!activity.ok) { await save('preflight-held', { activity }); throw new Error('ACTIVITY_NOT_READABLE'); }
      if (publication.kind !== 'observed' || associated?.completeness !== 'complete' || associated.candidates.length || !refs || factoryBranches?.length ||
        !refs[`refs/heads/${repository.base}`] || publication.baseProtection?.state !== 'pull-request-required' || !app ||
        issue.kind !== 'observed' || title !== ticket.title) {
        await save('preflight-held', { publication, factoryBranches, app, issue, title }); throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', { status: 'success', operators: [operator], issue, base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] }, refs,
        baseProtection: publication.baseProtection, app, associatedPullRequests: 0 });
      return;
    }
    const operators = (await load('preflight-result'))?.operators as { login: string; id: number }[] | undefined;
    if (!Array.isArray(operators) || operators.length !== 1) throw new Error('OPERATOR_IDENTITY_UNRESOLVED');
    if (phase === 'run' || phase === 'race' || phase === 'reconcile' || phase === 'finish') { await runControl(phase, save, operators); return; }
    // inspect / stop-environment: a private COPY of the storage (the original is never written).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = workOf(list);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const { needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const sessions: Record<string, unknown>[] = [];
      const pushes: string[] = [];
      for (const execution of [...work.previousExecutions, work.execution]) {
        if (!execution.dispatch.boot) continue;
        const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 12)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            if (!('text' in read)) { sessions.push({ executionId: execution.executionId, launch, file: String(file), ...read }); continue; }
            const calls = sessionCommands(read.text);
            pushes.push(...calls.flatMap(call => call.command ? [call.command] : []));
            sessions.push({ executionId: execution.executionId, launch, file: String(file), calls, tokenPattern: /gh[pousr]_[A-Za-z0-9_]{20,}|PRIVATE KEY/.test(read.text) });
          }
        }
      }
      const { github, tracker, codeRepository } = await compose();
      const head = work.publication?.pullRequest?.headSha ?? null;
      const humans = ([1, 2] as const).map(step => ({ step, observed: null as unknown }));
      for (const item of humans) item.observed = await load(`human-step-${item.step}-observed`);
      const compare = async (from: string) => head ? github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/compare/${from}...${head}`)) : null;
      const contents = async (path: string) => head ? github.read(repository, 'publication-read', session => session.get(`/repos/${repository.repository}/contents/${path}?ref=${head}`)) : null;
      const human = [];
      for (const item of humans) {
        const sha = ((item.observed as { seen?: { sha?: string } } | null)?.seen?.sha) ?? null;
        human.push({ step: item.step, sha, compareToHead: sha ? await compare(sha) : null, file: await contents(humanSteps[item.step].file) });
      }
      const remote = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: work.branch ? [work.branch] : [], refs: true, base: repository.base });
      const issue = await tracker.readTicket(work.ticket);
      await save('inspect-result', { work: { work_id: work.work_id, branch: work.branch, pullRequest: work.pullRequest, publication: work.publication, impediments: work.impediments,
        budget: work.budget, history: work.history.filter(item => item.event.startsWith('publication') || item.event.startsWith('reconciliation') || item.event.startsWith('question')) },
      executions: [...work.previousExecutions, work.execution].map(item => ({ executionId: item.executionId, phase: item.dispatch.phase, request: item.request, credential: item.credential,
        end: item.end, held: item.held, finalCapture: item.review?.rounds.at(-1)?.handoff.summary ?? null, verification: item.review?.verification ?? null })),
      human, pushViolations: pushViolations(pushes, [...work.previousExecutions, work.execution].flatMap(item => item.request.publication ? [{ branch: item.request.publication.branch,
        head: item.request.publication.head, expected: item.request.publication.expectedRemote.state === 'present' ? item.request.publication.expectedRemote.sha : null }] : [])),
      sessions, remote, issue, preflight: await load('preflight-result') });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q21 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    // The namespace's key copy is removed once the last GitHub phase ran (inspect), never earlier.
    if (phase === 'inspect') await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
