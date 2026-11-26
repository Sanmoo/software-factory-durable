import type { GitHubTicketRef, JiraTicketRef, TicketCommentFact } from '../../issue-tracker/index.js';
import type { AccessDependencies, ConfiguredRepository, JiraOriginTracker, TicketSource, TriageRequest } from '../types.js';
import type { TriageRoles } from '../rules/triage.js';
import type { TriagePromptBlockers, TriagePromptComment, TriagePromptTicket } from '../rules/triage-prompt.js';
import { triageCandidates, type TriageCandidate, type VerdictContext } from '../rules/triage-verdict.js';
import { jiraLinkTypesOf, visibleBlockers } from './jira-evaluation.js';

// Spec #68 §7 (ticket #75): what the Control reads of a Ticket for the first prompt of its Triager. Read-only; every comment is taken,
// with what the origin says of its author (never the filtered selection a Builder receives). A text that cannot be read completely is
// `unavailable`: no attempt starts on a guess. The blockers are context only, so an unreadable blocker read is stated, not fatal.

type GitHubSource = Extract<TicketSource, { tracker: 'github' }>;
type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
/** Everything one attempt needs about its Ticket and its source: the prompt facts, the candidates and how a Verdict is checked. */
export type TriageSubject = {
  ticket: TriagePromptTicket;
  origin: string;
  candidates: TriageCandidate<ConfiguredRepository>[];
  blockers: TriagePromptBlockers;
  roles: TriageRoles;
  verdictContext: VerdictContext;
};
type TriageSubjectRead = { kind: 'observed'; subject: TriageSubject } | { kind: 'unavailable'; code: string };
const unavailable = (code: string): TriageSubjectRead => ({ kind: 'unavailable', code });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The open issues that block this one, from the native blocked_by graph; the Triage never waits for them (spec §4.4). */
async function githubBlockers(access: AccessDependencies, ticket: GitHubTicketRef): Promise<TriagePromptBlockers> {
  try {
    const graph = await access.tracker.readDependencyGraph(ticket);
    const direct = graph.nodes.find(node => node.issueId === ticket.issueId)?.blockedBy;
    if (!direct) return { kind: 'unavailable', code: graph.problems[0]?.code ?? 'DEPENDENCIES_UNVERIFIABLE' };
    const open = graph.nodes.filter(node => direct.includes(node.issueId) && node.state === 'open');
    return { kind: 'observed', blockers: open.map(node => ({ reference: `${node.repository}#${node.number}`, url: node.url })) };
  } catch {
    return { kind: 'unavailable', code: 'POLLING_QUERY_FAILED' };
  }
}

const githubComment = (comment: TicketCommentFact): TriagePromptComment => ({
  author: `@${comment.author.login}`,
  association: comment.ownApp ? "FACTORY (this Factory's own App)" : comment.authorAssociation,
  at: comment.createdAt,
  text: comment.body,
});
/** The code of a read that did not observe; `absent` when the adapter does not compose that read at all. */
const notRead = (read: { code: string } | undefined, absent: string) => ({ code: read?.code ?? absent });
/** Title, body and EVERY comment of the issue (never the selection a Builder receives), or the code of the read that failed. */
async function githubTicket(access: AccessDependencies, ticket: GitHubTicketRef): Promise<TriagePromptTicket | { code: string }> {
  const text = await access.tracker.readTicketText?.(ticket);
  if (text?.kind !== 'observed') return notRead(text, 'TICKET_TEXT_NOT_COMPOSED');
  const listing = await access.tracker.readTicketComments?.(ticket);
  if (listing?.kind !== 'observed') return notRead(listing, 'TICKET_COMMENTS_NOT_COMPOSED');
  const comments = listing.comments.map(githubComment);
  return { reference: `${ticket.repository}#${ticket.number}`, url: ticket.url, title: text.title, body: text.body, notes: [], comments };
}

async function githubSubject(access: AccessDependencies, source: GitHubSource, ticket: GitHubTicketRef): Promise<TriageSubjectRead> {
  const scope = access.repositories.find(item => same(item.repository, source.repository));
  if (!scope || !source.triage) return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
  const read = await githubTicket(access, ticket);
  if ('code' in read) return unavailable(read.code);
  return {
    kind: 'observed',
    subject: {
      ticket: read,
      origin: `GitHub issue ${ticket.repository}#${ticket.number} (${ticket.url})`,
      candidates: triageCandidates({ tracker: 'github', repository: source.repository }, access.repositories),
      blockers: await githubBlockers(access, ticket),
      roles: { ...source.triage, admission: scope.label },
      verdictContext: { tracker: 'github' },
    },
  };
}

/** The Card's visible blockers that are not done. `links: null` (not read completely) is an unreadable blocker read, never "none". */
async function jiraBlockers(access: AccessDependencies, tracker: JiraOriginTracker, source: JiraSource, ticket: JiraTicketRef): Promise<TriagePromptBlockers> {
  try {
    const card = await tracker.readTicket(ticket);
    if (card.kind !== 'observed') return { kind: 'unavailable', code: card.code };
    const types = jiraLinkTypesOf(access, ticket.siteId);
    const { blockers } = await visibleBlockers(tracker, ticket, card.links, card.observedAt, () => tracker.readLinkTypes(ticket.siteId), types);
    if (blockers.kind !== 'observed') return { kind: 'unavailable', code: blockers.code };
    const open = blockers.blockers.filter(blocker => blocker.statusCategory !== 'done');
    return { kind: 'observed', blockers: open.map(blocker => ({ reference: blocker.key, url: `${source.url.replace(/\/$/, '')}/browse/${blocker.key}` })) };
  } catch {
    return { kind: 'unavailable', code: 'POLLING_QUERY_FAILED' };
  }
}

async function jiraSubject(access: AccessDependencies, source: JiraSource, ticket: JiraTicketRef): Promise<TriageSubjectRead> {
  const tracker = access.trackers?.jira;
  if (!tracker || !source.triage) return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
  const content = await tracker.readTicketContent(ticket);
  if (content.kind !== 'observed') return unavailable(content.code);
  const listing = await tracker.listComments(ticket);
  if (listing.kind !== 'observed') return unavailable(listing.code);
  const comments = listing.comments.map((comment): TriagePromptComment => {
    const note = comment.restricted ? 'visibility restricted in Jira: its text is not delivered' : 'its body is not a readable document: no text is delivered';
    return {
      author: comment.authorAccountId ? `account ${comment.authorAccountId}` : 'an account Jira did not name',
      association: 'not reported by Jira',
      at: comment.createdAt,
      text: comment.restricted ? null : comment.text,
      ...(comment.restricted || comment.text === null ? { note } : {}),
    };
  });
  const candidates = triageCandidates({ tracker: 'jira', routes: source.routes }, access.repositories);
  return {
    kind: 'observed',
    subject: {
      ticket: {
        reference: ticket.key,
        url: ticket.url,
        title: content.summary,
        body: content.description,
        notes: content.truncated ? ['The description is longer than the Factory reads: only its beginning follows.'] : [],
        comments,
      },
      origin: `Jira Card ${ticket.key} (${ticket.url}), project ${source.projectId} of the site ${source.url}`,
      candidates,
      blockers: await jiraBlockers(access, tracker, source, ticket),
      roles: { ...source.triage, admission: source.label },
      verdictContext: { tracker: 'jira', components: candidates.flatMap(candidate => candidate.components) },
    },
  };
}

/** The source a request was discovered in, while its `triage` block is on and the Host can serve it. */
export function triageSourceOf(access: AccessDependencies, request: Pick<TriageRequest, 'source'>): TicketSource | undefined {
  const { source } = request;
  return access.sources?.find(item =>
    item.triage?.available !== true
      ? false
      : source.tracker === 'github'
        ? item.tracker === 'github' && same(item.repository, source.repository)
        : item.tracker === 'jira' && item.siteId === source.siteId && item.projectId === source.projectId,
  );
}

export async function readTriageSubject(access: AccessDependencies, request: Pick<TriageRequest, 'ticket' | 'source'>): Promise<TriageSubjectRead> {
  const source = triageSourceOf(access, request);
  if (!source) return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
  try {
    if (source.tracker === 'github' && request.ticket.tracker === 'github') return await githubSubject(access, source, request.ticket);
    if (source.tracker === 'jira' && request.ticket.tracker === 'jira') return await jiraSubject(access, source, request.ticket);
    return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
  } catch {
    return unavailable('POLLING_QUERY_FAILED');
  }
}
