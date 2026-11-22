import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { JiraTicketRef } from '../../issue-tracker/index.js';
import type { JiraOriginTracker } from '../types.js';
import { commentReconciliation, type FactoryCommentContent } from '../rules/jira-notices.js';
import { jiraCommentBackoffSeconds, retryNotBefore } from './jira-retry.js';
import type { Session } from './store.js';

// Jira ticket 05 (spec §4 last paragraph): recoverable automatic Jira comments, reused by every Jira notice (impediments now, Questions in
// ticket 06, delivery in ticket 09). The destination, logical reference and content are committed BEFORE the POST; an unknown outcome or an
// interrupted attempt is reconciled against every visible comment of the Card before anything else. One exact own copy confirms; none in
// a complete read allows a new POST with the SAME reference (unlike GitHub's stricter rule); several copies, an edited own copy, an
// incomplete read or denied access stay pending with a diagnosis and no blind POST.

/** What the comment is for; its owner decides whether it is still wanted (tickets 06/09 add their kinds). */
export type JiraCommentPurpose = { kind: 'impediment'; ticketKey: string; reasonKey: string } |
  /** Jira ticket 06: a Question of a Jira Work, published on its origin Card. */
  { kind: 'question'; questionId: string; workId: string } |
  /** Jira ticket 06: guidance to a `/factory` comment of the Card that did not apply (by its ingress request). */
  { kind: 'reply'; workId: string; request_id: string } |
  /** Jira ticket 09: the delivery notice of a Work whose own PR was merged (told once; delivery never depends on it). */
  { kind: 'delivery'; workId: string };
/** An unsettled effect is never abandoned (spec §4/§5): it stays pending and visible, retried with bounded backoff, never blindly. */
export type JiraCommentState = 'intended' | 'attempting' | 'unknown' | 'pending' | 'failed' | 'published' | 'withdrawn';
export type JiraCommentEffect = { effectId: string; logicalRef: string; destination: JiraTicketRef; purpose: JiraCommentPurpose;
  /** Plain lines (header first); the ADF sent is one paragraph per line, so the stored lines ARE the content. */
  content: FactoryCommentContent; state: JiraCommentState; recordedAt: string; updatedAt: string;
  attempts: { at: string; outcome: 'published' | 'failed' | 'unknown' | 'interrupted'; code?: string }[];
  reconciliations: { at: string; outcome: 'confirmed' | 'absent' | 'pending'; code?: string; candidates?: string[] }[];
  /** `createdAt`: Jira's own creation instant of the comment, when observed (POST answer or reconciliation listing). */
  comment: { commentId: string; url: string; createdAt?: string } | null;
  /** Earliest instant of the next POST after Jira asked to wait (429/5xx Retry-After). */
  notBefore?: string;
  diagnostic: { code: string; nextStep: string; at: string } | null };

/** Every Jira comment effect of the installation (storage format 3); settled ones are kept, bounded, unsettled ones never dropped. */
/** `sequences`: per prefix, the last short reference handed out (`Q-17`); never reused. */
export const jiraComments = defineDoc<{ effects: Record<string, JiraCommentEffect>; sequences?: Record<string, number> }>({ kind: 'factory.jira-comment', version: 1, scope: 'session',
  initial: () => ({ effects: {} }), checkpointWhen: () => true });
type Tx = Parameters<Parameters<Session['commit']>[0]>[0];

const unsettledStates: ReadonlySet<JiraCommentState> = new Set(['intended', 'attempting', 'unknown', 'pending', 'failed']);
export const commentUnsettled = (effect: Pick<JiraCommentEffect, 'state'>) => unsettledStates.has(effect.state);
const maxSettled = 200;
/**
 * Jira ticket 10 (spec §1): the host could not read the Jira token, so nothing was sent and Jira refused nothing. Such an attempt never
 * counts toward the backoff: the effect stays pending (retried every pass) until the token file is restored.
 */
const credentialMissing = 'JIRA_CREDENTIAL_UNAVAILABLE';
/** Attempts that did not publish (known refusals, uncertain or interrupted POSTs), the token's absence aside: they set the backoff. */
const unsuccessful = (effect: JiraCommentEffect) => effect.attempts.filter(item => item.outcome !== 'published' && item.code !== credentialMissing).length;
/**
 * The next POST waits for the later of Jira's Retry-After and the bounded backoff of the attempts so far, counted from the last attempt
 * (a reconciliation later than the POST does not push the retry further away).
 */
function backOff(effect: JiraCommentEffect, at: string, waitSeconds?: number) {
  const since = effect.attempts.at(-1)?.at ?? at;
  const candidates = [retryNotBefore(since, jiraCommentBackoffSeconds(unsuccessful(effect))), ...(waitSeconds !== undefined ? [retryNotBefore(at, waitSeconds)] : [])];
  const notBefore = candidates.sort().at(-1)!;
  if (notBefore > at) effect.notBefore = notBefore; else delete effect.notBefore;
}
const keep = <T>(items: T[]) => items.slice(-20);

/**
 * Records the intent of one automatic comment INSIDE the caller's commit (with whatever decided it). The logical reference is fixed here:
 * `<prefix>-<effect id prefix>`, or with `sequenced` the next installation-wide number of that prefix (`Q-17`, short enough to type).
 */
export async function intendJiraComment(tx: Tx, input: { destination: JiraTicketRef; purpose: JiraCommentPurpose; content: (ref: string) => FactoryCommentContent;
  refPrefix: string; sequenced?: boolean;
  /** Jira ticket 09: a reference fixed by the caller (`delivery:<work_id>`), instead of a prefix-based one. */ logicalRef?: string }): Promise<JiraCommentEffect> {
  const document = await tx.doc(jiraComments);
  const effectId = randomUUID();
  let logicalRef = input.logicalRef ?? `${input.refPrefix}-${effectId.slice(0, 8)}`;
  if (input.sequenced && input.logicalRef === undefined) {
    const sequences = document.sequences ??= {};
    sequences[input.refPrefix] = (sequences[input.refPrefix] ?? 0) + 1;
    logicalRef = `${input.refPrefix}-${sequences[input.refPrefix]}`;
  }
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
/** `observed`: called inside every commit that changed the effect (its owner may mirror the state, e.g. the Question's publication). */
export type JiraCommentOwner = { wanted(tx: Tx, effect: JiraCommentEffect): Promise<CommentWanted>; withdrawn?(tx: Tx, effect: JiraCommentEffect): Promise<void>;
  observed?(tx: Tx, effect: JiraCommentEffect): Promise<void> };
/**
 * One owner for the single desk: each purpose kind is handled by its own owner; a kind without one waits (never posted nor withdrawn by a
 * stranger). Tickets 06/09 add their kinds here.
 */
export function composeJiraCommentOwners(owners: { [K in JiraCommentPurpose['kind']]?: JiraCommentOwner }): JiraCommentOwner {
  const of = (effect: JiraCommentEffect) => owners[effect.purpose.kind];
  return {
    wanted: async (tx, effect) => await of(effect)?.wanted(tx, effect) ?? 'wait',
    withdrawn: async (tx, effect) => { await of(effect)?.withdrawn?.(tx, effect); },
    observed: async (tx, effect) => { await of(effect)?.observed?.(tx, effect); },
  };
}

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
    if (result === 'stale') return result;
    effect.updatedAt = at;
    await deps.owner.observed?.(tx, effect);
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
        const createdAt = listing?.kind === 'observed' ? listing.comments.find(item => item.commentId === outcome.commentId)?.createdAt : undefined;
        current.comment = { commentId: outcome.commentId, url: `${current.destination.url}?focusedCommentId=${outcome.commentId}`, ...(createdAt ? { createdAt } : {}) };
        current.diagnostic = null;
      } else if (outcome.kind === 'pending') {
        current.state = 'pending';
        current.diagnostic = { code: outcome.code, at, nextStep: outcome.code === 'JIRA_COMMENT_MULTIPLE' || outcome.code === 'JIRA_COMMENT_SIMILAR'
          ? `More than one own comment, or an edited one, carries ${current.logicalRef}: nothing is reposted or deleted; the operator may remove the extra copy.`
          : `The Card's comments could not be read completely (${outcome.code}); nothing is reposted blindly, the next poll reads again.` };
      } else {
        // Absent in a complete read: the same reference may be sent again (spec §4), if its owner still wants it, after the backoff.
        current.state = 'intended';
        backOff(current, at);
        current.diagnostic = unsuccessful(current) > 1 ? { code: 'JIRA_COMMENT_ABSENT_AFTER_UNCERTAIN_POST', at,
          nextStep: `${current.logicalRef} was not found after ${unsuccessful(current)} uncertain POSTs; it stays pending and is sent again with the same reference${current.notBefore ? ` after ${current.notBefore}` : ''}.` } : null;
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
        current.comment = { commentId: result.commentId, url: result.url, createdAt: result.createdAt };
        current.attempts = keep([...current.attempts, { at, outcome: 'published' }]);
        current.diagnostic = null;
        return;
      }
      const code = result?.code ?? 'JIRA_UNEXPECTED_FAILURE';
      current.attempts = keep([...current.attempts, { at, outcome: result?.kind === 'failed' ? 'failed' : 'unknown', code }]);
      if (result?.kind === 'failed') {
        current.state = 'failed';
        // A missing token sent nothing: retried every pass (Retry-After aside), whatever was refused before.
        if (code === credentialMissing) { if (result.waitSeconds !== undefined) current.notBefore = retryNotBefore(at, result.waitSeconds); else delete current.notBefore; }
        else backOff(current, at, result.waitSeconds);
        current.diagnostic = { code, at, nextStep: code === credentialMissing
          ? `${result.nextStep} ${current.logicalRef} stays pending on this Card and is sent on the next poll after the token file is restored; it is never sent elsewhere.`
          : `${result.nextStep} ${current.logicalRef} stays pending on this Card and is retried with backoff${current.notBefore ? ` (next after ${current.notBefore})` : ''}; it is never abandoned.` };
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
