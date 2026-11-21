import { randomUUID } from 'node:crypto';
import { effectDescriptionLimit, type ChannelDropOutcome } from '../../contracts/index.js';
import type { BootRef } from '../lifecycle.js';
import type { EnvironmentRef } from '../prepare.js';
import { serveReadTools } from '../read-tools.js';
import { contextSchema, type GuestOwner, type QualifiedProfileOrigin, type ReadBinding, type ToolContext } from '../tool-binding.js';
import { defaultLambdaObservationTimer, observeLambdaBoot, openLambdaBootChannel, readLambdaBoot, readLambdaChannelReport, recordLambdaChannelEntry, type LambdaBootDependencies, type LambdaObservation } from './boot.js';
import type { GuestExecRequest, GuestExecResult, GuestUser, LambdaChannel } from './transport.js';

/**
 * v2 ticket 05 (V2-02 Executar ferramenta, V2-20, V2-23, V2-24, V2-26): the role tools of the MVP over a Lambda boot. Nothing of the
 * tool contract is forked: the same owner transport (`serveReadTools`), the same guest programs and the same result codes run, with the
 * boot's SSH channel standing where the Gondolin VM stands (`GuestOwner`).
 *
 * Authenticating the tunnel authorizes nothing. Each invocation is bound by the HOST to one role on one boot, and the role decides two
 * independent layers: the tools the binding accepts (reviewers: `read` only) and the guest Unix user its programs run as (`reviewer`:
 * owns nothing, no `docker` group, no forwarding). A context of another invocation, Work, environment or boot is refused.
 *
 * Residual risk, documented (V2-23): the `reviewer` user can reach the guest's local ports over loopback (the hook agent on 9000, `sshd`,
 * the WebSocket listener, anything a container publishes). It has no tool that opens a connection: its only program is the fixed read.
 */
export const lambdaToolOrigin: QualifiedProfileOrigin = 'factory-lambda-ssh-channel-v1';
/** The guest Unix user of a role. Reviewers of either kind share the one read-only user. */
export const guestUserOfRole = (role: ToolContext['role']): GuestUser => role === 'builder' ? 'builder' : 'reviewer';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** Where a tool call registers its process in the guest (v2 ticket 11). `call` is a host-generated UUID: nothing in the guest can guess it. */
export const callMarker = (call: string) => `/tmp/factory-call-${call}`;
/**
 * The bash text of one tool program: the fixed argument vector of the tool backends, every word single-quoted. It carries no secret.
 *
 * `call` (v2 ticket 11): the program first writes its own PID to the call's marker. `sshd` runs each command as the leader of a new
 * session, and `exec` keeps that PID, so the PID is the process GROUP of everything the call starts (NOT PROVEN in a real guest); it is
 * what `endCallProgram` kills after a reconnection.
 */
export const toolScript = (argv: readonly string[], cwd = '/', call?: string) =>
  `${call === undefined ? '' : `echo $$ > ${quote(callMarker(call))} && `}cd ${quote(cwd)} && exec ${argv.map(quote).join(' ')}`;
/**
 * v2 ticket 11 (V2-21): ends the process group of a call whose connection dropped, over a NEW connection as the same guest user (the
 * proof showed a closed connection does not end the process). Prints `call-ended`, or `call-not-started` when the call never
 * registered; exit 5 when the group is still alive after the kill, exit 6 when the marker holds no usable PID. It reads nothing the
 * orphan wrote: there is no reattachment to its output.
 */
export const endCallProgram = (call: string): GuestExecRequest => ({ program: 'end-call', script: [
  `marker=${quote(callMarker(call))}`,
  'pid=$(cat "$marker" 2>/dev/null) || { echo call-not-started; exit 0; }',
  'case "$pid" in \'\'|*[!0-9]*) exit 6;; esac',
  '[ "$pid" -gt 1 ] || exit 6',
  'kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
  'for attempt in 1 2 3 4 5; do kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || break; sleep 1; done',
  'if kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then echo call-alive; exit 5; fi',
  'rm -f "$marker"',
  'echo call-ended'].join('\n') });

/** Reconnection of a dropped channel with the environment alive (V2-21): bounded, then the boot serves no more calls. Never a loop. */
export const lambdaReconnect = Object.freeze({ attempts: 5, intervalSeconds: 5 });
/**
 * What the tool owner of a boot gives each call to recover from a dropped channel. `condition` is the SERVICE's answer about the
 * environment (`unknown`: it could not be read, which is never taken as an end); `exhausted` latches once reconnection reached its limit.
 */
export type ChannelRecovery = { condition(): Promise<'active' | 'ended' | 'unknown'>; sleep(milliseconds: number): Promise<void>;
  exhausted(): boolean; exhaust(attempts: number): Promise<void> };
type Dropped = { status: 'dropped'; outcome: ChannelDropOutcome; /** Whether the program can have started in the guest. */ started: boolean };

/**
 * A call whose connection dropped, or could not be opened, with the host not having interrupted it. The service is consulted first:
 * an ended environment is not reconnected to (its path is the end of the activation). With the environment alive, a call that never
 * started is simply run again; one that started has its process group ended over a new connection and is reported as dropped.
 */
async function recovered(first: GuestExecResult, run: () => Promise<GuestExecResult>, channel: LambdaChannel, call: string, signal: AbortSignal,
  recovery: ChannelRecovery): Promise<GuestExecResult | Dropped> {
  const down = (result: GuestExecResult) => result.status === 'lost' || (result.status === 'refused' && result.code === 'UNREACHABLE');
  if (!down(first) || signal.aborted) return first;
  let started = first.status === 'lost';
  if (recovery.exhausted()) return { status: 'dropped', outcome: 'channel-unrecoverable', started };
  for (let attempt = 1; attempt <= lambdaReconnect.attempts; attempt += 1) {
    const condition = await recovery.condition();
    if (signal.aborted) return { status: 'lost' };
    if (condition === 'ended') return { status: 'dropped', outcome: 'environment-ended', started };
    if (condition === 'active' && started) {
      const ended = await channel.exec(endCallProgram(call));
      if (ended.status === 'closed') return ended;
      if (ended.status === 'exited' && ended.exitCode === 0) return { status: 'dropped', outcome: 'orphan-ended', started };
    } else if (condition === 'active') {
      const again = await run();
      if (!down(again)) return again;
      started ||= again.status === 'lost';
    }
    if (attempt < lambdaReconnect.attempts) await recovery.sleep(lambdaReconnect.intervalSeconds * 1000);
  }
  await recovery.exhaust(lambdaReconnect.attempts);
  return { status: 'dropped', outcome: 'channel-unrecoverable', started };
}

/** Whole input of one program. The channel delivers stdin in one piece, so a streamed source is gathered first, up to this bound. */
const stdinLimit = 64 * 1024 * 1024;
async function gather(stdin: string | AsyncIterable<Buffer> | undefined): Promise<Buffer> {
  if (stdin === undefined || typeof stdin === 'string') return Buffer.from(stdin ?? '', 'utf8');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    bytes += chunk.length;
    if (bytes > stdinLimit) throw new Error('TOOL_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * What a channel outcome means to the tool backends. ONLY an exit status of the program is a result; a connection that was refused, lost
 * or closed gives none, and the backends then answer with their own "effects unknown" codes, as for a Gondolin exec that did not settle.
 * A drop under a program that STARTED carries how the adapter left it (v2 ticket 11): the backends report the uncertain effect and, when
 * the orphan was ended, answer "indeterminate" instead of ending the invocation.
 */
const settled = (outcome: GuestExecResult | Dropped): { exitCode: number | null; channel?: ChannelDropOutcome } =>
  outcome.status === 'dropped' ? { exitCode: null, ...(outcome.started ? { channel: outcome.outcome } : {}) }
    : { exitCode: outcome.status === 'exited' ? outcome.exitCode : null };

/**
 * The boot's channel as the exec boundary of the tool backends. One program per connection, as the bound Unix user of `channel`. `env`
 * travels as the program's explicit process environment (the only place a secret is put), stdout is streamed as it arrives and stderr is
 * given once at the end (Bash merges it in the guest instead). `signal` closes the connection; that is not proof the program stopped.
 * With `recovery`, a connection that drops without the host having closed it is recovered (`recovered`); without it, as in ticket 05.
 * `gone` (v2 ticket 10, V2-15) aborts once the service confirmed the end of the environment: the call in flight has its connection closed
 * and answers `environment-ended`, and a later call is answered the same way without anything being sent.
 */
export function lambdaGuestOwner(channel: LambdaChannel, recovery?: ChannelRecovery, gone?: AbortSignal): GuestOwner {
  return { exec(argv, options) {
    const pending: Buffer[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const outcome = (async (): Promise<GuestExecResult | Dropped> => {
      const stdin = await gather(options.stdin);
      if (options.signal.aborted) return { status: 'lost' };
      if (gone?.aborted) return { status: 'dropped', outcome: 'environment-ended', started: false };
      const call = randomUUID();
      const signal = gone ? AbortSignal.any([options.signal, gone]) : options.signal;
      const run = () => channel.exec({ program: 'tool', script: toolScript(argv, options.cwd, call), environment: options.env ?? {}, ...(stdin.length > 0 ? { stdin } : {}) },
        { signal, onData: data => { pending.push(data); wake?.(); } });
      const first = await run();
      const outcome = recovery && !gone?.aborted ? await recovered(first, run, channel, call, options.signal, recovery) : first;
      // The environment ended under this call: whatever the connection reported, the program may have started and has no result.
      if (gone?.aborted && !options.signal.aborted && outcome.status !== 'exited' && outcome.status !== 'dropped') {
        return { status: 'dropped', outcome: 'environment-ended', started: first.status !== 'refused' };
      }
      return outcome;
    })().catch((): GuestExecResult => ({ status: 'lost' })).finally(() => { finished = true; wake?.(); });
    return {
      result: outcome.then(settled),
      async *output() {
        for (;;) {
          while (pending.length > 0) yield { stream: 'stdout' as const, data: pending.shift()! };
          if (finished) break;
          await new Promise<void>(resolve => { wake = resolve; });
          wake = null;
        }
        const end = await outcome;
        if (options.stderr === 'pipe' && end.status === 'exited' && end.stderr.length > 0) yield { stream: 'stderr' as const, data: Buffer.from(end.stderr, 'utf8') };
      },
    };
  } };
}

/** What the host states for one invocation. The adapter's qualification and guest conventions are the adapter's, never the caller's. */
export type LambdaToolBinding = Omit<ReadBinding, 'profileOrigin' | 'guestConventions' | 'uncertainEffect'>;
export type LambdaTools = {
  /**
   * Binds one invocation to its role on THIS boot and serves its tools on `endpoint` (the worker's `connectReadTools` side is unchanged).
   * Refused: a context of another Work, environment or boot, and an invocation this boot already bound.
   */
  bind(binding: LambdaToolBinding): Promise<{ status: 'bound'; endpoint: string; close(): Promise<void> } | { status: 'refused';
    /** `CHANNEL_UNRECOVERABLE` (v2 ticket 11): reconnection reached its limit on this boot; it serves no more calls. */
    /** `ENVIRONMENT_ENDED` (v2 ticket 10): the service confirmed the end of this boot's environment; nothing is bound to it any more. */
    code: 'STALE_TOOL_CONTEXT' | 'TOOL_BINDING_INVALID' | 'CHANNEL_UNRECOVERABLE' | 'ENVIRONMENT_ENDED' }>;
  /** Ends every binding and closes the boot's connections. It does not stop the boot. */
  close(): Promise<void>;
};

/** v2 ticket 10: what the service said when it confirmed the end of a boot's environment (the reason is the service's own text). */
export type LambdaEnvironmentEnd = { reason: string | null; terminatedAt: string | null };

/**
 * The tool owner of one ACTIVE Lambda boot, for the host process that launches its workers (ticket 06). Opened from the boot's record, so
 * it does not depend on the process that started the boot.
 *
 * v2 ticket 10 (V2-15): while it serves, it WATCHES the environment: one read of the service per observation interval of the profile
 * (kept in the boot's record), whether or not a call is in flight. It watches the environment, never the work: a long command or a
 * silent agent ends nothing, and a read that fails or shows an in-between state is "unknown", after which the watch simply goes on.
 * Confirmed cessation (by the watch, or by a dropped call's own query) is latched: the calls in flight are cancelled and answered
 * `SANDBOX_ENVIRONMENT_ENDED`, every later call and binding is denied without touching the channel, nothing is ever reconnected, and
 * `environmentEnded` is told once the cancelled calls have answered (the owner then ends the workers; Control ends the activation).
 */
export async function serveLambdaTools(dependencies: LambdaBootDependencies, { environment, boot }: { environment: EnvironmentRef; boot: BootRef },
  { environmentEnded }: { environmentEnded?: (observed: LambdaEnvironmentEnd) => void } = {}):
  Promise<{ status: 'serving'; tools: LambdaTools } | { status: 'unavailable'; code: string }> {
  const record = await readLambdaBoot(dependencies.root, environment, boot);
  if (!record) return { status: 'unavailable', code: 'BOOT_NOT_FOUND' };
  const channels = new Map<GuestUser, LambdaChannel>();
  for (const user of ['builder', 'reviewer'] as const) {
    const opened = await openLambdaBootChannel(dependencies, { environment, boot, user });
    if (opened.status !== 'open') { for (const channel of channels.values()) channel.close(); return { status: 'unavailable', code: opened.code }; }
    channels.set(user, opened.channel);
  }
  const owners: { close(): Promise<void>; idle(): Promise<void> }[] = [];
  // Once-only claim of an invocation, never released: an uncertain binding must not invite a replacement under the same identity.
  const invocations = new Set<string>();
  let closing: Promise<void> | undefined;
  // v2 ticket 11: the service's word on the environment, the wait between attempts on the boot's clock, and the latch of the limit.
  let exhausted = (await readLambdaChannelReport(dependencies.root, environment, boot)).unrecoverable !== null;
  // v2 ticket 10: the latch of the confirmed cessation, and the life of the watch.
  const gone = new AbortController();
  const watching = new AbortController();
  let ending: Promise<void> | undefined;
  const end = (observed: LambdaObservation) => ending ??= (async () => {
    // Synchronously, before anything else can run: no new call or binding from here on, and the connections in flight are closed.
    gone.abort();
    watching.abort();
    // The cancelled calls answer (and record their uncertain effect) before anyone ends the workers that made them.
    await Promise.allSettled(owners.map(owner => owner.idle()));
    for (const channel of channels.values()) channel.close();
    try { environmentEnded?.({ reason: observed.lifecycle?.stateReason ?? null, terminatedAt: observed.lifecycle?.terminatedAt ?? null }); } catch { /* The latch stands whatever the listener does. */ }
  })();
  /** The service's word on the environment. `observeLambdaBoot` records a death nobody asked for as the boot's end, with its reason. */
  const condition = async (): Promise<'active' | 'ended' | 'unknown'> => {
    if (gone.signal.aborted) return 'ended';
    const observed = await observeLambdaBoot(dependencies, { environment, boot }).catch(() => null);
    if (observed?.condition === 'stopped') { void end(observed); return 'ended'; }
    return observed?.condition === 'active' ? 'active' : 'unknown';
  };
  if (record.observationIntervalSeconds !== undefined) {
    const milliseconds = record.observationIntervalSeconds * 1000;
    const timer = dependencies.observationTimer ?? defaultLambdaObservationTimer;
    void (async () => {
      while (!watching.signal.aborted) {
        await timer(milliseconds, watching.signal);
        if (watching.signal.aborted) return;
        // `unknown` is never cessation: the next interval asks again.
        await condition();
      }
    })().catch(() => {});
  }
  const recovery: ChannelRecovery = {
    condition,
    sleep: milliseconds => dependencies.clock.sleep(milliseconds),
    exhausted: () => exhausted,
    async exhaust(attempts) {
      if (exhausted) return;
      exhausted = true;
      await recordLambdaChannelEntry(dependencies.root, environment, boot, { kind: 'unrecoverable', at: new Date(dependencies.clock.now()).toISOString(), attempts });
    },
  };
  return { status: 'serving', tools: {
    async bind(binding) {
      const context = contextSchema.safeParse(binding.context);
      if (gone.signal.aborted) return { status: 'refused', code: 'ENVIRONMENT_ENDED' };
      if (exhausted) return { status: 'refused', code: 'CHANNEL_UNRECOVERABLE' };
      if (closing || binding.signal.aborted || !context.success || context.data.workId !== record.workId || context.data.environmentRef !== environment ||
          context.data.bootRef !== boot || invocations.has(context.data.invocationId)) return { status: 'refused', code: 'STALE_TOOL_CONTEXT' };
      invocations.add(context.data.invocationId);
      // The role the host bound picks the guest user; no call, tunnel or guest answer can change it afterwards.
      const vm = lambdaGuestOwner(channels.get(guestUserOfRole(context.data.role))!, recovery, gone.signal);
      const { executionId, invocationId, role } = context.data;
      // Written on the host before the call answers: the record does not depend on the session, the worker or this process surviving.
      const uncertainEffect: ReadBinding['uncertainEffect'] = effect => recordLambdaChannelEntry(dependencies.root, environment, boot, { kind: 'effect',
        at: new Date(dependencies.clock.now()).toISOString(), executionId, invocationId, role, ...effect, description: effect.description.slice(0, effectDescriptionLimit) });
      let owner: Awaited<ReturnType<typeof serveReadTools>>;
      try { owner = await serveReadTools({ ...binding, context: context.data, vm, profileOrigin: lambdaToolOrigin, guestConventions: 'ssh-channel', uncertainEffect, environmentEnded: () => gone.signal.aborted }); }
      catch { return { status: 'refused', code: 'TOOL_BINDING_INVALID' }; }
      if (closing) { await owner.close(); return { status: 'refused', code: 'STALE_TOOL_CONTEXT' }; }
      owners.push(owner);
      return { status: 'bound', endpoint: owner.endpoint, close: owner.close };
    },
    close() {
      watching.abort();
      return closing ??= Promise.allSettled(owners.map(owner => owner.close())).then(() => { for (const channel of channels.values()) channel.close(); });
    },
  } };
}
