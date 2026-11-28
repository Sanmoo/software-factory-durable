import type { ClosureEvent, GitHubTicketRef, LabelEvent, TicketCommentFact, TriageWrite } from '../../issue-tracker/index.js';
import type { AccessDependencies, TriageRequest } from '../types.js';
import { triageRoles } from '../rules/triage.js';
import { sameCommentText, triageCommentMarker, type EffectFact } from '../rules/triage-publication.js';
import type { TriageIntendedEffect } from '../rules/triage-verdict.js';
import type { TriagePublisher } from './triage-publication.js';
import { triageSourceOf } from './triage-ticket.js';

// What GitHub gives the publication of a Verdict on an issue. Each effect is its own write (comment, label of
// the outcome, withdrawal of `needs-triage`, `not_planned` closing). A label or closing is the Factory's when the latest matching event
// of the timeline was performed by this installation's App (`actor` + `performed_via_github_app`); the comment, when the App wrote it
// under the request's marker with the expected content.

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type Authored = { eventId: string; actor: unknown; ownApp: boolean };
const authorOf = (event: Authored): EffectFact['author'] => (event.ownApp ? 'own' : event.actor === null ? 'unknown' : 'other');
/** The latest event that produced the state `holds` describes; an older or opposite event says nothing of who produced it. */
const authored = (holds: boolean, event: Authored | undefined): EffectFact =>
  event ? { holds, author: authorOf(event), reference: event.eventId } : { holds, author: 'none' };

type Observed = { open: boolean; labels: string[]; comments: TicketCommentFact[]; events: LabelEvent[]; closures: ClosureEvent[] };
function labelFact(effect: Extract<TriageIntendedEffect, { kind: 'add-label' | 'remove-label' }>, observed: Observed): EffectFact {
  const present = observed.labels.some(label => same(label, effect.label));
  const latest = observed.events.findLast(event => same(event.label, effect.label));
  const wanted = effect.kind === 'add-label' ? 'added' : 'removed';
  return authored(effect.kind === 'add-label' ? present : !present, latest?.action === wanted ? latest : undefined);
}
function commentFact(request: TriageRequest, expected: string, observed: Observed): EffectFact {
  const marker = triageCommentMarker(request.triage_request_id);
  // A comment somebody else wrote with the marker is not this request's effect, whatever it says.
  const own = observed.comments.find(comment => comment.ownApp && comment.body.trimStart().startsWith(marker));
  if (!own) return { holds: false, author: 'none' };
  return { holds: true, author: sameCommentText(own.body, expected) ? 'own' : 'unknown', reference: own.url };
}
function effectFact(request: TriageRequest, effect: TriageIntendedEffect, expected: string, observed: Observed): EffectFact {
  if (effect.kind === 'comment') return commentFact(request, expected, observed);
  if (effect.kind === 'add-label' || effect.kind === 'remove-label') return labelFact(effect, observed);
  const latest = observed.closures.at(-1);
  // A component is a Card's: it never holds on an issue, so it is never taken as written.
  return effect.kind === 'close' ? authored(!observed.open, latest?.action === 'closed' ? latest : undefined) : { holds: false, author: 'none' };
}
const writeOf = (effect: TriageIntendedEffect, comment: string): TriageWrite | undefined => {
  if (effect.kind === 'comment') return { kind: 'comment', body: comment };
  if (effect.kind === 'add-component') return undefined;
  return effect.kind === 'close' ? { kind: 'close', reason: effect.reason } : { kind: effect.kind, label: effect.label };
};

/** The code of a read that did not observe; `absent` when the adapter does not compose that read at all. */
const unread = (read: { code: string } | undefined, absent: string) => ({ code: read?.code ?? absent });

export function githubTriagePublisher(access: AccessDependencies): TriagePublisher {
  const { tracker } = access;
  async function readIssue(ticket: GitHubTicketRef): Promise<Pick<Observed, 'open' | 'labels'> | { code: string }> {
    const issue = await tracker.readTicket(ticket);
    if (issue.kind !== 'observed') return { code: issue.code };
    if (issue.ticket.repositoryId !== ticket.repositoryId || issue.ticket.issueId !== ticket.issueId) return { code: 'TICKET_IDENTITY_MISMATCH' };
    return { open: issue.state === 'open' && !issue.pullRequest, labels: issue.labels.map(label => label.name) };
  }
  /** The issue, its comments and its timeline, each read completely; one of them unread concludes nothing. */
  async function read(ticket: GitHubTicketRef): Promise<Observed | { code: string }> {
    const issue = await readIssue(ticket);
    if ('code' in issue) return issue;
    const comments = await tracker.readTicketComments?.(ticket);
    if (comments?.kind !== 'observed') return unread(comments, 'TICKET_COMMENTS_NOT_COMPOSED');
    const history = await tracker.readLabelHistory?.(ticket);
    if (history?.kind !== 'observed') return unread(history, 'LABEL_HISTORY_NOT_COMPOSED');
    return { ...issue, comments: comments.comments, events: history.events, closures: history.closures };
  }
  return {
    // GitHub documents no size for an issue comment; 60,000 characters is what the adapter sends (GitHubAccess.comment).
    commentLimit: 60000,
    caseSensitive: false,
    roles(request) {
      const source = triageSourceOf(access, request);
      const scope = source?.tracker === 'github' ? access.repositories.find(item => same(item.repository, source.repository)) : undefined;
      return source?.triage && scope ? triageRoles(source.triage, scope.label) : undefined;
    },
    groups: intended => intended.map((_, index) => [index]),
    async observe(request, comment) {
      if (request.ticket.tracker !== 'github') return { kind: 'unavailable', code: 'TRIAGE_SOURCE_NOT_CONFIGURED' };
      const observed = await read(request.ticket);
      if ('code' in observed) return { kind: 'unavailable', code: observed.code };
      const effects = (request.intended ?? []).map(effect => effectFact(request, effect, comment, observed));
      return { kind: 'observed', facts: { open: observed.open, labels: observed.labels, effects } };
    },
    async write(request, group, comment) {
      const effect = request.intended?.[group[0] ?? -1];
      const write = effect && group.length === 1 ? writeOf(effect, comment) : undefined;
      if (!write || request.ticket.tracker !== 'github' || !tracker.writeTriage) return { kind: 'failed', code: 'TRIAGE_WRITE_NOT_COMPOSED' };
      const result = await tracker.writeTriage(request.ticket, write);
      return result.kind === 'accepted' ? { kind: 'accepted' } : { kind: result.kind, code: result.code };
    },
  };
}
