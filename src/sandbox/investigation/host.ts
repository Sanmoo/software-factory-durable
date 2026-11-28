import { execFile } from 'node:child_process';

/**
 * Installation validation: what the Host needs before an Investigation Environment can exist on it. The environment is a
 * bubblewrap confinement inside a transient user systemd unit, and the Triager reads code in it with `git` and `rg`.
 */
const investigationPrerequisites = ['linux', 'bwrap', 'unprivileged-namespaces', 'systemd-user', 'git', 'rg'] as const;
export type InvestigationPrerequisite = (typeof investigationPrerequisites)[number];

/** The prerequisites the Host lacks, in the order above (empty: the Host can investigate). Injectable: tests never depend on the real Host. */
export type InvestigationHostProbe = () => Promise<InvestigationPrerequisite[]>;

type Outcome = 'succeeded' | 'failed' | 'absent';

/** Probes the real Host with the PATH of `environment` (no shell). Nothing is created, started or written. */
export function createInvestigationHostProbe({
  environment = process.env,
  platform = process.platform,
}: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): InvestigationHostProbe {
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
    const lacking: Record<InvestigationPrerequisite, boolean> = {
      linux: platform !== 'linux',
      bwrap: bwrap === 'absent',
      'unprivileged-namespaces': namespaces === 'failed',
      'systemd-user': systemd !== 'succeeded',
      git: git === 'absent',
      rg: rg === 'absent',
    };
    return investigationPrerequisites.filter(item => lacking[item]);
  };
}
