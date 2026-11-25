import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { InvestigationRecord, InvestigationStop } from '../../sandbox/index.js';
import type { AccessDependencies, TriageAttempt, TriagePorts, TriageRequest } from '../types.js';
import { afterAttemptWithoutVerdict, attemptEndCode, holdsTriageCapacity } from '../rules/triage.js';
import { triageActivation } from '../rules/triage-prompt.js';
import { intendedChanges, validateVerdict } from '../rules/triage-verdict.js';
import type { Session } from './store.js';
import { readTriageRequest, readTriageRequests, transitionTriageRequest, triageQueue, triageVerdicts, updateTriageAttempt } from './triage-requests.js';
import { readTriageSubject, type TriageSubject } from './triage-ticket.js';

// Spec #68 §6-§7 (ticket #75): one request from `queued` to a recorded Verdict (`publishing`). An attempt STARTS at the commit that moves
// the request to `investigating` with the environment's intent, and ENDS at the commit that sets `attempt.end` after the environment
// answered the stop. In between, the Triager session of that attempt asks for clones and records the Verdict through this desk, which
// validates both. Nothing here writes to a tracker: the intended changes are recorded with the Verdict for the publication.

type Activation = Awaited<ReturnType<TriagePorts['triager']['activate']>>;
type Host = Parameters<TriagePorts['triager']['activate']>[0]['host'];
type Running = {
  request: TriageRequest;
  attempt: string;
  subject: TriageSubject;
  clones: string | null;
  cloned: Map<string, { path: string; commit: string }>;
};
const cloneName = (repository: string) => repository.replace('/', '__');
/** How often a running attempt's environment is observed for an agent that ended without reporting. */
const agentWatchMs = 2000;
const unconfirmed: InvestigationStop = { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' };

export function createTriageInvestigations(deps: {
  session: Session;
  access: AccessDependencies;
  ports: TriagePorts;
  paused(): Promise<boolean>;
  stopped(): boolean;
  /** GitHub identity of an executable repository, as the polling of this run observed it (it keys the bare cache). */
  repositoryId(repository: string): number | undefined;
}) {
  const { session, ports } = deps;
  /** Attempts whose session this process is running (memory only); every other open attempt belongs to an earlier process. */
  const running = new Map<string, Promise<void>>();
  let reconciled = false;

  /** Stops the attempt's environment, removes it once the stop is confirmed and records how the attempt ended. */
  async function endAttempt(triage_request_id: string, record: InvestigationRecord, end: { code: string; transcript: string | null }) {
    const cessation = await ports.environment.stop(record).catch(() => unconfirmed);
    if (cessation.cessationConfirmed) await ports.environment.close(record).catch(() => {});
    await updateTriageAttempt(session, triage_request_id, record.attempt, attempt => {
      attempt.end = { at: new Date().toISOString(), code: end.code, cessation, transcript: end.transcript };
    });
    const request = await readTriageRequest(session, triage_request_id);
    if (request?.state !== 'investigating') return;
    // Without a Verdict the request leaves `investigating` by the rule ticket #76 owns (requeue with balance, else `failed`).
    const next = afterAttemptWithoutVerdict({ attempts: request.attempts?.length ?? 0 }, end.code);
    await transitionTriageRequest(session, triage_request_id, { from: ['investigating'], to: next.to, event: 'attempt-ended', code: next.code });
  }

  /** The clone request of a session: a candidate is copied from the bare cache and mounted read-only; anything else is refused. */
  async function requestClone(state: Running, repository: string): ReturnType<Host['requestClone']> {
    const candidate = state.subject.candidates.find(item => item.repository.toLowerCase() === repository.toLowerCase());
    if (!candidate) {
      const names = state.subject.candidates.map(item => item.repository).join(', ') || 'none';
      return { status: 'refused', code: 'CLONE_NOT_A_CANDIDATE', message: `${repository} is not a candidate repository of this Triage. Candidates: ${names}.` };
    }
    const known = state.cloned.get(candidate.repository);
    if (known) return { status: 'cloned', repository: candidate.repository, ...known };
    if (!state.clones) return { status: 'refused', code: 'CLONE_UNAVAILABLE', message: 'The Investigation Environment is not open yet.' };
    const { ticket } = state.request;
    const own = ticket.tracker === 'github' && ticket.repository.toLowerCase() === candidate.repository.toLowerCase();
    const repositoryId = own ? ticket.repositoryId : deps.repositoryId(candidate.repository);
    if (repositoryId === undefined)
      return { status: 'refused', code: 'CLONE_UNAVAILABLE', message: `The Factory has not observed ${candidate.repository} yet. Go on without it.` };
    const name = cloneName(candidate.repository);
    const { installationId, base } = candidate;
    const created = await ports.clones.create({ directory: state.clones, name, repository: candidate.repository, repositoryId, installationId, base });
    if (created.status !== 'success')
      return {
        status: 'refused',
        code: 'CLONE_UNAVAILABLE',
        message: `The Factory could not clone ${candidate.repository} (${created.code}). Go on without it.`,
      };
    const mounted = await ports.environment.mountClone(state.attempt, { name, source: created.path });
    const clone = { path: mounted.path, commit: created.commit };
    state.cloned.set(candidate.repository, clone);
    await updateTriageAttempt(session, state.request.triage_request_id, state.attempt, attempt => {
      attempt.clones.push({ repository: candidate.repository, commit: created.commit, at: new Date().toISOString() });
    });
    return { status: 'cloned', repository: candidate.repository, ...clone };
  }

  /**
   * `concluir_triagem`: an invalid Verdict goes back to the session with its errors; a valid one is recorded with its intended changes in
   * the ONE commit that moves the request to `publishing`. Accepted means recorded, never published.
   */
  async function conclude(state: Running, input: Record<string, unknown>): ReturnType<Host['conclude']> {
    const checked = validateVerdict(input, state.subject.verdictContext);
    if (!checked.valid) return { status: 'refused', errors: checked.errors };
    const { text, ...verdict } = checked.verdict;
    const id = state.request.triage_request_id;
    const moved = await transitionTriageRequest(session, id, { from: ['investigating'], to: 'publishing', event: 'verdict-recorded' }, async (request, tx) => {
      request.verdict = {
        ...verdict,
        attempt: state.attempt,
        recordedAt: new Date().toISOString(),
        textSha256: createHash('sha256').update(text).digest('hex'),
        textBytes: Buffer.byteLength(text),
      };
      request.intended = intendedChanges(checked.verdict, state.subject.roles, state.request.ticket.tracker);
      (await tx.doc(triageVerdicts, id, null)).verdict = { triage_request_id: id, text };
    });
    if (moved.kind === 'applied') return { status: 'recorded' };
    return {
      status: 'refused',
      errors: [{ code: 'TRIAGE_REQUEST_NOT_INVESTIGATING', message: 'This Triage request is no longer being investigated; nothing was recorded. Stop here.' }],
    };
  }

  /**
   * An agent that ended without reporting (it never reached its channel, or died with it): the environment confirms the attempt ceased
   * while its completion never came. Observed until the attempt is no longer running here; without it such an attempt would never end.
   */
  async function agentGone(record: InvestigationRecord): Promise<{ status: 'failure'; code: string }> {
    for (;;) {
      await delay(ports.agentWatchMs ?? agentWatchMs, undefined, { ref: false });
      const observed = await ports.environment.observe(record).catch(() => unconfirmed);
      if (observed.cessationConfirmed || !running.has(record.attempt)) return { status: 'failure', code: 'TRIAGER_AGENT_EXITED' };
    }
  }

  /** One attempt, after its start commit: activate the Triager, open the environment with its agent, wait for the session, end. */
  async function investigate(state: Running, intent: InvestigationRecord) {
    const id = state.request.triage_request_id;
    let record = intent;
    let activation: Activation | undefined;
    let end = { code: 'TRIAGE_ATTEMPT_FAILED', transcript: null as string | null };
    try {
      activation = await ports.triager.activate({
        attempt: state.attempt,
        activation: triageActivation({ ...state.subject, remainingMs: ports.investigationMinutes * 60_000 }),
        host: { requestClone: repository => requestClone(state, repository), conclude: verdict => conclude(state, verdict) },
      });
      const { skillPack } = activation;
      await updateTriageAttempt(session, id, state.attempt, attempt => void (attempt.skillPack = skillPack));
      // A controller that is stopping starts no environment: the attempt ends here, spent, with nothing to stop.
      const opened = deps.stopped()
        ? ({ status: 'failure', code: 'CONTROLLER_STOPPED' } as const)
        : await ports.environment.open(intent, { limits: ports.limits, agent: activation.agent });
      if (opened.status === 'failure') end = { code: opened.code, transcript: null };
      else {
        record = opened.record;
        state.clones = opened.clones;
        await updateTriageAttempt(session, id, state.attempt, attempt => void (attempt.environment = opened.record));
        const completion = await Promise.race([activation.completed, agentGone(opened.record)]);
        const recorded = (await readTriageRequest(session, id))?.verdict?.attempt === state.attempt;
        end = { code: recorded ? 'VERDICT_RECORDED' : attemptEndCode(completion), transcript: 'transcript' in completion ? completion.transcript : null };
      }
    } catch {
      /* `end` keeps the generic failure: the attempt is ended below whatever threw. */
    }
    await activation?.close().catch(() => {});
    await endAttempt(id, record, end);
  }

  /** Reads the Ticket, then starts the attempt: the intent is committed with the move to `investigating` BEFORE the environment exists. */
  async function start(request: TriageRequest) {
    const read = await readTriageSubject(deps.access, request);
    if (read.kind !== 'observed') return;
    const ordinal = (request.attempts?.length ?? 0) + 1;
    const attempt = `t${request.sequence}-${ordinal}-${randomBytes(4).toString('hex')}`;
    const intent = await ports.environment.plan(attempt);
    const record: TriageAttempt = { attempt, ordinal, startedAt: new Date().toISOString(), environment: intent, skillPack: null, clones: [], end: null };
    const moved = await transitionTriageRequest(
      session,
      request.triage_request_id,
      { from: ['queued'], to: 'investigating', event: 'attempt-started', code: attempt },
      current => void (current.attempts = [...(current.attempts ?? []), record]),
    );
    if (moved.kind !== 'applied') return;
    const state: Running = { request: moved.request, attempt, subject: read.subject, clones: null, cloned: new Map() };
    running.set(
      attempt,
      investigate(state, intent)
        .catch(() => {})
        .finally(() => running.delete(attempt)),
    );
  }

  /** Attempts an earlier process left open: never reattached (spec §6). Stopped, confirmed when possible, and counted as spent. */
  async function reconcile(requests: readonly TriageRequest[]) {
    for (const request of requests)
      for (const attempt of request.attempts ?? [])
        if (!attempt.end && !running.has(attempt.attempt))
          await endAttempt(request.triage_request_id, attempt.environment, { code: 'INVESTIGATION_INTERRUPTED', transcript: null });
  }

  return {
    /**
     * One pass, after each polling cycle. At most one attempt holds the capacity here (ticket #76 replaces this by the configured Triage
     * capacity and the budget); a paused installation starts none, and an attempt already running goes on.
     */
    async pass() {
      if (deps.stopped()) return;
      let requests = await readTriageRequests(session);
      if (!reconciled) {
        await reconcile(requests);
        reconciled = true;
        requests = await readTriageRequests(session);
      }
      if (requests.some(request => request.attempts?.some(holdsTriageCapacity)) || (await deps.paused())) return;
      const [head] = await triageQueue(session);
      if (head) await start(head);
    },
    /** Controller stop: every running attempt is ended with its cessation observed, and counts as spent (spec §11). */
    async stop() {
      const requests = await readTriageRequests(session);
      for (const request of requests)
        for (const attempt of request.attempts ?? [])
          if (!attempt.end && running.has(attempt.attempt)) await ports.environment.stop(attempt.environment).catch(() => unconfirmed);
      await Promise.allSettled([...running.values()]);
    },
    /** Resolves when no attempt of this process is running (tests and the stop wait on it). */
    idle: () => Promise.allSettled([...running.values()]).then(() => undefined),
  };
}
export type TriageInvestigations = ReturnType<typeof createTriageInvestigations>;
