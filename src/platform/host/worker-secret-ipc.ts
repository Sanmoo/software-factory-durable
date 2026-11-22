import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { workerBootstrapSchema } from './worker-bootstrap.js';
import { isQuestionMessage, workerQuestionSchema } from './worker-question-ipc.js';

// Private technical host/worker seam over the already inherited child channel.
// Not a tool, reader, WorkAdmission grant, transaction or credential producer.
type Context = z.infer<typeof workerBootstrapSchema>['context'];
type Wire = Pick<EventEmitter, 'on' | 'removeListener'> & {
  readonly connected?: boolean;
  send?: (message: Record<string, unknown>, callback: (error: Error | null) => void) => boolean;
};
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const contextSchema = z.strictObject({
  workId: identifier,
  executionId: identifier,
  invocationId: identifier,
  role: z.enum(['standards', 'spec', 'builder']),
  environmentRef: identifier,
  bootRef: identifier,
  phaseId: identifier,
});
const correlation = { version: z.literal(1), id: z.uuid(), context: contextSchema };
const requestSchema = z.strictObject({ kind: z.literal('worker-secret-register'), ...correlation, values: z.array(z.string().min(1).max(4096)).min(1).max(3) });
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('worker-secret-ack'), ...correlation }),
  z.strictObject({ kind: z.literal('worker-secret-error'), ...correlation, code: z.literal('SECRET_SYNC_DENIED') }),
]);
const denied = () => Object.freeze({ code: 'SECRET_SYNC_DENIED' as const });
const same = (left: Context, right: Context) => Object.keys(left).every(key => left[key as keyof Context] === right[key as keyof Context]);
const withinBudget = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '') <= 49152;
const receipt = z.strictObject({ workId: identifier, id: z.uuid() });
const ownerLifecycleSchema = z.union([
  z.strictObject({ kind: z.literal('worker-started'), receipt, invocation: z.strictObject({ executionId: identifier, invocationId: identifier }).optional() }),
  z.strictObject({ kind: z.literal('worker-error'), code: z.string().regex(/^[A-Z_]{1,128}$/) }),
  // Ticket 11: a Builder result names its exact session tool set (the owner observes the preserved session itself).
  // v2 ticket 09: `boot-swap` is the Builder's yield before a planned swap. Without it here the receiver, which shares the wire with the
  // launcher, read that result as a malformed message and ended the activation as WORKER_SECRET_SYNC_SCHEMA (real account, 2026-11-22).
  z.strictObject({
    kind: z.literal('worker-result'),
    status: z.enum(['completed', 'interrupted', 'boot-swap']),
    receipt,
    sessionFile: z.string().nullable().optional(),
    sessionTools: z
      .array(z.string().regex(/^[a-z_]{1,32}$/))
      .max(16)
      .optional(),
    opinion: z.record(z.string(), z.json()).optional(),
    // Ticket 48: an interrupted Builder whose own request/tool budget count closed the session. Ticket 57: one whose model request failed
    // without a Host abort.
    budgetExhausted: z.enum(['requests', 'tools']).optional(),
    providerUnavailable: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal('worker-result'), status: z.literal('failure'), code: z.string().regex(/^[A-Z_]{1,128}$/) }),
  z.strictObject({
    kind: z.literal('worker-result'),
    status: z.literal('question'),
    receipt,
    sessionFile: z.string().nullable().optional(),
    sessionTools: z
      .array(z.string().regex(/^[a-z_]{1,32}$/))
      .max(16)
      .optional(),
    question: workerQuestionSchema.extend({ acknowledged: z.boolean() }),
  }),
  // Ticket 12 lifecycle: the suspended Builder's handoff notice (validated in full by the owner's launcher, not here).
  z.strictObject({ kind: z.literal('worker-handoff'), event: z.record(z.string(), z.json()) }),
]);
const abortSchema = z.strictObject({ kind: z.literal('abort') });
const findingId = z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/);
/** Host directive to a suspended Builder (ticket 12); demultiplexed by the fixed entrypoint like abort. */
export const deliverSchema = z.strictObject({
  kind: z.literal('deliver'),
  directive: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('review-results'),
      round: z.number().int().min(1).max(99),
      prompt: z.string().min(1).max(40000),
      end: z.literal(true).optional(),
      // Ticket 13: the finding ids each reviewer listed for that round (the handoff refuses treatments of unlisted findings).
      findings: z.strictObject({ standards: z.array(findingId).max(40), spec: z.array(findingId).max(40) }).optional(),
    }),
    // v2 ticket 09 (V2-13): the boot of this Builder crossed its rotation margin; the session yields at its next call boundary.
    z.strictObject({ kind: z.literal('boot-swap') }),
  ]),
});

/** Pure construction is allowed before durable start; publication is not. The
 * callback is usable by the future OAuth observer, but no producer is activated. */
export function createSecretPublisher(wire: Wire, input: Context, signal: AbortSignal, timeoutMs = 5000, revoke: () => void = () => {}) {
  const context = Object.freeze(contextSchema.parse(input));
  let ready = false,
    failed = false;
  // Ticket 59: values the owner of THIS session already acknowledged (registered in its Records). Re-sending them would spend the owner's
  // bounded syncs on every model request; only a new value (a token refresh) needs a sync. Never logged, persisted or sent elsewhere.
  const acknowledged = new Set<string>();
  let pending: { id: string; ack: boolean; sent: boolean; resolve(): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const active = () => !failed && ready && !signal.aborted && wire.connected === true;
  function cleanup() {
    signal.removeEventListener('abort', fail);
    for (const event of ['disconnect', 'exit', 'error', 'close']) wire.removeListener(event, fail);
    wire.removeListener('message', message);
  }
  function fail() {
    if (failed) return;
    failed = true;
    const current = pending;
    pending = undefined;
    if (current) {
      clearTimeout(current.timer);
      current.reject(denied());
    }
    cleanup();
    try {
      revoke();
    } catch {
      /* Never propagate parent/private diagnostics. */
    }
  }
  function finish() {
    const current = pending;
    if (!current || !current.ack || !current.sent) return;
    if (!active()) {
      fail();
      return;
    }
    pending = undefined;
    clearTimeout(current.timer);
    current.resolve();
  }
  function message(value: unknown) {
    // Keep the fixed entrypoint's abort/lifecycle and the question seam's demultiplexers independent.
    if (abortSchema.safeParse(value).success || isQuestionMessage(value) || deliverSchema.safeParse(value).success) return;
    try {
      const parsed = responseSchema.safeParse(value);
      if (
        !withinBudget(value) ||
        !parsed.success ||
        !pending ||
        pending.ack ||
        !active() ||
        parsed.data.id !== pending.id ||
        !same(parsed.data.context, context) ||
        parsed.data.kind !== 'worker-secret-ack'
      ) {
        fail();
        return;
      }
      pending.ack = true;
      finish();
    } catch {
      fail();
    }
  }
  wire.on('message', message);
  for (const event of ['disconnect', 'exit', 'error', 'close']) wire.on(event, fail);
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted || wire.connected !== true) fail();
  return {
    protectedStarted() {
      if (!failed && !signal.aborted) ready = true;
    },
    async acknowledgeSecrets(values: readonly string[]): Promise<void> {
      try {
        const send = wire.send?.bind(wire);
        if (!active() || !send || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw denied();
        // The caller's whole input is validated as before (shape and serialized size), even when every value is already acknowledged.
        const whole = requestSchema.safeParse({ kind: 'worker-secret-register', version: 1, id: randomUUID(), context, values });
        if (!whole.success || !withinBudget(whole.data)) throw denied();
        const fresh = [...new Set(whole.data.values)].filter(value => !acknowledged.has(value));
        if (fresh.length === 0) return; // already registered by this owner; the channel is still active (checked above)
        if (pending) throw denied();
        const request = requestSchema.safeParse({ ...whole.data, values: fresh });
        if (!request.success) throw denied();
        await new Promise<void>((resolve, reject) => {
          const id = request.data.id;
          pending = { id, ack: false, sent: false, resolve, reject, timer: setTimeout(fail, timeoutMs) };
          try {
            send(request.data, error => {
              if (error || !active()) {
                fail();
                return;
              }
              if (pending?.id !== id) return; // failed/closed callbacks cannot resurrect
              pending.sent = true;
              finish();
            });
          } catch {
            fail();
          }
        });
        // Recheck the ORIGINAL scope after the awaited ACK, before credential use.
        if (!active()) throw denied();
        for (const value of request.data.values) acknowledged.add(value);
      } catch {
        fail();
        throw denied();
      }
    },
    close: fail,
  };
}

/**
 * Ticket 59: why the owner closed a secret channel. A closed set, never a value, prefix or exception text. `closed` is the owner's own normal
 * close (after a result or a lost child); `disconnect`/`abort` are channel or lifetime loss; every other reason is a refusal of a sync.
 */
export const secretChannelFailures = [
  'schema',
  'context',
  'replay',
  'limit',
  'busy',
  'not-started',
  'register',
  'timeout',
  'send',
  'disconnect',
  'abort',
  'closed',
] as const;
export type SecretChannelFailure = (typeof secretChannelFailures)[number];
/** Ticket 59: syncs of one session before its first model request (credential read/list before the runtime's first auth) and slack. */
export const secretSyncSetupMargin = 16;
/**
 * Ticket 59: the owner's bound on the syncs of ONE worker session, derived from that session's maximum model request budget. The publisher
 * sends only values the owner has not acknowledged yet, so a sync is spent by a setup read or a token refresh (at most one per request), never
 * by a request reusing the same token. Pilot 2: the old fixed 128 ended two Builders at request 126/127, below their 150.
 */
export function secretSyncLimit(maxRequests: number): number {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('WORKER_BUDGET_INVALID');
  return maxRequests + secretSyncSetupMargin;
}

/** Bound to one expected child by listener installation, never by a self-claimed
 * process id. The sink must synchronously register in the SAME owner Records
 * used by tool bindings. Failure revokes only this invocation, never the VM.
 * Ticket 59: `revoke` receives the closed reason; `syncLimit` comes from `secretSyncLimit` of the launch's budget. */
export function createOwnerSecretReceiver(
  wire: Wire,
  input: Context,
  signal: AbortSignal,
  started: () => boolean,
  registerSecret: (value: string) => void,
  revoke: (reason: SecretChannelFailure) => void,
  syncLimit: number,
  timeoutMs = 5000,
) {
  const context = Object.freeze(contextSchema.parse(input));
  if (!Number.isSafeInteger(syncLimit) || syncLimit < 1) throw new Error('WORKER_BUDGET_INVALID');
  const seen = new Set<string>(); // bounded replay tombstones (by id), no queue/retries
  let failed = false,
    pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !failed && !signal.aborted && wire.connected === true && started();
  const inactive = (): SecretChannelFailure => (signal.aborted ? 'abort' : wire.connected !== true ? 'disconnect' : 'not-started');
  function cleanup() {
    signal.removeEventListener('abort', aborted);
    for (const event of ['disconnect', 'exit', 'error', 'close']) wire.removeListener(event, lost);
    wire.removeListener('message', message);
  }
  function fail(reason: SecretChannelFailure) {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    cleanup();
    try {
      revoke(reason);
    } catch {
      /* Never propagate parent/private diagnostics. */
    }
  }
  const aborted = () => fail('abort');
  const lost = () => fail('disconnect');
  const expired = () => fail('timeout');
  function refusal(value: unknown): SecretChannelFailure | null {
    const parsed = requestSchema.safeParse(value);
    if (!withinBudget(value) || !parsed.success) return 'schema';
    if (!active()) return inactive();
    if (!wire.send) return 'disconnect';
    if (pending) return 'busy';
    if (!same(parsed.data.context, context)) return 'context';
    if (seen.has(parsed.data.id)) return 'replay';
    if (seen.size >= syncLimit) return 'limit';
    return null;
  }
  function message(value: unknown) {
    if (ownerLifecycleSchema.safeParse(value).success || isQuestionMessage(value)) return;
    try {
      const refused = refusal(value);
      if (refused) {
        fail(refused);
        return;
      }
      const request = requestSchema.parse(value);
      pending = true;
      seen.add(request.id);
      // NO awaits between validation, same-instance registration and ACK send.
      // Partial registrations on capacity/error intentionally remain registered.
      try {
        for (const secret of request.values) registerSecret(secret);
      } catch {
        // Closed correlated failure, never the Records/SDK exception or cause.
        try {
          wire.send!({ kind: 'worker-secret-error', version: 1, id: request.id, context, code: 'SECRET_SYNC_DENIED' }, () => {});
        } finally {
          fail('register');
        }
        return;
      }
      if (!active()) {
        fail(inactive());
        return;
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        fail('timeout');
        return;
      }
      timer = setTimeout(expired, timeoutMs);
      try {
        wire.send!({ kind: 'worker-secret-ack', version: 1, id: request.id, context }, error => {
          if (error) {
            fail('send');
            return;
          }
          if (!active()) {
            fail(inactive());
            return;
          }
          clearTimeout(timer);
          pending = false;
        });
      } catch {
        fail('send');
      }
    } catch {
      fail('schema');
    }
  }
  wire.on('message', message);
  for (const event of ['disconnect', 'exit', 'error', 'close']) wire.on(event, lost);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) fail('abort');
  else if (wire.connected !== true) fail('disconnect');
  return { close: () => fail('closed') };
}
