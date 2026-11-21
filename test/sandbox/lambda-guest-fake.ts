import { readFileSync } from 'node:fs';
import { sessionPublicKey, type GuestExecRequest, type GuestExecResult, type GuestRefusal, type GuestTarget, type GuestTransport } from '../../src/sandbox/index.js';
import { generateSessionKey } from '../../src/sandbox/lambda/transport.js';
import type { lambdaAccountFake } from './lambda-service-fake.js';

/**
 * v2 Lambda tickets (04 onwards): the in-process guest and channel behind the `GuestTransport` seam, bound to the MicroVMs of the fake
 * account (`lambda-service-fake.ts`). No `ssh`, no `websocat`, no socket, no port: a connection is a function call that is admitted or
 * refused the way the real layers do it (service token of the port, pinned host key, session key), and a program is a handler.
 *
 * It models a GUEST, not call scripts. Each MicroVM gets its own guest when it runs: a fresh host key, the session key authorized by the
 * run hook payload, an EMPTY disk (no repository, no caches, no Docker data) and the Docker images its MicroVM image declares, pulled by
 * digest at that boot. Tests change the world (`origins`, `pullFailures`, `sshReadySeconds`, a guest's `hostKey`/`files`) and add
 * programs with `programs`; tickets 05 and 11 add the role tools and orphan processes on the same guest.
 */
export type FakeGuest = { microvmId: string;
  /** Generated in this boot; a test replaces it to play a guest that is not the one the host pinned. */ hostKey: string;
  /** Session public keys the run hook wrote, per user. */ authorized: Record<string, string>;
  /** The guest disk, empty at boot. */ files: Map<string, string>;
  /** What `docker pull` fetched in THIS boot. */ dockerImages: string[]; pullFailed: boolean;
  /** `/workspace/repo` once cloned. */ repository: { remote: string; commit: string; branch: string | null } | null;
  logs: Record<string, string>;
  /** Every program that ran here, with the NAMES of its environment (values are checked by the handlers, never kept). */
  executions: { program: string; script: string; environmentNames: string[] }[] };
export type FakeProgramResult = { exitCode: number; stdout?: string; stderr?: string };
export type FakeProgram = (guest: FakeGuest, request: GuestExecRequest) => FakeProgramResult | Promise<FakeProgramResult>;
export type FakeConnection = { microvmId: string; token: string; keepaliveSeconds: number; user: string; program: string; open: boolean };

/** The `declared-images` file of a stored (uncompressed) build artifact. */
function declaredImages(zip: Uint8Array | undefined): string[] {
  if (!zip) return [];
  const bytes = Buffer.from(zip);
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = offset + 30 + nameLength + extraLength;
    if (name === 'declared-images') return bytes.subarray(data, data + size).toString('utf8').split('\n').filter(Boolean);
    offset = data + size;
  }
  return [];
}

export function lambdaGuestFake(fake: ReturnType<typeof lambdaAccountFake>) {
  const world = {
    /** `origin` per remote URL: the commits it has and the one Git credential it accepts. */
    origins: {} as Record<string, { commits: string[]; token: string }>,
    /** Seconds after the MicroVM runs until its `sshd` answers (observed: about 7 s). */
    sshReadySeconds: 7,
    /** Image references whose pull by digest fails at boot. */
    pullFailures: [] as string[],
    /** Programs beyond the adapter's fixed ones, by `program` name; they also override a built-in. */
    programs: {} as Record<string, FakeProgram>,
  };
  const guests = new Map<string, FakeGuest>();
  const connections: FakeConnection[] = [];

  const builtIn: Record<string, FakeProgram> = {
    'boot-ready': guest => ({ exitCode: 0, stdout: `boot-done pull=${guest.pullFailed ? 1 : 0}\n` }),
    clone: (guest, request) => {
      const remote = /clone --quiet --no-checkout -- '([^']+)'/.exec(request.script)?.[1];
      const checkout = /git checkout --quiet (?:--detach|-B '([^']+)') '([0-9a-f]+)'/.exec(request.script);
      const origin = remote ? world.origins[remote] : undefined;
      if (!remote || !checkout || !origin) return { exitCode: 128, stderr: `fatal: repository '${remote ?? ''}' not found\n` };
      if (guest.repository) return { exitCode: 4, stderr: 'The guest already has a repository directory\n' };
      if (request.environment?.FACTORY_GIT_TOKEN !== origin.token) return { exitCode: 128, stderr: `fatal: Authentication failed for '${remote}'\n` };
      if (!origin.commits.includes(checkout[2]!)) return { exitCode: 128, stderr: `fatal: reference is not a tree: ${checkout[2]}\n` };
      guest.repository = { remote, commit: checkout[2]!, branch: checkout[1] ?? null };
      return { exitCode: 0, stdout: `HEAD ${checkout[2]}\n` };
    },
    evidence: guest => ({ exitCode: 0, stdout: Object.entries(guest.logs).map(([file, text]) => `===== ${file}\n${text}\n`).join('') }),
  };

  /** The guest of a running MicroVM, born on first contact from what the service handed to its run hook. */
  const guestOf = (endpoint: string): FakeGuest | null => {
    const microvm = fake.account.microvms.find(candidate => candidate.endpoint === endpoint);
    if (!microvm) return null;
    const existing = guests.get(microvm.microvmId);
    if (existing) return existing;
    const payload = JSON.parse(microvm.request.runHookPayload) as { builder?: string };
    const image = fake.account.images.find(candidate => candidate.imageArn === microvm.imageArn);
    const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(image?.request?.artifactUri ?? '') ?? [];
    const declared = declaredImages(bucket && key ? fake.account.objects[bucket]?.[key]?.body : undefined);
    const dockerImages = declared.filter(reference => !world.pullFailures.includes(reference));
    const pullFailed = dockerImages.length !== declared.length;
    const guest: FakeGuest = { microvmId: microvm.microvmId, hostKey: generateSessionKey().publicKey, authorized: payload.builder ? { builder: payload.builder } : {},
      files: new Map(), dockerImages, pullFailed, repository: null, executions: [],
      logs: { '/var/log/factory-done': `boot-done pull=${pullFailed ? 1 : 0}`, '/var/log/factory-pull.log': declared.map(reference => `pull ${reference}`).join('\n') } };
    guests.set(microvm.microvmId, guest);
    return guest;
  };

  /** The layers a NEW connection passes: the service's proxy (MicroVM running, token of the port), `sshd` up, then the session key. */
  const admit = (target: GuestTarget): { guest: FakeGuest } | GuestRefusal => {
    const admitted = fake.admits({ endpoint: target.endpoint, port: target.port, token: target.token });
    if (admitted === 'gone') return { status: 'refused', code: 'UNREACHABLE' };
    if (admitted === 'forbidden') return { status: 'refused', code: 'TOKEN_REFUSED', detail: 'Received unexpected status code (403 Forbidden)' };
    const microvm = fake.account.microvms.find(candidate => candidate.endpoint === target.endpoint)!;
    if (fake.account.clock.now < microvm.runningAt + world.sshReadySeconds * 1000) return { status: 'refused', code: 'UNREACHABLE' };
    const guest = guestOf(target.endpoint)!;
    let presented: string | null = null;
    try { presented = sessionPublicKey(readFileSync(target.identityFile, 'utf8')); } catch { /* No identity: refused below. */ }
    if (!presented || guest.authorized[target.user] !== presented) return { status: 'refused', code: 'AUTHENTICATION_REFUSED', detail: 'Permission denied (publickey).' };
    return { guest };
  };

  const transport: GuestTransport = {
    async readHostKey(target) {
      const admitted = admit(target);
      return 'guest' in admitted ? { status: 'read', hostKey: admitted.guest.hostKey } : admitted;
    },
    async exec(target, request, options = {}): Promise<GuestExecResult> {
      const admitted = admit(target);
      if (!('guest' in admitted)) return admitted;
      const { guest } = admitted;
      // The client refuses a host key other than the pinned one before anything runs.
      if (guest.hostKey !== target.hostKey) return { status: 'refused', code: 'HOST_KEY_MISMATCH', detail: 'Host key verification failed.' };
      const connection: FakeConnection = { microvmId: guest.microvmId, token: target.token, keepaliveSeconds: target.keepaliveSeconds, user: target.user, program: request.program, open: true };
      connections.push(connection);
      guest.executions.push({ program: request.program, script: request.script, environmentNames: Object.keys(request.environment ?? {}) });
      const program = world.programs[request.program] ?? builtIn[request.program];
      try {
        const aborted = new Promise<'aborted'>(resolve => { options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true }); });
        const outcome = await Promise.race([Promise.resolve(program ? program(guest, request) : { exitCode: 127, stderr: `${request.program}: not found\n` }), aborted]);
        // A closed connection or a dead MicroVM gives the client no exit status; the token's expiry alone ends nothing.
        if (outcome === 'aborted') return { status: 'lost' };
        fake.settle();
        if (fake.account.microvms.find(candidate => candidate.microvmId === guest.microvmId)?.state !== 'RUNNING') return { status: 'lost' };
        if (outcome.stdout) options.onData?.(Buffer.from(outcome.stdout));
        return { status: 'exited', exitCode: outcome.exitCode, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
      } finally { connection.open = false; }
    },
  };
  return { world, guests, connections, transport, guestOf: (microvmId: string) => guests.get(microvmId) ?? null };
}
