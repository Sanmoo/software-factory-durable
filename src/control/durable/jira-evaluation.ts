import { createHash, randomUUID } from 'node:crypto';
import type {
  JiraBlocker,
  JiraBlockersObservation,
  JiraCandidateObservation,
  JiraLinkTypesObservation,
  JiraTicketObservation,
  JiraTicketRef,
  JiraUnavailable,
} from '../../issue-tracker/index.js';
import type { AccessDependencies, DependencyEvaluation, JiraOriginTracker, TicketContent, TicketSource } from '../types.js';
import { jiraAuthorizationFacts } from '../rules/cycles.js';
import type { WorkRecord } from './admission.js';
import {
  blockerDirection,
  evaluateJiraCandidate,
  jiraBlockersConclusion,
  routeTicket,
  ticketUnverifiable,
  type JiraEvaluation,
  type JiraReason,
  type LinkDirection,
  type JiraLinkTypeIndication,
  type RouteDecision,
} from '../rules/jira-admission.js';

type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
/** One evaluated candidate: the fresh identity read by ID (key/url may have changed), the decision and the facts behind it. */
export type JiraCandidateEvaluation = {
  ticket: JiraTicketRef;
  evaluation: JiraEvaluation;
  observedAt: string;
  route: RouteDecision | null;
  /** The visible-blockers fact (spec §3.3): `null` when not reached (unreadable Ticket or label gone). */
  blockers: JiraBlockersObservation | null;
  /** Jira ticket 04: the component IDs read (null = not read or not complete), for the admission evidence. */
  components?: string[] | null;
};
export type JiraSourceEvaluation =
  | {
      kind: 'evaluated';
      siteId: string;
      projectId: string;
      observedAt: string;
      limitations: string[];
      candidates: JiraCandidateEvaluation[];
      /** Candidates left for the next poll after Jira asked to wait (429/5xx with Retry-After): never a tight loop. */
      deferred: JiraTicketRef[];
    }
  | { kind: 'unavailable'; siteId: string; projectId: string; listing: Extract<JiraCandidateObservation, { kind: 'unavailable' }> };

/** Upper bound of distinct blocker neighbours read for one Card; beyond it the blockers are unverifiable (never a partial list). */
const maxBlockerReads = 50;

/**
 * Whether ONE Jira Ticket may start now (spec §3 steps 1-3), from a fresh read by ID with the CURRENT source configuration: label, project,
 * components -> destination, links -> catalogue -> visible blockers' status category. Read-only: it creates no Work, comments nothing and
 * dispatches nothing. `catalogue` lets one evaluation round read the site's link types once.
 */
export async function evaluateJiraTicket(input: {
  tracker: JiraOriginTracker;
  source: JiraSource;
  authorizedRepositories: readonly string[];
  ticket: JiraTicketRef;
  catalogue?: () => Promise<JiraLinkTypesObservation>;
}): Promise<JiraCandidateEvaluation> {
  const { tracker, source } = input;
  const observation = await tracker.readTicket(input.ticket);
  if (observation.kind === 'unavailable') {
    return { ticket: input.ticket, evaluation: ticketUnverifiable(observation), observedAt: observation.observedAt, route: null, blockers: null };
  }
  const ticket = observation.ticket;
  if (observation.projectId !== source.projectId || !observation.labels.includes(source.label)) {
    return { ticket, evaluation: { decision: 'not-candidate', reasons: [] }, observedAt: observation.observedAt, route: null, blockers: null };
  }
  const route = routeTicket({
    components: observation.components?.map(item => item.id) ?? null,
    routes: source.routes,
    authorizedRepositories: input.authorizedRepositories,
  });
  const { links, blockers } = await visibleBlockers(
    tracker,
    ticket,
    observation.links,
    observation.observedAt,
    input.catalogue ?? (() => tracker.readLinkTypes(ticket.siteId)),
    source.linkTypes ?? [],
  );
  const evaluation = evaluateJiraCandidate({
    labelPresent: true,
    route,
    links,
    blockers: blockers.kind === 'observed' ? { kind: 'observed', blockers: blockers.blockers } : blockers,
  });
  return { ticket, evaluation, observedAt: observation.observedAt, route, blockers, components: observation.components?.map(item => item.id) ?? null };
}

async function visibleBlockers(
  tracker: JiraOriginTracker,
  root: JiraTicketRef,
  observed: Parameters<typeof blockerDirection>[0]['link'][] | null,
  readAt: string,
  catalogue: () => Promise<JiraLinkTypesObservation>,
  linkTypes: readonly JiraLinkTypeIndication[],
): Promise<{ links: LinkDirection[]; blockers: JiraBlockersObservation }> {
  const unavailable = (code: string, nextStep: string, observedAt: string, waitSeconds?: number): JiraUnavailable => ({
    kind: 'unavailable',
    source: 'jira-rest',
    observedAt,
    siteId: root.siteId,
    completeness: 'incomplete',
    code,
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    nextStep,
  });
  const limitations = ['Visible to the configured account only: an empty list is not global absence of blockers, nor an atomic snapshot.'];
  if (observed === null)
    return {
      links: [],
      blockers: unavailable('JIRA_LINKS_UNVERIFIABLE', "The Card's links were not read completely; the next poll reads them again.", readAt),
    };
  if (!observed.length)
    return { links: [], blockers: { kind: 'observed', source: 'jira-rest', observedAt: readAt, root, coverage: 'visible', blockers: [], limitations } };
  const types = await catalogue();
  if (types.kind === 'unavailable') return { links: [], blockers: types };
  const links = observed.map(link => blockerDirection({ catalogue: types.types, link, linkTypes }));
  const neighbours = [...new Set(links.flatMap(link => (link.kind === 'blocker' ? [link.issueId] : [])))];
  if (neighbours.length > maxBlockerReads) {
    return { links, blockers: unavailable('JIRA_BLOCKERS_TOO_MANY', `More than ${maxBlockerReads} visible blockers; nothing is concluded.`, types.observedAt) };
  }
  const blockers: JiraBlocker[] = [];
  let observedAt = types.observedAt > readAt ? types.observedAt : readAt;
  for (const issueId of neighbours) {
    const status = await tracker.readIssueStatus(root.siteId, issueId);
    if (status.kind === 'unavailable') return { links, blockers: status };
    blockers.push({ issueId, key: status.key, statusCategory: status.statusCategory });
    if (status.observedAt > observedAt) observedAt = status.observedAt;
  }
  return { links, blockers: { kind: 'observed', source: 'jira-rest', observedAt, root, coverage: 'visible', blockers, limitations } };
}

/**
 * Evaluation of a Jira source's candidates without admission (Jira ticket 03): one JQL listing over every page, then each candidate
 * re-read and decided with the current configuration. An incomplete listing evaluates nothing. When Jira asks to wait, the remaining
 * candidates are deferred to the next poll. Nothing is persisted, published or dispatched; ticket 04 admits from these decisions.
 */
export async function evaluateJiraSource(input: {
  tracker: JiraOriginTracker;
  source: JiraSource;
  authorizedRepositories: readonly string[];
}): Promise<JiraSourceEvaluation> {
  const { tracker, source } = input;
  const listing = await tracker.listCandidates({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: source.label });
  if (listing.kind === 'unavailable') return { kind: 'unavailable', siteId: source.siteId, projectId: source.projectId, listing };
  let types: Promise<JiraLinkTypesObservation> | undefined;
  const catalogue = () => (types ??= tracker.readLinkTypes(source.siteId));
  const candidates: JiraCandidateEvaluation[] = [];
  const deferred: JiraTicketRef[] = [];
  for (const ticket of listing.candidates) {
    if (candidates.some(item => item.evaluation.reasons.some(reason => reason.waitSeconds !== undefined))) {
      deferred.push(ticket);
      continue;
    }
    candidates.push(await evaluateJiraTicket({ ...input, ticket, catalogue }));
  }
  return {
    kind: 'evaluated',
    siteId: source.siteId,
    projectId: source.projectId,
    observedAt: listing.observedAt,
    limitations: listing.limitations,
    candidates,
    deferred,
  };
}

const visibleLimitation = 'Jira visible blockers: only what the configured account can see; an empty list is not global absence, nor an atomic snapshot.';
const browse = (root: JiraTicketRef, key: string) => `${new URL(root.url).origin}/browse/${key}`;
/** A Jira reason as a dependency reason of the Work (local view: the neighbour is named only in the controller's own records). */
const reasonOf = (root: JiraTicketRef) => (reason: JiraReason) => ({
  code: reason.code,
  nextStep: reason.nextStep,
  ...(reason.blocker ? { url: browse(root, reason.blocker.key) } : {}),
  ...(reason.observedCode ? { observedCode: reason.observedCode } : {}),
  ...(reason.waitSeconds !== undefined ? { waitSeconds: reason.waitSeconds } : {}),
});

/** Jira ticket 04: the dependency evaluation an eligible admission carries (its blockers were read just before the commit, all in Done). */
export function admittedJiraEvaluation(blockers: Extract<JiraBlockersObservation, { kind: 'observed' }>, attemptId: string): DependencyEvaluation {
  return {
    evaluationId: randomUUID(),
    attemptId,
    source: 'jira-rest',
    observedAt: blockers.observedAt,
    evaluatedAt: new Date().toISOString(),
    principals: [],
    completeness: 'complete',
    conclusion: 'satisfied',
    blockers: [],
    cycles: [],
    shared: [],
    reasons: [],
    limitations: [visibleLimitation],
    jira: { blockers: structuredClone(blockers.blockers) },
  };
}

/**
 * Jira ticket 04: ONE fresh read by ID of an admitted Jira Work's Card and the evaluation of its visible blockers for `attemptId` (polling
 * round or dispatch attempt). The destination is never recomputed; the fresh observation also carries the current key (presentation)
 * and the entry label (authorization, judged by the caller). An unreadable Card is inconclusive, never released.
 */
export async function evaluateJiraWork(input: {
  tracker: JiraOriginTracker;
  ticket: JiraTicketRef;
  attemptId: string;
  catalogue?: () => Promise<JiraLinkTypesObservation>;
  /** The operator's link type indications of the Card's site (spec §3.2); none = custom/ambiguous types need the operator. */
  linkTypes?: readonly JiraLinkTypeIndication[];
}): Promise<{ observation: JiraTicketObservation; evaluation: DependencyEvaluation }> {
  const { tracker, ticket, attemptId } = input;
  const base = {
    evaluationId: randomUUID(),
    attemptId,
    source: 'jira-rest' as const,
    principals: [],
    blockers: [],
    cycles: [],
    shared: [],
    limitations: [visibleLimitation],
  };
  let observation: JiraTicketObservation;
  try {
    observation = await tracker.readTicket(ticket);
  } catch {
    observation = {
      kind: 'unavailable',
      source: 'jira-rest',
      observedAt: new Date().toISOString(),
      siteId: ticket.siteId,
      completeness: 'incomplete',
      code: 'POLLING_QUERY_FAILED',
      nextStep: 'Unexpected failure while reading the Card; nothing is concluded. Inspect controller logs; polling retries with backoff.',
    };
  }
  if (observation.kind === 'unavailable') {
    return {
      observation,
      evaluation: {
        ...base,
        observedAt: observation.observedAt,
        evaluatedAt: new Date().toISOString(),
        completeness: 'incomplete',
        conclusion: 'inconclusive',
        reasons: ticketUnverifiable(observation).reasons.map(reasonOf(ticket)),
      },
    };
  }
  const fresh = observation.ticket;
  let links: LinkDirection[], blockers: JiraBlockersObservation;
  try {
    ({ links, blockers } = await visibleBlockers(
      tracker,
      fresh,
      observation.links,
      observation.observedAt,
      input.catalogue ?? (() => tracker.readLinkTypes(fresh.siteId)),
      input.linkTypes ?? [],
    ));
  } catch {
    links = [];
    blockers = {
      kind: 'unavailable',
      source: 'jira-rest',
      observedAt: new Date().toISOString(),
      siteId: fresh.siteId,
      completeness: 'incomplete',
      code: 'POLLING_QUERY_FAILED',
      nextStep: 'Unexpected failure while reading the visible blockers; nothing is concluded.',
    };
  }
  const result = jiraBlockersConclusion({ links, blockers: blockers.kind === 'observed' ? { kind: 'observed', blockers: blockers.blockers } : blockers });
  return {
    observation,
    evaluation: {
      ...base,
      observedAt: blockers.observedAt,
      evaluatedAt: new Date().toISOString(),
      completeness: result.completeness,
      conclusion: result.conclusion,
      reasons: result.reasons.map(reasonOf(fresh)),
      ...(blockers.kind === 'observed' ? { jira: { blockers: structuredClone(blockers.blockers) } } : {}),
    },
  };
}

/** The operator's link type indications of a site (validated identical on every source of the site); none when no source names it. */
export function jiraLinkTypesOf(access: Pick<AccessDependencies, 'sources'>, siteId: string): readonly JiraLinkTypeIndication[] {
  return access.sources?.find((source): source is JiraSource => source.tracker === 'jira' && source.siteId === siteId)?.linkTypes ?? [];
}

/** Jira ticket 04: the ORIGIN source of a Jira Work (site + project recorded at admission) in the configuration in force; undefined when gone. */
export function jiraSourceOf(access: Pick<AccessDependencies, 'sources'>, work: Pick<WorkRecord, 'ticket' | 'authorization'>): JiraSource | undefined {
  if (work.ticket.tracker !== 'jira' || work.authorization.source !== 'jira-rest') return undefined;
  const { siteId } = work.ticket,
    { projectId } = work.authorization.basis;
  return access.sources?.find((source): source is JiraSource => source.tracker === 'jira' && source.siteId === siteId && source.projectId === projectId);
}
const notComposed = (siteId: string): JiraUnavailable => ({
  kind: 'unavailable',
  source: 'jira-rest',
  observedAt: new Date().toISOString(),
  siteId,
  completeness: 'incomplete',
  code: 'JIRA_TRACKER_NOT_COMPOSED',
  nextStep: 'This installation has no Jira adapter composed; nothing is read from the Card.',
});
const failedRead = (siteId: string): JiraUnavailable => ({
  kind: 'unavailable',
  source: 'jira-rest',
  observedAt: new Date().toISOString(),
  siteId,
  completeness: 'incomplete',
  code: 'POLLING_QUERY_FAILED',
  nextStep: 'Unexpected failure while reading the Card; nothing is concluded.',
});

/** Jira ticket 04: one complete re-read by ID of a Jira Work's Card and what it concludes about its authorization (origin label). */
export async function observeJiraAuthorization(access: Pick<AccessDependencies, 'sources' | 'trackers'>, work: Pick<WorkRecord, 'ticket' | 'authorization'>) {
  if (work.ticket.tracker !== 'jira') throw new Error('TICKET_ORIGIN_NOT_JIRA');
  const tracker = access.trackers?.jira;
  const observation: JiraTicketObservation = !tracker
    ? notComposed(work.ticket.siteId)
    : await tracker.readTicket(work.ticket).catch(() => failedRead((work.ticket as JiraTicketRef).siteId));
  const source = jiraSourceOf(access, work);
  return { observation, facts: jiraAuthorizationFacts({ source, observation }) };
}

/** Jira ticket 04: {@link evaluateJiraWork} through the composed adapter; without one the evaluation is inconclusive (never released). */
export async function evaluateJiraWorkOf(access: Pick<AccessDependencies, 'trackers' | 'sources'>, ticket: JiraTicketRef, attemptId: string) {
  const tracker = access.trackers?.jira;
  if (tracker) return evaluateJiraWork({ tracker, ticket, attemptId, linkTypes: jiraLinkTypesOf(access, ticket.siteId) });
  const observation = notComposed(ticket.siteId);
  const evaluation: DependencyEvaluation = {
    evaluationId: randomUUID(),
    attemptId,
    source: 'jira-rest',
    observedAt: observation.observedAt,
    evaluatedAt: new Date().toISOString(),
    principals: [],
    completeness: 'incomplete',
    conclusion: 'inconclusive',
    blockers: [],
    cycles: [],
    shared: [],
    limitations: [visibleLimitation],
    reasons: ticketUnverifiable(observation).reasons.map(reasonOf(ticket)),
  };
  return { observation, evaluation };
}

/** Jira ticket 04 (agent context): the Card's text for the Builder, read by the controller with its own adapter. */
export async function readJiraContent(
  access: Pick<AccessDependencies, 'trackers'>,
  ticket: JiraTicketRef,
): Promise<{ kind: 'observed'; content: TicketContent } | { kind: 'unavailable'; code: string }> {
  const tracker = access.trackers?.jira;
  if (!tracker) return { kind: 'unavailable', code: 'JIRA_TRACKER_NOT_COMPOSED' };
  const read = await tracker.readTicketContent(ticket).catch(() => failedRead(ticket.siteId));
  if (read.kind !== 'observed') return { kind: 'unavailable', code: read.code };
  const sha256 = createHash('sha256')
    .update(JSON.stringify([read.summary, read.description]))
    .digest('hex');
  return {
    kind: 'observed',
    content: {
      source: 'jira-rest',
      key: read.ticket.key,
      url: read.ticket.url,
      observedAt: read.observedAt,
      summary: read.summary,
      description: read.description,
      truncated: read.truncated,
      sha256,
    },
  };
}
