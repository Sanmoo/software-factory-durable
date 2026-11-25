import { execFile } from 'node:child_process';
import type { Diagnostic } from '../contracts/index.js';

/**
 * Spec #68 §2 (installation validation): what the Host needs before a `triage` block turns on. The Investigation Environment is a
 * bubblewrap confinement inside a transient user systemd unit, and the Triager reads code with `git` and `rg`.
 */
export const triagePrerequisites = ['linux', 'bwrap', 'unprivileged-namespaces', 'systemd-user', 'git', 'rg'] as const;
export type TriagePrerequisite = (typeof triagePrerequisites)[number];

/** The prerequisites the Host lacks, in the order above (empty: the Host can triage). Injectable: tests never depend on the real Host. */
export type TriageHostProbe = () => Promise<TriagePrerequisite[]>;

/**
 * Whether Triage is on in this installation: `off` when no Ticket source carries a `triage` block (every schema 1 or 2 config.yaml),
 * `unavailable` when a source asks for it and the Host lacks a prerequisite, `on` otherwise.
 */
export type TriageAvailability = { status: 'off' } | { status: 'on' } | { status: 'unavailable'; missing: TriagePrerequisite[] };

type Outcome = 'succeeded' | 'failed' | 'absent';

/** Probes the real Host with the PATH of `environment` (no shell). Nothing is created, started or written. */
export function createTriageHostProbe({
  environment = process.env,
  platform = process.platform,
}: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): TriageHostProbe {
  const run = (executable: string, args: string[]) =>
    new Promise<Outcome>(resolve => {
      execFile(executable, args, { env: environment, encoding: 'utf8' }, error =>
        resolve(!error ? 'succeeded' : typeof error.code === 'number' ? 'failed' : 'absent'),
      );
    });
  return async () => {
    const [bwrap, systemd, git, rg] = await Promise.all([
      run('bwrap', ['--version']),
      // Answers only when the user manager of this account is reachable (the unit of each attempt is a transient user unit).
      run('systemctl', ['--user', 'show-environment']),
      run('git', ['--version']),
      run('rg', ['--version']),
    ]);
    // The confinement of one command, reduced to nothing: it only succeeds where an unprivileged user may create the namespaces.
    const namespaces = bwrap === 'absent' ? 'absent' : await run('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']);
    const lacking: Record<TriagePrerequisite, boolean> = {
      linux: platform !== 'linux',
      bwrap: bwrap === 'absent',
      'unprivileged-namespaces': namespaces === 'failed',
      'systemd-user': systemd !== 'succeeded',
      git: git === 'absent',
      rg: rg === 'absent',
    };
    return triagePrerequisites.filter(item => lacking[item]);
  };
}

/** `sources`: how many Ticket sources carry a `triage` block. The Host is probed only when one does. */
export async function triageAvailability(sources: number, probe: TriageHostProbe): Promise<TriageAvailability> {
  if (sources === 0) return { status: 'off' };
  const missing = await probe();
  return missing.length === 0 ? { status: 'on' } : { status: 'unavailable', missing };
}

/** The installation diagnostic of a configured Triage (none while it is off: nothing was asked of the Host). */
export function triageDiagnostics(availability: TriageAvailability): Diagnostic[] {
  if (availability.status === 'off') return [];
  const on = availability.status === 'on';
  return [
    {
      id: 'triage:prerequisites',
      status: on ? 'ok' : 'blocked',
      message: on
        ? 'The Host has what the Investigation Environment needs (Linux, bwrap, unprivileged namespaces, user systemd, git, rg).'
        : `Triage is off in every Ticket source: the Host lacks ${availability.missing.join(', ')}. Works are admitted as without the triage block.`,
      nextStep: 'Administrator provides the named Host prerequisite, or the operator removes the `triage` block; nothing is installed or repaired.',
    },
  ];
}

/**
 * The Ticket sources where Triage is on: the ones carrying a `triage` block, and none while the Host lacks a prerequisite. The only
 * reading of "is Triage on for this source" (the configured block alone never starts a Triage).
 */
export function triageSources<Source extends { triage?: unknown }>(effective: {
  triage: TriageAvailability;
  ticketSources: readonly Source[];
}): (Source & { triage: NonNullable<Source['triage']> })[] {
  if (effective.triage.status !== 'on') return [];
  return effective.ticketSources.filter((source): source is Source & { triage: NonNullable<Source['triage']> } => source.triage !== undefined);
}
