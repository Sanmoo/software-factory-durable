// Jira ticket 04: an in-memory Jira site behind the Jira tracker contract (JiraOriginTracker). Every call is recorded, unexpected ones
// included (a Proxy records any method not modelled and answers unavailable), so a test can assert absence of comments/writes.
import {
  jiraInputsOf,
  type JiraLink,
  type JiraLinkType,
  type JiraStatusCategory,
  type JiraTicketRef,
  type JiraVisibleComment,
} from '../../src/issue-tracker/index.js';
import type { JiraOriginTracker, TicketSource } from '../../src/control/types.js';

export const site = { siteId: 'site-A', url: 'https://equipe.atlassian.net' };
export const blocksType: JiraLinkType = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
export type JiraCard = {
  issueId: string;
  key: string;
  projectId: string;
  labels: string[];
  components: string[] | null;
  links: JiraLink[] | null;
  statusCategory: JiraStatusCategory;
  summary: string | null;
  description?: string | null;
};
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
  /** Jira ticket 06: outcome of the next comment POSTs (default ok): `lost-created` = created, answer lost; `lost-not-created` = not created, unknown. */
  postOutcomes?: ('ok' | 'lost-created' | 'lost-not-created')[];
  /** Comment listings (inputs and reconciliation) answer unavailable while set. */
  commentsFailure?: string;
  /** Inputs ignore the cursor (a re-delivery of every comment, as after a lost cursor). */
  redeliver?: boolean;
  /** Jira ticket 08: outcomes of the next remote link upserts (default applied). `lost`: Jira applies it but the answer is lost (unknown). */
  linkOutcomes?: ('applied' | 'lost' | 'down')[];
  /** Jira ticket 09: outcomes of the next comment POSTs (default published). `lost`: created, answer lost; `twice`: two copies created, answer lost. */
  commentOutcomes?: ('published' | 'lost' | 'down' | 'twice')[];
  /** Jira ticket 09: the whole site is unreachable for comments, links and the account read (listing via `listFailure`). */
  down?: boolean;
};
export const jiraSource = (overrides: Partial<Extract<TicketSource, { tracker: 'jira' }>> = {}): Extract<TicketSource, { tracker: 'jira' }> => ({
  tracker: 'jira',
  siteId: site.siteId,
  url: site.url,
  projectId: '10010',
  label: 'factory-ready',
  discover: true,
  routes: [
    { componentId: '10022', repository: 'acme/project' },
    { componentId: '10021', repository: 'acme/other' },
  ],
  ...overrides,
});
export const card = (issueId: string, key: string, overrides: Partial<JiraCard> = {}): JiraCard => ({
  issueId,
  key,
  projectId: '10010',
  labels: ['factory-ready'],
  components: ['10022'],
  links: [],
  statusCategory: 'new',
  summary: `Summary ${key}`,
  ...overrides,
});
export const refOf = (item: Pick<JiraCard, 'issueId' | 'key'>): JiraTicketRef => ({
  tracker: 'jira',
  siteId: site.siteId,
  issueId: item.issueId,
  key: item.key,
  url: `${site.url}/browse/${item.key}`,
});
export const blockedBy = (linkId: string, issueId: string, key: string): JiraLink => ({ linkId, type: blocksType, end: 'inward', issue: { issueId, key } });

export function jiraDoubles(remote: JiraRemote) {
  const calls: { method: string; args?: unknown }[] = [];
  const observedAt = () => new Date().toISOString();
  const unavailable = (code: string, waitSeconds?: number) => ({
    kind: 'unavailable' as const,
    source: 'jira-rest' as const,
    observedAt: observedAt(),
    siteId: site.siteId,
    completeness: 'incomplete' as const,
    code,
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    nextStep: `synthetic ${code}`,
  });
  // Ticket 05's impediment notices: comments the Factory account posts on a Card (the only write the doubles model).
  const comments: Record<string, JiraVisibleComment[]> = {};
  let commentSequence = 10040;
  // Jira ticket 08: the remote links of each Card by globalId, as Jira keeps them (an upsert by globalId never makes a second one).
  const links: Record<string, Record<string, { url: string; title: string; id: string }>> = {};
  let linkSequence = 20000;
  const find = (issueId: string) => remote.cards.find(item => item.issueId === issueId);
  const modelled: Partial<JiraOriginTracker> = {
    listCandidates: async scope => {
      calls.push({ method: 'listCandidates', args: scope });
      if (remote.listFailure) return unavailable(remote.listFailure.code, remote.listFailure.waitSeconds);
      const candidates = remote.listed ?? remote.cards.filter(item => item.projectId === scope.projectId && item.labels.includes(scope.label)).map(refOf);
      remote.afterListing?.();
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: observedAt(),
        siteId: scope.siteId,
        projectId: scope.projectId,
        label: scope.label,
        completeness: 'complete',
        candidates: structuredClone(candidates),
        limitations: ['synthetic'],
      };
    },
    readTicket: async ticket => {
      calls.push({ method: 'readTicket', args: ticket.issueId });
      const failure = remote.readFailures?.[ticket.issueId];
      if (failure) return unavailable(failure);
      const found = find(ticket.issueId);
      if (!found) return unavailable('JIRA_NOT_FOUND');
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: observedAt(),
        completeness: 'complete',
        ticket: refOf(found),
        projectId: found.projectId,
        labels: [...found.labels],
        components: found.components?.map(id => ({ id, name: `c${id}` })) ?? null,
        statusCategory: found.statusCategory,
        summary: found.summary,
        links: found.links ? structuredClone(found.links) : null,
      };
    },
    readTicketContent: async ticket => {
      calls.push({ method: 'readTicketContent', args: ticket.issueId });
      const found = find(ticket.issueId);
      if (!found) return unavailable('JIRA_NOT_FOUND');
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: observedAt(),
        ticket: refOf(found),
        summary: found.summary,
        description: found.description ?? null,
        truncated: false,
      };
    },
    publishComment: async (ticket, comment) => {
      calls.push({ method: 'publishComment', args: { issueId: ticket.issueId, lines: comment.lines } });
      const outcome = remote.down ? 'down' : (remote.commentOutcomes?.shift() ?? 'published');
      if (outcome === 'down') return { kind: 'unknown', observedAt: observedAt(), code: 'JIRA_UNAVAILABLE', nextStep: 'synthetic' };
      const posted = remote.postOutcomes?.shift() ?? 'ok';
      if (posted === 'lost-not-created') return { kind: 'unknown', observedAt: observedAt(), code: 'JIRA_TIMEOUT', nextStep: 'synthetic lost answer' };
      const commentId = String((commentSequence += 1)),
        at = observedAt();
      (comments[ticket.issueId] ??= []).push({
        commentId,
        authorAccountId: 'acc-factory',
        text: comment.lines.join('\n'),
        createdAt: at,
        updatedAt: at,
        restricted: false,
      });
      if (outcome === 'twice') {
        const copy = String((commentSequence += 1));
        comments[ticket.issueId]!.push({
          commentId: copy,
          authorAccountId: 'acc-factory',
          text: comment.lines.join('\n'),
          createdAt: at,
          updatedAt: at,
          restricted: false,
        });
      }
      if (outcome !== 'published' || posted === 'lost-created')
        return { kind: 'unknown', observedAt: at, code: 'JIRA_TIMEOUT', nextStep: 'synthetic lost answer' };
      return {
        kind: 'published',
        observedAt: at,
        commentId,
        createdAt: at,
        authorAccountId: 'acc-factory',
        url: `${ticket.url}?focusedCommentId=${commentId}`,
      };
    },
    listComments: async ticket => {
      calls.push({ method: 'listComments', args: ticket.issueId });
      if (remote.down) return unavailable('JIRA_UNAVAILABLE');
      if (remote.commentsFailure) return unavailable(remote.commentsFailure);
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: observedAt(),
        siteId: site.siteId,
        issueId: ticket.issueId,
        completeness: 'complete',
        comments: [...(comments[ticket.issueId] ?? [])],
        limitations: [],
      };
    },
    readInputs: async (ticket, cursor) => {
      calls.push({ method: 'readInputs', args: ticket.issueId });
      const listing =
        remote.down || remote.commentsFailure
          ? unavailable(remote.commentsFailure ?? 'JIRA_UNAVAILABLE')
          : {
              kind: 'observed' as const,
              source: 'jira-rest' as const,
              observedAt: observedAt(),
              siteId: site.siteId,
              issueId: ticket.issueId,
              completeness: 'complete' as const,
              comments: structuredClone(comments[ticket.issueId] ?? []),
              limitations: [],
            };
      return jiraInputsOf(ticket, listing, remote.redeliver ? null : cursor);
    },
    readAccount: async siteId => {
      calls.push({ method: 'readAccount' });
      if (remote.down) return unavailable('JIRA_UNAVAILABLE');
      return { kind: 'observed', source: 'jira-rest', observedAt: observedAt(), siteId, accountId: 'acc-factory' };
    },
    upsertRemoteLink: async (ticket, link) => {
      calls.push({ method: 'upsertRemoteLink', args: { issueId: ticket.issueId, ...link } });
      const outcome = remote.down ? 'down' : (remote.linkOutcomes?.shift() ?? 'applied');
      if (outcome === 'down') return { kind: 'unknown', observedAt: observedAt(), code: 'JIRA_UNAVAILABLE', nextStep: 'synthetic' };
      const card = (links[ticket.issueId] ??= {});
      const id = card[link.globalId]?.id ?? String((linkSequence += 1));
      card[link.globalId] = { url: link.url, title: link.title, id };
      return outcome === 'lost'
        ? { kind: 'unknown', observedAt: observedAt(), code: 'JIRA_TIMEOUT', nextStep: 'synthetic' }
        : { kind: 'applied', observedAt: observedAt(), linkId: id };
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
      return async (...args: unknown[]) => {
        calls.push({ method: `unexpected:${name}`, args });
        return unavailable('JIRA_CAPABILITY_NOT_AVAILABLE');
      };
    },
  }) as JiraOriginTracker;
  /** Jira ticket 06: a comment written on the Card by `accountId` (the Factory's shared account by default), a second after now. */
  /** `accountId: null`: Jira gave no author; `text: null`: the body was not a valid ADF document. */
  const write = (issueId: string, text: string | null, options: { accountId?: string | null; edited?: boolean; restricted?: boolean } = {}) => {
    const commentId = String((commentSequence += 1));
    const created = new Date(Date.now() + 1000).toISOString();
    (comments[issueId] ??= []).push({
      commentId,
      authorAccountId: options.accountId === undefined ? 'acc-factory' : options.accountId,
      text,
      createdAt: created,
      updatedAt: options.edited ? new Date(Date.now() + 2000).toISOString() : created,
      restricted: Boolean(options.restricted),
    });
    return commentId;
  };
  return { tracker, calls, comments, write, links, methods: () => calls.map(call => call.method) };
}
