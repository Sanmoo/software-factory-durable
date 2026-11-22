import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuestExecRequest, GuestExecResult, GuestRefusal, GuestTarget, GuestTransport } from './transport.js';

/**
 * v2 ticket 04 (V2-20): the production transport, made of ready-made components only. The host's OpenSSH client runs one program per
 * connection; its `ProxyCommand` is `websocat`, which opens the WebSocket to the MicroVM's `HTTP_INGRESS` endpoint with the service
 * token of the port in the `X-aws-proxy-auth` header (proven shape: prototype `bin/proxy`, websocat 1.14). The guest side is `sshd` on
 * loopback behind `websocat` on 8022 (`guest-files.ts`). `ssh` and `websocat` are host prerequisites, like `aws`.
 *
 * NOT PROVEN, isolated in this file:
 * - `remoteCommand`: environment delivered on the program's stdin (the proofs passed no environment at all);
 * - `readHostKey`: pinning by `StrictHostKeyChecking=accept-new` on the first, token-authenticated contact (the prototype read the host
 *   key from a diagnostics port that production does not have);
 * - `classify`: the client texts that tell a refusal from a lost connection (only the 403 and exit 255 were observed);
 * - the token is in `websocat`'s argument list on the HOST (as in the proofs): visible to host processes of the same trust domain.
 */
export type SshRunner = (
  argv: readonly string[],
  options: { environment: Readonly<Record<string, string>>; stdin: Uint8Array; signal?: AbortSignal; onData?: (data: Buffer) => void },
) => Promise<{ status: 'exited'; exitCode: number | null; stdout: string; stderr: string } | { status: 'unavailable' }>;

const outputLimit = 16 * 1024 * 1024;
export function createSshRunner({ executable = 'ssh', environment = process.env }: { executable?: string; environment?: NodeJS.ProcessEnv } = {}): SshRunner {
  return (argv, options) =>
    new Promise(resolve => {
      const child = spawn(executable, [...argv], {
        env: { ...environment, ...options.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        options.onData?.(data);
        if (stdout.length < outputLimit) stdout += data.toString('utf8');
      });
      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < outputLimit) stderr += data.toString('utf8');
      });
      child.on('error', error =>
        resolve('code' in error && error.code === 'ENOENT' ? { status: 'unavailable' } : { status: 'exited', exitCode: null, stdout, stderr }),
      );
      child.on('close', exitCode => resolve({ status: 'exited', exitCode, stdout, stderr }));
      child.stdin.on('error', () => {
        /* The connection ended before the input was read: reported by the exit. */
      });
      child.stdin.end(options.stdin);
    });
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const hostAlias = 'factory-microvm';
const tokenVariable = 'FACTORY_MICROVM_TOKEN';

/**
 * The remote command line and the bytes of its stdin. The command line carries the program's script and NO environment value: each
 * `NAME=value` entry travels on stdin, NUL-terminated, before an empty entry; a fixed bootstrap exports them and replaces itself with the
 * program, which reads the rest of stdin. So a secret is never an argument of any guest process and never a guest file (V2-24).
 */
export function remoteCommand(request: GuestExecRequest): { command: string; stdin: Uint8Array } | null {
  const entries = Object.entries(request.environment ?? {});
  if (entries.some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0'))) return null;
  const bootstrap = 'while IFS= read -r -d "" entry && [ -n "$entry" ]; do export "$entry"; done; exec bash -c "$1"';
  return {
    command: `exec bash -c ${quote(bootstrap)} factory ${quote(request.script)}`,
    stdin: Buffer.concat([...entries.map(([name, value]) => Buffer.from(`${name}=${value}\0`, 'utf8')), Buffer.from([0]), Buffer.from(request.stdin ?? [])]),
  };
}

/** The `ssh` argument list of one connection. `hostKeys`: `pinned` accepts only the key in `knownHostsFile`; `first-contact` records the key presented. */
export function sshArguments(
  target: Omit<GuestTarget, 'token'>,
  knownHostsFile: string,
  hostKeys: 'pinned' | 'first-contact',
  command: string,
  websocat = 'websocat',
): string[] | null {
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(target.endpoint) || !Number.isInteger(target.port)) return null;
  const proxy = `${quote(websocat)} --binary "--header=X-aws-proxy-auth: $${tokenVariable}" "--header=X-aws-proxy-port: ${target.port}" - ${quote(`wss://${target.endpoint}/`)}`;
  const options = [
    'BatchMode=yes',
    'IdentitiesOnly=yes',
    `IdentityFile=${target.identityFile}`,
    'IdentityAgent=none',
    'PreferredAuthentications=publickey',
    `StrictHostKeyChecking=${hostKeys === 'pinned' ? 'yes' : 'accept-new'}`,
    `UserKnownHostsFile=${knownHostsFile}`,
    'GlobalKnownHostsFile=/dev/null',
    'HashKnownHosts=no',
    `HostKeyAlias=${hostAlias}`,
    'HostKeyAlgorithms=ssh-ed25519',
    'UpdateHostKeys=no',
    // Keepalive at the SSH level, as in the proofs (the longest measured connection, 37.6 min, ran with it).
    `ServerAliveInterval=${target.keepaliveSeconds}`,
    'ServerAliveCountMax=3',
    'ConnectTimeout=30',
    'ControlMaster=no',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
    `ProxyCommand=${proxy}`,
  ];
  return ['-F', 'none', '-T', ...options.flatMap(option => ['-o', option]), `${target.user}@${hostAlias}`, '--', command];
}

/** `ssh` exit 255 means the CLIENT failed. These texts say whether the connection was never established (nothing ran) or was lost. */
function classify(stderr: string): GuestRefusal | { status: 'lost'; detail?: string } {
  const detail = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300);
  const refused = (code: GuestRefusal['code']): GuestRefusal => ({ status: 'refused', code, ...(detail ? { detail } : {}) });
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* has changed/i.test(stderr)) return refused('HOST_KEY_MISMATCH');
  if (/403|Forbidden/.test(stderr)) return refused('TOKEN_REFUSED');
  if (/Permission denied/.test(stderr)) return refused('AUTHENTICATION_REFUSED');
  if (
    /kex_exchange_identification|Connection refused|Connection timed out|Could not resolve|unexpected status code|WebSocketError|banner exchange/i.test(stderr)
  )
    return refused('UNREACHABLE');
  return { status: 'lost', ...(detail ? { detail } : {}) };
}

export function createSshTransport({ run = createSshRunner(), websocat = 'websocat' }: { run?: SshRunner; websocat?: string } = {}): GuestTransport {
  async function connect(
    target: GuestTarget,
    hostKeys: 'pinned' | 'first-contact',
    knownHosts: string,
    request: GuestExecRequest,
    options: { signal?: AbortSignal; onData?: (data: Buffer) => void } = {},
  ): Promise<{ result: GuestExecResult; knownHosts: string }> {
    const remote = remoteCommand(request);
    const directory = await mkdtemp(join(tmpdir(), 'factory-lambda-ssh-'));
    try {
      const file = join(directory, 'known_hosts');
      await writeFile(file, knownHosts, { mode: 0o600 });
      const argv = remote ? sshArguments(target, file, hostKeys, remote.command, websocat) : null;
      if (!remote || !argv)
        return { result: { status: 'refused', code: 'UNREACHABLE', detail: 'The connection request is not one the host makes' }, knownHosts };
      const ran = await run(argv, {
        environment: { [tokenVariable]: target.token },
        stdin: remote.stdin,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onData ? { onData: options.onData } : {}),
      });
      const seen = await readFile(file, 'utf8').catch(() => '');
      if (ran.status === 'unavailable')
        return { result: { status: 'refused', code: 'UNREACHABLE', detail: 'The ssh client is not available on this host' }, knownHosts: seen };
      if (ran.exitCode === null || options.signal?.aborted) return { result: { status: 'lost' }, knownHosts: seen };
      if (ran.exitCode === 255) return { result: classify(ran.stderr), knownHosts: seen };
      return { result: { status: 'exited', exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }, knownHosts: seen };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    async readHostKey(target) {
      const { result, knownHosts } = await connect(target, 'first-contact', '', { program: 'first-contact', script: 'true' });
      if (result.status === 'refused' || result.status === 'lost') return result;
      const hostKey = /^factory-microvm (ssh-ed25519 [A-Za-z0-9+/=]+)\s*$/m.exec(knownHosts)?.[1];
      if (result.status !== 'exited' || result.exitCode !== 0 || !hostKey)
        return { status: 'lost', detail: 'The first contact presented no readable host key' };
      return { status: 'read', hostKey };
    },
    exec: async (target, request, options) => (await connect(target, 'pinned', `${hostAlias} ${target.hostKey}\n`, request, options)).result,
  };
}
