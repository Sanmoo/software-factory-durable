import { createHash } from 'node:crypto';
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
 * programs with `programs`.
 *
 * Ticket 11: a tool program that registers itself (`echo $$ > <marker>`) is a PROCESS of the guest (`processes`). It outlives its connection:
 * `drop()` cuts open connections the way a network failure does (the client gets no exit status, the program keeps running), `end-call`
 * kills the process group a marker names, and `world.channelDown` refuses new connections while the MicroVM stays alive.
 *
 * Ticket 05: the guest has the Unix users its IMAGE creates (read from the Dockerfile and `sshd_config` of the build artifact): who may
 * log in, who is in the `docker` group, who owns the workspace. The `tool` program is what the tool backends send (a quoted argument
 * vector): the fake recognises the fixed guest programs (read, write, edit, stream copy, Bash) and applies them to `files` AS THE USER of
 * the connection. Shell commands are handlers by exact command text (`commands`); `docker ps` is built in.
 */
export type FakeGuest = { microvmId: string;
  /** Generated in this boot; a test replaces it to play a guest that is not the one the host pinned. */ hostKey: string;
  /** Session public keys the run hook wrote, per user. */ authorized: Record<string, string>;
  /** The guest disk, empty at boot. */ files: Map<string, string>;
  /** Permission bits of files the tools created (absent: 0o644, what `git` and a shell leave). */ modes: Map<string, number>;
  /** Directories created explicitly (a file's parents exist implicitly). */ directories: Set<string>;
  /** Unix users of the image: `login` (sshd admits it), `docker` (member of the group that owns the Docker socket). */
  users: Record<string, { login: boolean; docker: boolean }>;
  /** The user that owns `/workspace` and `/artifacts`: the only one that writes there. */ owner: string;
  /** What `docker pull` fetched in THIS boot. */ dockerImages: string[]; pullFailed: boolean;
  /** `/workspace/checkout` once cloned. */ repository: { remote: string; commit: string; branch: string | null } | null;
  logs: Record<string, string>;
  /** Every program that ran here, with the NAMES of its environment (values are checked by the handlers, never kept). */
  executions: { program: string; user: string; script: string; environmentNames: string[] }[];
  /** Tool programs that registered a call marker (ticket 11): each is one process group, alive until it exits or is killed. */
  processes: { marker: string; user: string; state: 'running' | 'exited' | 'killed' }[] };
export type FakeProgramResult = { exitCode: number; stdout?: string | Buffer; stderr?: string };
/** A running program: its Unix user, output it writes before it ends, and whether its connection is still open. */
export type FakeRun = { user: string; emit(data: string | Buffer): void; readonly connected: boolean; /** Resolves when the connection closes under the program. */ disconnected: Promise<void>;
  /** Resolves when the program's process group is killed (ticket 11); never for a program without a call marker. */ killed: Promise<void> };
export type FakeProgram = (guest: FakeGuest, request: GuestExecRequest, run: FakeRun) => FakeProgramResult | Promise<FakeProgramResult>;
/** A shell command of the Builder's Bash, by exact text: its environment is what the command sees, its return the exit status. */
export type FakeCommand = (guest: FakeGuest, run: FakeRun & { environment: Record<string, string>; stdin: string }) => number | Promise<number>;
export type FakeConnection = { microvmId: string; token: string; keepaliveSeconds: number; user: string; program: string; open: boolean;
  /** What the client presented and accepted on this connection (ticket 11: a reconnection uses the boot's own). */ identityFile: string; hostKey: string };

/** One file of a stored (uncompressed) build artifact. */
function artifactFile(zip: Uint8Array | undefined, wanted: string): string {
  if (!zip) return '';
  const bytes = Buffer.from(zip);
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = offset + 30 + nameLength + extraLength;
    if (name === wanted) return bytes.subarray(data, data + size).toString('utf8');
    offset = data + size;
  }
  return '';
}

/** The words of a script the host wrote as single-quoted words (`'it'\''s'`); anything else is not a tool program. */
function quotedWords(text: string): string[] | null {
  const words: string[] = [];
  let word = '', open = false;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      word += text.slice(index + 1, end); index = end + 1; open = true;
    } else if (character === '\\' && text[index + 1] === "'") { word += "'"; index += 2; open = true;
    } else if (character === ' ' && open) { words.push(word); word = ''; open = false; index += 1;
    } else return null;
  }
  if (open) words.push(word);
  return words;
}
/** A tool program as the host writes it: an optional call marker (ticket 11), the working directory and the quoted argument vector. */
const toolScriptPattern = /^(?:echo \$\$ > '([^']*)' && )?cd '([^']*)' && exec (.*)$/s;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const roots = ['/workspace', '/artifacts'];

/** The fixed guest programs of the tool backends, applied to the fake disk as `run.user`. Exit statuses are the programs' own. */
async function toolProgram(guest: FakeGuest, request: GuestExecRequest, run: FakeRun, commands: Record<string, FakeCommand>): Promise<FakeProgramResult> {
  const script = toolScriptPattern.exec(request.script);
  const argv = script ? quotedWords(script[3]!) : null;
  if (!argv) return { exitCode: 2, stderr: 'not a tool program\n' };
  const stdin = Buffer.from(request.stdin ?? []).toString('utf8');
  const inside = (path: string) => roots.some(root => path.startsWith(`${root}/`)) && !path.split('/').includes('..');
  const isDirectory = (path: string) => roots.includes(path) || guest.directories.has(path) || [...guest.files.keys()].some(file => file.startsWith(`${path}/`));
  const mayRead = (path: string) => run.user === guest.owner || ((guest.modes.get(path) ?? 0o644) & 0o004) !== 0;
  const mayWrite = () => run.user === guest.owner;
  const python = argv.indexOf('/usr/bin/python3');
  if (python >= 0 && argv[python + 3] === '-c') {
    const program = argv[python + 4]!, parameters = argv.slice(python + 5);
    const writes = program.includes('os.O_WRONLY') || program.includes('os.O_RDWR');
    if (!writes) {
      const path = parameters[0]!;
      const missingStatus = program.includes('missing = True') ? 4 : 1;
      if (!inside(path)) return { exitCode: 1 };
      if (isDirectory(path)) return { exitCode: 3 };
      const content = guest.files.get(path);
      if (content === undefined) return { exitCode: missingStatus };
      if (!mayRead(path)) return { exitCode: 1 };
      return { exitCode: 0, stdout: Buffer.from(content, 'utf8') };
    }
    const [operation, path] = parameters as [string, string];
    if (!inside(path) || !mayWrite()) return { exitCode: 1 };
    // The permission bits the program asks for at creation: the reviewer's own user reads only what is left world-readable.
    const fileMode = /os\.O_EXCL[^\n]*0o644/.test(program) ? 0o644 : 0o600;
    if (operation === 'mkdir') {
      if (guest.files.has(path)) return { exitCode: 1 };
      for (let parent = path; !roots.includes(parent) && parent !== ''; parent = parent.slice(0, parent.lastIndexOf('/'))) guest.directories.add(parent);
      return { exitCode: 0 };
    }
    if (isDirectory(path)) return { exitCode: 1 };
    const existing = guest.files.get(path);
    if (operation === 'commit') {
      if (existing === undefined) return { exitCode: 1 };
      if (Buffer.byteLength(existing) !== Number(parameters[2]) || sha256(existing) !== parameters[3]) return { exitCode: 42 };
    } else if (operation === 'stream') {
      if (existing !== undefined) return { exitCode: 1 };
    } else if (operation !== 'create') return { exitCode: 1 };
    guest.files.set(path, stdin);
    if (existing === undefined) guest.modes.set(path, fileMode);
    return { exitCode: 0, ...(operation === 'stream' ? { stdout: JSON.stringify({ bytes: Buffer.byteLength(stdin), sha256: sha256(stdin) }) } : {}) };
  }
  // Bash of the channel conventions: `/bin/bash -c <prelude> <name> <command> NAME=value...`; the prelude leaves the command exactly the
  // given entries plus the credential of its own process environment (modelled here, exercised with a real bash in the tools test).
  if (argv[0] === '/bin/bash' && argv[1] === '-c' && argv.length >= 5) {
    const command = argv[4]!;
    const environment = Object.fromEntries(argv.slice(5).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    if (request.environment?.GH_TOKEN !== undefined) environment.GH_TOKEN = request.environment.GH_TOKEN;
    const handler = commands[command];
    if (!handler) { run.emit(`bash: line 1: ${command.split(' ')[0]}: command not found\n`); return { exitCode: 127 }; }
    return { exitCode: await handler(guest, { ...run, get connected() { return run.connected; }, environment, stdin }) };
  }
  return { exitCode: 127, stderr: `${argv[0]}: not found\n` };
}

export function lambdaGuestFake(fake: ReturnType<typeof lambdaAccountFake>) {
  const world = {
    /** `origin` per remote URL: the commits it has and the one Git credential it accepts. */
    origins: {} as Record<string, { commits: string[]; token: string }>,
    /** Seconds after the MicroVM runs until its `sshd` answers (observed: about 7 s). */
    sshReadySeconds: 7,
    /** Image references whose pull by digest fails at boot. */
    pullFailures: [] as string[],
    /** Ticket 11: while set, no NEW connection reaches a guest although its MicroVM runs (a network failure between host and service). */
    channelDown: false,
    /** Programs beyond the adapter's fixed ones, by `program` name; they also override a built-in. */
    programs: {} as Record<string, FakeProgram>,
    /** Shell commands of the Builder's Bash, by exact command text. */
    commands: {
      // The Docker socket belongs to root and the `docker` group.
      'docker ps': (guest, run) => {
        if (guest.users[run.user]?.docker) { run.emit('CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES\n'); return 0; }
        run.emit('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n');
        return 1;
      },
    } as Record<string, FakeCommand>,
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
    tool: (guest, request, run) => toolProgram(guest, request, run, world.commands),
    // Ticket 11: ends the process group a call marker names. Only the owner of a process may kill it.
    'end-call': (guest, request, run) => {
      const marker = /^marker='([^']*)'$/m.exec(request.script)?.[1];
      const process = guest.processes.find(candidate => candidate.marker === marker);
      if (!process) return { exitCode: 0, stdout: 'call-not-started\n' };
      if (process.state === 'running') {
        if (process.user !== run.user) return { exitCode: 5, stdout: 'call-alive\n' };
        process.state = 'killed';
        kills.get(process)?.();
      }
      return { exitCode: 0, stdout: 'call-ended\n' };
    },
  };
  const kills = new Map<FakeGuest['processes'][number], () => void>();
  const drops = new Set<() => void>();

  /** The guest of a running MicroVM, born on first contact from what the service handed to its run hook. */
  const guestOf = (endpoint: string): FakeGuest | null => {
    const microvm = fake.account.microvms.find(candidate => candidate.endpoint === endpoint);
    if (!microvm) return null;
    const existing = guests.get(microvm.microvmId);
    if (existing) return existing;
    const payload = JSON.parse(microvm.request.runHookPayload) as { builder?: string };
    const image = fake.account.images.find(candidate => candidate.imageArn === microvm.imageArn);
    const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(image?.request?.artifactUri ?? '') ?? [];
    const artifact = bucket && key ? fake.account.objects[bucket]?.[key]?.body : undefined;
    const declared = artifactFile(artifact, 'declared-images').split('\n').filter(Boolean);
    // The users are the image's: created by its Dockerfile, admitted by its sshd_config; the hook agent authorizes the session key for them.
    const dockerfile = artifactFile(artifact, 'Dockerfile'), sshd = artifactFile(artifact, 'sshd_config');
    const admitted = (/^AllowUsers (.+)$/m.exec(sshd)?.[1] ?? '').split(/\s+/);
    const users = Object.fromEntries([...dockerfile.matchAll(/adduser -D -s \/bin\/bash ([a-z]+)/g)].map(([, name]) =>
      [name!, { login: admitted.includes(name!), docker: new RegExp(`addgroup ${name} docker\\b`).test(dockerfile) }]));
    const owner = /chown ([a-z]+):[a-z]+ \/workspace/.exec(dockerfile)?.[1] ?? 'root';
    const dockerImages = declared.filter(reference => !world.pullFailures.includes(reference));
    const pullFailed = dockerImages.length !== declared.length;
    const guest: FakeGuest = { microvmId: microvm.microvmId, hostKey: generateSessionKey().publicKey, authorized: payload.builder ? Object.fromEntries(Object.entries(users).filter(([, user]) => user.login).map(([name]) => [name, payload.builder!])) : {},
      files: new Map(), modes: new Map(), directories: new Set(), users, owner, dockerImages, pullFailed, repository: null, executions: [], processes: [],
      logs: { '/var/log/factory-done': `boot-done pull=${pullFailed ? 1 : 0}`, '/var/log/factory-pull.log': declared.map(reference => `pull ${reference}`).join('\n') } };
    guests.set(microvm.microvmId, guest);
    return guest;
  };

  /** The layers a NEW connection passes: the service's proxy (MicroVM running, token of the port), `sshd` up, then the session key. */
  const admit = (target: GuestTarget): { guest: FakeGuest } | GuestRefusal => {
    const admitted = fake.admits({ endpoint: target.endpoint, port: target.port, token: target.token });
    if (admitted === 'gone') return { status: 'refused', code: 'UNREACHABLE' };
    if (world.channelDown) return { status: 'refused', code: 'UNREACHABLE' };
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
      const connection: FakeConnection = { microvmId: guest.microvmId, token: target.token, keepaliveSeconds: target.keepaliveSeconds, user: target.user, program: request.program, open: true,
        identityFile: target.identityFile, hostKey: target.hostKey };
      connections.push(connection);
      guest.executions.push({ program: request.program, user: target.user, script: request.script, environmentNames: Object.keys(request.environment ?? {}) });
      const program = world.programs[request.program] ?? builtIn[request.program];
      const alive = () => fake.account.microvms.find(candidate => candidate.microvmId === guest.microvmId)?.state === 'RUNNING';
      let stdout = '';
      const deliver = (data: string | Buffer) => {
        // Output reaches the client only while its connection is open and the MicroVM lives.
        if (!connection.open || !alive()) return;
        stdout += data.toString('utf8');
        options.onData?.(Buffer.from(data));
      };
      try {
        const aborted = new Promise<'aborted'>(resolve => {
          if (options.signal?.aborted) resolve('aborted'); else options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        // Cut from outside (ticket 11): the client loses the connection, nobody asked the program to stop.
        let cut!: () => void;
        const dropped = new Promise<'aborted'>(resolve => { cut = () => resolve('aborted'); });
        drops.add(cut);
        const gone = Promise.race([aborted, dropped]);
        const marker = request.program === 'tool' ? toolScriptPattern.exec(request.script)?.[1] : undefined;
        const process = marker ? { marker, user: target.user, state: 'running' as 'running' | 'exited' | 'killed' } : null;
        const killed = new Promise<void>(resolve => { if (process) { guest.processes.push(process); kills.set(process, resolve); } });
        const run: FakeRun = { user: target.user, emit: deliver, get connected() { return connection.open; },
          disconnected: gone.then(() => { connection.open = false; }), killed };
        const running = Promise.resolve(program ? program(guest, request, run) : { exitCode: 127, stderr: `${request.program}: not found\n` });
        // The program is a process of the guest: it ends when IT ends, whatever happened to the connection that started it.
        void running.then(() => { if (process?.state === 'running') process.state = 'exited'; }, () => {}).finally(() => drops.delete(cut));
        const outcome = await Promise.race([running, gone]);
        // A closed connection or a dead MicroVM gives the client no exit status; the token's expiry alone ends nothing.
        if (outcome === 'aborted') return { status: 'lost' };
        fake.settle();
        if (!alive()) return { status: 'lost' };
        if (outcome.stdout) deliver(outcome.stdout);
        return { status: 'exited', exitCode: outcome.exitCode, stdout, stderr: outcome.stderr ?? '' };
      } finally { connection.open = false; }
    },
  };
  /**
   * What a process of `user` INSIDE the guest gets when it runs `request` itself, without the host: the guest's own permissions are the
   * only thing between that user and the effect (the second layer of V2-23).
   */
  const inside = async (microvmId: string, user: string, request: GuestExecRequest) => {
    let output = '';
    const result = await builtIn.tool!(guests.get(microvmId)!, request, { user, emit: data => { output += data.toString('utf8'); }, connected: true, disconnected: new Promise(() => {}), killed: new Promise(() => {}) });
    return { exitCode: result.exitCode, output: output + (result.stdout?.toString('utf8') ?? '') };
  };
  /** Ticket 11: cuts every open connection as a network failure does. The programs keep running in their guests. */
  const drop = () => { for (const cut of [...drops]) cut(); };
  return { world, guests, connections, transport, inside, drop, guestOf: (microvmId: string) => guests.get(microvmId) ?? null };
}
