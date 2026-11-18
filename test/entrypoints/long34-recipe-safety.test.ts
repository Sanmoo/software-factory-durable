import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assess, censusCrossedExpiry, clockDrift, grantAllowed, labelExact, phaseGuard, runOutcome, teardownSteps, walkWorks, type LongInput } from './long34-qualification.js';
import * as provider from './long34-provider.js';

// Recipe safety of the R-LONG real run, on controlled data only (never the real root, GitHub, VM or model).

test('phase guard: unpinned issue refuses; each phase once; everything after preflight needs its success; inspect needs the run', () => {
  assert.equal(phaseGuard('preflight', {}, new Set(), false), 'TICKET_NOT_PINNED');
  assert.equal(phaseGuard('preflight', {}, new Set(), true), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent']), true), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('run', { preflight: { status: 'held' } }, new Set(['preflight-intent']), true), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('run', { preflight: { status: 'success' } }, new Set(['preflight-intent']), true), null);
  assert.equal(phaseGuard('inspect', { preflight: { status: 'success' } }, new Set(), true), 'RUN_RESULT_REQUIRED');
});

test('the schedule: fingerprints and reads only, never a value; the census is REAL suite work without any sleep and lasts at least 75 min', () => {
  assert.equal(provider.schedule.length, 3);
  for (const call of provider.schedule) assert.doesNotMatch(call.command, /gh[sopu]_|echo "\$GH_TOKEN"|printenv|\benv\b|\bsleep\b/, 'never prints the value or the environment; no sleep');
  assert.match(provider.census, /\.\/gradlew --no-daemon test/, 'the README suite (q24 v4 command)');
  assert.match(provider.census, new RegExp(`-lt ${provider.censusSeconds} `), 'the census runs while less than censusSeconds have elapsed');
  assert.ok(provider.censusSeconds >= 4500, 'the census outlives the 3600 s token by a margin');
  assert.ok(provider.schedule[1].timeout > provider.censusSeconds, 'the tool call bound exceeds the census (it is not a Factory timeout)');
  assert.match(provider.schedule[1].command, /q34l-c1a.*q34l-gh-c1a.*q34l-run.*q34l-c1b.*q34l-gh-c1b/s, 'c1 fingerprints and reads before and after the census');
  const parsed = provider.extract('q34l-c1a:0123456789ab\nq34l-gh-c1b:fail:HTTP-401\nq34l-run:3:1:612\nq34l-census:8:4511\nnoise ghs_abcdefghijklmnopqrstuvwxyz0123 █');
  assert.deepEqual(parsed.markers, ['c1a:0123456789ab', 'gh-c1b:fail:HTTP-401', 'run:3:1:612', 'census:8:4511']);
  assert.deepEqual([parsed.rawTokenShape, parsed.filtered], [true, true]);
});

test('the scripted provider walks the exact schedule over socket-free requests and holds on any deviation', async () => {
  const fixture = provider.createFixture();
  const request = (messages: unknown[], overrides: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ model: 'q34l-model', stream: true, messages }));
    return Object.assign((async function* () { yield body; })(), { method: 'POST', url: provider.path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: `127.0.0.1:${provider.port}`, authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, ...overrides });
  };
  const send = async (req: unknown) => {
    let status = 0, text = '';
    await fixture.handle(req as never, { writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as never);
    return { status, text };
  };
  const history: unknown[] = [{ role: 'user', content: '/implement https://github.com/Sanmoo/java-springboot-event-sourcing/issues/9 repository=x' }];
  for (let index = 0; index <= provider.schedule.length; index++) {
    const { status, text } = await send(request(history));
    assert.equal(status, 200);
    if (index < provider.schedule.length) {
      assert.ok(text.includes(JSON.stringify(JSON.stringify(provider.schedule[index]))), 'the exact scheduled bash call');
      history.push({ role: 'assistant', content: null }, { role: 'tool', tool_call_id: `q34l-${index}`, content: `q34l-c${index}:abcdefabcdef` });
    } else assert.match(text, /"content":"Complete\."/);
  }
  assert.equal((await send(request(history))).status, 400, 'no request beyond the schedule');
  assert.equal(fixture.observation().held, true);
  const other = provider.createFixture();
  await other.handle(request(history.slice(0, 1), { url: '/other' }) as never, { writeHead() {}, end() {} } as never);
  assert.equal(other.observation().held, true, 'a foreign route holds the provider');
});

test('host clock: drift is calendar minus monotonic per interval; a jump over 1 s counts as an observed step (never injected)', () => {
  assert.deepEqual(clockDrift([{ wall: 0, mono: 0 }, { wall: 60_000, mono: 60_000 }, { wall: 120_010, mono: 120_000 }]), { samples: 3, maxDriftMs: 10, totalDriftMs: 10, steps: 0 });
  assert.equal(clockDrift([{ wall: 0, mono: 0 }, { wall: 3_660_000, mono: 60_000 }]).steps, 1);
  assert.deepEqual(clockDrift([]), { samples: 0, maxDriftMs: 0, totalDriftMs: 0, steps: 0 });
});

const expiresAt = '2026-11-20T11:00:00.000Z';
function world(change: (input: LongInput) => void = () => {}) {
  const input: LongInput = {
    execution: { end: { outcome: 'completed' }, timing: { timeoutSeconds: null, timeout: null, duration: { kind: 'measured', elapsedMs: 80 * 60_000, endedAt: '2026-11-20T11:21:00.000Z' } },
      credentialIssuance: { outcome: 'issued', metadata: { issuedAt: '2026-11-20T10:00:00.000Z', expiresAt } },
      credentialRenewals: [{ outcome: 'issued', delivery: 'delivered', metadata: { issuedAt: '2026-11-20T10:50:00.000Z', expiresAt: '2026-11-20T11:50:00.000Z' } }] } as never,
    issued: ['f1', 'f2'], delivered: ['f1', 'f2'], deliveredAt: ['2026-11-20T10:50:01.000Z'],
    markers: [['c0:f1', 'gh-c0:ok:Sanmoo/java-springboot-event-sourcing'], ['c1a:f1', 'gh-c1a:ok:x', 'run:1:0:600', 'census:8:4510', 'c1b:f1', 'gh-c1b:fail:HTTP-401'], ['c2:f2', 'gh-c2:ok:x']],
    c1: { start: '2026-11-20T10:01:00.000Z', end: '2026-11-20T11:16:30.000Z' }, revocations: ['revoked', 'revoked'], postCheck: ['already-invalid', 'already-invalid'],
    observedMonotonicMs: 80 * 60_000 + 7000, deadlineReached: false };
  change(input);
  return assess(input);
}

test('V-03.c/V-13.e verdict: passed only with every check; a timeout cut or a lost renewal FAILS; a census that never crossed the expiry is INCONCLUSIVE', () => {
  assert.equal(world().status, 'passed', JSON.stringify(world().checks));
  const cut = world(input => { input.execution = { ...input.execution!, end: { outcome: 'failure', code: 'EXECUTION_TIMEOUT' } as never, timing: { ...input.execution!.timing!, timeout: { reachedAt: 'x', elapsedMs: 3_600_000, evidence: 'measured' } } }; });
  assert.deepEqual([cut.status, cut.failures], ['failed', ['completedWithoutTimeout']], 'any timeout cut fails the run');
  assert.deepEqual(world(input => { input.markers[1] = ['c1a:f1', 'gh-c1a:ok:x', 'c1b:f2', 'gh-c1b:ok:x']; }).failures, ['runningCommandKeptItsValue'], 'a running command never changes its value');
  assert.deepEqual(world(input => { input.markers[2] = ['c2:f1', 'gh-c2:fail:HTTP-401']; }).failures, ['newCommandGotRenewal']);
  assert.deepEqual(world(input => { input.revocations = ['revoked', 'unknown']; }).failures, ['everyGrantRevoked']);
  assert.deepEqual(world(input => { input.postCheck = ['already-invalid', 'revoked']; }).failures, ['githubRejectsEveryGrantAfterwards'], 'a grant still accepted afterwards');
  const late = world(input => { (input.execution!.credentialRenewals[0]!.metadata as { issuedAt: string }).issuedAt = '2026-11-20T11:05:00.000Z'; });
  assert.deepEqual(late.failures, ['renewedBeforeExpiry'], 'a renewal after the first expiry is a lost renewal');
  const short = world(input => { input.c1 = { start: '2026-11-20T10:01:00.000Z', end: '2026-11-20T10:40:00.000Z' }; input.execution!.timing!.duration = { kind: 'measured', elapsedMs: 45 * 60_000, endedAt: '2026-11-20T10:45:00.000Z' }; input.observedMonotonicMs = 45 * 60_000; });
  assert.equal(short.status, 'inconclusive');
  assert.ok(short.inconclusive.includes('CENSUS_DID_NOT_CROSS_THE_FIRST_EXPIRY') && short.inconclusive.includes('ACTIVITY_SHORTER_THAN_ONE_HOUR'));
  assert.equal(world(input => { input.observedMonotonicMs = 70 * 60_000; }).checks.durationMonotonic, false, 'a recorded duration far from the monotonic measure');
  assert.equal(world(input => { input.observedMonotonicMs = 70 * 60_000; }).status, 'failed', 'never passed with a duration mismatch');
});

test('lessons (R-CAND/R-CRASH-A/R-GH): label exact before preflight; every list page walked; Questions by id and any Question holds with its text', async () => {
  assert.equal(labelExact([9], [9]), true);
  assert.equal(labelExact([], [9]), false, 'GitHub may list nothing right after labelling');
  assert.equal(labelExact([9, 10], [9]), false);
  // In-process `list` pages too: the Work may be on a later page; a non-advancing page is incomplete, never a silent partial list.
  const pages: Record<number, unknown> = { 0: { kind: 'list', works: [{ work_id: 'a' }], page: { nextCursor: 1 } }, 1: { kind: 'list', works: [{ work_id: 'b' }], page: { nextCursor: null } } };
  assert.deepEqual(await walkWorks(async cursor => pages[cursor]), { works: [{ work_id: 'a' }, { work_id: 'b' }], complete: true });
  assert.equal((await walkWorks(async () => ({ kind: 'list', works: [], page: { nextCursor: 0 } }))).complete, false);
  const ended = { state: 'ended', end: { outcome: 'completed' }, dispatch: { phase: 'stopped' } };
  assert.deepEqual(runOutcome({ execution: ended, questions: [], deadlineReached: false, listComplete: true }), { status: 'success', holdReason: null });
  assert.deepEqual(runOutcome({ execution: ended, questions: [{ questionId: 'q1', state: 'open', request: { question: 'Which name?' } }], deadlineReached: false, listComplete: true }),
    { status: 'held', holdReason: 'UNSCRIPTED_QUESTION:q1' }, 'the scripted schedule never asks: any Question holds');
  assert.deepEqual(runOutcome({ execution: { state: 'held', held: { code: 'START_X' } }, questions: [], deadlineReached: false, listComplete: true }), { status: 'held', holdReason: 'EXECUTION_HELD:START_X' });
  assert.deepEqual(runOutcome({ execution: { ...ended, end: { outcome: 'failure', code: 'EXECUTION_TIMEOUT' } }, questions: [], deadlineReached: false, listComplete: true }),
    { status: 'held', holdReason: 'EXECUTION_ENDED:failure:EXECUTION_TIMEOUT' });
  assert.deepEqual(runOutcome({ execution: undefined, questions: [], deadlineReached: true, listComplete: true }), { status: 'held', holdReason: 'DEADLINE_REACHED' });
  assert.deepEqual(runOutcome({ execution: undefined, questions: [], deadlineReached: false, listComplete: false }), { status: 'held', holdReason: 'LIST_INCOMPLETE' });
});

test('lessons: builder-publish is refused (no GitHub write); inspect requests the teardown first; a killed phase removes the key copy', () => {
  assert.equal(grantAllowed('builder-start'), true);
  assert.equal(grantAllowed(undefined), true);
  assert.equal(grantAllowed('builder-publish'), false);
  const steps = teardownSteps(9);
  assert.ok(steps.some(item => /remove the label ready-for-agent from #9/.test(item)) && steps.some(item => /close #9/.test(item)));
  const text = readFileSync(join(process.cwd(), 'test', 'entrypoints', 'long34-qualification.ts'), 'utf8');
  assert.match(text, /for \(const signal of \['SIGTERM', 'SIGINT'\] as const\) process\.once\(signal/, 'SIGTERM/SIGINT remove the namespace key copy');
  assert.ok(text.indexOf("save('teardown-request'") < text.indexOf('snapshotStorage(observations'), 'the teardown request is saved before any storage/GitHub read');
});

test('real run v1: Gradle skipped the suite after run 1 (`:test UP-TO-DATE`, 16 s) and the 12-run cap ended the census at 963 s; v2 forces re-execution and bounds the census by TIME', () => {
  assert.match(provider.census, /\.\/gradlew --no-daemon test --rerun-tasks/, 'every run re-executes the tests (never UP-TO-DATE)');
  assert.ok(provider.maxRuns >= 40, 'the run cap is only a safety bound, far above 4500 s of real runs');
  assert.match(provider.census, new RegExp(`while \\[ "\\$\\(\\( \\$\\(date \\+%s\\) - start \\)\\)" -lt ${provider.censusSeconds} \\] && \\[ "\\$i" -lt ${provider.maxRuns} \\]`),
    'the loop runs WHILE the elapsed time is below the census, the count is only the safety cap');
  assert.doesNotMatch(provider.census, /\bsleep\b/);
});

test('CENSUS_SHORT: the census call must end after the first grant expires', () => {
  assert.equal(censusCrossedExpiry({ start: '2026-11-18T08:10:17.221Z', end: '2026-11-18T08:26:22.548Z' }, '2026-11-18T09:10:15Z'), false, 'v1');
  assert.equal(censusCrossedExpiry({ start: '2026-11-18T08:10:17Z', end: '2026-11-18T09:26:00Z' }, '2026-11-18T09:10:15Z'), true);
  assert.equal(censusCrossedExpiry(undefined, '2026-11-18T09:10:15Z'), null);
  assert.equal(censusCrossedExpiry({ start: 'a', end: 'b' }, null), null);
  const ended = { state: 'ended', end: { outcome: 'completed' }, dispatch: { phase: 'stopped' } };
  assert.deepEqual(runOutcome({ execution: ended, questions: [], deadlineReached: false, listComplete: true, censusCrossed: false }), { status: 'held', holdReason: 'CENSUS_SHORT' });
  assert.deepEqual(runOutcome({ execution: ended, questions: [], deadlineReached: false, listComplete: true, censusCrossed: true }), { status: 'success', holdReason: null });
});

test('real run v1 verdict: a run that never reached the renewal point is INCONCLUSIVE, never failed by newCommandGotRenewal', () => {
  const v1 = world(input => {
    input.execution = { end: { outcome: 'completed' }, timing: { timeoutSeconds: null, timeout: null, duration: { kind: 'measured', elapsedMs: 967863, endedAt: '2026-11-18T08:26:23.343Z' } },
      credentialIssuance: { outcome: 'issued', metadata: { issuedAt: '2026-11-18T08:10:15.289Z', expiresAt: '2026-11-18T09:10:15Z' } }, credentialRenewals: [] } as never;
    input.issued = ['f1']; input.delivered = ['f1']; input.deliveredAt = [];
    input.markers = [['c0:f1', 'gh-c0:ok:x'], ['c1a:f1', 'gh-c1a:ok:x', 'census:12:963', 'c1b:f1', 'gh-c1b:ok:x'], ['c2:f1', 'gh-c2:ok:x']];
    input.c1 = { start: '2026-11-18T08:10:17.221Z', end: '2026-11-18T08:26:22.548Z' }; input.revocations = ['revoked']; input.postCheck = ['already-invalid'];
    input.observedMonotonicMs = 970910;
  });
  assert.equal(v1.status, 'inconclusive', JSON.stringify(v1));
  assert.deepEqual(v1.failures, []);
  assert.ok(v1.inconclusive.includes('CENSUS_DID_NOT_CROSS_THE_FIRST_EXPIRY') && v1.inconclusive.includes('RENEWAL_POINT_NOT_REACHED'));
});
