import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockerDirection, evaluateJiraCandidate, routeTicket, type JiraBlockerFacts } from '../../src/control/rules/jira-admission.js';

// Jira ticket 03 (spec §3 steps 1-3): pure rules deciding whether a Jira candidate may start. No I/O, no clock: callers pass facts.
const routes = [{ componentId: '10021', repository: 'equipe/checkout-web' }, { componentId: '10022', repository: 'equipe/payments-api' },
  { componentId: '10023', repository: 'equipe/checkout-web' }];
const authorized = ['equipe/checkout-web', 'equipe/payments-api'];

test('complete components route to the distinct authorized destinations; an unrouted component is ignored beside a routed one', () => {
  assert.deepEqual(routeTicket({ components: ['10021'], routes, authorizedRepositories: authorized }), { kind: 'single', repository: 'equipe/checkout-web' });
  assert.deepEqual(routeTicket({ components: ['10021', '10023'], routes, authorizedRepositories: authorized }), { kind: 'single', repository: 'equipe/checkout-web' },
    'two routes to the same repository are one destination');
  assert.deepEqual(routeTicket({ components: ['10021', '10099'], routes, authorizedRepositories: authorized }), { kind: 'single', repository: 'equipe/checkout-web' },
    'Checkout plus an unrouted component (UX) still points to checkout-web');
});

test('zero destinations, divergent destinations and a partial component list are kept apart', () => {
  assert.deepEqual(routeTicket({ components: [], routes, authorizedRepositories: authorized }), { kind: 'none' });
  assert.deepEqual(routeTicket({ components: ['10099'], routes, authorizedRepositories: authorized }), { kind: 'none' }, 'only UX: no route');
  assert.deepEqual(routeTicket({ components: ['10021', '10022'], routes, authorizedRepositories: authorized }),
    { kind: 'divergent', repositories: ['equipe/checkout-web', 'equipe/payments-api'] });
  assert.deepEqual(routeTicket({ components: null, routes, authorizedRepositories: authorized }), { kind: 'unverifiable' }, 'a partial list is never zero routes');
});

test('a route to a repository that is no longer an authorized destination does not count', () => {
  assert.deepEqual(routeTicket({ components: ['10022'], routes, authorizedRepositories: ['equipe/checkout-web'] }), { kind: 'none' });
  assert.deepEqual(routeTicket({ components: ['10021', '10022'], routes, authorizedRepositories: ['equipe/checkout-web'] }), { kind: 'single', repository: 'equipe/checkout-web' });
});

const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const relates = { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' };
const catalogue = [blocks, relates, { id: '10001', name: 'Cloners', inward: 'is cloned by', outward: 'clones' }];
const link = (type: typeof blocks, end: 'inward' | 'outward') => ({ linkId: '811', type, end, issue: { issueId: '70202', key: 'OPS-9' } });

test('the Blocks type and its direction come from the site catalogue: only the inward "is blocked by" neighbour blocks the root', () => {
  assert.deepEqual(blockerDirection({ catalogue, link: link(blocks, 'inward') }), { kind: 'blocker', issueId: '70202', key: 'OPS-9' });
  assert.deepEqual(blockerDirection({ catalogue, link: link(blocks, 'outward') }), { kind: 'not-blocker' }, 'the root blocks the neighbour: not a blocker');
  assert.deepEqual(blockerDirection({ catalogue, link: link(relates, 'inward') }), { kind: 'not-blocker' });
});

test('a custom type or an ambiguous direction needs the operator; a link that disagrees with the catalogue is unverifiable', () => {
  const custom = { id: '10200', name: 'Depends', inward: 'depends on', outward: 'is depended on by' };
  assert.equal(blockerDirection({ catalogue: [...catalogue, custom], link: link(custom, 'inward') }).kind, 'needs-operator');
  const swapped = { ...blocks, inward: 'blocks', outward: 'is blocked by' };
  const edited = blockerDirection({ catalogue: [swapped, relates], link: link(swapped, 'inward') });
  assert.equal(edited.kind === 'needs-operator' && edited.code, 'JIRA_LINK_DIRECTION_AMBIGUOUS', 'edited Blocks labels: direction is not assumed');
  const twice = { ...blocks, id: '10300' };
  assert.equal(blockerDirection({ catalogue: [...catalogue, twice], link: link(blocks, 'inward') }).kind, 'needs-operator', 'two Blocks types');
  assert.equal(blockerDirection({ catalogue: [relates], link: link(blocks, 'inward') }).kind, 'unverifiable', 'type absent from the catalogue');
  assert.equal(blockerDirection({ catalogue: [{ ...blocks, inward: 'x' }], link: link(blocks, 'inward') }).kind, 'unverifiable', 'embedded type differs');
});

const single = { kind: 'single' as const, repository: 'equipe/payments-api' };
const visible = (blockers: { issueId: string; key: string; statusCategory: string }[]): JiraBlockerFacts => ({ kind: 'observed', blockers });
const codes = (evaluation: ReturnType<typeof evaluateJiraCandidate>) => evaluation.reasons.map(reason => reason.code);

test('a valid empty visible list or only Done blockers releases the candidate; Done is the category, never the status name', () => {
  assert.deepEqual(evaluateJiraCandidate({ labelPresent: true, route: single, links: [], blockers: visible([]) }),
    { decision: 'eligible', repository: 'equipe/payments-api', reasons: [] });
  const done = evaluateJiraCandidate({ labelPresent: true, route: single, links: [{ kind: 'blocker', issueId: '70202', key: 'OPS-9' }],
    blockers: visible([{ issueId: '70202', key: 'OPS-9', statusCategory: 'done' }]) });
  assert.equal(done.decision, 'eligible', 'an external neighbour in Done, outside the project and without the label');
  const open = evaluateJiraCandidate({ labelPresent: true, route: single, links: [{ kind: 'blocker', issueId: '70202', key: 'OPS-9' }],
    blockers: visible([{ issueId: '70202', key: 'OPS-9', statusCategory: 'indeterminate' }]) });
  assert.equal(open.decision, 'blocked');
  assert.deepEqual(codes(open), ['JIRA_BLOCKER_NOT_DONE']);
  assert.doesNotMatch(open.reasons[0]!.nextStep, /OPS-9|70202/, 'the operator-facing step never names a possibly restricted neighbour');
});

test('zero or divergent destinations and links needing the operator block; partial facts are unverifiable, never released', () => {
  assert.deepEqual(codes(evaluateJiraCandidate({ labelPresent: true, route: { kind: 'none' }, links: [], blockers: visible([]) })), ['JIRA_ROUTE_NONE']);
  const divergent = evaluateJiraCandidate({ labelPresent: true, route: { kind: 'divergent', repositories: ['equipe/checkout-web', 'equipe/payments-api'] }, links: [], blockers: visible([]) });
  assert.equal(divergent.decision, 'blocked');
  assert.deepEqual(codes(divergent), ['JIRA_ROUTE_DIVERGENT']);
  const custom = evaluateJiraCandidate({ labelPresent: true, route: single, links: [{ kind: 'needs-operator', code: 'JIRA_LINK_TYPE_CUSTOM', linkId: '811', typeId: '10200' }], blockers: visible([]) });
  assert.equal(custom.decision, 'blocked');
  assert.deepEqual(codes(custom), ['JIRA_LINK_TYPE_CUSTOM']);

  const partial = evaluateJiraCandidate({ labelPresent: true, route: { kind: 'unverifiable' }, links: [], blockers: visible([]) });
  assert.equal(partial.decision, 'unverifiable');
  assert.deepEqual(codes(partial), ['JIRA_COMPONENTS_UNVERIFIABLE']);
  for (const observedCode of ['JIRA_FORBIDDEN', 'JIRA_NOT_FOUND', 'JIRA_TIMEOUT', 'JIRA_OBSERVATION_INVALID']) {
    const unknown = evaluateJiraCandidate({ labelPresent: true, route: single, links: [], blockers: { kind: 'unavailable', code: observedCode, nextStep: 'Retry later.' } });
    assert.equal(unknown.decision, 'unverifiable', observedCode);
    assert.deepEqual(unknown.reasons.map(reason => [reason.code, reason.observedCode]), [['JIRA_BLOCKERS_UNVERIFIABLE', observedCode]]);
  }
  const inconsistent = evaluateJiraCandidate({ labelPresent: true, route: single, links: [{ kind: 'unverifiable', code: 'JIRA_LINK_TYPE_INCONSISTENT', linkId: '811' }],
    blockers: visible([]) });
  assert.equal(inconsistent.decision, 'unverifiable');
});

test('a removed label is not a candidate: no reason to communicate, whatever else was observed', () => {
  assert.deepEqual(evaluateJiraCandidate({ labelPresent: false, route: { kind: 'none' }, links: [], blockers: { kind: 'unavailable', code: 'JIRA_TIMEOUT', nextStep: 'x' } }),
    { decision: 'not-candidate', reasons: [] });
});

test('the operator indication by link type ID resolves a custom or ambiguous type; an unindicated one keeps blocking and names the key', () => {
  const custom = { id: '10500', name: 'Depends', inward: 'depends on', outward: 'is depended on by' };
  const all = [...catalogue, custom];
  const inward = [{ id: '10500', blocks: 'inward' as const }];
  assert.deepEqual(blockerDirection({ catalogue: all, link: link(custom, 'inward'), linkTypes: inward }), { kind: 'blocker', issueId: '70202', key: 'OPS-9' });
  assert.deepEqual(blockerDirection({ catalogue: all, link: link(custom, 'outward'), linkTypes: inward }), { kind: 'not-blocker' });
  assert.deepEqual(blockerDirection({ catalogue: all, link: link(custom, 'outward'), linkTypes: [{ id: '10500', blocks: 'outward' }] }),
    { kind: 'blocker', issueId: '70202', key: 'OPS-9' }, 'the outward neighbour blocks the root');
  assert.deepEqual(blockerDirection({ catalogue: all, link: link(custom, 'inward'), linkTypes: [{ id: '10500', blocks: 'none' }] }), { kind: 'not-blocker' });
  const swapped = { ...blocks, inward: 'blocks', outward: 'is blocked by' };
  assert.deepEqual(blockerDirection({ catalogue: [swapped, relates], link: link(swapped, 'outward'), linkTypes: [{ id: '10000', blocks: 'outward' }] }),
    { kind: 'blocker', issueId: '70202', key: 'OPS-9' }, 'an edited Blocks type follows the indication');
  assert.deepEqual(blockerDirection({ catalogue, link: link(blocks, 'inward'), linkTypes: [{ id: '10000', blocks: 'none' }] }),
    { kind: 'blocker', issueId: '70202', key: 'OPS-9' }, 'the unambiguous Blocks type is never overridden');
  assert.equal(blockerDirection({ catalogue: [relates], link: link(custom, 'inward'), linkTypes: inward }).kind, 'unverifiable', 'an indication never vouches for an inconsistent link');
  const unindicated = blockerDirection({ catalogue: all, link: link(custom, 'inward'), linkTypes: [{ id: '10999', blocks: 'none' }] });
  assert.deepEqual(unindicated, { kind: 'needs-operator', code: 'JIRA_LINK_TYPE_CUSTOM', linkId: '811', typeId: '10500' });
  const evaluation = evaluateJiraCandidate({ labelPresent: true, route: { kind: 'single', repository: 'equipe/payments-api' }, links: [unindicated], blockers: { kind: 'observed', blockers: [] } });
  assert.equal(evaluation.decision, 'blocked');
  assert.match(evaluation.reasons[0]!.nextStep, /linkTypes/);
  assert.match(evaluation.reasons[0]!.nextStep, /10500/);
});
