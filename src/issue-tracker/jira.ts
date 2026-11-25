// Jira Cloud adapter of the issue tracker (spec §1-§5), re-exported by the module's index.
import { z } from 'zod';
import { jiraInputOrder } from '../contracts/index.js';
import type { IssueTracker } from './tracker-types.js';
import type {
  JiraBlockerReads,
  JiraCapabilityFact,
  JiraComment,
  JiraCommentListing,
  JiraComments,
  JiraContentReads,
  JiraInputCursor,
  JiraInputsObservation,
  JiraLabelEvent,
  JiraRemoteLinks,
  JiraTicketRef,
  JiraTrackerScope,
  JiraUnavailable,
  JiraVisibleComment,
} from './jira-types.js';
import { jiraStatusCategories } from './jira-types.js';
import { adfPlainText } from './jira-adf-text.js';
import type { JiraRequest, JiraTransport } from './jira-http.js';

/**
 * Jira ticket 06: the inputs after `cursor` from a COMPLETE listing of the Card's comments (an incomplete one is returned as is: nothing
 * concluded). The observation's cursor is the last listed input (or the given cursor): the Control stores it only after processing them.
 */
export function jiraInputsOf(ticket: JiraTicketRef, listing: JiraCommentListing, cursor: JiraInputCursor | null): JiraInputsObservation {
  if (listing.kind !== 'observed') return listing;
  const comments = [...listing.comments]
    .sort((a, b) => jiraInputOrder(a, b))
    .filter(item => cursor === null || jiraInputOrder(item, cursor) > 0)
    .map((item): JiraComment => ({
      ref: { tracker: 'jira', siteId: ticket.siteId, issueId: ticket.issueId, commentId: item.commentId },
      url: `${ticket.url}?focusedCommentId=${item.commentId}`,
      author: item.authorAccountId === null ? null : { tracker: 'jira', accountId: item.authorAccountId },
      body: item.text,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      restricted: item.restricted,
    }));
  const last = comments.at(-1);
  return {
    kind: 'observed',
    source: 'jira-rest',
    observedAt: listing.observedAt,
    ticket,
    completeness: 'complete',
    comments,
    cursor: last ? { tracker: 'jira', createdAt: last.createdAt, commentId: last.ref.commentId } : cursor,
    limitations: [...listing.limitations],
  };
}

const jiraId = z.string().regex(/^[1-9][0-9]{0,17}$/);
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]{0,17}$/);
const jiraLinkTypeSchema = z.object({ id: jiraId, name: z.string().min(1).max(255), inward: z.string().min(1).max(255), outward: z.string().min(1).max(255) });
const jiraLinkSchema = z
  .object({
    id: jiraId,
    type: jiraLinkTypeSchema,
    inwardIssue: z.object({ id: jiraId, key: jiraKey }).optional(),
    outwardIssue: z.object({ id: jiraId, key: jiraKey }).optional(),
  })
  .refine(link => (link.inwardIssue === undefined) !== (link.outwardIssue === undefined));
const jiraIssueSchema = z.object({
  id: jiraId,
  key: jiraKey,
  fields: z.object({
    labels: z.array(z.string().min(1).max(255)),
    // Absent = not read (failFast=false or not returned): a partial read, never an empty list.
    components: z.unknown().optional(),
    issuelinks: z.unknown().optional(),
    summary: z.string().max(4096).nullable().optional(),
    project: z.object({ id: jiraId }),
    status: z.object({ statusCategory: z.object({ key: z.enum(jiraStatusCategories) }) }),
  }),
});
const jiraComponentsSchema = z.array(z.object({ id: jiraId, name: z.string().max(255) }));
const jiraStatusSchema = z.object({
  id: jiraId,
  key: jiraKey,
  fields: z.object({ status: z.object({ statusCategory: z.object({ key: z.enum(jiraStatusCategories) }) }) }),
});
const jiraContentSchema = z.object({
  id: jiraId,
  key: jiraKey,
  fields: z.object({ summary: z.string().max(4096).nullable().optional(), description: z.unknown().optional() }),
});
/** Bound of the description handed to the Builder (characters of plain text); beyond it the text says it was cut. */
const maxDescriptionChars = 8000;
const jiraLinkTypesSchema = z.object({ issueLinkTypes: z.array(jiraLinkTypeSchema).max(500) });
const jiraSearchPageSchema = z.object({
  issues: z.array(z.object({ id: jiraId, key: jiraKey, fields: z.object({ project: z.object({ id: jiraId }) }) })).max(5000),
  nextPageToken: z.string().min(1).max(4096).optional(),
  isLast: z.boolean(),
});
/** Bound of one listing: beyond it the listing is unavailable, never truncated. */
const maxSearchPages = 50;
const visibleOnly = 'Only what the configured account can see; the last page ends this query, it is neither global completeness nor an atomic snapshot.';
/** ADF node as read back (Jira may add attributes/marks); only text, hard breaks and nesting matter to the projection. */
type AdfNode = { type: string; text?: string | undefined; content?: AdfNode[] | undefined };
const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({ type: z.string().max(64), text: z.string().max(65536).optional(), content: z.array(adfNodeSchema).max(2000).optional() }),
);
const adfDocSchema = z.object({ type: z.literal('doc'), content: z.array(adfNodeSchema).max(2000) });
/** Plain text of an ADF document: one line per top-level block, text nodes concatenated, hard breaks as new lines. */
const adfText = (doc: z.infer<typeof adfDocSchema>) => {
  const inline = (node: AdfNode): string =>
    node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(inline).join('');
  return doc.content.map(inline).join('\n');
};
const adfOf = (lines: readonly string[]) => ({
  type: 'doc',
  version: 1,
  content: lines.map(text => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' })),
});
const jiraCommentCreatedSchema = z.object({
  id: jiraId,
  created: z.string().min(1).max(64),
  author: z.object({ accountId: z.string().min(1).max(128) }).optional(),
});
const jiraCommentSchema = z.object({
  id: jiraId,
  author: z.object({ accountId: z.string().max(128).optional() }).optional(),
  body: z.unknown(),
  created: z.string().min(1).max(64),
  updated: z.string().min(1).max(64),
  visibility: z.object({ type: z.string(), value: z.string().optional() }).nullable().optional(),
});
const jiraCommentPageSchema = z.object({ startAt: z.number().int().min(0), total: z.number().int().min(0), comments: z.array(jiraCommentSchema).max(5000) });
/** Refusals that prove the comment was NOT created (Jira answered 4xx, or nothing was sent); anything else after a send may have created it. */
const commentNotCreated = new Set([
  'JIRA_UNAUTHENTICATED',
  'JIRA_FORBIDDEN',
  'JIRA_NOT_FOUND',
  'JIRA_RATE_LIMITED',
  'JIRA_REQUEST_REJECTED',
  'JIRA_REQUEST_REFUSED',
  'JIRA_CREDENTIAL_UNAVAILABLE',
  'JIRA_SITE_URL_INVALID',
]);
const maxJiraCommentPages = 50;
const jiraChangelogPageSchema = z.object({
  startAt: z.number().int().min(0),
  total: z.number().int().min(0),
  values: z
    .array(
      z.object({
        id: jiraId,
        author: z.object({ accountId: z.string().max(128).optional() }).optional(),
        created: z.string().min(1).max(64),
        items: z.array(z.object({ field: z.string().max(255), fromString: z.string().nullable().optional(), toString: z.unknown().optional() })).max(1000),
      }),
    )
    .max(5000),
});
const maxJiraChangelogPages = 50;
/** One verified changelog page, only when it starts where the read is. */
function changelogPageOf(body: unknown, startAt: number) {
  const page = jiraChangelogPageSchema.safeParse(body);
  if (!page.success || page.data.startAt !== startAt) return null;
  return page.data;
}
/** Jira writes the `labels` field of a changelog item as the space-separated set before and after (labels never contain spaces). */
const labelSet = (text: unknown) => (typeof text === 'string' ? text.split(' ').filter(Boolean) : []);
/** The label changes of one changelog entry: what its `labels` items added and removed. */
function labelChanges(entry: z.infer<typeof jiraChangelogPageSchema>['values'][number]): JiraLabelEvent[] {
  const author = entry.author?.accountId ? { tracker: 'jira' as const, accountId: entry.author.accountId } : null;
  return entry.items
    .filter(item => item.field === 'labels')
    .flatMap(item => {
      // `toString` is read as an own property: on a parsed object the name otherwise resolves to Object.prototype.toString.
      const before = labelSet(item.fromString);
      const after = labelSet(Object.hasOwn(item, 'toString') ? item.toString : null);
      return [
        ...before.filter(label => !after.includes(label)).map(label => ({ action: 'removed' as const, label })),
        ...after.filter(label => !before.includes(label)).map(label => ({ action: 'added' as const, label })),
      ];
    })
    .map(change => ({ eventId: entry.id, ...change, at: entry.created, author }));
}

/** Jira ticket 10: project permissions the Factory's account needs (reads; ordinary comments; remote links). */
const jiraPermissions = [
  { key: 'BROWSE_PROJECTS', name: 'Browse projects' },
  { key: 'ADD_COMMENTS', name: 'Add comments' },
  { key: 'LINK_ISSUES', name: 'Link issues' },
] as const;
const jiraPermissionsSchema = z.object({ permissions: z.record(z.string(), z.object({ havePermission: z.boolean().optional() })) });
const accessLimitation =
  "Permissions of the configured account only: who can see the Factory's comments, and blockers in projects it cannot read, are not verified.";

/** JQL string literal: quotes and backslashes escaped (labels are validated without spaces). */
const jqlString = (value: string) => `"${value.replace(/[\\"]/g, character => `\\${character}`)}"`;

/** The listing's scope is exactly the configured one (site, project and label). */
const configuredAs = (configured: JiraTrackerScope | undefined, scope: JiraTrackerScope): configured is JiraTrackerScope =>
  configured !== undefined && configured.projectId === scope.projectId && configured.label === scope.label;
const searchBody = (jql: string, token: string | undefined) => ({
  jql,
  fields: ['project'],
  maxResults: 100,
  ...(token === undefined ? {} : { nextPageToken: token }),
});
/** One verified page of the JQL search, only when every issue belongs to the project. */
function searchPageOf(body: unknown, projectId: string) {
  const parsed = jiraSearchPageSchema.safeParse(body);
  if (!parsed.success || parsed.data.issues.some(item => item.fields.project.id !== projectId)) return null;
  return parsed.data;
}
/** First sighting wins: an issue repeated on a later page is listed once. */
function addCandidates(seen: Map<string, JiraTicketRef>, issues: readonly { id: string; key: string }[], configured: JiraTrackerScope) {
  for (const item of issues)
    if (!seen.has(item.id))
      seen.set(item.id, { tracker: 'jira', siteId: configured.siteId, issueId: item.id, key: item.key, url: `${configured.url}/browse/${item.key}` });
}
/** A next page token not seen before (a repeated or absent one would not reach the end). */
const freshToken = (token: string | undefined, tokens: ReadonlySet<string>): token is string => token !== undefined && !tokens.has(token);
/** The description as plain text: `null` when absent, `invalid` when present but not an ADF document. */
function descriptionText(description: unknown) {
  if (description === null || description === undefined) return null;
  return adfPlainText(description, maxDescriptionChars) ?? 'invalid';
}
const descriptionFields = (text: { text: string; truncated: boolean } | null) => ({ description: text?.text ?? null, truncated: text?.truncated ?? false });
/** One verified comment page, only when it starts where the listing is. */
function commentPageOf(body: unknown, startAt: number) {
  const page = jiraCommentPageSchema.safeParse(body);
  if (!page.success || page.data.startAt !== startAt) return null;
  return page.data;
}
function visibleComment(item: z.infer<typeof jiraCommentSchema>): JiraVisibleComment {
  const body = adfDocSchema.safeParse(item.body);
  return {
    commentId: item.id,
    authorAccountId: item.author?.accountId || null,
    text: body.success ? adfText(body.data) : null,
    createdAt: item.created,
    updatedAt: item.updated,
    restricted: Boolean(item.visibility),
  };
}

/**
 * Jira Cloud adapter of the common tracker contract. Jira ticket 01: composition and the re-read by ID; ticket 03: the JQL listing (all
 * pages, `nextPageToken`/`isLast` of the enhanced search), the re-read with components and links, the link type catalogue and a
 * neighbour's status category. The transport of each configured site is created lazily, on the first request to that site; visible
 * blockers are assembled by the Control (direction is its rule), inputs and comments answer unavailable (tickets 05/06) and the remote link
 * is refused without any call (tickets 08/09). Nothing here admits Work or authorizes commands.
 */
export function createJiraTracker(options: {
  scopes: JiraTrackerScope[];
  transport: (scope: JiraTrackerScope) => JiraTransport;
}): IssueTracker<'jira'> & JiraRemoteLinks & JiraBlockerReads & JiraContentReads & JiraComments {
  const transports = new Map<string, JiraTransport>();
  const site = (siteId: string) => options.scopes.find(scope => scope.siteId === siteId);
  const transportOf = (scope: JiraTrackerScope) => {
    let transport = transports.get(scope.siteId);
    if (!transport) {
      transport = options.transport(scope);
      transports.set(scope.siteId, transport);
    }
    return transport;
  };
  const unavailable = (siteId: string, code: string, nextStep: string, observedAt = new Date().toISOString(), waitSeconds?: number): JiraUnavailable => ({
    kind: 'unavailable',
    source: 'jira-rest',
    observedAt,
    siteId,
    completeness: 'incomplete',
    code,
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    nextStep,
  });
  const notConfigured = (siteId: string) => unavailable(siteId, 'JIRA_SITE_NOT_CONFIGURED', 'Only explicitly configured Jira sites are read.');
  const notAvailable = (siteId: string) =>
    unavailable(siteId, 'JIRA_CAPABILITY_NOT_AVAILABLE', 'This release does not read it from Jira yet; nothing is concluded.');
  const invalid = (siteId: string, observedAt: string) =>
    unavailable(siteId, 'JIRA_OBSERVATION_INVALID', 'Jira returned an answer that could not be verified; nothing is concluded.', observedAt);
  const notSent = () => ({
    kind: 'failed' as const,
    observedAt: new Date().toISOString(),
    code: 'JIRA_CAPABILITY_NOT_AVAILABLE',
    nextStep: 'This release does not write to Jira yet; nothing was sent.',
  });
  /** One GET/POST of a configured site: the 200 body, or the unavailable fact that concludes nothing. */
  async function read(siteId: string, request: JiraRequest): Promise<{ ok: true; body: unknown; observedAt: string } | { ok: false; fact: JiraUnavailable }> {
    const scope = site(siteId);
    if (!scope) return { ok: false, fact: notConfigured(siteId) };
    const response = await transportOf(scope).request(request);
    if (!response.ok) return { ok: false, fact: unavailable(siteId, response.code, response.nextStep, response.observedAt, response.waitSeconds) };
    if (response.status !== 200) return { ok: false, fact: invalid(siteId, response.observedAt) };
    return { ok: true, body: response.body, observedAt: response.observedAt };
  }
  const tracker: ReturnType<typeof createJiraTracker> = {
    // Jira ticket 10: one read of the account's own permissions on the configured project (diagnosis only, never a request for more access).
    async checkAccess(scope) {
      const unverified = {
        projectRead: 'unverified',
        commentCreate: 'unverified',
        remoteLinks: 'unverified',
        commentAudience: 'unverified',
        blockerVisibility: 'unverified',
      } as const;
      const base = {
        source: 'jira-rest' as const,
        purpose: 'tracker' as const,
        siteId: scope.siteId,
        projectId: scope.projectId,
        limitations: [accessLimitation],
      };
      const answer = await read(scope.siteId, {
        method: 'GET',
        path: '/rest/api/3/mypermissions',
        query: { projectId: scope.projectId, permissions: jiraPermissions.map(item => item.key).join(',') },
      });
      if (!answer.ok)
        return {
          ...base,
          observedAt: answer.fact.observedAt,
          status: 'blocked',
          code: answer.fact.code,
          completeness: 'incomplete',
          nextStep: answer.fact.nextStep,
          facts: unverified,
        };
      const parsed = jiraPermissionsSchema.safeParse(answer.body);
      if (!parsed.success)
        return {
          ...base,
          observedAt: answer.observedAt,
          status: 'blocked',
          code: 'JIRA_OBSERVATION_INVALID',
          completeness: 'incomplete',
          nextStep: 'Jira returned a permissions answer that could not be verified; nothing is concluded.',
          facts: unverified,
        };
      const fact = (key: string): JiraCapabilityFact => {
        const have = parsed.data.permissions[key]?.havePermission;
        return have === true ? 'granted' : have === false ? 'missing' : 'unverified';
      };
      const facts = { ...unverified, projectRead: fact('BROWSE_PROJECTS'), commentCreate: fact('ADD_COMMENTS'), remoteLinks: fact('LINK_ISSUES') };
      const missing = jiraPermissions.filter(item => fact(item.key) === 'missing');
      const open = jiraPermissions.filter(item => fact(item.key) === 'unverified');
      const ok = !missing.length && !open.length;
      return {
        ...base,
        observedAt: answer.observedAt,
        status: ok ? 'ok' : 'blocked',
        code: ok ? 'JIRA_ACCESS_OK' : missing.length ? 'JIRA_PERMISSION_MISSING' : 'JIRA_PERMISSION_UNVERIFIED',
        completeness: open.length ? 'incomplete' : 'complete',
        facts,
        nextStep: ok
          ? 'The configured account holds the project permissions the Factory uses; comment audience and blocker visibility are not provable by it.'
          : missing.length
            ? `Ask a Jira administrator to grant the configured account ${missing.map(item => `"${item.name}"`).join(', ')} on project ${scope.projectId} ` +
              '(the Factory never requests or widens access itself).'
            : `Jira did not answer for ${open.map(item => `"${item.name}"`).join(', ')}; nothing is concluded.`,
      };
    },
    async listCandidates(scope) {
      // A site may carry several configured listings (other projects; the needs-triage label of a source with Triage, spec #68 §4).
      const configured = options.scopes.find(candidate => candidate.siteId === scope.siteId && configuredAs(candidate, scope));
      if (!configured) return notConfigured(scope.siteId);
      const jql = `project = ${scope.projectId} AND labels = ${jqlString(scope.label)}`;
      const seen = new Map<string, JiraTicketRef>();
      const tokens = new Set<string>();
      let token: string | undefined;
      let observedAt = '';
      for (let pages = 0; ; pages += 1) {
        if (pages >= maxSearchPages)
          return unavailable(
            scope.siteId,
            'JIRA_SEARCH_TOO_LARGE',
            `More than ${maxSearchPages} result pages; narrow the project/label. Nothing is concluded.`,
            observedAt,
          );
        const answer = await read(scope.siteId, {
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body: searchBody(jql, token),
        });
        if (!answer.ok) return answer.fact;
        observedAt ||= answer.observedAt;
        const page = searchPageOf(answer.body, scope.projectId);
        if (!page) return invalid(scope.siteId, answer.observedAt);
        addCandidates(seen, page.issues, configured);
        if (page.isLast) break;
        token = page.nextPageToken;
        if (!freshToken(token, tokens))
          return unavailable(
            scope.siteId,
            'JIRA_SEARCH_INCOMPLETE',
            'The JQL pages did not reach their end; nothing is concluded, the next poll lists again.',
            answer.observedAt,
          );
        tokens.add(token);
      }
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt,
        siteId: scope.siteId,
        projectId: scope.projectId,
        label: scope.label,
        completeness: 'complete',
        candidates: [...seen.values()],
        limitations: [visibleOnly],
      };
    },
    async readTicket(ticket) {
      const answer = await read(ticket.siteId, {
        method: 'GET',
        path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}`,
        query: { fields: 'labels,components,issuelinks,status,summary,project' },
      });
      if (!answer.ok) return answer.fact;
      const parsed = jiraIssueSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== ticket.issueId) return invalid(ticket.siteId, answer.observedAt);
      const { key, fields } = parsed.data;
      const components = jiraComponentsSchema.safeParse(fields.components);
      const links = z.array(jiraLinkSchema).max(1000).safeParse(fields.issuelinks);
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: answer.observedAt,
        completeness: 'complete',
        ticket: { tracker: 'jira', siteId: ticket.siteId, issueId: ticket.issueId, key, url: `${site(ticket.siteId)!.url}/browse/${key}` },
        projectId: fields.project.id,
        labels: fields.labels,
        components: components.success ? components.data.map(item => ({ id: item.id, name: item.name })) : null,
        statusCategory: fields.status.statusCategory.key,
        summary: fields.summary ?? null,
        links: links.success
          ? links.data.map(link => {
              const neighbour = (link.inwardIssue ?? link.outwardIssue)!;
              return {
                linkId: link.id,
                type: { id: link.type.id, name: link.type.name, inward: link.type.inward, outward: link.type.outward },
                end: link.inwardIssue ? ('inward' as const) : ('outward' as const),
                issue: { issueId: neighbour.id, key: neighbour.key },
              };
            })
          : null,
      };
    },
    async readLabelHistory(ticket) {
      // By entry id: an entry repeated on a later page (a concurrent change) is read once, at its first position (a Map keeps it).
      const entries = new Map<string, Parameters<typeof labelChanges>[0]>();
      let startAt = 0;
      let observedAt = '';
      for (let pages = 0; ; pages += 1) {
        if (pages >= maxJiraChangelogPages)
          return unavailable(
            ticket.siteId,
            'JIRA_CHANGELOG_TOO_LARGE',
            `More than ${maxJiraChangelogPages} changelog pages; nothing is concluded.`,
            observedAt || undefined,
          );
        const answer = await read(ticket.siteId, {
          method: 'GET',
          path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/changelog`,
          query: { startAt: String(startAt), maxResults: '100' },
        });
        if (!answer.ok) return answer.fact;
        observedAt ||= answer.observedAt;
        const page = changelogPageOf(answer.body, startAt);
        if (!page) return invalid(ticket.siteId, answer.observedAt);
        for (const entry of page.values) entries.set(entry.id, entry);
        startAt += page.values.length;
        if (startAt >= page.total) break;
        if (!page.values.length)
          return unavailable(
            ticket.siteId,
            'JIRA_CHANGELOG_INCOMPLETE',
            'A changelog page ended before the announced total; nothing is concluded, the next poll reads again.',
            answer.observedAt,
          );
      }
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt,
        ticket,
        completeness: 'complete',
        events: [...entries.values()].flatMap(labelChanges),
        limitations: [visibleOnly, 'A label the Card was created with has no changelog entry.'],
      };
    },
    async readTicketContent(ticket) {
      const answer = await read(ticket.siteId, {
        method: 'GET',
        path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}`,
        query: { fields: 'summary,description' },
      });
      if (!answer.ok) return answer.fact;
      const parsed = jiraContentSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== ticket.issueId) return invalid(ticket.siteId, answer.observedAt);
      const text = descriptionText(parsed.data.fields.description);
      // A description that is present but not an ADF document is not guessed at.
      if (text === 'invalid') return invalid(ticket.siteId, answer.observedAt);
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: answer.observedAt,
        ticket: {
          tracker: 'jira',
          siteId: ticket.siteId,
          issueId: ticket.issueId,
          key: parsed.data.key,
          url: `${site(ticket.siteId)!.url}/browse/${parsed.data.key}`,
        },
        summary: parsed.data.fields.summary ?? null,
        ...descriptionFields(text),
      };
    },
    async readLinkTypes(siteId) {
      const answer = await read(siteId, { method: 'GET', path: '/rest/api/3/issueLinkType' });
      if (!answer.ok) return answer.fact;
      const parsed = jiraLinkTypesSchema.safeParse(answer.body);
      if (!parsed.success) return invalid(siteId, answer.observedAt);
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: answer.observedAt,
        siteId,
        types: parsed.data.issueLinkTypes.map(type => ({ id: type.id, name: type.name, inward: type.inward, outward: type.outward })),
      };
    },
    async readIssueStatus(siteId, issueId) {
      const answer = await read(siteId, { method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(issueId)}`, query: { fields: 'status' } });
      if (!answer.ok) return answer.fact;
      const parsed = jiraStatusSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.id !== issueId) return invalid(siteId, answer.observedAt);
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt: answer.observedAt,
        siteId,
        issueId,
        key: parsed.data.key,
        statusCategory: parsed.data.fields.status.statusCategory.key,
      };
    },
    async publishComment(ticket, comment) {
      const scope = site(ticket.siteId);
      if (!scope)
        return {
          kind: 'failed',
          observedAt: new Date().toISOString(),
          code: 'JIRA_SITE_NOT_CONFIGURED',
          nextStep: 'Only explicitly configured Jira sites are written; nothing was sent.',
        };
      const response = await transportOf(scope).request({
        method: 'POST',
        path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/comment`,
        body: { body: adfOf(comment.lines) },
      });
      if (!response.ok) {
        return commentNotCreated.has(response.code)
          ? {
              kind: 'failed',
              observedAt: response.observedAt,
              code: response.code,
              ...(response.waitSeconds !== undefined ? { waitSeconds: response.waitSeconds } : {}),
              nextStep: response.nextStep,
            }
          : {
              kind: 'unknown',
              observedAt: response.observedAt,
              code: response.code,
              nextStep: 'The comment may have been created; it is reconciled before any new POST.',
            };
      }
      const created = jiraCommentCreatedSchema.safeParse(response.body);
      if (!created.success)
        return {
          kind: 'unknown',
          observedAt: response.observedAt,
          code: 'JIRA_COMMENT_RESPONSE_INVALID',
          nextStep: 'Jira accepted the POST with an unreadable answer; it is reconciled before any new POST.',
        };
      return {
        kind: 'published',
        observedAt: response.observedAt,
        commentId: created.data.id,
        createdAt: created.data.created,
        authorAccountId: created.data.author?.accountId ?? null,
        url: `${scope.url}/browse/${ticket.key}?focusedCommentId=${created.data.id}`,
      };
    },
    async listComments(ticket) {
      const comments = new Map<string, JiraVisibleComment>();
      let startAt = 0;
      let observedAt = '';
      for (let pages = 0; ; pages += 1) {
        if (pages >= maxJiraCommentPages)
          return unavailable(
            ticket.siteId,
            'JIRA_COMMENTS_TOO_MANY',
            `More than ${maxJiraCommentPages} comment pages; nothing is concluded.`,
            observedAt || undefined,
          );
        const answer = await read(ticket.siteId, {
          method: 'GET',
          path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/comment`,
          query: { startAt: String(startAt), maxResults: '100', orderBy: 'created' },
        });
        if (!answer.ok) return answer.fact;
        observedAt ||= answer.observedAt;
        const page = commentPageOf(answer.body, startAt);
        if (!page) return invalid(ticket.siteId, answer.observedAt);
        for (const item of page.comments) comments.set(item.id, visibleComment(item));
        startAt += page.comments.length;
        if (startAt >= page.total) break;
        if (!page.comments.length)
          return unavailable(
            ticket.siteId,
            'JIRA_COMMENTS_INCOMPLETE',
            'A comment page ended before the announced total; nothing is concluded, the next poll reads again.',
            answer.observedAt,
          );
      }
      return {
        kind: 'observed',
        source: 'jira-rest',
        observedAt,
        siteId: ticket.siteId,
        issueId: ticket.issueId,
        completeness: 'complete',
        comments: [...comments.values()],
        limitations: [visibleOnly],
      };
    },
    async readAccount(siteId) {
      const answer = await read(siteId, { method: 'GET', path: '/rest/api/3/myself' });
      if (!answer.ok) return answer.fact;
      const parsed = z.object({ accountId: z.string().min(1).max(128) }).safeParse(answer.body);
      if (!parsed.success) return invalid(siteId, answer.observedAt);
      return { kind: 'observed', source: 'jira-rest', observedAt: answer.observedAt, siteId, accountId: parsed.data.accountId };
    },
    async readDependencyGraph(ticket) {
      return notAvailable(ticket.siteId);
    },
    // Jira ticket 06: the inputs of a Work are the visible comments of its origin Card after the processed cursor (all pages, or nothing).
    async readInputs(ticket, cursor) {
      return jiraInputsOf(ticket, await tracker.listComments(ticket), cursor);
    },
    async findQuestion(ticket) {
      return notAvailable(ticket.siteId);
    },
    async findReply(ticket) {
      return notAvailable(ticket.siteId);
    },
    async postComment() {
      return notSent();
    },
    async upsertRemoteLink(ticket, link) {
      const at = new Date().toISOString();
      if (
        !/^software-factory:work:[0-9a-f-]{1,64}$/.test(link.globalId) ||
        !/^https:\/\/[^\s]{1,2000}$/.test(link.url) ||
        !link.title.trim() ||
        link.title.length > 255
      ) {
        return {
          kind: 'failed',
          observedAt: at,
          code: 'JIRA_REMOTE_LINK_INVALID',
          nextStep: 'The link was refused locally (globalId, https URL or title); nothing was sent.',
        };
      }
      const scope = site(ticket.siteId);
      if (!scope)
        return {
          kind: 'failed',
          observedAt: at,
          code: 'JIRA_SITE_NOT_CONFIGURED',
          nextStep: 'Only explicitly configured Jira sites are written; nothing was sent.',
        };
      const response = await transportOf(scope).request({
        method: 'POST',
        path: `/rest/api/3/issue/${encodeURIComponent(ticket.issueId)}/remotelink`,
        body: { globalId: link.globalId, object: { url: link.url, title: link.title } },
      });
      if (!response.ok) {
        return commentNotCreated.has(response.code)
          ? {
              kind: 'failed',
              observedAt: response.observedAt,
              code: response.code,
              ...(response.waitSeconds !== undefined ? { waitSeconds: response.waitSeconds } : {}),
              nextStep: response.nextStep,
            }
          : {
              kind: 'unknown',
              observedAt: response.observedAt,
              code: response.code,
              nextStep: 'The link may have been applied; the same upsert by globalId is sent again later.',
            };
      }
      const applied = z.object({ id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]) }).safeParse(response.body);
      if (!applied.success)
        return {
          kind: 'unknown',
          observedAt: response.observedAt,
          code: 'JIRA_REMOTE_LINK_RESPONSE_INVALID',
          nextStep: 'Jira answered with an unreadable body; the same upsert is sent again later.',
        };
      return { kind: 'applied', observedAt: response.observedAt, linkId: String(applied.data.id) };
    },
  };
  return tracker;
}
