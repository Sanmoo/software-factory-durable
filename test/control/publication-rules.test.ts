import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCandidate, decideDiscovery, descriptionCheck, publicationMarker, publicationPrompt, publicationStep, publishableContent,
  type CandidateFacts } from '../../src/control/rules/publication.js';
import type { ExecutionView, PublicationView } from '../../src/control/types.js';

// Rule level (R): pure publication decisions of ticket 14 (spec §9.1). No I/O; the verification is ticket 13's record, consumed as data.
const workId = '0b9c6a52-3d3e-4c8f-9a51-000000000001';
const branch = 'factory/3-0b9c6a52';
const head = 'd'.repeat(40);
const marker = publicationMarker(workId);
const app = { login: 'factory-app[bot]', id: 41898282 };
const expect = { workId, ticketNumber: 3, branch, base: 'main', repositoryId: 3, head, app };
const refs = { 'refs/heads/main': 'b'.repeat(40) };
const protectedBase = { state: 'pull-request-required' as const, sources: ['ruleset:1'] };
const body = [marker, '## Summary', 'Adds the factory note. Closes #3', '## Validation', 'npm test: passed (Factory gate t1).', '## Risk', 'Low: docs only.'].join('\n');
const own = (overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({ pullRequestId: 9004, nodeId: 'PR_node4', number: 4, url: 'https://github.com/acme/project/pull/4',
  state: 'open', merged: false, draft: true, headRef: branch, headSha: head, baseRef: 'main', headRepositoryId: 3, author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' },
  body, ...overrides });
const observed = (candidates: CandidateFacts[], tip: { state: 'absent' } | { state: 'present'; sha: string } | { state: 'unknown'; code: string } = { state: 'present', sha: head },
  extra: { refs?: Record<string, string> | 'unknown'; baseProtection?: Parameters<typeof decideDiscovery>[0]['observation'] extends infer O ? O extends { baseProtection: infer P } ? P : never : never } = {}) =>
  ({ kind: 'observed' as const, repositoryId: 3, candidates, branch: tip,
    refs: extra.refs === 'unknown' ? { state: 'unknown' as const, code: 'GITHUB_QUERY_FAILED' } : { state: 'complete' as const, refs: extra.refs ?? refs },
    baseProtection: extra.baseProtection ?? protectedBase });

/** A completed, ceased Execution whose ticket 13 verification and final capture are given. */
function execution(overrides: { verification?: object | null; content?: object | null; outcome?: 'completed' | 'failure'; cessation?: 'confirmed' | 'unconfirmed';
  summaryHead?: string; publication?: ExecutionView['request']['publication']; started?: boolean; executionId?: string } = {}): ExecutionView {
  const summary = { version: 1, round: 2, index: 'i', indexSha256: 'a'.repeat(64), head: overrides.summaryHead ?? head, branch, base: 'b'.repeat(40), mergeBase: 'b'.repeat(40),
    counts: {}, patches: {}, spec: null, instructions: null, changed: [], changedTruncated: false,
    ...(overrides.content === null ? {} : { content: overrides.content ?? { sha256: 'f'.repeat(64), clean: true, headMatches: true } }) };
  const verification = overrides.verification === null ? undefined : overrides.verification ?? { at: '2026-11-14T10:00:00.000Z', status: 'verified', reasons: [], reviewedRound: 1,
    finalRound: 2, contentSha256: 'f'.repeat(64), applicability: { kind: 'identical-commit', head, reviewedHead: 'e'.repeat(40) },
    gates: [{ id: 't1', outcome: 'passed', current: true, boundToFinalContent: true, requiredCheck: null }], treatments: [], requiredChecks: [] };
  return { executionId: overrides.executionId ?? 'e1', invocationId: 'builder-e1', mode: 'initial', state: 'ended',
    slot: { held: false, capacity: 1, reservedAt: 'x', releasedAt: 'y' }, start: overrides.started === false ? null : { receiptId: 'r', confirmedAt: 'x' },
    request: { ticket: 'https://github.com/acme/project/issues/3', repository: 'acme/project', base: 'main', branch, baseCommit: 'b'.repeat(40), checkout: '/workspace/checkout',
      promptSha256: null, skillPack: null, policies: {}, ...(overrides.publication ? { publication: overrides.publication } : {}) },
    end: { at: 'z', outcome: overrides.outcome ?? 'completed', code: null, cessation: overrides.cessation ?? 'confirmed' },
    review: { rounds: [{ round: 2, handoff: { summary } }], ...(verification ? { verification } : {}) } } as unknown as ExecutionView;
}

test('AC2: only content the end-of-Execution verification established is publishable; a completed Execution is never success by itself', () => {
  const ok = publishableContent(execution());
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.verified.executionId, ok.verified.head, ok.verified.contentSha256, ok.verified.reviewedRound, ok.verified.gates],
    ['e1', head, 'f'.repeat(64), 1, [{ id: 't1', outcome: 'passed' }]]);
  const reasons = (value: ReturnType<typeof publishableContent>) => value.ok ? [] : value.reasons;
  assert.deepEqual(reasons(publishableContent(execution({ verification: null }))), ['REVIEW_VERIFICATION_ABSENT'], 'reviews of ticket 12 alone are not a verification');
  assert.deepEqual(reasons(publishableContent(execution({ verification: { status: 'not-verified', reasons: ['GATE_FAILED:t1'], contentSha256: 'f'.repeat(64) } }))),
    ['REVIEW_NOT_VERIFIED', 'VERIFICATION:GATE_FAILED:t1']);
  assert.deepEqual(reasons(publishableContent(execution({ outcome: 'failure' }))), ['EXECUTION_NOT_COMPLETED']);
  assert.deepEqual(reasons(publishableContent(execution({ cessation: 'unconfirmed' }))), ['CESSATION_NOT_CONFIRMED']);
  assert.deepEqual(reasons(publishableContent(execution({ content: { sha256: 'f'.repeat(64), clean: false, headMatches: false } }))), ['VERIFIED_CONTENT_NOT_COMMITTED'],
    'uncommitted verified content cannot be pushed as that commit');
  assert.deepEqual(reasons(publishableContent(execution({ content: { sha256: '0'.repeat(64), clean: true, headMatches: true } }))), ['VERIFICATION_CONTENT_MISMATCH']);
  assert.deepEqual(reasons(publishableContent(execution({ content: null }))), ['FINAL_CAPTURE_CONTENT_UNKNOWN']);
  assert.ok(reasons(publishableContent(execution({ publication: { basisExecutionId: 'e0', head, branch, base: 'main', marker, expectedRemote: { state: 'absent' } } })))
    .includes('PUBLICATION_EXECUTION'), 'a publication activation is never itself a basis');
});

test('AC2/AC4: ownership needs the marker, the App bot author, the own branch, repository and base; anything else is never adopted', () => {
  assert.deepEqual(classifyCandidate(own(), expect), { own: true, reasons: [] });
  assert.deepEqual(classifyCandidate(own({ body: 'no marker' }), expect).reasons, ['MARKER_ABSENT']);
  assert.deepEqual(classifyCandidate(own({ body: publicationMarker('0b9c6a52-3d3e-4c8f-9a51-000000000002') }), expect).reasons, ['MARKER_ABSENT'], 'another Work\'s marker');
  assert.deepEqual(classifyCandidate(own({ author: { id: 10, login: 'human', type: 'User' } }), expect).reasons, ['AUTHOR_NOT_FACTORY_APP'], 'a human copying the marker is not the Factory');
  // Review MED 3: the App identity is pinned; another bot carrying the marker is not the Factory, and an unknown identity owns nothing.
  assert.deepEqual(classifyCandidate(own({ author: { id: 777, login: 'other-app[bot]', type: 'Bot' } }), expect).reasons, ['AUTHOR_NOT_FACTORY_APP']);
  assert.deepEqual(classifyCandidate(own({ author: { id: 41898282, login: 'other-app[bot]', type: 'Bot' } }), expect).reasons, ['AUTHOR_NOT_FACTORY_APP'], 'login and id both');
  assert.deepEqual(classifyCandidate(own(), { ...expect, app: null }).reasons, ['FACTORY_APP_IDENTITY_UNKNOWN']);
  assert.deepEqual(decideDiscovery({ expect: { ...expect, app: null }, attempted: false, observation: observed([], { state: 'absent' }) }).reasons, ['FACTORY_APP_IDENTITY_UNKNOWN'],
    'nothing is requested without the pinned identity');
  assert.deepEqual(classifyCandidate(own({ headRef: 'factory/3-other' }), expect).reasons, ['OTHER_BRANCH']);
  assert.deepEqual(classifyCandidate(own({ headRepositoryId: 99 }), expect).reasons, ['OTHER_REPOSITORY']);
  assert.deepEqual(classifyCandidate(own({ baseRef: 'release' }), expect).reasons, ['OTHER_BASE']);
});

test('AC4/AC6: discovery links exactly one own draft PR at the verified head; absence (complete, never attempted) requests publication', () => {
  const linked = decideDiscovery({ expect, attempted: true, observation: observed([own()]) });
  assert.equal(linked.outcome, 'linked');
  assert.equal(decideDiscovery({ expect, attempted: false, observation: observed([], { state: 'absent' }) }).outcome, 'absent');
  assert.deepEqual(decideDiscovery({ expect, attempted: false, observation: observed([], { state: 'absent' }) }),
    { outcome: 'absent', expectedRemote: { state: 'absent' }, update: null, refs, reasons: [], candidates: [] }, 'the request keeps the refs snapshot');
  // The verified commit already on the remote branch is a compatible own push (only the PR is missing): the lease expects it.
  assert.deepEqual(decideDiscovery({ expect, attempted: false, observation: observed([]) }),
    { outcome: 'absent', expectedRemote: { state: 'present', sha: head }, update: null, refs, reasons: [], candidates: [] });
});

test('AC4/AC6: the expected branch name is not authorship; unknown PRs, several candidates, unknown changes and incomplete reads block repetition', () => {
  const blocked = (input: Parameters<typeof decideDiscovery>[0]) => { const value = decideDiscovery(input); return [value.outcome, value.reasons]; };
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([], { state: 'present', sha: 'e'.repeat(40) }) }), ['blocked', ['REMOTE_BRANCH_UNKNOWN_CHANGE']]);
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([own({ body: null, author: { id: 10, login: 'human', type: 'User' } })]) }),
    ['held', ['UNKNOWN_PULL_REQUEST:4']], 'a PR on the expected branch without correlation is not adopted; before any attempt it is held (07 operator path)');
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own({ body: null, author: { id: 10, login: 'human', type: 'User' } })]) }),
    ['blocked', ['UNKNOWN_PULL_REQUEST:4']], 'after an attempt it blocks');
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own(), own({ number: 5, pullRequestId: 9005, url: 'https://github.com/acme/project/pull/5' })]) }),
    ['blocked', ['MULTIPLE_OWN_PULL_REQUESTS:4,5']]);
  assert.deepEqual(blocked({ expect, attempted: true, observation: { kind: 'incomplete', code: 'GITHUB_QUERY_FAILED' } }), ['incomplete', ['GITHUB_QUERY_FAILED']]);
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([], { state: 'unknown', code: 'GITHUB_QUERY_FAILED' }) }), ['incomplete', ['REMOTE_BRANCH_UNKNOWN:GITHUB_QUERY_FAILED']]);
  // After a publication attempt, an empty first read never proves absence: no automatic repetition.
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([], { state: 'absent' }) }), ['blocked', ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_ABSENT']]);
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([]) }), ['blocked', ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_AT_VERIFIED_HEAD']]);
  // Ticket 21 supersedes the ticket 14 block here: a head the Factory never linked or pushed is a DIVERGENCE (Question), never a repetition.
  const notVerified = decideDiscovery({ expect, attempted: true, observation: observed([own({ headSha: 'e'.repeat(40) })], { state: 'present', sha: 'e'.repeat(40) }) });
  assert.deepEqual([notVerified.outcome, notVerified.reasons[0]], ['diverged', `HUMAN_CHANGE_NOT_ATTRIBUTABLE:${'e'.repeat(40)}`]);
  assert.equal(notVerified.outcome === 'diverged' && notVerified.pullRequest.number, 4, 'an own PR is kept, never recreated, even when it cannot be accepted');
  const older = decideDiscovery({ expect, attempted: true, previousHeads: ['e'.repeat(40)], observation: observed([own({ headSha: 'e'.repeat(40) })], { state: 'present', sha: 'e'.repeat(40) }) });
  assert.deepEqual([older.outcome, older.reasons], ['blocked', ['PUBLISHED_HEAD_NOT_VERIFIED']], 'an earlier Factory head after an attempt still blocks (ticket 14)');
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own({ draft: false })]) }), ['blocked', ['PULL_REQUEST_NOT_DRAFT']]);
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own({ state: 'closed', merged: true })]) }), ['blocked', ['OWN_PULL_REQUEST_MERGED']]);
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own()], { state: 'present', sha: 'e'.repeat(40) }) }),
    ['diverged', [`HUMAN_CHANGE_NOT_ATTRIBUTABLE:${'e'.repeat(40)}`]], 'ticket 21: the branch moved past the own PR head outside the Factory');
  assert.deepEqual(blocked({ expect, attempted: true, previousHeads: ['e'.repeat(40)], observation: observed([own()], { state: 'present', sha: 'e'.repeat(40) }) }),
    ['blocked', ['REMOTE_BRANCH_CHANGED']], 'a branch back at an earlier Factory head still blocks (ticket 14)');
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own(), own({ number: 9, pullRequestId: 9009, headRef: 'human/x', body: 'Closes #3', author: { id: 10, login: 'h', type: 'User' } })]) }),
    ['blocked', ['UNKNOWN_PULL_REQUEST:9']], 'an unknown associated PR is never adopted nor ignored');
  // Review LOW: a non-conformant description is never linked as published.
  assert.deepEqual(blocked({ expect, attempted: true, observation: observed([own({ body: `${marker}\nno sections` })]) }),
    ['blocked', ['DESCRIPTION_NONCONFORMANT:SUMMARY_SECTION_MISSING+VALIDATION_SECTION_MISSING+RISK_SECTION_MISSING+TICKET_LINK_MISSING']]);
});

test('review MED 4: a request needs a complete refs snapshot and a base requiring PRs without App bypass; other refs changed during the window block', () => {
  const blocked = (input: Parameters<typeof decideDiscovery>[0]) => { const value = decideDiscovery(input); return [value.outcome, value.reasons]; };
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([], { state: 'absent' }, { refs: 'unknown' }) }), ['incomplete', ['REFS_UNKNOWN:GITHUB_QUERY_FAILED']]);
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([], { state: 'absent' }, { baseProtection: { state: 'not-required', reason: 'NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS' } }) }),
    ['blocked', ['BASE_PROTECTION_NOT_VERIFIED:NO_PULL_REQUEST_RULE_WITHOUT_APP_BYPASS']], 'no publication without a base the App cannot update directly');
  assert.deepEqual(blocked({ expect, attempted: false, observation: observed([], { state: 'absent' }, { baseProtection: { state: 'unknown', code: 'GITHUB_ACCESS_DENIED' } }) }),
    ['incomplete', ['BASE_PROTECTION_UNKNOWN:GITHUB_ACCESS_DENIED']]);
  const after = { ...refs, [`refs/heads/${branch}`]: head };
  assert.deepEqual(blocked({ expect, attempted: true, refsBefore: refs, observation: observed([own()], { state: 'present', sha: head }, { refs: after }) }), ['linked', []], 'the own branch may change');
  assert.deepEqual(blocked({ expect, attempted: true, refsBefore: refs, observation: observed([own()], { state: 'present', sha: head }, { refs: { ...after, 'refs/heads/main': 'e'.repeat(40) } }) }),
    ['blocked', ['UNEXPECTED_REF_CHANGE:refs/heads/main']]);
  assert.deepEqual(blocked({ expect, attempted: true, refsBefore: refs, observation: observed([own()], { state: 'present', sha: head }, { refs: { ...after, 'refs/tags/v9': head } }) }),
    ['blocked', ['UNEXPECTED_REF_CHANGE:refs/tags/v9']]);
  assert.deepEqual(blocked({ expect, attempted: true, refsBefore: refs, observation: observed([own()], { state: 'present', sha: head }, { refs: 'unknown' }) }), ['incomplete', ['REFS_UNKNOWN:GITHUB_QUERY_FAILED']]);
});

test('review MED 6: a later verified head updates the linked own PR once; the same head is never requested twice', () => {
  const old = 'a'.repeat(40);
  const update = decideDiscovery({ expect, attempted: false, previousHeads: [old], observation: observed([own({ headSha: old })], { state: 'present', sha: old }) });
  assert.equal(update.outcome, 'absent');
  assert.ok(update.outcome === 'absent' && update.update?.number === 4 && JSON.stringify(update.expectedRemote) === JSON.stringify({ state: 'present', sha: old }));
  assert.deepEqual(decideDiscovery({ expect, attempted: true, previousHeads: [old], observation: observed([own({ headSha: old })], { state: 'present', sha: old }) }).reasons,
    ['PUBLISHED_HEAD_NOT_VERIFIED'], 'an attempted head is never re-requested');
  assert.deepEqual(decideDiscovery({ expect, attempted: false, previousHeads: [], observation: observed([own({ headSha: old })], { state: 'present', sha: old }) }).reasons,
    [`HUMAN_CHANGE_NOT_ATTRIBUTABLE:${old}`], 'only a head the Factory itself linked may be updated; any other is a divergence (ticket 21)');
});

test('AC3: the description is short summary/validation/risk with the marker and the Ticket link; no transcript or local path presented as a link', () => {
  assert.deepEqual(descriptionCheck(body, { workId, ticketNumber: 3 }), { conformant: true, reasons: [] });
  assert.deepEqual(descriptionCheck(`${marker}\n## Resumo\nMuda X. Closes #3\n## Validação\nok\n## Risco\nbaixo`, { workId, ticketNumber: 3 }).conformant, true, 'Portuguese headings');
  const reasons = (text: string | null) => descriptionCheck(text, { workId, ticketNumber: 3 }).reasons;
  assert.deepEqual(reasons(null), ['DESCRIPTION_MISSING']);
  assert.deepEqual(reasons(body.replace(marker + '\n', '')), ['MARKER_NOT_FIRST_LINE']);
  assert.deepEqual(reasons(body.replace('## Risk\nLow: docs only.', '')), ['RISK_SECTION_MISSING']);
  assert.deepEqual(reasons(body.replace(' Closes #3', '')), ['TICKET_LINK_MISSING']);
  assert.deepEqual(reasons(`${body}\nSee [the log](/artifacts/review/r1/standards.json).`), ['LOCAL_PATH_AS_LINK']);
  assert.deepEqual(reasons(`${body}\n[x](file:///workspace/checkout/a.ts)`), ['LOCAL_PATH_AS_LINK']);
  assert.deepEqual(reasons(`${body}\n\`\`\`\n${'line\n'.repeat(40)}\`\`\``), ['TRANSCRIPT_LIKE']);
  assert.deepEqual(reasons(`${body}\n${'x'.repeat(7000)}`), ['DESCRIPTION_TOO_LONG']);
});

test('AC1/AC5: the publication request names the exact commit, branch, base, lease expectation and marker; it never asks to merge or approve', () => {
  const input = { reason: 'PUBLISH_ONLY_SESSION', pullRequest: null, executionId: 'e2', previousExecutionId: 'e1', skillDirectory: '/artifacts/factory/skill-pack/factory-skills-v6',
    repository: 'acme/project', base: 'main', branch, head, marker, ticket: { number: 3, url: 'https://github.com/acme/project/issues/3' }, workId, checkout: '/workspace/checkout',
    expectedRemote: { state: 'absent' as const }, verified: { reviewedRound: 1, gates: [{ id: 't1', outcome: 'passed' }], requiredChecks: [] } };
  const continued = publicationPrompt(input);
  assert.equal(continued.kind, 'prompt');
  if (continued.kind !== 'prompt') return;
  assert.match(continued.prompt, /^Factory publication instruction \(publish-only session/);
  assert.match(continued.prompt, /PUBLISH-ONLY/);
  // Ticket 18 real run q18-v3: the guest-writable checkout had lost its `origin`; the instruction names the configured repository URL itself.
  assert.ok(continued.prompt.includes(`--force-with-lease=refs/heads/${branch}: https://github.com/acme/project.git ${head}:refs/heads/${branch}`), 'empty expectation: the branch must not exist yet');
  assert.ok(continued.prompt.includes('git ls-remote https://github.com/acme/project.git'));
  assert.doesNotMatch(continued.prompt, /\borigin\b/, 'never relies on the guest-controlled remote configuration');
  assert.ok(continued.prompt.includes(marker) && continued.prompt.includes('--draft') && continued.prompt.includes('/skills/pr/SKILL.md'));
  assert.doesNotMatch(continued.prompt, /gh pr merge|--admin|gh pr ready|--force(?!-with-lease)/);
  const pushed = publicationPrompt({ ...input, expectedRemote: { state: 'present', sha: head } });
  assert.ok(pushed.kind === 'prompt' && pushed.prompt.includes(`already holds the verified commit ${head}`) && !pushed.prompt.includes('git -C /workspace/checkout push'));
  const updated = publicationPrompt({ ...input, expectedRemote: { state: 'present', sha: 'a'.repeat(40) }, pullRequest: 4 });
  assert.ok(updated.kind === 'prompt' && updated.prompt.includes(`--force-with-lease=refs/heads/${branch}:${'a'.repeat(40)}`) && updated.prompt.includes('Do NOT create a pull request: #4')
    && !updated.prompt.includes('gh pr create'));
});

test('AC4/AC6: the next publication step follows the Work: evaluate a new verified basis, discover after cessation, nothing while active or settled', () => {
  const work = (execution: ExecutionView | null, publication: Partial<PublicationView> | null = null, previous: ExecutionView[] = []) =>
    ({ result: 'open' as const, execution, previousExecutions: previous, publication: publication as PublicationView | null });
  assert.deepEqual(publicationStep(work(execution())), { kind: 'evaluate', basisExecutionId: 'e1' });
  assert.deepEqual(publicationStep(work(execution(), { state: 'not-publishable', basisExecutionId: 'e1' })), { kind: 'none' });
  assert.deepEqual(publicationStep(work(execution(), { state: 'awaiting-discovery', basisExecutionId: 'e1' })), { kind: 'discover', trigger: 'verified', attempted: false });
  assert.deepEqual(publicationStep(work(execution({ cessation: 'unconfirmed' }))), { kind: 'none' }, 'never before cessation');
  const active = { ...execution(), state: 'started' } as ExecutionView;
  assert.deepEqual(publicationStep(work(active)), { kind: 'none' });
  const publication = execution({ executionId: 'e2', outcome: 'failure', publication: { basisExecutionId: 'e1', head, branch, base: 'main', marker, expectedRemote: { state: 'absent' } } });
  assert.deepEqual(publicationStep(work(publication, { state: 'awaiting-discovery', basisExecutionId: 'e1', verified: { head } as PublicationView['verified'],
    attempts: [{ executionId: 'e2', head, at: 'x' }] }, [execution()])),
    { kind: 'discover', trigger: 'after-publication', attempted: true }, 'a lost result is discovered before anything is repeated');
  assert.deepEqual(publicationStep(work(execution(), { state: 'published', basisExecutionId: 'e1' })), { kind: 'none' });
  assert.deepEqual(publicationStep(work(execution({ executionId: 'e4' }), { state: 'published', basisExecutionId: 'e1' })), { kind: 'evaluate', basisExecutionId: 'e4' },
    'review MED 6: a later verified basis after publication may update the own PR');
  assert.deepEqual(publicationStep(work(execution(), { state: 'blocked', basisExecutionId: 'e1' })), { kind: 'none' });
  assert.deepEqual(publicationStep(work(execution({ executionId: 'e3' }), { state: 'requested', basisExecutionId: 'e1' })), { kind: 'evaluate', basisExecutionId: 'e3' },
    'a newer verified basis (e.g. after a scope update) is evaluated again');
});

test('real-run recovery: own branch created in the attempt window at EXACTLY the verified head, no PR -> one PR-only continuation (no push)', () => {
  const own = `refs/heads/${branch}`;
  const window = { ...refs, [own]: head };
  const decide = (input: Partial<Parameters<typeof decideDiscovery>[0]>) => decideDiscovery({ expect, attempted: true, refsBefore: refs, prOnlyRecovery: true,
    observation: observed([], { state: 'present', sha: head }, { refs: window }), ...input });
  const recovered = decide({});
  assert.equal(recovered.outcome, 'absent');
  assert.ok(recovered.outcome === 'absent' && recovered.recovery === 'create-pull-request-only' && recovered.update === null &&
    JSON.stringify(recovered.expectedRemote) === JSON.stringify({ state: 'present', sha: head }), 'the remote already holds the commit: no push, only the PR');
  // Never adopted otherwise: a second PR-only attempt, a branch that existed before the window, another head, or another ref changed.
  assert.deepEqual(decide({ prOnlyRecovery: false }).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_AT_VERIFIED_HEAD']);
  assert.deepEqual(decide({ refsBefore: { ...refs, [own]: head } }).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_AT_VERIFIED_HEAD']);
  assert.deepEqual(decide({ observation: observed([], { state: 'present', sha: 'e'.repeat(40) }, { refs: { ...refs, [own]: 'e'.repeat(40) } }) }).reasons,
    ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_UNKNOWN_CHANGE']);
  assert.deepEqual(decide({ observation: observed([], { state: 'present', sha: head }, { refs: { ...window, 'refs/tags/x': head } }) }).reasons, ['UNEXPECTED_REF_CHANGE:refs/tags/x']);
  assert.deepEqual(decide({ refsBefore: null }).reasons, ['PUBLICATION_OUTCOME_UNCONFIRMED', 'REMOTE_BRANCH_AT_VERIFIED_HEAD'], 'without the window snapshot nothing is attributable');
});

test('ticket 18: after a publication attempt, the reasons that show a guest effect outside the publish-only scope', async () => {
  const { guestEffectOutOfScope } = await import('../../src/control/rules/publication.js');
  assert.deepEqual(guestEffectOutOfScope(['UNEXPECTED_REF_CHANGE:refs/heads/main', 'DESCRIPTION_NONCONFORMANT:x', 'PULL_REQUEST_NOT_DRAFT', 'OWN_PULL_REQUEST_MERGED',
    'OWN_PULL_REQUEST_CLOSED', 'REMOTE_BRANCH_CHANGED', 'PUBLISHED_HEAD_NOT_VERIFIED', 'MULTIPLE_OWN_PULL_REQUESTS:4,5', 'PUBLICATION_OUTCOME_UNCONFIRMED']),
  ['UNEXPECTED_REF_CHANGE:refs/heads/main', 'PULL_REQUEST_NOT_DRAFT', 'OWN_PULL_REQUEST_MERGED', 'OWN_PULL_REQUEST_CLOSED', 'REMOTE_BRANCH_CHANGED',
    'PUBLISHED_HEAD_NOT_VERIFIED', 'MULTIPLE_OWN_PULL_REQUESTS:4,5']);
  assert.deepEqual(guestEffectOutOfScope(['DESCRIPTION_NONCONFORMANT:x', 'PUBLICATION_OUTCOME_UNCONFIRMED']), [], 'a missing or badly described publication is not an out-of-scope effect');
});

test('v2 ticket 06: a LIVE basis (started, not ended) is publishable under the same requirements, and only when asked as live', () => {
  const reasons = (decision: ReturnType<typeof publishableContent>) => decision.ok ? [] : decision.reasons;
  const live = { ...execution(), state: 'started', end: null } as unknown as ExecutionView;
  assert.deepEqual(reasons(publishableContent(live)), ['EXECUTION_NOT_COMPLETED', 'CESSATION_NOT_CONFIRMED'], 'the MVP rule still needs the end and the cessation');
  const ok = publishableContent(live, { live: true });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.verified.executionId, ok.verified.head], ['e1', head]);
  assert.deepEqual(reasons(publishableContent(execution(), { live: true })), ['EXECUTION_NOT_LIVE'], 'an ended Execution is never a live basis');
  const unverified = { ...execution({ verification: { status: 'not-verified', reasons: ['GATE_FAILED:t1'], contentSha256: 'f'.repeat(64) } }), state: 'started', end: null } as unknown as ExecutionView;
  assert.deepEqual(reasons(publishableContent(unverified, { live: true })), ['REVIEW_NOT_VERIFIED', 'VERIFICATION:GATE_FAILED:t1']);
  const dirty = { ...execution({ content: { sha256: 'f'.repeat(64), clean: false, headMatches: true } }), state: 'started', end: null } as unknown as ExecutionView;
  assert.deepEqual(reasons(publishableContent(dirty, { live: true })), ['VERIFIED_CONTENT_NOT_COMMITTED']);
});
