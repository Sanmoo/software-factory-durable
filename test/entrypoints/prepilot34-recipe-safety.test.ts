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
  assert.match(cand.humanCommands(2, { issue: 50, pullRequest: 51 })[0]!, /^gh pr review 51 --repo \S+ --request-changes --body 'Please restore AGENTS.md/);
  assert.equal(cand.humanCommands(3, { issue: 50, pullRequest: 51 })[0], `gh pr comment 51 --repo Sanmoo/java-springboot-event-sourcing --body '/factory repair Delete ${cand.candidateFile} and close this pull request.'`);
  assert.deepEqual(cand.humanCommands(5, { issue: 50, pullRequest: 51 }), [`gh pr review 51 --repo Sanmoo/java-springboot-event-sourcing --approve --body 'Approved after the candidate journey.'`,
    'gh pr merge 51 --repo Sanmoo/java-springboot-event-sourcing --merge']);
  for (const step of [1, 2, 3, 4, 5] as const) {
    for (const line of cand.humanCommands(step, { issue: 50, pullRequest: 51, questionId: 'q' })) assert.ok(!/--admin|--squash|--rebase|--delete-branch|--force|dismiss/.test(line), line);
  }
  assert.throws(() => cand.humanCommands(4, { issue: 50 }), /QUESTION_ID_REQUIRED/);
  assert.throws(() => cand.humanCommands(2, { issue: 50 }), /PULL_REQUEST_REQUIRED/);
  // The Ticket: documentation only; the instruction trap and the gate whose waiver needs approval are in it; the runnable gate is POSIX.
  assert.ok(cand.ticketBody.includes(cand.agentsLine) && cand.ticketBody.includes(cand.contentGate) && cand.ticketBody.includes(cand.docsCheckGate));
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
  assert.equal(cand.boundsViolation(snap(work(), ['a', 'b', 'c', 'd'].map(id => question(id, 'open')))), 'BOUND_QUESTIONS');
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
  markers: { 'ticket-23-feedback': true, 'ticket-24-single-pass-dispatch': true, 'ticket-29-inspection': true, 'ticket-34-candidate': true, 'd-07-sqlite-scrub': true, 'owner-user-bus': true, 'continuation-findings': true } };
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
      agentsAtBase: 'sha-base', agentsAtMerge: 'sha-base', cli: [{ args: ['show'], code: 0 }, { args: ['usage'], code: 0 }], secrets: { storage: 0, observations: 0 },
      usage: { byRole: { builder: { measured: 2, tokens: { total: 10 } }, standards: { measured: 1, tokens: { total: 5 } }, spec: { measured: 1, tokens: { total: 4 } } } } }) };
}

test('R-CAND verdict: every obligation proven only by what the saved results show; a missing stamp, a worktree executable or a silent repair disproves', () => {
  const good = cand.verdict(savedJourney() as never);
  assert.ok(good.passed, JSON.stringify(good.checks.filter(item => !item.passed)));
  assert.deepEqual(good.obligations, { 'V-06.h': 'proven', 'V-07.f': 'proven', 'V-08.g': 'proven', 'V-10.d': 'proven', 'V-16.d': 'proven' });
  const unstamped = savedJourney(); (unstamped.review as Record<string, unknown>).factory = undefined;
  assert.equal(cand.verdict(unstamped as never).obligations['V-06.h'], 'not-proven', 'a result without the Factory commit proves nothing');
  const worktree = savedJourney(); (worktree.answer as { controller: { exe: string } }).controller.exe = '/usr/bin/node';
  assert.equal(cand.verdict(worktree as never).obligations['V-08.g'], 'not-proven', 'not run from the installed release');
  const silent = savedJourney(); (silent.repair as unknown as { outcome: string }).outcome = 'closed-without-question';
  assert.equal(cand.verdict(silent as never).obligations['V-10.d'], 'not-proven');
  const kept = savedJourney(); (kept.inspect as unknown as { prFiles: string[] }).prFiles = ['AGENTS.md', cand.candidateFile];
  assert.equal(cand.verdict(kept as never).obligations['V-07.f'], 'not-proven', 'the instruction change was merged');
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

test('R-CAND v3: the human review asks only what the Ticket anticipates; ended predecessor cycles hold no capacity', () => {
  const review = cand.humanCommands(2, { issue: 50, pullRequest: 51 })[0]!;
  assert.ok(!/Review notes/.test(review), 'v2 asked for a section outside the Ticket scope (Spec finding, unscripted Question)');
  assert.match(review, /supersedes item 3/);
  assert.match(cand.ticketBody, /a later operator review that asks to remove it supersedes this item/);
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
