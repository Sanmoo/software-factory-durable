import type { BootRef } from '../lifecycle.js';
import type { EnvironmentRef } from '../prepare.js';
import { serveReadTools } from '../read-tools.js';
import { contextSchema, type GuestOwner, type QualifiedProfileOrigin, type ReadBinding, type ToolContext } from '../tool-binding.js';
import { openLambdaBootChannel, readLambdaBoot, type LambdaBootDependencies } from './boot.js';
import type { GuestExecResult, GuestUser, LambdaChannel } from './transport.js';

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
/** The bash text of one tool program: the fixed argument vector of the tool backends, every word single-quoted. It carries no secret. */
export const toolScript = (argv: readonly string[], cwd = '/') => `cd ${quote(cwd)} && exec ${argv.map(quote).join(' ')}`;

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
 * This is the one place ticket 11 changes: `lost` with the MicroVM alive becomes reconnect, end the orphan's process group, and the
 * "indeterminate" result; `refused` ran nothing.
 */
const settled = (outcome: GuestExecResult): { exitCode: number | null } => ({ exitCode: outcome.status === 'exited' ? outcome.exitCode : null });

/**
 * The boot's channel as the exec boundary of the tool backends. One program per connection, as the bound Unix user of `channel`. `env`
 * travels as the program's explicit process environment (the only place a secret is put), stdout is streamed as it arrives and stderr is
 * given once at the end (Bash merges it in the guest instead). `signal` closes the connection; that is not proof the program stopped.
 */
export function lambdaGuestOwner(channel: LambdaChannel): GuestOwner {
  return { exec(argv, options) {
    const pending: Buffer[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const outcome = (async (): Promise<GuestExecResult> => {
      const stdin = await gather(options.stdin);
      if (options.signal.aborted) return { status: 'lost' };
      return channel.exec({ program: 'tool', script: toolScript(argv, options.cwd), environment: options.env ?? {}, ...(stdin.length > 0 ? { stdin } : {}) },
        { signal: options.signal, onData: data => { pending.push(data); wake?.(); } });
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
export type LambdaToolBinding = Omit<ReadBinding, 'profileOrigin' | 'guestConventions'>;
export type LambdaTools = {
  /**
   * Binds one invocation to its role on THIS boot and serves its tools on `endpoint` (the worker's `connectReadTools` side is unchanged).
   * Refused: a context of another Work, environment or boot, and an invocation this boot already bound.
   */
  bind(binding: LambdaToolBinding): Promise<{ status: 'bound'; endpoint: string; close(): Promise<void> } | { status: 'refused'; code: 'STALE_TOOL_CONTEXT' | 'TOOL_BINDING_INVALID' }>;
  /** Ends every binding and closes the boot's connections. It does not stop the boot. */
  close(): Promise<void>;
};

/**
 * The tool owner of one ACTIVE Lambda boot, for the host process that launches its workers (ticket 06). Opened from the boot's record, so
 * it does not depend on the process that started the boot.
 */
export async function serveLambdaTools(dependencies: LambdaBootDependencies, { environment, boot }: { environment: EnvironmentRef; boot: BootRef }):
  Promise<{ status: 'serving'; tools: LambdaTools } | { status: 'unavailable'; code: string }> {
  const record = await readLambdaBoot(dependencies.root, environment, boot);
  if (!record) return { status: 'unavailable', code: 'BOOT_NOT_FOUND' };
  const channels = new Map<GuestUser, LambdaChannel>();
  for (const user of ['builder', 'reviewer'] as const) {
    const opened = await openLambdaBootChannel(dependencies, { environment, boot, user });
    if (opened.status !== 'open') { for (const channel of channels.values()) channel.close(); return { status: 'unavailable', code: opened.code }; }
    channels.set(user, opened.channel);
  }
  const owners: { close(): Promise<void> }[] = [];
  // Once-only claim of an invocation, never released: an uncertain binding must not invite a replacement under the same identity.
  const invocations = new Set<string>();
  let closing: Promise<void> | undefined;
  return { status: 'serving', tools: {
    async bind(binding) {
      const context = contextSchema.safeParse(binding.context);
      if (closing || binding.signal.aborted || !context.success || context.data.workId !== record.workId || context.data.environmentRef !== environment ||
          context.data.bootRef !== boot || invocations.has(context.data.invocationId)) return { status: 'refused', code: 'STALE_TOOL_CONTEXT' };
      invocations.add(context.data.invocationId);
      // The role the host bound picks the guest user; no call, tunnel or guest answer can change it afterwards.
      const vm = lambdaGuestOwner(channels.get(guestUserOfRole(context.data.role))!);
      let owner: Awaited<ReturnType<typeof serveReadTools>>;
      try { owner = await serveReadTools({ ...binding, context: context.data, vm, profileOrigin: lambdaToolOrigin, guestConventions: 'ssh-channel' }); }
      catch { return { status: 'refused', code: 'TOOL_BINDING_INVALID' }; }
      if (closing) { await owner.close(); return { status: 'refused', code: 'STALE_TOOL_CONTEXT' }; }
      owners.push(owner);
      return { status: 'bound', endpoint: owner.endpoint, close: owner.close };
    },
    close() {
      return closing ??= Promise.allSettled(owners.map(owner => owner.close())).then(() => { for (const channel of channels.values()) channel.close(); });
    },
  } };
}
