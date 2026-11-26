import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { InvestigationRecord, InvestigationStop } from '../../sandbox/index.js';
import type { AccessDependencies, TriageAttempt, TriageClock, TriagePorts, TriageRequest } from '../types.js';
import {
  afterAttemptWithoutVerdict,
  attemptEndCode,
  holdsTriageCapacity,
  triageBalance,
  triageAttemptsExhausted,
  triageStarts,
  triageTimeExhausted,
} from '../rules/triage.js';
import { triageActivation } from '../rules/triage-prompt.js';
import { intendedChanges, validateVerdict } from '../rules/triage-verdict.js';
import type { Session } from './store.js';
import {
  endTriageAttempt,
  readTriageRequest,
  readTriageRequests,
  recordTriageCessation,
  transitionTriageRequest,
  triageQueue,
  triageVerdicts,
  updateTriageAttempt,
} from './triage-requests.js';
import { readTriageSubject, type TriageSubject } from './triage-ticket.js';

// Spec #68 §6-§7 (ticket #75): one request from `queued` to a recorded Verdict (`publishing`). An attempt STARTS at the commit that moves
// the request to `investigating` with the environment's intent, and ENDS at the commit that sets `attempt.end` after the environment
// answered the stop. In between, the Triager session of that attempt asks for clones and records the Verdict through this desk, which
// validates both. Nothing here writes to a tracker: the intended changes are recorded with the Verdict for the publication.
//
// Spec #68 §5 (ticket #76): what bounds it. At most `capacity` attempts hold a unit of Triage capacity (never a Slot), taken by the queue
// in arrival order. A request spends investigation time only while an attempt of it runs, and its attempts; both are read from the durable
// attempt records, so a restart gives nothing back. An attempt without a Verdict sends the request back to the queue for a NEW session
// while it has balance, and to `failed` otherwise. An attempt another process left open is never reattached: it is stopped and spent. A
// stop the environment does not confirm keeps its unit (an Impediment, derived from the record) and is asked again at every pass.

type Activation = Awaited<ReturnType<TriagePorts['triager']['activate']>>;
type Host = Parameters<TriagePorts['triager']['activate']>[0]['host'];
type Running = {
  request: TriageRequest;
  attempt: string;
  subject: TriageSubject;
  clones: string | null;
  cloned: Map<string, { path: string; commit: string }>;
};
/** What the session of an attempt left: its transcript and its calls per tool (absent when it never reported). */
type AttemptEnd = { code: string; transcript: string | null; toolCalls?: Record<string, number> | null };
const reportedBy = (completion: Awaited<Activation['completed']>): Omit<AttemptEnd, 'code'> =>
  'transcript' in completion ? { transcript: completion.transcript, toolCalls: completion.toolCalls ?? null } : { transcript: null };
const cloneName = (repository: string) => repository.replace('/', '__');
/** How often a running attempt's environment is observed for an agent that ended without reporting. */
const agentWatchMs = 2000;
const unconfirmed: InvestigationStop = { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' };
const notInvestigating = {
  status: 'refused' as const,
  errors: [{ code: 'TRIAGE_REQUEST_NOT_INVESTIGATING', message: 'This Triage request is no longer being investigated; nothing was recorded. Stop here.' }],
};
const systemClock: TriageClock = { now: () => Date.now(), sleep: (ms, signal) => delay(ms, undefined, { ref: false, signal }).catch(() => {}) };

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
  const clock = ports.clock ?? systemClock;
  const budget = { investigationMs: ports.investigationMinutes * 60_000, attempts: ports.attempts };
  const stamp = () => new Date(clock.now()).toISOString();

  /** Stops the attempt's environment, removes it once the stop is confirmed and records how the attempt ended. */
  async function endAttempt(triage_request_id: string, record: InvestigationRecord, end: AttemptEnd) {
    const cessation = await ports.environment.stop(record).catch(() => unconfirmed);
    if (cessation.cessationConfirmed) await ports.environment.close(record).catch(() => {});
    // Without a Verdict the request leaves `investigating` in the same commit: back to the queue with balance, else `failed`.
    const at = clock.now();
    await endTriageAttempt(
      session,
      triage_request_id,
      record.attempt,
      started => ({
        at: new Date(at).toISOString(),
        code: end.code,
        cessation,
        transcript: end.transcript,
        toolCalls: end.toolCalls ?? null,
        spentMs: Math.max(0, at - Date.parse(started.startedAt)),
      }),
      request => afterAttemptWithoutVerdict(budget, request.attempts ?? []),
    );
  }

  /** The stop of an ended attempt that was not confirmed is asked again; once confirmed its environment is removed and its unit is free. */
  async function confirmStop(triage_request_id: string, attempt: TriageAttempt) {
    const cessation = await ports.environment.stop(attempt.environment).catch(() => unconfirmed);
    if (cessation.cessationConfirmed) await ports.environment.close(attempt.environment).catch(() => {});
    else if (!attempt.end || attempt.end.cessation.cessationConfirmed || cessation.code === attempt.end.cessation.code) return;
    await recordTriageCessation(session, triage_request_id, attempt.attempt, cessation, stamp());
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
    // Only the session of the request's open attempt records: an earlier attempt of a request investigated again never does (its
    // channel is closed before its attempt ends, so this is a second barrier, not the only one).
    const open = (await readTriageRequest(session, id))?.attempts?.at(-1);
    if (open?.attempt !== state.attempt || open.end) return notInvestigating;
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
    return moved.kind === 'applied' ? { status: 'recorded' } : notInvestigating;
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

  /**
   * The investigation clock of the request while one attempt of it runs: when the time left runs out the environment is stopped, which
   * ends the session. `due` then tells why the attempt ended.
   */
  function investigationDeadline(remainingMs: number, stop: () => Promise<unknown>) {
    const over = new AbortController();
    let due = false;
    const done = clock
      .sleep(remainingMs, over.signal)
      .then(async () => {
        if (over.signal.aborted) return;
        due = true;
        await stop();
      })
      .catch(() => {});
    return {
      due: () => due,
      async cancel() {
        over.abort();
        await done;
      },
    };
  }
  type Deadline = ReturnType<typeof investigationDeadline>;

  /** Opens the environment with the attempt's agent and records its invocation. A stopping controller or a spent clock opens none. */
  async function open(state: Running, intent: InvestigationRecord, activation: Activation, deadline: Deadline) {
    const { skillPack, mcpProfiles = [] } = activation;
    const id = state.request.triage_request_id;
    await updateTriageAttempt(session, id, state.attempt, attempt => void Object.assign(attempt, { skillPack, mcpProfiles }));
    // A controller that is stopping starts no environment: the attempt ends here, spent, with nothing to stop.
    if (deps.stopped()) return { status: 'failure', code: 'CONTROLLER_STOPPED' } as const;
    if (deadline.due()) return { status: 'failure', code: triageTimeExhausted } as const;
    const opened = await ports.environment.open(intent, { limits: ports.limits, agent: activation.agent });
    if (opened.status === 'failure') return opened;
    state.clones = opened.clones;
    await updateTriageAttempt(session, id, state.attempt, attempt => void (attempt.environment = opened.record));
    return opened;
  }

  /** Waits for the session of an open environment and tells how the attempt ended: the Verdict, the clock, or what the session reported. */
  async function sessionEnd(state: Running, record: InvestigationRecord, activation: Activation, deadline: Deadline) {
    // The clock ran out while the environment was starting: the stop asked then named no invocation, so it is asked again.
    if (deadline.due()) await ports.environment.stop(record).catch(() => unconfirmed);
    const completion = await Promise.race([activation.completed, agentGone(record)]);
    const recorded = (await readTriageRequest(session, state.request.triage_request_id))?.verdict?.attempt === state.attempt;
    const timedOut = deadline.due() ? triageTimeExhausted : attemptEndCode(completion);
    return { code: recorded ? 'VERDICT_RECORDED' : timedOut, ...reportedBy(completion) };
  }

  /**
   * One attempt, after its start commit: activate the Triager, open the environment with its agent, wait for the session, end. The
   * investigation clock of the request runs from the start commit, and the attempt it ends carries the clock's own code.
   */
  async function investigate(state: Running, intent: InvestigationRecord, remainingMs: number) {
    let record = intent;
    let activation: Activation | undefined;
    let end: AttemptEnd = { code: 'TRIAGE_ATTEMPT_FAILED', transcript: null };
    const deadline = investigationDeadline(remainingMs, () => ports.environment.stop(record).catch(() => unconfirmed));
    try {
      activation = await ports.triager.activate({
        attempt: state.attempt,
        activation: triageActivation({ ...state.subject, remainingMs }),
        host: { requestClone: repository => requestClone(state, repository), conclude: verdict => conclude(state, verdict) },
      });
      const opened = await open(state, intent, activation, deadline);
      if (opened.status === 'success') record = opened.record;
      end = opened.status === 'failure' ? { code: opened.code, transcript: null } : await sessionEnd(state, record, activation, deadline);
    } catch {
      /* `end` keeps the generic failure: the attempt is ended below whatever threw. */
    }
    await deadline.cancel();
    await activation?.close().catch(() => {});
    await endAttempt(state.request.triage_request_id, record, end);
  }

  /**
   * Reads the Ticket, then starts the attempt: the intent is committed with the move to `investigating` BEFORE the environment exists.
   * A queued request without balance (the limits were lowered since its last attempt) fails here instead of starting.
   */
  async function start(request: TriageRequest) {
    const balance = triageBalance(budget, request.attempts ?? []);
    if (balance.attemptsLeft <= 0 || balance.remainingMs <= 0) {
      const code = balance.remainingMs <= 0 ? triageTimeExhausted : triageAttemptsExhausted;
      await transitionTriageRequest(session, request.triage_request_id, { from: ['queued'], to: 'failed', event: 'failed', code });
      return;
    }
    const read = await readTriageSubject(deps.access, request);
    if (read.kind !== 'observed') return;
    const ordinal = (request.attempts?.length ?? 0) + 1;
    const attempt = `t${request.sequence}-${ordinal}-${randomBytes(4).toString('hex')}`;
    const intent = await ports.environment.plan(attempt);
    const record: TriageAttempt = { attempt, ordinal, startedAt: stamp(), environment: intent, skillPack: null, clones: [], end: null };
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
      investigate(state, intent, balance.remainingMs)
        .catch(() => {})
        .finally(() => running.delete(attempt)),
    );
  }

  /**
   * What other processes left behind, at every pass (so at every start and every reconciliation). An attempt left open is never
   * reattached (spec §6): it is stopped, confirmed when possible, and spent, and its request retries only with balance. An ended attempt
   * whose stop was not confirmed is asked again until it is.
   */
  async function reconcile(requests: readonly TriageRequest[]) {
    let changed = false;
    for (const request of requests)
      for (const attempt of request.attempts ?? []) {
        if (running.has(attempt.attempt) || !holdsTriageCapacity(attempt)) continue;
        changed = true;
        if (attempt.end) await confirmStop(request.triage_request_id, attempt);
        else await endAttempt(request.triage_request_id, attempt.environment, { code: 'INVESTIGATION_INTERRUPTED', transcript: null });
      }
    return changed;
  }

  return {
    /**
     * One pass, after each polling cycle. The free units of Triage capacity go to the queue in arrival order; a paused installation
     * starts none, and an attempt already running goes on.
     */
    async pass() {
      if (deps.stopped()) return;
      let requests = await readTriageRequests(session);
      if (await reconcile(requests)) requests = await readTriageRequests(session);
      if (deps.stopped() || (await deps.paused())) return;
      const held = requests.reduce((sum, request) => sum + (request.attempts?.filter(holdsTriageCapacity).length ?? 0), 0);
      const queue = await triageQueue(session);
      for (const id of triageStarts({ capacity: ports.capacity, held, queue })) await start(queue.find(request => request.triage_request_id === id)!);
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
