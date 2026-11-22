import type { JiraBlockersObservation, JiraCandidateObservation, JiraLinkTypesObservation, JiraTicketRef, JiraUnavailable } from '../../issue-tracker/index.js';
import type { JiraOriginTracker, TicketSource } from '../types.js';
import { blockerDirection, evaluateJiraCandidate, routeTicket, ticketUnverifiable, type JiraEvaluation, type LinkDirection, type RouteDecision } from '../rules/jira-admission.js';

type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
/** One evaluated candidate: the fresh identity read by ID (key/url may have changed), the decision and the facts behind it. */
export type JiraCandidateEvaluation = { ticket: JiraTicketRef; evaluation: JiraEvaluation; observedAt: string; route: RouteDecision | null;
  /** The visible-blockers fact (spec §3.3): `null` when not reached (unreadable Ticket or label gone). */
  blockers: JiraBlockersObservation | null };
export type JiraSourceEvaluation = { kind: 'evaluated'; siteId: string; projectId: string; observedAt: string; limitations: string[];
  candidates: JiraCandidateEvaluation[];
  /** Candidates left for the next poll after Jira asked to wait (429/5xx with Retry-After): never a tight loop. */
  deferred: JiraTicketRef[] } |
  { kind: 'unavailable'; siteId: string; projectId: string; listing: Extract<JiraCandidateObservation, { kind: 'unavailable' }> };

/** Upper bound of distinct blocker neighbours read for one Card; beyond it the blockers are unverifiable (never a partial list). */
const maxBlockerReads = 50;

/**
 * Whether ONE Jira Ticket may start now (spec §3 steps 1-3), from a fresh read by ID with the CURRENT source configuration: label, project,
 * components -> destination, links -> catalogue -> visible blockers' status category. Read-only: it creates no Work, comments nothing and
 * dispatches nothing. `catalogue` lets one evaluation round read the site's link types once.
 */
export async function evaluateJiraTicket(input: { tracker: JiraOriginTracker; source: JiraSource; authorizedRepositories: readonly string[]; ticket: JiraTicketRef;
  catalogue?: () => Promise<JiraLinkTypesObservation> }): Promise<JiraCandidateEvaluation> {
  const { tracker, source } = input;
  const observation = await tracker.readTicket(input.ticket);
  if (observation.kind === 'unavailable') {
    return { ticket: input.ticket, evaluation: ticketUnverifiable(observation), observedAt: observation.observedAt, route: null, blockers: null };
  }
  const ticket = observation.ticket;
  if (observation.projectId !== source.projectId || !observation.labels.includes(source.label)) {
    return { ticket, evaluation: { decision: 'not-candidate', reasons: [] }, observedAt: observation.observedAt, route: null, blockers: null };
  }
  const route = routeTicket({ components: observation.components?.map(item => item.id) ?? null, routes: source.routes, authorizedRepositories: input.authorizedRepositories });
  const { links, blockers } = await visibleBlockers(tracker, ticket, observation.links, observation.observedAt, input.catalogue ?? (() => tracker.readLinkTypes(ticket.siteId)));
  const evaluation = evaluateJiraCandidate({ labelPresent: true, route, links,
    blockers: blockers.kind === 'observed' ? { kind: 'observed', blockers: blockers.blockers } : blockers });
  return { ticket, evaluation, observedAt: observation.observedAt, route, blockers };
}

async function visibleBlockers(tracker: JiraOriginTracker, root: JiraTicketRef, observed: Parameters<typeof blockerDirection>[0]['link'][] | null, readAt: string,
  catalogue: () => Promise<JiraLinkTypesObservation>): Promise<{ links: LinkDirection[]; blockers: JiraBlockersObservation }> {
  const unavailable = (code: string, nextStep: string, observedAt: string, waitSeconds?: number): JiraUnavailable => ({ kind: 'unavailable', source: 'jira-rest', observedAt,
    siteId: root.siteId, completeness: 'incomplete', code, ...(waitSeconds !== undefined ? { waitSeconds } : {}), nextStep });
  const limitations = ['Visible to the configured account only: an empty list is not global absence of blockers, nor an atomic snapshot.'];
  if (observed === null) return { links: [], blockers: unavailable('JIRA_LINKS_UNVERIFIABLE', 'The Card\'s links were not read completely; the next poll reads them again.', readAt) };
  if (!observed.length) return { links: [], blockers: { kind: 'observed', source: 'jira-rest', observedAt: readAt, root, coverage: 'visible', blockers: [], limitations } };
  const types = await catalogue();
  if (types.kind === 'unavailable') return { links: [], blockers: types };
  const links = observed.map(link => blockerDirection({ catalogue: types.types, link }));
  const neighbours = [...new Set(links.flatMap(link => link.kind === 'blocker' ? [link.issueId] : []))];
  if (neighbours.length > maxBlockerReads) {
    return { links, blockers: unavailable('JIRA_BLOCKERS_TOO_MANY', `More than ${maxBlockerReads} visible blockers; nothing is concluded.`, types.observedAt) };
  }
  const blockers: { issueId: string; key: string; statusCategory: string }[] = [];
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
export async function evaluateJiraSource(input: { tracker: JiraOriginTracker; source: JiraSource; authorizedRepositories: readonly string[] }): Promise<JiraSourceEvaluation> {
  const { tracker, source } = input;
  const listing = await tracker.listCandidates({ tracker: 'jira', siteId: source.siteId, url: source.url, projectId: source.projectId, label: source.label });
  if (listing.kind === 'unavailable') return { kind: 'unavailable', siteId: source.siteId, projectId: source.projectId, listing };
  let types: Promise<JiraLinkTypesObservation> | undefined;
  const catalogue = () => types ??= tracker.readLinkTypes(source.siteId);
  const candidates: JiraCandidateEvaluation[] = [];
  const deferred: JiraTicketRef[] = [];
  for (const ticket of listing.candidates) {
    if (candidates.some(item => item.evaluation.reasons.some(reason => reason.waitSeconds !== undefined))) { deferred.push(ticket); continue; }
    candidates.push(await evaluateJiraTicket({ ...input, ticket, catalogue }));
  }
  return { kind: 'evaluated', siteId: source.siteId, projectId: source.projectId, observedAt: listing.observedAt, limitations: listing.limitations, candidates, deferred };
}
