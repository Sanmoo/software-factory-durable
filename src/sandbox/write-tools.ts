import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { createRecords } from '../records/index.js';
import { commandLifetime, type GuestOwner } from './tool-binding.js';

type Context = { workId: string; executionId: string; invocationId: string; role: 'builder' | 'standards' | 'spec'; environmentRef: string; bootRef: string; phaseId: string };
type Options = { context: Context; signal: AbortSignal; records: Awaited<ReturnType<typeof createRecords>>;
  vm: GuestOwner };
type Result = { status: 'failure'; code: string } | { status: 'success'; format: 'text'; reference: { workId: string; id: string }; bytes: number; encoding: 'base64'; data: string; nextOffset: number };

const path = z.string().min(1).max(4096);
const callId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
// Per-frame development transport budget, NOT a native write/global file-size policy.
export const writeCallSchema = z.union([
  z.strictObject({ name: z.literal('write'), operation: z.literal('mkdir'), path, callId }),
  z.strictObject({ name: z.literal('write'), operation: z.literal('create'), path, content: z.string(), callId }),
]);
export type WriteCall = z.infer<typeof writeCallSchema>;

// SOURCE ONLY, never host-executed. Trusted guest interpreter/kernel/proc/mount
// prerequisites remain unchanged. FD authorization is instantaneous, not continuous
// beneath-root membership against concurrent renames/mounts or malicious guest root.
// Reject ALL symlinks including in-root links. Direct FD truncate/write or exclusive
// create is non-atomic: truncation/partial bytes/directories can survive failure,
// including empty content. Existing inode/mode are retained. No unlink/retry.
const guestWriteProgram = `import os, stat, sys
fds = []
try:
    operation, path = sys.argv[1:]
    parts = path.split("/")
    if (operation not in ("mkdir", "create") or not path.isprintable()
            or len(path) > 4096 or parts[0] != "" or parts[1] not in ("workspace", "artifacts")
            or any(part in ("", ".", "..") for part in parts[1:])
            or (operation == "create" and len(parts) < 3)):
        raise ValueError()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    def authorize(fd, regular=False):
        target = os.readlink("/proc/self/fd/" + str(fd))
        if (not (stat.S_ISREG(os.fstat(fd).st_mode) if regular else stat.S_ISDIR(os.fstat(fd).st_mode)) or not target.isprintable()
                or target.endswith(" (deleted)")
                or not ((not regular and target in ("/workspace", "/artifacts")) or target.startswith(("/workspace/", "/artifacts/")))
                or any(part in ("", ".", "..") for part in target.split("/")[1:])):
            raise ValueError()
    base = os.open("/", flags)
    fds.append(base)
    parent = os.open(parts[1], flags, dir_fd=base)
    fds.append(parent)
    authorize(parent)
    directories = parts[2:] if operation == "mkdir" else parts[2:-1]
    for leaf in directories:
        authorize(parent)
        try:
            child = os.open(leaf, flags, dir_fd=parent)
        except FileNotFoundError:
            authorize(parent)
            os.mkdir(leaf, mode=0o700, dir_fd=parent)
            child = os.open(leaf, flags, dir_fd=parent)
        fds.append(child)
        authorize(child)
        parent = child
    if operation == "create":
        authorize(parent)
        leaf = parts[-1]
        if leaf in ("", ".", "..") or "/" in leaf:
            raise ValueError()
        try:
            fd = os.open(leaf, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            authorize(parent)
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        fds.append(fd)
        authorize(fd, regular=True)
        authorize(parent)
        os.ftruncate(fd, 0)
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            while data:
                written = os.write(fd, data)
                if written <= 0:
                    raise OSError()
                data = data[written:]
except BaseException:
    sys.exit(1)
finally:
    for fd in reversed(fds):
        os.close(fd)
`;

// Stream branch is derived from the SAME authorized-FD engine. Public Write
// and Edit bytes remain unchanged. Exclusive flat artifact only; no repair,
// overwrite, retry, directory creation or rollback. Program remains DATA on host.
const guestStreamProgram = guestWriteProgram.replace('import os, stat, sys', 'import os, stat, sys, hashlib, json')
  .replace('("mkdir", "create")', '("stream",)')
  .replace('("workspace", "artifacts")', '("artifacts",)')
  .replace('("/workspace", "/artifacts")', '("/artifacts",)')
  .replace('target.startswith(("/workspace/", "/artifacts/"))', 'target.startswith("/artifacts/")')
  .replace('(operation == "create" and len(parts) < 3)', '(operation == "stream" and (len(parts) != 3 or parts[1] != "artifacts"))')
  .replace('            authorize(parent)\n            os.mkdir(leaf, mode=0o700, dir_fd=parent)\n            child = os.open(leaf, flags, dir_fd=parent)', '            raise')
  .replace('if operation == "create":', 'if operation == "stream":')
  .replace(`        try:
            fd = os.open(leaf, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            authorize(parent)
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)`,
    '        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)')
  .replace('        os.ftruncate(fd, 0)', '        count = 0\n        digest = hashlib.sha256()')
  .replace('                data = data[written:]', `                count += written
                if count > 9007199254740991:
                    raise OverflowError()
                digest.update(data[:written])
                data = data[written:]
        print(json.dumps({"bytes": count, "sha256": digest.hexdigest()}, separators=(",", ":")), end="", flush=True)`);

/** Private closed stream-copy variant of the owner mutation engine. No caller
 * source/destination/count/hash grants: all inputs come from the spent Bash slot.
 * Receipt proves an observation, NOT physical FD cessation or durable storage. */
export function boundStreamCopyTools(options: Options, valid: () => boolean, revoke: () => void,
  publishedCopies: Set<string>) {
  const bound = Object.freeze({ ...options.context });
  return async (callId: string, capture: { reference: { workId: string; id: string }; bytes: number; callId: string }): Promise<Result> => {
    const failure = (): Result => ({ status: 'failure', code: 'BASH_COPY_EFFECTS_OR_CAPTURE_UNKNOWN' });
    const { phaseId, ...captureContext } = bound;
    const evidence = { ...captureContext, callId };
    const path = `/artifacts/factory-output-${randomUUID()}.txt`;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([options.signal, lifetime.signal]);
    const projection = options.records.projectText({ context: { ...captureContext, callId: capture.callId },
      reference: capture.reference, expectedBytes: capture.bytes, signal });
    let attempted = false;
    let count = 0;
    const hash = createHash('sha256');
    let output: Awaited<ReturnType<typeof options.records.openOutput>> | undefined;
    let completed = false;
    let published = false;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      revoke(); lifetime.abort();
    };
    async function* stdin() {
      try {
        for await (const chunk of projection.chunks) {
          if (!valid() || signal.aborted || !Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > 65536 ||
              !Number.isSafeInteger(count + chunk.length)) throw new Error('copy source unavailable');
          count += chunk.length;
          hash.update(chunk);
          yield chunk;
        }
      } catch (error) {
        // SDK stdin consumption is independent of output/result settlement.
        // Revoke admission and request abort before exposing a failed pull.
        fail();
        throw error;
      }
    }
    try {
      await options.records.record(evidence, { kind: 'mutation-intent', phaseId, operation: 'copy-output', path,
        source: capture.reference, semantics: 'exclusive-stream-create-non-atomic' });
      if (!valid() || signal.aborted) throw new Error('stale');
      attempted = true;
      const process = options.vm.exec(['/usr/bin/env', '-i', '/usr/bin/python3', '-I', '-S', '-c', guestStreamProgram, 'stream', path], {
        stdout: 'pipe', stderr: 'pipe', signal, windowBytes: 65536, env: {}, cwd: '/', stdin: stdin(), stdinCapacity: { maxChunkBytes: 65536 },
      });
      void process.result.catch(fail);
      // Bounded validation buffer ONLY, never an output/source accumulator.
      let receiptBytes = Buffer.alloc(0);
      for await (const chunk of process.output()) {
        if (!valid() || signal.aborted || chunk.stream !== 'stdout' || receiptBytes.length + chunk.data.length > 8192) throw new Error('receipt unavailable');
        receiptBytes = Buffer.concat([receiptBytes, chunk.data]);
      }
      const result = await process.result;
      const receipt = z.strictObject({ bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)));
      const digest = hash.digest('hex');
      if (result.exitCode !== 0 || result.signal !== undefined || receipt.bytes !== count || receipt.sha256 !== digest ||
          !receiptBytes.equals(Buffer.from(JSON.stringify(receipt)))) throw new Error('receipt mismatch');
      projection.assertCompleteAndCurrent();
      const metadata = JSON.stringify({ path, bytes: count, sha256: digest });
      output = await options.records.openOutput(evidence);
      const released = await output.write(Buffer.from(metadata));
      const protectedReceipt = await output.finish();
      completed = true;
      if (released + protectedReceipt.tail !== metadata || protectedReceipt.bytes !== Buffer.byteLength(metadata)) throw new Error('filtered metadata');
      await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: 'copy-output', path,
        status: 'guest-receipt-observed', bytes: count, sha256: digest, output: protectedReceipt.reference });
      // The final publication fence follows EVERY awaited evidence write. No
      // await below it. Historical EOF alone is insufficient after a late secret.
      if (!valid() || signal.aborted) throw new Error('stale');
      projection.assertCompleteAndCurrent();
      // Binding-private permission publication. All asynchronous evidence and
      // current-secret fences precede this; successful return has no later await.
      publishedCopies.add(path);
      published = true;
      return { status: 'success', format: 'text', reference: protectedReceipt.reference, bytes: protectedReceipt.bytes,
        encoding: 'base64', data: Buffer.from(metadata).toString('base64'), nextOffset: protectedReceipt.bytes };
    } catch {
      // Synchronous before uncertain evidence persistence: peers cannot enter
      // Write/Edit/Bash while that await is held. Abort is NOT a physical stop.
      fail();
      if (attempted) {
        try { await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: 'copy-output',
          status: 'effects-unknown-no-retry' }); } catch { /* Still unknown. */ }
      }
      return failure();
    } finally {
      lifetime.abort();
      if (!published) { try { await projection.chunks.return(); } catch { revoke(); } }
      if (output && !completed) { try { await output.abort(); } catch { revoke(); } }
    }
  };
}

// Private owner-to-helper input. NEVER part of writeCallSchema or any wire schema.
type ConditionalCommit = { name: 'edit-source'; operation: 'commit'; path: string; callId: string;
  replacement: string; expectedBytes: number; expectedDigest: string };

// Derive the existing helper's conditional branch, retaining its nofollow walk,
// FD authorization and direct-write loop. The public helper bytes stay unchanged.
// Exit 42 exists ONLY before any effect. Never execute either body on the host.
// Guarantee: compare the observed bytes on this authorized writable FD against
// the lossless capture, then modify that SAME FD. NOT atomic CAS, a coherent
// snapshot, continuous root membership, guest-writer exclusion, equal-content
// inode replacement detection or physical cessation. No rollback or retry.
const guestConditionalProgram = guestWriteProgram.replace('import os, stat, sys', 'import os, stat, sys, hashlib\nclass SourceMismatch(Exception):\n    pass')
  .replace('operation, path = sys.argv[1:]', 'operation, path = sys.argv[1:3]\n    expected_count = int(sys.argv[3])\n    expected_digest = sys.argv[4]\n    if not 0 <= expected_count <= 8192:\n        raise ValueError()')
  .replace('("mkdir", "create")', '("commit",)')
  .replace('(operation == "create" and len(parts) < 3)', '(operation == "commit" and len(parts) < 3)')
  .replace('            authorize(parent)\n            os.mkdir(leaf, mode=0o700, dir_fd=parent)\n            child = os.open(leaf, flags, dir_fd=parent)', '            raise')
  .replace('if operation == "create":', 'if operation == "commit":')
  .replace('os.O_WRONLY | os.O_NONBLOCK', 'os.O_RDWR | os.O_NONBLOCK')
  .replace('            authorize(parent)\n            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)', '            raise')
  .replace('        os.ftruncate(fd, 0)', `        observed_count = 0
        observed_digest = hashlib.sha256()
        while observed_count <= expected_count:
            data = os.read(fd, expected_count + 1 - observed_count)
            if not data:
                break
            observed_count += len(data)
            observed_digest.update(data)
        if observed_count != expected_count or observed_digest.hexdigest() != expected_digest:
            raise SourceMismatch()
        authorize(fd, regular=True)
        authorize(parent)
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)`)
  .replace('except BaseException:', 'except SourceMismatch:\n    sys.exit(42)\nexcept BaseException:');

export function boundWriteTools(options: Options, valid: () => boolean, revoke: () => void) {
  const execute = boundMutation(options, valid, revoke);
  return (context: Context, call: WriteCall) => execute(context, call);
}
/** Internal owner seam only; expected identity comes exclusively from its spent capture. */
export function boundConditionalEditTools(options: Options, valid: () => boolean, revoke: () => void) {
  const execute = boundMutation(options, valid, revoke);
  return (context: Context, call: ConditionalCommit) => execute(context, call);
}
function boundMutation(options: Options, valid: () => boolean, revoke: () => void) {
  const bound = Object.freeze({ ...options.context });
  return async function execute(context: Context, call: WriteCall | ConditionalCommit): Promise<Result> {
    const conditional = call.operation === 'commit';
    const prefix = conditional ? 'EDIT_SOURCE' : 'WRITE';
    let content = '';
    if (conditional) content = call.replacement;
    else if (call.operation === 'create') content = call.content;
    const failure = (code: string): Result => ({ status: 'failure', code });
    if (Object.keys(bound).some(key => bound[key as keyof Context] !== context[key as keyof Context]) || !valid()) return failure('STALE_TOOL_CONTEXT');
    if (bound.role !== 'builder') return failure('WRITE_ROLE_DENIED');
    if (!/^\/(workspace|artifacts)(\/[^\0]*)?$/.test(call.path) || /[\x00-\x1f\x7f]/.test(call.path) ||
        call.path.split('/').slice(1).some(part => ['', '.', '..'].includes(part)) ||
        (call.operation === 'create' && call.path.split('/').length < 3)) return failure('WRITE_PATH_DENIED');
    if (!conditional && ((call.operation === 'create' && call.content.length > 8192) || Buffer.byteLength(JSON.stringify(call)) > 49152)) return failure('WRITE_PAYLOAD_TOO_LARGE');
    const { phaseId, ...captureContext } = bound;
    const evidence = { ...captureContext, callId: call.callId };
    let attempted = false;
    let persistingResult = false;
    const command = commandLifetime(options.signal);
    try {
      await options.records.record(evidence, { kind: 'mutation-intent', phaseId, operation: call.operation, path: call.path,
        semantics: conditional ? 'same-fd-source-compare-direct-write-non-atomic' : 'regular-file-write-non-atomic', contentBytes: Buffer.byteLength(content) });
      if (!valid()) return failure('STALE_TOOL_CONTEXT');
      attempted = true;
      const argv = ['/usr/bin/python3', '-I', '-S', '-c', conditional ? guestConditionalProgram : guestWriteProgram, call.operation, call.path];
      if (conditional) argv.push(String(call.expectedBytes), call.expectedDigest);
      const process = options.vm.exec(argv, {
        // Native output() merges two required pipes. Drain/discard both below;
        // diagnostics still never reach SDK, evidence or display.
        stdout: 'pipe', stderr: 'pipe', signal: command.signal, windowBytes: 65536,
        env: {}, cwd: '/', stdin: content,
      });
      void process.result.catch(() => {});
      // No guest-controlled error/output reaches SDK, evidence or display.
      for await (const _chunk of process.output()) { /* drain bounded transport */ }
      const result = await process.result;
      const complete = result.exitCode === 0 && valid();
      const mismatch = conditional && result.exitCode === 42 && valid();
      let outcome = 'effects-uncertain';
      let effects = 'truncation-partial-file-or-directories-may-remain';
      if (complete) {
        outcome = 'complete';
        effects = call.operation === 'mkdir' ? 'directories-may-have-been-created' : 'regular-file-written';
      } else if (mismatch) {
        outcome = 'not-applied';
        effects = 'source-changed-before-effect';
      }
      // An uncertain conditional result must deny future effects even while evidence waits.
      if (conditional && !complete && !mismatch) revoke();
      persistingResult = true;
      const reference = await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: call.operation, outcome, effects });
      // A critical result await can overlap revocation; never publish late success.
      if (!valid()) { revoke(); return failure(`${prefix}_EFFECTS_UNCERTAIN`); }
      if (mismatch) return failure('EDIT_SOURCE_CHANGED');
      if (!complete) { revoke(); return failure(`${prefix}_EFFECTS_UNCERTAIN`); }
      // Same protected-reference result envelope as read, with no file-content bytes.
      return { status: 'success', format: 'text', reference, bytes: 0, encoding: 'base64', data: '', nextOffset: 0 };
    } catch {
      revoke(); command.abort();
      if (attempted && !persistingResult) {
        try {
          await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: call.operation,
            outcome: 'effects-uncertain', effects: 'truncation-partial-file-or-directories-may-remain' });
        } catch { /* Critical capture failure: no raw fallback, success or mutation retry. */ }
      }
      return failure(attempted ? `${prefix}_EVIDENCE_OR_EFFECTS_UNCERTAIN` : `PROTECTED_${prefix}_UNAVAILABLE`);
    } finally { command.abort(); }
  };
}
