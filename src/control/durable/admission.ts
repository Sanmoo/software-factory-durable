import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { GitHubTicketRef, JiraTicketRef, TicketRef } from '../../issue-tracker/index.js';
import type { EnvironmentDeclarationObservation } from '../../contracts/index.js';
import { environmentImpedimentCodes, environmentNotEvaluated, environmentOutcome } from '../rules/environment.js';
import type { ControlInput, ControlReceipt, DependencyEvaluation, ForgottenWork, Impediment, JiraAuthorizationEvidence, WorkView } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import { initialBudget } from '../rules/budget.js';
import { dependencyImpedimentCodes, dependencyImpediments, ownCycleFor, type OwnCycle, type OwnCycleFacts } from '../rules/dependencies.js';
import type { Session } from './store.js';

type History = { request_id: string; operation: 'pause' | 'unpause'; before: boolean; after: boolean; origin: 'local-cli' };
/** Ticket 33: one controller run of this storage (spec §11.4: only a confirmed cessation/persistence is a clean stop; a crash leaves `current`). */
export type ControllerRun = {
  runId: string;
  startedAt: string;
  /** An earlier interruption (crash, uncertain or failed end) not yet settled by a reconciling boot (ticket 26) when this run started. */
  pendingReconciliation?: boolean;
};
export type ControllerRunEnd = ControllerRun & {
  endedAt: string;
  end: 'clean' | 'uncertain' | 'failed';
  /** This run performed ticket 26's boot reconciliation. */
  reconciled?: boolean;
  /** An interruption is still not settled after this run (it had one pending and did not reconcile, or it ended interrupted itself). */
  reconciliationPending?: boolean;
};
/** Ticket 33: explicitly requested, supported storage migrations applied to this storage, oldest first. */
export type StorageMigration = { upgradeId: string; migration: string; from: number; to: number; at: string; release: string; previousRelease: string | null };
type Installation = {
  paused: boolean;
  history: History[];
  /** Storage format identity (ticket 33; 3 since the Jira origin) and the record of every migration applied. */
  storage: { format: 3; migrations: StorageMigration[] };
  /** Storage format 2 (ticket 33): `current` is the run that has not recorded its end (alive, or crashed); `last` the latest recorded end. */
  lifecycle: { current: ControllerRun | null; last: ControllerRunEnd | null };
};
/** factory-storage-1-to-2 (ticket 33): format 1 recorded no controller lifecycle, so nothing proves how its last run ended and nothing is invented. */
const installationOneToTwo = (value: Record<string, unknown>) => ({
  ...value,
  storage: { format: 2, migrations: [] },
  lifecycle: { current: null, last: null },
});
/** factory-storage-2-to-3 (Jira ticket 02): only the format identity changes; pause, history, migration records and lifecycle are kept. */
const installationTwoToThree = (value: Record<string, unknown>) => ({ ...value, storage: { ...(value.storage as Record<string, unknown>), format: 3 } });
/**
 * Version 3 = storage format 3 (Jira ticket 02; version 2 = format 2, ticket 33). Older storages are NEVER migrated lazily: the operational open
 * refuses them (STORAGE_MIGRATION_REQUIRED) and only the explicitly requested upgrade migration commits this conversion, all at once. A format-1
 * installation passes through exactly the 1→2 conversion first.
 */
export const installation = defineDoc<Installation>({
  kind: 'factory.installation',
  version: 3,
  scope: 'session',
  initial: () => ({ paused: false, history: [], storage: { format: 3, migrations: [] }, lifecycle: { current: null, last: null } }),
  checkpointWhen: () => true,
  migrate: (value, fromVersion) => {
    if (fromVersion !== 1 && fromVersion !== 2) throw new Error('STORAGE_FORMAT_UNSUPPORTED');
    const two = fromVersion === 1 ? installationOneToTwo(value as Record<string, unknown>) : (value as Record<string, unknown>);
    return installationTwoToThree(two) as unknown as Installation;
  },
});
/** Identified ingresses (CLI request ids, `github-comment-<id>` for comments, `jira-comment-<site>-<issue>-<comment>` for Jira Card comments) with
 * their single durable result. */
export const requests = defineDocFamily<
  {
    input:
      | ControlInput
      | { request_id: string; operation: 'answer'; origin: 'github-comment' | 'jira-comment' }
      | { request_id: string; operation: 'repair'; work_id: string; reason: string; origin: 'github-comment' }
      /** Jira ticket 06: a `/factory` comment of a Jira Card that did not apply (its guidance/ignored receipt). */
      /** `accountId: null`: Jira gave no author (the comment was ignored, never applied). */
      | {
          request_id: string;
          operation: 'jira-comment';
          work_id: string;
          origin: 'jira-comment';
          comment: { siteId: string; issueId: string; commentId: string; accountId: string | null };
        }
      /** Jira ticket 07: `/factory cancel` on the Work's origin Card (its cancel receipt, the same cancellation as the local `cancel`). */
      | {
          request_id: string;
          operation: 'cancel';
          work_id: string;
          origin: 'jira-comment';
          comment: { siteId: string; issueId: string; commentId: string; accountId: string };
        }
      | null;
    receipt: ControlReceipt | null;
  },
  null
>({
  kind: 'factory.request',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ input: null, receipt: null }),
  checkpointWhen: () => true,
});
/** Installation-level Ticket → cycle index and FIFO admission sequence (spec §3.2), committed with each Work. */
/** `memory`: explicit minimal memory per Ticket key (spec §12.4) — cycle identity/order, result and confirmed merge; absent in pre-08 storage. */
/** `forgotten` (ticket 31): minimal memory of each Work whose history `forget` deleted, by Work id. Such a Work leaves `order` (no Work record
 * remains) but stays named by `tickets` (never re-admitted) and by `memory` (own-dependency evaluation). */
type TicketIndex = {
  admissionSequence: number;
  tickets: Record<string, { current: string; previous: string[] }>;
  order: string[];
  /** Ticket 22: last repair sequence given to a new correction (installation-wide FIFO of the repair category). */
  repairSequence?: number;
  memory?: Record<string, { cycles: OwnCycle[] }>;
  forgotten?: Record<string, ForgottenWork>;
};
export type { TicketIndex };
export const ticketIndex = defineDoc<TicketIndex>({
  kind: 'factory.ticket-index',
  version: 1,
  scope: 'session',
  initial: () => ({ admissionSequence: 0, tickets: {}, order: [] }),
  checkpointWhen: () => true,
});
/**
 * Ticket 31 (review MED): every request whose input carries operator text (answer, update-scope, authorize-readiness) is linked to its Work in
 * the SAME commit as the request, whatever its outcome (accepted or not-applied), so `forget` erases all of them. Kept on the Work record (an
 * optional field of `factory.work` v1: no new document kind, the storage format is unchanged).
 */
export async function linkRequest(tx: Parameters<Parameters<Session['commit']>[0]>[0], work_id: string, request_id: string) {
  const document = await tx.doc(works, work_id, null);
  if (!document.work) return;
  const linked = document.work.contentRequests ?? [];
  if (!linked.includes(request_id)) document.work.contentRequests = [...linked, request_id];
}
export type WorkRecord = Omit<WorkView, 'dispatch' | 'limits'>;
export const works = defineDocFamily<{ work: WorkRecord | null }, null>({
  kind: 'factory.work',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ work: null }),
  checkpointWhen: () => true,
});

export type AdmissionEvidence = GitHubAdmissionEvidence | JiraAdmissionEvidence;
/**
 * Jira ticket 04 (spec §3.5): a Jira Card re-read by ID and decided eligible with the current configuration immediately before the commit.
 * `dependencies` is that same read's visible-blockers evaluation (current round): no `DEPENDENCIES_NOT_EVALUATED` is added for Jira.
 * `repository.repositoryId` is the destination's GitHub identity (observed by the GitHub polling of that repository), never a Jira fact.
 */
export type JiraAdmissionEvidence = {
  ticket: JiraTicketRef;
  repository: { repository: string; repositoryId: number; base: string };
  observedAt: string;
  authorization: JiraAuthorizationEvidence;
  dependencies: DependencyEvaluation;
  environment?: EnvironmentDeclarationObservation;
};
export type GitHubAdmissionEvidence = {
  ticket: GitHubTicketRef;
  repository: { repository: string; repositoryId: number; base: string };
  observedAt: string;
  label: { id: number; name: string };
  publication: { observedAt: string; limitations: string[] };
  /** Ticket 44: the read of `.factory/environment.yaml` at the base tip made by the polling round that admits the Work (always present there).
   * Absent only for callers predating ticket 44 (tests); such a Work has no `environment` and is never gated by it. */
  environment?: EnvironmentDeclarationObservation;
};
export type AdmissionResult = { kind: 'admitted'; work_id: string; sequence: number } | { kind: 'existing'; work_id: string } | { kind: 'paused' };

export async function initialize(session: Session) {
  await session.commit(async tx => {
    await tx.doc(installation);
    await tx.doc(ticketIndex);
  }, BACKGROUND_CONTEXT);
}

/**
 * Admit-Work transaction (spec §3.4): absence of a current cycle in the index, the global pause, the Work record, the index entry and the
 * admission sequence are read and written in ONE real Session commit. Concurrent or repeated callers serialise on Pi Durable's commit line.
 */
export async function admitTicket(
  session: Session,
  evidence: AdmissionEvidence,
  /** Configured limits of the repository, captured with the Work (spec §4.4); later configuration changes never alter them. */
  limits: { correctionLimit?: number | undefined; recoveryLimit?: number | undefined } = {},
): Promise<AdmissionResult> {
  const key = ticketKey(evidence.ticket);
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const existing = index.tickets[key];
    if (existing) return { kind: 'existing' as const, work_id: existing.current };
    if ((await tx.doc(installation)).paused) return { kind: 'paused' as const };
    const work_id = randomUUID();
    const document = await tx.doc(works, work_id, null);
    if (document.work) throw new Error('WORK_IDENTITY_COLLISION');
    const sequence = index.admissionSequence + 1;
    const admittedAt = new Date().toISOString();
    const jira = evidence.ticket.tracker === 'jira' ? (evidence as JiraAdmissionEvidence) : null;
    const github = jira ? null : (evidence as GitHubAdmissionEvidence);
    const origin = jira ? ('jira-polling' as const) : ('github-polling' as const);
    // GitHub: replaced by the first native dependency evaluation of the same polling round; a crash in between keeps the Work held.
    // Jira: the visible blockers were evaluated by the re-read that decided this admission (recorded as the Work's current evaluation).
    const impediments: Impediment[] = jira
      ? []
      : [
          {
            code: 'DEPENDENCIES_NOT_EVALUATED',
            scope: 'work',
            since: admittedAt,
            nextStep: 'Native blocked_by evaluation must complete before any dispatch; the next polling round evaluates it.',
          },
        ];
    // Ticket 44: the environment declaration read at the base tip in the same round, pinned with the Work (or the impediment saying why not).
    const initial = evidence.environment ? environmentNotEvaluated(admittedAt) : null;
    const outcome =
      initial && evidence.environment
        ? environmentOutcome(initial.environment, evidence.environment, {
            workId: work_id,
            repository: evidence.repository.repository,
            base: evidence.repository.base,
            at: admittedAt,
          })
        : null;
    if (outcome?.impediment) impediments.push(outcome.impediment);
    document.work = {
      work_id,
      cycle: 1,
      predecessor: null,
      ticket: evidence.ticket,
      repository: evidence.repository,
      result: 'open',
      authorization: jira
        ? {
            state: 'authorized',
            observedAt: jira.observedAt,
            ...structuredClone(jira.authorization),
            tracking:
              'Authorization recorded at admission from the Card re-read by ID; later reads of the entry label track it. Absence from a listing is never treated as withdrawal.',
          }
        : {
            state: 'authorized',
            source: 'github-rest',
            observedAt: github!.observedAt,
            basis: { repositoryConfigured: true, issueState: 'open', label: github!.label },
            publication: {
              observedAt: github!.publication.observedAt,
              completeness: 'complete',
              associatedPullRequests: 0,
              limitations: github!.publication.limitations,
            },
            tracking:
              'Authorization recorded at admission. Later label removal/closure tracking is not part of this increment; absence from a listing is never treated as withdrawal.',
          },
      queue: { category: 'normal', sequence, pending: true },
      impediments,
      dependencies: jira
        ? {
            latest: jira.dependencies,
            lastComplete: { evaluationId: jira.dependencies.evaluationId, observedAt: jira.dependencies.observedAt, conclusion: jira.dependencies.conclusion },
          }
        : { latest: null, lastComplete: null },
      execution: null,
      branch: null,
      pullRequest: null,
      previousExecutions: [],
      questions: [],
      inputs: { cursor: null },
      admittedAt,
      budget: initialBudget(limits, evidence.repository.repository, admittedAt),
      correction: null,
      pendingRecovery: null,
      history: [
        { at: admittedAt, event: 'admitted', origin, sequence },
        ...(outcome?.event ? [{ at: admittedAt, event: 'environment-evaluated' as const, origin, detail: outcome.event }] : []),
      ],
      ...(outcome ? { environment: outcome.environment } : {}),
    };
    index.admissionSequence = sequence;
    index.tickets[key] = { current: work_id, previous: [] };
    index.memory = {
      ...(index.memory ?? {}),
      [key]: { cycles: [...(index.memory?.[key]?.cycles ?? []), { work_id, cycle: 1, result: 'open', mergeConfirmed: false }] },
    };
    index.order.push(work_id);
    return { kind: 'admitted' as const, work_id, sequence };
  }, BACKGROUND_CONTEXT);
}

/**
 * Lifecycle of an Execution recorded before the credential lifecycle (ticket 20), derived from its execution state: an Execution that is no
 * longer reserved/started is `withdrawn` for an unknown legacy reason; otherwise `active` when it holds a grant.
 */
export function legacyCredentialLifecycle(execution: NonNullable<WorkRecord['execution']>): NonNullable<WorkRecord['execution']>['credentialLifecycle'] {
  const over = execution.end !== null || ['ended', 'released', 'held'].includes(execution.state);
  return {
    state: over ? 'withdrawn' : execution.credentialIssuance ? 'active' : 'none',
    withdrawnAt: null,
    reason: over ? 'legacy-unknown' : null,
    renewal: 'enabled',
    renewalStop: null,
    workerNotice: null,
  };
}
const normalize = (work: WorkRecord): WorkRecord => ({
  ...work,
  dependencies: work.dependencies ?? { latest: null, lastComplete: null },
  execution: work.execution
    ? {
        ...work.execution,
        credentialRenewals: work.execution.credentialRenewals ?? [],
        credentialLifecycle: work.execution.credentialLifecycle
          ? { ...work.execution.credentialLifecycle, workerNotice: work.execution.credentialLifecycle.workerNotice ?? null }
          : legacyCredentialLifecycle(work.execution),
      }
    : null,
  branch: work.branch ?? null,
  previousExecutions: work.previousExecutions ?? [],
  questions: work.questions ?? [],
  inputs: work.inputs ?? { cursor: null },
  budget: work.budget ?? null,
  correction: work.correction ?? null,
  pendingRecovery: work.pendingRecovery ?? null,
});

/** Open Works with pending queue work of one repository (by immutable id), FIFO by admission sequence. */
export async function pendingWorks(session: Session, repositoryId: number): Promise<WorkRecord[]> {
  return (await readWorks(session)).filter(work => work.repository.repositoryId === repositoryId && work.result === 'open' && work.queue.pending);
}

/**
 * Local facts of blockers that are Factory Tickets, by GitHub issue id (globally unique). Sources: the index (current/previous cycles), the
 * explicit minimal memory written with each admission (kept even if an index entry or Work record disappears) and the Work records.
 * Classification itself is the pure `ownCycleFor`: indexed or remembered is own, never external; no record and no memory is 'missing'.
 */
export async function ownCycles(session: Session, issueIds: number[]): Promise<Record<number, OwnCycleFacts>> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const issueOf = (key: string) => Number(/^github:repository:\d+:issue:(\d+)$/.exec(key)?.[1]);
  const indexed = new Map<number, { current: string; previous: string[] }>();
  for (const [key, entry] of Object.entries(index?.tickets ?? {})) if (Number.isSafeInteger(issueOf(key))) indexed.set(issueOf(key), entry);
  const memory = new Map<number, OwnCycle[]>();
  for (const [key, entry] of Object.entries(index?.memory ?? {})) if (Number.isSafeInteger(issueOf(key))) memory.set(issueOf(key), entry.cycles);
  const result: Record<number, OwnCycleFacts> = {};
  for (const issueId of new Set(issueIds)) {
    const entry = indexed.get(issueId),
      remembered = memory.get(issueId);
    if (!entry && !remembered) continue;
    const records: Record<string, OwnCycle | undefined> = {};
    for (const id of new Set([...(entry ? [entry.current, ...entry.previous] : []), ...(remembered ?? []).map(item => item.work_id)])) {
      const work = (await session.snapshot(works, id, BACKGROUND_CONTEXT))?.work;
      // Ticket 17 produces delivery: `delivered` only with the confirmed merge of the cycle's own pull request recorded in the same commit.
      if (work)
        records[id] = {
          work_id: id,
          cycle: work.cycle,
          result: work.result,
          mergeConfirmed: work.result === 'delivered' && work.delivery?.state === 'delivered' && Boolean(work.delivery.merge),
        };
    }
    const facts = ownCycleFor({ ...(entry ? { indexed: entry } : {}), ...(remembered ? { memory: remembered } : {}), records });
    if (facts) result[issueId] = facts;
  }
  return result;
}

/**
 * Record one evaluation on the CURRENT cycle of its Ticket, in one commit: latest evaluation, last complete one, dependency impediments
 * (others untouched) and a history entry only when the conclusion changes. A Work no longer open/pending/current is left unchanged.
 */
export async function recordDependencies(
  session: Session,
  work_id: string,
  evaluation: DependencyEvaluation,
  /** Ticket 16: also the published own PR's Work (readiness re-reads its dependencies before every recheck). */
  options: { published?: boolean } = {},
): Promise<'recorded' | 'skipped'> {
  return session.commit(async tx => {
    const index = await tx.doc(ticketIndex);
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    // Pending queue work, or the Execution reserved for it (revalidation immediately before activation, spec §3.4).
    if (
      !work ||
      work.result !== 'open' ||
      !(work.queue.pending || work.execution?.state === 'reserved' || (options.published && work.publication?.state === 'published')) ||
      index.tickets[ticketKey(work.ticket)]?.current !== work_id
    )
      return 'skipped' as const;
    const previous = work.dependencies ?? { latest: null, lastComplete: null };
    const before = previous.latest?.conclusion ?? null;
    const known = new Map(work.impediments.map(item => [item.code, item.since]));
    const derived = dependencyImpediments(evaluation, evaluation.evaluatedAt).map(item => ({ ...item, since: known.get(item.code) ?? item.since }));
    work.impediments = [...work.impediments.filter(item => !(dependencyImpedimentCodes as readonly string[]).includes(item.code)), ...derived];
    work.dependencies = {
      latest: evaluation,
      lastComplete:
        evaluation.completeness === 'complete' && evaluation.conclusion !== 'inconclusive'
          ? { evaluationId: evaluation.evaluationId, observedAt: evaluation.observedAt, conclusion: evaluation.conclusion }
          : previous.lastComplete,
    };
    if (before !== evaluation.conclusion)
      work.history.push({
        at: evaluation.evaluatedAt,
        event: 'dependencies-changed',
        origin: evaluation.source === 'jira-rest' ? 'jira-polling' : 'github-polling',
        before,
        after: evaluation.conclusion,
        evaluationId: evaluation.evaluationId,
      });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Ticket 44: record one read of the environment declaration on a pending Work whose environment is not pinned yet (one commit: state,
 * environment impediments, history on a change). A pinned or legacy Work is left unchanged (the pin is never re-read).
 */
export async function recordEnvironment(session: Session, work_id: string, observation: EnvironmentDeclarationObservation): Promise<'recorded' | 'skipped'> {
  return session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work;
    if (!work || work.result !== 'open') return 'skipped' as const;
    const at = new Date().toISOString();
    const outcome = environmentOutcome(work.environment, observation, {
      workId: work_id,
      repository: work.repository.repository,
      base: work.repository.base,
      at,
    });
    if (!outcome) return 'skipped' as const;
    const known = new Map(work.impediments.map(item => [item.code, item.since]));
    work.impediments = [
      ...work.impediments.filter(item => !(environmentImpedimentCodes as readonly string[]).includes(item.code)),
      ...(outcome.impediment ? [{ ...outcome.impediment, since: known.get(outcome.impediment.code) ?? outcome.impediment.since ?? at }] : []),
    ];
    work.environment = outcome.environment;
    if (outcome.event) work.history.push({ at, event: 'environment-evaluated', origin: 'github-polling', detail: outcome.event });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Jira ticket 04: a fresh observation by ID of a Jira Work's Card carries another visible key (PAG-42 -> FIN-18): update the presentation
 * (`ticket.key`/`url`) of the current Work with a history entry, in one commit. Identity, destination and index key never change.
 */
export async function recordTicketPresentation(
  session: Session,
  work_id: string,
  fresh: JiraTicketRef,
  origin: 'jira-polling' | 'controller-dispatch' = 'jira-polling',
): Promise<'recorded' | 'unchanged'> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    if (!work || work.ticket.tracker !== 'jira' || work.ticket.siteId !== fresh.siteId || work.ticket.issueId !== fresh.issueId) return 'unchanged' as const;
    if (work.ticket.key === fresh.key && work.ticket.url === fresh.url) return 'unchanged' as const;
    const before = work.ticket.key;
    work.ticket = { ...work.ticket, key: fresh.key, url: fresh.url };
    work.history.push({ at: new Date().toISOString(), event: 'ticket-presentation-changed', origin, detail: `${before} -> ${fresh.key}`.slice(0, 600) });
    return 'recorded' as const;
  }, BACKGROUND_CONTEXT);
}
/** Jira ticket 04: open Works with pending queue work admitted from one Jira source (site + project), FIFO. */
export async function pendingJiraWorks(session: Session, source: { siteId: string; projectId: string }): Promise<WorkRecord[]> {
  return (await readWorks(session)).filter(
    work =>
      work.ticket.tracker === 'jira' &&
      work.ticket.siteId === source.siteId &&
      work.authorization.source === 'jira-rest' &&
      work.authorization.basis.projectId === source.projectId &&
      work.result === 'open' &&
      work.queue.pending,
  );
}

export async function indexedWork(session: Session, ticket: TicketRef): Promise<string | undefined> {
  return (await session.snapshot(ticketIndex, BACKGROUND_CONTEXT))?.tickets[ticketKey(ticket)]?.current;
}
export async function readWorks(session: Session): Promise<WorkRecord[]> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  const result: WorkRecord[] = [];
  for (const id of index?.order ?? []) {
    const work = (await session.snapshot(works, id, BACKGROUND_CONTEXT))?.work;
    if (!work) throw new Error('WORK_INDEX_INCONSISTENT');
    result.push(normalize(work));
  }
  return result.sort((a, b) => a.queue.sequence - b.queue.sequence);
}
export async function readWork(session: Session, work_id: string): Promise<WorkRecord | undefined> {
  const work = (await session.snapshot(works, work_id, BACKGROUND_CONTEXT))?.work;
  return work ? normalize(work) : undefined;
}
/** Ticket 31: the minimal memory of every forgotten Work (admission order), or of one. */
export async function readForgotten(session: Session): Promise<ForgottenWork[]> {
  const index = await session.snapshot(ticketIndex, BACKGROUND_CONTEXT);
  return Object.values(index?.forgotten ?? {}).sort((a, b) => a.sequence - b.sequence);
}
export async function readForgottenWork(session: Session, work_id: string): Promise<ForgottenWork | undefined> {
  return (await session.snapshot(ticketIndex, BACKGROUND_CONTEXT))?.forgotten?.[work_id];
}
export async function readInstallation(session: Session): Promise<Installation> {
  const current = await session.snapshot(installation, BACKGROUND_CONTEXT);
  if (!current) throw new Error('INSTALLATION_STATE_MISSING');
  return current;
}
export async function readRequest(session: Session, request_id: string): Promise<ControlReceipt | null> {
  return (await session.snapshot(requests, request_id, BACKGROUND_CONTEXT))?.receipt ?? null;
}

/** Pause/unpause: receipt, history and pause change share one real Session commit (no deferred persistence). */
export async function acceptPauseCommand(
  session: Session,
  command: Extract<ControlInput, { operation: 'pause' | 'unpause' }>,
): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' }> {
  return session.commit(async tx => {
    const current = await tx.doc(installation);
    const request = await tx.doc(requests, command.request_id, null);
    if (request.input) {
      if (request.input.operation !== command.operation || request.input.origin !== command.origin) {
        return { kind: 'refused' as const, code: 'REQUEST_ID_CONFLICT' as const };
      }
      return { ...request.receipt! };
    }
    const paused = command.operation === 'pause';
    const receipt: ControlReceipt = {
      kind: 'durable',
      request_id: command.request_id,
      operation: command.operation,
      paused,
      historySequence: current.history.length + 1,
    };
    current.history.push({ request_id: command.request_id, operation: command.operation, before: current.paused, after: paused, origin: command.origin });
    current.paused = paused;
    request.input = command;
    request.receipt = receipt;
    return receipt;
  }, BACKGROUND_CONTEXT);
}
