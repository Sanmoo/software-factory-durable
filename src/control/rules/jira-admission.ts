// Jira ticket 03 (spec §3 steps 1-3): pure rules deciding whether a Jira candidate may start. No I/O, clock, storage or Jira types:
// callers pass the observed facts. A decision here never creates Work, comments or dispatches.

export type RouteDecision = { kind: 'single'; repository: string } | { kind: 'none' } | { kind: 'divergent'; repositories: string[] } | { kind: 'unverifiable' };

/**
 * Destination of a Jira Ticket from its CURRENT component IDs (`null` = the list was not read completely). The distinct authorized
 * repositories routed by its components: one = the destination; zero or several = no Work. An unrouted component is ignored; a partial
 * list is never "zero routes".
 */
export function routeTicket(input: { components: readonly string[] | null; routes: readonly { componentId: string; repository: string }[];
  authorizedRepositories: readonly string[] }): RouteDecision {
  if (input.components === null) return { kind: 'unverifiable' };
  const authorized = new Set(input.authorizedRepositories.map(name => name.toLowerCase()));
  const destinations = new Map<string, string>();
  for (const route of input.routes) {
    if (input.components.includes(route.componentId) && authorized.has(route.repository.toLowerCase())) destinations.set(route.repository.toLowerCase(), route.repository);
  }
  const repositories = [...destinations.values()].sort();
  if (repositories.length === 0) return { kind: 'none' };
  return repositories.length === 1 ? { kind: 'single', repository: repositories[0]! } : { kind: 'divergent', repositories };
}

/** One entry of the site's issue link type catalogue (`GET /rest/api/3/issueLinkType`). Labels are editable by the site administrator. */
export type JiraLinkType = { id: string; name: string; inward: string; outward: string };
/** A link observed on the root Ticket: `end: 'inward'` = the neighbour came as `inwardIssue` (read with `type.inward`). */
export type JiraLinkFact = { linkId: string; type: JiraLinkType; end: 'inward' | 'outward'; issue: { issueId: string; key: string } };
export type LinkDirection = { kind: 'blocker'; issueId: string; key: string } | { kind: 'not-blocker' } |
  { kind: 'needs-operator'; code: 'JIRA_LINK_TYPE_CUSTOM' | 'JIRA_LINK_DIRECTION_AMBIGUOUS'; linkId: string } |
  { kind: 'unverifiable'; code: 'JIRA_LINK_TYPE_INCONSISTENT'; linkId: string };

const standardBlocks = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
/** Jira's built-in link types that never mean blocking, with their default labels (an edited label makes them custom). */
const standardNonBlocking = [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }, { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  { name: 'Cloners', inward: 'is cloned by', outward: 'clones' }, { name: 'Issue split', inward: 'split from', outward: 'split to' },
  { name: 'Polaris work item link', inward: 'is implemented by', outward: 'implements' }];
const same = (a: { name: string; inward: string; outward: string }, b: { name: string; inward: string; outward: string }) =>
  a.name === b.name && a.inward === b.inward && a.outward === b.outward;

/**
 * Meaning of one observed link for the root Ticket, judged by the site catalogue, never by searching the word "blocks": the type must be
 * the catalogue's single `Blocks` with its default labels; then the `inwardIssue` neighbour ("is blocked by") blocks the root and the
 * `outwardIssue` one is blocked by it. A custom type, a second `Blocks` or edited labels need the operator; a link whose type is absent
 * from the catalogue or differs from it is unverifiable.
 */
export function blockerDirection(input: { catalogue: readonly JiraLinkType[]; link: JiraLinkFact }): LinkDirection {
  const { link } = input;
  const listed = input.catalogue.find(type => type.id === link.type.id);
  if (!listed || !same(listed, link.type)) return { kind: 'unverifiable', code: 'JIRA_LINK_TYPE_INCONSISTENT', linkId: link.linkId };
  const blockLike = (type: JiraLinkType) => type.name === standardBlocks.name || [type.name, type.inward, type.outward].some(text => /block|bloque/i.test(text));
  if (blockLike(listed)) {
    const blocksTypes = input.catalogue.filter(blockLike);
    if (blocksTypes.length !== 1 || !same(listed, standardBlocks)) return { kind: 'needs-operator', code: 'JIRA_LINK_DIRECTION_AMBIGUOUS', linkId: link.linkId };
    return link.end === 'inward' ? { kind: 'blocker', issueId: link.issue.issueId, key: link.issue.key } : { kind: 'not-blocker' };
  }
  return standardNonBlocking.some(type => same(type, listed)) ? { kind: 'not-blocker' } : { kind: 'needs-operator', code: 'JIRA_LINK_TYPE_CUSTOM', linkId: link.linkId };
}

/** Status category of each neighbour classified as blocker, read by ID; or why that could not be done (never an empty list). */
export type JiraBlockerFacts = { kind: 'observed'; blockers: readonly { issueId: string; key: string; statusCategory: string }[] } |
  { kind: 'unavailable'; code: string; waitSeconds?: number; nextStep: string };
export type JiraReasonCode = 'JIRA_ROUTE_NONE' | 'JIRA_ROUTE_DIVERGENT' | 'JIRA_BLOCKER_NOT_DONE' | 'JIRA_LINK_TYPE_CUSTOM' | 'JIRA_LINK_DIRECTION_AMBIGUOUS' |
  'JIRA_COMPONENTS_UNVERIFIABLE' | 'JIRA_BLOCKERS_UNVERIFIABLE' | 'JIRA_LINK_TYPE_INCONSISTENT' | 'JIRA_TICKET_UNVERIFIABLE';
/**
 * One reason a Jira candidate may not start. `nextStep` is safe to show to whoever marked the Card: it never names a neighbour (which may
 * belong to a restricted project). `blocker`, `linkId` and `observedCode` are local diagnosis only.
 */
export type JiraReason = { code: JiraReasonCode; nextStep: string; repositories?: string[]; blocker?: { issueId: string; key: string }; linkId?: string;
  observedCode?: string; waitSeconds?: number };
export type JiraEvaluation = { decision: 'eligible'; repository: string; reasons: [] } | { decision: 'blocked' | 'unverifiable'; reasons: JiraReason[] } |
  /** The entry label is gone, or the Card left the source project: no Work and no comment. */
  { decision: 'not-candidate'; reasons: [] };

const unverifiableCodes: ReadonlySet<JiraReasonCode> = new Set(['JIRA_COMPONENTS_UNVERIFIABLE', 'JIRA_BLOCKERS_UNVERIFIABLE', 'JIRA_LINK_TYPE_INCONSISTENT', 'JIRA_TICKET_UNVERIFIABLE']);

/**
 * Whether a re-read Jira candidate may start (spec §3 steps 1-3). Label absent = not a candidate. Otherwise every reason is collected: any
 * known impediment (no or divergent destination, a visible blocker not in the Done category, a link that needs the operator) = blocked;
 * only facts that could not be verified = unverifiable; none = eligible for its single destination. A failure never releases.
 */
export function evaluateJiraCandidate(input: { labelPresent: boolean; route: RouteDecision; links: readonly LinkDirection[]; blockers: JiraBlockerFacts }): JiraEvaluation {
  if (!input.labelPresent) return { decision: 'not-candidate', reasons: [] };
  const reasons: JiraReason[] = [];
  const { route } = input;
  if (route.kind === 'none') reasons.push({ code: 'JIRA_ROUTE_NONE', nextStep: 'No component of the Card routes to an authorized repository; set one routed component or adjust the routes.' });
  if (route.kind === 'divergent') reasons.push({ code: 'JIRA_ROUTE_DIVERGENT', repositories: route.repositories,
    nextStep: `The Card's components route to different repositories (${route.repositories.join(', ')}); keep components that route to one repository.` });
  if (route.kind === 'unverifiable') reasons.push({ code: 'JIRA_COMPONENTS_UNVERIFIABLE', nextStep: 'The component list could not be read completely; nothing is concluded, the next poll reads it again.' });
  for (const link of input.links) {
    if (link.kind === 'needs-operator') reasons.push({ code: link.code, linkId: link.linkId, nextStep: link.code === 'JIRA_LINK_TYPE_CUSTOM'
      ? 'The Card has a custom link type whose blocking meaning is unknown; the operator must remove the link or confirm it does not block.'
      : 'The site\'s Blocks link type is edited or duplicated, so its direction is ambiguous; the operator must restore the Blocks type or remove the link.' });
    if (link.kind === 'unverifiable') reasons.push({ code: link.code, linkId: link.linkId,
      nextStep: 'A link of the Card disagrees with the site\'s link type catalogue; nothing is concluded, the next poll reads it again.' });
  }
  const facts = input.blockers;
  if (facts.kind === 'unavailable') reasons.push({ code: 'JIRA_BLOCKERS_UNVERIFIABLE', observedCode: facts.code, ...(facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
    nextStep: `The visible blockers could not be verified (${facts.code}); this never releases the Card. ${facts.nextStep}` });
  else for (const blocker of facts.blockers) {
    if (blocker.statusCategory !== 'done') reasons.push({ code: 'JIRA_BLOCKER_NOT_DONE', blocker: { issueId: blocker.issueId, key: blocker.key },
      nextStep: 'A visible blocker of the Card is not in a Done status category; finish it or remove the "is blocked by" link.' });
  }
  if (!reasons.length && route.kind === 'single') return { decision: 'eligible', repository: route.repository, reasons: [] };
  return { decision: reasons.some(reason => !unverifiableCodes.has(reason.code)) ? 'blocked' : 'unverifiable', reasons };
}

/** The Ticket itself could not be re-read by ID: nothing is concluded (local diagnosis only; intent is unknown, so no comment). */
export function ticketUnverifiable(facts: { code: string; waitSeconds?: number; nextStep: string }): JiraEvaluation {
  return { decision: 'unverifiable', reasons: [{ code: 'JIRA_TICKET_UNVERIFIABLE', observedCode: facts.code, ...(facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
    nextStep: `The Card could not be re-read (${facts.code}); nothing is concluded. ${facts.nextStep}` }] };
}
