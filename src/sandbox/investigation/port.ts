/**
 * Spec #68 §6: the port of the Investigation Environment. One environment per attempt of a Triage request, local to the Control's Host
 * in every installation. It never goes through `sandbox.adapter` nor `SandboxCapabilities`: that selector is the lifecycle of a Work's
 * environment. Types only; the first implementation is `systemd.ts` (bubblewrap inside a transient unit of the user manager).
 */

/** Names the attempt: lowercase letters, digits and single hyphens, at most 64. Never reused: the unit name is derived from it. */
export type InvestigationAttemptRef = string;

/** `triager.environment` of the installation (spec §2), plus the output cut of one command. */
export type InvestigationLimits = {
  memoryGiB: number;
  processes: number;
  commandSeconds: number;
  /** Bytes of combined stdout and stderr kept from one command; absent means `defaultOutputBytes`. */
  outputBytes?: number;
};

/** What the Control records BEFORE the environment starts: the unit and the Host boot it will start under. */
export type InvestigationIntent = { attempt: InvestigationAttemptRef; unit: string; hostBoot: string };

/** What the Control records right after the start. An intent without `invocation` is a start whose outcome was never recorded. */
export type InvestigationRecord = InvestigationIntent & { invocation?: string };

/**
 * The agent process the environment contains. It stays outside the confinement (it needs the model and the MCP Profiles). It starts
 * with exactly `env`, which travels on a command line: never a secret there; a credential reaches the agent by its own channel.
 */
export type InvestigationAgent = { executable: string; argv: readonly string[]; env: Readonly<Record<string, string>> };

export type InvestigationOpened =
  | {
      status: 'success';
      record: InvestigationRecord & { invocation: string };
      /** Host directory of the attempt where the caller creates the clones it then mounts; removed by `close`. */
      clones: string;
    }
  | { status: 'failure'; code: string };

export type StopEvidence = 'unit-inactive' | 'host-rebooted';
export type StopRefusal =
  | 'INVESTIGATION_MANAGER_UNAVAILABLE'
  | 'INVESTIGATION_INVOCATION_MISMATCH'
  | 'INVESTIGATION_UNIT_ACTIVE'
  | 'INVESTIGATION_CGROUP_POPULATED'
  | 'INVESTIGATION_CGROUP_UNREADABLE';

/** Cessation of the whole attempt (agent and commands). Unconfirmed never frees Triage capacity (spec §5). */
export type InvestigationStop = { cessationConfirmed: true; evidence: StopEvidence } | { cessationConfirmed: false; code: StopRefusal };

export type InvestigationCommandResult =
  | {
      status: 'completed';
      exitCode: number | null;
      signal: string | null;
      output: string;
      /** Present when the output was cut: tells how much was kept. */
      notice?: string;
    }
  /** The command was killed; the environment is still open and the next command runs. */
  | { status: 'failed'; code: 'INVESTIGATION_COMMAND_TIMEOUT' | 'INVESTIGATION_COMMAND_UNAVAILABLE'; output: string; notice?: string };

/** Runs the Triager's commands. Each one is a new confinement over the attempt's directories; there is no long-lived shell. */
export interface InvestigationShell {
  /** Where a command writes: the attempt's private temporary space, as the command sees it. */
  readonly temporary: string;
  exec(request: { command: string; cwd?: string }): Promise<InvestigationCommandResult>;
}

export interface InvestigationEnvironmentPort {
  /** Pure derivation plus the Host boot read: nothing is created. The Control records the result, then calls `open`. */
  plan(attempt: InvestigationAttemptRef): Promise<InvestigationIntent>;
  open(intent: InvestigationIntent, options: { limits: InvestigationLimits; agent: InvestigationAgent }): Promise<InvestigationOpened>;
  /** Mounts a Host directory read-only for the next commands. Returns the path the commands see. */
  mountClone(attempt: InvestigationAttemptRef, clone: { name: string; source: string }): Promise<{ path: string }>;
  /** The shell of an open attempt. Under systemd it only runs inside the attempt's unit, so that the stop covers every command. */
  shell(attempt: InvestigationAttemptRef): Promise<InvestigationShell>;
  /** Read-only. */
  observe(record: InvestigationRecord): Promise<InvestigationStop>;
  /** Asks the recorded invocation to stop and observes until confirmed or the wait ends. Never stops another invocation. */
  stop(record: InvestigationRecord): Promise<InvestigationStop>;
  /** Removes the attempt's directories (temporary space and clones). Refused while the stop is unconfirmed. */
  close(record: InvestigationRecord): Promise<InvestigationStop>;
}

export const defaultOutputBytes = 65536;
export const attemptPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const investigationUnit = (attempt: InvestigationAttemptRef) => {
  if (attempt.length > 64 || !attemptPattern.test(attempt)) throw new Error('INVESTIGATION_ATTEMPT_INVALID');
  return `factory-triage-${attempt}.service`;
};
