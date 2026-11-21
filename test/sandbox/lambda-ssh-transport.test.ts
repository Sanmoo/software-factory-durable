import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshTransport, sessionPublicKey, type GuestTarget, type SshRunner } from '../../src/sandbox/index.js';
import { bootReady, bootReadyProgram, clonedHead, cloneProgram } from '../../src/sandbox/lambda/guest-programs.js';
import { remoteCommand, sshArguments } from '../../src/sandbox/lambda/ssh-transport.js';
import { generateSessionKey } from '../../src/sandbox/lambda/transport.js';
import { remainingMs } from '../runner/budget.js';

// v2 ticket 04 (V2-20, V2-24): the production transport and the fixed guest programs, without a guest. `ssh` and `websocat` are never
// run: the transport gets a scripted runner. Local `bash`, `git` and `ssh-keygen` processes check the texts the host would send.
const target: GuestTarget = { endpoint: 'microvm-0001.lambda-microvm.us-east-1.on.aws', port: 8022, token: 'secret-proxy-token', user: 'builder',
  identityFile: '/var/lib/factory/lambda/works/env-x/boots/boot-y/session_ed25519', keepaliveSeconds: 15 };
const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILn928sK0SwvZiCB5HrFZBSZtuz9a5W/Mcm9n6o0+mhm';
const local = (command: string, argv: string[], options: { input?: Uint8Array; env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  spawnSync(command, argv, { encoding: 'utf8', timeout: remainingMs(), ...options });

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-lambda-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a session key is an ed25519 pair: the public line for the run hook payload and a private key the ssh client reads', async t => {
  const first = generateSessionKey(), second = generateSessionKey();
  assert.match(first.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]$/);
  assert.notEqual(first.publicKey, second.publicKey);
  assert.equal(sessionPublicKey(first.privateKey), first.publicKey);
  assert.equal(sessionPublicKey('not a key'), null);
  // The OpenSSH tooling itself derives the same public key from the file the host writes.
  const directory = await scratch(t);
  await writeFile(join(directory, 'identity'), first.privateKey, { mode: 0o600 });
  const derived = local('ssh-keygen', ['-y', '-f', join(directory, 'identity')]);
  // Never a silent skip: the OpenSSH client tools are a prerequisite of the adapter's host (docs/lambda-installation.md, section 6), so a
  // host without them fails here by name instead of reporting a test that proved nothing.
  assert.equal(derived.error, undefined, `ssh-keygen (OpenSSH client tools) is required on the host that runs this suite: ${derived.error?.message}`);
  assert.equal(derived.stdout.trim().split(' ').slice(0, 2).join(' '), first.publicKey);
});

test('the remote command line carries the script and no environment value: the environment arrives on stdin and the program reads the rest', () => {
  const request = { program: 'probe', script: 'printf "%s|%s|" "$FACTORY_GIT_TOKEN" "$PLAIN"; cat', environment: { FACTORY_GIT_TOKEN: 'ghs_secret value\'"$(id)', PLAIN: 'a=b' },
    stdin: Buffer.from('the program input\n') };
  const remote = remoteCommand(request)!;
  assert.doesNotMatch(remote.command, /ghs_secret/);
  // What the guest's sshd does with the command line: hand it to the login shell.
  const ran = local('bash', ['-c', remote.command], { input: remote.stdin, env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'ghs_secret value\'"$(id)|a=b|the program input\n');
  const bare = remoteCommand({ program: 'probe', script: 'echo "[${FACTORY_GIT_TOKEN-unset}]"; exit 7' })!;
  const exit = local('bash', ['-c', bare.command], { input: bare.stdin, env: { PATH: process.env.PATH } });
  assert.deepEqual([exit.status, exit.stdout], [7, '[unset]\n']);
  assert.equal(remoteCommand({ program: 'probe', script: 'true', environment: { 'BAD NAME': 'x' } }), null);
  assert.equal(remoteCommand({ program: 'probe', script: 'true', environment: { NAME: 'a\0b' } }), null);
});

test('every ssh connection goes through websocat to the ingress endpoint with keepalive, the session key only and the token out of the argument list', () => {
  const argv = sshArguments(target, '/tmp/known', 'pinned', 'true')!;
  const options = argv.flatMap((value, index) => argv[index - 1] === '-o' ? [value] : []);
  assert.deepEqual(argv.slice(0, 3), ['-F', 'none', '-T']);
  assert.deepEqual(argv.slice(-3), ['builder@factory-microvm', '--', 'true']);
  for (const option of ['BatchMode=yes', 'IdentitiesOnly=yes', `IdentityFile=${target.identityFile}`, 'IdentityAgent=none', 'StrictHostKeyChecking=yes',
    'UserKnownHostsFile=/tmp/known', 'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=factory-microvm', 'ServerAliveInterval=15', 'ForwardAgent=no']) assert.ok(options.includes(option), option);
  assert.ok(options.includes(`ProxyCommand='websocat' --binary "--header=X-aws-proxy-auth: $FACTORY_MICROVM_TOKEN" "--header=X-aws-proxy-port: 8022" - 'wss://microvm-0001.lambda-microvm.us-east-1.on.aws/'`));
  assert.doesNotMatch(argv.join(' '), /secret-proxy-token/);
  // Only the first contact of a boot records the key it sees; every other connection accepts the pinned key alone.
  assert.ok(sshArguments(target, '/tmp/known', 'first-contact', 'true')!.includes('StrictHostKeyChecking=accept-new'));
  assert.equal(sshArguments({ ...target, endpoint: 'evil.example/$(id)' }, '/tmp/known', 'pinned', 'true'), null);
});

function scripted(answer: (argv: readonly string[], knownHostsFile: string) => Promise<Awaited<ReturnType<SshRunner>>> | Awaited<ReturnType<SshRunner>>) {
  const runs: { argv: string[]; environment: Readonly<Record<string, string>>; knownHosts: string; stdin: string }[] = [];
  const run: SshRunner = async (argv, options) => {
    const file = argv.find(value => value.startsWith('UserKnownHostsFile='))!.slice('UserKnownHostsFile='.length);
    runs.push({ argv: [...argv], environment: options.environment, knownHosts: await readFile(file, 'utf8'), stdin: Buffer.from(options.stdin).toString('utf8') });
    return answer(argv, file);
  };
  return { runs, transport: createSshTransport({ run }) };
}

test('a program runs over a connection that accepts only the pinned host key, with the token in the client environment', async () => {
  const { runs, transport } = scripted(() => ({ status: 'exited', exitCode: 3, stdout: 'out\n', stderr: 'err\n' }));
  const result = await transport.exec({ ...target, hostKey }, { program: 'build', script: 'make', environment: { A: '1' } });
  assert.deepEqual(result, { status: 'exited', exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.knownHosts, `factory-microvm ${hostKey}\n`);
  assert.deepEqual(runs[0]!.environment, { FACTORY_MICROVM_TOKEN: 'secret-proxy-token' });
  assert.ok(runs[0]!.argv.includes('StrictHostKeyChecking=yes'));
  assert.equal(runs[0]!.stdin, 'A=1\0\0');
  assert.doesNotMatch(runs[0]!.argv.join(' '), /secret-proxy-token/);
});

test('a client failure is a refusal when the connection was never established and a lost connection otherwise', async () => {
  const failing = (stderr: string) => scripted(() => ({ status: 'exited', exitCode: 255, stdout: '', stderr })).transport.exec({ ...target, hostKey }, { program: 'p', script: 'true' });
  assert.deepEqual(await failing('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n'),
    { status: 'refused', code: 'HOST_KEY_MISMATCH', detail: 'Host key verification failed.' });
  // Observed in the proof (T4): websocat's text for an expired token, then ssh exit 255.
  assert.deepEqual(await failing('websocat: WebSocketError: Received unexpected status code (403 Forbidden)\nkex_exchange_identification: Connection closed by remote host\n'),
    { status: 'refused', code: 'TOKEN_REFUSED', detail: 'kex_exchange_identification: Connection closed by remote host' });
  assert.equal((await failing('builder@factory-microvm: Permission denied (publickey).\n') as { code?: string }).code, 'AUTHENTICATION_REFUSED');
  assert.equal((await failing('kex_exchange_identification: Connection closed by remote host\n') as { code?: string }).code, 'UNREACHABLE');
  assert.deepEqual(await failing('Timeout, server factory-microvm not responding.\n'), { status: 'lost', detail: 'Timeout, server factory-microvm not responding.' });
  const absent = scripted(() => ({ status: 'unavailable' }));
  assert.equal((await absent.transport.exec({ ...target, hostKey }, { program: 'p', script: 'true' }) as { code?: string }).code, 'UNREACHABLE');
  const killed = scripted(() => ({ status: 'exited', exitCode: null, stdout: 'partial', stderr: '' }));
  assert.deepEqual(await killed.transport.exec({ ...target, hostKey }, { program: 'p', script: 'true' }), { status: 'lost' });
});

test('the first contact of a boot returns the host key the guest presented over the authenticated tunnel', async () => {
  const { runs, transport } = scripted(async (_argv, knownHostsFile) => {
    await writeFile(knownHostsFile, `factory-microvm ${hostKey}\n`);
    return { status: 'exited', exitCode: 0, stdout: '', stderr: "Warning: Permanently added 'factory-microvm' (ED25519) to the list of known hosts.\n" };
  });
  assert.deepEqual(await transport.readHostKey(target), { status: 'read', hostKey });
  assert.equal(runs[0]!.knownHosts, '');
  assert.ok(runs[0]!.argv.includes('StrictHostKeyChecking=accept-new'));
  const silent = scripted(() => ({ status: 'exited', exitCode: 0, stdout: '', stderr: '' }));
  assert.equal((await silent.transport.readHostKey(target)).status, 'lost');
  const refused = scripted(() => ({ status: 'exited', exitCode: 255, stdout: '', stderr: 'Received unexpected status code (403 Forbidden)\n' }));
  assert.deepEqual(await refused.transport.readHostKey(target), { status: 'refused', code: 'TOKEN_REFUSED', detail: 'Received unexpected status code (403 Forbidden)' });
});

test('the clone program leaves the starting commit of origin checked out on the Work branch and writes the credential nowhere', async t => {
  const directory = await scratch(t);
  const origin = join(directory, 'origin');
  const identity = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', PATH: process.env.PATH };
  const git = (...argv: string[]) => { const ran = local('git', argv, { cwd: origin, env: identity }); assert.equal(ran.status, 0, ran.stderr); return ran.stdout.trim(); };
  assert.equal(local('git', ['init', '--quiet', '--initial-branch=main', origin], { env: identity }).status, 0);
  await writeFile(join(origin, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'one');
  const starting = git('rev-parse', 'HEAD');
  await writeFile(join(origin, 'a.txt'), 'two\n');
  git('commit', '--quiet', '-am', 'two');

  const token = 'ghs_cloneTokenNeverWritten';
  const program = cloneProgram({ remote: origin, commit: starting, branch: 'factory/work-1', token, directory: join(directory, 'workspace', 'repo') })!;
  assert.doesNotMatch(program.script, new RegExp(token));
  assert.deepEqual(program.environment, { FACTORY_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' });
  const remote = remoteCommand(program)!;
  const ran = local('bash', ['-c', remote.command], { input: remote.stdin, env: { ...identity, HOME: directory } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(clonedHead(ran.stdout), starting);
  const cloned = (...argv: string[]) => local('git', argv, { cwd: join(directory, 'workspace', 'repo'), env: identity }).stdout.trim();
  assert.equal(cloned('rev-parse', '--abbrev-ref', 'HEAD'), 'factory/work-1');
  assert.equal(cloned('config', '--get', 'remote.origin.url'), origin);
  assert.equal(await readFile(join(directory, 'workspace', 'repo', 'a.txt'), 'utf8'), 'one\n');
  assert.doesNotMatch(await readFile(join(directory, 'workspace', 'repo', '.git', 'config'), 'utf8'), /ghs_|credential/);
  // A second clone into the same boot is refused: a boot starts from an empty disk exactly once.
  assert.equal(local('bash', ['-c', remote.command], { input: remote.stdin, env: { ...identity, HOME: directory } }).status, 4);
  // A commit origin does not have fails; the host never accepts another HEAD as the starting commit.
  const missing = remoteCommand(cloneProgram({ remote: origin, commit: 'f'.repeat(40), token, directory: join(directory, 'other') })!)!;
  assert.notEqual(local('bash', ['-c', missing.command], { input: missing.stdin, env: { ...identity, HOME: directory } }).status, 0);
});

test('the host places only validated values in a guest script', () => {
  const valid = { remote: 'https://github.com/acme/shop.git', commit: 'a'.repeat(40), token: 't' };
  assert.ok(cloneProgram(valid));
  assert.match(cloneProgram(valid)!.script, /git checkout --quiet --detach 'a{40}'/);
  assert.equal(cloneProgram({ ...valid, commit: 'HEAD' }), null);
  assert.equal(cloneProgram({ ...valid, branch: '-x' }), null);
  assert.equal(cloneProgram({ ...valid, branch: 'a..b' }), null);
  assert.equal(cloneProgram({ ...valid, remote: '--upload-pack=x' }), null);
  assert.equal(cloneProgram({ ...valid, remote: 'https://x/\n' }), null);
  assert.deepEqual(bootReady('boot-done pull=0\n'), { pulled: true });
  assert.deepEqual(bootReady('boot-done pull=1\n'), { pulled: false });
  assert.equal(bootReady('boot-not-done\n'), null);
  assert.match(bootReadyProgram().script, /factory-done/);
});
