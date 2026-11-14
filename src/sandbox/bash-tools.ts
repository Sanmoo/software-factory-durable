import { z } from 'zod';
import { referenceSchema, type ReadBinding, type GuestOwner, type ToolContext, type ReadResult } from './tool-binding.js';
import { boundStreamCopyTools } from './write-tools.js';

// Match the native local backend's timer range; no invented global deadline.
export const bashTimeout = z.number().finite().positive().max(2147483.647);
const callId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const bashCallSchema = z.union([
  z.strictObject({ name: z.literal('bash'), command: z.string().max(16384), timeout: bashTimeout.optional(), callId }),
  z.strictObject({ name: z.literal('bash'), operation: z.literal('copy-output'), reference: referenceSchema, callId }),
]);
export type BashCall = z.infer<typeof bashCallSchema>;
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const bashProgressSchema = z.strictObject({ context: z.record(z.string(), z.string()),
  sequence: safeCount, bytes: safeCount,
  data: z.string().min(4).max(32768).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });
export type BashProgress = z.infer<typeof bashProgressSchema>;
// Guest-only fixed prelude (never run on the host). The token arrives on stdin, never in argv or the exec wire environment, and is exported
// only to this command's process tree as GH_TOKEN plus a gh credential helper for GitHub HTTPS (spec §8: no stored secret, no remote URL).
export const credentialPrelude = 'IFS= read -r GH_TOKEN || exit 97; export GH_TOKEN; export GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 ' +
  'GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.https://github.com.helper "GIT_CONFIG_VALUE_0=!/usr/bin/gh auth git-credential" ' +
  'GH_CONFIG_DIR="${GH_CONFIG_DIR:-/tmp/factory-gh-config}"; exec /bin/bash -c "$1"';

/** Fixed Factory commit identity of every Builder command (never a human's, never chosen by the model); only Host configuration may replace it. */
export const factoryCommitIdentity = Object.freeze({ name: 'Software Factory Builder', email: 'software-factory-builder@users.noreply.invalid' });
const identityPart = /^[A-Za-z0-9 ._@+-]{1,128}$/;
export function commitIdentityEnv(identity: Readonly<{ name: string; email: string }> = factoryCommitIdentity): string[] {
  if (!identityPart.test(identity.name) || !identityPart.test(identity.email) || !identity.email.includes('@')) throw new Error('COMMIT_IDENTITY_INVALID');
  return [`GIT_AUTHOR_NAME=${identity.name}`, `GIT_AUTHOR_EMAIL=${identity.email}`, `GIT_COMMITTER_NAME=${identity.name}`, `GIT_COMMITTER_EMAIL=${identity.email}`];
}

/** Existing owner only. The callback's cwd/env never crosses this authority boundary.
 * UTF-8 is intentionally fatal (Records default): arbitrary binary Bash is OPEN.
 */
export function boundBashTools(options: ReadBinding & { vm: GuestOwner }, valid: () => boolean, revoke: () => void,
  publishedCopies = new Set<string>()) {
  const bound = Object.freeze({ ...options.context });
  // Trusted host snapshot precedes any await. JSON cannot qualify a VM or
  // select policy. Host must select native-truncated output; no second truncator.
  const copyAllowed = options.copyOutput === true && options.profileOrigin === 'factory-development-gondolin-0.14.0-stdin-capacity-v1';
  const copy = boundStreamCopyTools(options, valid, revoke, publishedCopies);
  // Builder-only, host-delivered holder; its CURRENT value is snapshotted per command (renewal reaches new commands only).
  const holder = bound.role === 'builder' ? options.credential : undefined;
  // Host snapshot before any await; tool JSON can never set it.
  const identity = commitIdentityEnv(options.commitIdentity);
  let latest: { reference: { workId: string; id: string }; bytes: number; callId: string } | undefined;
  let running = false;
  return async (context: ToolContext, call: BashCall, progress: (frame: BashProgress) => Promise<void>): Promise<ReadResult> => {
    const failure = (code: string): ReadResult => ({ status: 'failure', code });
    if (!valid() || Object.keys(bound).some(key => bound[key as keyof ToolContext] !== context[key as keyof ToolContext])) return failure('STALE_TOOL_CONTEXT');
    if (bound.role !== 'builder') return failure('BASH_ROLE_DENIED');
    if ('operation' in call) {
      if (!copyAllowed || publishedCopies.size >= 32 || running || !latest || latest.callId === call.callId ||
          latest.reference.id !== call.reference.id || latest.reference.workId !== call.reference.workId) return failure('BASH_COPY_DENIED');
      const capture = latest;
      latest = undefined; // Spend synchronously before the FIRST await; no retry.
      running = true;
      try { return await copy(call.callId, capture); } finally { running = false; }
    }
    if (running) return failure('BASH_IN_PROGRESS');
    running = true;
    // Synchronous snapshot before the first await: this command and its subprocesses keep this value even if a renewal arrives meanwhile.
    const credential = holder?.current();
    latest = undefined; // Every new command invalidates its predecessor before effects.
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let attempted = false;
    let output: Awaited<ReturnType<typeof options.records.openOutput>> | undefined;
    let completed = false;
    let sequence = 0;
    let bytes = 0;
    const emit = async (text: string) => {
      const filtered = Buffer.from(text);
      for (let offset = 0; offset < filtered.length; offset += 24576) {
        if (!valid()) throw new Error('STALE_TOOL_CONTEXT');
        const chunk = filtered.subarray(offset, offset + 24576);
        bytes += chunk.length;
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(sequence + 1)) throw new Error('BASH_PROGRESS_LIMIT');
        await progress({ context: bound, sequence: sequence++, bytes, data: chunk.toString('base64') });
      }
    };
    try {
      const { phaseId: _phase, ...captureContext } = bound;
      output = await options.records.openOutput({ ...captureContext, callId: call.callId });
      if (!valid()) throw new Error('STALE_TOOL_CONTEXT');
      if (call.timeout !== undefined) timer = setTimeout(() => { timedOut = true; lifetime.abort(); }, call.timeout * 1000);
      attempted = true;
      // Gondolin merges env:{} with its VM default and omits an empty wire env;
      // the guest daemon may retain gEnv. Clear it at the fixed guest exec boundary.
      // Both guest executables are profile prerequisites, never host fallbacks.
      const argv = credential === undefined ? ['/usr/bin/env', '-i', ...identity, '/bin/bash', '-c', call.command]
        : ['/usr/bin/env', '-i', ...identity, '/bin/bash', '-c', credentialPrelude, 'factory-builder-credential', call.command];
      const process = options.vm.exec(argv, { stdout: 'pipe', stderr: 'pipe',
        signal: AbortSignal.any([options.signal, lifetime.signal]), windowBytes: 65536, env: {}, cwd: '/workspace', stdin: credential === undefined ? '' : `${credential}\n` });
      void process.result.catch(() => {});
      // SDK's ordered output stream preserves stdout/stderr arrival order. Every
      // release awaits protected Records.write BEFORE awaited native capture admission.
      // Capture completion, not each progress frame, establishes synced evidence.
      for await (const chunk of process.output()) {
        if (!valid() || lifetime.signal.aborted) throw new Error('BASH_ABORTED');
        for (let offset = 0; offset < chunk.data.length; offset += 65536) {
          await emit(await output.write(chunk.data.subarray(offset, offset + 65536)));
        }
      }
      const result = await process.result;
      if (!valid() || lifetime.signal.aborted || !Number.isInteger(result.exitCode) || result.exitCode === null ||
          result.exitCode < 0 || result.exitCode > 255) throw new Error('BASH_EFFECTS_UNKNOWN');
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const capture = await output.finish();
      await emit(capture.tail);
      if (!valid()) throw new Error('STALE_TOOL_CONTEXT');
      completed = true;
      latest = { reference: capture.reference, bytes: capture.bytes, callId: call.callId };
      return { status: 'success', format: 'text', reference: capture.reference, bytes: capture.bytes, encoding: 'base64',
        data: '', nextOffset: 0, exitCode: result.exitCode, progressFrames: sequence };
    } catch {
      // Abort requests are NOT proof of physical cessation. Never retry or claim
      // known non-effect after transport/capture failure or null exit.
      revoke(); lifetime.abort();
      if (timedOut) return failure('BASH_TIMEOUT_EFFECTS_UNKNOWN');
      return failure(attempted ? 'BASH_EFFECTS_OR_CAPTURE_UNKNOWN' : 'PROTECTED_BASH_UNAVAILABLE');
    } finally {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      lifetime.abort();
      if (output && !completed) { try { await output.abort(); } catch { revoke(); } }
    }
  };
}
