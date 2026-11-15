import type { ExecutionPorts, ListView, QuestionView, RuntimeInventory, ShowView, WorkView } from '../../src/control/index.js';
import type { AccessDependencies } from '../../src/control/index.js';
import type { IssueTracker } from '../../src/issue-tracker/index.js';
import type { CodeRepository } from '../../src/code-repository/index.js';
import { createHash } from 'node:crypto';

// TEST ONLY. Ticket 18 one-shot real qualification recipe: the FIRST INTEGRATED JOURNEY of one real Ticket through the PRODUCTION composition
// (`composeProductionAccess` + `composeProductionExecution` of src/entrypoints/controller/composition.ts, configuration validated by the
// production `readConfiguration`), never a per-ticket wiring. Import and `--plan` are inert. Every other phase is a REAL effect and needs an
// explicit operator grant per run: real GitHub (App), real Gondolin/KVM VMs, the real model. One-shot: exclusive intent tombstones precede
// effects; a consumed phase never reruns; a phase runs only after the previous one SUCCEEDED; nothing is retried automatically.
// The recipe only OBSERVES and BOUNDS the production ports (counts, Ticket identity, phase); it never changes what they do. The Factory never
// merges, approves or bypasses: the Question's answer (a REAL `/factory answer` comment), the approval and the merge are the operator's.
// A merge-blocking base rule (ticket 39, e.g. `update` = Restrict updates on main of the test repository) is an EXPLAINED STOP the recipe
// detects and reports, never works around.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q18-journey-v4`;
const revision = 'q18-journey-v4';
export const phases = ['preflight', 'run', 'resume', 'ready', 'deliver', 'inspect', 'stop-environment'] as const;
export type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' } as const;
const repositoryId = 1256893534;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' } as const;
const operatorLogin = 'Sanmoo';
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const sandbox = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const pollingSeconds = 60;
const deadlines = { run: 90, resume: 150, ready: 15, deliver: 20 } as const; // minutes; resume includes waiting for the real answer comment
const answerWaitMinutes = 60;
const gh = { trace: `${observations}/gh-trace.jsonl`, maxComments: 2, maxDraftMutations: 2 } as const;
/** Bounds per owner phase (counted on the production ports; anything beyond is refused locally, never sent). */
export const bounds = { prepares: 2, builders: 2, reviewers: 2 * 4 * 2, builderStart: 8, builderPublish: 2, comments: gh.maxComments, setDraft: gh.maxDraftMutations, cleanupBranch: 1 } as const;
/** Pins the gh guard reads at request time (written by the recipe from Control's own records, never guessed). */
export const pins = { ownPullRequest: 'own-pull-request.json', cleanup: 'cleanup-armed', repository: 'repository-pin.json' } as const;

/** The Ticket text the supervisor puts on the NEW synthetic issue (documentation only; one documented gate; one pinned question). */
export const ticketBody = [
  'Add a short documentation page `docs/FACTORY_JOURNEY.md`. This exact upper-case file name was decided by the operator: keep it even if other docs use another naming style.',
  '', 'Required content:',
  '1. A `# Factory journey` title and one paragraph explaining that this file exists only to exercise the Software Factory integrated delivery journey.',
  '2. A `## Steps` section with a numbered list of exactly four steps: build, review, publish, merge.',
  '3. A third section whose title the operator decides. BEFORE writing the file, ask the operator with the ask_user tool exactly: "Which title should the third ' +
    'section of docs/FACTORY_JOURNEY.md have: `## Rollback` or `## Removal`?" and wait for the answer. Use exactly the answered title; the section says the ' +
    'file can be deleted at any time without other changes.',
  '', 'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Commit the change on your branch.',
  '', 'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and put the directory change inside the command; it must exit 0):',
  '`cd /workspace/checkout && test -f docs/FACTORY_JOURNEY.md && grep -q \'^## Steps\' docs/FACTORY_JOURNEY.md && grep -q \'^## Rollback\' docs/FACTORY_JOURNEY.md`'].join('\n');
/**
 * The NEW synthetic issue on Sanmoo/java-springboot-event-sourcing. `number: null` until the supervisor creates it AFTER the operator's
 * authorization and pins its number here (title and body must then be exactly these): every effect phase refuses `TICKET_NOT_PINNED` before.
 */
export const ticket = { number: null as number | null, // consumed: v1 held (label listed #1/#7), v2 #7, v3 #10, v4 #14 PASSED; a rerun needs a NEW namespace and issue
  title: 'Factory journey: document the integrated delivery', body: ticketBody, label: repository.label };
/** The answer the operator authorized for the pinned question: posted by the supervisor, with the operator's gh account, as a REAL comment. */
export const pinnedAnswer = 'Use `## Rollback` as the title of the third section.';
/** The exact `/factory answer` comment body and the command that posts it (the Factory never posts it; the recipe never answers locally). */
export function answerCommand(issue: number, questionId: string) {
  const body = `/factory answer ${questionId} ${pinnedAnswer}`;
  return { body, command: `gh issue comment ${issue} --repo ${repository.repository} --body ${JSON.stringify(body)}`,
    account: `the operator's own gh account (${operatorLogin}, pinned operator id from preflight-result.operator)` };
}

export function plan() {
  return { revision, root, observations, phases, repository: { ...repository, repositoryId }, ticket, pinnedAnswer, guestAssets, sandbox, pollingSeconds, deadlinesMinutes: deadlines,
    answerWaitMinutes, bounds,
    composition: {
      production: 'src/entrypoints/controller/composition.ts: composeProductionAccess (owner access: IssueTracker, CodeRepository, operators, lazy App identity) + ' +
        'composeProductionExecution (release profile for the three roles; Builder prompt chosen PER SESSION MODE by productionBuilderPrompt; latest continuation skill pack ' +
        '= factory-skills-v6; reviews {rounds 4, partialRecovery}; real Builder credentials; Sandbox/Workers; cleanup = Sandbox.remove + Records ' +
        'preservation; capacity 1; no clock deadline)',
      configuration: `${observations}/config.yaml written by preflight and validated by the production readConfiguration (operators pinned by id, models = release profile)`,
      roots: { execution: `${root} (Sandbox environments/runtime, Workers OAuth store credentials/chatgpt.json, Records evidence): the shared qualification root, never copied`,
        github: `${observations} (GitHub access root: run/ for gh dirs; credentials/app.pem = a COPY of ${root}/credentials/app.pem taken at the start of each phase and removed at its end, also on failure)`,
        storage: `${observations}/control.sqlite under an exclusive flock (control.lock)` },
      inventory: `production inventoryRuntime(${root}) restricted to environments attributed to Works of THIS storage (supervisor decision): the shared qualification root ` +
        'holds other storages\' environments a real installation would not; the full listing is recorded; an unknown entry, an environment without owner attribution or a ' +
        'cache in preparation holds the phase',
      recipeWrappers: 'observation + bounds only (counts, pinned Ticket, phase), every port and write method wrapped explicitly; gh behind a write allow-list guard',
    },
    model: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', auth: 'factory-oauth (operator first-login store under root/credentials)', sameModelForAllRoles: true,
      builder: { budget: 'builder-v1', activations: 'initial (run) + one recovery after the real answer + one publish-only (resume)', maxRequests: 60, maxToolCalls: 120 },
      reviewers: { budget: 'reviewer-v1', maxRounds: 4, maxRequestsEach: 24, maxToolCallsEach: 80 }, providerRetries: 0, sdkRetries: 0, providerBillingHardCap: false },
    github: { app: githubApp,
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'publication-read', 'checks-read', 'delivery-read', 'repository-fetch',
        'question-publish {metadata:read, issues:write}', 'readiness-write {metadata:read, pull_requests:write} (fresh, single use)',
        'branch-cleanup {metadata:read, contents:write, pull_requests:read} (fresh, single use, deliver only)'],
      builderPurposes: ['builder-start {metadata:read, contents:read, issues:read}', 'builder-publish {metadata:read, contents:write, pull_requests:write, issues:read} (publish-only activation)'],
      guard: `gh (GitHub access root = this namespace) behind a wrapper tracing every request in gh-trace.jsonl: GET without input; POST /app/installations/${repository.installationId}/access_tokens ` +
        `for exactly this repository; POST issues/<pinned>/comments (<= ${gh.maxComments}); the two exact draft mutations ONLY on the own PR node Control linked (pinned in ` +
        `${pins.ownPullRequest}; <= ${gh.maxDraftMutations}); ONE updateRefs deletion of exactly the own branch at the merged linked head, only while deliver arms it ` +
        `(${pins.cleanup}); DELETE /installation/token; anything else exit 97, nothing sent`,
      guestPolicy: 'The Builder guest push guard is ticket 21\'s src/workers/push-policy.ts (single implementation; merge/ready/review/API refusals to be folded in). ' +
        'GitHub permissions cannot separate push from merge, so Control verifies after the publication activation (GUEST_EFFECT_OUT_OF_SCOPE) — the backstop',
      writes: ['controller: Question comment(s) on the pinned issue (marker + body)', 'supervisor with the operator\'s account: ONE `/factory answer <id> <text>` comment',
        'Builder (guest, own grant): ONE push creating refs/heads/factory/<N>-<work8> with an explicit lease, ONE draft PR',
        'controller: markPullRequestReadyForReview of the own PR (only from complete current evidence; NOT while a merge-blocking rule is active)',
        'controller (deliver): ONE atomic updateRefs deletion of the own branch at the merged head', 'App: access_tokens issuance and DELETE /installation/token self-revocations'],
      never: ['merge', 'approval or review', 'bypass', 'push to main or another branch', 'ruleset/protection change', 'labels/assignees', 'closing the issue or the PR', 'implicit retry',
        'a local CLI answer'] },
    operatorSteps: [
      'BEFORE preflight: authorize this run; the supervisor creates the synthetic issue with exactly `ticket.title`/`ticket.body`, label ready-for-agent, and pins its number; ' +
        'it must be the ONLY open issue with that label; the App key is at root/credentials/app.pem',
      `after \`run\` (outcome question-published): the supervisor posts, with the operator's gh account, EXACTLY run-result.answer.command (body \`/factory answer <id> ` +
        `${pinnedAnswer}\`) on the issue, then runs \`resume\`; the controller must ingest that real comment (resume waits up to ${answerWaitMinutes} min)`,
      'if resume ends `merge-blocked` (expected while ruleset 26435808 has `update`): decide. Either stop here (journey demonstrated up to an explained impediment), or remove ' +
        'Restrict updates from main and run `ready` (refused before its intent while `update` is still active; the Factory, not the human, converts the draft to ready)',
      'after readiness is confirmed ready: approve the own PR (required) and merge it with a merge commit, from your own account; no bypass/admin merge, no "Delete branch", ' +
        'no push to the branch; keep "Automatically delete head branches" OFF; then run `deliver`',
      'inspect (also after any held phase), then (only if inspect shows a boot that may still run) stop-environment'],
    effects: [
      'preflight: key-source check BEFORE any effect; exclusive namespace, intent, then credentials/ (key copy) and run/; repository owner pinned as operator id; repository ' +
        'node id pinned; config.yaml written and validated by readConfiguration; production composition summary; read-only GitHub: label lists exactly the pinned issue with ' +
        'exactly the pinned title/body, native blocked_by, no associated PR, every branch/tag tip and no factory/<N>- branch, base protection pull-request-required, App bot ' +
        'identity, raw rules of main (records merge-blocking types such as `update`: expected stop); y5 runtime inventory',
      'run: ONE owner run of the production composition on a new storage: admission/dependencies, queue, start receipt, preserved request, implementation; it STOPS once the ' +
        'pinned ask_user Question is published on the issue and the activation ended with confirmed cessation and released its Slot; records the exact answer command ' +
        '(if the Builder never asks, it continues to the readiness outcome and records the question subcase as NOT exercised)',
      'resume (only after a question-published run): a NEW owner run; waits until the controller ingested the REAL comment (answer origin github-comment from the pinned ' +
        'operator); recovery through the queue (new boot), Standards+Spec rounds with treatments and gates, verification, discovery, ONE publish-only activation (Builder push + ' +
        'draft PR), discovery/link (Control verifies the guest stayed in scope), required checks, readiness: `ready` or `merge-blocked` or another explained stop',
      'ready (only after a merge-blocked run/resume and the operator removed the blocking rule): rules re-read BEFORE the intent (refused while `update` is active); a NEW ' +
        'owner run, no prepare/activation/Builder grant allowed, until the Factory converts the own draft PR to ready (or 15 min)',
      'deliver (only after a confirmed ready and the human merge; precondition re-read: own PR merged by a human at the linked head into main, merged_by recorded, else held ' +
        'before the intent): a NEW owner run, no agent; delivery recorded; evidence preserved; own environment(s) removed; ONE atomic deletion of the own branch',
      'inspect (after any phase, also held ones): read-only on a COPY of whatever storage exists: status/list/show, own PR facts, refs, issue state, environment listing, ' +
        'evidence manifest, gh trace summary, secret scan',
      'stop-environment: own boot of the last Execution when it may still run: public Sandbox.stop of that exact boot'],
    expected: {
      preflight: 'success; `restrictUpdates: true` while ruleset 26435808 keeps `update` (=> resume expected to end merge-blocked)',
      run: 'question-published: Execution initial ended `question`, cessation confirmed, Slot released, Question published on the issue; answer.command recorded',
      resume: ['answer ingested from the real comment (origin github-comment, author = pinned operator); QUESTION_PENDING removed only by it',
        'Executions: recovery QUESTION_ANSWERED (verified: both reviewers complete per reviewed round, findings treated, gates passed) -> recovery PUBLICATION_REQUESTED (builder-publish)',
        'publication published: own draft PR, head = verified head, author = App bot, conformant short description; no GUEST_EFFECT_OUT_OF_SCOPE',
        'with `update` active: readiness not-ready, reason merge MERGE_BLOCKED_UPDATE_RESTRICTED (confirmed), next step "adjust the base protection", NO draft mutation; ' +
          'without it: mark-ready confirmed (one readiness-write grant, revoked)'],
      ready: 'mark-ready confirmed; PR non-draft; Work open (ready is not delivery)',
      deliver: 'delivery delivered (own PR merged by the human, merge confirmed by identity); cleanup complete: environment/checkout/local-branch/temporaries removed, ' +
        'remote-branch removed (or absent if GitHub deleted it); status.delivery {delivered 1, cleanup.complete 1}',
      inspect: 'refs: only the own branch removed (main moved only by the human merge); issue closed by `Closes #<N>`; no token in storage/observations',
    },
    limits: ['one path with a question, findings and a merge-blocking stop; NOT the adversity battery nor pilot usefulness (tickets 34/35)',
      'a guest command guard reads command TEXT (obfuscation is possible): Control\'s post-publication verification is the backstop',
      'consumption: model usage as reported by the sessions; no provider billing hard cap'],
  };
}

type Result = { status?: unknown; outcome?: unknown } | null;
const readyOutcome = (results: Partial<Record<string, Result>>) => ['run', 'resume', 'ready'].some(name => results[name]?.outcome === 'ready');
/**
 * Each phase once; each only after the previous one SUCCEEDED. `resume` only after a question-published run; `ready` only after a
 * merge-blocked run/resume; `deliver` only after a confirmed ready; `inspect`/`stop-environment` after any started preflight (held included).
 */
export function phaseGuard(phase: Phase, results: Partial<Record<'preflight' | 'run' | 'resume' | 'ready' | 'deliver', Result>>, intents: ReadonlySet<string>,
  pinned: number | null = ticket.number): string | null {
  if (pinned === null) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase === 'preflight') return null;
  if (phase === 'inspect' || phase === 'stop-environment') return intents.has('preflight-intent') ? null : 'PREFLIGHT_REQUIRED';
  if (results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if (phase === 'run') return null;
  if (phase === 'resume') return results.run?.outcome === 'question-published' ? null : 'QUESTION_PUBLISHED_RUN_REQUIRED';
  if (phase === 'ready') return results.run?.outcome === 'merge-blocked' || results.resume?.outcome === 'merge-blocked' ? null : 'MERGE_BLOCKED_RUN_REQUIRED';
  return readyOutcome(results) ? null : 'CONFIRMED_READY_REQUIRED';
}

type Outcome = 'question-published' | 'ready' | 'merge-blocked' | 'held' | 'not-publishable' | 'publication-blocked' | 'guest-effect-out-of-scope' | 'question-unanswered' |
  'answer-not-observed' | 'unexpected';
const ceased = (work: WorkView) => work.execution?.end?.outcome === 'question' && work.execution.end.cessation === 'confirmed' && !work.execution.slot.held;
/**
 * Whether an owner phase has settled, and as what (first match wins). `run` stops at the first published Question after cessation. In
 * `resume`, `answered` is the run's Question id: its real answer must be ingested; any OTHER published Question is never answered by the recipe.
 */
export function journeyOutcome(phase: 'run' | 'resume', work: WorkView | undefined, questions: Pick<QuestionView, 'questionId' | 'state' | 'publication'>[], answered: string | null):
  { settled: false } | { settled: true; outcome: Outcome } {
  if (!work) return { settled: false };
  if (work.result !== 'open') return { settled: true, outcome: 'unexpected' };
  if (work.impediments.some(item => item.code === 'GUEST_EFFECT_OUT_OF_SCOPE')) return { settled: true, outcome: 'guest-effect-out-of-scope' };
  if (work.readiness?.effects.some(item => item.action === 'mark-ready' && item.state === 'confirmed')) return { settled: true, outcome: 'ready' };
  if (work.readiness?.latest?.reasons.some(item => item.area === 'merge' && item.certainty === 'confirmed' && item.code.startsWith('MERGE_BLOCKED'))) {
    return { settled: true, outcome: 'merge-blocked' };
  }
  if (work.execution?.state === 'held') return { settled: true, outcome: 'held' };
  if (work.publication?.state === 'not-publishable') return { settled: true, outcome: 'not-publishable' };
  if (work.publication?.state === 'blocked') return { settled: true, outcome: 'publication-blocked' };
  const open = questions.filter(item => item.state === 'open' && item.publication.state === 'published' && item.questionId !== answered);
  if (open.length && ceased(work)) return { settled: true, outcome: phase === 'run' ? 'question-published' : 'question-unanswered' };
  return { settled: false };
}

/** The real answer was ingested: the run's Question is answered from a GitHub comment of the pinned operator (never a local answer). */
export function answerIngested(questions: Pick<QuestionView, 'questionId' | 'state' | 'answer'>[], questionId: string, operatorId: number): 'ingested' | 'waiting' | 'not-the-real-comment' {
  const question = questions.find(item => item.questionId === questionId);
  if (!question || question.state !== 'answered' || !question.answer) return 'waiting';
  const { author, origin } = question.answer;
  return origin.kind === 'github-comment' && author.kind === 'github' && author.id === operatorId ? 'ingested' : 'not-the-real-comment';
}

/** Production inventory restricted to environments attributed to THIS storage's Works (others belong to other qualification storages). */
export function ownInventory(listing: { environments: { environment: string; workId: string | null }[]; cache: RuntimeInventory['cache']; unknown: string[] }, works: ReadonlySet<string>):
  { inventory: RuntimeInventory; excluded: string[]; holds: string[] } {
  const own = listing.environments.filter(item => item.workId !== null && works.has(item.workId));
  return { inventory: { kind: 'listed', observedAt: new Date().toISOString(), environments: own, cache: listing.cache, unknown: listing.unknown },
    excluded: listing.environments.filter(item => item.workId !== null && !own.includes(item)).map(item => item.environment),
    holds: [...listing.unknown.map(item => `UNKNOWN_RESOURCE:${item}`), ...listing.environments.filter(item => item.workId === null).map(item => `ENVIRONMENT_UNATTRIBUTED:${item.environment}`),
      ...listing.cache.filter(item => item.state !== 'idle').map(item => `CACHE_NOT_IDLE:${item.repositoryId ?? 'unknown'}`)] };
}

/** The synthetic issue carries exactly the pinned title and body (GitHub may return CRLF line ends); only hashes are recorded. */
export function pinnedText(issue: { title?: unknown; body?: unknown }): { matches: boolean; titleSha256: string | null; bodySha256: string | null } {
  const sha = (value: unknown) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
  const body = typeof issue.body === 'string' ? issue.body.replace(/\r\n/g, '\n').trimEnd() : null;
  return { matches: issue.title === ticket.title && body === ticket.body, titleSha256: sha(issue.title), bodySha256: sha(body) };
}

/** Deliver precondition: the own PR the storage linked is merged by GitHub, by a HUMAN, at exactly the linked head into main. */
export function deliverPrecondition(linked: { number: number; headSha: string } | null, facts: { merged: boolean; state: string; headSha: string; baseRef: string } | null,
  mergedBy: { login: string; type: string } | null): string | null {
  if (!linked) return 'OWN_PULL_REQUEST_NOT_LINKED';
  if (!facts) return 'OWN_PULL_REQUEST_UNREADABLE';
  if (!facts.merged || facts.state !== 'closed') return 'NOT_MERGED';
  if (facts.headSha !== linked.headSha) return 'HEAD_NOT_LINKED_HEAD';
  if (facts.baseRef !== repository.base) return 'BASE_MISMATCH';
  if (!mergedBy) return 'MERGER_UNKNOWN';
  return mergedBy.type === 'User' && !/\[bot\]$/i.test(mergedBy.login) ? null : 'NOT_MERGED_BY_A_HUMAN';
}

/**
 * Text of the gh wrapper. Traces every request (method, endpoint, kind; never a token). Forwards: GET without input; the App's token
 * issuance for exactly this installation and repository; POST of a comment on the pinned issue (at most `maxComments`); one of the two exact
 * draft mutations ONLY on the own PR node pinned in `own-pull-request.json` (at most `maxDraftMutations` in total); ONE atomic updateRefs
 * deletion of exactly the ref, repository node and beforeOid pinned in `cleanup-armed` (deliver only); DELETE /installation/token.
 * Anything else: exit 97 and gh never runs.
 */
export function journeyGuardScript(input: { node: string; gh: string; trace: string; directory: string; repository: string; installationId: number; issue: number;
  documents: readonly string[]; maxComments: number; maxDraftMutations: number }) {
  return `#!${input.node}
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const at = args.indexOf('--method');
const method = at >= 0 ? args[at + 1] : null;
const endpoint = args.at(-1);
const piped = args.includes('--input');
const directory = ${JSON.stringify(input.directory)};
const slot = (name, max) => { for (let i = 1; i <= max; i++) { try { closeSync(openSync(directory + '/' + name + '-' + i + '.sent', 'wx', 0o600)); return true; } catch {} } return false; };
const pin = name => { try { return JSON.parse(readFileSync(directory + '/' + name, 'utf8')); } catch { return null; } };
let body, kind = 'refused', allowed = false;
const read = () => { body = readFileSync(0, 'utf8'); try { return JSON.parse(body); } catch { return null; } };
if (method === 'GET' && !piped) { allowed = true; kind = 'read'; }
else if (method === 'DELETE' && endpoint === '/installation/token' && !piped) { allowed = true; kind = 'revocation'; }
else if (method === 'POST' && piped && args[args.indexOf('--input') + 1] === '-') {
  const request = read();
  if (endpoint === ${JSON.stringify(`/app/installations/${input.installationId}/access_tokens`)} && request && Object.keys(request).sort().join() === 'permissions,repositories' &&
    Array.isArray(request.repositories) && request.repositories.length === 1 && request.repositories[0] === ${JSON.stringify(input.repository.split('/')[1])}) {
    allowed = true; kind = 'token-issuance';
  } else if (endpoint === ${JSON.stringify(`/repos/${input.repository}/issues/${input.issue}/comments`)} && request && Object.keys(request).join() === 'body' && typeof request.body === 'string') {
    allowed = slot('comment', ${input.maxComments}); kind = allowed ? 'question-comment' : 'refused-comment';
  } else if (endpoint === 'graphql' && request && ${JSON.stringify(input.documents)}.includes(request.query) && Object.keys(request).sort().join() === 'query,variables' &&
    Object.keys(request.variables ?? {}).sort().join() === 'cid,id') {
    const own = pin(${JSON.stringify(pins.ownPullRequest)});
    allowed = Boolean(own && typeof own.nodeId === 'string' && request.variables.id === own.nodeId) && slot('draft-mutation', ${input.maxDraftMutations});
    kind = allowed ? (request.query.includes('markPullRequestReadyForReview') ? 'mark-ready' : 'convert-to-draft') : 'refused-mutation';
  } else if (endpoint === '/graphql' && request && /^mutation\\(\\$repositoryId: ID!, \\$refUpdates: \\[RefUpdate!\\]!\\) \\{ updateRefs\\(input: \\{ repositoryId: \\$repositoryId, refUpdates: \\$refUpdates \\}\\) \\{ clientMutationId \\} \\}$/.test(request.query ?? '')) {
    const armed = pin(${JSON.stringify(pins.cleanup)});
    const updates = request.variables?.refUpdates;
    const ok = armed && Array.isArray(updates) && updates.length === 1 && request.variables.repositoryId === armed.repositoryNodeId && updates[0].name === armed.ref &&
      updates[0].beforeOid === armed.beforeOid && updates[0].afterOid === '0'.repeat(40) && updates[0].force === false && armed.ref.startsWith(${JSON.stringify(`refs/heads/factory/${input.issue}-`)});
    allowed = Boolean(ok) && slot('branch-deletion', 1); kind = allowed ? 'branch-deletion' : 'refused-deletion';
  }
}
appendFileSync(${JSON.stringify(input.trace)}, JSON.stringify({ at: new Date().toISOString(), method, endpoint, allowed, kind }) + '\\n');
if (!allowed) { process.stderr.write('RECIPE_GUARD_REFUSED\\n'); process.exit(97); }
const result = spawnSync(${JSON.stringify(input.gh)}, args, body === undefined ? { stdio: 'inherit', env: process.env } : { input: body, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
process.exit(result.status ?? 1);
`;
}

type OwnerPhase = 'run' | 'resume' | 'ready' | 'deliver';
/**
 * Bounds of the production ports for one phase (observation + refusal only; allowed calls are delegated unchanged). `run`/`resume` allow the
 * journey's activities for the pinned Ticket's Work; `ready`/`deliver` allow no prepare/activation/Builder grant; cleanup only in `deliver`.
 */
export function guardPorts(ports: ExecutionPorts, phase: OwnerPhase, owns: (workId: string) => Promise<boolean>, log: (entry: Record<string, unknown>) => void): ExecutionPorts {
  const count = { prepares: 0, builders: 0, reviewers: 0, builderStart: 0, builderPublish: 0 };
  const agents = phase === 'run' || phase === 'resume';
  const refusal = (code: string) => { log({ call: 'refused', code }); return code; };
  const cleanup = ports.cleanup;
  return { ...ports,
    sandbox: { ...ports.sandbox,
      async prepare(input) {
        log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
        if (!agents || ++count.prepares > bounds.prepares || !await owns(input.workId)) return { status: 'failure', code: refusal('RECIPE_PREPARE_GUARD') };
        const result = await ports.sandbox.prepare(input);
        log({ call: 'prepare-result', result });
        return result;
      },
      async start(input) { const result = await ports.sandbox.start(input); log({ call: 'start', result }); return result; },
      async stop(input) { const result = await ports.sandbox.stop(input); log({ call: 'stop', input, result }); return result; } },
    workers: { ...ports.workers,
      async activate(invocation, delivery, events) {
        const role = invocation.context.role;
        log({ call: 'activate', role, phaseId: invocation.context.phaseId, executionId: invocation.context.executionId, round: invocation.review?.round ?? null,
          credentialDelivered: delivery?.credential !== undefined });
        const over = role === 'builder' ? ++count.builders > bounds.builders : ++count.reviewers > bounds.reviewers;
        if (!agents || over || !await owns(invocation.context.workId)) throw new Error(refusal('RECIPE_ACTIVATION_GUARD'));
        const handle = await ports.workers.activate(invocation, delivery, events);
        void handle.completed.then(done => log({ call: 'completed', role, phaseId: invocation.context.phaseId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
          () => log({ call: 'completion-uncertain', role }));
        return handle;
      } },
    credentials: {
      async issue(context) {
        const purpose = context.purpose ?? 'builder-start';
        const over = purpose === 'builder-publish' ? ++count.builderPublish > bounds.builderPublish : purpose === 'builder-start' ? ++count.builderStart > bounds.builderStart : true;
        log({ call: 'issue', purpose, allowed: agents && !over });
        if (!agents || over) throw Object.assign(new Error(refusal('RECIPE_GRANT_GUARD')), { outcome: 'known-rejected' });
        const grant = await ports.credentials.issue(context);
        log({ call: 'issued', metadata: grant.metadata });
        return grant;
      },
      async revoke(grant) { const result = await ports.credentials.revoke(grant); log({ call: 'revoked', purpose: grant.metadata.purpose, kind: result.kind }); return result; } },
    ...(cleanup ? { cleanup: { ...(cleanup.retrySeconds === undefined ? {} : { retrySeconds: cleanup.retrySeconds }),
      async remove(input) {
        log({ call: 'remove', environment: input.environment });
        if (phase !== 'deliver') return { status: 'failure', code: refusal('RECIPE_CLEANUP_GUARD'), resources: [] };
        const result = await cleanup.remove(input);
        log({ call: 'remove-result', result });
        return result;
      },
      async preserve(input) {
        if (phase !== 'deliver') { refusal('RECIPE_CLEANUP_GUARD'); return { status: 'failure', code: 'RECIPE_CLEANUP_GUARD' } as never; }
        const result = await cleanup.preserve(input);
        log({ call: 'preserve', workId: input.workId, environment: input.environment, result });
        return result;
      } } } : {}) };
}

/**
 * Bounds of the production access. Every method is wrapped EXPLICITLY (a method added later is absent, never passed through unbounded):
 * reads delegate; comments only on the pinned issue in run/resume; draft mutations never in deliver; the one branch deletion only in deliver.
 */
export function guardAccess(access: AccessDependencies, phase: OwnerPhase, issue: number, log: (entry: Record<string, unknown>) => void): AccessDependencies {
  let comments = 0, drafts = 0, deletions = 0;
  const tracker = access.tracker, repo = access.repository;
  const guardedTracker: IssueTracker = { checkAccess: scope => tracker.checkAccess(scope), listCandidates: scope => tracker.listCandidates(scope), readTicket: ref => tracker.readTicket(ref),
    readDependencyGraph: ref => tracker.readDependencyGraph(ref), readInputs: (ref, cursor) => tracker.readInputs(ref, cursor), findQuestion: (ref, id) => tracker.findQuestion(ref, id),
    async postComment(ref, comment, effect) {
      log({ call: 'post-comment', issue: ref.number, questionId: comment.questionId, effectId: effect.effectId });
      if ((phase !== 'run' && phase !== 'resume') || ref.number !== issue || ref.repositoryId !== repositoryId || ++comments > bounds.comments) {
        return { kind: 'failed', observedAt: new Date().toISOString(), code: 'RECIPE_COMMENT_GUARD', nextStep: 'Refused locally; nothing was sent.' };
      }
      const result = await tracker.postComment(ref, comment, effect);
      log({ call: 'post-comment-result', result });
      return result;
    } };
  const readOwnMerge = repo.readOwnMerge, cleanupBranch = repo.cleanupBranch;
  const guardedRepository: CodeRepository = { checkAccess: (scope, base) => repo.checkAccess(scope, base), findPublication: correlation => repo.findPublication(correlation),
    readPullRequest: query => repo.readPullRequest(query),
    async setDraft(pr, draft, effect) {
      log({ call: 'set-draft', number: pr.number, draft, effectId: effect.effectId });
      if (phase === 'deliver' || ++drafts > bounds.setDraft) {
        return { kind: 'known-failure', observedAt: new Date().toISOString(), code: 'RECIPE_DRAFT_GUARD', nextStep: 'Refused locally; nothing was sent.', revocation: 'not-issued' };
      }
      const result = await repo.setDraft(pr, draft, effect);
      log({ call: 'set-draft-result', result });
      return result;
    },
    ...(readOwnMerge ? { readOwnMerge: (pr: Parameters<typeof readOwnMerge>[0]) => readOwnMerge(pr) } : {}),
    ...(cleanupBranch ? { async cleanupBranch(selection: Parameters<typeof cleanupBranch>[0], effect: Parameters<typeof cleanupBranch>[1]) {
      log({ call: 'cleanup-branch', branch: selection.branch, expectedTip: selection.expectedTip });
      if (phase !== 'deliver' || !selection.branch.startsWith(`factory/${issue}-`) || ++deletions > bounds.cleanupBranch) {
        return { outcome: 'failed' as const, code: 'RECIPE_CLEANUP_BRANCH_GUARD', observedAt: new Date().toISOString(), tip: null, revocation: 'not-issued' as const,
          nextStep: 'Refused locally; nothing was sent.', effectId: effect.effectId };
      }
      const result = await cleanupBranch(selection, effect);
      log({ call: 'cleanup-branch-result', result });
      return result;
    } } : {}) };
  return { repositories: access.repositories, ...(access.dependencyRepositories ? { dependencyRepositories: access.dependencyRepositories } : {}),
    ...(access.operators ? { operators: access.operators } : {}), ...(access.factoryApp ? { factoryApp: access.factoryApp } : {}),
    tracker: guardedTracker, repository: guardedRepository };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>, () => null);
  const pin = async (name: string, data: unknown) => { await fs.writeFile(`${observations}/${name}`, JSON.stringify(data), { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error; }); };
  return { fs, save, exists, load, pin };
}

export const keySource = `${root}/${githubApp.privateKeyFile}`;
/** Fails loudly, with the path and what to do, when the App key the phase copies is missing (nothing has been created yet). */
export async function requireKeySource(access: (path: string) => Promise<unknown>) {
  await access(keySource).catch(() => {
    throw new Error(`APP_KEY_SOURCE_MISSING: ${keySource} is absent; restore the App private key there before preflight (nothing was created, no intent, no GitHub call).`);
  });
}

async function guardedGh(issue: number) {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { draftMutations } = await import('../../src/platform/github/index.js');
  const target = `${observations}/gh-guard.mjs`;
  if (!(await fs.access(target).then(() => true, () => false))) {
    let found: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (await fs.access(`${directory}/gh`, constants.X_OK).then(() => true, () => false)) { found = `${directory}/gh`; break; }
    }
    if (!found) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(target, journeyGuardScript({ node: process.execPath, gh: found, trace: gh.trace, directory: observations, repository: repository.repository,
      installationId: repository.installationId, issue, documents: [draftMutations.markPullRequestReadyForReview, draftMutations.convertPullRequestToDraft],
      maxComments: gh.maxComments, maxDraftMutations: gh.maxDraftMutations }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}

/** The production composition, configured from this namespace's config.yaml (validated by the production reader). */
async function compose(issue: number) {
  const { readConfiguration } = await import('../../src/entrypoints/configuration.js');
  const { composeProductionAccess, composeProductionExecution } = await import('../../src/entrypoints/controller/composition.js');
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const validated = await readConfiguration(observations, guestAssets);
  if (!validated.configuration.valid) throw new Error('CONFIGURATION_INVALID');
  const effective = validated.configuration.effective;
  const github = createGitHubAccess({ root: observations, ...effective.githubApp, executable: await guardedGh(issue) });
  const composed = await composeProductionExecution({ root, effective, guestAssets, github });
  if (composed.status !== 'composed') throw new Error(`COMPOSITION_REFUSED:${composed.roles.join(',')}`);
  return { effective, github, composed, access: composeProductionAccess({ github, effective }) };
}

const traceOf = async () => {
  const fs = await import('node:fs/promises');
  return (await fs.readFile(gh.trace, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string | null; endpoint: string; allowed: boolean; kind: string });
};
const summarize = (trace: Awaited<ReturnType<typeof traceOf>>) => ({ requests: trace.length, refused: trace.filter(item => !item.allowed).map(item => [item.method, item.endpoint, item.kind]),
  writes: trace.filter(item => item.kind !== 'read').map(item => [item.method, item.endpoint, item.kind, item.allowed]) });
const workOf = (list: unknown, issue: number) => ((list as ListView).works ?? []).find(item => item.ticket.number === issue && item.ticket.repositoryId === repositoryId);

/** A read-only view of the recipe storage through a fresh COPY (the original is never opened outside an owner phase). */
async function viewCopy(label: string, issue: number) {
  const fs = await import('node:fs/promises');
  if (!await fs.access(`${observations}/control.sqlite`).then(() => true, () => false)) return null;
  const { openControl } = await import('../../src/control/index.js');
  const { snapshotStorage } = await import('./review12-qualification.js');
  const copy = await snapshotStorage(observations, `${observations}/${label}-storage-copy`);
  const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
  try {
    const list = await stored.inspect({ kind: 'list' }) as ListView;
    const status = await stored.inspect({ kind: 'status' });
    const work = workOf(list, issue);
    const shown = work ? await stored.inspect({ kind: 'show', work_id: work.work_id }) as Extract<ShowView, { kind: 'work' }> : null;
    return { list, status, work, shown };
  } finally { const halt = new AbortController(); halt.abort(); await stored.run(halt.signal); }
}

/** One owner run of the production composition on the recipe storage, bounded by the phase guards, until `settled` or the deadline. */
async function runOwner(phase: OwnerPhase, issue: number, settled: (work: WorkView | undefined, questions: QuestionView[]) => string | null) {
  const { openControl } = await import('../../src/control/index.js');
  const { inventoryRuntime } = await import('../../src/sandbox/index.js');
  const { pin } = await io();
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => { events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry }); };
  const { composed, access, effective } = await compose(issue);
  const holder: { control?: Awaited<ReturnType<typeof openControl>> } = {};
  const owns = async (workId: string) => {
    const shown = await holder.control!.inspect({ kind: 'show', work_id: workId });
    return 'work' in shown && shown.work.ticket.number === issue && shown.work.ticket.repositoryId === repositoryId;
  };
  // Works of THIS storage (a fresh storage has none): only their environments are this owner's runtime resources.
  const before = await viewCopy(`${phase}-inventory`, issue);
  const known = new Set((before?.list.works ?? []).map(item => item.work_id));
  const listed = await inventoryRuntime(root);
  const { inventory, excluded, holds } = ownInventory(listed, known);
  if (holds.length) { log({ call: 'inventory-held', holds }); throw new Error(`INVENTORY_HELD:${holds.join(',').slice(0, 96)}`); }
  const control = holder.control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: inventory, execution: guardPorts(composed.ports, phase, owns, log),
    access: guardAccess(access, phase, issue, log), polling: { intervalSeconds: effective.pollingSeconds } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const deadline = Date.now() + deadlines[phase] * 60 * 1000;
  let outcome: string | null = null, final: unknown, questions: QuestionView[] = [];
  let status: unknown = null, shown: unknown = null, ended: Awaited<typeof running> | null = null;
  try {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const list = await control.inspect({ kind: 'list' });
      const work = workOf(list, issue);
      questions = work ? (await control.inspect({ kind: 'show', work_id: work.work_id }) as Extract<ShowView, { kind: 'work' }>).questions : [];
      // The gh guard allows draft mutations only on the own PR node Control itself linked (pinned once, from Control's record).
      const own = work?.publication?.pullRequest;
      if (own) await pin(pins.ownPullRequest, { number: own.number, nodeId: own.nodeId, headSha: own.headSha, pinnedAt: new Date().toISOString() });
      outcome = settled(work, questions);
      if (outcome) { final = list; break; }
    }
  } finally {
    final ??= await control.inspect({ kind: 'list' }).catch(() => null);
    status = await control.inspect({ kind: 'status' }).catch(() => null);
    const work = workOf(final, issue);
    shown = work ? await control.inspect({ kind: 'show', work_id: work.work_id }).catch(() => null) : null;
    stop.abort();
    ended = await running;
  }
  return { outcome: outcome ?? 'deadline', ended, final, shown, questions, controlStatus: status, inventory: { listed, excluded, own: inventory.environments },
    events, gh: summarize(await traceOf()), deadlineReached: Date.now() >= deadline };
}

/** Raw active rules of main (GET only) and whether `update` (Restrict updates) makes a merge need a bypass. */
async function mainRules(issue: number) {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh(issue) });
  const read = await github.read(repository, 'checks-read', session => session.list(`/repos/${repository.repository}/rules/branches/${repository.base}`, { maxPages: 10 }));
  const rules = read.ok && Array.isArray(read.value) ? (read.value as { type?: unknown; ruleset_id?: unknown }[]).map(rule => ({ type: String(rule.type), ruleset: Number(rule.ruleset_id) })) : null;
  return { ok: read.ok, rules, restrictUpdates: rules ? rules.some(rule => rule.type === 'update') : null };
}

/** The App key copy lives only for one phase: taken at its start, removed at its end (also on failure). */
async function withKey<T>(work: () => Promise<T>): Promise<T> {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const target = `${observations}/${githubApp.privateKeyFile}`;
  await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await fs.mkdir(`${observations}/run`, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await fs.copyFile(keySource, target, constants.COPYFILE_EXCL);
  try { await fs.chmod(target, 0o600); return await work(); } finally { await fs.rm(target, { force: true }); }
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const issue = ticket.number;
  if (issue === null) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  // Before ANY effect (no directory, intent or GitHub call): the App key every phase copies must exist.
  await requireKeySource(path => fs.access(path));
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  const results = { preflight: await load('preflight-result'), run: await load('run-result'), resume: await load('resume-result'), ready: await load('ready-result'),
    deliver: await load('deliver-result') };
  const refused = phaseGuard(phase, results, new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null)))
    .filter((item): item is string => item !== null)));
  if (refused) throw new Error(refused);
  // `ready` re-reads the rules BEFORE its intent: while `update` is active nothing is consumed (the operator decides first).
  if (phase === 'ready') {
    const rules = await withKey(() => mainRules(issue));
    if (rules.restrictUpdates !== false) throw new Error(rules.restrictUpdates ? 'MERGE_RULE_STILL_ACTIVE' : 'RULES_UNREADABLE');
  }
  await save(`${phase}-intent`, { revision, phase, issue, at: new Date().toISOString() });
  const { holdStorageLock } = await import('./question10-qualification.js');
  try {
    await withKey(async () => {
      if (phase === 'preflight') { await preflight(issue, save); return; }
      if (phase === 'inspect' || phase === 'stop-environment') { await inspectOrStop(phase, issue, save); return; }
      const lock = await holdStorageLock(`${observations}/control.lock`);
      try { await ownerPhase(phase, issue, results, save); } finally { await lock.release(); }
    });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

async function ownerPhase(phase: OwnerPhase, issue: number, results: Record<string, Record<string, unknown> | null>, save: (name: string, data: unknown) => Promise<void>) {
  const { fs, pin } = await io();
  const preflight = results.preflight as { restrictUpdates?: boolean; operator?: { id: number } } | null;
  const expectedStop = preflight?.restrictUpdates ? 'merge-blocked' : 'ready';
  if (phase === 'run') {
    const result = await runOwner('run', issue, (work, questions) => { const decided = journeyOutcome('run', work, questions, null); return decided.settled ? decided.outcome : null; });
    const asked = result.questions.find(item => item.state === 'open' && item.publication.state === 'published');
    await save('run-result', { status: 'observed', expected: 'question-published', met: result.outcome === 'question-published',
      questionSubcase: asked ? 'exercised' : 'NOT exercised (the Builder did not ask)', answer: asked ? { questionId: asked.questionId, comment: asked.publication.comment, ...answerCommand(issue, asked.questionId) } : null,
      expectedStop, ...result });
    return;
  }
  if (phase === 'resume') {
    const answered = ((results.run as { answer?: { questionId?: string } } | null)?.answer?.questionId) ?? null;
    if (!answered || !preflight?.operator) throw new Error('RUN_QUESTION_UNKNOWN');
    const started = Date.now();
    let ingestion: string = 'waiting';
    const result = await runOwner('resume', issue, (work, questions) => {
      ingestion = answerIngested(questions, answered, preflight.operator!.id);
      if (ingestion === 'not-the-real-comment') return 'answer-not-the-real-comment';
      if (ingestion === 'waiting') return Date.now() - started > answerWaitMinutes * 60 * 1000 ? 'answer-not-observed' : null;
      const decided = journeyOutcome('resume', work, questions, answered);
      return decided.settled ? decided.outcome : null;
    });
    await save('resume-result', { status: 'observed', expected: expectedStop, met: result.outcome === expectedStop, answerIngestion: ingestion,
      answer: result.questions.find(item => item.questionId === answered)?.answer ?? null, ...result });
    return;
  }
  if (phase === 'ready') {
    const result = await runOwner('ready', issue, work => work?.readiness?.effects.some(item => item.action === 'mark-ready' && item.state === 'confirmed') ? 'ready' : null);
    await save('ready-result', { status: 'observed', ...result });
    return;
  }
  // deliver: the human merge is confirmed by GitHub BEFORE any effect (the own PR the storage linked; merged_by recorded).
  const stored = await viewCopy('deliver-precondition', issue);
  const own = stored?.work?.publication?.pullRequest ?? null;
  const { access, github } = await compose(issue);
  const facts = own && access.repository.readOwnMerge ? await access.repository.readOwnMerge({ repo: repository, repositoryId, number: own.number, pullRequestId: own.pullRequestId, nodeId: own.nodeId }) : null;
  const raw = own ? await github.read(repository, 'delivery-read', session => session.get(`/repos/${repository.repository}/pulls/${own.number}`)) : null;
  const mergedBy = raw?.ok && raw.value && typeof raw.value === 'object' && (raw.value as { merged_by?: { login?: unknown; type?: unknown; id?: unknown } | null }).merged_by
    ? (raw.value as { merged_by: { login: string; type: string; id: number } }).merged_by : null;
  const observed = facts?.kind === 'observed' ? facts.pullRequest : null;
  const held = deliverPrecondition(own ? { number: own.number, headSha: own.headSha } : null, observed, mergedBy ? { login: String(mergedBy.login), type: String(mergedBy.type) } : null);
  const repositoryPin = JSON.parse(await fs.readFile(`${observations}/${pins.repository}`, 'utf8')) as { nodeId: string };
  await save('deliver-precondition', { own, facts, mergedBy: mergedBy ? { login: mergedBy.login, id: mergedBy.id, type: mergedBy.type } : null, held,
    note: 'The Factory-made readiness is recorded in run/resume/ready-result; approval and merge were the operator\'s.' });
  if (held || !own) throw new Error(`DELIVER_PRECONDITION_HELD:${held ?? 'OWN_PULL_REQUEST_NOT_LINKED'}`);
  // The guard allows ONE updateRefs of exactly this ref, repository node and merged linked head, only while this pin exists.
  await pin(pins.cleanup, { repositoryNodeId: repositoryPin.nodeId, ref: `refs/heads/${own.headRef}`, beforeOid: own.headSha });
  try {
    const result = await runOwner('deliver', issue, work => work?.cleanup?.state === 'complete' ? 'cleanup-complete' : null);
    await save('deliver-result', { status: 'observed', ...result });
  } finally { await fs.rm(`${observations}/${pins.cleanup}`, { force: true }); }
}

async function preflight(issue: number, save: (name: string, data: unknown) => Promise<void>) {
  const { fs, pin } = await io();
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { resolveOperator } = await import('./question10-qualification.js');
  const { productionSkillPack } = await import('../../src/entrypoints/controller/composition.js');
  const { inventoryRuntime } = await import('../../src/sandbox/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh(issue) });
  const owner = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}`));
  if (!owner.ok) { await save('preflight-result', { status: 'held', reason: 'REPOSITORY_UNREADABLE', owner }); throw new Error('REPOSITORY_UNREADABLE'); }
  const operator = resolveOperator(owner.value, operatorLogin);
  const nodeId = (owner.value as { node_id?: unknown }).node_id;
  if (typeof nodeId !== 'string' || !/^[A-Za-z0-9_=-]{1,128}$/.test(nodeId)) throw new Error('REPOSITORY_NODE_ID_UNKNOWN');
  await pin(pins.repository, { nodeId, repositoryId });
  const model = { provider: 'openai', model: 'gpt-6-luna' };
  const configuration = { schemaVersion: 1, operators: [operator], models: { builder: model, standards: model, spec: model }, githubApp, sandbox,
    repositories: [{ ...repository, correctionLimit: 3, recoveryLimit: 3 }], dependencyRepositories: [], concurrency: 1, pollingSeconds };
  // JSON is YAML: the production reader parses and validates it like any config.yaml.
  await fs.writeFile(`${observations}/config.yaml`, `${JSON.stringify(configuration, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  const { composed, access } = await compose(issue);
  const listing = await access.tracker.listCandidates(repository);
  const candidate = listing.kind === 'observed' && listing.repositoryId === repositoryId && listing.candidates.length === 1 && listing.candidates[0]!.number === issue ? listing.candidates[0]! : null;
  const read = candidate ? await access.tracker.readTicket(candidate) : null;
  const graph = candidate ? await access.tracker.readDependencyGraph(candidate) : null;
  // The Factory never captures a Ticket body; the recipe checks the synthetic issue's text against the pinned text with one raw GET (hashes recorded).
  const rawIssue = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${issue}`));
  const text = rawIssue.ok && rawIssue.value && typeof rawIssue.value === 'object' ? pinnedText(rawIssue.value as { title?: unknown; body?: unknown }) : { matches: false, titleSha256: null, bodySha256: null };
  const publication = await access.repository.findPublication({ repo: repository, issueNumbers: [issue], knownBranches: [], refs: true, base: repository.base });
  const associated = publication.kind === 'observed' ? publication.issues[String(issue)] : undefined;
  const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
  const factoryBranches = refs ? Object.keys(refs).filter(ref => ref.startsWith(`refs/heads/factory/${issue}-`)) : null;
  const app = await github.appIdentity(repository);
  const rules = await mainRules(issue);
  const listed = await inventoryRuntime(root).catch((error: Error) => ({ error: error.message.slice(0, 128) }));
  const inventoryHolds = 'error' in listed ? ['INVENTORY_UNREADABLE'] : ownInventory(listed, new Set()).holds;
  const reasons = [
    ...(candidate ? [] : ['LABEL_DOES_NOT_LIST_EXACTLY_THE_PINNED_ISSUE']), ...(text.matches ? [] : ['TICKET_TEXT_NOT_PINNED_TEXT']),
    ...(graph && graph.completeness === 'complete' ? [] : ['DEPENDENCIES_INCOMPLETE']),
    ...(associated?.completeness === 'complete' && !associated.candidates.length ? [] : ['ASSOCIATED_PULL_REQUEST_OR_INCOMPLETE']),
    ...(refs && refs[`refs/heads/${repository.base}`] && factoryBranches && !factoryBranches.length ? [] : ['REFS_NOT_AS_EXPECTED']),
    ...(publication.kind === 'observed' && publication.baseProtection?.state === 'pull-request-required' ? [] : ['BASE_NOT_PULL_REQUEST_PROTECTED']),
    ...(app ? [] : ['APP_IDENTITY_UNKNOWN']), ...(rules.ok ? [] : ['RULES_UNREADABLE']), ...inventoryHolds];
  await save('preflight-result', { status: reasons.length ? 'held' : 'success', reasons, operator, repositoryNodeId: nodeId, configuration, skillPack: await productionSkillPack(),
    composition: composed.summary, ticket: read, text, graph: graph ? { completeness: graph.completeness, nodes: graph.nodes.length, problems: graph.problems } : null, refs,
    baseProtection: publication.kind === 'observed' ? publication.baseProtection : null, app, rules, restrictUpdates: rules.restrictUpdates,
    expectedStop: rules.restrictUpdates ? 'readiness MERGE_BLOCKED_UPDATE_RESTRICTED (ticket 39): nothing converted; operator decides' : null, y5Inventory: listed, gh: summarize(await traceOf()) });
  if (reasons.length) throw new Error(reasons.join(',').slice(0, 160));
}

async function inspectOrStop(phase: 'inspect' | 'stop-environment', issue: number, save: (name: string, data: unknown) => Promise<void>) {
  const fs = await import('node:fs/promises');
  const { holdStorageLock } = await import('./question10-qualification.js');
  // Works after ANY earlier phase, held ones included: whatever storage exists is read through a copy taken under the lock.
  const lock = await holdStorageLock(`${observations}/control.lock`);
  let stored: Awaited<ReturnType<typeof viewCopy>>;
  try { stored = await viewCopy(phase, issue); } finally { await lock.release(); }
  const work = stored?.work;
  const environment = work?.execution?.dispatch.environment ?? null;
  if (phase === 'stop-environment') {
    const { needsStop } = await import('./builder09-qualification.js');
    if (!work?.execution || !environment || !needsStop(work.execution)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const box = createSandbox({ root, guestAssets });
    const before = await box.observe({ environment: environment as never, boot: work.execution.dispatch.boot as never });
    const result = before.condition === 'active' ? await box.stop({ environment: environment as never, boot: work.execution.dispatch.boot as never, reason: 'q18 explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before, result });
    return;
  }
  const config = await fs.access(`${observations}/config.yaml`).then(() => true, () => false);
  const remoteState = config ? await (async () => {
    const { access } = await compose(issue);
    const own = work?.publication?.pullRequest ?? null;
    const facts = own && access.repository.readOwnMerge ? await access.repository.readOwnMerge({ repo: repository, repositoryId, number: own.number, pullRequestId: own.pullRequestId, nodeId: own.nodeId }) : null;
    const remote = await access.repository.findPublication({ repo: repository, issueNumbers: [issue], knownBranches: work?.branch ? [work.branch] : [], refs: true, base: repository.base });
    const issueState = work ? await access.tracker.readTicket(work.ticket) : null;
    return { facts, remote, issueState };
  })().catch((error: Error) => ({ error: error.message.slice(0, 160) })) : { error: 'NO_CONFIGURATION (preflight held before writing it)' };
  const preflight = await fs.readFile(`${observations}/preflight-result.json`, 'utf8').then(text => JSON.parse(text) as { refs?: Record<string, string> | null }, () => null);
  const after = 'remote' in remoteState && remoteState.remote.kind === 'observed' && remoteState.remote.refs?.state === 'complete' ? remoteState.remote.refs.refs : null;
  const before = preflight?.refs ?? null;
  const refsDiff = before && after ? { removed: Object.keys(before).filter(ref => !(ref in after)), added: Object.keys(after).filter(ref => !(ref in before)),
    moved: Object.keys(after).filter(ref => ref in before && before[ref] !== after[ref]) } : null;
  const environmentListing = environment ? await fs.readdir(`${root}/environments/${environment}`).catch((error: NodeJS.ErrnoException) => ({ error: error.code ?? 'UNREADABLE' })) : null;
  const evidence = work ? await fs.readdir(`${root}/${work.work_id}/evidence`).catch((error: NodeJS.ErrnoException) => ({ error: error.code ?? 'UNREADABLE' })) : null;
  const storage = Buffer.concat(await Promise.all(['control.sqlite', 'control.sqlite-wal'].map(name => fs.readFile(`${observations}/${name}`).catch(() => Buffer.alloc(0)))));
  const held = Object.fromEntries(await Promise.all(phases.map(async name => [name, await fs.readFile(`${observations}/${name}-held.json`, 'utf8').then(text => JSON.parse(text) as unknown, () => null)])));
  await save('inspect-result', { storage: stored ? 'present' : 'absent', status: stored?.status ?? null, work: work ?? null, shown: stored?.shown ?? null, remote: remoteState, refsDiff, held,
    environment: environment ? { id: environment, listing: environmentListing } : null, evidence,
    secretScan: { ghs: storage.includes(Buffer.from('ghs_')), privateKey: storage.includes(Buffer.from('PRIVATE KEY')) }, gh: summarize(await traceOf()) });
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(['APP_KEY_SOURCE_MISSING', 'TICKET_NOT_PINNED', 'MERGE_RULE_STILL_ACTIVE', 'RULES_UNREADABLE'].some(code => message.startsWith(code)) ? message
      : `Qualification held; no retry. (${message.slice(0, 160)})`);
    process.exit(1);
  });
}
