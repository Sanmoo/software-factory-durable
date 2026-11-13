# 05 — first native Builder write vertical (Task83)

Scope: a real native `createWriteTool` execution through the existing Q5 owner,
Protocol and Records, the fixed new Node24 worker, and actual native JSONL/session
reopen. This is **not full Builder/05 completion or guest runtime qualification**.
Base: `bef5fc87b82940a1bc271870ce5857ec4866e980`. No SDK patch, pin change,
guest-read-helper change, new VM owner, credential service, Bash or Edit.

## Implementation and authority

- Host bootstrap/launch/context role unions now accept Builder. Its native session
  exposes only `write`; Standards/Spec still expose only their existing `read`.
  Worker endpoints still cannot register bindings or launch/administer workers;
  an asserted role, callback cwd or environment is not authorization.
- Both native write callbacks are replaced, including the constructor used for
  schema projection. Native schema, path normalization, process-local per-path
  mutation queue, success text and abort checks remain upstream. The narrowed
  tool description explicitly denies overwrite and all symlinks.
- Owner-bound mkdir/create operations use the **same** VM instance. Protected
  mutation intent is synced before each effect, without raw file content; results
  record known completion or uncertain partial effects. Critical intent/result
  failure revokes further effects and aborts the native model loop. No raw guest
  errors are forwarded; stdout is drained/discarded and stderr ignored.
- Content is data on stdin, never owner argv, evidence or diagnostics. Native
  sessions retain model-supplied tool arguments as upstream behavior. Paths are argv data,
  never source interpolation. The owner supplies `env: {}` and `cwd: '/'`, not
  callback or parent environment. Existing owner/child known-value registration
  precedes use. No App key, model key or real GitHub grant is supplied to guest.
- Development transport limit: 8192 content UTF-16 code units, bounded encoded
  call/frame payload (49152 bytes at owner; a smaller pre-mkdir worker guard).
  Rejection is explicit `WRITE_PAYLOAD_TOO_LARGE`, not a native/global size claim.

## Guest-only SOURCE boundary

The fixed Python source is never executed on the host. It opens `/`, then each
allowed root with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`, authorizes directory FD
resolved targets using trusted proc, traverses nofollow directory FDs and validates
the parent before mkdir/create. It rejects root/intermediate/final symlinks,
including links that remain in root. One safe final leaf is created directly
using `O_CREAT | O_EXCL | O_NOFOLLOW`, never `O_TRUNC`, rename, replacement or unlink.
Existing regular files cannot be truncated, even on a final-name race.

This intentionally provides **non-atomic new-file writes**: a partial regular
file and/or directories may survive errors, EOF or cancellation. A completed
mkdir followed by native cancellation is not reported as no effect. Unknown
outcomes are not retried or automatically rolled back. There is no atomicity,
fsync durability, overwrite/native symlink parity, kernel-beneath guarantee or
continuous root-membership claim. A directory FD is authorized only at the check
instant; trusted guest kernel, proc, mount layout and interpreter assumptions
remain unchanged. Malicious guest root/concurrent mount manipulation is not
contained by this mechanism.

## TDD and local evidence

Explicit runtime: `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`
(`v24.21.0`). Baseline focused native read/BOM tests: 8 passed, 0 failed.
New initial tests failed compilation for missing native write module, Builder
role, write DTO and stdin/env/cwd projection; they passed after implementation.
A broader focused regression run exposed the old test treating Builder as an
invalid bootstrap role; only that invalid value changed to `administrator`.

New tests cover both real callbacks; stdin-only multibyte content; denied host
model-path sentinel unchanged; reviewer/forged/stale/admin denials; bounded
pre-effect rejection; native cancellation before/between callbacks; real Records
intent/result publication failure; unknown partial effects and native next-turn
abort. Separate new Node24 cases exercise native write success, guest failure,
and real result-persistence failure, and reopen native session/toolResult JSONL.
The public `createWorkers.activate` path also goes through real owner registration,
Host launch/bootstrap/start receipt, same-owner Protocol/Records and new Node24.
It checks once-only launch, reviewer write denial, forged role denial and a
virtual existing-target refusal. External manager/VM and HTTP are doubles only;
SDK, Workers, owner, Protocol and Records implementations are not doubled.

The SOURCE test runs trusted Python `ast.parse` only on captured guest source,
with adverse root-nofollow, parent-authorization and `O_TRUNC`/missing-`O_EXCL`
mutations. This does **not** execute the guest body or establish real kernel FD,
symlink/race or hardware behavior. No actual VM/system unit/model/network/DNS,
credentials, personal profile, Docker, mount, install or rootfs exploration ran.

Final validation commands/results are recorded in the implementation artifact.
Full suite intentionally not run; focused dist tests are bounded by `timeout 60s`.

## Residual work

Actual authorized guest boundary qualification remains pending, including frozen
Python/stdlib availability and hostile symlink/race behavior on real guest FDs.
This commit does not implement native Bash/Edit, overwrites, symlink following,
atomic durability, credential rotation/delivery, scheduling, handoff or broader
Factory execution. Task65 remains user-pending. A protected mutation result can
be unavailable after persistence failure; such a write is uncertain, never success.
