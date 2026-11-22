import type { PreservationObservation } from '../../contracts/index.js';
import { guestRepositoryDirectory } from './guest-programs.js';
import type { GuestExecRequest, LambdaChannel } from './transport.js';

/**
 * v2 ticket 07 (V2-06, proof G1): the preservation gate's observation. ONE fixed program the host runs in the guest over the boot's
 * channel: the agent chooses neither the program nor its parameters. It reports what the guest's checkout holds (tracked changes,
 * untracked files that are not ignored, stash entries, HEAD) and the tip of the Work branch as `origin` answers `ls-remote` now; the
 * local tracking ref is never read. The remote is the URL the HOST names, not whatever the guest's `origin` points to.
 *
 * Guest-attested: Control confirms the tip with its own read of `origin` before anything counts as preserved. The Git credential reaches
 * `git ls-remote` through the process environment only (`FACTORY_GIT_TOKEN`, an in-memory helper on that one command line; V2-24).
 * Not run in a real guest yet: exercised with the local bash and git against a temporary clone.
 */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const branchPattern = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export type PreservationRequest = { remote: string; branch: string; token: string; directory?: string };

/** `null`: a value is not one the host places in a script. */
export function preservationGateProgram({ remote, branch, token, directory = guestRepositoryDirectory }: PreservationRequest): GuestExecRequest | null {
  if (!branchPattern.test(branch) || /[\u0000-\u001f\u007f]/.test(remote + directory) || remote.startsWith('-')) return null;
  const helper = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$FACTORY_GIT_TOKEN"; }; f';
  const ref = `refs/heads/${branch}`;
  return {
    program: 'preservation-gate',
    environment: { FACTORY_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
    script: [
      'set -u',
      `cd ${quote(directory)} || exit 3`,
      'head=$(git rev-parse --verify --quiet HEAD) || exit 3',
      // One line per path (odd names are quoted by porcelain v1); `??` are untracked files that are not ignored.
      'status=$(git status --porcelain=v1 --untracked-files=all) || exit 3',
      "modified=$(printf '%s\\n' \"$status\" | grep -c -v -e '^??' -e '^$')",
      "untracked=$(printf '%s\\n' \"$status\" | grep -c '^??')",
      'stashes=$(git stash list | grep -c .)',
      `if listed=$(git -c credential.helper= -c credential.helper=${quote(helper)} ls-remote -- ${quote(remote)} ${quote(ref)} 2>/dev/null); then`,
      `  tip=$(printf '%s\\n' "$listed" | awk -v ref=${quote(ref)} '$2 == ref { print $1; exit }')`,
      '  remote=${tip:-absent}',
      'else remote=unavailable; fi',
      'printf \'GATE head=%s modified=%s untracked=%s stashes=%s remote=%s\\n\' "$head" "$modified" "$untracked" "$stashes" "$remote"',
    ].join('\n'),
  };
}

const answer = /^GATE head=([0-9a-f]{40,64}) modified=([0-9]{1,9}) untracked=([0-9]{1,9}) stashes=([0-9]{1,9}) remote=([0-9a-f]{40,64}|absent|unavailable)$/m;
/** The observation of the boot behind `channel`. Anything but the program's one answer line is no observation (never a guessed one). */
export async function observeLambdaPreservation(channel: LambdaChannel, request: PreservationRequest): Promise<PreservationObservation> {
  const program = preservationGateProgram(request);
  if (!program) return { status: 'unavailable', code: 'PRESERVATION_REQUEST_INVALID' };
  const result = await channel.exec(program);
  const match = result.status === 'exited' && result.exitCode === 0 ? answer.exec(result.stdout) : null;
  if (!match) return { status: 'unavailable', code: 'PRESERVATION_OBSERVATION_FAILED' };
  const remote = match[5]!;
  return {
    status: 'observed',
    head: match[1]!,
    modified: Number(match[2]),
    untracked: Number(match[3]),
    stashes: Number(match[4]),
    remote: remote === 'absent' ? { state: 'absent' } : remote === 'unavailable' ? { state: 'unavailable' } : { state: 'present', sha: remote },
  };
}
