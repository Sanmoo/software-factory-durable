import type { TicketRef } from '../../issue-tracker/index.js';
import { deliveryComment } from '../rules/jira-notices.js';
import { workShortRef } from '../rules/jira-links.js';
import { commentUnsettled, intendJiraComment, jiraComments, type JiraCommentOwner } from './jira-comments.js';
import { desireJiraLink, jiraLinks } from './jira-links.js';
import type { Session } from './store.js';

// Jira ticket 09 (spec §5 "Percurso normal"/"Percurso interrompido"): what the Card is told when the Work's own PR is merged. The delivery
// itself is GitHub's merge, committed first; inside that SAME commit only intents are recorded (the link's desired state `delivered` and the
// delivery notice), and the Card hears about it whenever Jira answers. Neither intent changes the Work, its result or the Card's status.

type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
export const deliveryNoticeRef = (workId: string) => `delivery:${workId}`;

/**
 * Inside the delivery commit (nothing for a GitHub Work): desire the link `delivered` and intend the delivery notice. A notice already
 * intended for this Work is never intended again (one notice per Work, whatever the number of merge observations).
 */
export async function intendJiraDelivery(
  tx: Tx,
  input: { work: { work_id: string; ticket: TicketRef; queue: { sequence: number } }; url: string; base: string },
) {
  const { work } = input;
  if (work.ticket.tracker !== 'jira') return;
  const link = await desireJiraLink(tx, { work, url: input.url, desired: 'delivered' });
  const document = await tx.doc(jiraComments);
  if (Object.values(document.effects).some(effect => effect.purpose.kind === 'delivery' && effect.purpose.workId === work.work_id)) return;
  const workRef = link?.workRef ?? workShortRef(work.queue.sequence);
  await intendJiraComment(tx, {
    destination: { ...work.ticket },
    purpose: { kind: 'delivery', workId: work.work_id },
    refPrefix: 'delivery',
    logicalRef: deliveryNoticeRef(work.work_id),
    content: () => deliveryComment({ workRef, base: input.base, url: input.url }),
  });
}

/** The delivery is a fact: its notice is always wanted (never withdrawn), posted when Jira answers and reconciled after any uncertain POST. */
export const jiraDeliveryOwner: JiraCommentOwner = { wanted: async () => 'post' };

/**
 * Retention protections of a Work's Card communication still unsettled (the link not confirmed, the delivery notice not published): the
 * Work is not forgotten under them, so its pending reference stays visible with the Work.
 */
export async function jiraDeliveryProtections(tx: Tx, work_id: string): Promise<string[]> {
  const reasons: string[] = [];
  const link = (await tx.doc(jiraLinks)).links[work_id];
  if (link?.state === 'pending') reasons.push(`EFFECT_UNSETTLED:jira-link:${work_id}`);
  for (const effect of Object.values((await tx.doc(jiraComments)).effects)) {
    if (effect.purpose.kind === 'delivery' && effect.purpose.workId === work_id && commentUnsettled(effect))
      reasons.push(`EFFECT_UNSETTLED:jira-notice:${effect.effectId}`);
  }
  return reasons;
}
