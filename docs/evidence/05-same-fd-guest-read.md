# 05 — post-open same-FD guest read guard (Task75)

## Scope and engineering decision

This is **source/wiring/static-parse implementation evidence**, not physical Linux
FD confinement proof or whole-05 acceptance. Parent engineering selected post-open
resolved-target authorization of a regular FD for the **current trusted guest
kernel/proc/mount/interpreter profile**, not atomic never-traverse-outside,
all-magic-link exclusion, continuous membership, immutable content, or hardware
termination proof. Q5/Q8/Q9/Q13 and the canonical spec remain the authority;
this change is private to the existing Sandbox owner and existing Records channel.

The repository recipe `src/sandbox/guest-profile/apk-packages.txt` explicitly lists
`python3`. **Frozen runtime executable/stdlib availability and integrity remain
UNQUALIFIED.** No image, pin, asset, SDK, installed helper, package or guest profile
was changed or inspected in runtime. `-I -S` suppresses Python environment/user-site
initialization; CPython's standard library is **not** a security boundary against a
compromised guest root replacing the interpreter or its dependencies. The approved
root mounts must themselves be fixed/trusted, not replaceable symlink/mount aliases.
Proc evidence is conditional on trusted guest kernel and mount topology.

## Mechanism

The same boot owner calls its existing VM `exec` with precisely:

```
/usr/bin/python3 -I -S -c CONSTANT_PROGRAM REQUEST_PATH
```

The path is only `sys.argv[1]`; it is not interpolated into code or a shell.
Missing interpreter/proc/open flags and ambiguous targets fail closed, without cat
fallback, diagnostic stdout, host filesystem reads, native guest-file RPC, new read
engine or administrative API. The constant program:

1. Validates length, printable input, fixed `/workspace/` or `/artifacts/` lexical
   roots and no `..` component. It checks required Linux flag constants explicitly.
2. Opens once with `O_RDONLY | O_NONBLOCK | O_CLOEXEC`.
3. Uses `fstat` on that FD and rejects nonregular sources before the first source
   read. Open itself may have kernel/device/filesystem effects before this check.
4. Obtains the actual target with guest `readlink('/proc/self/fd/N')`, requiring
   an unambiguous printable absolute path strictly within either root (slash
   boundary), no empty/dot/dot-dot components or ` (deleted)` suffix. Root itself,
   prefix lookalikes and outside targets cannot pass this textual check.
5. Only then uses `os.read` on **that same FD**, with 65536-byte chunks, handling
   partial stdout writes. Neither the original path nor the proc link is reopened.
   Errors exit nonzero; stdout contains source bytes only; stderr is ignored.

Ordinary and cross-approved-root aliases can pass according to the final FD
resolved target. Intermediate traversal and magic links ending inside an approved
root are not categorically forbidden. Parent swaps are checked by the object that
won the open, but membership is checked only at verification time. Subsequent
rename/unlink/content mutation is not prevented; hard-link provenance and hostile
mount changes are not solved.

## Records and existing native pipeline

The owner still performs context/role/boot/reference checks, streamed image-magic
rejection, Q8 filtering before destinations, paged reads and existing native SDK
flow. Native image delivery remains **unsupported**. It completes Records only
after stream EOF and helper exit zero with a current binding, and registers the
reference only after a second current-binding check around finish.

The existing `openOutput` channel now has narrow idempotent `abort()` invalidation.
It marks the channel failed synchronously, discards its filter tail, closes the
handle and withdraws completion (including a completion raced by revocation).
There is no new ledger or capture format: existing `read()` reports `partial` when
capture metadata exists without completion. Failed/aborted/helper-nonzero reads
invoke abort rather than `finish()` in finally, and never publish an SDK source
reference. Invalidation filesystem errors are protected failures, not success or
raw diagnostic fallback. This is not a power-loss/storage-recovery proof.

## Explicit pending policy and qualification

Existing 65536-byte source chunks and SDK window, bounded filter state and bounded
page frames remain. **TOTAL source bytes, read duration and stuck-kernel I/O are
uncapped pending proper host-owned policy.** No global 16MiB/10s cap, invented
production deadline or waiver was added. Existing context/revocation requests SDK
abort; it does not attest guest/hardware cessation or unblock arbitrary kernel I/O.

A later **new closed-VM grant** is required for ordinary files/EOF, aliases,
outside symlinks, parent races, rename/delete, FIFOs without writers,
devices/directories/sockets, proc/flags/interpreter absence and physical target
semantics. No fake guest-FD engine was used as security proof. Task65 auth USD10
remains user-pending, unrelated to this source-only change.

## Local TDD and validation

Commands use absolute Node24.21.0, clear `NODE_OPTIONS`/`NODE_COMPILE_CACHE`, set
`NODE_DISABLE_COMPILE_CACHE=1`, and have individual <=60s bounds. No suite-wide
153-test loop, hook override, architecture relaxation, network/model/VM execution,
asset/rootfs exploration, install, sudo/mount or peer integration was performed.
The provider boundary in native regressions is an existing local deterministic
external HTTP double, never a real network/model request.

- Baseline compiler exit 0; four focused existing files: `tests 18; pass 18;
  fail 0; duration_ms 1146.386302`.
- Behavioral RED before production edits: `tests 18; pass 11; fail 7;
  duration_ms 248.999451`. Failures showed old cat argv, absent abort, and
  nonzero/stream-error/revoked/binary captures wrongly marked complete.
- First production compile exposed a mistaken private helper name (`invalidate`);
  corrected to an explicit shared invalidation helper around the actual existing
  open/closed/failed channel state. No bypass.
- Intermediate GREEN: seven focused files, `tests 49; pass 49; fail 0;
  duration_ms 2867.754586`, including real owner/Protocol/Records/native SDK and
  normal worker launch, with external VM/provider/host observations doubled.
- Added coverage for concurrent idempotent abort, abort during temporary/parent
  completion sync, interpreter-exec/result failures, invalid UTF-8 and empty
  nonzero output. All guest helper analysis is static. Host Python runs only
  `ast.parse(program-as-stdin-DATA)` and dumps the AST; it never calls/executes,
  imports as a module, evaluates or opens a path using the guest helper body.
- Final compiler: `node node_modules/typescript/bin/tsc -p tsconfig.json`, exit 0.
- Final affected scope (not the full suite):

  ```sh
  node --test dist/test/records/*.test.js \
    dist/test/protocol/protocol.test.js \
    dist/test/sandbox/tool-transport.test.js \
    dist/test/sandbox/invocation-isolation.test.js \
    dist/test/workers/native-owner-read.test.js \
    dist/test/workers/worker-process.test.js \
    dist/test/sandbox/owner-registration.test.js \
    dist/test/entrypoints/normal-worker.test.js
  ```

  Exact summary: `tests 84; suites 0; pass 84; fail 0; cancelled 0; skipped 0;
  todo 0; duration_ms 6051.022857`.
- Architecture: `node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs
  --config .dependency-cruiser.cjs --output-type err-long .`:
  `✔ no dependency violations found (107 modules, 535 dependencies cruised)`.
- Full ESLint: `node node_modules/eslint/bin/eslint.js . --max-warnings 0`, exit 0.
- `git diff --check`, exit 0. LSP probe reported 0 diagnostics, 6 confirmed clean
  and 2 inconclusive at that intermediate point; the final full compiler above is
  the authoritative changed-TypeScript validation, not an empty-cache claim.

Self-review: no blockers found. Kept fixed roots/context/ref/role, owner stream
window, Q8 filtering/page format and SDK pipeline; updated only doubles' argv
expectations where the command shape changed. Failure finally no longer creates
successful completion metadata, including real Records abort/publication races.
Residual physical/runtime/capacity-policy limitations above remain open, not waived.
