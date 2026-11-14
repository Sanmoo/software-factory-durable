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
const contextSchema = z.strictObject({ workId: identifier, executionId: identifier, invocationId: identifier,
  role: z.enum(['standards', 'spec', 'builder']), environmentRef: identifier, bootRef: identifier, phaseId: identifier });
const correlation = { version: z.literal(1), id: z.uuid(), context: contextSchema };
const requestSchema = z.strictObject({ kind: z.literal('worker-secret-register'), ...correlation,
  values: z.array(z.string().min(1).max(4096)).min(1).max(3) });
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
  z.strictObject({ kind: z.literal('worker-result'), status: z.enum(['completed', 'interrupted']), receipt, sessionFile: z.string().nullable().optional(),
    sessionTools: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(16).optional(), opinion: z.record(z.string(), z.json()).optional() }),
  z.strictObject({ kind: z.literal('worker-result'), status: z.literal('failure'), code: z.string().regex(/^[A-Z_]{1,128}$/) }),
  z.strictObject({ kind: z.literal('worker-result'), status: z.literal('question'), receipt, sessionFile: z.string().nullable().optional(),
    sessionTools: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(16).optional(), question: workerQuestionSchema.extend({ acknowledged: z.boolean() }) }),
  // Ticket 12 lifecycle: the suspended Builder's handoff notice (validated in full by the owner's launcher, not here).
  z.strictObject({ kind: z.literal('worker-handoff'), event: z.record(z.string(), z.json()) }),
]);
const abortSchema = z.strictObject({ kind: z.literal('abort') });
/** Host directive to a suspended Builder (ticket 12); demultiplexed by the fixed entrypoint like abort. */
export const deliverSchema = z.strictObject({ kind: z.literal('deliver'), directive: z.strictObject({ kind: z.literal('review-results'),
  round: z.number().int().min(1).max(99), prompt: z.string().min(1).max(40000) }) });

/** Pure construction is allowed before durable start; publication is not. The
 * callback is usable by the future OAuth observer, but no producer is activated. */
export function createSecretPublisher(wire: Wire, input: Context, signal: AbortSignal, timeoutMs = 5000, revoke: () => void = () => {}) {
  const context = Object.freeze(contextSchema.parse(input));
  let ready = false, failed = false;
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
    const current = pending; pending = undefined;
    if (current) { clearTimeout(current.timer); current.reject(denied()); }
    cleanup();
    try { revoke(); } catch { /* Never propagate parent/private diagnostics. */ }
  }
  function finish() {
    const current = pending;
    if (!current || !current.ack || !current.sent) return;
    if (!active()) { fail(); return; }
    pending = undefined;
    clearTimeout(current.timer);
    current.resolve();
  }
  function message(value: unknown) {
    // Keep the fixed entrypoint's abort/lifecycle and the question seam's demultiplexers independent.
    if (abortSchema.safeParse(value).success || isQuestionMessage(value) || deliverSchema.safeParse(value).success) return;
    try {
      const parsed = responseSchema.safeParse(value);
      if (!withinBudget(value) || !parsed.success || !pending || pending.ack || !active() ||
          parsed.data.id !== pending.id || !same(parsed.data.context, context) || parsed.data.kind !== 'worker-secret-ack') {
        fail(); return;
      }
      pending.ack = true;
      finish();
    } catch { fail(); }
  }
  wire.on('message', message);
  for (const event of ['disconnect', 'exit', 'error', 'close']) wire.on(event, fail);
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted || wire.connected !== true) fail();
  return {
    protectedStarted() { if (!failed && !signal.aborted) ready = true; },
    async acknowledgeSecrets(values: readonly string[]): Promise<void> {
      try {
        const send = wire.send?.bind(wire);
        if (!active() || pending || !send || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw denied();
        const request = requestSchema.safeParse({ kind: 'worker-secret-register', version: 1, id: randomUUID(), context, values });
        if (!request.success || !withinBudget(request.data)) throw denied();
        await new Promise<void>((resolve, reject) => {
          const id = request.data.id;
          pending = { id, ack: false, sent: false, resolve, reject, timer: setTimeout(fail, timeoutMs) };
          try {
            send(request.data, error => {
              if (error || !active()) { fail(); return; }
              if (pending?.id !== id) return; // failed/closed callbacks cannot resurrect
              pending.sent = true;
              finish();
            });
          } catch { fail(); }
        });
        // Recheck the ORIGINAL scope after the awaited ACK, before credential use.
        if (!active()) throw denied();
      } catch { fail(); throw denied(); }
    },
    close: fail,
  };
}

/** Bound to one expected child by listener installation, never by a self-claimed
 * process id. The sink must synchronously register in the SAME owner Records
 * used by tool bindings. Failure revokes only this invocation, never the VM. */
export function createOwnerSecretReceiver(wire: Wire, input: Context, signal: AbortSignal,
  started: () => boolean, registerSecret: (value: string) => void, revoke: () => void, timeoutMs = 5000) {
  const context = Object.freeze(contextSchema.parse(input));
  const seen = new Set<string>(); // bounded replay tombstones, no queue/retries
  let failed = false, pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !failed && !signal.aborted && wire.connected === true && started();
  function cleanup() {
    signal.removeEventListener('abort', fail);
    for (const event of ['disconnect', 'exit', 'error', 'close']) wire.removeListener(event, fail);
    wire.removeListener('message', message);
  }
  function fail() {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    cleanup();
    try { revoke(); } catch { /* Never propagate parent/private diagnostics. */ }
  }
  function message(value: unknown) {
    if (ownerLifecycleSchema.safeParse(value).success || isQuestionMessage(value)) return;
    try {
      const parsed = requestSchema.safeParse(value);
      if (!withinBudget(value) || !parsed.success || !active() || pending || !wire.send ||
          !same(parsed.data.context, context) || seen.has(parsed.data.id) || seen.size >= 128) { fail(); return; }
      const request = parsed.data;
      pending = true;
      seen.add(request.id);
      // NO awaits between validation, same-instance registration and ACK send.
      // Partial registrations on capacity/error intentionally remain registered.
      try { for (const secret of request.values) registerSecret(secret); }
      catch {
        // Closed correlated failure, never the Records/SDK exception or cause.
        try { wire.send({ kind: 'worker-secret-error', version: 1, id: request.id, context, code: 'SECRET_SYNC_DENIED' }, () => {}); }
        finally { fail(); }
        return;
      }
      if (!active() || !Number.isFinite(timeoutMs) || timeoutMs <= 0) { fail(); return; }
      timer = setTimeout(fail, timeoutMs);
      wire.send({ kind: 'worker-secret-ack', version: 1, id: request.id, context }, error => {
        if (error || !active()) { fail(); return; }
        clearTimeout(timer);
        pending = false;
      });
    } catch { fail(); }
  }
  wire.on('message', message);
  for (const event of ['disconnect', 'exit', 'error', 'close']) wire.on(event, fail);
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted || wire.connected !== true) fail();
  return { close: fail };
}
