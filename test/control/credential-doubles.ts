// Execution boundary doubles for the active credential lifecycle (ticket 20). Control, Pi Durable and SQLite stay real; Sandbox lifecycle,
// Workers activation/delivery and the Builder credential projection are doubled. Synthetic secrets only; not evidence of GitHub/VM/worker.
import type { BuilderGrant, RevocationResult } from '../../src/contracts/index.js';
import type { ExecutionPorts } from '../../src/control/types.js';

export type LifecycleCall = { kind: 'prepare' | 'start' | 'issue' | 'activate' | 'deliver' | 'revoke' | 'close' | 'stop'; at: number; token?: string; directive?: string; detail?: unknown };
export type LifecycleOptions = {
  /** Lifetime (ms) of each issued grant; default one hour. */
  lifetimeMs?: (sequence: number) => number;
  /** Renewal margin passed to the composition (seconds before expiresAt). */
  beforeExpirySeconds?: number;
  /** Outcome of the n-th issuance (1 = initial). */
  issue?: (sequence: number) => 'ok' | 'unknown' | 'rejected' | Promise<'ok'>;
  /** Revocation outcome per token. */
  revoke?: (token: string) => RevocationResult['kind'];
  deliver?: (sequence: number) => 'delivered' | 'failure';
  /** Result of the withdraw-credential directive. */
  withdrawDirective?: 'withdrawn' | 'failure';
  stopCessation?: boolean;
  /** Literal expiresAt of the n-th grant (overrides lifetimeMs), e.g. an invalid value. */
  expiresAt?: (sequence: number) => string | undefined;
  /** Activation waits for this gate before returning its handle. */
  activateGate?: Promise<void>;
  /** The start observation names another Execution (receipt conflict). */
  startConflict?: boolean;
  /** Revocation never settles (a crash test kills the process meanwhile); `onRevoke` fires first. */
  revokeHangs?: boolean;
  onRevoke?: () => void;
};

export const tokenOf = (sequence: number) => `ghs_syntheticLifecycle${String(sequence).padStart(4, '0')}abcdefghij`;

export function lifecycleDoubles(options: LifecycleOptions = {}) {
  const calls: LifecycleCall[] = [];
  let issued = 0;
  let delivered = 0;
  let finish!: (value: { status: 'success' }) => void;
  const completion = new Promise<{ status: 'success' }>(resolve => { finish = resolve; });
  const record = (call: Omit<LifecycleCall, 'at'>) => { calls.push({ ...call, at: calls.length }); };
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' }, capacity: 1,
    builder: { skillPack: 'factory-skills-v1', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    ...(options.beforeExpirySeconds === undefined ? {} : { credentialRenewal: { beforeExpirySeconds: options.beforeExpirySeconds } }),
    sandbox: {
      async prepare(input) {
        record({ kind: 'prepare', detail: input });
        return { status: 'success', environment: `env-${'c'.repeat(64)}` as never, seeds: [],
          checkout: { path: '/workspace/checkout', repository: input.checkout.repository, repositoryId: input.checkout.repositoryId, base: 'main', branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40), origin: 'https://github.com/acme/project.git', reused: false, preparedAt: new Date().toISOString() } };
      },
      async start() { record({ kind: 'start' }); return { status: 'success', boot: 'boot-11111111-2222-4333-8444-555555555555' as never }; },
      async stop() {
        record({ kind: 'stop' });
        return options.stopCessation === false ? { status: 'indeterminate', code: 'X', cessationConfirmed: false } : { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
    },
    credentials: {
      async issue(context): Promise<BuilderGrant> {
        const sequence = ++issued;
        record({ kind: 'issue', detail: context });
        const outcome = await (options.issue?.(sequence) ?? 'ok');
        if (outcome === 'unknown') throw Object.assign(new Error('GITHUB_TOKEN_ISSUANCE_UNKNOWN'), { outcome: 'unknown' });
        if (outcome === 'rejected') throw Object.assign(new Error('GITHUB_RATE_LIMITED'), { outcome: 'known-rejected' });
        const now = Date.now();
        return { delivery: Object.freeze({ token: tokenOf(sequence) }), metadata: { role: 'builder', purpose: 'builder-start', repository: 'acme/project', repositoryId: 3, installationId: 2,
          permissions: { metadata: 'read', contents: 'read', issues: 'read' }, issuedAt: new Date(now).toISOString(),
          expiresAt: options.expiresAt?.(sequence) ?? new Date(now + (options.lifetimeMs?.(sequence) ?? 3600000)).toISOString() } };
      },
      async revoke(grant) {
        record({ kind: 'revoke', token: grant.delivery.token });
        options.onRevoke?.();
        if (options.revokeHangs) await new Promise(() => {});
        const kind = options.revoke?.(grant.delivery.token) ?? 'revoked';
        return { kind, code: `SYNTHETIC_${kind.toUpperCase().replace('-', '_')}`, nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation, delivery) {
        record({ kind: 'activate', ...(delivery?.credential ? { token: delivery.credential.token } : {}), detail: { invocation: { ...invocation, signal: undefined } } });
        if (options.activateGate) await options.activateGate;
        const started = Promise.resolve({ receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
          invocation: { executionId: options.startConflict ? 'another-execution' : invocation.context.executionId, invocationId: invocation.context.invocationId } });
        return { worker: invocation.context.invocationId, started,
          completed: started.then(() => completion.then(() => ({ status: 'success' as const, receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' } }))),
          close() { record({ kind: 'close' }); } };
      },
      async deliver(worker, directive) {
        if (directive.kind === 'withdraw-credential') {
          record({ kind: 'deliver', directive: directive.kind, detail: worker });
          return options.withdrawDirective === 'failure' ? { status: 'failure', code: 'CREDENTIAL_DELIVERY_UNCERTAIN' } : { status: 'withdrawn' };
        }
        if (directive.kind !== 'credential') return { status: 'failure', code: 'DELIVERY_NOT_APPLICABLE' };
        const sequence = ++delivered;
        record({ kind: 'deliver', directive: directive.kind, token: directive.credential.token, detail: worker });
        return (options.deliver?.(sequence) ?? 'delivered') === 'delivered' ? { status: 'delivered' } : { status: 'failure', code: 'CREDENTIAL_DELIVERY_UNCERTAIN' };
      },
    },
  };
  return { ports, calls, complete: () => finish({ status: 'success' }), kinds: () => calls.map(call => call.kind) };
}
