import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateEntry, evaluatePublication, githubOnly, pollDelaySeconds, ticketKey, ticketLabel, workBranchName } from '../../src/control/rules/admission.js';

const listed = { repository: 'acme/project', repositoryId: 3, issueId: 7001, nodeId: 'I_node1', number: 1 };
const observed = (overrides: object = {}) => ({ kind: 'observed' as const, ticket: listed, state: 'open' as const, labels: [{ id: 55, name: 'Ready-For-Agent' }], pullRequest: false, ...overrides });

test('index key uses immutable repository and issue ids, never number, title or URL', () => {
  assert.equal(ticketKey(listed), 'github:repository:3:issue:7001');
  assert.notEqual(ticketKey(listed), ticketKey({ ...listed, issueId: 7002 }));
  assert.notEqual(ticketKey(listed), ticketKey({ ...listed, repositoryId: 4 }));
});

test('a Jira Ticket is keyed by (jira, siteId, issueId) only, without collisions and never in the GitHub form', () => {
  const jira = { tracker: 'jira' as const, siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
  assert.equal(ticketKey(jira), 'jira:site:site-A:issue:81017');
  const renamed = { ...jira, key: 'FIN-18', url: 'https://equipe.atlassian.net/browse/FIN-18' };
  assert.equal(ticketKey(renamed), ticketKey(jira), 'a key change is presentation only');
  assert.notEqual(ticketKey({ ...jira, siteId: 'site-B' }), ticketKey(jira));
  // Separators inside a part are encoded: ("a:issue:b", "c") and ("a", "b:issue:c") stay distinct.
  assert.notEqual(ticketKey({ ...jira, siteId: 'a:issue:b', issueId: 'c' }), ticketKey({ ...jira, siteId: 'a', issueId: 'b:issue:c' }));
  assert.doesNotMatch(ticketKey(jira), /^github:repository:\d+:issue:(\d+)$/);
  assert.equal(ticketKey({ tracker: 'github', ...listed }), 'github:repository:3:issue:7001', 'the tagged GitHub reference keeps the same key');
});

test('a Ticket is presented as owner/repo#n on GitHub and by its key on Jira; GitHub-only paths refuse a Jira reference', () => {
  assert.equal(ticketLabel({ tracker: 'github', ...listed }), 'acme/project#1');
  const jira = { tracker: 'jira' as const, siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };
  assert.equal(ticketLabel(jira), 'PAG-42');
  assert.equal(githubOnly({ tracker: 'github' as const, ...listed }).number, 1);
  assert.throws(() => githubOnly(jira), /TICKET_ORIGIN_NOT_GITHUB/);
});

test('entry requires configured repository, open issue, effective label (GitHub label names are case-insensitive) and stable identity', () => {
  assert.deepEqual(evaluateEntry({ configuredLabel: 'ready-for-agent', listed, facts: observed() }), { authorized: true, label: { id: 55, name: 'Ready-For-Agent' } });
  const codes = (facts: Parameters<typeof evaluateEntry>[0]['facts'], configured = true) => {
    const result = evaluateEntry({ configuredLabel: configured ? 'ready-for-agent' : undefined, listed, facts });
    return result.authorized ? [] : result.holds.map(hold => hold.code);
  };
  assert.deepEqual(codes(observed(), false), ['REPOSITORY_NOT_CONFIGURED']);
  assert.deepEqual(codes(observed({ state: 'closed', labels: [] })), ['TICKET_NOT_OPEN', 'LABEL_NOT_PRESENT'], 'dimensions are not collapsed');
  assert.deepEqual(codes(observed({ pullRequest: true })), ['TICKET_IS_PULL_REQUEST']);
  assert.deepEqual(codes(observed({ ticket: { ...listed, nodeId: 'other' } })), ['TICKET_IDENTITY_MISMATCH']);
  assert.deepEqual(codes(observed({ ticket: { ...listed, number: 2 } })), ['TICKET_IDENTITY_MISMATCH']);
  const unavailable = evaluateEntry({ configuredLabel: 'ready-for-agent', listed, facts: { kind: 'unavailable', code: 'GITHUB_RATE_LIMITED', waitSeconds: 30, nextStep: 'wait' } });
  assert.equal(unavailable.authorized, false);
  if (!unavailable.authorized) {
    assert.deepEqual([unavailable.holds[0]!.code, unavailable.holds[0]!.observedCode, unavailable.holds[0]!.waitSeconds], ['TICKET_READ_UNAVAILABLE', 'GITHUB_RATE_LIMITED', 30]);
    assert.match(unavailable.holds[0]!.nextStep, /does not prove absence/);
  }
});

test('associated pull requests are foreign unless they are on a known own branch of the same repository', () => {
  const pr = { pullRequestId: 1, number: 9, url: 'u', state: 'open' as const, merged: false, headRef: 'factory/w', headRepositoryId: 3, association: ['closing-reference'] };
  assert.deepEqual(evaluatePublication({ facts: { kind: 'observed', repositoryId: 3, candidates: [] }, ownBranches: [] }), { clear: true });
  assert.deepEqual(evaluatePublication({ facts: { kind: 'observed', repositoryId: 3, candidates: [pr] }, ownBranches: ['factory/w'] }), { clear: true });
  for (const [candidate, own] of [[pr, []], [{ ...pr, headRepositoryId: 99 }, ['factory/w']], [{ ...pr, headRepositoryId: null }, ['factory/w']]] as const) {
    const result = evaluatePublication({ facts: { kind: 'observed', repositoryId: 3, candidates: [candidate] }, ownBranches: [...own] });
    assert.equal(result.clear, false);
    if (!result.clear) assert.equal(result.holds[0]!.code, 'FOREIGN_PULL_REQUEST');
  }
  const unknown = evaluatePublication({ facts: { kind: 'unavailable', code: 'INCOMPLETE_GITHUB_QUERY', nextStep: 'x' }, ownBranches: [] });
  assert.equal(!unknown.clear && unknown.holds[0]!.code, 'PUBLICATION_UNKNOWN');
});

test('poll delay: interval on success, service wait prevails, bounded exponential backoff on failure', () => {
  assert.equal(pollDelaySeconds({ intervalSeconds: 60, outcome: 'observed', consecutiveFailures: 0 }), 60);
  assert.equal(pollDelaySeconds({ intervalSeconds: 60, outcome: 'observed', waitSeconds: 600, consecutiveFailures: 0 }), 600);
  assert.deepEqual([1, 2, 3, 4, 5, 30].map(n => pollDelaySeconds({ intervalSeconds: 60, outcome: 'unavailable', consecutiveFailures: n })), [60, 120, 240, 480, 900, 900]);
  assert.equal(pollDelaySeconds({ intervalSeconds: 60, outcome: 'unavailable', waitSeconds: 3600, consecutiveFailures: 1 }), 3600);
  assert.equal(pollDelaySeconds({ intervalSeconds: 1200, outcome: 'unavailable', consecutiveFailures: 9 }), 1200, 'cap never shortens the configured interval');
});

test('Jira ticket 04: the Work branch is named by the immutable Ticket identity (GitHub number unchanged; Jira issue ID, never the key)', () => {
  const workId = '0b9c6a52-3d3e-4c8f-9a51-000000000001';
  assert.equal(workBranchName({ tracker: 'github', number: 3 }, workId), 'factory/3-0b9c6a52');
  assert.equal(workBranchName({ tracker: 'jira', issueId: '81017' }, workId), 'factory/jira-81017-0b9c6a52');
  assert.throws(() => workBranchName({ tracker: 'jira', issueId: '../x' }, workId), /TICKET_ID_INVALID/);
});
