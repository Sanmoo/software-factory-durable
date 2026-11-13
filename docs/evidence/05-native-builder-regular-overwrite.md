# 05 — native Builder regular-file overwrite (Task92)

Base: `e9aac87a14b90324c62cf6101ac63b73a913fe25`. This extends the existing native write vertical, not increment 05 completion or runtime qualification. No SDK/profile/dependency/pin changes or SDK-drain-candidate adoption. Canonical integration remains untouched. Task65 remains user-pending; the SDK-internal host-spill hard-bound requirement remains **UNSATISFIED**.

## Implemented boundary

Both upstream `createWriteTool` operations still traverse the same bound owner, Protocol, protected Records and stdin transport. Native schema, path normalization, per-path mutation queue, success text and cancellation checks remain upstream. Each callback retains a fresh UUID; callback cwd does not grant authority. Standards/Spec remain read-only. The existing internal `create` operation now handles new or existing regular files without a new protocol shape.

The guest-only Python SOURCE first opens the leaf relative to its authorized parent FD using `O_WRONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC`, without `O_CREAT` or `O_TRUNC`. Only `FileNotFoundError` (ENOENT) enters parent-reauthorized `O_CREAT | O_EXCL | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC` creation. Raced EEXIST is a failure, never a retry to overwrite. All directory traversal still uses nofollow directory FDs; final/intermediate symlinks, even in-root links, remain denied.

Before `ftruncate(fd, 0)` or any stdin read/data write, the opened FD must be regular, its actual proc-resolved target must be within an approved root and printable/nondeleted, and the parent FD must be reauthorized. Existing inode/mode are preserved by direct FD writes rather than unlink/rename/replacement. FIFO/device/nonregular FDs never reach truncation/data writes. Guest errors/output are not exposed.

These are instantaneous FD/parent checks under trusted guest kernel, proc, mount layout and interpreter prerequisites, not continuous membership, beneath-root traversal, hostile-TCB containment or full native symlink parity. The guest body was **never host-executed**; tests only parse captured SOURCE with trusted Python `ast.parse`. Real kernel FD/inode/mode/symlink/race qualification remains pending.

## Effects and evidence

Direct FD writes are deliberately non-atomic. Empty content still truncates; truncation, partial data/new files and directories may survive cancellation, process failure or capture failure. There is no rollback, unlink, automatic retry, rename-atomicity or fsync promise. Protected intent precedes possible effects; successful evidence says `regular-file-written`, not new-file-only. Failure evidence explicitly allows truncation/partial effects. Result publication failure remains UNKNOWN, revokes dependent calls and prevents another SDK provider turn, never success/no-effect.

Content remains stdin only, not argv, environment or evidence. Existing 8192-code-unit/encoded-frame development transport limits remain explicit and unchanged; no global/native size policy is claimed.

## Verification

All runtime commands used the absolute Node24.21.0 executable, cleared `NODE_OPTIONS`/`NODE_COMPILE_CACHE`, disabled compile cache and used `timeout 60s`. No install/prepare-sdk/build-clean command ran.

- Baseline: 8 focused tests passed.
- RED: 6 tests failed before implementation (missing existing-target open in SOURCE; old new-file-only evidence semantics).
- GREEN narrow set: 12 tests passed, including actual new Node24 native SDK new-file/overwrite/empty-overwrite ToolResults and JSONL reopen, guest failure after virtual truncation, actual protected result persistence failure, next-turn prevention and public owner/Host-bound native overwrite.
- Final focused regression: **77 tests, 77 pass, 0 fail**, 18.37 seconds. Includes old operation-UUID/read-only/BOM/image/native Bash and public worker regressions. Full suite and previous 136/153-test loops were not run.
- Absolute Node24 `tsc -p tsconfig.json` passed. Dependency-cruiser: `no dependency violations found (135 modules, 690 dependencies cruised)`. ESLint passed with zero warnings; `git diff --check` passed. One initial architecture invocation used a nonexistent binary filename; corrected to the installed `dependency-cruiser.mjs` and passed without configuration changes.
- Active LSP checked 9 changed TypeScript files: 0 diagnostics, 7 confirmed clean and 2 inconclusive. Compiler result is the complete typecheck evidence.

External manager/VM and HTTP are doubles only; native SDK, owner, Protocol, Records, worker entrypoints and JSONL are real. Virtual outside sentinels are not kernel proof. SOURCE mutation guards reject missing nonblock/nofollow/exclusive flags, widened ENOENT fallback and missing FD/parent authorization/truncation. A real native queue test holds the first write until settled and confirms the second same-path mkdir cannot pass it, then validates four distinct callback UUIDs.

No Edit, symlink-following, BMP, selective copy, Git grant, SDK candidate adoption, handoff, other increment implementation or real VM/model/network/credentials/system-unit operations were added or performed.
