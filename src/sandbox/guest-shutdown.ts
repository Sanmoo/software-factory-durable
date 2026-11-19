import { join } from 'node:path';
import { z } from 'zod';
import { metadata, type BootRef } from './lifecycle.js';

/**
 * Ticket 47: how the guest root filesystem was left by the stop of a boot. `clean` = the guest itself stopped its containers and processes,
 * synced and remounted its ext4 root READ-ONLY before the VMM was closed (the disk is consistent whatever happens to the VMM afterwards).
 * `forced` = anything else (finalization failed or ran out of the grace period; no record: never operational, crash, kill, host loss).
 */
export type GuestStopResult = 'clean' | 'forced';
export const guestStopReasons = ['GUEST_ROOT_READ_ONLY', 'GUEST_FINALIZATION_TIMEOUT', 'GUEST_FINALIZATION_FAILED',
  'NO_GUEST_STOP_RECORD'] as const;
export type GuestStopReason = typeof guestStopReasons[number];
export type GuestStop = { result: GuestStopResult; reason: GuestStopReason };
const bootRef = z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const guestStopSchema = z.strictObject({ version: z.literal(1), boot: bootRef, result: z.enum(['clean', 'forced']),
  reason: z.enum(guestStopReasons) });
/** Name of the per-boot record written by the adapter when it stops its VM (never by a worker or the guest). */
export const guestStopRecord = 'guest-stop.json';

/** Exit status of the guest script when the root filesystem is verified read-only (the only `clean` outcome). */
const cleanExit = 0;

/**
 * Ticket 47: the FIXED guest-only clean stop, run as its own guest exec when the VM is stopped (Gondolin 0.14 cannot terminate a running
 * exec, so a Gradle/Docker command of a worker may still be writing: this script stops it from inside). Never executed on the host.
 *  1. Docker containers get a bounded `docker stop` (their own graceful stop), best effort.
 *  2. Every guest process except PID 1 (sandboxd), the Gondolin helpers (sandboxfs/ssh/ingress), kernel threads and this script's own
 *     ancestry gets SIGTERM (dockerd, Gradle daemons, the worker's running commands), then SIGKILL after the bounded wait.
 *  3. `sync`, then `mount -o remount,ro /`; if a writer still holds the root, the kernel emergency sync + read-only remount (sysrq s, u).
 *  4. Exit 0 only when /proc/mounts shows the ext4 root read-only (ext4 is then marked clean on disk); otherwise nonzero.
 * `budgetSeconds` is the whole exec budget (the adapter's share of `shutdownGraceSeconds`); the waits are fractions of it.
 */
export function guestShutdownScript(budgetSeconds: number): string {
  if (!Number.isSafeInteger(budgetSeconds) || budgetSeconds < 1) throw new Error('INVALID_GUEST_SHUTDOWN_BUDGET');
  const dockerSeconds = Math.max(1, Math.floor(budgetSeconds * 0.3));
  const termTicks = Math.max(5, Math.floor(budgetSeconds * 3)); // tenths of a second: 30% of the budget
  return `set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
keep=" 1 $$ "
pid=$$
while test "$pid" -gt 1; do
  IFS= read -r info < "/proc/$pid/stat" || break
  fields=\${info##*) }
  set -f; set -- $fields; set +f
  test "$#" -ge 2 || break
  case "$2" in ''|*[!0-9]*) break;; esac
  keep="$keep$2 "
  pid=$2
done
candidates() {
  out=
  for dir in /proc/[0-9]*; do
    p=\${dir#/proc/}
    case "$keep" in *" $p "*) continue;; esac
    exe=$(readlink "$dir/exe" 2>/dev/null) || continue
    case "$exe" in /usr/bin/sandboxd|/usr/bin/sandboxfs|/usr/bin/sandboxssh|/usr/bin/sandboxingress) continue;; esac
    out="$out $p"
  done
}
if test -x /usr/bin/docker; then
  ids=$(timeout ${dockerSeconds} docker ps -q 2>/dev/null) || ids=
  valid=
  for id in $ids; do
    case "$id" in *[!0-9a-f]*) ;; *) valid="$valid $id";; esac
  done
  test -z "$valid" || timeout ${dockerSeconds} docker stop -t ${Math.max(1, dockerSeconds - 1)} $valid > /dev/null 2>&1 || true
fi
candidates
test -z "$out" || kill -TERM $out 2> /dev/null || true
ticks=0
while :; do
  candidates
  test -n "$out" || break
  test "$ticks" -lt ${termTicks} || break
  sleep 0.1
  ticks=$((ticks + 1))
done
if test -n "$out"; then
  kill -KILL $out 2> /dev/null || true
  ticks=0
  while :; do
    candidates
    test -n "$out" || break
    test "$ticks" -lt 20 || break
    sleep 0.1
    ticks=$((ticks + 1))
  done
fi
sync
if ! mount -o remount,ro / 2> /dev/null; then
  if test -w /proc/sysrq-trigger; then
    echo s > /proc/sysrq-trigger
    echo u > /proc/sysrq-trigger
  fi
fi
ticks=0
while :; do
  ro=no
  while read -r device target type options rest; do
    if test "$target" = / && test "$type" = ext4; then
      case ",$options," in *,ro,*) ro=yes;; *) ro=no;; esac
    fi
  done < /proc/mounts
  test "$ro" = no || break
  test "$ticks" -lt 30 || exit 3
  sleep 0.1
  ticks=$((ticks + 1))
done
sync
exit ${cleanExit}`;
}

type GuestExec = (argv: string[], options: { signal: AbortSignal; stdout: 'ignore'; stderr: 'ignore' }) => PromiseLike<{ exitCode: number }>;

/**
 * Ticket 47: runs the clean stop in the guest within `graceSeconds` (80% of it: the rest is left to evidence publication and the VMM close;
 * the manager kills the whole unit at `shutdownGraceSeconds` anyway) and classifies it. Never throws; the caller closes the VMM afterwards
 * (the forced part of every stop, harmless once the root is read-only).
 */
export async function stopGuestCleanly(exec: GuestExec, graceSeconds: number): Promise<GuestStop> {
  const budgetMs = Math.max(1, Math.floor(graceSeconds * 800));
  const signal = AbortSignal.timeout(budgetMs);
  try {
    const result = await exec(['/bin/sh', '-c', guestShutdownScript(Math.max(1, Math.floor(budgetMs / 1000)))], { signal, stdout: 'ignore', stderr: 'ignore' });
    return result.exitCode === cleanExit ? { result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' } : { result: 'forced', reason: 'GUEST_FINALIZATION_FAILED' };
  } catch {
    return { result: 'forced', reason: signal.aborted ? 'GUEST_FINALIZATION_TIMEOUT' : 'GUEST_FINALIZATION_FAILED' };
  }
}

/** Ticket 47: how `boot` was stopped, from its adapter record; no (valid, correlated) record = an abrupt end, never a guessed clean stop. */
export async function readGuestStop(bootDirectory: string, boot: BootRef): Promise<GuestStop> {
  try {
    const record = await metadata(join(bootDirectory, guestStopRecord), guestStopSchema);
    if (record.boot === boot) return { result: record.result, reason: record.reason };
  } catch { /* Missing, unsafe or uncorrelated evidence is an abrupt end. */ }
  return { result: 'forced', reason: 'NO_GUEST_STOP_RECORD' };
}
