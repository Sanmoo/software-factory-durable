# Task143 — direct Task142 P1 correction (bounded owner component)

Base: `2efc1d5a80d3d2d15ba0514f6d667e38144c0be1`, existing `implement/software-factory-mvp-05` worktree. Read the complete Task142 review, Task139 component report, repository agent/issue-tracker instructions, actual owner/write/read sources, copy tests and helper AST guard before editing.

## Change

Only `boundStreamCopyTools` changes at runtime: one idempotent synchronous failure action revokes owner mutation admission and aborts the copy lifetime. The stdin generator catches projection/local validation errors and invokes it before rejecting the SDK's pull. The independent guest-result rejection observer invokes the same action instead of swallowing rejection. The existing outer catch invokes it before uncertainty persistence. Existing uncertainty records, iterator cleanup, slot/profile/policy rules, completion/current guard, receipt/count/SHA and publication semantics remain in place. Production guest helper bytes are unchanged. No retry, deletion, new RPC/schema/authority or VM shutdown was added.

## Genuine RED, then GREEN

New `test/sandbox/bash-copy-independent-failure.test.ts` has three independent-pump receipt doubles. The pump runs outside the output iterator. Every case accepts one 65,536-byte chunk, then:

1. **Projection:** real `Records.projectText` fails after `registerSecret` changes its current revision, while output and result remain held unsettled.
2. **Local validation:** actual Records iterator is retained, with test-only second-pull injection of an empty Buffer to exercise the owner's synchronous chunk validation. Output and result remain held unsettled.
3. **Result rejection:** result rejects independently while output remains held and the source is paused. The rejection is observed without an unhandled rejection.

An independent peer connection to the **same owner** attempts actual Write create, a previously captured Edit commit, and Bash. No local single-flight guard can mask admission. Observation waits on source-failure/result-rejection promises, never on the abort being tested. Holds deliberately ignore abort. `finally` releases all holds and joins the pending copy/pump in both RED and GREEN, with no sleep/poll.

Before any runtime edit, compiler succeeded and all three tests genuinely failed: `aborted: false`, peer Write and Edit succeeded, `additionalGuestExec: 2`, Bash returned `BASH_IN_PROGRESS`; output stayed unsettled, and source cases also held result unsettled. Existing copy/shared-helper baseline was 33/33 passes. This is the Task142 gap, not a mere Bash-running or client-busy assertion.

After the fix, each case asserts/prints before releasing holds:

- `aborted: true`, `guestExec: 3` (initial Edit capture + Bash capture + copy), `additionalGuestExec: 0`;
- `acceptedChunks: 1`, `acceptedBytes: 65536`, `abortEvents: 1`;
- peer Write/Edit/Bash all return exactly `STALE_TOOL_CONTEXT`;
- `outputSettled: false`; `resultSettled: false` for source failures, `true` only for deliberate result rejection;
- `uncertainRecords: 0`: revocation/abort does not await result/output/evidence settlement.

After releasing/joining, all copies fail and each has exactly one existing uncertainty record and one abort event, exercising observer/outer-cleanup coexistence.

## Commands and exact summary output

Every Node invocation used the following exact executable/environment, with each shell tool timeout at most 60 seconds:

```sh
N=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node
# Each invocation below is prefixed: env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 "$N"
```

- `node_modules/typescript/bin/tsc -p tsconfig.json`: final exit 0, no diagnostics; compiles JS only, does not run SDK preparers.
- `--test dist/test/sandbox/bash-copy-independent-failure.test.js` before runtime change:
  `tests 3; suites 0; pass 0; fail 3; cancelled 0; skipped 0; todo 0` (exit 1, expected RED).
- Baseline `--test dist/test/sandbox/bash-copy.test.js dist/test/sandbox/write-source-guard.test.js`:
  `tests 33; suites 0; pass 33; fail 0; cancelled 0; skipped 0; todo 0`.
- Final `--test dist/test/sandbox/bash-copy-independent-failure.test.js dist/test/sandbox/bash-copy.test.js dist/test/sandbox/write-source-guard.test.js`:
  `tests 36; suites 0; pass 36; fail 0; cancelled 0; skipped 0; todo 0`.
- `--test dist/test/records/*.test.js`:
  `tests 80; suites 0; pass 80; fail 0; cancelled 0; skipped 0; todo 0`.
- `--test dist/test/sandbox/bash-progress.test.js dist/test/sandbox/edit-commit.test.js dist/test/sandbox/edit-source.test.js dist/test/sandbox/tool-transport.test.js dist/test/sandbox/invocation-isolation.test.js dist/test/workers/native-builder-bash.test.js dist/test/workers/native-builder-write.test.js dist/test/workers/native-builder-edit.test.js`:
  `tests 123; suites 0; pass 122; fail 1; cancelled 0; skipped 0; todo 0`.
  Sole failure: existing `Builder lexical composition is host-fixed with upstream typed extension and no edit enablement` static test rejects `/createEditTool|builderEdit/` in existing `src/workers/worker-session.ts`. The test and source have no diff from the clean base. A focused `--test --test-name-pattern='Builder lexical composition' dist/test/workers/native-builder-write.test.js` reproduces this same failure (1 test, 1 fail). Not changed or hidden in this P1 correction.
- `node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .`:
  `✔ no dependency violations found (167 modules, 859 dependencies cruised)`.
- `node_modules/eslint/bin/eslint.js src/sandbox/write-tools.ts test/sandbox/bash-copy-independent-failure.test.ts --max-warnings 0`: exit 0, no diagnostics.
- Active LSP probe on both changed TypeScript files: `Files checked: 2; Total diagnostics: 0; clean=2, findings=0, unsupported=0, unavailable=0, failed=0, too_large=0, inconclusive=0`. This is changed-path coverage only, not a globally-clean claim.
- `git diff --check`: exit 0.

Initial tooling mistakes were not RED evidence: an attempted `--import tsx --test ...ts` failed immediately with `ERR_MODULE_NOT_FOUND` (no package installed and no test/runtime loaded); compilation then caught missing text-format narrowing. A later test instrumentation compile caught `unknown` event access. Both type issues were corrected before final successful compilation. All actual test execution used compiled JS; no SDK prepare, TS runtime install or dependency change occurred.

## Scope and residual risks

Self-review found no in-scope blocker. The adjacent pre-existing static Write composition assertion remains failing and is reported rather than repaired. The fix establishes local owner revocation and an abort request; it does **not** prove physical guest-FD termination, rollback, durability, continuous root membership, race-CAS or exclusion of other shared-VM actors. Already accepted bytes are irreversible and effects remain uncertain.

No actual guest VM/start, root SDK execution, helper host execution, model/network service, preparer, installation, private SDK/profile/root staging mutation, integration operation, push, or ticket closure occurred. AST parsers inspect guest helper strings as data. Tests use owned short 0700 temporary Records roots and synthetic receipt doubles. Task140 VFS execution was not run or re-enabled. Task141 static fixture proof/counters were not modified and do not become actual-bind proof. Historical Task137 initial ten original syscall paths remain unobserved; this correction does not erase that caveat. This is a direct P1 correction to Task139's bounded owner component, **not** whole-05 or automatic Worker full-copy integration acceptance.
