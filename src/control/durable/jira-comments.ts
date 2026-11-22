import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { JiraTicketRef } from '../../issue-tracker/index.js';
import type { JiraOriginTracker } from '../types.js';
import { commentReconciliation, type FactoryCommentContent } from '../rules/jira-notices.js';
import type { Session } from './store.js';

// Jira ticket 05 (spec §4 last paragraph): recoverable automatic Jira comments, reused by every Jira notice (impediments now, Questions in
// ticket 06, delivery in ticket 09). The destination, logical reference and content are committed BEFORE the POST; an unknown outcome or an
// interrupted attempt is reconciled against every visible comment of the Card before anything else. One exact own copy confirms; none in
// a complete read allows a new POST with the SAME reference (unlike GitHub's stricter rule); several copies, an edited own copy, an
// incomplete read or denied access stay pending with a diagnosis and no blind POST.

/** What the comment is for; its owner decides whether it is still wanted (tickets 06/09 add their kinds). */
export type JiraCommentPurpose = { kind: 'impediment'; ticketKey: string; reasonKey: string };
export type JiraCommentState = 'intended' | 'attempting' | 'unknown' | 'pending' | 'failed' | 'published' | 'withdrawn' | 'abandoned';
export type JiraCommentEffect = { effectId: string; logicalRef: string; destination: JiraTicketRef; purpose: JiraCommentPurpose;
  /** Plain lines (header first); the ADF sent is one paragraph per line, so the stored lines ARE the content. */
  content: FactoryCommentContent; state: JiraCommentState; recordedAt: string; updatedAt: string;
  attempts: { at: string; outcome: 'published' | 'failed' | 'unknown' | 'interrupted'; code?: string }[];
  reconciliations: { at: string; outcome: 'confirmed' | 'absent' | 'pending'; code?: string; candidates?: string[] }[];
  comment: { commentId: string; url: string } | null;
  /** Earliest instant of the next POST after Jira asked to wait (429/5xx Retry-After). */
  notBefore?: string;
  diagnostic: { code: string; nextStep: string; at: string } | null };

/** Every Jira comment effect of the installation (storage format 3); settled ones are kept, bounded, unsettled ones never dropped. */
export const jiraComments = defineDoc<{ effects: Record<string, JiraCommentEffect> }>({ kind: 'factory.jira-comment', version: 1, scope: 'session',
  initial: () => ({ effects: {} }), checkpointWhen: () => true });
type Tx = Parameters<Parameters<Session['commit']>[0]>[0];

const unsettledStates: ReadonlySet<JiraCommentState> = new Set(['intended', 'attempting', 'unknown', 'pending', 'failed']);
export const commentUnsettled = (effect: Pick<JiraCommentEffect, 'state'>) => unsettledStates.has(effect.state);
const maxSettled = 200;
const maxKnownFailures = 5;
/** POSTs whose outcome stayed unknown and were then found absent: beyond this the effect is abandoned (never an endless repost loop). */
const maxUncertainPosts = 3;
const keep = <T>(items: T[]) => items.slice(-20);

/** Records the intent of one automatic comment INSIDE the caller's commit (with whatever decided it). The logical reference is fixed here. */
export async function intendJiraComment(tx: Tx, input: { destination: JiraTicketRef; purpose: JiraCommentPurpose; content: (ref: string) => FactoryCommentContent;
  refPrefix: string }): Promise<JiraCommentEffect> {
  const document = await tx.doc(jiraComments);
  const effectId = randomUUID();
  const logicalRef = `${input.refPrefix}-${effectId.slice(0, 8)}`;
  const at = new Date().toISOString();
  const effect: JiraCommentEffect = { effectId, logicalRef, destination: input.destination, purpose: input.purpose, content: input.content(logicalRef), state: 'intended',
    recordedAt: at, updatedAt: at, attempts: [], reconciliations: [], comment: null, diagnostic: null };
  document.effects[effectId] = effect;
  const settled = Object.values(document.effects).filter(item => !commentUnsettled(item)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const old of settled.slice(0, Math.max(0, settled.length - maxSettled))) delete document.effects[old.effectId];
  return effect;
}

export async function readJiraComments(session: Session): Promise<JiraCommentEffect[]> {
  const document = await session.snapshot(jiraComments, BACKGROUND_CONTEXT);
  return Object.values(document?.effects ?? {}).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.effectId.localeCompare(b.effectId));
}

/** `post`: send now; `wait`: keep the intent for a later pass; `withdraw`: the reason is gone (label removed, superseded), never sent. */
export type CommentWanted = 'post' | 'wait' | 'withdraw';
export type JiraCommentOwner = { wanted(tx: Tx, effect: JiraCommentEffect): Promise<CommentWanted>; withdrawn?(tx: Tx, effect: JiraCommentEffect): Promise<void> };

/**
 * One pass over every unsettled Jira comment: reconcile first whatever may already exist (interrupted attempt, unknown outcome, pending
 * ambiguity), then POST at most once per effect whose owner still wants it. Never more than one listing and one POST per effect per pass:
 * the next poll re-reads (no tight loop). The Factory account is read on demand (`GET /myself`) or learned from a created comment.
 */
export function createJiraCommentDesk(deps: { session: Session; tracker: JiraOriginTracker; owner: JiraCommentOwner; stopped?: () => boolean }) {
  const { session, tracker } = deps;
  const accounts = new Map<string, string>();
  const stopped = deps.stopped ?? (() => false);
  const onEffect = <T>(effectId: string, change: (effect: JiraCommentEffect, tx: Tx, at: string) => Promise<T> | T) => session.commit(async tx => {
    const effect = (await tx.doc(jiraComments)).effects[effectId];
    if (!effect) return 'stale' as const;
    const at = new Date().toISOString();
    const result = await change(effect, tx, at);
    effect.updatedAt = at;
    return result;
  }, BACKGROUND_CONTEXT);

  async function account(siteId: string): Promise<string | null> {
    const known = accounts.get(siteId);
    if (known) return known;
    const observed = await tracker.readAccount(siteId).catch(() => undefined);
    if (observed?.kind !== 'observed') return null;
    accounts.set(siteId, observed.accountId);
    return observed.accountId;
  }

  async function reconcile(effect: JiraCommentEffect): Promise<JiraCommentState | 'stale'> {
    const listing = await tracker.listComments(effect.destination).catch(() => undefined);
    const owner = listing?.kind === 'observed' ? await account(effect.destination.siteId) : null;
    const outcome = commentReconciliation({ expected: effect.content, account: owner,
      listing: listing?.kind === 'observed' ? { kind: 'complete', comments: listing.comments.map(item => ({ commentId: item.commentId, accountId: item.authorAccountId,
        text: item.text, restricted: item.restricted })) } : { kind: 'incomplete', code: listing?.code ?? 'JIRA_UNEXPECTED_FAILURE' } });
    return onEffect(effect.effectId, (current, _tx, at) => {
      if (current.state !== effect.state) return 'stale' as const;
      if (current.state === 'attempting') current.attempts = keep([...current.attempts, { at, outcome: 'interrupted' }]);
      current.reconciliations = keep([...current.reconciliations, { at, outcome: outcome.kind, ...(outcome.kind === 'pending' ? { code: outcome.code,
        ...(outcome.candidates ? { candidates: outcome.candidates.slice(0, 10) } : {}) } : {}) }]);
      if (outcome.kind === 'confirmed') {
        current.state = 'published';
        current.comment = { commentId: outcome.commentId, url: `${current.destination.url}?focusedCommentId=${outcome.commentId}` };
        current.diagnostic = null;
      } else if (outcome.kind === 'pending') {
        current.state = 'pending';
        current.diagnostic = { code: outcome.code, at, nextStep: outcome.code === 'JIRA_COMMENT_MULTIPLE' || outcome.code === 'JIRA_COMMENT_SIMILAR'
          ? `More than one own comment, or an edited one, carries ${current.logicalRef}: nothing is reposted or deleted; the operator may remove the extra copy.`
          : `The Card's comments could not be read completely (${outcome.code}); nothing is reposted blindly, the next poll reads again.` };
      } else if (current.attempts.filter(item => item.outcome === 'unknown' || item.outcome === 'interrupted').length >= maxUncertainPosts) {
        current.state = 'abandoned';
        current.diagnostic = { code: 'JIRA_COMMENT_REPOST_LIMIT', at, nextStep: `${current.logicalRef} was never observed after ${maxUncertainPosts} uncertain POSTs; it is not sent again.` };
      } else {
        // Absent in a complete read: the same reference may be sent again (spec §4), if its owner still wants it.
        current.state = 'intended';
        current.diagnostic = null;
      }
      return current.state;
    });
  }

  async function post(effect: JiraCommentEffect) {
    const begun = await onEffect(effect.effectId, async (current, tx, at) => {
      if (current.state !== 'intended' && current.state !== 'failed') return 'stale' as const;
      if (current.notBefore && current.notBefore > at) return 'stale' as const;
      const wanted = await deps.owner.wanted(tx, current);
      if (wanted === 'withdraw') {
        current.state = 'withdrawn';
        await deps.owner.withdrawn?.(tx, current);
        return 'withdrawn' as const;
      }
      if (wanted === 'wait') return 'stale' as const;
      current.state = 'attempting';
      return 'attempting' as const;
    });
    if (begun !== 'attempting') return;
    const result = await tracker.publishComment(effect.destination, { lines: effect.content.lines }).catch(() => undefined);
    await onEffect(effect.effectId, (current, _tx, at) => {
      if (current.state !== 'attempting') return;
      if (result?.kind === 'published') {
        if (result.authorAccountId) accounts.set(current.destination.siteId, result.authorAccountId);
        current.state = 'published';
        current.comment = { commentId: result.commentId, url: result.url };
        current.attempts = keep([...current.attempts, { at, outcome: 'published' }]);
        current.diagnostic = null;
        return;
      }
      const code = result?.code ?? 'JIRA_UNEXPECTED_FAILURE';
      current.attempts = keep([...current.attempts, { at, outcome: result?.kind === 'failed' ? 'failed' : 'unknown', code }]);
      if (result?.kind === 'failed') {
        const failures = current.attempts.filter(item => item.outcome === 'failed').length;
        current.state = failures >= maxKnownFailures ? 'abandoned' : 'failed';
        if (result.waitSeconds !== undefined) current.notBefore = new Date(Date.parse(at) + result.waitSeconds * 1000).toISOString();
        current.diagnostic = { code, at, nextStep: failures >= maxKnownFailures ? `Jira refused ${current.logicalRef} ${failures} times; it is not sent again. ${result.nextStep}` : result.nextStep };
      } else {
        current.state = 'unknown';
        current.diagnostic = { code, at, nextStep: 'The comment may exist: the next pass reconciles it against the Card\'s visible comments before any new POST.' };
      }
    });
  }

  return {
    async pass() {
      for (const effect of await readJiraComments(session)) {
        if (stopped()) return;
        if (!commentUnsettled(effect)) continue;
        let state: JiraCommentState | 'stale' = effect.state;
        if (state === 'attempting' || state === 'unknown' || state === 'pending') state = await reconcile(effect);
        if (stopped()) return;
        if (state === 'intended' || state === 'failed') await post({ ...effect, state });
      }
    },
  };
}
