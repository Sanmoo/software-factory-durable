import type { ExecutionView, QuestionView, WorkView } from '../../src/control/index.js';

// TEST ONLY. Ticket 34 pre-pilot group R-LONG (V-03.c, V-13.e): ONE real activity of more than 60 minutes with NO timeout configured, real
// GitHub App installation tokens (they live 3600 s) renewed by the production policy (600 s before expiry) and ONE command that crosses the
// expiry of the token it started with. Import and `--plan` are inert. Every other phase is a REAL effect that needs an explicit operator
// grant: real GitHub App installation tokens (issuance and self-revocation, read-only grants), one real Gondolin/KVM VM under the user
// systemd manager and one real Builder worker. The model is replaced by the scripted local provider (long34-provider.ts), so no model
// request is made; the long part is REAL work the Factory sees as one tool call: a flakiness census of the repository's own suite.
// Host clock: the recipe NEVER changes the system clock (host-wide: other sessions, TLS validity and the GitHub App JWT `iat`/`exp` would all
// move). It observes it read-only: calendar vs monotonic samples every minute in the orchestrator, `timedatectl` NTP state at start/end,
// and compares the Control's recorded duration (controller monotonic clock) with both. A step adjustment of the host clock stays at S level.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q34-long-v2`;
/**
 * The recipe's OWN Factory root (environments, host Git cache, Records, worker runtime), created by preflight: never the shared y5 root. Outside
 * the namespace because worker sockets under <root>/r/<boot>/s/ must stay within 107 bytes (at most 38 bytes of root). No model store needed.
 */
// v2: a NEW root (l34 holds v1's environment). Three characters keep the worker sockets within 107 bytes ("l34v2" would not).
export const factoryRoot = '/home/sanmoo/software-factory-test/lv2';
export const sharedCache = `${root}/cache`;
// v1 (real run, #118) ended after 16 min: Gradle skipped the suite after run 1 (`:test UP-TO-DATE`) and the 12-run cap ended the census at
// 963 s, before the first token expired; its verdict read FAILED (newCommandGotRenewal) although no renewal was due yet. v2: the census
// re-executes the suite (--rerun-tasks) WHILE less than 75 min elapsed; renewal is judged only once the renewal point was reached; a census
// that ends before the first expiry holds CENSUS_SHORT.
const revision = 'q34-long-v2';
export const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
export type Phase = typeof phases[number];
/** No `timeoutSeconds`: the repository has no timeout (spec: no implicit 60 min cut). recoveryLimit/correctionLimit: production defaults. */
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
/**
 * The NEW synthetic issue the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no other open
 * issue with that label). `number` MUST be pinned in a reviewed commit before preflight: 0 refuses every phase (TICKET_NOT_PINNED).
 */
export const ticket = { number: 0, repositoryId: 1256893534, title: 'Factory qualification: one activity longer than an hour (suite flakiness census)' } as const;
export const ticketBody = [
  'Run a flakiness census of the repository test suite: run the documented suite (README: `./gradlew test`, JDK 25 + Docker) repeatedly for at least 75 minutes ' +
    'and report, per run, the exit code and duration. No code change is requested.',
  '', 'This Ticket is executed by a scripted Software Factory qualification (no model): it exists to prove one real activity longer than an hour with credential renewal.'].join('\n');
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 4096, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const runDeadlineMs = 140 * 60 * 1000;
/** Initial grant + renewals every ~50 min over < 140 min; the recipe refuses more (bounded POSTs). */
const maxIssuances = 5;
const clockSampleMs = 60_000;
const hour = 3_600_000;
/** The production renewal margin (credentialRenewal absent: 600 s before expiresAt; src/control/durable/dispatch.ts). */
const renewalMarginSeconds = 600;

export function plan() {
  return { revision, root, observations, factoryRoot, cacheRoot: `${factoryRoot}/cache/git`, sharedCache, phases, repository, ticket: { ...ticket, body: ticketBody, label: repository.label, pinned: ticket.number > 0, labelAtCreation: false,
      labelledBy: 'the main session, right before preflight (preflight waits, GET only, up to 10 min until the label lists EXACTLY this issue)' }, configuration, guestAssets,
    renewal: { policy: 'production default: renew 600 s before expiresAt (no override)', tokenLifetimeSeconds: 3600, maxIssuances },
    timeout: 'none configured (repository.timeoutSeconds absent)',
    model: 'none: scripted local provider on 127.0.0.1:18734 (openai-completions SSE): c0 fingerprint+read; c1 fingerprint+read, the suite census (README suite with --rerun-tasks, repeated WHILE < 75 min elapsed, safety cap 40 runs; no sleep), fingerprint+read; c2 fingerprint+read; then "Complete."; no OAuth/model request',
    hostClock: { injected: false, reason: 'changing the system clock is host-wide (other sessions, TLS, the App JWT iat/exp); not done', observed: `calendar vs monotonic samples every ${clockSampleMs / 1000} s, timedatectl NTP state at start/end, Control duration vs both` },
    requires: [`${root}/${githubApp.privateKeyFile} present`, 'the supervisor created the NEW issue (title/body above) UNLABELLED and pinned its number in a reviewed commit; the main session labels it right before preflight', 'no other open issue carries the label',
      `a fresh ${factoryRoot} (absent: preflight creates it with the setup layout); no model login (scripted provider)`, 'one VM for about 90-140 min (guest 4096 MiB / 2 vCPU / 40 GiB virtual disk)',
      'the guest egress reaches services.gradle.org and the eclipse-temurin:25-jdk image registry (as in q24 v4)', 'explicit operator authorization for THIS run (one-shot; a consumed namespace is never reused)'],
    github: { app: githubApp, accessRoot: `${observations} (own namespace: credentials/ copy of ${root}/${githubApp.privateKeyFile}, run/); never y5/run`,
      controllerPurposes: ['tracker-read', 'association-read', 'dependency-read', 'repository-read', 'repository-fetch {metadata:read, contents:read}'],
      builderPurpose: 'builder-start {metadata:read, contents:read, issues:read} for Sanmoo/java-springboot-event-sourcing only (initial + each renewal)',
      writes: 'POST access_tokens (issuance) and DELETE /installation/token (self-revocation; one post-check DELETE per Builder grant expecting 401); nothing else: no comment, label, branch, push or PR (builder-publish refused)',
      mainSession: ['label the pinned issue right before preflight', 'teardown after inspect: see teardown'] },
    teardown: teardownSteps(ticket.number),
    lessons: ['label listing EXACT before preflight', 'every page of the in-process list walked', 'Questions read by id; any Question holds UNSCRIPTED_QUESTION with its text saved',
      'every held phase names its reason (run-result.holdReason, preflight-held.reasons)', 'SIGTERM/SIGINT remove the namespace key copy', 'inspect requests the teardown FIRST (teardown-request.json)',
      'no stall watch: the census is ONE tool call of >= 75 min with no observable change in between'],
    effects: [
      `preflight: key source check BEFORE any effect; exclusive namespace; read-only GitHub: the label lists exactly the pinned issue, no associated PR; creates the NEW own Factory root ${factoryRoot} (exclusive, setup layout); the shared ${sharedCache} is never touched`,
      `run: new Control storage; ONE Execution: host fetch, clone, Sandbox.prepare/start (1 new VM), Builder grant, Workers.activate (scripted provider), renewals delivered over the host channel, end, withdrawal + self-revocation, Sandbox.stop, Slot release; post-check revocation; clock samples; ${runDeadlineMs / 60000} min deadline`,
      'inspect: FIRST teardown-request.json (local data only), then read-only on a private storage COPY; verdict; secret-shape scan (counts only) of storage/observations/records/session; the namespace key copy removed first',
      'stop-environment: own boot of the recorded Execution if it may still run and is observed active: public Sandbox.stop of that exact boot'],
    guards: ['one-shot intent tombstones, phase order', `at most ${maxIssuances} Builder issuances`, 'prepare/activate allowed once and only for the Work of the pinned issue', 'no retry', 'no remove/cleanup',
      'no push/PR (read-only grants)', 'only sha256 12-hex fingerprints of grants are recorded, never values'],
    expected: [
      'execution ended completed after >= 3600 s of measured monotonic duration; timing.timeoutSeconds null and no timeout record',
      'grant 1 expiresAt falls inside the activity; a renewal issued BEFORE it and delivered; c1a = c1b = fp(grant 1); the c1b read fails HTTP-401 (expiry during the command); c2 sees a renewed, delivered grant and its read works',
      'every grant revoked at the end and rejected afterwards (already-invalid)',
      'recorded duration within 60 s of the orchestrator monotonic measure; clock drift and NTP state reported (no injection)',
      'run: held CENSUS_SHORT when the census call ended before the first grant expiresAt (nothing about expiry/renewal proven)',
      'verdict: passed only if every check holds; inconclusive when the census ended before the first token expired, the renewal point (expiresAt - 600 s) was not reached or the deadline was reached; failed on a timeout cut, a lost renewal or a token left valid'],
  };
}

export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>, pinned = ticket.number > 0): string | null {
  if (!pinned) return 'TICKET_NOT_PINNED';
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase !== 'preflight' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if (phase === 'inspect' && !results.run) return 'RUN_RESULT_REQUIRED';
  return null;
}

export type ClockSample = { wall: number; mono: number };
/** Pure: calendar minus monotonic drift between consecutive samples; a jump over 1 s is a step of the host clock (observed, never injected). */
export function clockDrift(samples: ClockSample[]) {
  let maxDriftMs = 0, steps = 0;
  for (let index = 1; index < samples.length; index++) {
    const drift = (samples[index]!.wall - samples[index - 1]!.wall) - (samples[index]!.mono - samples[index - 1]!.mono);
    maxDriftMs = Math.max(maxDriftMs, Math.abs(drift));
    if (Math.abs(drift) > 1000) steps++;
  }
  const total = samples.length > 1 ? (samples.at(-1)!.wall - samples[0]!.wall) - (samples.at(-1)!.mono - samples[0]!.mono) : 0;
  return { samples: samples.length, maxDriftMs: Math.round(maxDriftMs), totalDriftMs: Math.round(total), steps };
}

type Marker = (label: string) => string | undefined;
export type LongInput = {
  execution: Pick<ExecutionView, 'end' | 'timing' | 'credentialIssuance' | 'credentialRenewals'> | undefined;
  /** Fingerprints (12 hex) of every issued grant in order, of every grant DELIVERED (initial first, then renewals), with the renewal delivery instants. */
  issued: string[]; delivered: string[]; deliveredAt: string[]; markers: string[][];
  /** c1: when the census call was handed out and when its result came back. */
  c1: { start: string; end: string } | undefined;
  revocations: string[]; postCheck: string[];
  /** Orchestrator monotonic measure from the first `started` observation to the first `ended` observation (null when either is missing). */
  observedMonotonicMs: number | null; deadlineReached: boolean;
};
export type Assessment = { status: 'passed' | 'failed' | 'inconclusive'; checks: Record<string, boolean>; inconclusive: string[]; failures: string[] };
export function assess(input: LongInput): Assessment {
  const marker: Marker = label => input.markers.flat().find(item => item.startsWith(`${label}:`))?.slice(label.length + 1);
  const execution = input.execution;
  const duration = execution?.timing?.duration;
  const elapsedMs = duration?.kind === 'measured' ? duration.elapsedMs : null;
  const firstExpiry = execution?.credentialIssuance?.metadata?.expiresAt ?? null;
  const endedAt = duration?.kind === 'measured' ? duration.endedAt : null;
  const renewedBeforeExpiry = firstExpiry !== null && (execution?.credentialRenewals ?? []).some(item => item.outcome === 'issued' && item.delivery === 'delivered' &&
    item.metadata !== null && item.metadata.issuedAt < firstExpiry);
  const c1Crossed = input.c1 !== undefined && firstExpiry !== null && input.c1.start < firstExpiry && input.c1.end > firstExpiry;
  // The production policy renews 600 s before expiresAt: before that instant no renewal is due, so its absence proves nothing.
  const renewalPoint = firstExpiry !== null ? new Date(Date.parse(firstExpiry) - renewalMarginSeconds * 1000).toISOString() : null;
  const renewalPointReached = renewalPoint !== null && endedAt !== null && endedAt > renewalPoint;
  const checks = {
    completedWithoutTimeout: execution?.end?.outcome === 'completed' && execution.timing?.timeoutSeconds === null && execution.timing.timeout === null,
    activityOverOneHour: elapsedMs !== null && elapsedMs >= hour,
    initialGrantExpiredDuringActivity: firstExpiry !== null && endedAt !== null && firstExpiry < endedAt,
    renewedBeforeExpiry,
    runningCommandKeptItsValue: marker('c1a') !== undefined && marker('c1a') === marker('c1b') && marker('c1a') === input.issued[0],
    expiryObservedDuringCommand: c1Crossed && marker('gh-c1a')?.startsWith('ok:') === true && marker('gh-c1b') === 'fail:HTTP-401',
    renewalDeliveredWhileC1Ran: input.c1 !== undefined && input.deliveredAt.some(at => at > input.c1!.start && at < input.c1!.end),
    newCommandGotRenewal: marker('c2') !== undefined && marker('c2') !== input.issued[0] && input.delivered.includes(marker('c2')!) && marker('gh-c2')?.startsWith('ok:') === true,
    everyGrantRevoked: input.revocations.length === input.issued.length && input.issued.length > 0 && input.revocations.every(kind => kind === 'revoked'),
    githubRejectsEveryGrantAfterwards: input.postCheck.length === input.issued.length && input.postCheck.every(kind => kind === 'already-invalid'),
    durationMonotonic: elapsedMs !== null && input.observedMonotonicMs !== null && Math.abs(elapsedMs - input.observedMonotonicMs) <= 60_000,
  };
  const failures = (['completedWithoutTimeout', 'renewedBeforeExpiry', 'runningCommandKeptItsValue', 'newCommandGotRenewal', 'everyGrantRevoked', 'githubRejectsEveryGrantAfterwards'] as const)
    .filter(key => !checks[key] && !(input.deadlineReached && key === 'completedWithoutTimeout') &&
      !((key === 'renewedBeforeExpiry' || key === 'newCommandGotRenewal') && !renewalPointReached));
  if (execution?.end?.code === 'EXECUTION_TIMEOUT' || execution?.timing?.timeout) failures.push('completedWithoutTimeout');
  const inconclusive = [...(input.deadlineReached ? ['DEADLINE_REACHED'] : []), ...(!c1Crossed ? ['CENSUS_DID_NOT_CROSS_THE_FIRST_EXPIRY'] : []),
    ...(elapsedMs !== null && elapsedMs < hour ? ['ACTIVITY_SHORTER_THAN_ONE_HOUR'] : []), ...(!renewalPointReached ? ['RENEWAL_POINT_NOT_REACHED'] : [])];
  const unique = [...new Set(failures)];
  const status = unique.length ? 'failed' : inconclusive.length ? 'inconclusive' : Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  return { status, checks, inconclusive, failures: unique };
}

/** Lesson (R-GH-CHECKS v3 race): GitHub may list nothing (or a partial set) right after labelling; preflight waits for EXACTLY the pins. */
export function labelExact(listed: readonly number[], expected: readonly number[]): boolean {
  return JSON.stringify([...listed].sort((a, b) => a - b)) === JSON.stringify([...expected].sort((a, b) => a - b));
}
/** Lesson (R-CAND v4): every page of `list` is walked (the page is fitted); a failed or non-advancing page is INCOMPLETE, never a partial list. */
export async function walkWorks(read: (cursor: number) => Promise<unknown>, maxPages = 100): Promise<{ works: WorkView[]; complete: boolean }> {
  const works: WorkView[] = [];
  let cursor = 0;
  for (let pages = 0; pages < maxPages; pages++) {
    const view = await read(cursor) as { kind?: string; works?: WorkView[]; page?: { nextCursor?: number | null } } | null;
    if (view?.kind !== 'list' || !Array.isArray(view.works)) return { works, complete: false };
    works.push(...view.works);
    const next = view.page?.nextCursor ?? null;
    if (next === null) return { works, complete: true };
    if (typeof next !== 'number' || next <= cursor) return { works, complete: false };
    cursor = next;
  }
  return { works, complete: false };
}
/** No GitHub write: the recipe never lets a publication activation get a token (there are no reviews, so none is expected anyway). */
export const grantAllowed = (purpose: string | undefined) => purpose === undefined || purpose === 'builder-start';
type OutcomeExecution = { state?: string; end?: { outcome?: string; code?: string | null } | null; held?: { code?: string } | null; dispatch?: { phase?: string } } | undefined;
/**
 * Lesson (every held phase names its reason): the run phase is `success` only when the ONE Execution ended completed and stopped; the scripted
 * schedule never asks, so ANY Question holds (its text is saved, read by id). Otherwise the reason is named.
 */
/** CENSUS_SHORT (pure): whether the census call ended after the first grant's expiry (null when either fact is unknown). */
export function censusCrossedExpiry(c1: { start: string; end: string } | undefined, firstExpiresAt: string | null): boolean | null {
  if (!c1 || !firstExpiresAt || Number.isNaN(Date.parse(c1.end)) || Number.isNaN(Date.parse(firstExpiresAt))) return null;
  return Date.parse(c1.end) > Date.parse(firstExpiresAt);
}
export function runOutcome(input: { execution: OutcomeExecution; questions: readonly ({ questionId: string } & Record<string, unknown>)[]; deadlineReached: boolean; listComplete: boolean;
  /** Absent: not judged; false: the census ended before the first grant expired (nothing about expiry or renewal can be proven). */ censusCrossed?: boolean | null }):
    { status: 'success' | 'held'; holdReason: string | null } {
  const held = (holdReason: string) => ({ status: 'held' as const, holdReason });
  if (input.questions.length) return held(`UNSCRIPTED_QUESTION:${input.questions[0]!.questionId}`);
  if (!input.listComplete) return held('LIST_INCOMPLETE');
  const execution = input.execution;
  if (execution?.state === 'held') return held(`EXECUTION_HELD:${execution.held?.code ?? 'UNKNOWN'}`);
  if (execution?.state === 'ended' && execution.end?.outcome !== 'completed') return held(`EXECUTION_ENDED:${execution.end?.outcome ?? 'unknown'}:${execution.end?.code ?? ''}`);
  if (execution?.state === 'ended' && execution.dispatch?.phase === 'stopped') return input.censusCrossed === false || input.censusCrossed === null ? held('CENSUS_SHORT') : { status: 'success', holdReason: null };
  if (execution?.state === 'released') return held('EXECUTION_RELEASED_BEFORE_START');
  return held(input.deadlineReached ? 'DEADLINE_REACHED' : `EXECUTION_NOT_SETTLED:${execution?.state ?? 'none'}`);
}
/** Lesson (R-GH-CHECKS v4): the teardown the main session performs, requested by inspect FIRST from local data only. */
export function teardownSteps(number: number): string[] {
  return [`remove the label ${repository.label} from #${number} (main session; no other issue is touched)`, `close #${number} as completed with no comment by the Factory`,
    'run `stop-environment` only if inspect or stop-environment-result says the own boot may still run', `remove ${factoryRoot} after the evidence is kept (its environment and cache are this recipe's only)`];
}

export const keySource = `${root}/${githubApp.privateKeyFile}`;
async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
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
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
const ownWork = (works: readonly WorkView[]) => works.find(item => item.ticket.number === ticket.number && item.ticket.repositoryId === ticket.repositoryId);
/** The recipe's Work over EVERY page of the in-process list (never only the first page). */
async function findWork(control: { inspect(query: never): Promise<unknown> }) {
  const walked = await walkWorks(cursor => control.inspect({ kind: 'list', cursor } as never));
  return { work: ownWork(walked.works), complete: walked.complete };
}
/** Every Question of the Work, read BY ID (`show`/list may omit them), with its text. */
async function questionsOf(control: { inspect(query: never): Promise<unknown> }, work: WorkView | undefined): Promise<QuestionView[]> {
  const found: QuestionView[] = [];
  for (const id of (work?.questions ?? []).slice(0, 16)) {
    const view = await control.inspect({ kind: 'question', question_id: id } as never) as { kind?: string; question?: QuestionView };
    if (view.kind === 'question' && view.question) found.push(view.question);
  }
  return found;
}
async function ntpState() {
  const { execFile } = await import('node:child_process');
  return new Promise<string | null>(resolve => execFile('/usr/bin/timedatectl', ['show', '--property=NTP', '--property=NTPSynchronized', '--property=Timezone'],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: 65536, shell: false, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim().slice(0, 512))));
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (ticket.number <= 0) throw new Error('TICKET_NOT_PINNED');
  const { fs, save, exists, load } = await io();
  // inspect requests the teardown FIRST, from local data only (no storage, no GitHub): a held or killed run never leaves it unrequested.
  if (phase === 'inspect' && !(await exists('teardown-request'))) {
    await save('teardown-request', { at: new Date().toISOString(), by: 'main session', steps: teardownSteps(ticket.number) }).catch(() => {});
  }
  if (phase === 'preflight') {
    const { requireKeySource } = await import('./crashfx27-qualification.js');
    await requireKeySource(path => fs.access(path)); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    await fs.mkdir(factoryRoot, { mode: 0o700 }); // EXCLUSIVE: the own Factory root is new (never y5, never an earlier one)
    const { setup } = await import('../../src/entrypoints/setup.js');
    await setup(factoryRoot);
    const { constants } = await import('node:fs');
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 });
    await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { tracker, codeRepository } = await compose();
      // The main session labels the issue right before preflight: wait (bounded, GET only) until the listing is EXACTLY the pinned issue.
      let listing = await tracker.listCandidates(repository);
      for (const until = Date.now() + 10 * 60 * 1000; Date.now() < until; listing = await tracker.listCandidates(repository)) {
        if (listing.kind === 'observed' && labelExact(listing.candidates.map(item => item.number), [ticket.number])) break;
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
      if (listing.kind !== 'observed' || !labelExact(listing.candidates.map(item => item.number), [ticket.number]) || listing.repositoryId !== ticket.repositoryId) {
        await save('preflight-held', { status: 'held', reasons: ['LABEL_LISTING_NOT_EXACT'], listing }); throw new Error('PRECONDITION_HELD:LABEL_LISTING_NOT_EXACT');
      }
      const issue = await (await compose()).github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${ticket.number}`));
      const value = issue.ok ? issue.value as { state?: string; title?: string; body?: string | null } : null;
      if (!value || value.state !== 'open' || value.title !== ticket.title || (value.body ?? '').replaceAll('\r\n', '\n').trim() !== ticketBody.trim()) {
        await save('preflight-held', { status: 'held', reasons: ['ISSUE_NOT_AS_PINNED'], issue: value ? { state: value.state, title: value.title } : issue }); throw new Error('PRECONDITION_HELD:ISSUE_NOT_AS_PINNED');
      }
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: [ticket.number], knownBranches: [] });
      const associated = publication.kind === 'observed' ? publication.issues[String(ticket.number)] : undefined;
      const { createSandbox, inventoryRuntime } = await import('../../src/sandbox/index.js');
      const listed = await inventoryRuntime(factoryRoot);
      const sandbox = createSandbox({ root: factoryRoot, guestAssets });
      const observed = [];
      for (const item of listed.environments) {
        const { storage: _storage, ...lifecycle } = await sandbox.observe({ environment: item.environment as never });
        observed.push({ environment: item.environment, condition: lifecycle.condition, cessationConfirmed: lifecycle.cessationConfirmed });
      }
      if (associated?.completeness !== 'complete' || associated.candidates.length || listed.unknown.length || !observed.every(item => item.cessationConfirmed || item.condition === 'removed')) {
        const reasons = [...(associated?.completeness !== 'complete' ? ['PUBLICATION_UNKNOWN'] : associated.candidates.length ? ['ASSOCIATED_PULL_REQUEST'] : []),
          ...(listed.unknown.length ? ['UNKNOWN_RUNTIME_RESOURCE'] : []), ...(!observed.every(item => item.cessationConfirmed || item.condition === 'removed') ? ['ENVIRONMENT_NOT_CEASED'] : [])];
        await save('preflight-held', { status: 'held', reasons, publication, observed, unknown: listed.unknown }); throw new Error(`PRECONDITION_HELD:${reasons.join(',')}`);
      }
      await save('preflight-result', { status: 'success', ticket: listing.candidates[0], preexisting: listed.environments.map(item => item.environment), observed, ntp: await ntpState() });
      return;
    }
    if (phase === 'run') {
      const { createHash } = await import('node:crypto');
      const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
      const { createSandbox, inventoryRuntime } = await import('../../src/sandbox/index.js');
      const { createWorkers } = await import('../../src/workers/index.js');
      const { openControl } = await import('../../src/control/index.js');
      const { ownInventory } = await import('./recovery26-qualification.js');
      const provider = await import('./long34-provider.js');
      const preexisting = (results.preflight as { preexisting?: string[] }).preexisting ?? [];
      const sandbox = createSandbox({ root: factoryRoot, guestAssets, repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }) });
      const workers = createWorkers({ root: factoryRoot, knownSecrets: [], profile: { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
        systemPrompt: 'Ticket 34 R-LONG qualification. Follow the scripted tool schedule.', providerId: 'q34l-qualification-fixture', modelId: 'q34l-model', apiKey: provider.apiKey,
        provider: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.port}/q34l-v1`, models: [{ id: 'q34l-model', name: 'Q34L', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
      const real = createBuilderCredentials({ github, repositories: [repository] });
      const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);
      // Grants stay in this process's memory only (post-check); only fingerprints/metadata are recorded.
      const grants: Parameters<typeof real.revoke>[0][] = [];
      const events: Record<string, unknown>[] = [];
      const log = (event: Record<string, unknown>) => events.push({ at: new Date().toISOString(), mono: Math.round(performance.now()), ...event });
      const credentials: typeof real = {
        async issue(context) {
          if (grants.length >= maxIssuances) throw Object.assign(new Error('RECIPE_ISSUANCE_LIMIT'), { outcome: 'known-rejected' });
          if (!grantAllowed(context.purpose)) throw Object.assign(new Error('RECIPE_NO_PUBLICATION'), { outcome: 'known-rejected' });
          log({ call: 'issue', purpose: context.purpose ?? 'builder-start' });
          const grant = await real.issue(context);
          grants.push(grant);
          log({ call: 'issued', sequence: grants.length, fingerprint: fingerprint(grant.delivery.token), metadata: grant.metadata });
          return grant;
        },
        async revoke(grant) { const result = await real.revoke(grant); log({ call: 'revoke', fingerprint: fingerprint(grant.delivery.token), result }); return result; },
      };
      let prepared = 0, activated = 0;
      let control!: Awaited<ReturnType<typeof openControl>>;
      const allowed = async (workId: string) => (await findWork(control as never)).work?.work_id === workId;
      const samples: { wall: number; mono: number }[] = [];
      const sample = () => samples.push({ wall: Date.now(), mono: performance.now() });
      const ntpAtStart = await ntpState();
      sample();
      const sampler = setInterval(sample, clockSampleMs);
      const model = await provider.startProvider();
      let startedMono: number | null = null, endedMono: number | null = null;
      try {
        control = await openControl({ storagePath: `${observations}/control.sqlite`, runtimeInventory: ownInventory(await inventoryRuntime(factoryRoot), preexisting, new Date().toISOString()),
          access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] }, polling: { intervalSeconds: 60 },
          // credentialRenewal ABSENT: the production policy (600 s before expiry). No timeout: the repository has none.
          execution: { configuration, capacity: 1, credentials, builder: {},
            sandbox: {
              async prepare(input) {
                log({ call: 'prepare', workId: input.workId });
                if (++prepared !== 1 || !await allowed(input.workId)) return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
                const result = await sandbox.prepare(input); log({ call: 'prepare-result', result }); return result;
              },
              async start(input) { const result = await sandbox.start(input); log({ call: 'start', result }); return result; },
              async stop(input) { const result = await sandbox.stop(input); log({ call: 'stop', input, result }); return result; },
            },
            workers: {
              async activate(invocation, delivery) {
                log({ call: 'activate', context: invocation.context, credentialDelivered: delivery?.credential !== undefined });
                if (++activated !== 1) throw new Error('WORKER_LAUNCH_INVALID');
                return workers.activate(invocation, delivery);
              },
              async deliver(worker, directive) {
                const result = await workers.deliver(worker, directive);
                log({ call: 'deliver', directive: directive.kind, ...(directive.kind === 'credential' ? { fingerprint: fingerprint(directive.credential.token) } : {}), result });
                return result;
              },
            } } });
        const stop = new AbortController();
        const running = control.run(stop.signal);
        const deadline = Date.now() + runDeadlineMs;
        let found: Awaited<ReturnType<typeof findWork>> = { work: undefined, complete: false };
        let questions: QuestionView[] = [];
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          found = await findWork(control as never);
          const execution = found.work?.execution;
          if (execution?.state === 'started' && startedMono === null) startedMono = performance.now();
          if (execution && execution.state !== 'reserved' && execution.state !== 'started' && endedMono === null && startedMono !== null) endedMono = performance.now();
          // The scripted schedule never asks: any Question ends the run held, with its text (read by id).
          questions = await questionsOf(control as never, found.work);
          if (questions.length) break;
          if (execution && (['held', 'released'].includes(execution.state) || (execution.state === 'ended' && execution.dispatch.phase === 'stopped'))) break;
        }
        const final = found.work ?? null;
        const observed = model.observation();
        const firstExpiresAt = (events.find(event => event.call === 'issued')?.metadata as { expiresAt?: string } | undefined)?.expiresAt ?? null;
        const censusCrossed = censusCrossedExpiry(observed.emitted[1] && observed.results[1] ? { start: observed.emitted[1], end: observed.results[1].at } : undefined, firstExpiresAt);
        const settled = runOutcome({ execution: found.work?.execution ?? undefined, questions, deadlineReached: Date.now() >= deadline, listComplete: found.complete, censusCrossed });
        stop.abort();
        const outcome = await running;
        // Post-check: GitHub must no longer accept any grant (one DELETE each, expected 401 -> already-invalid). Never retried.
        const postCheck = [];
        for (const grant of grants) postCheck.push({ fingerprint: fingerprint(grant.delivery.token), result: await real.revoke(grant) });
        grants.length = 0;
        sample();
        await save('run-result', { status: settled.status, holdReason: settled.holdReason, censusCrossed, questions, outcome, final, events, postCheck, provider: model.observation(), observedMonotonicMs: startedMono !== null && endedMono !== null ? Math.round(endedMono - startedMono) : null,
          clock: { samples, ntpAtStart, ntpAtEnd: await ntpState() }, deadlineReached: Date.now() >= deadline });
      } finally { clearInterval(sampler); await model.close(); }
      const saved = await load('run-result') as { status?: string; holdReason?: string | null } | null;
      if (saved?.status !== 'success') throw new Error(`PHASE_NOT_AS_EXPECTED:${saved?.holdReason ?? 'RUN_RESULT_MISSING'}`);
      return;
    }
    // inspect / stop-environment: a private COPY of the storage (the original is never written).
    const { snapshotStorage } = await import('./review12-qualification.js');
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const { work } = await findWork(stored as never);
    const halt = new AbortController(); halt.abort();
    await stored.run(halt.signal);
    if (!work?.execution?.dispatch.environment) throw new Error('NO_EXECUTION_OBSERVED');
    if (phase === 'inspect') {
      const ran = await load('run-result') as { events: { call: string; fingerprint?: string; directive?: string; at: string; result?: { kind?: string; status?: string } }[];
        postCheck: { result: { kind: string } }[]; provider: { results: { markers: string[]; at: string }[]; emitted: string[] }; observedMonotonicMs: number | null;
        clock: { samples: ClockSample[]; ntpAtStart: string | null; ntpAtEnd: string | null }; deadlineReached: boolean };
      const delivered = ran.events.filter(event => event.call === 'deliver' && event.directive === 'credential' && event.result?.status === 'delivered');
      const verdict = assess({ execution: work.execution, issued: ran.events.filter(event => event.call === 'issued').map(event => event.fingerprint!),
        delivered: [ran.events.find(event => event.call === 'issued')?.fingerprint ?? '', ...delivered.map(event => event.fingerprint!)], deliveredAt: delivered.map(event => event.at),
        markers: ran.provider.results.map(result => result.markers), c1: ran.provider.emitted[1] && ran.provider.results[1] ? { start: ran.provider.emitted[1], end: ran.provider.results[1].at } : undefined,
        revocations: ran.events.filter(event => event.call === 'revoke').map(event => event.result?.kind ?? ''), postCheck: ran.postCheck.map(entry => entry.result.kind),
        observedMonotonicMs: ran.observedMonotonicMs, deadlineReached: ran.deadlineReached });
      const census = ran.provider.results[1]?.markers.filter(item => item.startsWith('run:') || item.startsWith('census:')) ?? [];
      await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }); // before the scan: any hit is then a real leak
      const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
      const { secretScan } = await import('./credential20-qualification.js');
      const scanned = [observations, `${factoryRoot}/${work.work_id}`, ...(work.execution.dispatch.boot ? [workerRuntimeDirectory(factoryRoot, work.execution.dispatch.boot)] : [])];
      await save('inspect-result', { verdict, census, hostClock: { injected: false, ...clockDrift(ran.clock.samples), ntpAtStart: ran.clock.ntpAtStart, ntpAtEnd: ran.clock.ntpAtEnd,
        recordedElapsedMs: work.execution.timing?.duration?.kind === 'measured' ? work.execution.timing.duration.elapsedMs : null, observedMonotonicMs: ran.observedMonotonicMs },
      execution: { executionId: work.execution.executionId, end: work.execution.end, timing: work.execution.timing, credentialIssuance: work.execution.credentialIssuance,
        credentialRenewals: work.execution.credentialRenewals }, secretShapes: await secretScan(scanned) });
      return;
    }
    const { needsStop } = await import('./builder09-qualification.js');
    if (!needsStop(work.execution as ExecutionView)) throw new Error('NOTHING_TO_STOP');
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root: factoryRoot, guestAssets });
    const environment = work.execution.dispatch.environment as never;
    const before = await sandbox.observe({ environment });
    const result = before.condition === 'active' && before.boot ? await sandbox.stop({ environment, boot: before.boot, reason: 'q34-long explicit stop of own boot' }) : null;
    await save('stop-environment-result', { state: work.execution.state, before: { condition: before.condition, boot: before.boot ?? null }, result });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    if (phase === 'inspect') await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  // A killed phase (SIGTERM/SIGINT) removes the namespace's key copy before exiting (its `finally` never runs).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void import('node:fs/promises').then(fs => fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true })).finally(() => process.exit(143));
  });
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') || message === 'TICKET_NOT_PINNED' ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
