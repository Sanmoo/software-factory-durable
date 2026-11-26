// Spec #68 §9 (ticket #74): the comments of a Ticket as the Builder receives them. Pure selection, bound and presentation; the Control
// reads the facts through the tracker adapters and persists the result with the Work's first Execution (version v1 of the Ticket).

/** One comment selected for the Builder. `association`: `FACTORY`, a GitHub `author_association`, or `JIRA`. */
export type SelectedComment = {
  id: string;
  author: string;
  association: string;
  createdAt: string;
  body: string;
  /** The text is not delivered: a Jira visibility restriction applies, or the body is not readable as text. Never a silent omission. */
  withheld?: 'restricted' | 'unreadable';
  /** Only the beginning of the text is kept (the comment alone exceeds the bound). */
  cut?: true;
};
/** The selected comments after the bound, oldest first: `omitted` of the `selected` ones (always the oldest) are not in `comments`. */
export type BoundedComments = { comments: SelectedComment[]; selected: number; omitted: number };

/** GitHub associations that mean write access to the repository (decision of the map: OWNER, MEMBER or COLLABORATOR). */
export const builderCommentAssociations: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

type GitHubCommentFact = { commentId: number; author: { login: string }; authorAssociation: string; ownApp: boolean; body: string; createdAt: string };
/** GitHub: the Factory's own comments and those of authors with write access; every other author is left out (ascending comment id). */
export function githubTicketComments(comments: readonly GitHubCommentFact[]): SelectedComment[] {
  return [...comments]
    .sort((a, b) => a.commentId - b.commentId)
    .filter(comment => comment.ownApp || builderCommentAssociations.includes(comment.authorAssociation))
    .map(comment => ({
      id: String(comment.commentId),
      author: comment.author.login,
      association: comment.ownApp ? 'FACTORY' : comment.authorAssociation,
      createdAt: comment.createdAt,
      body: comment.body,
    }));
}

type JiraCommentFact = { commentId: string; authorAccountId: string | null; text: string | null; createdAt: string; restricted: boolean };
const jiraWithheld = (comment: JiraCommentFact): SelectedComment['withheld'] | undefined => {
  if (comment.restricted) return 'restricted';
  return comment.text === null ? 'unreadable' : undefined;
};
/**
 * Jira: every comment of the Card, in the order of the listing (the adapter asks Jira for ascending creation). A visibility-restricted
 * text is never projected: the comment is delivered without it.
 */
export function jiraTicketComments(comments: readonly JiraCommentFact[]): SelectedComment[] {
  return comments.map(comment => {
    const withheld = jiraWithheld(comment);
    return {
      id: comment.commentId,
      author: comment.authorAccountId ? `account ${comment.authorAccountId}` : 'unknown account',
      association: 'JIRA',
      createdAt: comment.createdAt,
      body: withheld ? '' : (comment.text ?? ''),
      ...(withheld ? { withheld } : {}),
    };
  });
}

const bytes = (text: string) => new TextEncoder().encode(text).length;
/** Bytes a comment costs besides its text (header line and fence). */
const commentOverheadBytes = 200;
/**
 * Bound of the comments of one Ticket, in UTF-8 bytes, in both origins (tickets #77 and #78 raised it from 8,000, and from the 2,000 to
 * 8,000 a Card had). It has to hold the largest Verdict comment a Triage publishes (a 24,000-byte Verdict text under its heading) whole,
 * with room for later comments of people: the Verdict is the only thing the Builder gets from the Triage, so it is never the part that
 * is cut. The Card's own text travels beside it under its own bound.
 */
export const ticketCommentsBound = 32000;
/** The longest beginning of `text` within `maxBytes`, cut between characters. */
function beginning(text: string, maxBytes: number): string {
  let kept = '';
  let used = 0;
  for (const character of text) {
    used += bytes(character);
    if (used > maxBytes) break;
    kept += character;
  }
  return kept;
}
/**
 * Keeps the most recent comments that fit `maxBytes`; the oldest are omitted and counted. The most recent comment is always delivered:
 * alone above the bound, it keeps its beginning and is marked `cut`.
 */
export function boundTicketComments(selected: readonly SelectedComment[], maxBytes: number): BoundedComments {
  const kept: SelectedComment[] = [];
  let used = 0;
  for (const comment of [...selected].reverse()) {
    const cost = bytes(comment.body) + commentOverheadBytes;
    if (used + cost > maxBytes) {
      if (!kept.length) kept.unshift({ ...comment, body: beginning(comment.body, Math.max(0, maxBytes - commentOverheadBytes)), cut: true });
      break;
    }
    kept.unshift(comment);
    used += cost;
  }
  return { comments: kept, selected: selected.length, omitted: selected.length - kept.length };
}

const withheldNote = {
  restricted: 'visibility-restricted comment',
  unreadable: 'its body is not readable as text',
};
function commentLines(comment: SelectedComment, position: number, total: number, fenced: (text: string) => string): string[] {
  const head = `Comment ${position} of ${total}, by ${comment.author} (${comment.association}) at ${comment.createdAt}`;
  if (comment.withheld)
    return [
      `${head} (text withheld by the Factory controller: ${withheldNote[comment.withheld]}; if it is required, treat it as an inaccessible required source).`,
    ];
  return [`${head}${comment.cut ? ' (cut: only its beginning is kept)' : ''}:`, fenced(comment.body)];
}
/** The comments as prompt lines, each fenced as data; a cut is stated before them, never silent. */
export function ticketCommentsLines(bounded: BoundedComments, fenced: (text: string) => string): string[] {
  const cut = bounded.omitted > 0 || bounded.comments.some(comment => comment.cut);
  const first = bounded.selected - bounded.comments.length + 1;
  return [
    ...(cut
      ? [
          `Comments were cut at the controller's bound: the ${bounded.omitted} oldest of ${bounded.selected} are omitted and the most recent are kept. ` +
            'If a cut part is required, treat it as an inaccessible required source (blocker); never fetch it yourself.',
        ]
      : []),
    ...bounded.comments.flatMap((comment, index) => commentLines(comment, first + index, bounded.selected, fenced)),
  ];
}
