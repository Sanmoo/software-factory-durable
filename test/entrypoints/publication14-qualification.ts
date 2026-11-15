import type { ExecutionView, WorkView } from '../../src/control/index.js';
import { readBounded, snapshotStorage } from './review12-qualification.js';
export { readBounded, snapshotStorage };

// TEST ONLY. Ticket 14 one-shot real publication qualification recipe. Import and `--plan` are inert. Every other phase is a REAL effect and
// requires an explicit operator grant: real GitHub (App), a real Gondolin/KVM VM and the real model. Phases are one-shot: an exclusive
// intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.
// GitHub WRITES of this recipe (all by the Builder, directly, in its guest, with its own repo-restricted `builder-publish` grant): ONE push
// creating the Work's own branch `factory/3-<work8>` and ONE draft pull request from it to `main` in Sanmoo/java-springboot-event-sourcing.
// Never a merge, approval, ready conversion, label/assignee change, push to main or to another branch by design (skill + prompt), and the
// controller itself never pushes or creates a pull request. Composes ticket 13's multi-round reviews and end-of-Execution verification.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q14-publication-v8`;
const revision = 'q14-publication-v8';
const phases = ['preflight', 'run', 'discover', 'inspect', 'stop-environment'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedTicket = { number: 3, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const runDeadlineMs = 80 * 60 * 1000;
const discoverDeadlineMs = 25 * 60 * 1000;
/** Leftover of the consumed v6 run (its push landed, `gh pr create` failed for lack of an exported PATH): tolerated only at exactly this tip. */
export const leftoverBranches: Readonly<Record<string, string>> = { 'refs/heads/factory/3-28c75e5a': '8c0495962444a3cd9331d83529c10d6eead6422e' };
/** Ticket 13 composition: captures per Builder activation (handoffs + closing) and reviewer rounds at most. */
const rounds = { max: 4 } as const;
/** Long cadence: the dispatcher tick (discovery + selection) follows each polling cycle; the first cycle runs at start. */
const pollingSeconds = 120;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder: 'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never request broader ' +
    'access or use another credential. Never push, open pull requests or change GitHub state, EXCEPT inside a publication activation the Factory requests ' +
    '(a `publish` message or a Factory publication instruction): then follow it and the pr skill exactly (your own branch, the verified commit, the explicit ' +
    'lease, ONE draft pull request) and never merge, approve, mark ready or touch anything else. Report blockers instead of working around them.',
  standards: 'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec: 'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
/** v6 = ticket 14 publication on top of the ticket 13 pack v5. */
const skillPack = 'factory-skills-v6' as const;
/** The Ticket text the operator puts on issue #3 for this run (documentation only; one documented gate). Same smoke as ticket 13. */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_SMOKE.md`. This exact upper-case file name was decided by the operator: keep it even if other docs use another naming style.',
  '', 'Required content:',
  '1. A `# Factory smoke` title and one paragraph explaining that this file exists only to exercise the Software Factory review loop.',
  '2. A `## Steps` section with a numbered list of exactly three steps: build, review, merge.',
  '3. A `## Rollback` section saying the file can be deleted at any time without other changes.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_SMOKE.md && grep -q \'^## Steps\' docs/FACTORY_SMOKE.md && grep -q \'^## Rollback\' docs/FACTORY_SMOKE.md`'].join('\n');

export function plan() {
  return { revision, root, observations, phases, repository, expectedTicket, configuration, guestAssets,
    requires: 'factory-skills-v5 and factory-skills-v6 registered and loadable (v6 continuation-capable); reviews.rounds composed',
    model: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', auth: 'factory-oauth (operator first-login store under root/credentials)', sameModelForAllRoles: true,
      builder: { skillPack, budget: 'builder-v1', maxRequests: 60, maxToolCalls: 120, deadlineMinutes: 30, activations: 2, captures: rounds.max },
      reviewers: { roles: ['standards', 'spec'], budget: 'reviewer-v1', maxRequestsEach: 24, maxToolCallsEach: 80, deadlineMinutesEach: 15, tools: ['read'], maxRounds: rounds.max,
        onlyForTheImplementationExecution: true },
      maxRequestsTotal: 2 * 60 + 24 * 2 * rounds.max, providerRetries: 0, sdkRetries: 0, providerBillingHardCap: false },
    ticket: { number: expectedTicket.number, title: 'Factory smoke: document the review loop', body: ticketBody },
    github: { app: githubApp, appPermissionsRequired: 'installation must grant Contents RW and Pull requests RW (plus Metadata R, Issues RW for questions); never Workflows/administration write',
      operatorObligation: 'main of the test repository must be protected (no direct push, no merge without human review) with NO bypass for the App: Contents W does not separate push from merge',
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'publication-read {metadata:read, contents:read, pull_requests:read}', 'repository-fetch {metadata:read, contents:read}'],
      builderPurposes: ['builder-start {metadata:read, contents:read, issues:read} (implementation activation + renewals)',
        'builder-publish {metadata:read, contents:write, pull_requests:write, issues:read} (ONLY the publish-only activation: no handoff, no edit tool; at most 2 issuances: initial + one renewal)'],
      appIdentity: 'GET /app (slug) + GET /users/<slug>[bot] (installation token): pinned at preflight and required as the own PR author',
      reviewerCredentials: 'none',
      writes: ['Builder (guest, direct): 1 git push creating refs/heads/factory/3-<work8> at the verified commit with --force-with-lease=refs/heads/<branch>: (branch must not exist)',
        'Builder (guest, direct): 1 draft pull request factory/3-<work8> -> main whose body starts with <!-- software-factory:work:<work-id> --> and contains Closes #3',
        'discover (only in the PR-only recovery): at most 1 draft pull request creation by the Builder, never a push',
        'App: access_tokens issuance POSTs and DELETE /installation/token self-revocations of the grants',
        'controller: at most one Question comment on issue #3 only if the Builder asks (ask_user); the recipe then stops (no answer)'],
      never: ['merge', 'approval', 'ready-for-review conversion', 'push to main or any other branch', 'labels/assignees/Projects', 'closing the issue or the PR', 'branch deletion/cleanup'] },
    effects: [
      'preflight: read-only GitHub: the configured label lists exactly Ticket #3; ticket, native blocked_by and its associated pull requests (must be NONE); every branch/tag tip ' +
        '(no `factory/3-` branch may exist except the v6 leftover factory/3-28c75e5a at exactly 8c04959; it is another Work\'s branch, never adopted); main must require pull requests with NO bypass for the App (ruleset current_user_can_bypass never, or classic required reviews without App bypass); the App bot identity',
      'run: new Control storage; implementation Execution (ticket 13 rounds, verification); next tick: discovery (own branch tip, all refs, base protection, correlated PRs) -> absent -> ' +
        'publication requested; next cycle: ONE publish-only activation (new boot, same Work checkout, builder-publish grant, new session without handoff/edit) where the Builder pushes and ' +
        'creates the draft PR directly. From the moment the publication activation is observed, the recipe makes every discovery read of the own branch FAIL (lost result provoked): ' +
        'Control records nothing about the PR. The owner stops when the publication Execution ended and its boot was stopped (or any hold/block, or the 80 min deadline)',
      'discover: a NEW owner process on the SAME storage with the real adapter: it must discover and link the own draft PR before anything else. Only if the push landed but no PR ' +
        'exists (own branch absent in the request snapshot, now at exactly the verified head, no other ref changed) Control requests ONE PR-only continuation (no push): the ' +
        'recipe then allows exactly one prepare, one publication Builder and its publish grant(s) (at most 2), nothing else; stops at published/blocked or 25 min',
      'inspect: read-only on an exclusive COPY: Control view (publication record, discoveries, Executions); checkout through a Factory-owned bare copy (never host git on the guest tree); ' +
        'confined read of /artifacts/publication/pr-body.md; tool names, read paths and bash command texts of each worker session (host runtime directory); read-only GitHub: own PR facts, main tip, issue state',
      'stop-environment: own boot of the last recorded Execution when it may still run: public Sandbox.stop of that exact boot',
    ],
    guards: ['one-shot intent tombstones', 'prepare at most twice and only for the Work of Ticket #3', 'Builder activations: one implementation, then ONE publication (phaseId builder-publication) of another Execution of the same Work',
      `reviewers only for the implementation Execution, at most ${rounds.max} rounds per role`, 'builder-publish issued only after Control requested the publication, at most 2', 'no retry', 'no remove/cleanup',
      'discover phase: prepare/activate/issue refused'],
    expected: ['implementation Execution: ended completed, cessation confirmed, review.verification.status verified (otherwise publication.state not-publishable with reasons, and NO GitHub write)',
      'publication.state requested after the first discovery (trigger verified, outcome absent, branch absent), expectedRemote {state: absent}',
      'publication Execution: request.publication {basisExecutionId, head = verified head, branch, base main, marker, expectedRemote absent, pullRequest null}, credential.purpose builder-publish, ' +
        'phaseId builder-publication, no handoff, policies without edit, prompt starts with `Factory publication instruction (publish-only session`; publication.attempts records it at the activation commit',
      'publication session: bash commands include the explicit --force-with-lease=refs/heads/<branch>: and gh pr create --draft (normal records); no merge/ready/approve command',
      'end of run: publication.state awaiting-discovery with incomplete discoveries (provoked), pullRequest null — the Factory did NOT learn the result from the Builder',
      'discover: publication.state published, pullRequest {draft: true, headSha = verified head, headRef = own branch, base main, author = pinned App bot}, Work.pullRequest set, ' +
        'description conformant (otherwise blocked DESCRIPTION_NONCONFORMANT with its reasons), no unexpected ref change vs refsBefore, no new Execution; issue open; main tip unchanged; PR open, draft, not merged',
      'no token in storage/receipts/sessions/observations'],
  };
}

/** `factory/<ticket>-` branches other than the known leftover at exactly its recorded tip (another tip of it is not tolerated). */
export function unexpectedFactoryBranches(refs: Record<string, string>): string[] {
  return Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${expectedTicket.number}-`) && leftoverBranches[ref] !== refs[ref]);
}

/**
 * Discover-phase guard: at most ONE PR-only continuation (ticket 14 real-run recovery). Allowed only while Control's own publication
 * requests it — `requested` with the remote ALREADY at the verified head (no push) — and for its renewal; nothing else is ever launched.
 */
export function recoveryGuard(maxGrants = 2) {
  let prepared = false, activated = false, grants = 0;
  const prOnly = (publication: { state: string; expectedRemote?: { state: string; sha?: string } | null; verified?: { head: string } | null } | null | undefined) =>
    Boolean(publication && publication.state === 'requested' && publication.expectedRemote?.state === 'present' && publication.expectedRemote.sha === publication.verified?.head);
  return {
    prepare(publication: Parameters<typeof prOnly>[0]) { if (prepared || !prOnly(publication)) return false; prepared = true; return true; },
    activate(context: { role: string; phaseId: string }) { if (activated || !prepared || context.role !== 'builder' || context.phaseId !== 'builder-publication') return false; activated = true; return true; },
    issue(purpose: string | undefined, publication: Parameters<typeof prOnly>[0], running: boolean) {
      if (purpose !== 'builder-publish' || grants >= maxGrants || !(prOnly(publication) || (running && publication?.state === 'awaiting-discovery'))) return false;
      grants++;
      return true;
    },
  };
}

/**
 * Activation guard of the run phase: ONE implementation Builder, its reviewers (distinct rounds, at most `maxRounds` per role, same
 * Execution), then ONE publication Builder (phaseId builder-publication) of ANOTHER Execution of the same Work; nothing else.
 */
export function activationGuard(maxRounds: number = rounds.max) {
  let implementation: { workId: string; executionId: string } | undefined;
  let publication = false;
  const seen: Record<string, Set<number>> = { standards: new Set(), spec: new Set() };
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, review?: { round: number }) => {
    if (context.role === 'builder') {
      if (!implementation) { if (context.phaseId === 'builder-publication') return false; implementation = { workId: context.workId, executionId: context.executionId }; return true; }
      if (publication || context.phaseId !== 'builder-publication' || context.workId !== implementation.workId || context.executionId === implementation.executionId) return false;
      publication = true;
      return true;
    }
    const used = seen[context.role];
    if (!used || !implementation || publication || context.executionId !== implementation.executionId || !review || used.has(review.round) || used.size >= maxRounds) return false;
    used.add(review.round);
    return true;
  };
}

/**
 * Grant guard: `builder-publish` only for the publication activation's own lifecycle — its initial issuance while Control's publication
 * is `requested`, and a renewal while that activation runs (the publication is then `awaiting-discovery` with its attempt recorded) —
 * at most `max` issuances; never another purpose.
 */
export function grantGuard(max = 2) {
  let publish = 0;
  return (purpose: string | undefined, lifecycle: { publicationState: string | null; publicationActivation: boolean }) => {
    if ((purpose ?? 'builder-start') === 'builder-start') return true;
    const own = lifecycle.publicationState === 'requested' || (lifecycle.publicationState === 'awaiting-discovery' && lifecycle.publicationActivation);
    if (purpose !== 'builder-publish' || !own || publish >= max) return false;
    publish++;
    return true;
  };
}

/** Lost-result provocation: discovery reads of the own branch fail from the moment the publication activation was observed. */
export function lostResult() {
  let provoked = false;
  return { provoke() { provoked = true; }, refuses(knownBranches: string[]) { return provoked && knownBranches.length > 0; } };
}

/** Tool calls of one worker session JSONL with bash command texts (bounded); tokens are reported as a pattern hit, never copied. */
export function sessionCommands(jsonl: string) {
  const calls: { name: string; path?: string; command?: string }[] = [];
  for (const line of jsonl.split('\n').slice(0, 20000)) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: { type?: string; name?: string; arguments?: { path?: unknown; command?: unknown } }[] } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) if (block.type === 'toolCall' && typeof block.name === 'string') {
      const command = typeof block.arguments?.command === 'string' ? block.arguments.command.replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[TOKEN-PATTERN]').slice(0, 1024) : undefined;
      calls.push({ name: block.name, ...(typeof block.arguments?.path === 'string' ? { path: block.arguments.path.slice(0, 512) } : {}), ...(command ? { command } : {}) });
    }
  }
  return calls.slice(0, 500);
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
  return { fs, save, exists };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}

const workOf = (list: unknown): WorkView | undefined => (list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works[0] : undefined;
const ended = (execution: ExecutionView | null | undefined) => Boolean(execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped')));

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists } = await io();
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { factorySkillPackIds } = await import('../../src/contracts/index.js');
      const { skillPackContinues } = await import('../../src/workers/index.js');
      // Each pack is loaded with its manifest/hash verification by `skillPackContinues`; v6 must be the continuation-capable newest one.
      for (const id of ['factory-skills-v5', 'factory-skills-v6'] as const) {
        if (!(factorySkillPackIds as readonly string[]).includes(id) || !await skillPackContinues(id)) throw new Error('SKILL_PACK_NOT_READY');
      }
      if (factorySkillPackIds.at(-1) !== skillPack) throw new Error('SKILL_PACK_NOT_NEWEST');
      const { github, tracker, codeRepository } = await compose();
      const listing = await tracker.listCandidates(repository);
      if (listing.kind !== 'observed' || listing.candidates.length !== 1 || listing.candidates[0]!.number !== expectedTicket.number ||
        listing.repositoryId !== expectedTicket.repositoryId) { await save('preflight-held', { listing }); throw new Error('PRECONDITION_HELD'); }
      const ticket = await tracker.readTicket(listing.candidates[0]!);
      const graph = await tracker.readDependencyGraph(listing.candidates[0]!);
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [expectedTicket.number], knownBranches: [], refs: true, base: repository.base });
      const associated = publication.kind === 'observed' ? publication.issues[String(expectedTicket.number)] : undefined;
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const factoryBranches = refs ? unexpectedFactoryBranches(refs) : null;
      const app = await github.appIdentity(repository);
      if (publication.kind !== 'observed' || associated?.completeness !== 'complete' || associated.candidates.length || !refs || factoryBranches?.length ||
        !refs[`refs/heads/${repository.base}`] || publication.baseProtection?.state !== 'pull-request-required' || !app) {
        await save('preflight-held', { publication, factoryBranches, app }); throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', { status: 'success', ticket, graph: { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems },
        base: { state: 'present', sha: refs[`refs/heads/${repository.base}`] }, refs, baseProtection: publication.baseProtection, app, associatedPullRequests: 0 });
      return;
    }
    if (!(await exists('preflight-result'))) throw new Error('PREFLIGHT_REQUIRED');
    if (phase === 'run' || phase === 'discover') {
      if (phase === 'discover' && !(await exists('run-result'))) throw new Error('RUN_REQUIRED');
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox } = await import('../../src/sandbox/index.js');
      const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
      const pack = builderSkillPacks[skillPack];
      const { openControl } = await import('../../src/control/index.js');
      const sandbox = createSandbox({ root, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
        artifactSeeds: [{ name: pack.seedName, directory: pack.directory }] });
      const workers = createWorkers({ root, knownSecrets: [], profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
        profiles: { builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model }, standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
          spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model } } });
      const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
      const events: unknown[] = [];
      const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
      let prepared = 0;
      const guard = activationGuard();
      const grants = grantGuard();
      const recovery = recoveryGuard();
      const lost = lostResult();
      const discovering = phase === 'discover';
      const shown = async () => workOf(await control.inspect({ kind: 'list' }));
      const control = await openControl({ storagePath: `${observations}/control.sqlite`,
        // Recipe decision: root/environments holds only earlier qualification resources and this storage's own ceased boots.
        runtimeInventory: 'empty',
        access: { tracker, repository: { checkAccess: (repo, base) => codeRepository.checkAccess(repo, base),
          // Ticket 15 (GET-only checks explanation of the linked own PR) composes unchanged.
          readPullRequest: query => codeRepository.readPullRequest(query), setDraft: async () => ({ kind: 'known-failure' as const, observedAt: new Date().toISOString(), code: 'RECIPE_NO_READINESS', nextStep: 'This recipe never converts draft/ready; nothing was sent.', revocation: 'not-issued' }), async findPublication(correlation) {
          if (!discovering && lost.refuses(correlation.knownBranches)) { log({ call: 'find-publication-refused', knownBranches: correlation.knownBranches }); throw new Error('RECIPE_LOST_RESULT'); }
          const result = await codeRepository.findPublication(correlation);
          log({ call: 'find-publication', knownBranches: correlation.knownBranches, kind: result.kind, ...(result.kind === 'observed' ? { branches: result.branches,
            candidates: Object.values(result.issues).flatMap(item => item.completeness === 'complete' ? item.candidates.map(candidate => ({ number: candidate.number, headRef: candidate.headRef,
              headSha: candidate.headSha, draft: candidate.draft, author: candidate.author.login })) : []) } : { code: result.code }) });
          return result;
        } }, repositories: [repository], dependencyRepositories: [], factoryApp: () => github.appIdentity(repository) }, polling: { intervalSeconds: pollingSeconds },
        execution: { configuration, capacity: 1, builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
          // Ticket 13 composition (multi-round reviews + end-of-Execution verification).
          reviews: { reviewer, rounds },
          credentials: { async issue(context) {
            const work = await shown();
            const running = Boolean(work?.execution?.request.publication) && work?.execution?.executionId === context.executionId && work.execution.state !== 'ended';
            const allowed = work?.ticket.number === expectedTicket.number && (discovering ? recovery.issue(context.purpose, work.publication, running)
              : grants(context.purpose, { publicationState: work.publication?.state ?? null, publicationActivation: running }));
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
              const ok = work?.work_id === input.workId && work.ticket.number === expectedTicket.number && (discovering ? recovery.prepare(work.publication) : ++prepared <= 2);
              if (!ok) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
              const result = await sandbox.prepare(input);
              log({ call: 'prepare-result', result });
              return result;
            },
            async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
            async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
            async observeProposal(input) { const result = await sandbox.observeProposal(input); log({ call: 'observe-proposal', round: input.round, result }); return result; },
          },
          workers: { async deliver(worker, directive) {
            log({ call: 'deliver', kind: directive.kind, ...(directive.kind === 'review-results' ? { round: directive.round, bytes: Buffer.byteLength(directive.prompt) } : {}) });
            const result = await workers.deliver(worker, directive);
            log({ call: 'delivered', kind: directive.kind, result });
            return result;
          }, async observe(input) { const result = await workers.observe(input); log({ call: 'observe-session', state: result.session.state }); return result; },
          async activate(invocation, delivery, activationEvents) {
            log({ call: 'activate', context: invocation.context, promptSha256: (await import('node:crypto')).createHash('sha256').update(invocation.prompt).digest('hex'),
              promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160), continuation: Boolean(invocation.continuation), review: invocation.review ?? null, handoff: invocation.handoff ?? null,
              credentialDelivered: delivery?.credential !== undefined });
            if (discovering ? !recovery.activate(invocation.context) : !guard(invocation.context, invocation.review)) throw new Error('RECIPE_ONE_SHOT_GUARD');
            // From here on the Factory must not learn the publication result in this phase (provoked lost result).
            if (invocation.context.phaseId === 'builder-publication') lost.provoke();
            const handle = await workers.activate(invocation, delivery, activationEvents);
            const role = invocation.context.role;
            void handle.started.then(start => log({ call: 'started', role, receipt: start.receipt.id }), () => log({ call: 'start-failed', role }));
            void handle.completed.then(done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
              () => log({ call: 'completion-uncertain', role }));
            return handle;
          } } } });
      const stop = new AbortController();
      const running = control.run(stop.signal);
      const deadline = Date.now() + (discovering ? discoverDeadlineMs : runDeadlineMs);
      let final: unknown;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const list = await control.inspect({ kind: 'list' });
        const work = workOf(list);
        const publication = work?.publication;
        const settled = discovering
          ? ['published', 'blocked'].includes(publication?.state ?? '')
          : (ended(work?.execution) && (Boolean(work!.execution!.request.publication) || work!.execution!.state !== 'ended' || work!.execution!.end?.outcome !== 'completed')) ||
            ['not-publishable', 'blocked'].includes(publication?.state ?? '');
        if (settled) { final = list; break; }
      }
      final ??= await control.inspect({ kind: 'list' });
      const status = await control.inspect({ kind: 'status' });
      stop.abort();
      const outcome = await running;
      await save(`${phase}-result`, { status: 'observed', outcome, final, controlStatus: status, events, deadlineReached: Date.now() >= deadline });
      return;
    }
    // Authority is the recipe's own storage, opened ONLY as a private copy (the original is never written by inspect/stop).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const stopped = new AbortController(); stopped.abort();
    await stored.run(stopped.signal);
    const work = workOf(list);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    const environmentDirectory = `${root}/environments/${work.execution.dispatch.environment}`;
    const { inspectEnvironment, needsStop } = await import('./builder09-qualification.js');
    if (phase === 'inspect') {
      const { readConfined } = await import('../../src/sandbox/index.js');
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const artifacts = `${environmentDirectory}/artifacts`;
      const body = await readConfined(artifacts, 'publication/pr-body.md', 64 * 1024)
        .then(bytes => bytes === null ? { absent: true } : { bytes: bytes.length, text: bytes.toString('utf8') }, (error: Error) => ({ error: error.message }));
      const sessions: Record<string, unknown>[] = [];
      for (const execution of [...work.previousExecutions, work.execution].slice(-4)) {
        if (!execution.dispatch.boot) continue;
        const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
        for (const launch of (await fs.readdir(runtime).catch(() => [])).filter(name => name.startsWith('w-')).sort().slice(0, 12)) {
          const directory = `${runtime}/${launch}/profile/sessions`;
          for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
            const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
            sessions.push('text' in read ? { executionId: execution.executionId, launch, file: String(file), bytes: Buffer.byteLength(read.text), calls: sessionCommands(read.text),
              tokenPattern: /gh[pousr]_[A-Za-z0-9_]{20,}|PRIVATE KEY/.test(read.text) } : { executionId: execution.executionId, launch, file: String(file), ...read });
          }
        }
      }
      // Read-only GitHub observation of the final remote state (own PR, own branch, main tip, issue still open).
      const { tracker, codeRepository } = await compose();
      const remote = await codeRepository.findPublication({ repo: repository, issueNumbers: [expectedTicket.number], knownBranches: work.branch ? [work.branch] : [], refs: true, base: repository.base });
      const ticket = await tracker.readTicket(work.ticket);
      const preflight = JSON.parse(await fs.readFile(`${observations}/preflight-result.json`, 'utf8')) as { base: unknown; refs: unknown };
      await save('inspect-result', { work: { work_id: work.work_id, branch: work.branch, pullRequest: work.pullRequest, publication: work.publication, impediments: work.impediments,
        history: work.history.filter(item => item.event.startsWith('publication') || item.event.startsWith('execution')) },
      executions: [...work.previousExecutions, work.execution].map(item => ({ executionId: item.executionId, mode: item.mode, state: item.state, request: item.request, credential: item.credential,
        credentialRenewals: item.credentialRenewals.map(renewal => renewal.metadata?.purpose ?? null), end: item.end, held: item.held,
        verification: (item.review as { verification?: unknown } | undefined)?.verification ?? null })),
      prBody: body, sessions, remote, ticket, baseBefore: preflight.base, refsBefore: preflight.refs, ...await inspectEnvironment(environmentDirectory, observations, work.execution.request.baseCommit ?? undefined) });
      return;
    }
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    const environment = work.execution.dispatch.environment as never, boot = work.execution.dispatch.boot as never;
    const before = await sandbox.observe({ environment, boot });
    const result = before.condition === 'active' ? await sandbox.stop({ environment, boot, reason: 'q14 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
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
