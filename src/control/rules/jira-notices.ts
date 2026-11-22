// Jira ticket 05 (spec §3 step 4, §4 last paragraph): pure rules of the impediment notice told on a refused Card and of the reconciliation
// of any automatic Jira comment whose POST outcome is uncertain. No I/O, clock, storage or Jira types.
import type { JiraEvaluation, JiraReason, JiraReasonCode } from './jira-admission.js';

/** Reasons a Card may be told about: known impediments whose `nextStep` never names a neighbour (it may be in a restricted project). */
const communicable: ReadonlySet<JiraReasonCode> = new Set(['JIRA_ROUTE_NONE', 'JIRA_ROUTE_DIVERGENT', 'JIRA_BLOCKER_NOT_DONE', 'JIRA_LINK_TYPE_CUSTOM',
  'JIRA_LINK_DIRECTION_AMBIGUOUS']);
export type NoticeLocalCode = 'JIRA_NOTICE_NOT_CANDIDATE' | 'JIRA_NOTICE_ELIGIBLE' | 'JIRA_NOTICE_UNVERIFIABLE' | 'JIRA_NOTICE_AUDIENCE_UNCERTAIN';
export type NoticeDecision = { kind: 'notify'; reasonKey: string; steps: string[] } | { kind: 'already-notified'; reasonKey: string } |
  { kind: 'local'; code: NoticeLocalCode; reasonKey: string | null };

/**
 * Identity of the impediment as the Card would read it: the communicable codes and the configuration data they carry (divergent
 * repositories). Neighbour identities are local diagnosis and never part of it: another hidden blocker is the same visible impediment.
 */
function reasonKey(reasons: readonly JiraReason[]): string {
  return [...new Set(reasons.map(reason => reason.code === 'JIRA_ROUTE_DIVERGENT' ? `${reason.code}(${[...(reason.repositories ?? [])].sort().join(',')})` : reason.code))]
    .sort().join('+');
}

/**
 * Whether the notice's audience is confirmed, from observed facts only: the comment is posted without a visibility restriction, so it
 * reaches whoever can see the Card; that audience is acceptable when the Card itself was just re-read by ID with the configured account
 * (`cardReread`) and the text carries no data of another issue (no neighbour key or ID in any step). It never claims more: who can see the
 * Card is not provable by one account (`doctor` keeps `commentAudience` unverified).
 */
function audienceConfirmed(cardReread: boolean, reasons: readonly JiraReason[], steps: readonly string[]): boolean {
  if (!cardReread) return false;
  const neighbours = reasons.flatMap(reason => reason.blocker ? [reason.blocker.key, reason.blocker.issueId] : []).filter(Boolean);
  return !steps.some(step => neighbours.some(neighbour => new RegExp(`(?<![A-Za-z0-9-])${neighbour.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(step)));
}

/**
 * Whether a freshly evaluated Card is told why its Work did not start (spec §3 step 4). Only a `blocked` Card whose label was just re-read
 * (intent confirmed) and whose audience is confirmed ({@link audienceConfirmed}) is told; the same impediment is never told twice in a row,
 * a different one is. Label gone, eligible, unverifiable or an audience that cannot be confirmed: local only.
 */
export function impedimentNotice(input: { evaluation: JiraEvaluation; cardReread: boolean; notified: string | null }): NoticeDecision {
  const { evaluation } = input;
  if (evaluation.decision === 'not-candidate') return { kind: 'local', code: 'JIRA_NOTICE_NOT_CANDIDATE', reasonKey: null };
  if (evaluation.decision === 'eligible') return { kind: 'local', code: 'JIRA_NOTICE_ELIGIBLE', reasonKey: null };
  const told = evaluation.reasons.filter(reason => communicable.has(reason.code));
  if (evaluation.decision === 'unverifiable' || !told.length) return { kind: 'local', code: 'JIRA_NOTICE_UNVERIFIABLE', reasonKey: null };
  const key = reasonKey(told);
  const steps = [...new Set(told.map(reason => reason.nextStep))];
  if (!audienceConfirmed(input.cardReread, evaluation.reasons, steps)) return { kind: 'local', code: 'JIRA_NOTICE_AUDIENCE_UNCERTAIN', reasonKey: key };
  if (input.notified === key) return { kind: 'already-notified', reasonKey: key };
  return { kind: 'notify', reasonKey: key, steps };
}

/** Text of an automatic comment: the reserved header first (spec §4: it marks text that is never an instruction), then plain lines. */
export type FactoryCommentContent = { header: string; lines: string[] };
/** Reserved header `[Software Factory · <Kind> <ref>]` (spec §4 table). */
export const reservedHeader = (kind: string, ref: string) => `[Software Factory · ${kind} ${ref}]`;
export function impedimentComment(input: { ref: string; steps: readonly string[] }): FactoryCommentContent {
  const header = reservedHeader('Impedimento', input.ref);
  return { header, lines: [header, 'The Software Factory did not start a Work for this Card:', ...input.steps.map(step => `- ${step}`),
    'This notice is not repeated while the same impediment persists; the next poll reads the Card again.'] };
}

/**
 * Jira ticket 09 (spec §5): the delivery notice, one line led by the reserved header, e.g.
 * `[Software Factory · Entrega T-17] O PR foi integrado a main: <URL>`. Its header names the Work, so it is told once per Work.
 */
export function deliveryComment(input: { workRef: string; base: string; url: string }): FactoryCommentContent {
  const header = reservedHeader('Entrega', input.workRef);
  return { header, lines: [`${header} O PR foi integrado a ${input.base}: ${input.url}`] };
}

/** Whether a comment's first line is led by `header` (alone, or followed by a space and the rest of that line). */
const ledBy = (text: string, header: string) => { const first = text.split('\n')[0]?.trim() ?? ''; return first === header || first.startsWith(`${header} `); };

/**
 * A visible comment as reconciliation compares it: author account, plain text projected from its ADF, and whether it carries a visibility
 * restriction. `null` = not observed (no author, or a body that is not ADF): such a comment is never one of the Factory's copies.
 */
export type ObservedComment = { commentId: string; accountId: string | null; text: string | null; restricted: boolean };
export type CommentReconciliation = { kind: 'confirmed'; commentId: string } | { kind: 'absent' } |
  { kind: 'pending'; code: 'JIRA_COMMENT_MULTIPLE' | 'JIRA_COMMENT_SIMILAR' | 'JIRA_ACCOUNT_UNKNOWN' | string; candidates?: string[] };

/**
 * After an uncertain POST (spec §4): compare the Factory account, the reserved header (logical reference) and the content of every visible
 * comment. One exact own copy confirms; none in a COMPLETE read is absent (the same reference may be sent again); several, an own copy with
 * the same header but other content or a restriction, an incomplete read or an unknown account stay pending. Another account's copy of the
 * header proves nothing (it is ignored). This bounds the logical effect; it never guarantees a single visual copy.
 */
export function commentReconciliation(input: { listing: { kind: 'complete'; comments: readonly ObservedComment[] } | { kind: 'incomplete'; code: string };
  account: string | null; expected: FactoryCommentContent }): CommentReconciliation {
  if (input.listing.kind === 'incomplete') return { kind: 'pending', code: input.listing.code };
  if (input.account === null) return { kind: 'pending', code: 'JIRA_ACCOUNT_UNKNOWN' };
  const text = input.expected.lines.join('\n');
  const own = input.listing.comments.filter(comment => comment.accountId === input.account && comment.text !== null && ledBy(comment.text, input.expected.header));
  const exact = own.filter(comment => comment.text === text && !comment.restricted);
  if (own.length > exact.length) return { kind: 'pending', code: 'JIRA_COMMENT_SIMILAR', candidates: own.map(comment => comment.commentId) };
  if (exact.length > 1) return { kind: 'pending', code: 'JIRA_COMMENT_MULTIPLE', candidates: exact.map(comment => comment.commentId) };
  return exact.length === 1 ? { kind: 'confirmed', commentId: exact[0]!.commentId } : { kind: 'absent' };
}
