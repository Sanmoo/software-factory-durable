import { spawn } from 'node:child_process';
import type { InvestigationCommandResult } from './port.js';

export type ClonePlacement = { name: string; source: string };

/** Host paths one confinement is built from. Every command of the attempt gets a new confinement over the same layout. */
export type ConfinementLayout = {
  /** Host directory bound read-write at `/tmp`: the only place a command writes. */
  temporary: string;
  /** Host directory with the minimal `passwd`, `group` and `nsswitch.conf` of the confinement. */
  etc: string;
  /** Empty Host directory bound read-only over every masked path. */
  empty: string;
  clones: readonly ClonePlacement[];
  /** `/bin`, `/lib`... as the Host has them: a symlink is recreated, a directory is bound read-only. */
  system: readonly { path: string; link: string | null }[];
  /** Host paths under `/usr` that must not be seen (the Factory root, when it lives there). */
  masked: readonly string[];
  shell: string;
};

export const confinedTemporary = '/tmp';
export const confinedClone = (name: string) => `/repos/${name}`;

const confinedEnvironment = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: confinedTemporary,
  TMPDIR: confinedTemporary,
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
};
const hostEtc = ['ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'alternatives'];
export const ownEtc = ['passwd', 'group', 'nsswitch.conf'];

/**
 * Spec #68 §6: the bubblewrap arguments of one command. Every namespace is new, so the network has only its own loopback; the root is
 * an empty read-only tmpfs with the Host's `/usr` and a minimal `/etc`, without `/home` and without the Factory root; the environment
 * is cleared, so no credential variable of the agent reaches the command.
 */
export function confinementArguments(layout: ConfinementLayout, command: string, cwd: string): string[] {
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--hostname',
    'investigation',
    '--clearenv',
    ...Object.entries(confinedEnvironment).flatMap(([name, value]) => ['--setenv', name, value]),
    '--ro-bind',
    '/usr',
    '/usr',
    ...layout.system.flatMap(({ path, link }) => (link === null ? ['--ro-bind', path, path] : ['--symlink', link, path])),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--dir',
    '/etc',
    ...ownEtc.flatMap(name => ['--ro-bind', `${layout.etc}/${name}`, `/etc/${name}`]),
    ...hostEtc.flatMap(name => ['--ro-bind-try', `/etc/${name}`, `/etc/${name}`]),
    '--bind',
    layout.temporary,
    confinedTemporary,
    '--dir',
    '/repos',
    ...layout.clones.flatMap(({ name, source }) => ['--ro-bind', source, confinedClone(name)]),
    ...layout.masked.flatMap(path => ['--ro-bind', layout.empty, path]),
    '--remount-ro',
    '/',
    '--chdir',
    cwd,
    '--',
    layout.shell,
    '-c',
    command,
  ];
}

/** Keeps the first `limit` bytes and counts the rest, so the cut is reported with its size. */
function boundedOutput(limit: number) {
  const kept: Buffer[] = [];
  let size = 0;
  let total = 0;
  return {
    add(chunk: Buffer) {
      total += chunk.length;
      if (size >= limit) return;
      const part = chunk.subarray(0, limit - size);
      kept.push(part);
      size += part.length;
    },
    read() {
      const output = Buffer.concat(kept).toString('utf8');
      return total > size ? { output, notice: `OUTPUT_TRUNCATED: kept the first ${size} of ${total} bytes` } : { output };
    },
  };
}

/**
 * Runs one command process bounded in time and output. Past the time the whole process group is killed and the failure is returned to
 * the caller: nothing else of the environment ends. Stdout and stderr are kept together, in arrival order.
 */
export function runBounded(
  executable: string,
  argv: readonly string[],
  bounds: { timeoutMs: number; outputBytes: number; env: Record<string, string>; cwd?: string },
): Promise<InvestigationCommandResult> {
  return new Promise(resolve => {
    const child = spawn(executable, argv, { env: bounds.env, cwd: bounds.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const output = boundedOutput(bounds.outputBytes);
    let failure: 'INVESTIGATION_COMMAND_TIMEOUT' | 'INVESTIGATION_COMMAND_UNAVAILABLE' | undefined;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group is already gone */
      }
    };
    const timer = setTimeout(() => {
      failure = 'INVESTIGATION_COMMAND_TIMEOUT';
      killGroup();
    }, bounds.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => output.add(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.add(chunk));
    child.once('error', () => {
      failure = 'INVESTIGATION_COMMAND_UNAVAILABLE';
      if (child.pid === undefined) {
        clearTimeout(timer);
        resolve({ status: 'failed', code: failure, ...output.read() });
      }
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      // Whatever the command left in its own group dies with it; a confinement dies with its bubblewrap parent.
      killGroup();
      resolve(failure ? { status: 'failed', code: failure, ...output.read() } : { status: 'completed', exitCode, signal, ...output.read() });
    });
  });
}
