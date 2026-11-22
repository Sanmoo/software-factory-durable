import type { GuestExecRequest } from './transport.js';

/**
 * v2 ticket 04: the FIXED programs the host runs in the guest over the channel during a boot's life. Their text is the host's; only
 * validated values are placed in it, single-quoted, and no secret ever is: the Git credential reaches `git` through the process
 * environment (`FACTORY_GIT_TOKEN`), is used by an in-memory credential helper given on the command line of that one `git` process and is
 * written to no file (V2-24). None of these programs ran in a real guest yet.
 */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** The MVP guest path contract (spec §7.3): tools and worker prompts name the checkout as `/workspace/checkout`. */
export const guestRepositoryDirectory = '/workspace/checkout';
const commitPattern = /^[0-9a-f]{40,64}$/;
const branchPattern = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

/**
 * Waits for the start script (launched by the run hook) to finish: `dockerd` up and the declared Docker images pulled by digest. Prints
 * the marker line `boot-done pull=<0|1>`; exit 3 when the marker never appeared.
 */
export const bootReadyProgram = (waitSeconds = 180): GuestExecRequest => ({
  program: 'boot-ready',
  script: [
    `for attempt in $(seq 1 ${waitSeconds}); do [ -f /var/log/factory-done ] && break; sleep 1; done`,
    '[ -f /var/log/factory-done ] || { echo boot-not-done; exit 3; }',
    'cat /var/log/factory-done',
  ].join('\n'),
});
export const bootReady = (stdout: string): { pulled: boolean } | null => {
  const match = /^boot-done pull=([01])$/m.exec(stdout);
  return match ? { pulled: match[1] === '0' } : null;
};

export type CloneRequest = { remote: string; commit: string; branch?: string; token: string; directory?: string };
/**
 * Clones `origin` into the guest and leaves the starting commit checked out (on the Work branch when one is given, detached otherwise).
 * Prints `HEAD <sha>`. The remote URL carries no credential. `null`: a value is not one the host places in a script.
 */
export function cloneProgram({ remote, commit, branch, token, directory = guestRepositoryDirectory }: CloneRequest): GuestExecRequest | null {
  if (
    !commitPattern.test(commit) ||
    (branch !== undefined && !branchPattern.test(branch)) ||
    /[\u0000-\u001f\u007f]/.test(remote + directory) ||
    remote.startsWith('-')
  )
    return null;
  const helper = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$FACTORY_GIT_TOKEN"; }; f';
  return {
    program: 'clone',
    environment: { FACTORY_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
    script: [
      'set -eu',
      `directory=${quote(directory)}`,
      '[ ! -e "$directory" ] || { echo "The guest already has a repository directory" >&2; exit 4; }',
      `git -c credential.helper= -c credential.helper=${quote(helper)} clone --quiet --no-checkout -- ${quote(remote)} "$directory"`,
      'cd "$directory"',
      branch === undefined ? `git checkout --quiet --detach ${quote(commit)}` : `git checkout --quiet -B ${quote(branch)} ${quote(commit)}`,
      'printf \'HEAD %s\\n\' "$(git rev-parse HEAD)"',
    ].join('\n'),
  };
}
export const clonedHead = (stdout: string): string | null => /^HEAD ([0-9a-f]{40,64})$/m.exec(stdout)?.[1] ?? null;

/** The guest's own boot logs, bounded: the only guest evidence of a boot is what the host reads over the channel while it lives (V2-34). */
export const evidenceFiles = [
  '/var/log/factory-done',
  '/var/log/factory-start.log',
  '/var/log/factory-pull.log',
  '/var/log/factory-dockerd.log',
  '/var/log/factory-sshd.log',
  '/var/log/factory-websocat.log',
] as const;
export const evidenceProgram = (): GuestExecRequest => ({
  program: 'evidence',
  script: `for file in ${evidenceFiles.join(' ')}; do printf '===== %s\\n' "$file"; tail -c 65536 "$file" 2>&1 || true; printf '\\n'; done`,
});
