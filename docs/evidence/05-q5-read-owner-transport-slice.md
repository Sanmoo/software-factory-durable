# 05 — partial Q5 read-owner transport slice

This is **not completion of ticket 05**, worker activation, SDK-candidate adoption,
or a new VM/model qualification. Recovery starts at clean `1d21fec`, with
`4e085bf` confirmed as ancestor. The checkpoint and all frozen review paths are
unchanged. No integration/sibling worktree or historical resource was modified.

## Implemented boundary

`Sandbox.serveReadTools` is trusted composition for **one host-bound reviewer
invocation in the existing per-Work native VM owner**, not a new process/service
or a worker constructor. The host supplies its private per-boot invocation socket,
immutable work/execution/invocation/role/environment/boot/phase context, current
host authority, protected Records instance, and the existing VM's native `exec`
boundary. The module never constructs a VM, imports a runtime SDK, discovers a
profile, executes host commands, reads host target files, or connects to a model.

`connectReadTools` returns only `executeTool(call)` and `close()`. Model input is
only a closed `read` call; it cannot select a role or bind a new invocation. The
owner validates every request against its host binding and current host context,
including after asynchronous capture preparation and before delivering a result.
Invalid operation/context/path, lost channel, owner closure, capture failure,
guest error, and late phase result all fail closed. Closing the owner is idempotent.
Protocol v1 is reused unchanged; no generic RPC framework or durable ACK is added.
The existing Protocol `local-operator` transport label is used by the **trusted
host part of the projection**, not as a worker role handshake. The endpoint is a
host capability and must only be provisioned to that invocation by composition.
It is not isolation against compromised trusted same-UID host code.

The owner issues argv-only guest `/usr/bin/head -c 16385 -- <path>` through the
already-owned VM. The selection permits `/workspace/` and `/artifacts/` paths
without `..`; symlinks are guest-resolved, **not** a claimed symlink jail. Nothing
falls back to host fs/exec. This bounded text-read slice captures at most 16,385
source bytes and flags source/display truncation. It is not the SDK read tool,
pagination, image support, or a substitute tool for operational worker activation.
A byte cap bisecting UTF-8 fails closed instead of producing replacement text.
Only Records-filtered `display` and its protected reference cross back over the
channel; guest stderr/exception text is never returned. Records metadata rejection
prevents a guest call. Guest execution failure closes its empty capture without
claiming a successful read or leaking an open handle.

## Local TDD and evidence

Approved seams tested: Q5 `executeTool`/host projection over real Q7 sockets, real
Records public API, with a double **only** at the external native VM exec boundary.
No guest command body is executed on the host. Tests use new private ordinary
fixtures under `/home/sanmoo/software-factory-test` and cleanup only those fixtures.

Execution prefix for successful local commands:

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 \
  TMPDIR=/home/sanmoo/software-factory-test \
  /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node
```

1. Initial setup error, not behavioral RED: PATH Node26 plus `--import tsx`
   failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. Reported/stopped
   immediately; supervisor explicitly directed continuation in this same native
   child using pinned Node24 and repository ESM compile/test. No tsx installed,
   runtime replacement, alternate CLI, or child retry.
2. Pinned `node_modules/typescript/bin/tsc -p tsconfig.json` succeeded, then the
   single new test failed with `Error: NOT_IMPLEMENTED` against the minimal shell:
   `tests 1 / pass 0 / fail 1`. This was the behavioral RED.
3. Initial implementation: same compile/new-test command passed `tests 1 / pass 1`.
4. Negative/lifecycle tests exposed non-idempotent owner close:
   `tests 6 / pass 5 / fail 1`, `ERR_SERVER_NOT_RUNNING`. Fixed owner close to share
   one close promise. Self-review also closed the empty capture on guest exception.
5. Final compile succeeded (exit 0, no output). Final focused command:

```sh
# Apply pinned execution prefix above.
node --test --test-concurrency=1 \
  dist/test/sandbox/tool-transport.test.js dist/test/protocol/protocol.test.js
```

Exact summary:

```text
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 423.497856
```

Eight new tests cover filtered successful read/evidence, hostile context/role/write
claims, path denial, host boot/phase invalidation/revocation, closed/lost channels,
late-result suppression, capture/guest failures, Spec role, bounded truncation,
and invalid UTF-8. Three existing Protocol tests passed in the same bounded block.
The frozen Records/SDK suites and completed 153-case gate were **not rerun**.

Architecture setup initially named nonexistent `dependency-cruise.mjs` and failed
`MODULE_NOT_FOUND` before running the analyzer. After inspecting the installed
binary path (no installation), the pinned command was:

```sh
# Apply pinned execution prefix to each command.
node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs \
  --config .dependency-cruiser.cjs --output-type err-long .
node node_modules/eslint/bin/eslint.js . --max-warnings 0
```

Exact analyzer output: `✔ no dependency violations found (84 modules, 397 dependencies cruised)`.
ESLint exited 0 without output. `git diff --check` passed without output.
Active LSP probe of the three changed TypeScript paths reported 0 diagnostics,
but only one confirmed clean and two inconclusive (push-only); compilation, not
that probe, is the static correctness evidence. Every command was bounded <=60s.

## Remaining local and real gates

- This is a composable, tested transport/projection **component**, not wired into
  the running adapter/worker lifecycle. Trusted controller/adapter composition
  must provision private per-boot invocation endpoints and provide authoritative
  phase/boot revocation; no model/worker activation is claimed here.
- Builder writes/edits/bash, SDK-native tool operations binding, cancellation,
  pagination/images, and operational session/model wiring remain outside this
  read-only slice. No unrestricted SDK/VM object is delivered to a worker.
- The SDK candidate remains frozen and unadopted; original SDK host path-probe
  issue and native worker/runtime-profile qualification remain open in checkpoint
  `docs/evidence/05-protected-output-and-sdk-candidate.md`.
- Real existing-owner IPC, guest binary/profile availability and review handoff
  require later authorized integration/physical evidence. No VM/backend image,
  network, credentials/GitHub, model, installation, mounts, Docker, asset mutation,
  or signals to old resources were attempted. All old physical grants remain spent.
- Historical default parallel `npm test` ingress-readiness failure remains visible
  in the checkpoint; this focused green result does not supersede it or certify 05.

Smallest next step: compose this restricted owner/projection inside the existing
adapter's host-authorized invocation lifecycle, then verify new affected paths
locally before any separately approved real worker/VM/model gate. Do not interpret
this partial commit as permission to activate workers or adopt the SDK candidate.
