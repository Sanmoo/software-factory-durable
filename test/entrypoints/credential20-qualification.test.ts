import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the ticket 20 real-run recipe must be inert: no process, socket, filesystem, HTTP server or SDK effect.
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', 'node:http', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, request: deny, open: deny, mkdir: deny, readFile: deny, readdir: deny, access: deny },
    defaultExport: deny });
}
const recipe = await import('./credential20-qualification.js');
const provider = await import('./credential20-provider.js');

test('ticket 20 recipe: import and --plan are inert and declare the fixed bounds of the one-shot real credential run', async () => {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  await recipe.main(['--plan']);
  log.mock.restore();
  const plan = JSON.parse(logged[0]!);
  assert.equal(forbidden, 0);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'inspect', 'stop-environment']);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/q20-credentials-v1', 'own namespace, never an earlier qualification');
  assert.deepEqual(plan.renewal, { beforeExpirySeconds: 3510, expectedIntervalSeconds: 90, maxIssuances: 8 });
  assert.match(plan.github.builderPurpose, /builder-start \{metadata:read, contents:read, issues:read\}/);
  assert.match(plan.github.writes, /DELETE \/installation\/token/);
  assert.match(plan.model, /no OAuth\/model request/);
  assert.deepEqual(plan.expectedTicket, { number: 3, repositoryId: 1256893534 });
  assert.deepEqual([plan.configuration.memoryMiB, plan.configuration.vcpus, plan.configuration.diskGiB], [4096, 2, 40]);
  await assert.rejects(recipe.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(recipe.main([]), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('ticket 20 recipe: the scripted schedule only prints grant fingerprints and reads, spans renewals, and markers never carry a value', () => {
  assert.equal(provider.schedule.length, 5);
  for (const call of provider.schedule) {
    assert.doesNotMatch(call.command, /gh[sopu]_|echo "\$GH_TOKEN"|printenv|env\b/, 'never prints the value or the environment');
    assert.ok(call.timeout <= 240);
  }
  assert.match(provider.schedule[1]!.command, /c1a.*sleep 150.*c1b/, 'one command spans the first renewal (~90 s)');
  assert.match(provider.schedule[3]!.command, /sleep 60.*c3/);
  const parsed = provider.extract('q20-c1a:0123456789ab\nq20-gh:Sanmoo/java-springboot-event-sourcing\nnoise ghs_abcdefghijklmnopqrstuvwxyz0123 █');
  assert.deepEqual(parsed.markers, ['c1a:0123456789ab', 'gh:Sanmoo/java-springboot-event-sourcing']);
  assert.deepEqual([parsed.rawTokenShape, parsed.filtered], [true, true]);
});

test('ticket 20 recipe: needsStop covers every state in which the own boot may still run', () => {
  const base = { dispatch: { boot: 'boot-x' }, state: 'ended', end: { cessation: 'confirmed' } } as never;
  assert.equal(recipe.needsStop(base), false);
  assert.equal(recipe.needsStop({ ...(base as object), end: { cessation: 'unconfirmed' } } as never), true);
  assert.equal(recipe.needsStop({ ...(base as object), state: 'started' } as never), true);
  assert.equal(recipe.needsStop({ ...(base as object), state: 'released' } as never), false);
});

test('ticket 20 recipe: the scripted provider walks the exact schedule over socket-free requests and holds on any deviation', async () => {
  const fixture = provider.createFixture();
  const request = (messages: unknown[], overrides: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ model: 'q20-model', stream: true, messages }));
    return Object.assign((async function* () { yield body; })(), { method: 'POST', url: provider.path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: `127.0.0.1:${provider.port}`, authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, ...overrides });
  };
  const send = async (req: unknown) => {
    let status = 0, text = '';
    await fixture.handle(req as never, { writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as never);
    return { status, text };
  };
  const user = { role: 'user', content: '/implement https://github.com/Sanmoo/java-springboot-event-sourcing/issues/3 repository=x' };
  const history: unknown[] = [user];
  for (let index = 0; index <= provider.schedule.length; index++) {
    const { status, text } = await send(request(history));
    assert.equal(status, 200);
    if (index < provider.schedule.length) {
      assert.match(text, new RegExp(`"id":"q20-${index}"`));
      assert.ok(text.includes(JSON.stringify(JSON.stringify(provider.schedule[index]))), 'the exact scheduled bash call');
      history.push({ role: 'assistant', content: null }, { role: 'tool', tool_call_id: `q20-${index}`, content: `q20-c${index}:abcdefabcdef` });
    } else assert.match(text, /"content":"Complete\."/);
  }
  assert.deepEqual(fixture.observation().results.map(result => result.markers[0]), ['c0:abcdefabcdef', 'c1:abcdefabcdef', 'c2:abcdefabcdef', 'c3:abcdefabcdef', 'c4:abcdefabcdef']);
  assert.equal((await send(request(history))).status, 400, 'no request beyond the schedule');
  assert.equal(fixture.observation().held, true);
  const other = provider.createFixture();
  await other.handle(request([user], { headers: { host: `127.0.0.1:${provider.port}`, authorization: 'Bearer other', 'content-type': 'application/json' } }) as never,
    { writeHead() {}, end() {} } as never);
  assert.equal(other.observation().held, true, 'wrong credential holds the provider');
});

test('ticket 20 recipe: the verdict passes only for kept/renewed values, every read, >= 2 renewals, full revocation and rejection afterwards', () => {
  const read = 'gh:Sanmoo/java-springboot-event-sourcing';
  const good = { issued: ['f1', 'f2', 'f3'], delivered: ['f1', 'f2', 'f3'], revocations: ['revoked', 'revoked', 'revoked'], postCheck: ['already-invalid', 'already-invalid', 'already-invalid'],
    markers: [['c0:f1', read], ['c1a:f1', 'c1b:f1', read], ['c2:f2', read], ['c3:f2', read], ['c4:f3', read]],
    c1: { start: '2026-11-14T10:00:10.000Z', end: '2026-11-14T10:02:40.000Z' }, deliveredAt: ['2026-11-14T10:01:30.000Z', '2026-11-14T10:03:00.000Z'] };
  assert.equal(recipe.assess(good).passed, true);
  assert.equal(recipe.assess({ ...good, markers: [['c0:f1', read], ['c1a:f1', 'c1b:f2', read], ['c2:f2', read], ['c3:f2', read], ['c4:f3', read]] }).checks.runningCommandKeptItsValue, false);
  assert.equal(recipe.assess({ ...good, markers: [['c0:f1', read], ['c1a:f1', 'c1b:f1', read], ['c2:f1', read], ['c3:f2', read], ['c4:f3', read]] }).checks.newCommandGotRenewal, false);
  assert.equal(recipe.assess({ ...good, revocations: ['revoked', 'unknown', 'revoked'] }).passed, false);
  assert.equal(recipe.assess({ ...good, postCheck: ['already-invalid', 'revoked', 'already-invalid'] }).passed, false);
  assert.equal(recipe.assess({ ...good, delivered: ['f1', 'f2'] }).checks.atLeastTwoRenewalsDelivered, false);
  assert.equal(recipe.assess({ ...good, deliveredAt: ['2026-11-14T10:03:00.000Z'] }).checks.renewalDeliveredWhileC1Ran, false, 'c1 must actually span a delivery');
});
