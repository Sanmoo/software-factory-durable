import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { unitState } from '../../platform/host/index.js';
import { confinedClone, confinedTemporary, confinementArguments, ownEtc, runBounded, type ClonePlacement, type ConfinementLayout } from './command.js';
import {
  defaultOutputBytes,
  investigationUnit,
  type InvestigationAttemptRef,
  type InvestigationEnvironmentPort,
  type InvestigationIntent,
  type InvestigationOpened,
  type InvestigationRecord,
  type InvestigationShell,
  type InvestigationStop,
} from './port.js';
import { stopConfirmation, type StopFacts } from './stop-rules.js';

const run = promisify(execFile);
const managerCall = { timeout: 10000, maxBuffer: 16384 };
const limitsSchema = z.strictObject({
  memoryGiB: z.number().positive().max(1024),
  processes: z.number().int().positive().max(1_000_000),
  commandSeconds: z.number().positive().max(86400),
  outputBytes: z.number().int().positive().max(16_777_216).optional(),
});
const environmentSchema = z.strictObject({ version: z.literal(1), attempt: z.string(), unit: z.string(), limits: limitsSchema });
const cloneSchema = z.strictObject({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/), source: z.string() });
const clonesSchema = z.array(cloneSchema);
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const systemPaths = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const hostBootNow = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const unitCgroup = (unit: string) => {
  const uid = process.getuid?.();
  return `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
};

async function cgroupFact(cgroup: string): Promise<StopFacts['cgroup']> {
  const directory = `/sys/fs/cgroup${cgroup}`;
  try {
    return /(?:^|\n)populated 0(?:\n|$)/.test(await readFile(`${directory}/cgroup.events`, 'utf8')) ? 'empty' : 'populated';
  } catch (error) {
    if (!missing(error)) return 'unreadable';
  }
  // A group that still exists but lacks readable events is unavailable, not empty.
  try {
    await lstat(directory);
    return 'unreadable';
  } catch (error) {
    return missing(error) ? 'absent' : 'unreadable';
  }
}

async function managerFact(unit: string): Promise<StopFacts['manager']> {
  try {
    const state = await unitState(unit);
    return { activeState: state.ActiveState ?? '', invocation: state.InvocationID ?? '', controlGroup: state.ControlGroup ?? '' };
  } catch {
    return 'unavailable';
  }
}

async function systemLayout(): Promise<ConfinementLayout['system']> {
  const found: { path: string; link: string | null }[] = [];
  for (const path of systemPaths) {
    try {
      const info = await lstat(path);
      found.push({ path, link: info.isSymbolicLink() ? await readlink(path) : null });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return found;
}

async function hostShell() {
  try {
    await access('/usr/bin/bash');
    return '/usr/bin/bash';
  } catch {
    return '/bin/sh';
  }
}

/** The unit's own properties: the cgroup limits of the attempt, and a stop that kills the agent and every command. */
function unitArguments(unit: string, limits: z.infer<typeof limitsSchema>) {
  return [
    '--user',
    `--unit=${unit}`,
    '--slice=app.slice',
    '--service-type=exec',
    '--property=Restart=no',
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=5s',
    // A command killed for memory ends alone: the attempt goes on.
    '--property=OOMPolicy=continue',
    `--property=MemoryMax=${Math.floor(limits.memoryGiB * 1024)}M`,
    '--property=MemorySwapMax=0',
    `--property=TasksMax=${limits.processes}`,
    '--property=UMask=0077',
    '--property=StandardOutput=null',
    '--property=StandardError=null',
  ];
}

/**
 * First implementation of the port: one transient unit of the user manager per attempt holds the agent and its commands;
 * each command is a new bubblewrap. `root` is the private directory of the attempts and `factoryRoot` the installation root that no
 * command may see. `shell` is called by the process running INSIDE the unit; everything else by the Control.
 */
export function createInvestigationEnvironment(options: { root: string; factoryRoot: string; stopWaitMs?: number }): InvestigationEnvironmentPort {
  if (!isAbsolute(options.root) || !isAbsolute(options.factoryRoot)) throw new Error('INVESTIGATION_ROOT_INVALID');
  const directoryOf = (attempt: InvestigationAttemptRef) => {
    investigationUnit(attempt);
    return join(options.root, attempt);
  };
  const clonesFile = (attempt: InvestigationAttemptRef) => join(directoryOf(attempt), 'clones.json');
  const readClones = async (attempt: InvestigationAttemptRef) => clonesSchema.parse(JSON.parse(await readFile(clonesFile(attempt), 'utf8')));
  let mounting: Promise<unknown> = Promise.resolve();

  async function prepare(intent: InvestigationIntent, limits: z.infer<typeof limitsSchema>) {
    const directory = directoryOf(intent.attempt);
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    for (const name of ['tmp', 'clones', 'etc', 'empty']) await mkdir(join(directory, name), { mode: 0o700 });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const etc: Record<string, string> = {
      passwd: `triager:x:${uid}:${gid}::${confinedTemporary}:/bin/sh\n`,
      group: `triager:x:${gid}:\n`,
      'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
    };
    for (const name of ownEtc) await writeFile(join(directory, 'etc', name), etc[name]!, { mode: 0o644 });
    await writeFile(clonesFile(intent.attempt), '[]', { mode: 0o600 });
    await writeFile(join(directory, 'environment.json'), JSON.stringify({ version: 1, attempt: intent.attempt, unit: intent.unit, limits }), { mode: 0o600 });
  }

  async function start(intent: InvestigationIntent, limits: z.infer<typeof limitsSchema>, agent: Parameters<InvestigationEnvironmentPort['open']>[1]['agent']) {
    const { stdout, stderr } = await run(
      'systemd-run',
      [
        ...unitArguments(intent.unit, limits),
        '/usr/bin/env',
        '-i',
        ...Object.entries(agent.env).map(([name, value]) => `${name}=${value}`),
        agent.executable,
        ...agent.argv,
      ],
      managerCall,
    );
    const announced = /invocation ID: ([0-9a-f]{32})/.exec(`${stderr}\n${stdout}`)?.[1];
    return announced ?? (await unitState(intent.unit)).InvocationID;
  }

  async function open(intent: InvestigationIntent, request: Parameters<InvestigationEnvironmentPort['open']>[1]): Promise<InvestigationOpened> {
    const limits = limitsSchema.safeParse(request.limits);
    const { agent } = request;
    if (!limits.success) return { status: 'failure', code: 'INVESTIGATION_LIMITS_INVALID' };
    if (!isAbsolute(agent.executable) || !Object.keys(agent.env).every(name => variableName.test(name)))
      return { status: 'failure', code: 'INVESTIGATION_AGENT_INVALID' };
    if (intent.unit !== investigationUnit(intent.attempt) || intent.hostBoot !== (await hostBootNow()))
      return { status: 'failure', code: 'INVESTIGATION_INTENT_STALE' };
    try {
      await prepare(intent, limits.data);
    } catch {
      return { status: 'failure', code: 'INVESTIGATION_DIRECTORY_UNAVAILABLE' };
    }
    try {
      const invocation = await start(intent, limits.data, agent);
      if (!invocation) return { status: 'failure', code: 'INVESTIGATION_START_UNCONFIRMED' };
      return { status: 'success', record: { ...intent, invocation }, clones: join(directoryOf(intent.attempt), 'clones') };
    } catch {
      // The start may or may not have happened: the caller stops by the recorded intent, never retries blindly.
      return { status: 'failure', code: 'INVESTIGATION_START_UNCONFIRMED' };
    }
  }

  async function addClone(attempt: InvestigationAttemptRef, clone: ClonePlacement) {
    const { name } = cloneSchema.parse(clone);
    const source = await realpath(clone.source);
    if (!(await lstat(source)).isDirectory()) throw new Error('INVESTIGATION_CLONE_SOURCE_INVALID');
    const clones = await readClones(attempt);
    const same = clones.find(item => item.name === name);
    if (same && same.source !== source) throw new Error('INVESTIGATION_CLONE_NAME_TAKEN');
    if (!same) {
      const next = `${clonesFile(attempt)}.next`;
      await writeFile(next, JSON.stringify([...clones, { name, source }]), { mode: 0o600 });
      await rename(next, clonesFile(attempt));
    }
    return { path: confinedClone(name) };
  }

  async function shell(attempt: InvestigationAttemptRef): Promise<InvestigationShell> {
    const directory = directoryOf(attempt);
    const environment = environmentSchema.parse(JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8')));
    const own = (await readFile('/proc/self/cgroup', 'utf8')).trim();
    const cgroup = `0::${unitCgroup(environment.unit)}`;
    // Outside the unit a command would survive the stop that was confirmed for the attempt.
    if (own !== cgroup && !own.startsWith(`${cgroup}/`)) throw new Error('INVESTIGATION_SHELL_OUTSIDE_UNIT');
    const usr = '/usr' + sep;
    const factoryRoot = resolve(options.factoryRoot);
    const fixed = {
      temporary: join(directory, 'tmp'),
      etc: join(directory, 'etc'),
      empty: join(directory, 'empty'),
      system: await systemLayout(),
      masked: factoryRoot.startsWith(usr) ? [factoryRoot] : [],
      shell: await hostShell(),
    };
    return {
      temporary: confinedTemporary,
      async exec({ command, cwd = confinedTemporary }) {
        if (!isAbsolute(cwd)) return { status: 'failed', code: 'INVESTIGATION_COMMAND_UNAVAILABLE', output: 'cwd must be an absolute path' };
        return runBounded('bwrap', confinementArguments({ ...fixed, clones: await readClones(attempt) }, command, cwd), {
          timeoutMs: environment.limits.commandSeconds * 1000,
          outputBytes: environment.limits.outputBytes ?? defaultOutputBytes,
          env: { PATH: '/usr/bin:/bin' },
          cwd: '/',
        });
      },
    };
  }

  async function observe(record: InvestigationRecord): Promise<InvestigationStop> {
    const expectedCgroup = unitCgroup(investigationUnit(record.attempt));
    let hostBoot: string;
    try {
      hostBoot = await hostBootNow();
    } catch {
      return { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' };
    }
    if (hostBoot !== record.hostBoot) return stopConfirmation(record, { hostBoot, expectedCgroup, manager: 'unavailable', cgroup: 'unreadable' });
    if (record.unit !== investigationUnit(record.attempt)) return { cessationConfirmed: false, code: 'INVESTIGATION_INVOCATION_MISMATCH' };
    return stopConfirmation(record, { hostBoot, expectedCgroup, manager: await managerFact(record.unit), cgroup: await cgroupFact(expectedCgroup) });
  }

  async function stop(record: InvestigationRecord): Promise<InvestigationStop> {
    let observed = await observe(record);
    if (observed.cessationConfirmed || observed.code === 'INVESTIGATION_INVOCATION_MISMATCH') return observed;
    try {
      // A job for the exact unit of this attempt; the mismatch above already refused any other invocation under its name.
      await run('systemctl', ['--user', '--no-block', 'stop', record.unit], managerCall);
    } catch {
      /* The observation below decides: a manager that did not take the job leaves the stop unconfirmed. */
    }
    const deadline = Date.now() + (options.stopWaitMs ?? 20000);
    for (;;) {
      observed = await observe(record);
      if (observed.cessationConfirmed || Date.now() >= deadline) return observed;
      await delay(100);
    }
  }

  async function close(record: InvestigationRecord): Promise<InvestigationStop> {
    const observed = await observe(record);
    if (!observed.cessationConfirmed) return observed;
    try {
      await run('systemctl', ['--user', 'reset-failed', record.unit], managerCall);
    } catch {
      /* Nothing to reset: the unit ended clean, was collected, or belongs to a previous Host boot. */
    }
    await rm(directoryOf(record.attempt), { recursive: true, force: true });
    return observed;
  }

  return {
    plan: async attempt => ({ attempt, unit: investigationUnit(attempt), hostBoot: await hostBootNow() }),
    open,
    mountClone(attempt, clone) {
      const added = mounting.then(() => addClone(attempt, clone));
      mounting = added.catch(() => undefined);
      return added;
    },
    shell,
    observe,
    stop,
    close,
  };
}
