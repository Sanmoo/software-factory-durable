import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Module-internal seams (Q14): the real durable store and the Jira impediment entry point the poller calls (tickets 04/10).
import { openStore } from '../../src/control/durable/store.js';
import { initialize } from '../../src/control/durable/admission.js';
import { jiraNoticeStatus, noticeJiraImpediments, readJiraNotices } from '../../src/control/durable/jira-impediments.js';
import type { JiraCandidateEvaluation, JiraSourceEvaluation } from '../../src/control/durable/jira-evaluation.js';
import type { JiraEvaluation } from '../../src/control/rules/jira-admission.js';
import type { JiraOriginTracker, TicketSource } from '../../src/control/types.js';
import type { JiraCommentPost, JiraTicketRef, JiraVisibleComment } from '../../src/issue-tracker/index.js';
import { untilHolds } from '../runner/budget.js';

// Jira ticket 05 (spec §3 step 4, §4 last paragraph) on real SQLite storage: the refused Card is told once per impediment, the comment is
// persisted before its POST and, after a lost answer or a crash, reconciled against every visible comment before any new POST.
const source: Extract<TicketSource, { tracker: 'jira' }> = {
  tracker: 'jira',
  siteId: 'site-A',
  url: 'https://equipe.atlassian.net',
  projectId: '10010',
  label: 'factory-ready',
  discover: true,
  routes: [{ componentId: '10021', repository: 'equipe/checkout-web' }],
};
const card = (issueId: string, key: string): JiraTicketRef => ({
  tracker: 'jira',
  siteId: 'site-A',
  issueId,
  key,
  url: `https://equipe.atlassian.net/browse/${key}`,
});
const pag42 = card('81017', 'PAG-42');
const routeNone: JiraEvaluation = { decision: 'blocked', reasons: [{ code: 'JIRA_ROUTE_NONE', nextStep: 'No component routes; set one routed component.' }] };
const blocker: JiraEvaluation = {
  decision: 'blocked',
  reasons: [{ code: 'JIRA_BLOCKER_NOT_DONE', blocker: { issueId: '70301', key: 'SEC-10' }, nextStep: 'A visible blocker of the Card is not Done.' }],
};
const candidate = (ticket: JiraTicketRef, evaluation: JiraEvaluation): JiraCandidateEvaluation => ({
  ticket,
  evaluation,
  observedAt: '2026-11-21T10:00:00.000Z',
  route: evaluation.decision === 'not-candidate' ? null : { kind: 'none' },
  blockers: null,
});
const round = (...candidates: JiraCandidateEvaluation[]): JiraSourceEvaluation => ({
  kind: 'evaluated',
  siteId: 'site-A',
  projectId: '10010',
  observedAt: '2026-11-21T10:00:00.000Z',
  limitations: [],
  candidates,
  deferred: [],
});

type Post = 'ok' | 'lost-created' | 'lost-not-created' | 'refused' | 'hang';
/** In-memory Jira site: comments per issue, every POST recorded (positive control), knobs for lost answers and partial listings. */
function jiraSite() {
  const comments: Record<string, JiraVisibleComment[]> = {};
  const posts: { issueId: string; lines: string[] }[] = [];
  const outcomes: Post[] = [];
  const knobs = { listing: 'complete' as 'complete' | 'incomplete' | 'forbidden', account: 'acc-factory' };
  let next = 10040;
  const at = '2026-11-21T10:00:00.000Z';
  const create = (issueId: string, lines: string[], accountId = 'acc-factory') => {
    const commentId = String((next += 1));
    (comments[issueId] ??= []).push({ commentId, authorAccountId: accountId, text: lines.join('\n'), createdAt: at, updatedAt: at, restricted: false });
    return commentId;
  };
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected Jira call ${name}`);
  };
  const tracker = {
    async publishComment(ticket: JiraTicketRef, comment: { lines: string[] }): Promise<JiraCommentPost> {
      posts.push({ issueId: ticket.issueId, lines: comment.lines });
      const outcome = outcomes.shift() ?? 'ok';
      if (outcome === 'hang') return new Promise(() => {});
      if (outcome === 'refused') return { kind: 'failed', observedAt: at, code: 'JIRA_FORBIDDEN', nextStep: 'Grant Add comments.' };
      if (outcome === 'lost-not-created') return { kind: 'unknown', observedAt: at, code: 'JIRA_TIMEOUT', nextStep: 'reconcile' };
      const commentId = create(ticket.issueId, comment.lines);
      if (outcome === 'lost-created') return { kind: 'unknown', observedAt: at, code: 'JIRA_TIMEOUT', nextStep: 'reconcile' };
      return {
        kind: 'published',
        observedAt: at,
        commentId,
        createdAt: at,
        authorAccountId: 'acc-factory',
        url: `${ticket.url}?focusedCommentId=${commentId}`,
      };
    },
    async listComments(ticket: JiraTicketRef) {
      if (knobs.listing === 'incomplete')
        return {
          kind: 'unavailable' as const,
          source: 'jira-rest' as const,
          observedAt: at,
          siteId: 'site-A',
          completeness: 'incomplete' as const,
          code: 'JIRA_UNAVAILABLE',
          nextStep: 'second page failed',
        };
      if (knobs.listing === 'forbidden')
        return {
          kind: 'unavailable' as const,
          source: 'jira-rest' as const,
          observedAt: at,
          siteId: 'site-A',
          completeness: 'incomplete' as const,
          code: 'JIRA_FORBIDDEN',
          nextStep: 'forbidden',
        };
      return {
        kind: 'observed' as const,
        source: 'jira-rest' as const,
        observedAt: at,
        siteId: 'site-A',
        issueId: ticket.issueId,
        completeness: 'complete' as const,
        comments: [...(comments[ticket.issueId] ?? [])],
        limitations: [],
      };
    },
    async readAccount(siteId: string) {
      return { kind: 'observed' as const, source: 'jira-rest' as const, observedAt: at, siteId, accountId: knobs.account };
    },
    checkAccess: unexpected('checkAccess'),
    listCandidates: unexpected('listCandidates'),
    readTicket: unexpected('readTicket'),
    readDependencyGraph: unexpected('readDependencyGraph'),
    readInputs: unexpected('readInputs'),
    findQuestion: unexpected('findQuestion'),
    postComment: unexpected('postComment'),
    upsertRemoteLink: unexpected('upsertRemoteLink'),
    readLinkTypes: unexpected('readLinkTypes'),
    readIssueStatus: unexpected('readIssueStatus'),
  } as unknown as JiraOriginTracker;
  return { tracker, comments, posts, outcomes, knobs, create };
}

async function storage(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-jira-notice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  const open = async () => {
    const store = await openStore(path);
    await initialize(store.session);
    return store;
  };
  return { open };
}

test('a refused Card is told once per impediment, again for a new reason, never after its label is gone; the diagnosis stays visible', async t => {
  const site = jiraSite();
  const { open } = await storage(t);
  const store = await open();
  try {
    const notice = (evaluation: JiraSourceEvaluation) => noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation });
    await notice(round(candidate(pag42, routeNone)));
    assert.equal(site.posts.length, 1, 'positive control: the first notice is POSTed');
    const [header, ...body] = site.posts[0]!.lines;
    assert.match(header!, /^\[Software Factory · Impedimento I-[0-9a-f]{8}\]$/);
    assert.ok(body.includes('- No component routes; set one routed component.'));
    await notice(round(candidate(pag42, routeNone)));
    assert.equal(site.posts.length, 1, 'the same impediment is not told twice');
    await notice(round(candidate(pag42, blocker)));
    assert.equal(site.posts.length, 2, 'a new reason is told');
    assert.notEqual(site.posts[1]!.lines[0], header, 'with another logical reference');
    assert.doesNotMatch(site.posts[1]!.lines.join('\n'), /SEC-10|70301/, 'never the neighbour');
    await notice(round(candidate(pag42, { decision: 'not-candidate', reasons: [] })));
    await notice(
      round(candidate(card('81018', 'PAG-43'), { decision: 'unverifiable', reasons: [{ code: 'JIRA_COMPONENTS_UNVERIFIABLE', nextStep: 'Read again.' }] })),
    );
    assert.equal(site.posts.length, 2, 'label gone or unverifiable: nothing is POSTed');
    const view = await readJiraNotices(store.session);
    assert.deepEqual(
      view.impediments.map(item => [item.ticket.key, item.decision, item.notice, item.localCode]),
      [
        ['PAG-42', 'not-candidate', 'local', 'JIRA_NOTICE_NOT_CANDIDATE'],
        ['PAG-43', 'unverifiable', 'local', 'JIRA_NOTICE_UNVERIFIABLE'],
      ],
    );
    assert.deepEqual(
      view.comments.map(item => item.state),
      ['published', 'published'],
    );
    const status = await jiraNoticeStatus(store.session);
    assert.equal(status.jiraNotices?.published, 2);
    assert.deepEqual(
      status.jiraNotices?.impediments.map(item => item.reasons),
      [[], ['JIRA_COMPONENTS_UNVERIFIABLE']],
    );
  } finally {
    await store.close();
  }
});

test('a POST accepted with its answer lost is confirmed after a restart by the one matching comment, with zero extra POSTs', async t => {
  const site = jiraSite();
  site.outcomes.push('lost-created');
  const { open } = await storage(t);
  let store = await open();
  try {
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
    assert.equal(site.posts.length, 1);
    assert.deepEqual(
      (await readJiraNotices(store.session)).comments.map(item => item.state),
      ['unknown'],
    );
  } finally {
    await store.close();
  }
  store = await open();
  try {
    // A human copied the header: another account's comment proves nothing.
    site.create('81017', site.posts[0]!.lines, 'acc-human');
    await noticeJiraImpediments({
      session: store.session,
      tracker: site.tracker,
      source,
      evaluation: {
        kind: 'unavailable',
        siteId: 'site-A',
        projectId: '10010',
        listing: {
          kind: 'unavailable',
          source: 'jira-rest',
          observedAt: '2026-11-21T10:00:00.000Z',
          siteId: 'site-A',
          completeness: 'incomplete',
          code: 'JIRA_UNAVAILABLE',
          nextStep: 'x',
        },
      },
    });
    assert.equal(site.posts.length, 1, 'zero extra POSTs');
    const [effect] = (await readJiraNotices(store.session)).comments;
    assert.equal(effect!.state, 'published');
    assert.equal(effect!.comment?.commentId, site.comments['81017']![0]!.commentId);
  } finally {
    await store.close();
  }
});

test('zero matches in a complete read re-POSTs exactly once with the same reference', async t => {
  const site = jiraSite();
  site.outcomes.push('lost-not-created');
  const { open } = await storage(t);
  let store = await open();
  try {
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
  } finally {
    await store.close();
  }
  store = await open();
  try {
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
    assert.equal(site.posts.length, 2, 'exactly one re-POST');
    assert.deepEqual(site.posts[1]!.lines, site.posts[0]!.lines, 'same logical reference and content');
    assert.deepEqual(
      (await readJiraNotices(store.session)).comments.map(item => item.state),
      ['published'],
    );
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
    assert.equal(site.posts.length, 2);
  } finally {
    await store.close();
  }
});

test('two copies, a partial listing or denied access keep the effect pending with a diagnosis and no blind POST', async t => {
  for (const variant of ['two', 'incomplete', 'forbidden'] as const) {
    const site = jiraSite();
    site.outcomes.push(variant === 'two' ? 'lost-created' : 'lost-not-created');
    const { open } = await storage(t);
    const store = await open();
    try {
      const notice = () => noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
      await notice();
      if (variant === 'two') site.create('81017', site.posts[0]!.lines);
      else site.knobs.listing = variant;
      await notice();
      await notice();
      assert.equal(site.posts.length, 1, `${variant}: no blind POST`);
      const [effect] = (await readJiraNotices(store.session)).comments;
      assert.equal(effect!.state, 'pending', variant);
      assert.equal(effect!.diagnostic?.code, { two: 'JIRA_COMMENT_MULTIPLE', incomplete: 'JIRA_UNAVAILABLE', forbidden: 'JIRA_FORBIDDEN' }[variant]);
    } finally {
      await store.close();
    }
  }
});

test('a crash between the attempt and the answer is reconciled at the next start; a known refusal is retried, never after the label is gone', async t => {
  const site = jiraSite();
  site.outcomes.push('hang');
  const { open } = await storage(t);
  let store = await open();
  const hung = noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
  void hung.catch(() => {});
  await untilHolds('the POST was sent', () => site.posts.length === 1);
  assert.deepEqual(
    (await readJiraNotices(store.session)).comments.map(item => item.state),
    ['attempting'],
    'persisted before the POST',
  );
  await store.close();
  store = await open();
  try {
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
    assert.equal(site.posts.length, 2, 'complete empty read after the interrupted attempt: one re-POST');
    assert.deepEqual(
      (await readJiraNotices(store.session)).comments.map(item => item.state),
      ['published'],
    );

    site.outcomes.push('refused');
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(card('81018', 'PAG-43'), blocker)) });
    assert.equal(site.posts.length, 3);
    await noticeJiraImpediments({
      session: store.session,
      tracker: site.tracker,
      source,
      evaluation: round(candidate(card('81018', 'PAG-43'), { decision: 'not-candidate', reasons: [] })),
    });
    assert.equal(site.posts.length, 3, 'label gone: the refused notice is withdrawn, not retried');
    assert.deepEqual(
      (await readJiraNotices(store.session)).comments.map(item => item.state),
      ['published', 'withdrawn'],
    );
    await noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(card('81018', 'PAG-43'), blocker)) });
    assert.equal(site.posts.length, 4, 'label back with the same reason: told, since the withdrawn notice never reached the Card');
  } finally {
    await store.close();
  }
});

test('known refusals and uncertain POSTs never abandon a comment: it stays pending and visible, retried with bounded backoff, never blindly', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-21T10:00:00.000Z') });
  const site = jiraSite();
  const { open } = await storage(t);
  const store = await open();
  try {
    const notice = () => noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(pag42, routeNone)) });
    const effect = async () => (await readJiraNotices(store.session)).comments[0]!;
    site.outcomes.push(...Array<Post>(7).fill('refused'));
    await notice();
    await notice();
    assert.equal(site.posts.length, 2, 'the first refusal is retried on the next pass');
    await notice();
    assert.equal(site.posts.length, 2, 'then the retry waits (backoff), never a tight loop');
    for (let refusal = 3; refusal <= 7; refusal++) {
      t.mock.timers.tick(15 * 60_000);
      await notice();
      assert.equal(site.posts.length, refusal, 'the backoff is bounded: a later pass retries');
    }
    const refused = await effect();
    assert.equal(refused.state, 'failed', 'still pending after more refusals than the old limit, never abandoned');
    assert.equal(refused.diagnostic?.code, 'JIRA_FORBIDDEN');
    assert.match(refused.diagnostic?.nextStep ?? '', /pending/);
    t.mock.timers.tick(15 * 60_000);
    await notice();
    assert.equal((await effect()).state, 'published', 'sent once Jira accepts it');

    // Uncertain POSTs, each found absent in a complete read: the same reference is sent again with backoff, forever pending, never abandoned.
    const other = card('81018', 'PAG-43');
    const noticeOther = () => noticeJiraImpediments({ session: store.session, tracker: site.tracker, source, evaluation: round(candidate(other, routeNone)) });
    const posted = site.posts.length;
    site.outcomes.push(...Array<Post>(5).fill('lost-not-created'));
    for (let attempt = 1; attempt <= 5; attempt++) {
      t.mock.timers.tick(15 * 60_000);
      await noticeOther();
      assert.equal(site.posts.length, posted + attempt);
    }
    t.mock.timers.tick(15 * 60_000);
    await noticeOther();
    const uncertain = (await readJiraNotices(store.session)).comments.find(item => item.destination.issueId === '81018')!;
    assert.equal(uncertain.state, 'published', 'after five uncertain POSTs the sixth is still sent, never abandoned');
    assert.equal(new Set(site.posts.slice(posted).map(item => item.lines[0])).size, 1, 'always the same logical reference');
  } finally {
    await store.close();
  }
});
