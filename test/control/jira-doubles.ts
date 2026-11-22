// Jira ticket 04: an in-memory Jira site behind the Jira tracker contract (JiraOriginTracker). Every call is recorded, unexpected ones
// included (a Proxy records any method not modelled and answers unavailable), so a test can assert absence of comments/writes.
import type { JiraLink, JiraLinkType, JiraTicketRef } from '../../src/issue-tracker/index.js';
import type { JiraOriginTracker, TicketSource } from '../../src/control/types.js';

export const site = { siteId: 'site-A', url: 'https://equipe.atlassian.net' };
export const blocksType: JiraLinkType = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
export type JiraCard = { issueId: string; key: string; projectId: string; labels: string[]; components: string[] | null; links: JiraLink[] | null;
  statusCategory: string; summary: string | null; description?: string | null };
export type JiraRemote = {
  cards: JiraCard[];
  /** What the listing returns (refs as listed then); absent = the cards carrying the label now. */
  listed?: JiraTicketRef[];
  catalogue?: JiraLinkType[];
  listFailure?: { code: string; waitSeconds?: number };
  /** Per issue id: the re-read fails with this code. */
  readFailures?: Record<string, string>;
  /** Called after the listing, before any re-read (models an edit between discovery and admission). */
  afterListing?: () => void;
};
export const jiraSource = (overrides: Partial<Extract<TicketSource, { tracker: 'jira' }>> = {}): Extract<TicketSource, { tracker: 'jira' }> => ({
  tracker: 'jira', siteId: site.siteId, url: site.url, projectId: '10010', label: 'factory-ready', discover: true,
  routes: [{ componentId: '10022', repository: 'acme/project' }, { componentId: '10021', repository: 'acme/other' }], ...overrides });
export const card = (issueId: string, key: string, overrides: Partial<JiraCard> = {}): JiraCard => ({ issueId, key, projectId: '10010', labels: ['factory-ready'],
  components: ['10022'], links: [], statusCategory: 'new', summary: `Summary ${key}`, ...overrides });
export const refOf = (item: Pick<JiraCard, 'issueId' | 'key'>): JiraTicketRef => ({ tracker: 'jira', siteId: site.siteId, issueId: item.issueId, key: item.key,
  url: `${site.url}/browse/${item.key}` });
export const blockedBy = (linkId: string, issueId: string, key: string): JiraLink => ({ linkId, type: blocksType, end: 'inward', issue: { issueId, key } });

export function jiraDoubles(remote: JiraRemote) {
  const calls: { method: string; args?: unknown }[] = [];
  const observedAt = () => new Date().toISOString();
  const unavailable = (code: string, waitSeconds?: number) => ({ kind: 'unavailable' as const, source: 'jira-rest' as const, observedAt: observedAt(), siteId: site.siteId,
    completeness: 'incomplete' as const, code, ...(waitSeconds !== undefined ? { waitSeconds } : {}), nextStep: `synthetic ${code}` });
  const find = (issueId: string) => remote.cards.find(item => item.issueId === issueId);
  const modelled: Partial<JiraOriginTracker> = {
    listCandidates: async scope => {
      calls.push({ method: 'listCandidates', args: scope });
      if (remote.listFailure) return unavailable(remote.listFailure.code, remote.listFailure.waitSeconds);
      const candidates = remote.listed ?? remote.cards.filter(item => item.projectId === scope.projectId && item.labels.includes(scope.label)).map(refOf);
      remote.afterListing?.();
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), siteId: scope.siteId, projectId: scope.projectId, label: scope.label, completeness: 'complete',
        candidates: structuredClone(candidates), limitations: ['synthetic'] };
    },
    readTicket: async ticket => {
      calls.push({ method: 'readTicket', args: ticket.issueId });
      const failure = remote.readFailures?.[ticket.issueId];
      if (failure) return unavailable(failure);
      const found = find(ticket.issueId);
      if (!found) return unavailable('JIRA_NOT_FOUND');
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), completeness: 'complete', ticket: refOf(found), projectId: found.projectId,
        labels: [...found.labels], components: found.components?.map(id => ({ id, name: `c${id}` })) ?? null, statusCategory: found.statusCategory,
        summary: found.summary, links: found.links ? structuredClone(found.links) : null };
    },
    readTicketContent: async ticket => {
      calls.push({ method: 'readTicketContent', args: ticket.issueId });
      const found = find(ticket.issueId);
      if (!found) return unavailable('JIRA_NOT_FOUND');
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), ticket: refOf(found), summary: found.summary, description: found.description ?? null, truncated: false };
    },
    readLinkTypes: async siteId => {
      calls.push({ method: 'readLinkTypes', args: siteId });
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), siteId, types: structuredClone(remote.catalogue ?? [blocksType]) };
    },
    readIssueStatus: async (siteId, issueId) => {
      calls.push({ method: 'readIssueStatus', args: issueId });
      const found = find(issueId);
      if (!found) return unavailable('JIRA_NOT_FOUND');
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), siteId, issueId, key: found.key, statusCategory: found.statusCategory };
    },
  };
  const tracker = new Proxy(modelled, {
    get(target, name: string) {
      if (name in target) return target[name as keyof typeof target];
      if (name === 'then') return undefined;
      return async (...args: unknown[]) => { calls.push({ method: `unexpected:${name}`, args }); return unavailable('JIRA_CAPABILITY_NOT_AVAILABLE'); };
    },
  }) as JiraOriginTracker;
  return { tracker, calls, methods: () => calls.map(call => call.method) };
}
