import { triageMarkerPrefix } from '../../contracts/index.js';
import type { JiraComponentEvent, JiraLabelEvent, JiraTicketRef, JiraTriageWrite, JiraVisibleComment } from '../../issue-tracker/index.js';
import type { AccessDependencies, JiraOriginTracker, TicketSource, TriageRequest } from '../types.js';
import { routeTicket } from '../rules/jira-admission.js';
import { triageRoles } from '../rules/triage.js';
import { cardRoute, sameCommentText, triageCommentMarker, type EffectFact } from '../rules/triage-publication.js';
import type { TriageIntendedEffect } from '../rules/triage-verdict.js';
import type { TriagePublisher } from './triage-publication.js';
import { triageSourceOf } from './triage-ticket.js';

// Spec #68 §8 (ticket #78): what Jira gives the publication of a Verdict on a Card. Two write units: the comment, then ONE edit with the
// label of the outcome, the withdrawal of `needs-triage` and, when the Card has no routed component, the component the Triager
// identified. Never a status, an assignee, a resolution or a removed component: `wontfix` only labels and comments.
//
// Authorship comes from the changelog. An edit is the Factory's when its entry was made by the configured account AND carries this
// request's mark (`historyMetadata`, sent with the edit): the account alone proves nothing, because a person may use it too. An entry of
// that account without the mark, or without an author, is an effect nobody can be named for (the operator decides). Whether Jira Cloud
// stores and returns the mark is the real behaviour TQ-05 still has to confirm; until then this is proven against the doubles only.

type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
type Observed = {
  open: boolean;
  labels: string[];
  /** null = the Card's components were not read completely. */
  components: string[] | null;
  comments: JiraVisibleComment[];
  events: JiraLabelEvent[];
  componentEvents: JiraComponentEvent[];
  account: string;
};
type Authored = { eventId: string; author: { accountId: string } | null; mark?: string };
const markOf = (request: TriageRequest) => `${triageMarkerPrefix}${request.triage_request_id}`;
/** Whose a changelog entry is: this request's own edit, somebody else's, or one nobody can be named for. */
function authorOf(event: Authored, observed: Observed, mark: string): EffectFact['author'] {
  if (event.author && event.author.accountId !== observed.account) return 'other';
  return event.author && event.mark === mark ? 'own' : 'unknown';
}
/** The latest entry that produced the state `holds` describes; an older or opposite entry says nothing of who produced it. */
const authored = (holds: boolean, event: Authored | undefined, observed: Observed, mark: string): EffectFact =>
  event ? { holds, author: authorOf(event, observed, mark), reference: event.eventId } : { holds, author: 'none' };

function labelFact(effect: Extract<TriageIntendedEffect, { kind: 'add-label' | 'remove-label' }>, observed: Observed, mark: string): EffectFact {
  const present = observed.labels.includes(effect.label);
  const latest = observed.events.findLast(event => event.label === effect.label);
  const wanted = effect.kind === 'add-label' ? 'added' : 'removed';
  return authored(effect.kind === 'add-label' ? present : !present, latest?.action === wanted ? latest : undefined, observed, mark);
}
function componentFact(effect: Extract<TriageIntendedEffect, { kind: 'add-component' }>, observed: Observed, mark: string): EffectFact {
  const latest = observed.componentEvents.findLast(event => event.componentId === effect.componentId);
  return authored(observed.components?.includes(effect.componentId) ?? false, latest?.action === 'added' ? latest : undefined, observed, mark);
}
function commentFact(request: TriageRequest, expected: string, observed: Observed): EffectFact {
  const marker = triageCommentMarker(request.triage_request_id);
  // A comment of another account with the marker is not this request's effect, whatever it says.
  const marked = observed.comments.filter(comment => comment.authorAccountId === observed.account && comment.text?.trimStart().startsWith(marker));
  const own = marked.find(comment => sameCommentText(comment.text ?? '', expected)) ?? marked[0];
  if (!own) return { holds: false, author: 'none' };
  const reference = `${request.ticket.url}?focusedCommentId=${own.commentId}`;
  return { holds: true, author: sameCommentText(own.text ?? '', expected) ? 'own' : 'unknown', reference };
}
function effectFact(request: TriageRequest, effect: TriageIntendedEffect, expected: string, observed: Observed): EffectFact {
  if (effect.kind === 'comment') return commentFact(request, expected, observed);
  if (effect.kind === 'add-label' || effect.kind === 'remove-label') return labelFact(effect, observed, markOf(request));
  // A Card is never closed by a Triage: that effect never holds here, so it is never taken as written.
  return effect.kind === 'add-component' ? componentFact(effect, observed, markOf(request)) : { holds: false, author: 'none' };
}

/** The one edit that carries every label and component effect of `group`. */
function editOf(request: TriageRequest, group: readonly number[]): Extract<JiraTriageWrite, { kind: 'edit' }> | undefined {
  const effects = group.map(index => request.intended?.[index]);
  const edit = { kind: 'edit' as const, mark: markOf(request), addLabels: [] as string[], removeLabels: [] as string[], addComponents: [] as string[] };
  for (const effect of effects) {
    if (effect?.kind === 'add-label') edit.addLabels.push(effect.label);
    else if (effect?.kind === 'remove-label') edit.removeLabels.push(effect.label);
    else if (effect?.kind === 'add-component') edit.addComponents.push(effect.componentId);
    else return undefined;
  }
  return effects.length ? edit : undefined;
}
function writeOf(request: TriageRequest, group: readonly number[], comment: string): JiraTriageWrite | undefined {
  if (group.length === 1 && request.intended?.[group[0]!]?.kind === 'comment') return { kind: 'comment', lines: comment.split('\n') };
  return editOf(request, group);
}
/** Refusals of the edit that are Jira's answer to what was asked (permission, field, component), not a passing condition of the site. */
const refusals = new Set(['JIRA_FORBIDDEN', 'JIRA_REQUEST_REJECTED', 'JIRA_NOT_FOUND']);
const unavailable = (code: string) => ({ kind: 'unavailable' as const, code });
const componentIds = (components: readonly { id: string }[] | null) => components?.map(component => component.id) ?? null;
/** The Card's changelog, or the code of the read that did not observe it (the read is optional in the tracker contract). */
async function historyOf(tracker: JiraOriginTracker, ticket: JiraTicketRef) {
  return (await tracker.readLabelHistory?.(ticket)) ?? unavailable('LABEL_HISTORY_NOT_COMPOSED');
}

export function jiraTriagePublisher(access: AccessDependencies): TriagePublisher {
  const sourceOf = (request: TriageRequest): JiraSource | undefined => {
    const source = triageSourceOf(access, request);
    return source?.tracker === 'jira' ? source : undefined;
  };
  const authorized = () => access.repositories.map(item => item.repository);
  const repositoryOf = (request: TriageRequest, componentId: string) => {
    const routed = routeTicket({ components: [componentId], routes: sourceOf(request)?.routes ?? [], authorizedRepositories: authorized() });
    return routed.kind === 'single' ? routed.repository : null;
  };
  /** The Card, its comments, its changelog and the configured account, each read completely; one of them unread concludes nothing. */
  async function read(tracker: JiraOriginTracker, ticket: JiraTicketRef): Promise<Observed | { code: string }> {
    const card = await tracker.readTicket(ticket);
    if (card.kind !== 'observed') return { code: card.code };
    const comments = await tracker.listComments(ticket);
    if (comments.kind !== 'observed') return { code: comments.code };
    const history = await historyOf(tracker, ticket);
    if (history.kind !== 'observed') return { code: history.code };
    const account = await tracker.readAccount(ticket.siteId);
    if (account.kind !== 'observed') return { code: account.code };
    return {
      open: card.statusCategory !== 'done',
      labels: card.labels,
      components: componentIds(card.components),
      comments: comments.comments,
      events: history.events,
      componentEvents: history.components,
      account: account.accountId,
    };
  }
  /** Spec §8, "Rota no Jira": Jira refused the edit that carried the component, so `ready-for-agent` is not applied. */
  function componentRefused(request: TriageRequest, write: JiraTriageWrite, result: { kind: 'failed' | 'unknown'; code: string }) {
    const componentId = write.kind === 'edit' ? write.addComponents[0] : undefined;
    if (result.kind !== 'failed' || !componentId || !refusals.has(result.code)) return {};
    return { fallback: { code: 'TRIAGE_COMPONENT_NOT_WRITTEN' as const, componentId, repository: repositoryOf(request, componentId) } };
  }
  return {
    commentLimit: 32767,
    // One paragraph per line, and the adapter reads back at most 2,000 blocks of a comment: a comment it could not read back would
    // never be recognised as published.
    commentMaxLines: 1900,
    caseSensitive: true,
    roles(request) {
      const source = sourceOf(request);
      return source?.triage ? triageRoles(source.triage, source.label) : undefined;
    },
    groups(intended) {
      const comment = intended.flatMap((effect, index) => (effect.kind === 'comment' ? [index] : []));
      const edit = intended.flatMap((effect, index) => (effect.kind === 'comment' ? [] : [index]));
      return [...comment.map(index => [index]), ...(edit.length ? [edit] : [])];
    },
    route: {
      repositoryOf,
      async check(request) {
        const tracker = access.trackers?.jira;
        const source = sourceOf(request);
        if (!tracker || !source || request.ticket.tracker !== 'jira') return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
        const card = await tracker.readTicket(request.ticket);
        if (card.kind !== 'observed') return unavailable(card.code);
        return cardRoute({
          component: request.verdict?.component ?? null,
          cardComponents: componentIds(card.components),
          routes: source.routes,
          authorizedRepositories: authorized(),
        });
      },
    },
    async observe(request, comment) {
      const tracker = access.trackers?.jira;
      if (!tracker || request.ticket.tracker !== 'jira') return unavailable('TRIAGE_SOURCE_NOT_CONFIGURED');
      const observed = await read(tracker, request.ticket);
      if ('code' in observed) return unavailable(observed.code);
      const intended = request.intended ?? [];
      // A component that was written is confirmed by the Card's components: a partial list says nothing of it.
      if (observed.components === null && intended.some(effect => effect.kind === 'add-component' && effect.attemptedAt !== undefined))
        return unavailable('JIRA_COMPONENTS_UNREADABLE');
      const effects = intended.map(effect => effectFact(request, effect, comment, observed));
      return { kind: 'observed', facts: { open: observed.open, labels: observed.labels, effects } };
    },
    async write(request, group, comment) {
      const tracker = access.trackers?.jira;
      const write = writeOf(request, group, comment);
      if (!write || !tracker?.writeTriage || request.ticket.tracker !== 'jira') return { kind: 'failed', code: 'TRIAGE_WRITE_NOT_COMPOSED' };
      const result = await tracker.writeTriage(request.ticket, write);
      if (result.kind === 'accepted') return { kind: 'accepted' };
      return { kind: result.kind, code: result.code, ...componentRefused(request, write, result) };
    },
  };
}
