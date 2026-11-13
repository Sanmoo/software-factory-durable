# 05 — native Builder Bash through the existing owner (Task85 checkpoint)

## Scope and status

Useful native Bash vertical implemented from clean `4ba724d7c3e3d91bd22b325f2d22810ce38422a4`, first checkpoint `ac41412`. This is **not completion of increment 05 or runtime qualification**. The stronger requirement that *all SDK-internal host spill pending bytes* have a hard bound is **UNSATISFIED**: native SDK 1.5.2's synchronous `OutputAccumulator.append()` writes to its native `WriteStream` without awaiting backpressure. The supported custom-exec seam does not expose that stream. Our transport/owner code has bounded frames/windows and no pending-output array; that does not establish a bound on the upstream stream under an indefinitely stalled host filesystem. No SDK fork, global production stream mutation, invented flow-control guarantee, or alternative accumulator was added.

No real VM, guest shell/helper, Factory model, network request, GitHub/OAuth/credential acquisition, installation, asset/rootfs change, or manager operation was performed. Tests substitute external VM/manager/HTTP boundaries and use synthetic values. Canonical integration was not changed or pushed. Task65 authorization remains separate/pending.

## Implemented path

- Actual upstream native `createBashTool` with **complete** custom `exec`; no local operations, host model-path access, host shell, or fallback backend.
- Builder snapshot contains native `write` (existing exclusive-new-file slice) and native `bash`; Standards/Spec remain read-only. Role forging, stale phase/boot, unsupported administrative names, and dependent calls after failure are rejected.
- The SAME existing boot owner receives concrete `execute-tool`, correlated `tool-progress`, and `tool-result` frames. This is not a generic RPC service or replacement transport.
- Native `exposeSessionEnvironment:false`; spawn hook replaces the SDK parent clone with `{}` and fixed `/workspace`. The owner independently ignores callback cwd/env and selects its own empty environment and fixed cwd.
- Actual Gondolin 0.14 `startExec` merges VM defaults and omits an empty wire environment. Therefore `env:{}` alone is **not** asserted to replace guest `gEnv`. Owner argv is fixed guest `['/usr/bin/env','-i','/bin/bash','-c',command]`; the command remains an argv data element. `/usr/bin/env` and `/bin/bash` are guest profile prerequisites, not host fallbacks or qualified frozen-image assets. No Git grant delivery is claimed.
- Ordered public SDK `output()` stream includes stdout and stderr; each bounded raw slice awaits real `Records.write` before its released filtered bytes become progress. Each progress payload contains bounded canonical base64 (at most 24,576 decoded bytes), exact context, sequence and cumulative safe byte count. Clients validate correlation, context, canonical encoding, sequence/count and completion before synchronous native `onData` sees anything. Protocol's existing bounded pending queue is retained.
- `finish().tail` is filtered by Records and sent before SDK completion. Records default **fatal UTF-8** remains unchanged; arbitrary binary Bash is explicitly unsupported/OPEN.
- Native live updates, tail truncation, nonzero structured exit/isError, native wall time, native `readFullOutput` and 1 MiB structured-output behavior are retained. Native full output spill is a real exclusive 0600 **HOST** file under the private worker TMPDIR; it is not a guest path. Selective guest copy is explicitly OPEN; Records is not mounted and no new log tool/ledger was introduced.
- Optional native per-call timeout is finite, positive and within native local timer bounds (`2_147_483_647ms`); no global domain execution deadline was introduced. Abort/lifetime/timeout request cancellation, not physical cessation. Null exit, lost transport, and capture failure after possible effects are UNKNOWN and revoke the binding; no automatic retry or dependent model turn.
- Owner and child register known synthetic values before capture/use. Capture/filter/transport/native callback failures abort future SDK work. Real temp-write and session-write faults terminate the fixed worker with a sanitized allowlisted error rather than leaking Node's raw diagnostic or taking another provider turn. This worker-boundary guard is needed because native accumulator's async open error may precede its completion handler.

## Tests and gates

All commands use the absolute Node24 executable `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node` with `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`. Each command stayed under 60 seconds.

TDD started with a new native Bash test and compiler failure `TS2307: Cannot find module '../../src/workers/bash.js'`. Subsequent behavior tests exposed real native async temp-stream failure and missing guest-env replacement semantics; both received concrete fixes rather than raw fallback.

Affected compiled suite:

```text
node --test --test-concurrency=2 dist/test/workers/*.test.js \
  dist/test/sandbox/bash-progress.test.js dist/test/sandbox/tool-transport.test.js \
  dist/test/sandbox/invocation-isolation.test.js dist/test/sandbox/owner-registration.test.js \
  dist/test/sandbox/write-source-guard.test.js dist/test/entrypoints/normal-*.test.js
ℹ tests 136
ℹ suites 0
ℹ pass 136
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The `node` abbreviation in this display is descriptive only; execution used the absolute path stated above.

- Public normal activation proves one external VM creation, same existing owner, new native Node child, protected receipt before provider requests, filtered >1 MiB real host spill, native JSONL and reopen. Parent SDK execution and default worker host spawn are forbidden test sentinels.
- Native component tests cover every byte cut of a non-ASCII literal secret across ordered stdout/stderr, final filter tail, source literal fragments, live updates before completion, host model-path sentinel preservation, native nonzero exit and error, null exit, optional timeout and abort, callback failure, and later-call refusal.
- Real native spill contents exactly equal complete filtered output; mode is 0600; structured head/tail omission stays within the native 1 MiB-plus-marker envelope and references the same host artifact.
- New Node worker faults cover fatal UTF-8 binary, actual Records completion publication failure, raw transport exception, actual native temp creation failure, actual native session append failure. No fault gets a dependent model request or raw stdio. Success scans protected evidence, spill, session and IPC for all synthetic secrets.
- Twelve adversarial peer cases reject sequence, count, noncanonical/empty/oversized base64, context, reply/message ID, completion mismatch, wrong-work reference, unexpected completion data and offset. This is an adversarial protocol peer test, not an alternate production executor.
- An existing host-launch test still treated Builder as unsupported despite the preceding native-write slice. Corrected it to reject Administrator and positively assert Builder; no launch authority was broadened by that test fix.
- After final completion-correlation hardening, the focused public-owner/Bash/child/adversarial suite passed **28/28**, zero failures (7,864ms). The preceding affected regression sweep passed **136/136**, zero failures (34,015ms).
- TypeScript compilation passes; dependency-cruiser and full ESLint pass; `git diff --check` passes. Active LSP probe reported 0 error findings across 18 changed source/test paths, with 11 confirmed clean and 7 push-only inconclusive (not asserted clean from silence).

## Residual risks / explicitly OPEN

1. **UNSATISFIED hard SDK-internal pending-spill bound** described above; sustained output into indefinitely stalled native host storage is not proved memory-bounded. Do not label this checkpoint fully accepted under that stronger requirement.
2. No real guest command execution or guest executable/frozen-image qualification; external VM tests establish composition and argv/options, not real Bash environment behavior, guest containment or process cessation.
3. Arbitrary raw binary Bash unsupported by unchanged fatal UTF-8 Records decoder. No general binary parity claim.
4. Native host spill is protected host metadata only. Explicit guest selective copy, full credential issue/renewal, native edit/overwrite, scheduler/handoff/budget/controller increments remain OPEN/out of scope.
5. Cooperative abort tests prove an abort request and fail-closed future work, not termination of uncooperative guest I/O. Such I/O can delay owner draining. Temp/session fatal failure may leave incomplete evidence/session tails; outcome is not known non-effect and must not be retried automatically.
