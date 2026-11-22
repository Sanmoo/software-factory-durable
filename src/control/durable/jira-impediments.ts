import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { JiraTicketRef } from '../../issue-tracker/index.js';
import type { JiraNoticeStatus, JiraOriginTracker, TicketSource } from '../types.js';
import { ticketKey } from '../rules/admission.js';
import type { JiraEvaluation, JiraReason } from '../rules/jira-admission.js';
import { impedimentComment, impedimentNotice, type NoticeDecision } from '../rules/jira-notices.js';
import { composeJiraCommentOwners, createJiraCommentDesk, intendJiraComment, readJiraComments, type CommentWanted, type JiraCommentEffect, type JiraCommentOwner,
  type JiraCommentPurpose } from './jira-comments.js';
import type { JiraCandidateEvaluation, JiraSourceEvaluation } from './jira-evaluation.js';
import type { Session } from './store.js';

// Jira ticket 05 (spec §3 step 4): pre-admission impediments of Jira Cards, indexed by Ticket and reason, WITHOUT a Work. A blocked Card
// whose intent (label just re-read) and audience are confirmed is told why and how to correct it, once per impediment; anything else is a
// local diagnosis visible in the Control's status.

type JiraSource = Extract<TicketSource, { tracker: 'jira' }>;
export type JiraImpedimentRecord = { ticketKey: string; ticket: JiraTicketRef;
  /** Latest fresh evaluation and what it led to; `reasons` include local-only diagnosis (neighbour identity) and are never posted. */
  latest: { at: string; observedAt: string; decision: JiraEvaluation['decision']; reasonKey: string | null; notice: NoticeDecision['kind']; localCode: string | null;
    reasons: JiraReason[] };
  /** Reason key of the last notice intended for this Card (cleared when that notice is withdrawn unsent). */
  notified: string | null; effects: string[];
  history: { at: string; decision: JiraEvaluation['decision']; reasonKey: string | null; notice: NoticeDecision['kind'] }[] };
/** Storage format 3 document: pre-admission impediments by Jira Ticket key (never a fictitious Work). */
export const jiraImpediments = defineDoc<{ tickets: Record<string, JiraImpedimentRecord> }>({ kind: 'factory.jira-impediment', version: 1, scope: 'session',
  initial: () => ({ tickets: {} }), checkpointWhen: () => true });
const keep = <T>(items: T[]) => items.slice(-20);


/**
 * Records ONE fresh evaluation of a Jira Card and, in the same commit, the intent of its notice when the rule says to tell it. The audience
 * is the Card's own only when the evaluation re-read the Card from this source's site (the comment carries no visibility restriction and only
 * Card-safe text); otherwise it is uncertain and nothing is told.
 */
export async function recordJiraImpediment(session: Session, source: JiraSource, candidate: JiraCandidateEvaluation): Promise<NoticeDecision> {
  const key = ticketKey(candidate.ticket);
  const audience = candidate.ticket.siteId === source.siteId && candidate.ticket.url.startsWith(`${source.url}/browse/`) ? 'card' as const : 'unknown' as const;
  return session.commit(async tx => {
    const document = await tx.doc(jiraImpediments);
    const previous = document.tickets[key];
    const decision = impedimentNotice({ evaluation: candidate.evaluation, audience, notified: previous?.notified ?? null });
    const at = new Date().toISOString();
    const record: JiraImpedimentRecord = previous ?? { ticketKey: key, ticket: candidate.ticket, latest: undefined!, notified: null, effects: [], history: [] };
    record.ticket = candidate.ticket;
    record.latest = { at, observedAt: candidate.observedAt, decision: candidate.evaluation.decision, reasonKey: decision.reasonKey, notice: decision.kind,
      localCode: decision.kind === 'local' ? decision.code : null, reasons: candidate.evaluation.reasons.slice(0, 20) };
    const last = record.history.at(-1);
    if (!last || last.decision !== candidate.evaluation.decision || last.reasonKey !== decision.reasonKey || last.notice !== decision.kind) {
      record.history = keep([...record.history, { at, decision: candidate.evaluation.decision, reasonKey: decision.reasonKey, notice: decision.kind }]);
    }
    if (decision.kind === 'notify') {
      const effect = await intendJiraComment(tx, { destination: candidate.ticket, purpose: { kind: 'impediment', ticketKey: key, reasonKey: decision.reasonKey },
        refPrefix: 'I', content: ref => impedimentComment({ ref, steps: decision.steps }) });
      record.notified = decision.reasonKey;
      record.effects = keep([...record.effects, effect.effectId]);
    }
    document.tickets[key] = record;
    return decision;
  }, BACKGROUND_CONTEXT);
}

/**
 * Whether an impediment notice is still wanted. Posted only when its Card was evaluated in THIS round and is still blocked by the same
 * impediment (a Card that left the listing is never told on old facts); withdrawn when the label is gone, it became eligible or another
 * impediment superseded it; kept for later while the Card is unverifiable or was not evaluated.
 */
function impedimentOwner(evaluated: ReadonlySet<string>): JiraCommentOwner {
  return {
    async wanted(tx, effect): Promise<CommentWanted> {
      if (effect.purpose.kind !== 'impediment') return 'wait';
      const record = (await tx.doc(jiraImpediments)).tickets[effect.purpose.ticketKey];
      if (!record || record.effects.at(-1) !== effect.effectId) return 'withdraw';
      const { latest } = record;
      if (latest.decision === 'not-candidate' || latest.decision === 'eligible') return 'withdraw';
      if (latest.reasonKey !== null && latest.reasonKey !== effect.purpose.reasonKey) return 'withdraw';
      return evaluated.has(effect.purpose.ticketKey) && latest.reasonKey === effect.purpose.reasonKey && latest.notice !== 'local' ? 'post' : 'wait';
    },
    async withdrawn(tx, effect) {
      if (effect.purpose.kind !== 'impediment') return;
      const record = (await tx.doc(jiraImpediments)).tickets[effect.purpose.ticketKey];
      // The Card never read this notice: the same impediment may be told when it is observed again.
      if (record && record.notified === effect.purpose.reasonKey && record.effects.at(-1) === effect.effectId) record.notified = null;
    },
  };
}

export type JiraNoticeRound = { decisions: { ticket: JiraTicketRef; notice: NoticeDecision }[] };

/**
 * Entry point for the poller (Jira tickets 04/10): after `evaluateJiraSource` (or one `evaluateJiraTicket`), record each refused or
 * unverifiable Card and tell the ones the rule allows, then run one pass of the recoverable comment desk (which also reconciles earlier
 * uncertain notices, even when this round's listing was unavailable). Eligible Cards are recorded too (their unsent notice is withdrawn);
 * admitting them is ticket 04's. Callers run one round at a time.
 */
export async function noticeJiraImpediments(input: { session: Session; tracker: JiraOriginTracker; source: JiraSource;
  evaluation: JiraSourceEvaluation | { kind: 'candidates'; candidates: JiraCandidateEvaluation[] }; stopped?: () => boolean;
  /** Owners of the other comment purposes sharing this single desk pass (Jira ticket 06: questions, replies; 09: delivery). */
  owners?: { [K in Exclude<JiraCommentPurpose['kind'], 'impediment'>]?: JiraCommentOwner } }): Promise<JiraNoticeRound> {
  const candidates = input.evaluation.kind === 'unavailable' ? [] : input.evaluation.candidates;
  const decisions: JiraNoticeRound['decisions'] = [];
  const evaluated = new Set<string>();
  for (const candidate of candidates) {
    if (input.stopped?.()) break;
    decisions.push({ ticket: candidate.ticket, notice: await recordJiraImpediment(input.session, input.source, candidate) });
    evaluated.add(ticketKey(candidate.ticket));
  }
  const desk = createJiraCommentDesk({ session: input.session, tracker: input.tracker, owner: composeJiraCommentOwners({ ...input.owners, impediment: impedimentOwner(evaluated) }), ...(input.stopped ? { stopped: input.stopped } : {}) });
  await desk.pass();
  return { decisions };
}

export type JiraNoticesView = {
  impediments: (Pick<JiraImpedimentRecord, 'ticket' | 'notified'> & Pick<JiraImpedimentRecord['latest'], 'at' | 'decision' | 'reasonKey' | 'notice' | 'localCode'> &
    { reasons: string[] })[];
  comments: Pick<JiraCommentEffect, 'effectId' | 'logicalRef' | 'destination' | 'state' | 'comment' | 'diagnostic' | 'purpose'>[] };
/** Local diagnosis for status/inspection: every recorded Card (reason codes only) and every Jira comment effect with its state. */
export async function readJiraNotices(session: Session): Promise<JiraNoticesView> {
  // Both documents are read together (one round of the Session's read line; status reads race nothing else).
  const [document, effects] = await Promise.all([session.snapshot(jiraImpediments, BACKGROUND_CONTEXT), readJiraComments(session)]);
  const impediments = Object.values(document?.tickets ?? {}).sort((a, b) => a.ticketKey.localeCompare(b.ticketKey)).map(record => ({
    ticket: record.ticket, notified: record.notified, at: record.latest.at, decision: record.latest.decision, reasonKey: record.latest.reasonKey,
    notice: record.latest.notice, localCode: record.latest.localCode, reasons: record.latest.reasons.map(reason => reason.code) }));
  const comments = effects.map(({ effectId, logicalRef, destination, state, comment, diagnostic, purpose }) =>
    ({ effectId, logicalRef, destination, state, comment, diagnostic, purpose }));
  return { impediments, comments };
}

/** Status section (absent while no Jira Card was ever evaluated): the recorded Cards and the Jira comments not yet published. */
export async function jiraNoticeStatus(session: Session): Promise<{ jiraNotices?: JiraNoticeStatus }> {
  const view = await readJiraNotices(session);
  if (!view.impediments.length && !view.comments.length) return {};
  return { jiraNotices: { impediments: view.impediments.slice(-50), published: view.comments.filter(item => item.state === 'published').length,
    unpublished: view.comments.filter(item => item.state !== 'published').slice(-50) } };
}
