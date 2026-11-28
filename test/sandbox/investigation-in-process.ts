// The Investigation Environment port in process, for every test that is not about the real mechanism (the
// Control flows). No bubblewrap and no systemd: the agent is an ordinary child process and each command an ordinary `/bin/sh -c` in the
// attempt's temporary directory, with the same time and output bounds as the real port. It confines NOTHING; the confinement itself is
// proved only by test/sandbox/investigation-environment.test.ts. The state lives in the instance: keep one instance across a simulated
// Control restart, as the Host's user manager outlives the Control.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runBounded } from '../../src/sandbox/investigation/command.js';
import {
  defaultOutputBytes,
  investigationUnit,
  stopConfirmation,
  type InvestigationAgent,
  type InvestigationAttemptRef,
  type InvestigationEnvironmentPort,
  type InvestigationLimits,
  type InvestigationRecord,
  type InvestigationStop,
} from '../../src/sandbox/index.js';

type Running = { stop(): Promise<void> };
type Attempt = { invocation: string; limits: InvestigationLimits; directory: string; clones: Map<string, string>; agent: Running; active: boolean };

/** The default agent start: a real child process in its own group, killed whole at the stop. */
function spawnAgent(agent: InvestigationAgent): Running {
  const child = spawn(agent.executable, [...agent.argv], { env: { ...agent.env }, stdio: 'ignore', detached: true });
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return {
    async stop() {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await exited;
    },
  };
}

export type InProcessInvestigationEnvironment = InvestigationEnvironmentPort & {
  controls: {
    /** While withheld, a stopped attempt reads as an inactive unit whose cgroup still has processes: never confirmed. */
    withholdStopConfirmation(): void;
    releaseStopConfirmation(): void;
    /** `false`: the manager does not answer, so nothing is confirmed and nothing is stopped. */
    managerAnswers(answers: boolean): void;
    /** The Host restarted: every earlier record now confirms as `host-rebooted`. */
    rebootHost(): void;
    /** Attempts whose agent was started and not stopped. */
    active(): InvestigationAttemptRef[];
    /** Every `open` and `stop` call, in order. */
    calls(): readonly string[];
  };
};

export function createInProcessInvestigationEnvironment(options: {
  root: string;
  /** Replaces the child process (for an agent the test runs itself). */
  launch?: (agent: InvestigationAgent, attempt: InvestigationAttemptRef) => Running;
}): InProcessInvestigationEnvironment {
  const attempts = new Map<InvestigationAttemptRef, Attempt>();
  const calls: string[] = [];
  let hostBoot = `in-process-${randomBytes(4).toString('hex')}`;
  let withheld = false;
  let answers = true;
  const known = (attempt: InvestigationAttemptRef) => {
    const found = attempts.get(attempt);
    if (!found) throw new Error('INVESTIGATION_ATTEMPT_UNKNOWN');
    return found;
  };

  async function observe(record: InvestigationRecord): Promise<InvestigationStop> {
    const attempt = attempts.get(record.attempt);
    return stopConfirmation(record, {
      hostBoot,
      expectedCgroup: record.unit,
      manager: answers ? { activeState: attempt?.active ? 'active' : 'inactive', invocation: attempt?.invocation ?? '', controlGroup: '' } : 'unavailable',
      cgroup: attempt && withheld ? 'populated' : 'absent',
    });
  }

  return {
    plan: async attempt => ({ attempt, unit: investigationUnit(attempt), hostBoot }),
    async open(intent, { limits, agent }) {
      calls.push(`open ${intent.attempt}`);
      if (attempts.has(intent.attempt) || intent.hostBoot !== hostBoot) return { status: 'failure', code: 'INVESTIGATION_INTENT_STALE' };
      const directory = join(await realpath(options.root), intent.attempt);
      for (const name of ['tmp', 'clones']) await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
      const invocation = randomBytes(16).toString('hex');
      const running = (options.launch ?? spawnAgent)(agent, intent.attempt);
      attempts.set(intent.attempt, { invocation, limits, directory, clones: new Map(), agent: running, active: true });
      return { status: 'success', record: { ...intent, invocation }, clones: join(directory, 'clones') };
    },
    async mountClone(attempt, clone) {
      const source = await realpath(clone.source);
      const { clones } = known(attempt);
      if (clones.has(clone.name) && clones.get(clone.name) !== source) throw new Error('INVESTIGATION_CLONE_NAME_TAKEN');
      clones.set(clone.name, source);
      // Not mounted anywhere: the commands read the Host path itself.
      return { path: source };
    },
    async shell(attempt) {
      const state = known(attempt);
      const temporary = join(state.directory, 'tmp');
      return {
        temporary,
        async exec({ command, cwd = temporary }) {
          if (!state.active) return { status: 'failed', code: 'INVESTIGATION_COMMAND_UNAVAILABLE', output: '' };
          return runBounded('/bin/sh', ['-c', command], {
            timeoutMs: state.limits.commandSeconds * 1000,
            outputBytes: state.limits.outputBytes ?? defaultOutputBytes,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temporary, TMPDIR: temporary, LANG: 'C.UTF-8', GIT_PAGER: 'cat', PAGER: 'cat' },
            cwd,
          });
        },
      };
    },
    observe,
    async stop(record) {
      calls.push(`stop ${record.attempt}`);
      const observed = await observe(record);
      if (observed.cessationConfirmed || observed.code !== 'INVESTIGATION_UNIT_ACTIVE') return observed;
      const attempt = known(record.attempt);
      await attempt.agent.stop();
      attempt.active = false;
      return observe(record);
    },
    async close(record) {
      const observed = await observe(record);
      if (!observed.cessationConfirmed) return observed;
      const attempt = attempts.get(record.attempt);
      if (attempt) await rm(attempt.directory, { recursive: true, force: true });
      return observed;
    },
    controls: {
      withholdStopConfirmation: () => void (withheld = true),
      releaseStopConfirmation: () => void (withheld = false),
      managerAnswers: value => void (answers = value),
      rebootHost() {
        hostBoot = `in-process-${randomBytes(4).toString('hex')}`;
        for (const attempt of attempts.values()) {
          attempt.active = false;
          void attempt.agent.stop();
        }
      },
      active: () => [...attempts].filter(([, attempt]) => attempt.active).map(([name]) => name),
      calls: () => calls,
    },
  };
}
