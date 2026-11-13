# Offline adapter regression fixture boundary

Task137 migrates the legacy diagnostic fixture to the **authored loader boundary**, not to an installed/staged SDK export mock. `gondolin-sdk-runtime.js` is substituted with an explicit VM/provider double. This is not actual profile verification, native Gondolin execution, or physical qualification.

## Source audit and real-module map

Before executing the migrated fixture, the complete legacy fixture, mode consumers, runtime-loader fixture, preparer tests/implementation, adapter, workspace-provider, lifecycle/host worker-launch, worker-session/process, four normal public worker fixtures, and provider preloads were inspected as source. The initial legacy fixture was not executed. Its installed public SDK import and PATH fake-systemctl executable were removed first.

- **Actual application modules:** adapter logical gates, asset hashing of owned inert DATA, metadata/durable Records, public Sandbox/Workers owner/binding channels, fixed new Node24 worker, native Phi session/tool wrappers and JSONL reopening. No real model endpoint: existing provider preloads return synthetic HTTP responses. ModelRuntime receives only the newly owned profile directory, synthetic key, custom provider, no refresh/model-network, and an empty resource loader.
- **Doubles:** closed Gondolin loader, VM/create/start/exec/close, provider, manager `execFile` observation, proc/cgroup/mount namespace/state. Guest shell/Python helper bodies are DATA recorded/responded to by the VM double, never handed to host Python or shell (even syntax-only host-shell calls were removed).
- **Forbidden before evaluation:** original/staged Gondolin public root and every SDK leaf/transitive import. A test-only loader hook rejects package/path URLs before resolution/evaluation. Negative tests cover exact original/staged root URLs and VM leaf. No SDK export enumeration is used.
- **Host commands:** only exact `systemctl --user show <this-fixture-unit> --property=LoadState,ActiveState,SubState,InvocationID,ControlGroup,MainPID,Result` is answered, via a direct builtin replacement with explicit `util.promisify.custom` returning `{stdout,stderr}`. No PATH fake executable. Other command APIs and host signals are denied. The only real spawn is the exact absolute Node24 worker entry, exact IPC/options/minimal environment, with one fixed adapter-only provider preload. No fallback real spawn/exec exists.
- **Transport:** only Unix sockets under the newly owned fixture root are allowed. TCP/TLS/HTTP and DNS are denied; children retain fake fetch responses. New adapter-only preloads install guards before importing existing offline provider preloads; shared standalone Workers preloads remain unchanged.
- **Filesystem:** all assets/profile/work/evidence data belong to newly created private fixture roots. Virtual supervision observations replace physical host gates. `/proc/self/fd/N` observation is restricted to this new fixture root or its descendants. Mocks and builtin named exports are restored at process exit.

## Actual VFS/RPC mode: UNRUN

The prior confinement mode imported the public SDK root to obtain actual RealFSProvider/FsRpcService. That import is now forbidden. Initial source sizing found `vfs/rpc-service.js` at940 lines and vendored `providers/real.js` at531 lines **before auditing further transitive modules**. A complete safe minimal import closure was not established in this bounded task. No deep-leaf import was allowed, no leaf usage hashes were asserted, and no real provider/RPC implementation was replaced with a toy and called actual proof.

The confinement regression remains explicitly skipped with `UNRUN: root SDK forbidden; actual leaf closure audit required`; direct fixture invocation in that mode fails before application/SDK imports. The former actual VFS probing branch is removed, not silently emulated. Future re-enablement must fully audit and pin an exact minimal read-only leaf closure and restore actual provider/RPC probes. Current results do not renew that proof level.

## Validation accounting

All commands use absolute Node24.21.0 with NODE_OPTIONS/NODE_COMPILE_CACHE unset, NODE_DISABLE_COMPILE_CACHE=1, each bounded60s. No full npm test/build/clean/preparation or candidate rerun.

Combined focused run: profile8 + guard1 + owner1 + diagnostics14 = tests24/pass23/fail0/skip1(actual VFS). After final guard tightening, guard+owner+diagnostics were rerun: tests16/pass15/fail0/skip1. Separate normal Read/Write/Bash3/pass3; Edit selected `complete|uncertain|persist|budget|cancel|eof`6/pass6. This does **not** claim all14 native Edit modes green. Preserved existing assertions cover all provider-request counts, protected-start ordering/context, critical evidence failure, abort/EOF and revocation, session filtering/reopen, and logical owner shutdown. They do not prove cessation of physical guest effects.

Architecture18/pass18; dependency-cruiser164 modules/840 dependencies/no violations. Compiler and changed-file lint pass. Active LSP ten changed TS paths: no warning/error diagnostics; silence is not runtime evidence.

### Development failures (not hidden as green)

- The first migrated diagnostic subset failed10 before any audit entry. `mock.method(execFile, replacement)` retained original custom-promisify metadata rather than the intended synthetic `{stdout,stderr}` seam. It was replaced with direct assignment before reruns. PATH was empty and other command APIs were denied, but that initial run did not independently instrument the original promisified command syscall path; **do not claim a whole-turn zero-command-attempt counter**. No successful manager command, systemd state read, SDK evaluation or VM execution was observed. Final guards include an explicit negative promisified-command test.
- Owner regression initially failed because the FD guard allowed only descendants, rejecting sync of the newly owned root directory itself. Root equality is now allowed; the existing owner expectations pass without production changes. Temporary diagnostic probing was removed.

## Retained limitations

Raw FD inheritance, actual cgroup/systemd supervision, real SDK/VM/guest/socket persistence, physical cessation, copy readiness and whole05 remain unqualified. No production preparer/loader/adapter, pinned DATA, dependency lock, installed SDK, retained ignored profile or integration destination was changed. The prior stale candidate was not rerun or waived.
