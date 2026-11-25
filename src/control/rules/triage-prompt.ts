// Spec #68 §7 (ticket #75): what the Control injects into the first prompt of a Triager, as text. Pure: the caller passes what it read.
// Exactly six fields; the label history, anything of an earlier attempt and the MCP tools are never among them.
import { fenced } from './continuation.js';

/** One comment of the Ticket. `association`: what the origin says of the author's link to it; `text: null` = not delivered (see `note`). */
export type TriagePromptComment = { author: string; association: string; at: string; text: string | null; note?: string };
export type TriagePromptTicket = {
  reference: string;
  url: string;
  title: string | null;
  body: string | null;
  /** Explicit statements about the text itself (for instance a description the origin cut). */
  notes: readonly string[];
  comments: readonly TriagePromptComment[];
};
export type TriagePromptBlockers =
  { kind: 'observed'; blockers: readonly { reference: string; url: string | null }[] } | { kind: 'unavailable'; code: string };
export type TriageActivationInput = {
  ticket: TriagePromptTicket;
  origin: string;
  candidates: readonly { repository: string; base: string; components: readonly string[] }[];
  blockers: TriagePromptBlockers;
  /** Investigation time this request still has. */
  remainingMs: number;
};
export type TriageActivationText = {
  ticket: string;
  origin: string;
  candidateRepositories: string;
  openBlockers: string;
  builderReach: string;
  remainingInvestigationTime: string;
};

function ticketText(ticket: TriagePromptTicket): string {
  const total = ticket.comments.length;
  const comments = ticket.comments.flatMap((comment, index) => [
    '',
    `### Comment ${index + 1} of ${total}, by ${comment.author} (association with the origin: ${comment.association}), ${comment.at}`,
    comment.text === null ? `(${comment.note ?? 'text not delivered'})` : fenced(comment.text),
  ]);
  return [
    `${ticket.reference}: ${ticket.url}`,
    `Title: ${ticket.title ?? '(no title)'}`,
    ...ticket.notes,
    '',
    '### Body',
    ticket.body === null || !ticket.body.trim() ? '(no body)' : fenced(ticket.body),
    ...(total ? comments : ['', 'No comments.']),
  ].join('\n');
}

function blockersText(blockers: TriagePromptBlockers): string {
  if (blockers.kind === 'unavailable')
    return `The blockers of this Ticket could not be read (${blockers.code}). Treat them as unknown; they never hold a Triage.`;
  if (!blockers.blockers.length) return 'None observed.';
  return blockers.blockers.map(blocker => `- ${blocker.reference} (open)${blocker.url ? `: ${blocker.url}` : ''}`).join('\n');
}

function remainingText(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return 'less than 1 minute';
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The six injected fields of the Triager activation prompt (the pack's template holds everything else). */
export function triageActivation(input: TriageActivationInput): TriageActivationText {
  const names = input.candidates.map(candidate => candidate.repository);
  return {
    ticket: ticketText(input.ticket),
    origin: input.origin,
    candidateRepositories: input.candidates.length
      ? input.candidates
          .map(
            candidate =>
              `- ${candidate.repository} (default branch \`${candidate.base}\`)` +
              (candidate.components.length ? `, destination of the Jira components ${candidate.components.join(', ')}` : ''),
          )
          .join('\n')
      : 'None: this source routes to no repository, so there is no code to read.',
    openBlockers: blockersText(input.blockers),
    builderReach:
      (names.length
        ? `A Builder works in one of: ${names.join(', ')}. It reaches that repository (code and history) and the issues and pull requests of that repository, `
        : 'A Builder reaches the repository it works in and the issues and pull requests of that repository, ') +
      'plus the Ticket text and comments the Factory delivers to it. Nothing else: no other repository, no MCP source, no external link.',
    remainingInvestigationTime: remainingText(input.remainingMs),
  };
}
