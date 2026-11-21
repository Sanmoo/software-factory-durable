import { lostMarkerPattern } from '../../contracts/index.js';
import { guestRepositoryDirectory } from './guest-programs.js';
import type { GuestExecRequest, LambdaChannel } from './transport.js';

/**
 * v2 ticket 12 (V2-16, proof G4): the loss marker of a boot. When the service ends the MicroVM it calls the guest's terminate hook; the
 * hook takes NOTHING from its caller: it only pulls a trigger (a FIFO that root alone writes). What answers the trigger is a holder, a
 * small process the HOST starts in the guest over the boot's channel with everything fixed by the host: the remote, the marker ref
 * (`refs/factory/lost/<work>/<boot>`) and the directory. On the trigger it pushes the committed `HEAD` to that ref, once, and exits.
 *
 * Credential (V2-24): the holder is a command the host runs over the channel with the Builder's reduced token in its explicit process
 * environment (`FACTORY_GIT_TOKEN`), used by an in-memory credential helper on the one `git push` command line. It is written to no
 * file, script, remote URL or hook payload, and there is no deploy key. It is the SAME grant the Builder's own commands receive, with
 * the same life: the host arms the holder when the grant is delivered, replaces it at each renewal and ends it at the withdrawal. A boot
 * whose grant was withdrawn (held Execution, between activations) has no holder: its death leaves no marker. That is a limit, not an error.
 *
 * Best effort by construction. Not covered, and never treated as a failure of anything: files without a commit, a push slower than the
 * hook's wait, an unreachable remote, an expired or revoked token, a death the service does not announce through the hook. The marker
 * never counts as preservation: only Control's own read of the Work BRANCH on `origin` does (ticket 07).
 * Not run in a real guest yet: exercised with the local bash, git and python3.
 */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** The guest paths the start script creates: the trigger (root writes, anyone reads) and the `builder` user's state directory. */
export const lossMarkerPaths = Object.freeze({ fifo: '/run/factory/terminate', state: '/run/factory/marker' });
export type LossMarkerPaths = { fifo: string; state: string };
/** The push must end inside the terminate hook's wait (45 s of the service's 60 s). */
const pushSeconds = 40;

const endHolder = [
  'old=$(cat "$state/holder.pid" 2>/dev/null) || old=',
  'case "$old" in \'\'|*[!0-9]*) ;; *) kill -- "-$old" 2>/dev/null || kill "$old" 2>/dev/null; ended=1 ;; esac',
  'rm -f "$state/holder.pid"'];

// The holder itself. No single quote in it: it travels as ONE single-quoted word, and every value reaches it through the environment.
const holder = [
  'echo $$ > "$FACTORY_MARKER_STATE/holder.pid"',
  // Blocks until root opens the trigger for writing. Anything but the hook's one line is no trigger.
  'IFS= read -r line < "$FACTORY_MARKER_FIFO" || exit 0',
  '[ "$line" = terminate ] || exit 0',
  'cd "$FACTORY_MARKER_DIRECTORY" && head=$(git rev-parse --verify --quiet HEAD) && ' +
    `timeout ${pushSeconds} git -c credential.helper= -c "credential.helper=$FACTORY_MARKER_HELPER" push --quiet --force -- "$FACTORY_MARKER_REMOTE" "$head:$FACTORY_MARKER_REF"`,
  'echo "push=$?" > "$FACTORY_MARKER_STATE/done"'].join('\n');

export type LossMarkerRequest = { remote: string; ref: string; token: string; directory?: string; paths?: LossMarkerPaths };
/** `null`: a value is not one the host places in a script (the ref must be a marker ref, never a branch). */
export function armLossMarkerProgram({ remote, ref, token, directory = guestRepositoryDirectory, paths = lossMarkerPaths }: LossMarkerRequest): GuestExecRequest | null {
  if (!lostMarkerPattern.test(ref) || /[\u0000-\u001f\u007f]/.test(remote + directory + paths.fifo + paths.state) || remote.startsWith('-')) return null;
  const helper = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$FACTORY_GIT_TOKEN"; }; f';
  return { program: 'loss-marker-arm', environment: { FACTORY_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }, script: [
    'set -u',
    `state=${quote(paths.state)}; fifo=${quote(paths.fifo)}`,
    '[ -p "$fifo" ] && [ -d "$state" ] && [ -w "$state" ] || { echo "MARKER unavailable"; exit 0; }',
    // One holder per boot: a renewed grant replaces the holder of the previous one.
    ...endHolder,
    'rm -f "$state/done"',
    `export FACTORY_MARKER_STATE="$state" FACTORY_MARKER_FIFO="$fifo" FACTORY_MARKER_DIRECTORY=${quote(directory)} FACTORY_MARKER_REMOTE=${quote(remote)} FACTORY_MARKER_REF=${quote(ref)} FACTORY_MARKER_HELPER=${quote(helper)}`,
    // Its own session: it outlives this connection and nothing of it is attached to the channel.
    `setsid sh -c ${quote(holder)} < /dev/null > /dev/null 2>&1 &`,
    'echo $! > "$state/holder.pid"',
    'echo "MARKER armed"'].join('\n') };
}
export function disarmLossMarkerProgram(paths: LossMarkerPaths = lossMarkerPaths): GuestExecRequest | null {
  if (/[\u0000-\u001f\u007f]/.test(paths.state)) return null;
  return { program: 'loss-marker-disarm', script: ['set -u', `state=${quote(paths.state)}`, 'ended=0', ...endHolder, 'echo "MARKER disarmed"'].join('\n') };
}

/** Starts (or replaces) the holder of the boot behind `channel`. `unavailable` is never an error of the boot: the marker is best effort. */
export async function armLossMarker(channel: LambdaChannel, request: LossMarkerRequest): Promise<{ status: 'armed' } | { status: 'unavailable'; code: string }> {
  const program = armLossMarkerProgram(request);
  if (!program) return { status: 'unavailable', code: 'LOSS_MARKER_REQUEST_INVALID' };
  const result = await channel.exec(program);
  if (result.status !== 'exited' || result.exitCode !== 0) return { status: 'unavailable', code: 'LOSS_MARKER_CHANNEL_FAILED' };
  return /^MARKER armed$/m.test(result.stdout) ? { status: 'armed' } : { status: 'unavailable', code: 'LOSS_MARKER_GUEST_UNAVAILABLE' };
}
/** Ends the holder: from here the terminate hook finds nothing to trigger and no token of this boot remains in a guest process. */
export async function disarmLossMarker(channel: LambdaChannel, paths: LossMarkerPaths = lossMarkerPaths): Promise<{ status: 'disarmed' } | { status: 'unavailable'; code: string }> {
  const program = disarmLossMarkerProgram(paths);
  if (!program) return { status: 'unavailable', code: 'LOSS_MARKER_REQUEST_INVALID' };
  const result = await channel.exec(program);
  return result.status === 'exited' && result.exitCode === 0 && /^MARKER disarmed$/m.test(result.stdout) ? { status: 'disarmed' } : { status: 'unavailable', code: 'LOSS_MARKER_CHANNEL_FAILED' };
}
