// Pure admission rules over observed facts. No I/O, clock, storage or GitHub types: callers pass data and time.
import type { JiraReasonCode } from './jira-admission.js';

export type HoldCode = 'REPOSITORY_NOT_CONFIGURED' | 'TICKET_READ_UNAVAILABLE' | 'TICKET_IDENTITY_MISMATCH' | 'TICKET_IS_PULL_REQUEST' |
  'TICKET_NOT_OPEN' | 'LABEL_NOT_PRESENT' | 'PUBLICATION_UNKNOWN' | 'FOREIGN_PULL_REQUEST' | 'GLOBAL_PAUSE' |
  /** Jira ticket 01: the repository is not a GitHub Ticket source with discovery on (v2 `ticketSources`); existing Works are unaffected. */
  'SOURCE_DISCOVERY_DISABLED' |
  /** Jira ticket 04: why a Jira candidate was not admitted (rules/jira-admission), and a destination whose GitHub identity is not observed yet. */
  JiraReasonCode | 'DESTINATION_NOT_OBSERVED';
export type Hold = { code: HoldCode; nextStep: string; observedCode?: string; waitSeconds?: number;
  /** Jira ticket 04 (local diagnosis only): divergent destinations, a blocker neighbour, a link needing the operator. */
  repositories?: string[]; blocker?: { issueId: string; key: string }; linkId?: string;
  pullRequests?: { pullRequestId: number; number: number; url: string; state: 'open' | 'closed'; merged: boolean; association: string[] }[] };

type Ref = { repository: string; repositoryId: number; issueId: number; nodeId: string; number: number };
type Unavailable = { kind: 'unavailable'; code: string; waitSeconds?: number; nextStep: string };
export type TicketFacts = { kind: 'observed'; ticket: Ref; state: 'open' | 'closed'; labels: { id: number; name: string }[]; pullRequest: boolean } | Unavailable;
export type PublicationFacts = { kind: 'observed'; repositoryId: number;
  candidates: { pullRequestId: number; number: number; url: string; state: 'open' | 'closed'; merged: boolean; headRef: string; headRepositoryId: number | null; association: string[] }[] } | Unavailable;

/** Identity part of a GitHub Ticket reference (untagged = GitHub: persisted format-2 shapes carry no other tracker). */
type GitHubKeyRef = Pick<Ref, 'repositoryId' | 'issueId'> & { tracker?: 'github' };
/** Identity part of a Jira Ticket reference: (siteId, issueId). The visible key (PAG-42) never takes part. */
type JiraKeyRef = { tracker: 'jira'; siteId: string; issueId: string };

/**
 * Durable index key: tracker + immutable ids, never number/key/title/url. GitHub keeps exactly `github:repository:<id>:issue:<id>`; Jira is
 * `jira:site:<siteId>:issue:<issueId>` with each part percent-encoded (`:` included), so no two tuples share a key and no Jira key matches
 * the GitHub form.
 */
export function ticketKey(ref: GitHubKeyRef | JiraKeyRef): string {
  if (ref.tracker === 'jira') return `jira:site:${encodeURIComponent(ref.siteId)}:issue:${encodeURIComponent(ref.issueId)}`;
  return `github:repository:${ref.repositoryId}:issue:${ref.issueId}`;
}

/** Narrows a Ticket reference to GitHub on a path that only GitHub origins reach (Jira Works are refused before it); throws otherwise. */
export function githubOnly<T extends { tracker: string }>(ref: T): Extract<T, { tracker: 'github' }> {
  if (ref.tracker !== 'github') throw new Error('TICKET_ORIGIN_NOT_GITHUB');
  return ref as Extract<T, { tracker: 'github' }>;
}

/**
 * Jira ticket 04: the Work's own branch. GitHub keeps `factory/<number>-<work8>`; Jira uses the immutable issue ID, never the visible key
 * (a key change never renames the branch): `factory/jira-<issueId>-<work8>`.
 */
export function workBranchName(ticket: { tracker: 'github'; number: number } | { tracker: 'jira'; issueId: string }, workId: string): string {
  const suffix = workId.slice(0, 8);
  if (ticket.tracker === 'jira') {
    if (!/^[1-9][0-9]{0,17}$/.test(ticket.issueId)) throw new Error('TICKET_ID_INVALID');
    return `factory/jira-${ticket.issueId}-${suffix}`;
  }
  return `factory/${ticket.number}-${suffix}`;
}

/** Presentation of a Ticket for views, CLI, history and prompts: `owner/repo#n` (GitHub) or the Jira key (`PAG-42`). Never an identity. */
export function ticketLabel(ref: { tracker: 'github'; repository: string; number: number } | { tracker: 'jira'; key: string }): string {
  return ref.tracker === 'jira' ? ref.key : `${ref.repository}#${ref.number}`;
}

const unavailable = (code: 'TICKET_READ_UNAVAILABLE' | 'PUBLICATION_UNKNOWN', facts: Unavailable, what: string): Hold => ({
  code, observedCode: facts.code, ...(facts.waitSeconds !== undefined ? { waitSeconds: facts.waitSeconds } : {}),
  nextStep: `${what} could not be observed (${facts.code}); this does not prove absence. ${facts.nextStep}`,
});

/** Entry authorization: configured repository + open issue (not a pull request) + effective configured label, same qualified identity. */
export function evaluateEntry(input: { configuredLabel: string | undefined; listed: Ref; facts: TicketFacts }):
  { authorized: true; label: { id: number; name: string } } | { authorized: false; holds: Hold[] } {
  if (input.configuredLabel === undefined) return { authorized: false, holds: [{ code: 'REPOSITORY_NOT_CONFIGURED',
    nextStep: 'Only explicitly configured repositories authorize entry; add the repository to the configuration and restart if intended.' }] };
  const facts = input.facts;
  if (facts.kind === 'unavailable') return { authorized: false, holds: [unavailable('TICKET_READ_UNAVAILABLE', facts, 'The current Ticket state')] };
  const holds: Hold[] = [];
  const { ticket } = facts;
  if (ticket.repositoryId !== input.listed.repositoryId || ticket.issueId !== input.listed.issueId || ticket.nodeId !== input.listed.nodeId ||
    ticket.number !== input.listed.number || ticket.repository.toLowerCase() !== input.listed.repository.toLowerCase()) holds.push({ code: 'TICKET_IDENTITY_MISMATCH',
    nextStep: 'The re-read issue does not carry the listed qualified identity (transfer/renumbering?); operator must inspect it on GitHub. Nothing was admitted.' });
  if (facts.pullRequest) holds.push({ code: 'TICKET_IS_PULL_REQUEST', nextStep: 'Pull requests are never Tickets; remove the label from the pull request.' });
  if (facts.state !== 'open') holds.push({ code: 'TICKET_NOT_OPEN', nextStep: 'Only open issues authorize entry; reopen the issue if work is intended.' });
  const label = facts.labels.find(candidate => candidate.name.toLowerCase() === input.configuredLabel!.toLowerCase());
  if (!label) holds.push({ code: 'LABEL_NOT_PRESENT', nextStep: `Apply the configured label "${input.configuredLabel}" to authorize entry.` });
  return holds.length || !label ? { authorized: false, holds } : { authorized: true, label: { id: label.id, name: label.name } };
}

/** A pull request associated with the Ticket and not recognised as own (known own branch in the same repository) blocks admission/adoption. */
export function evaluatePublication(input: { facts: PublicationFacts; ownBranches: string[] }): { clear: true } | { clear: false; holds: Hold[] } {
  const facts = input.facts;
  if (facts.kind === 'unavailable') return { clear: false, holds: [unavailable('PUBLICATION_UNKNOWN', facts, 'Associated pull requests')] };
  const foreign = facts.candidates.filter(candidate => !(input.ownBranches.includes(candidate.headRef) && candidate.headRepositoryId === facts.repositoryId));
  if (!foreign.length) return { clear: true };
  return { clear: false, holds: [{ code: 'FOREIGN_PULL_REQUEST',
    pullRequests: foreign.map(({ pullRequestId, number, url, state, merged, association }) => ({ pullRequestId, number, url, state, merged, association })),
    nextStep: 'A pull request associated with this Ticket is not recognised as the Factory\'s own; it is neither adopted nor admitted automatically. ' +
      'Open, closed or merged associated pull requests all keep blocking: closing one does not remove the association. Operator must decide on GitHub ' +
      '(handle the Ticket manually, or remove the association: edit the closing keyword/reference out of the pull request, or unlink it from Development); ' +
      'polling then re-evaluates the Ticket. A native timeline cross-reference cannot be deleted, so such a Ticket stays an operator decision.' }] };
}

/** Next poll delay for one repository: interval on success; service-indicated wait prevails; bounded exponential backoff on failures. */
export function pollDelaySeconds(input: { intervalSeconds: number; outcome: 'observed' | 'unavailable'; waitSeconds?: number; consecutiveFailures: number }): number {
  const interval = Math.max(1, input.intervalSeconds);
  if (input.outcome === 'observed') return Math.max(interval, input.waitSeconds ?? 0);
  const backoff = Math.min(interval * 2 ** Math.min(Math.max(input.consecutiveFailures - 1, 0), 16), Math.max(interval, 900));
  return Math.max(backoff, input.waitSeconds ?? 0, interval);
}
