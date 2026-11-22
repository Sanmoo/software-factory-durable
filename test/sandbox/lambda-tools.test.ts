import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { createSandbox, type BootRef, type EnvironmentRef, type ReadResult, type ToolCall, type ToolContext } from '../../src/sandbox/index.js';
import { accountClock, lambdaAccountFake } from './lambda-service-fake.js';
import { lambdaGuestFake } from './lambda-guest-fake.js';
import { renderGuestImage } from '../../src/sandbox/lambda/guest-image.js';
import { readLambdaChannelLog } from '../../src/sandbox/lambda/boot.js';
import { channelPrelude, commitIdentityEnv, guestPath } from '../../src/sandbox/bash-tools.js';
import { spawnSync } from 'node:child_process';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 05 (V2-02 Executar ferramenta, V2-20, V2-23, V2-24, V2-26): the role tools of the MVP over a Lambda boot, through the same
// owner transport and tool programs, with an in-process guest behind the channel. No AWS call, no ssh, no VM.
const configuration = { adapter: 'lambda', schemaVersion: 1, awsProfile: 'factory', installation: 'acme' };
const sha = (letter: string) => letter.repeat(64);
const pinned = {
  path: '.factory/environment.yaml',
  commit: 'c'.repeat(40),
  sha256: sha('d'),
  repository: 'acme/shop',
  repositoryId: 42,
  declaration: { schemaVersion: 1 as const, apk: [], images: [] },
};
const workId = '0b0f6a52-6f5c-4d0e-9a53-0d6f3f7c1a01';
const remote = 'https://github.com/acme/shop.git';
const startingCommit = '1'.repeat(40);
const builderToken = 'ghs_builderTokenOfThisExecution';

type Bind = Partial<{
  role: ToolContext['role'];
  invocationId: string;
  credential: { current(): string | undefined };
  editSourceMaxBytes: number;
  copyOutput: boolean;
  selectedOutputCopies: string[];
  records: Awaited<ReturnType<typeof createRecords>>;
}>;

async function activeBoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lambda-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = lambdaAccountFake();
  const guests = lambdaGuestFake(fake);
  guests.world.origins[remote] = { commits: [startingCommit], token: builderToken };
  const clock = accountClock(fake);
  const sandbox = createSandbox({
    root,
    lambdaService: fake.service,
    lambdaTransport: guests.transport,
    lambdaBootClock: clock,
    lambdaImageWait: { intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep },
  });
  const prepared = await sandbox.prepare({ workId, configuration, environment: pinned });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared));
  const environment = (prepared as { environment: EnvironmentRef }).environment;
  const boot = async () => {
    const started = await sandbox.start({
      environment,
      configuration,
      checkout: { repository: 'acme/shop', commit: startingCommit, branch: 'factory/work-1', credential: { token: builderToken } },
    });
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
    const bound = await tools.bind({ endpoint: join(root, `t${(sockets += 1)}`), context, signal: authority.signal, records, ...policy });
    assert.equal(bound.status, 'bound', JSON.stringify(bound));
    const client = createSandbox({ root, toolEndpoint: (bound as { endpoint: string }).endpoint });
    let calls = 0;
    const call = (input: Record<string, unknown>, onData?: (data: Buffer) => void, signal?: AbortSignal): Promise<ReadResult> =>
      client.executeTool(context, { callId: `call-${(calls += 1)}`, ...input } as ToolCall, onData, signal);
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
  assert.deepEqual(
    { program: ran.program, user: ran.user, environmentNames: ran.environmentNames },
    { program: 'tool', user: 'reviewer', environmentNames: [] },
  );
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
  const page = await builder.call({
    name: 'edit-source',
    operation: 'page',
    path: notes,
    reference: version.reference,
    sourceVersion: version.sourceVersion,
    offset: 0,
  });
  assert.equal(page.status === 'success' && Buffer.from(page.data, 'base64').toString(), 'first\n');
  assert.equal(
    (
      await builder.call({
        name: 'edit-source',
        operation: 'commit',
        path: notes,
        reference: version.reference,
        sourceVersion: version.sourceVersion,
        replacement: 'second\n',
      })
    ).status,
    'success',
  );
  assert.equal(guest.files.get(notes), 'second\n');

  // The file changed in the guest after its source was captured: the edit is not applied, with the MVP's code.
  const stale = (await builder.call({ name: 'edit-source', operation: 'capture', path: notes })) as Extract<ReadResult, { format: 'text' }>;
  guest.files.set(notes, 'changed behind the edit\n');
  assert.deepEqual(
    await builder.call({
      name: 'edit-source',
      operation: 'commit',
      path: notes,
      reference: stale.reference,
      sourceVersion: stale.sourceVersion,
      replacement: 'third\n',
    }),
    { status: 'failure', code: 'EDIT_SOURCE_CHANGED' },
  );
  assert.equal(guest.files.get(notes), 'changed behind the edit\n');

  assert.deepEqual(await builder.call({ name: 'write', operation: 'create', path: '/etc/passwd', content: 'x' }), {
    status: 'failure',
    code: 'WRITE_PATH_DENIED',
  });
  // As in the MVP, the Builder's `read` is for its output copies and skill pack; it reads the checkout with Bash.
  assert.equal(await builder.read(notes), 'READ_PATH_DENIED');
  assert.ok(guest.executions.filter(execution => execution.program === 'tool').every(execution => execution.user === 'builder'));

  const reviewer = await invocation({ role: 'spec' });
  assert.equal(await reviewer.read(notes), 'changed behind the edit\n');
});

test('Builder Bash runs in the guest with progress while the command still runs, the fixed command environment and its exit status', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
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
  const result = await builder.call({ name: 'bash', command: 'make test' }, data => {
    progress.push(data.toString());
    release();
  });
  // The first output reached the worker BEFORE the command ended: the command only ends after that delivery released it.
  assert.deepEqual(progress, ['compiling\n', '2 tests failed\n']);
  assert.deepEqual(
    {
      status: result.status,
      exitCode: result.status === 'success' && 'exitCode' in result && result.exitCode,
      bytes: result.status === 'success' && result.bytes,
    },
    { status: 'success', exitCode: 2, bytes: 25 },
  );
  assert.deepEqual(seen, {
    GIT_AUTHOR_NAME: 'Software Factory Builder',
    GIT_AUTHOR_EMAIL: 'software-factory-builder@users.noreply.invalid',
    GIT_COMMITTER_NAME: 'Software Factory Builder',
    GIT_COMMITTER_EMAIL: 'software-factory-builder@users.noreply.invalid',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  });
  const ran = guest.executions.at(-1)!;
  assert.deepEqual({ user: ran.user, environmentNames: ran.environmentNames }, { user: 'builder', environmentNames: [] });
  assert.match(ran.script, /^echo \$\$ > '\/tmp\/factory-call-[0-9a-f-]{36}' && cd '\/workspace' && exec /);
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
  assert.deepEqual(
    seen.map(entry => [entry.token, entry.stdin]),
    [
      [builderToken, ''],
      ['ghs_renewedTokenOfThisExecution', ''],
      [undefined, ''],
    ],
  );
  assert.deepEqual(guest.executions.at(-1)!.environmentNames, []);

  // Sweep of the guest after use: no file, no program text (the argument vectors) and no log holds either token.
  const everything = [...guest.files.entries()]
    .flat()
    .concat(
      guest.executions.map(execution => execution.script),
      Object.values(guest.logs),
    )
    .join('\n');
  for (const token of [builderToken, 'ghs_renewedTokenOfThisExecution']) assert.ok(!everything.includes(token));
  assert.deepEqual(
    [...guest.files.keys()].filter(path => /credential|token|\.netrc|gitconfig|history/i.test(path)),
    [],
  );

  // A reviewer never receives a credential, whatever the host held for the Execution.
  guests.world.programs.tool = (_guest, request) => {
    assert.deepEqual(request.environment, {});
    return { exitCode: 4 };
  };
  const reviewer = await invocation({ role: 'standards', credential: { current: () => builderToken } });
  assert.equal(await reviewer.read('/workspace/checkout/README.md'), 'READ_NOT_FOUND');
});

test('interrupting a Builder command closes its connection to the guest; a timeout answers "effects unknown" and revokes the invocation, as in the MVP', async t => {
  const { guests, invocation } = await activeBoot(t);
  const closed: string[] = [];
  let notify!: () => void;
  let waiting = new Promise<void>(resolve => {
    notify = resolve;
  });
  guests.world.commands['sleep 600'] = async (_guest, run) => {
    run.emit('started\n');
    await run.disconnected;
    closed.push(run.user);
    notify();
    return 0;
  };
  const interrupted = await invocation();
  const abort = new AbortController();
  assert.deepEqual(await interrupted.call({ name: 'bash', command: 'sleep 600' }, () => abort.abort(), abort.signal), {
    status: 'failure',
    code: 'TOOL_CHANNEL_CLOSED',
  });
  await waiting;
  assert.deepEqual(closed, ['builder']);
  assert.deepEqual(
    guests.connections.filter(connection => connection.open),
    [],
  );

  waiting = new Promise<void>(resolve => {
    notify = resolve;
  });
  const timed = await invocation();
  // The tool's own argument under test: a command that outlives its timeout.
  assert.deepEqual(await timed.call({ name: 'bash', command: 'sleep 600', timeout: 0.02 }, () => {}), {
    status: 'failure',
    code: 'BASH_TIMEOUT_EFFECTS_UNKNOWN',
  });
  await waiting;
  assert.deepEqual(
    guests.connections.filter(connection => connection.open),
    [],
  );
  assert.deepEqual(await timed.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
});

test('the role of each call is the one the host bound: a reviewer has only read, and a context of another invocation, Work or boot is refused', async t => {
  const { sandbox, guest, environment, boot, startBoot, tools, records, root, invocation } = await activeBoot(t);
  const reviewer = await invocation({ role: 'standards', editSourceMaxBytes: 8192, copyOutput: true });
  const before = guest.executions.length;
  assert.deepEqual(await reviewer.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'BASH_ROLE_DENIED' });
  assert.deepEqual(await reviewer.call({ name: 'write', operation: 'create', path: '/workspace/checkout/x', content: 'x' }), {
    status: 'failure',
    code: 'WRITE_ROLE_DENIED',
  });
  assert.deepEqual(await reviewer.call({ name: 'edit-source', operation: 'capture', path: '/workspace/checkout/x' }), {
    status: 'failure',
    code: 'EDIT_SOURCE_DENIED',
  });

  // A worker that presents another context at the reviewer's endpoint (claiming to be a Builder) gets nothing.
  const claimed: ToolContext = { ...reviewer.context, invocationId: 'claimed-builder', role: 'builder' };
  const refused = await reviewer.client.executeTool(claimed, { name: 'bash', command: 'docker ps', callId: 'claimed-1' }, () => {});
  assert.equal(refused.status, 'failure', JSON.stringify(refused));
  assert.equal(guest.executions.length, before);

  // The host binds only invocations of THIS Work on THIS boot, once.
  const signal = new AbortController().signal;
  const bind = (change: Partial<ToolContext>) =>
    tools.bind({
      endpoint: join(root, `refused-${Object.keys(change).join('-')}`),
      context: { ...reviewer.context, invocationId: 'fresh', ...change },
      signal,
      records,
    });
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
  assert.deepEqual(
    await served.tools.bind({ endpoint: join(root, 'previous-boot'), context: { ...reviewer.context, invocationId: 'fresh' }, signal, records }),
    { status: 'refused', code: 'STALE_TOOL_CONTEXT' },
  );
});

test('second layer: inside the guest, the reviewer user can neither write in the workspace nor talk to Docker, and its account has no group and no forwarding', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  const builder = await invocation();
  assert.equal(
    (await builder.call({ name: 'write', operation: 'create', path: '/workspace/checkout/owned.txt', content: 'by the builder\n' })).status,
    'success',
  );
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
  const text = (name: string) => (image.ok ? image.files.find(file => file.name === name)!.content : '');
  assert.match(text('Dockerfile'), /^RUN adduser -D -s \/bin\/bash reviewer && sed -i 's\/\^reviewer:!\/reviewer:\*\/' \/etc\/shadow$/m);
  assert.doesNotMatch(text('Dockerfile'), /addgroup reviewer|chown[^\n]*reviewer|reviewer[^\n]*(wheel|sudo|docker)/);
  assert.match(text('sshd_config'), /\nMatch User reviewer\n {4}DisableForwarding yes\n {4}PermitTTY no\n$/);
  assert.match(text('sshd_config'), /^PermitRootLogin no$/m);
});

test('a call whose connection ends because the environment died is never reported as a result: it answers "environment ended" and the boot serves nothing more', async t => {
  const { fake, guests, guest, sandbox, environment, boot, invocation } = await activeBoot(t);
  guests.world.commands['mvn verify'] = (_guest, run) => {
    run.emit('building\n');
    fake.kill(guest.microvmId);
    return 0;
  };
  const builder = await invocation();
  const writer = await invocation();
  // v2 tickets 11 and 10: the dropped call asks the service, which says the environment ended. Nothing is reconnected, no orphan is
  // looked for, the started call is an uncertain effect, the boot is recorded as lost and every later call is denied (V2-15).
  assert.deepEqual(await builder.call({ name: 'bash', command: 'mvn verify' }, () => {}), { status: 'failure', code: 'SANDBOX_ENVIRONMENT_ENDED' });
  assert.deepEqual(await writer.call({ name: 'write', operation: 'create', path: '/workspace/checkout/late.txt', content: 'x' }), {
    status: 'failure',
    code: 'SANDBOX_ENVIRONMENT_ENDED',
  });
  assert.deepEqual(
    guest.executions.filter(execution => execution.program === 'end-call'),
    [],
  );
  assert.deepEqual(await builder.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'SANDBOX_ENVIRONMENT_ENDED' });
  assert.equal((await sandbox.bootRecord({ environment, boot }))?.end?.reason, 'loss');
  const report = await sandbox.channelReport({ environment, boot });
  assert.deepEqual(
    report.indeterminateEffects.map(effect => [effect.tool, effect.description, effect.outcome]),
    [['bash', 'mvn verify', 'environment-ended']],
  );
  assert.equal(report.unrecoverable, null);
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
  const names = lines
    .filter(line => /^[A-Z_0-9]+=/.test(line))
    .map(line => line.slice(0, line.indexOf('=')))
    .filter(name => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name))
    .sort();
  assert.deepEqual(names, [
    'GH_CONFIG_DIR',
    'GH_HOST',
    'GH_NO_UPDATE_NOTIFIER',
    'GH_PROMPT_DISABLED',
    'GH_TOKEN',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_TERMINAL_PROMPT',
    'PATH',
  ]);
  assert.ok(lines.includes(`GH_TOKEN=${builderToken}`) && lines.includes('GIT_AUTHOR_NAME=Software Factory Builder') && lines.includes(`PATH=${guestPath}`));
  // Git asks the in-memory helper and gets the token of this command's environment; nothing is configured in any file.
  const filled = run("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", { ...ambient, GH_TOKEN: builderToken });
  assert.match(filled.stdout, new RegExp(`^username=x-access-token$[\\s\\S]*^password=${builderToken}$`, 'm'));
  const without = run('env', ambient);
  assert.deepEqual(
    without.stdout.split('\n').filter(line => /^(GH_|GIT_CONFIG|GIT_TERMINAL|STRAY|HOME|SSH_)/.test(line)),
    [],
  );
});

test('a Builder copies a command output into /artifacts and reads it; a reviewer reads that copy only when the host selected it', async t => {
  const { guests, guest, invocation } = await activeBoot(t);
  const output = 'Tests run: 12, Failures: 1\n'.repeat(40);
  guests.world.commands['mvn -q test'] = (_guest, run) => {
    run.emit(output);
    return 1;
  };
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

// ---- v2 ticket 11 (V2-21, V2-22): the channel drops while the environment lives ----

test('a channel drop with the MicroVM alive: the adapter reconnects with the boot\'s own credentials, ends the orphan and answers "indeterminate"; the invocation goes on', async t => {
  const { root, fake, guests, guest, sandbox, environment, boot, invocation } = await activeBoot(t);
  const after: string[] = [];
  guests.world.commands['mvn deploy'] = async (_guest, run) => {
    run.emit('uploading\n');
    guests.drop();
    // T4: a closed connection does not end the process. It goes on until someone kills its group.
    await run.killed;
    after.push('killed');
    run.emit('uploaded\n');
    return 0;
  };
  const builder = await invocation();
  const progress: string[] = [];
  const result = await builder.call({ name: 'bash', command: 'mvn deploy' }, data => {
    progress.push(data.toString());
  });
  // Never "not executed", never a result: the effect may have happened.
  assert.deepEqual(result, { status: 'failure', code: 'BASH_RESULT_INDETERMINATE' });
  assert.deepEqual(
    guest.processes.map(process => [process.user, process.state]),
    [['builder', 'killed']],
  );
  assert.deepEqual(after, ['killed']);
  // No reattachment: nothing the orphan wrote after the drop reaches the session.
  assert.deepEqual(progress, ['uploading\n']);
  // The reconnection is a new connection of the same boot: same session key, same pinned host key, same Unix user.
  const [call, end] = guests.connections.slice(-2);
  assert.deepEqual([call!.program, end!.program], ['tool', 'end-call']);
  assert.deepEqual([end!.user, end!.identityFile, end!.hostKey, end!.microvmId], [call!.user, call!.identityFile, call!.hostKey, call!.microvmId]);
  assert.equal(end!.hostKey, guest.hostKey);
  // The boot's record says what the one attempt met and how the end of the orphan answered.
  const steps = (await readLambdaChannelLog(root, environment, boot)).filter(entry => entry.kind === 'recovery');
  assert.deepEqual(
    steps.map(({ at: _at, call: _call, ...step }) => step),
    [{ kind: 'recovery', cause: 'drop', attempt: 1, condition: 'active', action: 'end-call', status: 'exited', exitCode: 0, outcome: 'call-ended' }],
  );
  assert.match(steps[0]!.call, /^[0-9a-f-]{36}$/);
  // The boot was not ended and the same invocation runs its next command.
  assert.equal((await sandbox.observe({ environment, boot })).condition, 'active');
  assert.equal(fake.account.microvms.at(-1)!.state, 'RUNNING');
  const next = await builder.call({ name: 'bash', command: 'docker ps' }, () => {});
  assert.equal(next.status === 'success' && 'exitCode' in next && next.exitCode, 0, JSON.stringify(next));
});

test('the uncertain effect of a dropped call is on the host before the call answers; a write and an edit dropped mid-way are indeterminate too', async t => {
  const { guests, guest, sandbox, environment, boot, invocation } = await activeBoot(t);
  guests.world.commands['terraform apply'] = async (_guest, run) => {
    guests.drop();
    await run.killed;
    return 0;
  };
  const builder = await invocation({ editSourceMaxBytes: 8192 });
  assert.deepEqual(await sandbox.channelReport({ environment, boot }), { indeterminateEffects: [], unrecoverable: null });
  await builder.call({ name: 'bash', command: 'terraform apply' }, () => {});
  const notes = '/workspace/checkout/notes.md';
  assert.equal((await builder.call({ name: 'write', operation: 'create', path: notes, content: 'first\n' })).status, 'success');
  const source = (await builder.call({ name: 'edit-source', operation: 'capture', path: notes })) as Extract<ReadResult, { format: 'text' }>;
  // From here on every mutation program loses its connection after it started; whether it wrote is unknown to the host.
  const real = guests.world.programs.tool;
  guests.world.programs.tool = async (_guest, _request, run) => {
    guests.drop();
    await run.killed;
    return { exitCode: 0 };
  };
  assert.deepEqual(await builder.call({ name: 'write', operation: 'create', path: '/workspace/checkout/late.txt', content: 'x' }), {
    status: 'failure',
    code: 'WRITE_RESULT_INDETERMINATE',
  });
  assert.deepEqual(
    await builder.call({
      name: 'edit-source',
      operation: 'commit',
      path: notes,
      reference: source.reference,
      sourceVersion: source.sourceVersion,
      replacement: 'second\n',
    }),
    { status: 'failure', code: 'EDIT_SOURCE_RESULT_INDETERMINATE' },
  );
  if (real) guests.world.programs.tool = real;
  else delete guests.world.programs.tool;
  assert.deepEqual(
    guest.processes.map(process => process.state),
    ['killed', 'exited', 'exited', 'killed', 'killed'],
  );
  const report = await sandbox.channelReport({ environment, boot });
  assert.deepEqual(
    report.indeterminateEffects.map(effect => [effect.tool, effect.description, effect.outcome, effect.invocationId, effect.executionId, effect.role]),
    [
      ['bash', 'terraform apply', 'orphan-ended', builder.context.invocationId, 'execution-1', 'builder'],
      ['write', 'create /workspace/checkout/late.txt', 'orphan-ended', builder.context.invocationId, 'execution-1', 'builder'],
      ['edit-source', 'commit /workspace/checkout/notes.md', 'orphan-ended', builder.context.invocationId, 'execution-1', 'builder'],
    ],
  );
  assert.ok(report.indeterminateEffects.every(effect => !Number.isNaN(Date.parse(effect.at)) && effect.callId.length > 0));
  // The invocation survived the three of them.
  assert.equal((await builder.call({ name: 'write', operation: 'create', path: '/workspace/checkout/after.txt', content: 'y' })).status, 'success');
  // A reviewer's read has no effect to be uncertain about: it fails as a read and nothing is recorded.
  guests.world.programs.tool = async (_guest, _request, run) => {
    guests.drop();
    await run.killed;
    return { exitCode: 0 };
  };
  const reviewer = await invocation({ role: 'standards' });
  assert.equal(await reviewer.read(notes), 'GUEST_READ_FAILED');
  assert.equal((await sandbox.channelReport({ environment, boot })).indeterminateEffects.length, 3);
  assert.equal(guest.processes.at(-1)!.state, 'killed');
});

test('reconnection that keeps failing with the MicroVM alive stops at its limit: the call is not a result, the boot serves no more calls and nothing loops', async t => {
  const { fake, guests, guest, sandbox, environment, boot, tools, records, root, invocation } = await activeBoot(t);
  guests.world.commands['make release'] = async (_guest, run) => {
    guests.world.channelDown = true;
    guests.drop();
    await run.killed;
    return 0;
  };
  const builder = await invocation();
  const other = await invocation();
  const reads = () => fake.calls.filter(call => call.operation === 'microvm').length;
  const before = { reads: reads(), now: fake.account.clock.now, connections: guests.connections.length };
  assert.deepEqual(await builder.call({ name: 'bash', command: 'make release' }, () => {}), { status: 'failure', code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' });
  // Five consultations of the service, five refused connections, four waits on the boot's clock: then it stops.
  assert.equal(reads() - before.reads, 5);
  assert.equal(fake.account.clock.now - before.now, 4 * 5000);
  assert.equal(fake.account.microvms.at(-1)!.state, 'RUNNING');
  // The orphan could not be reached: it is still running, and the record says so.
  assert.deepEqual(
    guest.processes.map(process => process.state),
    ['running'],
  );
  const report = await sandbox.channelReport({ environment, boot });
  assert.deepEqual(
    report.indeterminateEffects.map(effect => [effect.description, effect.outcome]),
    [['make release', 'channel-unrecoverable']],
  );
  assert.equal(report.unrecoverable?.attempts, 5);
  // Each of the five attempts is in the boot's record, before the limit: the service said the environment lived, the connection was refused.
  const log = await readLambdaChannelLog(root, environment, boot);
  assert.deepEqual(
    log.map(entry => entry.kind),
    ['recovery', 'recovery', 'recovery', 'recovery', 'recovery', 'unrecoverable', 'effect'],
  );
  assert.deepEqual(
    log.flatMap(entry => (entry.kind === 'recovery' ? [[entry.cause, entry.attempt, entry.condition, entry.action, entry.status, entry.code]] : [])),
    [1, 2, 3, 4, 5].map(attempt => ['drop', attempt, 'active', 'end-call', 'refused', 'UNREACHABLE']),
  );
  // The channel came back too late: this boot serves nothing more, and no further call consults the service or waits.
  guests.world.channelDown = false;
  const settled = { reads: reads(), now: fake.account.clock.now };
  assert.deepEqual(await builder.call({ name: 'bash', command: 'docker ps' }, () => {}), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.deepEqual(
    await tools.bind({ endpoint: join(root, 'late'), context: { ...builder.context, invocationId: 'late' }, signal: new AbortController().signal, records }),
    { status: 'refused', code: 'CHANNEL_UNRECOVERABLE' },
  );
  guests.world.channelDown = true;
  assert.equal((await other.call({ name: 'bash', command: 'docker ps' }, () => {})).status, 'failure');
  assert.deepEqual([reads(), fake.account.clock.now], [settled.reads, settled.now]);
  // A later owner of the same boot (another process) starts from the same record.
  const again = await sandbox.serveTools({ environment, boot });
  assert.equal(again.status, 'serving');
  if (again.status !== 'serving') return;
  t.after(() => again.tools.close());
  assert.deepEqual(
    await again.tools.bind({
      endpoint: join(root, 'later'),
      context: { ...builder.context, invocationId: 'later' },
      signal: new AbortController().signal,
      records,
    }),
    { status: 'refused', code: 'CHANNEL_UNRECOVERABLE' },
  );
});

test("an orphan the guest still reports alive is asked to end again; every attempt and its answer are in the boot's record, and nothing of a tool's output is", async t => {
  const { root, guests, guest, sandbox, environment, boot, invocation } = await activeBoot(t);
  const secret = 'ghs_outputOfTheCommandItself';
  guests.world.commands['make publish'] = async (_guest, run) => {
    run.emit(`${secret}\n`);
    guests.drop();
    await run.killed;
    return 0;
  };
  // The guest answers twice that the group still runs (exit 5); the third time its own program ends it.
  let asked = 0;
  guests.world.programs['end-call'] = () => {
    if ((asked += 1) === 2) delete guests.world.programs['end-call'];
    return { exitCode: 5, stdout: `call-alive\n${secret}\n` };
  };
  const builder = await invocation();
  assert.deepEqual(await builder.call({ name: 'bash', command: 'make publish' }, () => {}), { status: 'failure', code: 'BASH_RESULT_INDETERMINATE' });
  assert.deepEqual(
    guest.processes.map(process => process.state),
    ['killed'],
  );
  const log = await readLambdaChannelLog(root, environment, boot);
  assert.deepEqual(
    log.flatMap(entry => (entry.kind === 'recovery' ? [[entry.attempt, entry.condition, entry.action, entry.status, entry.exitCode, entry.outcome]] : [])),
    [
      [1, 'active', 'end-call', 'exited', 5, 'call-alive'],
      [2, 'active', 'end-call', 'exited', 5, 'call-alive'],
      [3, 'active', 'end-call', 'exited', 0, 'call-ended'],
    ],
  );
  assert.ok(!JSON.stringify(log).includes(secret));
  // The report Control reads is unchanged by the diagnostics: one uncertain effect, no limit reached.
  const report = await sandbox.channelReport({ environment, boot });
  assert.deepEqual([report.indeterminateEffects.map(effect => effect.outcome), report.unrecoverable], [['orphan-ended'], null]);
});

test('a reconnection accepts only the host key pinned at the boot; a call that never reached the guest is run once the channel is back', async t => {
  const { root, guests, guest, sandbox, environment, boot, invocation } = await activeBoot(t);
  // The connection cannot be opened for a while with the MicroVM alive: nothing ran, so the call is simply made again.
  const builder = await invocation();
  guests.world.channelDown = true;
  let consulted = 0;
  const pinned = guest.hostKey;
  const read = guests.transport.exec.bind(guests.transport);
  guests.transport.exec = async (target, request, options) => {
    const result = await read(target, request, options);
    if (result.status === 'refused' && (consulted += 1) === 2) guests.world.channelDown = false;
    return result;
  };
  const listed = await builder.call({ name: 'bash', command: 'docker ps' }, () => {});
  assert.equal(listed.status === 'success' && 'exitCode' in listed && listed.exitCode, 0, JSON.stringify(listed));
  assert.equal(consulted, 2);
  // A call that never started is run again, and the record says how each rerun ended (never what it printed).
  assert.deepEqual(
    (await readLambdaChannelLog(root, environment, boot)).flatMap(entry =>
      entry.kind === 'recovery' ? [[entry.attempt, entry.action, entry.status, entry.code, entry.exitCode, entry.outcome]] : [],
    ),
    [
      [1, 'rerun', 'refused', 'UNREACHABLE', undefined, undefined],
      [2, 'rerun', 'exited', undefined, 0, undefined],
    ],
  );
  assert.deepEqual((await sandbox.channelReport({ environment, boot })).indeterminateEffects, []);

  // After a drop, something else answers at the endpoint with another host key: the adapter never talks to it.
  guests.world.commands['make deploy'] = async (_guest, run) => {
    guest.hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAnotTheGuestThatWasPinnedAtBoot000000000000';
    guests.drop();
    await run.killed;
    return 0;
  };
  assert.deepEqual(await builder.call({ name: 'bash', command: 'make deploy' }, () => {}), { status: 'failure', code: 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' });
  assert.deepEqual(
    guest.executions.filter(execution => execution.program === 'end-call'),
    [],
  );
  assert.deepEqual(
    guest.processes.map(process => process.state),
    ['exited', 'running'],
  );
  assert.ok(guests.connections.every(connection => connection.hostKey === pinned));
  assert.equal((await sandbox.channelReport({ environment, boot })).unrecoverable?.attempts, 5);
});

test("MVP §12.2: the command text of an uncertain effect passes the Records secret filter before it reaches the boot's host record; a write names its path only", async t => {
  const { guests, sandbox, environment, boot, records, invocation } = await activeBoot(t);
  const secret = 'ghs_' + 'synthetic0123456789abcdefSECRET';
  records.registerSecret(secret);
  const command = `curl -H "Authorization: Bearer ${secret}" https://deploy.example/release`;
  guests.world.commands[command] = async (_guest, run) => {
    guests.drop();
    await run.killed;
    return 0;
  };
  const builder = await invocation({});
  await builder.call({ name: 'bash', command }, () => {});
  const [effect] = (await sandbox.channelReport({ environment, boot })).indeterminateEffects;
  assert.equal(effect!.description, 'curl -H "Authorization: Bearer █" https://deploy.example/release');
  // A filter that fails never releases the raw text by another path: the record says the text was withheld.
  const failing = await invocation({
    records: {
      ...records,
      filterText() {
        throw new Error('filter');
      },
    } as typeof records,
  });
  await failing.call({ name: 'bash', command }, () => {});
  assert.deepEqual((await sandbox.channelReport({ environment, boot })).indeterminateEffects.map(item => item.description).slice(1), [
    '(text withheld: the secret filter could not be applied)',
  ]);
});
