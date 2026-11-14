// Pure admission rules over observed facts. No I/O, clock, storage or GitHub types: callers pass data and time.

export type HoldCode = 'REPOSITORY_NOT_CONFIGURED' | 'TICKET_READ_UNAVAILABLE' | 'TICKET_IDENTITY_MISMATCH' | 'TICKET_IS_PULL_REQUEST' |
  'TICKET_NOT_OPEN' | 'LABEL_NOT_PRESENT' | 'PUBLICATION_UNKNOWN' | 'FOREIGN_PULL_REQUEST' | 'GLOBAL_PAUSE';
export type Hold = { code: HoldCode; nextStep: string; observedCode?: string; waitSeconds?: number;
  pullRequests?: { pullRequestId: number; number: number; url: string; state: 'open' | 'closed'; merged: boolean; association: string[] }[] };

type Ref = { repository: string; repositoryId: number; issueId: number; nodeId: string; number: number };
type Unavailable = { kind: 'unavailable'; code: string; waitSeconds?: number; nextStep: string };
export type TicketFacts = { kind: 'observed'; ticket: Ref; state: 'open' | 'closed'; labels: { id: number; name: string }[]; pullRequest: boolean } | Unavailable;
export type PublicationFacts = { kind: 'observed'; repositoryId: number;
  candidates: { pullRequestId: number; number: number; url: string; state: 'open' | 'closed'; merged: boolean; headRef: string; headRepositoryId: number | null; association: string[] }[] } | Unavailable;

/** Durable index key: tracker + immutable repository id + immutable issue id, never number/title/url. */
export function ticketKey(ref: Pick<Ref, 'repositoryId' | 'issueId'>): string {
  return `github:repository:${ref.repositoryId}:issue:${ref.issueId}`;
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
      'Operator must decide on GitHub: finish it manually, or close it / remove its closing reference, then polling re-evaluates the Ticket.' }] };
}

/** Next poll delay for one repository: interval on success; service-indicated wait prevails; bounded exponential backoff on failures. */
export function pollDelaySeconds(input: { intervalSeconds: number; outcome: 'observed' | 'unavailable'; waitSeconds?: number; consecutiveFailures: number }): number {
  const interval = Math.max(1, input.intervalSeconds);
  if (input.outcome === 'observed') return Math.max(interval, input.waitSeconds ?? 0);
  const backoff = Math.min(interval * 2 ** Math.min(Math.max(input.consecutiveFailures - 1, 0), 16), Math.max(interval, 900));
  return Math.max(backoff, input.waitSeconds ?? 0, interval);
}
