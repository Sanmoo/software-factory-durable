# 05 native read — explicit WIP timeout checkpoint

## Status and provenance

This is a **partial, non-integratable WIP checkpoint**, not completion/acceptance of 05, not a public-contract or architecture decision, and not a replacement implementation. Native run `d80bee5a` stopped at its 30-minute timeout. This one bounded recovery preserved its working delta without changing existing source, tests, configuration, metadata, or historical evidence. No ticket/label was resolved. No merge, push, peer write, VM, real model, network, credential, installation, or physical operation was performed.

Starting HEAD: `a218f280b57beca40965bad5652353fdd00402fa`. Integration destination remains `4e085bff4991210021c8e4714c4df89d4992376a` unchanged. The saved checkpoint is `/tmp/software-factory-mvp-05-timeout-checkpoint-IXQuR9/checkpoint.json`, captured at `2026-11-12T22:40:31.833Z`: 10 modified tracked paths, 13 untracked source/test/log paths, empty index, no lost work. Secured raw patch SHA-256: `d8b5d273871ed060be096bb8b169dcb81970ea83b41b0403a03765a15fac7ec2`; untracked tar SHA-256: `567737e7cbca6f833b5df272ff267cf27e01f5ee970928368efb5338b7b6ff5f`. The tracked binary diff still hashes to that exact saved patch at recovery validation.

## Actual source slice (not all of 05)

The preserved delta adds Workers reviewer SDK composition and native read operations over Sandbox Q5 capture/page transport, Records-filtered streamed text, host-bound context/revocation, protocol EOF notification and an optional adapter owner binding. It includes SDK-profile preparation/pinning, package alias/scripts and Workers-only alias lint restrictions, their fixtures/tests, and original RED/GREEN logs. It does not establish a complete runnable worker system.

Recovery source SHA-256 snapshots:

| File | SHA-256 |
| --- | --- |
| `src/workers/index.ts` | `fe04bf064b0245ed026fc05753b76a7b2246769af07a21022bd3210ae634d4e99` |
| `src/workers/read.ts` | `fc04d119154d0b49bb851db1af582e073ce15eec1db0bb55c6e84b6de849fb591` |
| `src/workers/sdk-profile.ts` | `11422e37affb5d8ae7962aa8a8b7f07b12b6ed949577251791084e1e45ed57bd` |
| `test/workers/native-owner-read.test.ts` | `6cc7e241d23b1af0925c81c491df7e639e270f583044e0c3c229b75c85e4a148f` |

## Evidence chronology and bounded validation

Original logs under `docs/evidence/05-native-read/` were read, not rerun or overwritten:

- `red.log`: earlier expected compile failure before the implementation existed.
- `alias-red.log`: earlier alias restriction assertion failed; retained as RED evidence.
- `binary-red.log`: earlier image-as-text success assertion failed; retained as RED evidence.
- `focused-green.log`: **15 tests, 15 pass, 0 fail**. Includes two native-owner tests, SDK candidate/profile checks, protocol/transport checks. SHA-256 `a39e2cdd9212256ae6e5c918167ff4752b0a2bb77817180f77512e8b21220fd45`.
- `architecture-tests-green.log`: **18 tests, 18 pass, 0 fail**. SHA-256 `fd0adf05c4b533050a45099f816c0348d94cfb7ed25d6dc3573fab584371a5d7e`.
- `compile-architecture-lint.log`: recorded Node `v24.21.0`, pinned private SDK profile and `no dependency violations found (92 modules, 440 dependencies cruised)`; supplied prior compile/architecture/lint PASS snapshot, not a new run. SHA-256 `d5e5396c06508d06995e5e1fc24290d51db496ba693c41aaffd1f1e2cdce1d12e`.

The third native-owner test (`a critical owner capture failure aborts the real SDK instead of requesting another provider turn`) was added **after** the 15-test log. No recorded outcome for it was found in the saved evidence; the pre-recovery compiled test also lacked it. Therefore only the explicitly permitted current compile and exact named test were run, with `NODE_OPTIONS` and `NODE_COMPILE_CACHE` unset, `NODE_DISABLE_COMPILE_CACHE=1`, `TMPDIR=/home/sanmoo/software-factory-test`, and `FACTORY_SANDBOX_TEST_ROOT=/home/sanmoo/software-factory-test/product-local-clYJQT`:

```text
/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
compile_exit=0
(no compiler diagnostics)

/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node --test-name-pattern='critical owner capture failure' dist/test/workers/native-owner-read.test.js
✔ a critical owner capture failure aborts the real SDK instead of requesting another provider turn (182.273637ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 186.483894
target_test_exit=0
```

New logs: `checkpoint-current-compile.log` (empty, successful compile; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) and `checkpoint-critical-owner.log` (SHA-256 `5f75e7ba56086eadcb44594373bf4d4d3d5a85da44d7797b711728e07ab4a8bb6`). Pre-staging `git diff --check` passed for the tracked delta. The later `git diff --cached --check` reported existing historical log formatting only: trailing spaces at `alias-red.log:16,18` and `binary-red.log:17,30`, plus a blank EOF line at `compile-architecture-lint.log:5`. These original logs are deliberately preserved byte-for-byte rather than rewritten to force a clean whitespace check; no source whitespace defect was reported. There was no full test suite, 153-test run, architecture/lint rerun, or focused-suite rerun. Historical 15/18 green snapshots plus one current targeted pass are **not** a single current 16-test run and do not supersede the older default `npm test` parallel-readiness failure. No whole-05 green claim is made.

## Mandatory unresolved boundaries

- The normal three-argument adapter CLI entrypoint still cannot provision the optional fourth-parameter `ReadBinding`. Private Control worker launch and invocation IPC are not complete.
- `Workers.activate` is in-process reviewer SDK composition tested with an external HTTP-provider double and VM doubles. It is not a supervised real-worker, real-model or real-VM qualification. The new failure test covers interrupted status and no second provider turn at that doubled boundary only.
- EOF revokes one binding and hooks VM termination in the adapter; this is not parallel-review or handoff qualification. No new VM termination experiment was performed.
- Native read text-stream pagination is demonstrated, including content beyond the former 16K wrapper and split-secret filtering. Images/binary are explicitly unsupported; rejection evidence is not native-images coverage.
- Builder write/edit/bash, reservations, and new-worker launch remain pending. No global variable or Records fact is promoted to domain authority, and no public contract or resolved label is changed by this checkpoint.
- The minimal SDK operations patch is for the owned private development copy only, not a global/shared/cache/node_modules installation change. Effective profile is `factory-development-pi-1.5.2-read-operations-v1`, upstream Pi `1.5.2` (not an implicit general upgrade from documented 1.5.0). `profile.json` records integrity `sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==`, upstream read hash `e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc`, upstream tree `7d0961cce25f6c802b22aaa028206cd610de386442d2e6b732d71367ef006391`, patch `5e45a7c2953db293a14db0138bb31f8ac9e95eb13512afd42f1f49b77c98e066`, and patched result `06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209` (SHA-256). Recovery did not prepare or alter any SDK copy. Generated SDK tree, profiles/credentials and build outputs are excluded from this commit.

## Disposition

The permitted current checks passed, so the saved source/test/log delta and this new evidence are committed as an **explicit WIP checkpoint only**. Source was not fixed or extended during recovery. 05 remains partial/open; integration must not receive this partial as acceptance. Remaining operational/physical boundaries require the parent workflow, not another recovery implementation here.
