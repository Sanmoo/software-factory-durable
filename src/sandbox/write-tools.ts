import { z } from 'zod';
import type { createRecords } from '../records/index.js';

type Context = { workId: string; executionId: string; invocationId: string; role: 'builder' | 'standards' | 'spec'; environmentRef: string; bootRef: string; phaseId: string };
type Options = { context: Context; signal: AbortSignal; records: Awaited<ReturnType<typeof createRecords>>;
  vm: { exec(argv: string[], options: { stdout: 'pipe'; stderr: 'ignore'; signal: AbortSignal; windowBytes: number; env: Record<string, string>; cwd: string; stdin: string }): {
    output(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: Buffer }>; result: Promise<{ exitCode: number }> } } };
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
// Reject ALL symlinks including in-root links. Direct exclusive create is deliberately
// non-atomic: partial bytes/new directories can survive failure. No unlink/retry.
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
    def authorize(fd):
        target = os.readlink("/proc/self/fd/" + str(fd))
        if (not stat.S_ISDIR(os.fstat(fd).st_mode) or not target.isprintable()
                or target.endswith(" (deleted)")
                or not (target in ("/workspace", "/artifacts") or target.startswith(("/workspace/", "/artifacts/")))
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
        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        fds.append(fd)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError()
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

export function boundWriteTools(options: Options, valid: () => boolean, revoke: () => void) {
  const bound = Object.freeze({ ...options.context });
  return async function execute(context: Context, call: WriteCall): Promise<Result> {
    const failure = (code: string): Result => ({ status: 'failure', code });
    if (Object.keys(bound).some(key => bound[key as keyof Context] !== context[key as keyof Context]) || !valid()) return failure('STALE_TOOL_CONTEXT');
    if (bound.role !== 'builder') return failure('WRITE_ROLE_DENIED');
    if (!/^\/(workspace|artifacts)(\/[^\0]*)?$/.test(call.path) || /[\x00-\x1f\x7f]/.test(call.path) ||
        call.path.split('/').slice(1).some(part => ['', '.', '..'].includes(part)) ||
        (call.operation === 'create' && call.path.split('/').length < 3)) return failure('WRITE_PATH_DENIED');
    if ((call.operation === 'create' && call.content.length > 8192) || Buffer.byteLength(JSON.stringify(call)) > 49152) return failure('WRITE_PAYLOAD_TOO_LARGE');
    const { phaseId, ...captureContext } = bound;
    const evidence = { ...captureContext, callId: call.callId };
    let attempted = false;
    let persistingResult = false;
    const commandLifetime = new AbortController();
    try {
      await options.records.record(evidence, { kind: 'mutation-intent', phaseId, operation: call.operation, path: call.path,
        semantics: 'new-file-only-exclusive-non-atomic', contentBytes: call.operation === 'create' ? Buffer.byteLength(call.content) : 0 });
      if (!valid()) return failure('STALE_TOOL_CONTEXT');
      attempted = true;
      const process = options.vm.exec(['/usr/bin/python3', '-I', '-S', '-c', guestWriteProgram, call.operation, call.path], {
        stdout: 'pipe', stderr: 'ignore', signal: AbortSignal.any([options.signal, commandLifetime.signal]), windowBytes: 65536,
        env: {}, cwd: '/', stdin: call.operation === 'create' ? call.content : '',
      });
      void process.result.catch(() => {});
      // No guest-controlled error/output reaches SDK, evidence or display.
      for await (const _chunk of process.output()) { /* drain bounded transport */ }
      const result = await process.result;
      const complete = result.exitCode === 0 && valid();
      persistingResult = true;
      const reference = await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: call.operation,
        outcome: complete ? 'complete' : 'effects-uncertain', effects: complete
          ? call.operation === 'create' ? 'new-file-created' : 'directories-may-have-been-created' : 'partial-file-or-directories-may-exist' });
      if (!complete) { revoke(); return failure('WRITE_EFFECTS_UNCERTAIN'); }
      // Same protected-reference result envelope as read, with no file-content bytes.
      return { status: 'success', format: 'text', reference, bytes: 0, encoding: 'base64', data: '', nextOffset: 0 };
    } catch {
      revoke(); commandLifetime.abort();
      if (attempted && !persistingResult) {
        try {
          await options.records.record(evidence, { kind: 'mutation-result', phaseId, operation: call.operation,
            outcome: 'effects-uncertain', effects: 'partial-file-or-directories-may-exist' });
        } catch { /* Critical capture failure: no raw fallback, success or mutation retry. */ }
      }
      return failure(attempted ? 'WRITE_EVIDENCE_OR_EFFECTS_UNCERTAIN' : 'PROTECTED_WRITE_UNAVAILABLE');
    } finally { commandLifetime.abort(); }
  };
}
