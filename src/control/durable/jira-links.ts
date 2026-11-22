import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { JiraTicketRef, RemoteLinkResult, TicketRef } from '../../issue-tracker/index.js';
import type { JiraLinkDesired, JiraLinkIntent, JiraLinkStatus, JiraOriginTracker } from '../types.js';
import { jiraLinkBackoffPasses, jiraLinkGlobalId, jiraLinkTitle, workShortRef } from '../rules/jira-links.js';
import type { Session } from './store.js';

// Jira ticket 08 (spec §5): the Work's ONE remote link on its Card. Its intent (desired state, URL, title) is committed in the same commit
// that fixes the own PR (or observes its closure / merge); a desk then upserts it by the Work's stable globalId. Only the LATEST desired
// state is applied: a confirmation of an older revision never settles a newer one. Independent of comments (ticket 05) and of the Work's
// cleanup, retention or forgetting: the intent lives in its own document and keeps everything it needs (destination, URL, reference).

/** Every Jira link intent of the installation by Work (storage format 3). One per Work; bounded only in settled ones of finished Works. */
export const jiraLinks = defineDoc<{ links: Record<string, JiraLinkIntent> }>({ kind: 'factory.jira-link', version: 1, scope: 'session',
  initial: () => ({ links: {} }), checkpointWhen: () => true });
type Tx = Parameters<Parameters<Session['commit']>[0]>[0];
const keep = <T>(items: T[]) => items.slice(-20);
const maxSettledFinal = 500;

/**
 * Records, INSIDE the caller's commit, the desired state of the Work's link on its Card (nothing for a GitHub Work). Same state and URL
 * as the latest one: unchanged (no new revision, nothing re-sent). Otherwise a new revision, pending, replaces the previous desire.
 */
export async function desireJiraLink(tx: Tx, input: { work: { work_id: string; ticket: TicketRef; queue: { sequence: number } }; url: string; desired: JiraLinkDesired }):
  Promise<JiraLinkIntent | null> {
  const { work } = input;
  if (work.ticket.tracker !== 'jira') return null;
  const document = await tx.doc(jiraLinks);
  const at = new Date().toISOString();
  const previous = document.links[work.work_id];
  // The Card's current presentation (key/url) goes with the intent; the upsert itself addresses the issue by its immutable ID.
  const destination: JiraTicketRef = { ...work.ticket };
  if (previous && previous.desired === input.desired && previous.url === input.url) {
    previous.destination = destination;
    return previous;
  }
  const workRef = previous?.workRef ?? workShortRef(work.queue.sequence);
  const intent: JiraLinkIntent = { workId: work.work_id, globalId: jiraLinkGlobalId(work.work_id), destination, workRef, url: input.url, desired: input.desired,
    title: jiraLinkTitle(workRef, input.desired), revision: (previous?.revision ?? 0) + 1, state: 'pending', recordedAt: previous?.recordedAt ?? at, updatedAt: at,
    attempts: previous?.attempts ?? [], confirmed: previous?.confirmed ?? null, diagnostic: null };
  document.links[work.work_id] = intent;
  // Bounded: confirmed links of finished Works (closed/delivered) beyond the bound are dropped, oldest first; pending ones never.
  const settled = Object.values(document.links).filter(item => item.state === 'confirmed' && item.desired !== 'open').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const old of settled.slice(0, Math.max(0, settled.length - maxSettledFinal))) delete document.links[old.workId];
  return intent;
}

export async function readJiraLinks(session: Session): Promise<JiraLinkIntent[]> {
  const document = await session.snapshot(jiraLinks, BACKGROUND_CONTEXT);
  return Object.values(document?.links ?? {}).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.workId.localeCompare(b.workId));
}

/**
 * One pass over every pending link: at most one upsert per link per pass (the latest revision), its outcome committed after the call. An
 * upsert by globalId never creates a second link, so a lost answer or a refusal is simply sent again on a later pass (bounded backoff in
 * passes; Jira's Retry-After honoured). Nothing else of the Card is written.
 */
export function createJiraLinkDesk(deps: { session: Session; tracker: JiraOriginTracker; stopped?: () => boolean }) {
  const { session, tracker } = deps;
  const stopped = deps.stopped ?? (() => false);
  // In memory: consecutive unconfirmed upserts per Work and the passes still to skip (a restart retries at once, then backs off again).
  const failures = new Map<string, number>();
  const skip = new Map<string, number>();
  return {
    async pass() {
      for (const intent of await readJiraLinks(session)) {
        if (stopped()) return;
        if (intent.state !== 'pending') continue;
        const now = new Date().toISOString();
        if (intent.notBefore && intent.notBefore > now) continue;
        const skipped = skip.get(intent.workId) ?? 0;
        if (skipped > 0) { skip.set(intent.workId, skipped - 1); continue; }
        const revision = intent.revision;
        const result: RemoteLinkResult = await tracker.upsertRemoteLink(intent.destination, { globalId: intent.globalId, url: intent.url, title: intent.title })
          .catch(() => ({ kind: 'unknown' as const, observedAt: new Date().toISOString(), code: 'JIRA_UNEXPECTED_FAILURE', nextStep: 'The same upsert is sent again later.' }));
        await session.commit(async tx => {
          const current = (await tx.doc(jiraLinks)).links[intent.workId];
          if (!current) return;
          const at = new Date().toISOString();
          current.attempts = keep([...current.attempts, { at, revision, outcome: result.kind, ...(result.kind === 'applied' ? {} : { code: result.code }) }]);
          current.updatedAt = at;
          if (result.kind === 'applied') {
            failures.delete(intent.workId);
            // A newer desire recorded meanwhile stays pending: the next pass sends it (latest state wins).
            if (current.revision === revision) {
              current.state = 'confirmed';
              current.confirmed = { revision, at, linkId: result.linkId, title: intent.title };
              current.diagnostic = null;
              delete current.notBefore;
            }
            return;
          }
          const count = (failures.get(intent.workId) ?? 0) + 1;
          failures.set(intent.workId, count);
          skip.set(intent.workId, jiraLinkBackoffPasses(count));
          if (result.kind === 'failed' && result.waitSeconds !== undefined) current.notBefore = new Date(Date.parse(at) + result.waitSeconds * 1000).toISOString();
          current.diagnostic = { code: result.code, at, nextStep: result.kind === 'failed'
            ? `Jira refused the link of ${current.workRef} (${result.code}); it stays pending and the same upsert is retried with backoff. ${result.nextStep}`
            : `The link of ${current.workRef} may or may not be applied (${result.code}); the same upsert by globalId is sent again later (never a second link).` };
        }, BACKGROUND_CONTEXT);
      }
    },
  };
}

export async function jiraLinkStatus(session: Session): Promise<{ jiraLinks?: JiraLinkStatus }> {
  const links = await readJiraLinks(session);
  if (!links.length) return {};
  return { jiraLinks: { pending: links.filter(item => item.state === 'pending').slice(-50), confirmed: links.filter(item => item.state === 'confirmed').length } };
}
