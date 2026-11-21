import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createSandbox, type BootRef, type EnvironmentRef, type ReadResult, type ToolCall, type ToolContext } from '../../src/sandbox/index.js';
import { lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';
import { renderGuestImage } from '../../src/sandbox/lambda/guest-image.js';
import { channelPrelude, commitIdentityEnv, guestPath } from '../../src/sandbox/bash-tools.js';
import { spawnSync } from 'node:child_process';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 05 (V2-02 Executar ferramenta, V2-20, V2-23, V2-24, V2-26): the role tools of the MVP over a Lambda boot, through the same
// owner transport and tool programs, with an in-process guest behind the channel. No AWS call, no ssh, no VM.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const pinned = { path: '.factory/environment.yaml', commit: 'c'.repeat(40), sha256: sha('d'), repository: 'acme/shop', repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [], images: [] } };
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const builderToken = 'ghs_builderTokenOfThisExecution';

type Bind = Partial<{ role: ToolContext['role']; invocationId: string; credential: { current(): string | undefined }; editSourceMaxBytes: number; copyOutput: boolean; selectedOutputCopies: string[] }>;

async function activeBoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  guests.world.origins[remote] = { commits: [startingCommit], token: builderToken };
  const clock = { now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } };
  const sandbox = createSandbox({ root, lambdaService: fake.service, lambdaTransport: guests.transport, lambdaBootClock: clock,
    lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep } });
  const prepared = await sandbox.prepare({ workId, configuration, environment: pinned });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const boot = async () => {
    const started = await sandbox.start({ environment, configuration, checkout: { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1', credential: { token: builderToken } } });
    assert.equal(started.status, 'success', JSON.stringify(started));
    return (started as { boot: BootRef }).boot;
  };
  const first = await boot();
  const guest = guests.guestOf(fake.account.microvms.at(-1)!.microvmId)!;
  await mkdir(join(root, 'records'), { mode: 0o700 });
  const records = await createRecords({ root: join(root, 'records') });
  const served = await sandbox.serveTools({ environment, boot: first });
  assert.equal(served.status, 'serving', JSON.stringify(served));
  const tools = (served as Extract<typeof served, { status: 'serving' }>).tools;
  t.after(() => tools.close());
  let sockets = 0;
  /** What the host does for one worker invocation: binds its role on the boot and hands the worker the bound endpoint. */
  const invocation = async ({ role = 'builder', invocationId = `invocation-${sockets}`, ...policy }: Bind = {}) => {
    const context: ToolContext = { workId, executionId: 'execution-1', invocationId, role, environmentRef: environment, bootRef: first, phaseId: 'phase-1' };
    const authority = new AbortController();
    const bound = await tools.bind({ endpoint: join(root, `t${sockets += 1}`), context, signal: authority.signal, records, ...policy });
    assert.equal(bound.status, 'bound', JSON.stringify(bound));
    const client = createSandbox({ root, toolEndpoint: (bound as { endpoint: string }).endpoint });
    let calls = 0;
    const call = (input: Record<string, unknown>, onData?: (data: Buffer) => void, signal?: AbortSignal): Promise<ReadResult> =>
      client.executeTool(context, { callId: `call-${calls += 1}`, ...input } as ToolCall, onData, signal);
    /** The whole text of a file as the `read` tool gives it: a capture, then its pages. */
    const read = async (path: string) => {
      const capture = await call({ name: 'read', operation: 'capture', path });
      if (capture.status !== 'success') return capture.code;
      let text = '';
      for (let offset = 0; offset < capture.bytes;) {
        const page = await call({ name: 'read', operation: 'page', reference: capture.reference, offset });
        assert.equal(page.status, 'success', JSON.stringify(page));
        if (page.status !== 'success') break;
        text += Buffer.from(page.data, 'base64').toString('utf8');
        offset = page.nextOffset;
      }
      return text;
    };
    return { context, authority, call, read, client };
  };
  return { root, fake, guests, guest, sandbox, environment, boot: first, startBoot: boot, records, tools, invocation };
}

test('a reviewer reads a file of the checkout cloned in the Lambda guest, as the read-only guest user', async t => {
  const { guest, invocation } = await activeBoot(t);
  guest.files.set('/workspace/checkout/README.md', '# Shop\nA file of the starting commit.\n');
  const reviewer = await invocation({ role: 'standards' });
  assert.equal(await reviewer.read('/workspace/checkout/README.md'), '# Shop\nA file of the starting commit.\n');
  const ran = guest.executions.at(-1)!;
  assert.deepEqual({ program: ran.program, user: ran.user, environmentNames: ran.environmentNames }, { program: 'tool', user: 'reviewer', environmentNames: [] });
  assert.equal(await reviewer.read('/workspace/checkout/absent.md'), 'READ_NOT_FOUND');
  assert.equal(await reviewer.read('/workspace/checkout'), 'READ_IS_DIRECTORY');
  assert.equal(await reviewer.read('/etc/shadow'), 'READ_PATH_DENIED');
});

test('a Builder writes and edits files in the guest with the MVP results and codes, and a reviewer reads what it wrote', async t => {
  const { guest, invocation } = await activeBoot(t);
  const builder = await invocation({ editSourceMaxBytes: 8192, copyOutput: true });
  const notes = '/workspace/checkout/docs/notes.md';
  assert.equal((await builder.call({ name: 'write', operation: 'mkdir', path: '/workspace/checkout/docs' })).status, 'success');
  const written = await builder.call({ name: 'write', operation: 'create', path: notes, content: 'first\n' });
  assert.deepEqual({ status: written.status, bytes: written.status === 'success' && written.bytes }, { status: 'success', bytes: 0 });
  assert.equal(guest.files.get(notes), 'first\n');

  const source = await builder.call({ name: 'edit-source', operation: 'capture', path: notes });
  assert.equal(source.status, 'success', JSON.stringify(source));
  const version = source as Extract<ReadResult, { format: 'text' }>;
  const page = await builder.call({ name: 'edit-source', operation: 'page', path: notes, reference: version.reference, sourceVersion: version.sourceVersion, offset: 0 });
  assert.equal(page.status === 'success' && Buffer.from(page.data, 'base64').toString(), 'first\n');
  assert.equal((await builder.call({ name: 'edit-source', operation: 'commit', path: notes, reference: version.reference, sourceVersion: version.sourceVersion, replacement: 'second\n' })).status, 'success');
  assert.equal(guest.files.get(notes), 'second\n');

  // The file changed in the guest after its source was captured: the edit is not applied, with the MVP's code.
  const stale = await builder.call({ name: 'edit-source', operation: 'capture', path: notes }) as Extract<ReadResult, { format: 'text' }>;
  guest.files.set(notes, 'changed behind the edit\n');
  assert.deepEqual(await builder.call({ name: 'edit-source', operation: 'commit', path: notes, reference: stale.reference, sourceVersion: stale.sourceVersion, replacement: 'third\n' }),
    { status: 'failure', code: 'EDIT_SOURCE_CHANGED' });
  assert.equal(guest.files.get(notes), 'changed behind the edit\n');

  assert.deepEqual(await builder.call({ name: 'write', operation: 'create', path: '/etc/passwd', content: 'x' }), { status: 'failure', code: 'WRITE_PATH_DENIED' });
  // As in the MVP, the Builder's `read` is for its output copies and skill pack; it reads the checkout with Bash.
  assert.equal(await builder.read(notes), 'READ_PATH_DENIED');
  assert.ok(guest.executions.filter(execution => execution.program === 'tool').every(execution => execution.user === 'builder'));

  const reviewer = await invocation({ role: 'spec' });
  assert.equal(await reviewer.read(notes), 'changed behind the edit\n');
});

test('Builder Bash runs in the guest with progress while the command still runs, the fixed command environment and its exit status', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let seen: Record<string, string> = {};
  guests.world.commands['make test'] = async (_guest, run) => {
    seen = run.environment;
    run.emit('compiling\n');
    await held;
    run.emit('2 tests failed\n');
    return 2;
  };
  const builder = await invocation();
  const progress: string[] = [];
  const result = await builder.call({ name: 'bash', command: 'make test' }, data => { progress.push(data.toString()); release(); });
  // The first output reached the worker BEFORE the command ended: the command only ends after that delivery released it.
  assert.deepEqual(progress, ['compiling\n', '2 tests failed\n']);
  assert.deepEqual({ status: result.status, exitCode: result.status === 'success' && 'exitCode' in result && result.exitCode, bytes: result.status === 'success' && result.bytes },
    { status: 'success', exitCode: 2, bytes: 25 });
  assert.deepEqual(seen, { GIT_AUTHOR_NAME: 'Software Factory Builder', GIT_AUTHOR_EMAIL: 'software-factory-builder@users.noreply.invalid',
    GIT_COMMITTER_NAME: 'Software Factory Builder', GIT_COMMITTER_EMAIL: 'software-factory-builder@users.noreply.invalid',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' });
  const ran = guest.executions.at(-1)!;
  assert.deepEqual({ user: ran.user, environmentNames: ran.environmentNames }, { user: 'builder', environmentNames: [] });
  assert.match(ran.script, /^cd '\/workspace' && exec /);
  // The Builder is in the docker group of the guest.
  const docker = await builder.call({ name: 'bash', command: 'docker ps' }, () => {});
  assert.equal(docker.status === 'success' && 'exitCode' in docker && docker.exitCode, 0, JSON.stringify(docker));
});

test('the Builder token reaches a command as explicit process environment only, follows renewal and withdrawal, and leaves no trace in the guest', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  const held: { token: string | undefined } = { token: builderToken };
  const seen: { token: string | undefined; stdin: string }[] = [];
  guests.world.commands['git push origin factory/work-1'] = (_guest, run) => {
    seen.push({ token: run.environment.GH_TOKEN, stdin: run.stdin });
    run.emit('To https://github.com/acme/shop.git\n');
    return 0;
  };
  const builder = await invocation({ credential: { current: () => held.token } });
  const push = () => builder.call({ name: 'bash', command: 'git push origin factory/work-1' }, () => {});
  assert.equal((await push()).status, 'success');
  assert.deepEqual(guest.executions.at(-1)!.environmentNames, ['GH_TOKEN']);
  held.token = 'ghs_renewedTokenOfThisExecution';
  await push();
  held.token = undefined;
  await push();
  assert.deepEqual(seen.map(entry => [entry.token, entry.stdin]), [[builderToken, ''], ['ghs_renewedTokenOfThisExecution', ''], [undefined, '']]);
  assert.deepEqual(guest.executions.at(-1)!.environmentNames, []);

  // Sweep of the guest after use: no file, no program text (the argument vectors) and no log holds either token.
  const everything = [...guest.files.entries()].flat().concat(guest.executions.map(execution => execution.script), Object.values(guest.logs)).join('\n');
  for (const token of [builderToken, 'ghs_renewedTokenOfThisExecution']) assert.ok(!everything.includes(token));
  assert.deepEqual([...guest.files.keys()].filter(path => /credential|token|\.netrc|gitconfig|history/i.test(path)), []);

  // A reviewer never receives a credential, whatever the host held for the Execution.
  guests.world.programs.tool = (_guest, request) => { assert.deepEqual(request.environment, {}); return { exitCode: 4 }; };
  const reviewer = await invocation({ role: 'standards', credential: { current: () => builderToken } });
  assert.equal(await reviewer.read('/workspace/checkout/README.md'), 'READ_NOT_FOUND');
});

test('interrupting a Builder command closes its connection to the guest; a timeout answers "effects unknown" and revokes the invocation, as in the MVP', async t => {
  const { guests, invocation } = await activeBoot(t);
  const closed: string[] = [];
  let notify!: () => void;
  let waiting = new Promise<void>(resolve => { notify = resolve; });
  guests.world.commands['sleep 600'] = async (_guest, run) => {
    run.emit('started\n');
    await run.disconnected;
    closed.push(run.user);
    notify();
    return 0;
  };
  const interrupted = await invocation();
  const abort = new AbortController();
  assert.deepEqual(await interrupted.call({ name: 'bash', command: 'sleep 600' }, () => abort.abort(), abort.signal), { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
  await waiting;
  assert.deepEqual(closed, ['builder']);
  assert.deepEqual(guests.connections.filter(connection => connection.open), []);

  waiting = new Promise<void>(resolve => { notify = resolve; });
  const timed = await invocation();
  // The tool's own argument under test: a command that outlives its timeout.
  assert.deepEqual(await timed.call({ name: 'bash', command: 'sleep 600', timeout: 0.02 }, () => {}), { status: 'failure', code: 'BASH_TIMEOUT_EFFECTS_UNKNOWN' });
  await waiting;
  assert.deepEqual(guests.connections.filter(connection => connection.open), []);
  assert.deepEqual(await timed.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
});

test('the role of each call is the one the host bound: a reviewer has only read, and a context of another invocation, Work or boot is refused', async t => {
  const { sandbox, guest, environment, boot, startBoot, tools, records, root, invocation } = await activeBoot(t);
  const reviewer = await invocation({ role: 'standards', editSourceMaxBytes: 8192, copyOutput: true });
  const before = guest.executions.length;
  assert.deepEqual(await reviewer.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'BASH_ROLE_DENIED' });
  assert.deepEqual(await reviewer.call({ name: 'write', operation: 'create', path: '/workspace/checkout/x', content: 'x' }), { status: 'failure', code: 'WRITE_ROLE_DENIED' });
  assert.deepEqual(await reviewer.call({ name: 'edit-source', operation: 'capture', path: '/workspace/checkout/x' }), { status: 'failure', code: 'EDIT_SOURCE_DENIED' });

  // A worker that presents another context at the reviewer's endpoint (claiming to be a Builder) gets nothing.
  const claimed: ToolContext = { ...reviewer.context, invocationId: 'claimed-builder', role: 'builder' };
  const refused = await reviewer.client.executeTool(claimed, { name: 'bash', command: 'docker ps', callId: 'claimed-1' }, () => {});
  assert.equal(refused.status, 'failure', JSON.stringify(refused));
  assert.equal(guest.executions.length, before);

  // The host binds only invocations of THIS Work on THIS boot, once.
  const signal = new AbortController().signal;
  const bind = (change: Partial<ToolContext>) => tools.bind({ endpoint: join(root, `refused-${Object.keys(change).join('-')}`), context: { ...reviewer.context, invocationId: 'fresh', ...change }, signal, records });
  assert.deepEqual(await bind({ invocationId: reviewer.context.invocationId }), { status: 'refused', code: 'STALE_TOOL_CONTEXT' });
  assert.deepEqual(await bind({ bootRef: 'boot-00000000-0000-4000-8000-000000000000' }), { status: 'refused', code: 'STALE_TOOL_CONTEXT' });
  assert.deepEqual(await bind({ environmentRef: `env-${sha('0')}` }), { status: 'refused', code: 'STALE_TOOL_CONTEXT' });
  assert.deepEqual(await bind({ workId: 'another-work' }), { status: 'refused', code: 'STALE_TOOL_CONTEXT' });

  // A stopped boot serves no tools, and an invocation bound to it reaches nothing in the next boot of the same Work.
  assert.equal((await sandbox.stop({ environment, boot, reason: 'end' })).status, 'success');
  assert.deepEqual(await sandbox.serveTools({ environment, boot }), { status: 'unavailable', code: 'BOOT_NOT_ACTIVE' });
  const next = await startBoot();
  assert.equal(await reviewer.read('/workspace/checkout/README.md'), 'GUEST_READ_FAILED');
  const served = await sandbox.serveTools({ environment, boot: next });
  assert.equal(served.status, 'serving');
  if (served.status !== 'serving') return;
  t.after(() => served.tools.close());
  assert.deepEqual(await served.tools.bind({ endpoint: join(root, 'previous-boot'), context: { ...reviewer.context, invocationId: 'fresh' }, signal, records }), { status: 'refused', code: 'STALE_TOOL_CONTEXT' });
});

test('second layer: inside the guest, the reviewer user can neither write in the workspace nor talk to Docker, and its account has no group and no forwarding', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  const builder = await invocation();
  assert.equal((await builder.call({ name: 'write', operation: 'create', path: '/workspace/checkout/owned.txt', content: 'by the builder\n' })).status, 'success');
  await builder.call({ name: 'bash', command: 'docker ps' }, () => {});
  const [write, docker] = guest.executions.slice(-2);
  // The very programs that worked for the Builder, run by a process of the reviewer user: only the guest's own permissions decide.
  assert.equal((await guests.inside(guest.microvmId, 'reviewer', { program: 'tool', script: write!.script, stdin: Buffer.from('overwritten\n') })).exitCode, 1);
  assert.equal(guest.files.get('/workspace/checkout/owned.txt'), 'by the builder\n');
  const denied = await guests.inside(guest.microvmId, 'reviewer', { program: 'tool', script: docker!.script });
  assert.deepEqual([denied.exitCode, /permission denied/.test(denied.output)], [1, true]);
  assert.equal((await guests.inside(guest.microvmId, 'builder', { program: 'tool', script: docker!.script })).exitCode, 0);
  assert.deepEqual(guest.users, { builder: { login: true, docker: true }, reviewer: { login: true, docker: false } });
  assert.equal(guest.owner, 'builder');

  // What the image itself states about that account (the part of the second layer the adapter owns).
  const image = renderGuestImage({ schemaVersion: 1, apk: [], images: [] });
  assert.equal(image.ok, true);
  const text = (name: string) => image.ok ? image.files.find(file => file.name === name)!.content : '';
  assert.match(text('Dockerfile'), /^RUN adduser -D -s \/bin\/bash reviewer && sed -i 's\/\^reviewer:!\/reviewer:\*\/' \/etc\/shadow$/m);
  assert.doesNotMatch(text('Dockerfile'), /addgroup reviewer|chown[^\n]*reviewer|reviewer[^\n]*(wheel|sudo|docker)/);
  assert.match(text('sshd_config'), /\nMatch User reviewer\n {4}DisableForwarding yes\n {4}PermitTTY no\n$/);
  assert.match(text('sshd_config'), /^PermitRootLogin no$/m);
});

test('a call whose connection ends without an exit status is never reported as a result: effects are unknown', async t => {
  const { fake, guests, guest, invocation } = await activeBoot(t);
  guests.world.commands['mvn verify'] = (_guest, run) => { run.emit('building\n'); fake.kill(guest.microvmId); return 0; };
  const builder = await invocation();
  assert.deepEqual(await builder.call({ name: 'bash', command: 'mvn verify' }, () => {}), { status: 'failure', code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' });
  const writer = await invocation();
  assert.deepEqual(await writer.call({ name: 'write', operation: 'create', path: '/workspace/checkout/late.txt', content: 'x' }), { status: 'failure', code: 'WRITE_EFFECTS_UNCERTAIN' });
});

test('the channel prelude of a Builder command, run by a real bash: only the fixed environment and the credential, stderr merged, Git answered from memory', () => {
  const run = (command: string, environment: Record<string, string>) => {
    const argv = ['-c', channelPrelude, 'factory-builder', command, ...commitIdentityEnv(), `PATH=${guestPath}`];
    assert.ok(!argv.join('\n').includes(builderToken));
    return spawnSync('/bin/bash', argv, { env: environment, encoding: 'utf8', timeout: remainingMs() });
  };
  const ambient = { HOME: '/home/someone', STRAY: 'ambient', SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22', PATH: '/nowhere' };
  const withToken = run('env; echo to-stderr >&2; exit 7', { ...ambient, GH_TOKEN: builderToken });
  assert.deepEqual([withToken.status, withToken.stderr], [7, '']);
  const lines = withToken.stdout.split('\n');
  assert.ok(lines.includes('to-stderr'));
  const names = lines.filter(line => /^[A-Z_0-9]+=/.test(line)).map(line => line.slice(0, line.indexOf('='))).filter(name => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name)).sort();
  assert.deepEqual(names, ['GH_CONFIG_DIR', 'GH_HOST', 'GH_NO_UPDATE_NOTIFIER', 'GH_PROMPT_DISABLED', 'GH_TOKEN', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_NAME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT', 'PATH']);
  assert.ok(lines.includes(`GH_TOKEN=${builderToken}`) && lines.includes('GIT_AUTHOR_NAME=Software Factory Builder') && lines.includes(`PATH=${guestPath}`));
  // Git asks the in-memory helper and gets the token of this command's environment; nothing is configured in any file.
  const filled = run("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", { ...ambient, GH_TOKEN: builderToken });
  assert.match(filled.stdout, new RegExp(`^username=x-access-token$[\\s\\S]*^password=${builderToken}$`, 'm'));
  const without = run('env', ambient);
  assert.deepEqual(without.stdout.split('\n').filter(line => /^(GH_|GIT_CONFIG|GIT_TERMINAL|STRAY|HOME|SSH_)/.test(line)), []);
});

test('a Builder copies a command output into /artifacts and reads it; a reviewer reads that copy only when the host selected it', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  const output = 'Tests run: 12, Failures: 1\n'.repeat(40);
  guests.world.commands['mvn -q test'] = (_guest, run) => { run.emit(output); return 1; };
  const builder = await invocation({ copyOutput: true });
  const ran = await builder.call({ name: 'bash', command: 'mvn -q test' }, () => {});
  assert.equal(ran.status, 'success', JSON.stringify(ran));
  if (ran.status !== 'success') return;
  const copied = await builder.call({ name: 'bash', operation: 'copy-output', reference: ran.reference }, () => {});
  assert.equal(copied.status, 'success', JSON.stringify(copied));
  const receipt = JSON.parse(Buffer.from(copied.status === 'success' ? copied.data : '', 'base64').toString()) as { path: string; bytes: number };
  assert.match(receipt.path, /^\/artifacts\/factory-output-[0-9a-f-]{36}\.txt$/);
  assert.equal(guest.files.get(receipt.path), output);
  assert.equal(await builder.read(receipt.path), output);
  assert.equal(await (await invocation({ role: 'standards', selectedOutputCopies: [receipt.path] })).read(receipt.path), output);
  assert.equal(await (await invocation({ role: 'spec' })).read(receipt.path), 'READ_PATH_DENIED');
});
