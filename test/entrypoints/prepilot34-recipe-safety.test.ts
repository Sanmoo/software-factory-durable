import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { QuestionView, WorkView } from '../../src/control/index.js';
import { serviceDefinition } from '../../src/entrypoints/setup.js';
import { workerRuntimeDirectory } from '../../src/platform/host/index.js';
import { installationRoot, mountsBelow, observationWriter, parseShow, redact, secretShapes, serviceUnit, type ReleaseIdentity } from './prepilot34-qualification.js';
import * as rel from './rrel34-qualification.js';
import * as cand from './rcand34-qualification.js';
import { usageVerdict } from './rinspect34-qualification.js';

// Recipe safety on controlled data and temporary fixtures only (never the real roots, never a real gh, systemd unit, VM or model).

test('shared: the unit name is the product\'s own; the root fits the guest socket budget; mounts below a root are found; secrets redacted', () => {
  assert.equal(serviceUnit(installationRoot), serviceDefinition(installationRoot).unit);
  // The longest guest runtime socket (src/sandbox/start.ts: <runtime>/s/<uuid>.sock) must fit sun_path (107 bytes + NUL).
  const longest = (root: string) => Buffer.byteLength(join(workerRuntimeDirectory(root, 'boot-00000000-0000-4000-8000-000000000000'), 's', '00000000-0000-4000-8000-000000000000.sock'));
  assert.ok(longest(installationRoot) <= 107, String(longest(installationRoot)));
  assert.ok(longest(`${installationRoot}x`) > 107, 'one byte more no longer fits');
  const mountinfo = ['22 1 0:21 / / rw - ext4 /dev/x rw', `90 22 0:50 / ${installationRoot}/environments/e1/mnt rw - fuse x rw`,
    '91 22 0:51 / /home/sanmoo/software-factory-test/pr20 rw - tmpfs t rw', '92 22 0:52 / /home/sanmoo/software-factory-test/pr2\\040x rw - tmpfs t rw'].join('\n');
  assert.deepEqual(mountsBelow(mountinfo, installationRoot), [`${installationRoot}/environments/e1/mnt`]);
  assert.deepEqual(parseShow('ActiveState=failed\nExecMainStatus=2\n'), { ActiveState: 'failed', ExecMainStatus: '2' });
  assert.equal(redact(`x ghs_${'a'.repeat(30)} y`).found, 1);
  assert.equal(secretShapes(Buffer.from(`-----BEGIN RSA PRIVATE KEY-----`)), 1);
});

test('shared: observation files are one-shot (O_EXCL, 0600), stamped, and redacted before anything reaches the disk', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prepilot34-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = observationWriter(directory, () => ({ factory: { commit: 'c'.repeat(40) } }));
  await save('run-result', { status: 'success', note: `token ghs_${'b'.repeat(36)}` });
  const text = await readFile(join(directory, 'run-result.json'), 'utf8');
  const saved = JSON.parse(text);
  assert.equal(saved.factory.commit, 'c'.repeat(40));
  assert.equal(saved.redactedSecretShapes, 1);
  assert.ok(!text.includes('ghs_b'));
  assert.equal((await stat(join(directory, 'run-result.json'))).mode & 0o777, 0o600);
  await assert.rejects(save('run-result', {}), /EEXIST/, 'never overwritten: a consumed phase never reruns');
  await assert.rejects(save('../escape', {}), /OBSERVATION_NAME/);
});

test('R-REL phase guard: order, one shot, and remove-root only after R-CAND kept its evidence', () => {
  const results = (...names: string[]) => new Set(names);
  assert.equal(rel.phaseGuard('build', results(), results()), null);
  assert.equal(rel.phaseGuard('build', results(), results('build')), 'PHASE_ALREADY_RAN');
  assert.equal(rel.phaseGuard('verify', results(), results('build')), 'BUILD_RESULT_REQUIRED', 'a held build is never followed');
  assert.equal(rel.phaseGuard('service', results('doctor'), results('build', 'verify', 'install', 'setup', 'doctor')), null);
  assert.equal(rel.phaseGuard('service', results('doctor'), results('service')), 'PHASE_ALREADY_RAN', 'no implicit retry');
  assert.equal(rel.phaseGuard('uninstall-service', results('doctor'), results()), 'SERVICE_RESULT_REQUIRED');
  assert.equal(rel.phaseGuard('remove-root', results('uninstall-service'), results()), 'CANDIDATE_EVIDENCE_NOT_KEPT');
  assert.equal(rel.phaseGuard('remove-root', results('uninstall-service', 'cand-finished'), results()), null);
});

const ok = { status: 'success' };
test('R-CAND phase guard: pinned issue; each phase once after the previous success with the expected outcome; inspect after any phase', () => {
  const none = new Set<string>();
  assert.equal(cand.phaseGuard('preflight', {}, none, false), 'TICKET_NOT_PINNED');
  assert.equal(cand.phaseGuard('preflight', {}, none, true), null);
  assert.equal(cand.phaseGuard('preflight', {}, new Set(['preflight']), true), 'PHASE_ALREADY_RAN');
  assert.equal(cand.phaseGuard('run', { preflight: { status: 'held' } }, none, true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(cand.phaseGuard('answer', { preflight: ok, run: { ...ok, outcome: 'published' } }, none, true), 'QUESTION_PUBLISHED_RUN_REQUIRED');
  assert.equal(cand.phaseGuard('answer', { preflight: ok, run: { ...ok, outcome: 'question-published' } }, none, true), null);
  assert.equal(cand.phaseGuard('review', { run: { ...ok, outcome: 'published' } }, none, true), null, 'a run that never asked goes straight to the review');
  assert.equal(cand.phaseGuard('repair', { review: { ...ok, outcome: 'question-published' } }, none, true), 'REVIEW_TREATED_REQUIRED');
  assert.equal(cand.phaseGuard('ready', { repair: { ...ok, outcome: 'asked-then-closed' } }, none, true), null);
  assert.equal(cand.phaseGuard('deliver', { ready: { status: 'held', outcome: 'merge-blocked' } }, none, true), 'READY_REQUIRED', 'no merge over a blocking rule');
  assert.equal(cand.phaseGuard('inspect', {}, none, true), 'PREFLIGHT_REQUIRED');
  assert.equal(cand.phaseGuard('inspect', { preflight: { status: 'held' } }, none, true), null, 'inspect works after a held phase');
  assert.equal(cand.phaseGuard('verdict', { preflight: ok }, none, true), 'INSPECT_REQUIRED');
});

test('R-CAND human commands: the operator\'s own gh; answers on the issue, review/comment/approve/merge on the own PR; never admin, squash, branch deletion or force', () => {
  assert.deepEqual(cand.humanCommands(1, { issue: 50, questionId: 'q-1' }),
    [`gh issue comment 50 --repo Sanmoo/java-springboot-event-sourcing --body '/factory answer q-1 ${cand.humanSteps[1].body}'`]);
  assert.equal(cand.humanCommands(2, { issue: 50, pullRequest: 51 })[0], `gh pr review 51 --repo Sanmoo/java-springboot-event-sourcing --request-changes --body 'In ${cand.candidateFile}, end the first paragraph (under \`# Factory candidate\`) with exactly this sentence: \`${cand.reviewSentence}\` Change nothing else.'`);
  assert.equal(cand.humanCommands(3, { issue: 50, pullRequest: 51 })[0], `gh pr comment 51 --repo Sanmoo/java-springboot-event-sourcing --body '/factory repair Delete ${cand.candidateFile} and close this pull request.'`);
  assert.deepEqual(cand.humanCommands(5, { issue: 50, pullRequest: 51 }), [`gh pr review 51 --repo Sanmoo/java-springboot-event-sourcing --approve --body 'Approved after the candidate journey.'`,
    'gh pr merge 51 --repo Sanmoo/java-springboot-event-sourcing --merge']);
  for (const step of [1, 2, 3, 4, 5, 6, 7] as const) {
    for (const line of cand.humanCommands(step, { issue: 50, pullRequest: 51, questionId: 'q', originalQuestionId: 'q0', reviewRef: 'review-1' })) assert.ok(!/--admin|--squash|--rebase|--delete-branch|--force|dismiss/.test(line), line);
  }
  assert.throws(() => cand.humanCommands(4, { issue: 50 }), /QUESTION_ID_REQUIRED/);
  assert.throws(() => cand.humanCommands(2, { issue: 50 }), /PULL_REQUEST_REQUIRED/);
  // The Ticket: documentation only; the instruction trap and the gate whose waiver needs approval are in it; the runnable gate is POSIX.
  assert.ok(!cand.ticketBody.includes('AGENTS.md') && cand.ticketBody.includes(cand.contentGate) && cand.ticketBody.includes(cand.docsCheckGate));
  assert.match(cand.contentGate, /^cd \/workspace\/checkout && test -f .+ && grep -q /);
});

test('R-CAND reads: GET paths of the test repository only (gh api without method or fields)', () => {
  for (const path of ['repos/Sanmoo/java-springboot-event-sourcing', 'repos/Sanmoo/java-springboot-event-sourcing/issues/50', 'repos/Sanmoo/java-springboot-event-sourcing/pulls/51/files',
    'repos/Sanmoo/java-springboot-event-sourcing/issues?labels=ready-for-agent&state=open&per_page=100', 'repos/Sanmoo/java-springboot-event-sourcing/pulls?state=all&per_page=100',
    'repos/Sanmoo/java-springboot-event-sourcing/git/matching-refs/heads/factory/50-', 'repos/Sanmoo/java-springboot-event-sourcing/rules/branches/main',
    `repos/Sanmoo/java-springboot-event-sourcing/contents/AGENTS.md?ref=${'a'.repeat(40)}`]) assert.ok(cand.readablePath(path), path);
  for (const path of ['repos/Sanmoo/other/issues/1', 'repos/Sanmoo/java-springboot-event-sourcing/pulls/51/merge', 'repos/Sanmoo/java-springboot-event-sourcing/../x',
    '-X POST repos/Sanmoo/java-springboot-event-sourcing/issues/50/comments', 'repos/Sanmoo/java-springboot-event-sourcing/issues/50/labels']) assert.equal(cand.readablePath(path), false, path);
});

const execution = (overrides: Record<string, unknown> = {}) => ({ executionId: 'e1', mode: 'initial', state: 'ended', slot: { held: false }, held: null, dispatch: { boot: 'boot-x' },
  end: { outcome: 'completed', cessation: 'confirmed' }, ...overrides });
const work = (overrides: Record<string, unknown> = {}) => ({ work_id: 'w1', result: 'open', impediments: [], previousExecutions: [], execution: execution(), publication: null,
  pullRequest: null, correction: null, corrections: [], feedback: { requests: [] }, budget: { corrections: { consumed: 0 } }, ...overrides }) as unknown as WorkView;
const question = (questionId: string, state: 'open' | 'answered', answer: unknown = null) => ({ questionId, state, publication: { state: 'published' }, answer, executionId: 'e1' }) as unknown as QuestionView;
const snap = (w: WorkView | null, questions: QuestionView[] = [], works = 1) => ({ work: w, questions, works, cycles: 0 });
const published = { publication: { state: 'published', pullRequest: { number: 51, headSha: 'h1' } }, pullRequest: { number: 51, url: 'u' } };

test('R-CAND settle: run stops at the published question after cessation; answer at the linked PR after quiet cycles; explained stops end any phase', () => {
  assert.deepEqual(cand.settle('run', snap(work())), { settled: false });
  assert.deepEqual(cand.settle('run', snap(work({ execution: execution({ end: { outcome: 'question', cessation: 'confirmed' } }) }), [question('q1', 'open')])),
    { settled: true, outcome: 'question-published', success: true });
  assert.deepEqual(cand.settle('run', snap(work({ execution: execution({ slot: { held: true }, end: { outcome: 'question', cessation: 'confirmed' } }) }), [question('q1', 'open')])),
    { settled: false }, 'Slot still held');
  assert.deepEqual(cand.settle('run', snap(work({ execution: execution({ state: 'held', held: { code: 'X' } }) }))), { settled: true, outcome: 'execution-held:X', success: false });
  assert.deepEqual(cand.settle('answer', snap(work(published)), { q1: 'q1', quiet: false }), { settled: false }, 'quiet cycles first');
  assert.deepEqual(cand.settle('answer', snap(work(published)), { q1: 'q1', quiet: true }), { settled: true, outcome: 'published', success: true });
  assert.deepEqual(cand.settle('answer', snap(work(published), [question('q1', 'answered'), question('q9', 'open')]), { q1: 'q1', quiet: true }),
    { settled: true, outcome: 'question-unanswered', success: false }, 'a second question is never answered by the recipe');
  assert.deepEqual(cand.settle('answer', snap(work({ publication: { state: 'blocked' } }))), { settled: true, outcome: 'publication-blocked', success: false });
});

test('R-CAND settle: review treated once; repair asks (then closes) or blocks, never silently; ready only from GitHub ready at the linked head; deliver after cleanup', () => {
  const human = (state: string) => ({ feedback: { requests: [{ code: 'HUMAN_CHANGES_REQUESTED', state, feedback: { author: { id: 7 } } }] } });
  assert.deepEqual(cand.settle('review', snap(work({ ...published, ...human('treated'), corrections: [{ outcome: 'published', charged: true }] })), { quiet: true, correctionsBefore: 0 }),
    { settled: true, outcome: 'treated', success: true });
  assert.deepEqual(cand.settle('review', snap(work({ ...published, ...human('in-correction') })), { quiet: true }), { settled: false });
  const explicit = (state: string) => ({ feedback: { requests: [{ code: 'EXPLICIT_REPAIR', state, feedback: { origin: 'github-comment', author: { id: 7 } } }] } });
  assert.deepEqual(cand.settle('repair', snap(work({ ...published, ...explicit('treated') })), { q1: 'q1', q2: 'q2', q2Answered: true, quiet: true }),
    { settled: true, outcome: 'asked-then-closed', success: true });
  assert.deepEqual(cand.settle('repair', snap(work({ ...published, ...explicit('treated') })), { q1: 'q1', quiet: true }),
    { settled: true, outcome: 'closed-without-question', success: true }, 'recorded; the verdict does NOT count it for V-10.d');
  assert.deepEqual(cand.settle('repair', snap(work({ ...published, ...explicit('in-correction'), impediments: [{ code: 'CORRECTION_LIMIT_REACHED' }] }))),
    { settled: true, outcome: 'blocked-explained', success: true });
  assert.deepEqual(cand.settle('ready', snap(work(published)), { githubReady: false }), { settled: false });
  assert.deepEqual(cand.settle('ready', snap(work(published)), { githubReady: true }), { settled: true, outcome: 'ready', success: true });
  assert.deepEqual(cand.settle('ready', snap(work({ ...published, readiness: { latest: { reasons: [{ area: 'merge', certainty: 'confirmed', code: 'MERGE_BLOCKED_UPDATE_RESTRICTED' }] } } }))),
    { settled: true, outcome: 'merge-blocked', success: false });
  assert.deepEqual(cand.settle('deliver', snap(work({ result: 'delivered', cleanup: { state: 'pending' } }))), { settled: false });
  assert.deepEqual(cand.settle('deliver', snap(work({ result: 'delivered', cleanup: { state: 'complete' } }))), { settled: true, outcome: 'delivered', success: true });
});

test('R-CAND bounds, answers and the deliver precondition', () => {
  assert.equal(cand.boundsViolation(snap(work(), [], 2)), 'BOUND_WORKS');
  assert.equal(cand.boundsViolation(snap(work({ previousExecutions: Array.from({ length: 10 }, () => execution()) }))), 'BOUND_EXECUTIONS');
  assert.equal(cand.boundsViolation(snap(work(), ['a', 'b', 'c', 'd', 'e'].map(id => question(id, 'open')))), 'BOUND_QUESTIONS');
  assert.equal(cand.boundsViolation(snap(work())), null);
  const real = question('q1', 'answered', { author: { kind: 'github', id: 7 }, origin: { kind: 'github-comment' } });
  assert.equal(cand.answeredByOperator(snap(work(), [real]), 'q1', 7), 'answered');
  assert.equal(cand.answeredByOperator(snap(work(), [question('q1', 'answered', { author: { kind: 'local-administrator' }, origin: { kind: 'local-cli' } })]), 'q1', 7), 'not-the-real-comment');
  assert.equal(cand.answeredByOperator(snap(work(), [question('q1', 'open')]), 'q1', 7), 'waiting');
  const pull = { merged: true, merged_by: { login: 'Sanmoo', id: 7 }, head: { sha: 'h1' }, base: { ref: 'main' } };
  assert.equal(cand.mergedByOperator(pull, 'h1', 7), null);
  assert.equal(cand.mergedByOperator({ ...pull, merged: false }, 'h1', 7), 'NOT_MERGED');
  assert.equal(cand.mergedByOperator({ ...pull, merged_by: { login: 'other', id: 8 } }, 'h1', 7), 'NOT_MERGED_BY_OPERATOR');
  assert.equal(cand.mergedByOperator(pull, 'h2', 7), 'MERGED_HEAD_IS_NOT_THE_LINKED_HEAD');
});

const identity: ReleaseIdentity = { release: 'mvp-34.2', commit: 'c'.repeat(40), commitTime: 't', branch: 'b', dirty: false, archive: 'a.tar', archiveSha256: 'a'.repeat(64),
  manifestSha256: 'm'.repeat(64), guestAssets: { manifestSha256: 'g' }, lockfileSha256: 'l', node: '24.21.0', root: installationRoot, unit: 'u', builtAt: 't',
  markers: { 'ticket-23-feedback': true, 'ticket-24-single-pass-dispatch': true, 'ticket-29-inspection': true, 'ticket-34-candidate': true, 'd-07-sqlite-scrub': true, 'owner-user-bus': true, 'continuation-findings': true, 'skills-v7-satisfied-findings': true, 'ticket-43-reconciliation-review': true } };
function savedJourney() {
  const factory = { release: identity.release, commit: identity.commit, manifestSha256: identity.manifestSha256, archiveSha256: identity.archiveSha256, root: identity.root, verifiedBy: 'x' };
  const exe = `${installationRoot}/releases/mvp-34.2/node/bin/node`;
  const gate = (id: string, declared: string, outcome: string, authorization: unknown = null) => ({ id, declared, outcome, authorization });
  const round = { versions: { instructions: { sha256: 'i'.repeat(64) } }, declarations: { gates: [gate('content', 'run', 'passed'), gate('docs-check', 'waived', 'waived', { kind: 'question', questionId: 'q1' })] } };
  const finalWork = work({ result: 'delivered', cleanup: { state: 'complete' }, ...published,
    feedback: { requests: [{ code: 'HUMAN_CHANGES_REQUESTED', state: 'treated', feedback: {} }, { code: 'EXPLICIT_REPAIR', state: 'treated', feedback: { origin: 'github-comment' } }] },
    corrections: [{ outcome: 'published', charged: true }], previousExecutions: [execution({ review: { rounds: [round] } })],
    execution: execution({ executionId: 'e2', review: { rounds: [round], verification: { gates: [{ id: 'content', outcome: 'passed' }, { id: 'docs-check', outcome: 'waived' }] } } }) });
  const phase = (mode: string | null, extra: Record<string, unknown> = {}) => ({ status: 'success', factory, ...(mode ? { controller: { mode, exe, sandboxesSeen: ['factory-sandbox-boot-1.service'] } } : {}), ...extra });
  return { identity, preflight: phase(null), run: phase('foreground', { outcome: 'question-published', q1: 'q1' }), answer: phase('service', { outcome: 'published', prFiles: ['AGENTS.md', cand.candidateFile] }),
    review: phase('service', { outcome: 'treated' }), repair: phase('service', { outcome: 'asked-then-closed', q2: 'q2' }), ready: phase('service', { outcome: 'ready' }),
    deliver: phase('service', { outcome: 'delivered' }),
    inspect: phase('service', { outcome: 'inspected', work: finalWork, questions: [question('q1', 'answered'), question('q2', 'answered')], prFiles: [cand.candidateFile],
      agentsAtBase: 'sha-base', agentsAtMerge: 'sha-base', reviewSentenceAtMerge: true, cli: [{ args: ['show'], code: 0 }, { args: ['usage'], code: 0 }], secrets: { storage: 0, observations: 0 },
      usage: { byRole: { builder: { measured: 2, tokens: { total: 10 } }, standards: { measured: 1, tokens: { total: 5 } }, spec: { measured: 1, tokens: { total: 4 } } } } }) };
}

test('R-CAND verdict: every obligation proven only by what the saved results show; a missing stamp, a worktree executable or a silent repair disproves', () => {
  const good = cand.verdict(savedJourney() as never);
  assert.ok(good.passed, JSON.stringify(good.checks.filter(item => !item.passed)));
  assert.deepEqual(good.obligations, { 'V-06.h': 'proven', 'V-08.g': 'proven', 'V-10.d': 'proven', 'V-16.d': 'proven' });
  const unstamped = savedJourney(); (unstamped.review as Record<string, unknown>).factory = undefined;
  assert.equal(cand.verdict(unstamped as never).obligations['V-06.h'], 'not-proven', 'a result without the Factory commit proves nothing');
  const worktree = savedJourney(); (worktree.answer as { controller: { exe: string } }).controller.exe = '/usr/bin/node';
  assert.equal(cand.verdict(worktree as never).obligations['V-08.g'], 'not-proven', 'not run from the installed release');
  const silent = savedJourney(); (silent.repair as unknown as { outcome: string }).outcome = 'closed-without-question';
  assert.equal(cand.verdict(silent as never).obligations['V-10.d'], 'not-proven');
  const agents = savedJourney(); (agents.inspect as unknown as { prFiles: string[] }).prFiles = ['AGENTS.md', cand.candidateFile];
  assert.equal(cand.verdict(agents as never).obligations['V-06.h'], 'not-proven', 'only the candidate file may reach the base');
  const noSentence = savedJourney(); (noSentence.inspect as unknown as { reviewSentenceAtMerge: boolean }).reviewSentenceAtMerge = false;
  assert.equal(cand.verdict(noSentence as never).obligations['V-06.h'], 'not-proven', 'the human review was not applied');
  const service = savedJourney(); for (const name of ['answer', 'review', 'repair', 'ready', 'deliver', 'inspect'] as const) (service[name] as { controller: { sandboxesSeen: string[] } }).controller.sandboxesSeen = [];
  assert.equal(cand.verdict(service as never).obligations['V-16.d'], 'not-proven', 'service mode never ran an environment');
});

test('R-INSPECT verdict: three roles measured, a continued session counted once, unavailable never a zero', () => {
  const activity = (role: string, session: string | null, entries: number, carried: number, total: number | null, measurement = 'complete') =>
    ({ executionId: 'e', role, measurement, code: measurement === 'complete' ? null : 'SESSION_REMOVED_BY_CLEANUP', carriedEntries: carried, entries, session: { sessionId: session },
      tokens: total === null ? null : { total }, cost: total === null ? null : { total: 0.1 } });
  const role = (measured: number, total: number | null, unavailable = 0) => ({ measured, unavailable, measurement: unavailable ? 'partial' : 'complete', tokens: total === null ? null : { total } });
  const works = [{ work_id: 'w', activities: [activity('builder', 's1', 4, 0, 40), activity('builder', 's1', 2, 4, 20), activity('standards', 's2', 3, 0, 30), activity('spec', 's3', 1, 0, 10),
    activity('spec', null, 0, 0, null, 'unavailable')],
  byRole: { builder: role(2, 60), standards: role(1, 30), spec: role(1, 10, 1) }, total: { measurement: 'partial', measured: 4, unavailable: 1, tokens: { total: 100 } } }];
  const good = usageVerdict(works);
  assert.ok(good.proven, JSON.stringify(good.checks));
  const doubled = structuredClone(works); doubled[0]!.activities[1]!.carriedEntries = 0; doubled[0]!.activities[1]!.entries = 6;
  assert.equal(usageVerdict(doubled).checks.find(item => item.id === 'resumed-session-counted-once')?.passed, false, 'entries summed twice');
  const zero = structuredClone(works); zero[0]!.activities[4]!.tokens = { total: 0 };
  assert.equal(usageVerdict(zero).checks.find(item => item.id === 'partial-or-absent-never-zero')?.passed, false);
  const complete = structuredClone(works); complete[0]!.total.measurement = 'complete';
  assert.equal(usageVerdict(complete).proven, false, 'an aggregate with an unavailable part is never complete');
  const allMeasured = structuredClone(works); allMeasured[0]!.activities.pop(); allMeasured[0]!.total.unavailable = 0; allMeasured[0]!.byRole.spec!.unavailable = 0;
  assert.deepEqual([usageVerdict(allMeasured).exercised.partialOrAbsent, usageVerdict(allMeasured).proven], [false, false], 'not exercised is not proven');
  assert.equal(usageVerdict([{ ...works[0]!, byRole: { ...works[0]!.byRole, standards: role(0, null) } }]).checks[0]!.passed, false);
});

test('R-CAND service environment: a credential or Node override in the user manager holds preflight (names only)', () => {
  assert.deepEqual(cand.unsafeServiceEnvironment(['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'XDG_RUNTIME_DIR']),
    ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS']);
  assert.deepEqual(cand.unsafeServiceEnvironment(['PATH', 'HOME', 'DBUS_SESSION_BUS_ADDRESS']), []);
});

test('R-CAND v7: the human review edits only the candidate file inside the Ticket scope; ended predecessor cycles hold no capacity', () => {
  const review = cand.humanCommands(2, { issue: 50, pullRequest: 51 })[0]!;
  assert.ok(!/Review notes|AGENTS\.md/.test(review), 'v2 asked outside the Ticket scope; v3-v6 asked for the AGENTS.md restore the Spec reviewers misjudged');
  assert.ok(review.includes(cand.candidateFile) && review.includes(cand.reviewSentence) && review.includes('Change nothing else.'));
  const of = (...results: string[]) => results.map(result => ({ result })) as never;
  assert.equal(cand.countedWorks(of('cancelled', 'open')), 1, 'the cancelled v2 Work on #49 does not count');
  assert.equal(cand.countedWorks(of('delivered', 'cancelled')), 0);
  assert.equal(cand.countedWorks(of('open', 'closed-unmerged')), 2, 'a closed-unmerged cycle can still continue');
});

test('R-UPG: phases in order once; apply only after a compatible check with nothing blocked (never a migration)', async () => {
  const upg = await import('./rupg34-qualification.js');
  const none = new Set<string>();
  assert.equal(upg.phaseGuard('build', none, none), null);
  assert.equal(upg.phaseGuard('build', none, new Set(['build'])), 'PHASE_ALREADY_RAN');
  assert.equal(upg.phaseGuard('extract', new Set(['build']), new Set(['build'])), 'VERIFY_RESULT_REQUIRED');
  assert.equal(upg.phaseGuard('upgrade', new Set(['build', 'verify', 'extract']), new Set(['build', 'verify', 'extract'])), null);
  assert.equal(upg.phaseGuard('unpause', new Set(['build', 'verify', 'extract']), none), 'UPGRADE_RESULT_REQUIRED');
  assert.equal(upg.applicable({ code: 'UPGRADE_COMPATIBLE', checks: [{ id: 'upgrade:pause', status: 'ok' }] }), null);
  assert.equal(upg.applicable({ code: 'UPGRADE_COMPATIBLE', checks: [{ id: 'upgrade:pause', status: 'blocked' }] }), 'CHECK_BLOCKED');
  assert.equal(upg.applicable({ code: 'UPGRADE_MIGRATION_REQUIRED' }), 'MIGRATION_REQUIRED');
  assert.equal(upg.applicable({ code: 'UPGRADE_INCOMPATIBLE' }), 'CHECK_UPGRADE_INCOMPATIBLE');
  assert.equal(upg.applicable(null), 'CHECK_UNPARSABLE');
});

test('R-CAND preflight configuration: the setup template is replaced, the recipe\'s own text is kept, any other edit refuses', () => {
  const expected = cand.configurationText({ schemaVersion: 1, operators: [{ login: 'Sanmoo', id: 1 }] });
  assert.equal(expected, '{\n "schemaVersion": 1,\n "operators": [\n  {\n   "login": "Sanmoo",\n   "id": 1\n  }\n ]\n}\n');
  const template = '# Complete explicit operators, models and GitHub App references before operation.\noperators: []\nrepositories: []\n';
  assert.equal(cand.configurationState(template, expected), 'template');
  assert.equal(cand.configurationState(expected, expected), 'recipe', 'written by an earlier revision of this recipe (qcand34-v2)');
  assert.equal(cand.configurationState(expected.replace('"id": 1', '"id": 2'), expected), null, 'an operator edit is never overwritten');
  assert.equal(cand.configurationState(expected.trimEnd(), expected), null, 'byte-identical only');
  assert.equal(cand.configurationState('', expected), null);
});

test('R-CAND snapshot list walk: follows page.nextCursor (the own Work on page 1 behind a fitted page 0); a failed or stuck page is incomplete', async () => {
  const w = (id: string, number: number, result = 'open') => ({ work_id: id, ticket: { number }, repository: { repository: 'Sanmoo/java-springboot-event-sourcing' }, result });
  // The qcand34-v4 shape: page 0 fitted to the cancelled predecessor only, the own Work on page 1.
  const pages: Record<number, unknown> = {
    0: { kind: 'list', works: [w('4b2d22b4', 49, 'cancelled')], page: { cursor: 0, limit: 50, returned: 1, filtered: 2, total: 2, nextCursor: 1, fitted: true } },
    1: { kind: 'list', works: [w('62f37492', 59)], page: { cursor: 1, limit: 50, returned: 1, filtered: 2, total: 2, nextCursor: null, fitted: false } } };
  const asked: number[] = [];
  const listed = await cand.listAllWorks(async cursor => { asked.push(cursor); return { code: 0, json: pages[cursor] }; });
  assert.deepEqual(asked, [0, 1]);
  assert.deepEqual([listed.pages, listed.complete], [2, true]);
  assert.deepEqual(listed.works.map(item => item.work_id), ['4b2d22b4', '62f37492']);
  assert.equal(listed.works.find(item => item.ticket.number === 59)?.work_id, '62f37492', 'the own Work is found');
  assert.equal(cand.countedWorks(listed.works), 1);
  const failed = await cand.listAllWorks(async cursor => cursor === 0 ? { code: 0, json: pages[0] } : { code: 2, json: null });
  assert.deepEqual([failed.complete, failed.works.length, failed.code], [false, 1, 2]);
  const stuck = await cand.listAllWorks(async () => ({ code: 0, json: { works: [], page: { nextCursor: 0 } } }));
  assert.deepEqual([stuck.complete, stuck.pages], [false, 1], 'a non-advancing cursor never loops');
  const bounded = await cand.listAllWorks(async cursor => ({ code: 0, json: { works: [], page: { nextCursor: cursor + 1 } } }), 3);
  assert.deepEqual([bounded.complete, bounded.pages], [false, 3]);
});

test('R-CAND v6: step 1 covers every later Execution; ONE scripted re-waiver answer cites the original Question; any other Question still holds', () => {
  assert.match(cand.humanSteps[1].body, /every later Execution of this Ticket \(repairs included\)/);
  assert.deepEqual(cand.humanCommands(6, { issue: 50, questionId: 'q-r', originalQuestionId: 'q-1' }),
    ["gh issue comment 50 --repo Sanmoo/java-springboot-event-sourcing --body '/factory answer q-r Yes: the approval in Question q-1 covers every Execution of this Ticket, repairs included; waive docs-check again. The content gate stays required.'"]);
  assert.throws(() => cand.humanCommands(6, { issue: 50, questionId: 'q-r' }), /ORIGINAL_QUESTION_ID_REQUIRED/);
  assert.throws(() => cand.humanCommands(6, { issue: 50, originalQuestionId: 'q-1' }), /QUESTION_ID_REQUIRED/);
  const asking = (questionId: string, text: string) => ({ ...question(questionId, 'open'), content: { question: text, context: '', sha256: 's', reference: { workId: 'w1', id: 'r' } } }) as unknown as QuestionView;
  // The qcand34-v5 Question, verbatim in substance.
  const rewaive = asking('q-r', 'The documented `docs-check` gate is still unavailable (exit 127). The existing approval in question q1 explicitly authorizes waiver for Ticket 60 only; may I rely on that approval for this authorized repair of the same Ticket and waive `docs-check` again?');
  assert.equal(cand.rewaiverQuestion(snap(work(), [question('q1', 'answered'), rewaive]), ['q1'])?.questionId, 'q-r');
  assert.equal(cand.rewaiverQuestion(snap(work(), [asking('q-x', 'Should I delete docs/FACTORY_CANDIDATE.md and close the pull request?')]), ['q1']), null, 'any other Question is not tolerated');
  assert.equal(cand.rewaiverQuestion(snap(work(), [rewaive]), ['q1', 'q-r']), null, 'once known it is never classified again');
  // review: the tolerated Question does not end the phase; an untolerated one still does.
  const quietWork = work({ ...published, execution: execution({ end: { outcome: 'question', cessation: 'confirmed' } }) });
  assert.deepEqual(cand.settle('review', snap(quietWork, [question('q1', 'answered'), rewaive]), { q1: 'q1', tolerated: ['q-r'], quiet: false }), { settled: false });
  assert.deepEqual(cand.settle('review', snap(quietWork, [question('q1', 'answered'), rewaive]), { q1: 'q1', quiet: false }),
    { settled: true, outcome: 'question-published', success: false });
  const other = asking('q-x', 'Something else?');
  assert.deepEqual(cand.settle('review', snap(quietWork, [question('q1', 'answered'), rewaive, other]), { q1: 'q1', tolerated: ['q-r'], quiet: false }),
    { settled: true, outcome: 'question-published', success: false }, 'a second unscripted Question still holds');
});

test('R-CAND v6 verdict: a docs-check waiver citing the answered tolerated re-waiver Question proves V-08.g; an unanswered or unknown one does not', () => {
  const withRewaiver = (answered: boolean, cited: string) => {
    const saved = savedJourney();
    const rounds = (saved.inspect as unknown as { work: { execution: { review: { rounds: { declarations: { gates: { id: string; authorization: unknown }[] } }[] } } } }).work.execution.review.rounds;
    const repairRound = structuredClone(rounds[0]!);
    repairRound.declarations.gates.find(gate => gate.id === 'docs-check')!.authorization = { kind: 'question', questionId: cited };
    rounds.push(repairRound);
    (saved.repair as Record<string, unknown>).rewaiver = { questionId: 'q-r', original: 'q1', phase: 'repair', answered };
    return saved;
  };
  assert.equal(cand.verdict(withRewaiver(true, 'q-r') as never).obligations['V-08.g'], 'proven');
  assert.equal(cand.verdict(withRewaiver(false, 'q-r') as never).obligations['V-08.g'], 'not-proven', 'the tolerated Question was never answered');
  assert.equal(cand.verdict(withRewaiver(true, 'q-other') as never).obligations['V-08.g'], 'not-proven', 'an unknown Question authorizes nothing');
  assert.equal(cand.verdict(withRewaiver(true, 'q1') as never).obligations['V-08.g'], 'proven', 'the original approval still counts');
});

test('R-CAND snapshot questions: read by id when the fitted show view omits them (qcand34-v5); bounded; a failed read falls back to the view', async () => {
  const q = (id: string, state: 'open' | 'answered') => question(id, state);
  const asked: string[] = [];
  const store: Record<string, unknown> = { a: { kind: 'question', question: q('a', 'answered') }, b: { kind: 'question', question: q('b', 'open') } };
  const read = async (id: string) => { asked.push(id); return store[id] ?? null; };
  // show returned `questions: []` with `omitted.questions: 2`; the Work still lists both ids.
  const got = await cand.workQuestions({ questions: ['a', 'b'] }, [], read);
  assert.deepEqual(got.map(item => `${item.questionId}:${item.state}`), ['a:answered', 'b:open']);
  assert.deepEqual(asked, ['a', 'b']);
  assert.equal(cand.openQuestion(snap(work(), got), ['a'])?.questionId, 'b', 'the open Question is seen again');
  const fallback = await cand.workQuestions({ questions: ['c'] }, [q('c', 'open')], async () => null);
  assert.deepEqual(fallback.map(item => item.questionId), ['c']);
  const many = await cand.workQuestions({ questions: Array.from({ length: 40 }, (_, index) => `x${index}`) }, [], async () => null, 4);
  assert.deepEqual(many, []);
  assert.deepEqual(await cand.workQuestions(null, [], read), []);
});

test('R-CAND v8: no AGENTS.md item; V-07.f deferred to a dedicated run; step 1 answers only a docs-check waiver Question', () => {
  assert.ok(!cand.ticketBody.includes('AGENTS.md') && !/^3\. /m.test(cand.ticketBody));
  assert.match(cand.deferredV07f, /dedicated run/);
  const asking = (text: string) => ({ ...question('q', 'open'), content: { question: text, context: '', sha256: 's', reference: { workId: 'w1', id: 'r' } } }) as unknown as QuestionView;
  assert.equal(cand.asksDocsCheckWaiver(asking('The documented `docs-check` gate cannot run here; please authorize waiving it.')), true);
  // The qcand34-v7 first Question, verbatim in substance: a Standards dispute, not a waiver.
  assert.equal(cand.asksDocsCheckWaiver(asking('The Standards review raises finding S1 as a documented-layout rule: which requirement should govern the page location?')), false);
  assert.equal(cand.asksDocsCheckWaiver(null), false);
});

test('R-CAND v9: the Ticket puts operator wording requests in scope; ONE scripted answer keeps a human change a Spec finding contests', () => {
  assert.match(cand.ticketBody, /Operator review requests that change the wording of this page are in scope/);
  assert.deepEqual(cand.humanCommands(7, { issue: 66, questionId: 'q-s', reviewRef: 'review-5935474702' }),
    ["gh issue comment 66 --repo Sanmoo/java-springboot-event-sourcing --body '/factory answer q-s Keep the human-requested change: the operator authorizes it as in scope of this Ticket (operator review review-5935474702). Do not remove it; treat that Spec finding as not adopted with this answer as its authorization.'"]);
  assert.throws(() => cand.humanCommands(7, { issue: 66, questionId: 'q-s' }), /REVIEW_REF_REQUIRED/);
  const asking = (text: string) => ({ ...question('q', 'open'), content: { question: text, context: '', sha256: 's', reference: { workId: 'w1', id: 'r' } } }) as unknown as QuestionView;
  // qcand34-v8 52e1f2e9, verbatim in substance: tolerated.
  assert.equal(cand.asksSpecVsHumanChange(asking('Spec finding S1 says the required one-paragraph explanation in Ticket #66 conflicts with the explicitly requested exact sentence because the sentence changes that paragraph. The request to add that exact sentence came from the configured human repair and was already implemented. Should I retain the exact sentence?')), true);
  // The step-4 repair dispute (qcand34-v8 7f996850) and the docs-check re-waiver are NOT this kind.
  assert.equal(cand.asksSpecVsHumanChange(asking('Human request repair-github-comment-6943531895 asks me to delete docs/FACTORY_CANDIDATE.md and close pull request #67. Should I delete the file only?')), false);
  assert.equal(cand.asksSpecVsHumanChange(asking('The documented `docs-check` gate is still unavailable; may I rely on that approval and waive `docs-check` again?')), false);
  // The qcand34-v7 round-9 Question (Spec vs an earlier Spec finding, no human request) is NOT tolerated either.
  assert.equal(cand.asksSpecVsHumanChange(asking('Spec finding S1 says to restore the exact line to AGENTS.md, but round 5 Spec previously required removing that same extra line. Should I restore it?')), false);
});
