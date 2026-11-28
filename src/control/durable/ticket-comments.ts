import { createHash } from 'node:crypto';
import type { AccessDependencies, ExecutionView, TicketComments } from '../types.js';
import type { WorkRecord } from './admission.js';
import { readJiraContent } from './jira-evaluation.js';
import type { TicketRef } from '../../issue-tracker/index.js';
import type { TicketText } from '../rules/continuation.js';
import { boundTicketComments, githubTicketComments, jiraTicketComments, ticketCommentsBound, type SelectedComment } from '../rules/ticket-comments.js';

// The Control reads the comments of the Ticket with its own adapters, selects and bounds them, and hands them to
// the Builder with the request. The Builder never fetches comments: what is not delivered here is not part of the Ticket.

type Access = Pick<AccessDependencies, 'tracker' | 'trackers'>;
type Unavailable = { kind: 'unavailable'; code: string };
const failed = (code: string): Unavailable => ({ kind: 'unavailable', code });

async function selectedComments(
  access: Access,
  ticket: TicketRef,
): Promise<{ kind: 'observed'; observedAt: string; selected: SelectedComment[] } | Unavailable> {
  if (ticket.tracker === 'jira') {
    const tracker = access.trackers?.jira;
    if (!tracker) return failed('JIRA_TRACKER_NOT_COMPOSED');
    const listing = await tracker.listComments(ticket).catch(() => failed('JIRA_READ_FAILED'));
    if (listing.kind !== 'observed') return failed(listing.code);
    return { kind: 'observed', observedAt: listing.observedAt, selected: jiraTicketComments(listing.comments) };
  }
  if (!access.tracker.readTicketComments) return failed('TICKET_COMMENTS_NOT_COMPOSED');
  const read = await access.tracker.readTicketComments(ticket).catch(() => failed('GITHUB_READ_FAILED'));
  if (read.kind !== 'observed') return failed(read.code);
  return { kind: 'observed', observedAt: read.observedAt, selected: githubTicketComments(read.comments) };
}

/**
 * The comments of a Ticket as its Builder receives them: GitHub, the Factory's own and those of authors with write access; Jira, every
 * comment of the Card, under one bound that holds a published Verdict whole.
 * An unreadable listing is `unavailable`: a Work never starts on a guess about its Ticket.
 */
export async function readTicketComments(access: Access, ticket: TicketRef): Promise<{ kind: 'observed'; comments: TicketComments } | Unavailable> {
  const read = await selectedComments(access, ticket);
  if (read.kind !== 'observed') return read;
  const bounded = boundTicketComments(read.selected, ticketCommentsBound);
  const sha256 = createHash('sha256').update(JSON.stringify(bounded.comments)).digest('hex');
  return { kind: 'observed', comments: { ...bounded, observedAt: read.observedAt, sha256 } };
}

type TicketRequest = Pick<ExecutionView['request'], 'ticket' | 'ticketContent' | 'ticketComments'>;
type TicketFields = Pick<ExecutionView['request'], 'ticketContent' | 'ticketComments'>;
const latestExecution = (work: Pick<WorkRecord, 'execution' | 'previousExecutions'>) => work.execution ?? work.previousExecutions?.at(-1) ?? null;
/**
 * The comments of the Ticket for a new Execution of a Work. Read only for the Work's FIRST Execution: they compose version v1 of the
 * Ticket. Every later Execution carries what the latest one carried, so a comment written after the first prompt never enters the Ticket
 * (it is not a scope change), and a Work started before comments were delivered keeps none.
 */
async function ticketCommentsFor(
  access: Access,
  work: Pick<WorkRecord, 'ticket' | 'execution' | 'previousExecutions'>,
): Promise<{ kind: 'observed'; comments: TicketComments | undefined } | Unavailable> {
  const latest = latestExecution(work);
  if (!latest) return readTicketComments(access, work.ticket);
  const carried = latest.request.ticketContent?.comments ?? latest.request.ticketComments;
  return { kind: 'observed', comments: carried ? structuredClone(carried) : undefined };
}
const refused = (reason: string, read: Unavailable) => ({ kind: 'unavailable' as const, reasons: [reason, read.code] });
/**
 * The Ticket text the Control hands to the Builder with a new Execution's request. A Jira Card: its text, read now (the Builder has no
 * Jira access), with its comments inside. A GitHub issue: its selected comments (the Builder reads the issue itself). An unreadable
 * Card or listing never starts a Work on a guess.
 */
export async function ticketOf(
  access: Access,
  work: Pick<WorkRecord, 'ticket' | 'execution' | 'previousExecutions'>,
): Promise<{ kind: 'observed'; request: TicketFields } | { kind: 'unavailable'; reasons: string[] }> {
  if (work.ticket.tracker !== 'jira') {
    const comments = await ticketCommentsFor(access, work);
    if (comments.kind !== 'observed') return refused('TICKET_COMMENTS_UNAVAILABLE', comments);
    return { kind: 'observed', request: comments.comments ? { ticketComments: comments.comments } : {} };
  }
  const content = await readJiraContent(access, work.ticket);
  if (content.kind !== 'observed') return refused('TICKET_CONTENT_UNAVAILABLE', content);
  const comments = await ticketCommentsFor(access, work);
  if (comments.kind !== 'observed') return refused('TICKET_COMMENTS_UNAVAILABLE', comments);
  return { kind: 'observed', request: { ticketContent: { ...content.content, ...(comments.comments ? { comments: comments.comments } : {}) } } };
}

/** The Ticket text an Execution's request carries, as the prompt rules take it (the Card's text, or the comments of a GitHub issue). */
export function ticketTextOf(request: TicketRequest): TicketText | null {
  if (request.ticketContent) return request.ticketContent;
  return request.ticketComments ? { tracker: 'github', url: request.ticket, comments: request.ticketComments } : null;
}
