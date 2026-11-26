// Jira ticket 10: one Jira Cloud site as raw HTTP, behind the production host transport (`composeProductionAccess({ jira: { send } })`).
// It models only what the Factory's Jira adapter uses (enhanced JQL search, issue re-reads, link type catalogue, comments, account, remote
// links; spec #68 ticket #78: the one issue edit of a Triage publication and the changelog it leaves). Every exchange is recorded, unexpected ones included (answered 404), so a test can assert the absence of any other write
// (status, assignee, resolution). Synthetic IDs only: it is not a Jira tenant and proves nothing about real permissions or audiences.
import type { JiraHttpExchange, JiraHttpResult } from '../../src/issue-tracker/index.js';

export const jiraOrigin = 'https://equipe.atlassian.net';
export type HttpCard = { id: string; key: string; projectId: string; labels: string[]; components: string[]; summary: string; description?: string };
export type HttpComment = { id: string; accountId: string; text: string; created: string; updated: string };
type ChangelogItem = { field: string; fieldId: string; from: string | null; fromString: string | null; to: string | null; toString: string | null };
/** One changelog entry as Jira lists it; `author` and `historyMetadata` are absent when the edit carried none. */
export type HttpChange = { id: string; author?: { accountId: string }; created: string; items: ChangelogItem[]; historyMetadata?: unknown };
type IssueUpdate = { labels?: { add?: string; remove?: string }[]; components?: { add?: { id: string } }[] };

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map(line => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
});
const textOf = (body: unknown) =>
  ((body as { content?: { content?: { text?: string }[] }[] }).content ?? [])
    .map(block => (block.content ?? []).map(node => node.text ?? '').join(''))
    .join('\n');

export function jiraHttpWorld(cards: HttpCard[]) {
  const exchanges: JiraHttpExchange[] = [];
  const unexpected: string[] = [];
  const comments: Record<string, HttpComment[]> = {};
  const links: Record<string, Record<string, { id: number; url: string; title: string }>> = {};
  const changelog: Record<string, HttpChange[]> = {};
  /** HTTP statuses of the next issue edits (`PUT`), one each; a refused edit changes nothing. Absent = applied, `204`. */
  const editFaults: number[] = [];
  let commentSequence = 10040;
  let linkSequence = 20000;
  let changeSequence = 60000;
  /** One edit of a Card's labels and components by relative operations, with the changelog entry Jira would keep for it. */
  const edit = (card: HttpCard, update: IssueUpdate, origin: { accountId?: string; historyMetadata?: unknown } = { accountId: 'acc-person' }) => {
    const before = [...card.labels];
    for (const operation of update.labels ?? []) {
      if (operation.add && !card.labels.includes(operation.add)) card.labels.push(operation.add);
      if (operation.remove) card.labels = card.labels.filter(label => label !== operation.remove);
    }
    const items: ChangelogItem[] = [];
    if (before.join(' ') !== card.labels.join(' '))
      items.push({ field: 'labels', fieldId: 'labels', from: null, fromString: before.join(' '), to: null, toString: card.labels.join(' ') });
    for (const operation of update.components ?? []) {
      const id = operation.add?.id;
      if (!id || card.components.includes(id)) continue;
      card.components.push(id);
      items.push({ field: 'Component', fieldId: 'components', from: null, fromString: null, to: id, toString: `c${id}` });
    }
    if (!items.length) return;
    (changelog[card.id] ??= []).push({
      id: String((changeSequence += 1)),
      ...(origin.accountId ? { author: { accountId: origin.accountId } } : {}),
      created: new Date().toISOString(),
      items,
      ...(origin.historyMetadata === undefined ? {} : { historyMetadata: origin.historyMetadata }),
    });
  };
  const json = (body: unknown, status = 200): JiraHttpResult => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const find = (id: string) => cards.find(item => item.id === id);
  const send = async (exchange: JiraHttpExchange): Promise<JiraHttpResult> => {
    exchanges.push(exchange);
    const url = new URL(exchange.url);
    const path = url.pathname;
    const body = exchange.body ? (JSON.parse(exchange.body) as Record<string, unknown>) : {};
    if (url.origin !== jiraOrigin) {
      unexpected.push(`${exchange.method} ${exchange.url}`);
      return json({}, 404);
    }
    if (exchange.method === 'POST' && path === '/rest/api/3/search/jql') {
      const jql = String(body.jql);
      const listed = cards.filter(item => jql.includes(`project = ${item.projectId} `) && item.labels.some(label => jql.includes(`labels = "${label}"`)));
      return json({ issues: listed.map(item => ({ id: item.id, key: item.key, fields: { project: { id: item.projectId } } })), isLast: true });
    }
    if (exchange.method === 'GET' && path === '/rest/api/3/issueLinkType')
      return json({ issueLinkTypes: [{ id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] });
    if (exchange.method === 'GET' && path === '/rest/api/3/myself') return json({ accountId: 'acc-factory' });
    if (exchange.method === 'GET' && path === '/rest/api/3/mypermissions' && url.searchParams.get('projectId') === '10010') {
      return json({ permissions: Object.fromEntries((url.searchParams.get('permissions') ?? '').split(',').map(key => [key, { key, havePermission: true }])) });
    }
    const issue = /^\/rest\/api\/3\/issue\/(\d+)(\/comment|\/remotelink|\/changelog)?$/.exec(path);
    const card = issue ? find(issue[1]!) : undefined;
    if (issue && card && !issue[2] && exchange.method === 'PUT') {
      const fault = editFaults.shift();
      if (fault) return json({ errorMessages: ['synthetic refusal'] }, fault);
      // Only what a Triage publication may name: any other key (fields, transition, a set replaced) is a write the Factory never makes.
      const update = (body.update ?? {}) as IssueUpdate & Record<string, unknown>;
      const allowed =
        Object.keys(body).every(key => key === 'update' || key === 'historyMetadata') &&
        Object.keys(update).every(key => key === 'labels' || key === 'components');
      if (!allowed) {
        unexpected.push(`${exchange.method} ${exchange.url} ${exchange.body}`);
        return json({ errorMessages: ['synthetic: not modelled'] }, 400);
      }
      edit(card, update, { accountId: 'acc-factory', historyMetadata: body.historyMetadata });
      return { kind: 'response', status: 204, headers: {}, body: '' };
    }
    if (issue && card && issue[2] === '/changelog' && exchange.method === 'GET') {
      const all = changelog[card.id] ?? [];
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      return json({ startAt, maxResults: 100, total: all.length, values: all.slice(startAt, startAt + 100) });
    }
    if (issue && card && !issue[2] && exchange.method === 'GET') {
      const fields = url.searchParams.get('fields');
      if (fields === 'summary,description')
        return json({ id: card.id, key: card.key, fields: { summary: card.summary, description: card.description ? adf(card.description) : null } });
      if (fields === 'status') return json({ id: card.id, key: card.key, fields: { status: { statusCategory: { key: 'new' } } } });
      return json({
        id: card.id,
        key: card.key,
        fields: {
          labels: card.labels,
          components: card.components.map(id => ({ id, name: `c${id}` })),
          issuelinks: [],
          summary: card.summary,
          project: { id: card.projectId },
          status: { statusCategory: { key: 'new' } },
        },
      });
    }
    if (issue && card && issue[2] === '/comment' && exchange.method === 'GET') {
      const all = comments[card.id] ?? [];
      return json({
        startAt: Number(url.searchParams.get('startAt') ?? 0),
        total: all.length,
        comments: all.map(item => ({ id: item.id, author: { accountId: item.accountId }, body: adf(item.text), created: item.created, updated: item.updated })),
      });
    }
    if (issue && card && issue[2] === '/comment' && exchange.method === 'POST') {
      const id = String((commentSequence += 1)),
        created = new Date().toISOString();
      (comments[card.id] ??= []).push({ id, accountId: 'acc-factory', text: textOf(body.body), created, updated: created });
      return json({ id, created, author: { accountId: 'acc-factory' } }, 201);
    }
    if (issue && card && issue[2] === '/remotelink' && exchange.method === 'POST') {
      const object = body.object as { url: string; title: string };
      const existing = (links[card.id] ??= {})[String(body.globalId)];
      const id = existing?.id ?? (linkSequence += 1);
      links[card.id]![String(body.globalId)] = { id, url: object.url, title: object.title };
      return json({ id }, existing ? 200 : 201);
    }
    unexpected.push(`${exchange.method} ${exchange.url}`);
    return json({ errorMessages: ['synthetic: not modelled'] }, 404);
  };
  /** A comment written on the Card by a person (the Factory's shared account by default), a second after now. */
  const write = (issueId: string, text: string, accountId = 'acc-factory') => {
    const id = String((commentSequence += 1)),
      created = new Date(Date.now() + 1000).toISOString();
    (comments[issueId] ??= []).push({ id, accountId, text, created, updated: created });
    return id;
  };
  const posted = (issueId: string) => (comments[issueId] ?? []).filter(item => item.text.startsWith('[Software Factory · ')).map(item => item.text);
  const requests = () => exchanges.map(exchange => `${exchange.method} ${new URL(exchange.url).pathname}`);
  return { send, exchanges, unexpected, comments, links, changelog, editFaults, edit, write, posted, requests };
}
